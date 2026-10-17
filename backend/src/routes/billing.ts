import type { FastifyPluginAsync } from "fastify";
import Stripe from "stripe";
import { z } from "zod";
import { prisma } from "../db.js";

// Stripe необязателен: без ключа эндпоинты оплаты отвечают 501, а подписка работает по ключам активации.
const stripe = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null;

const PRICES: Record<"pro" | "team", string | undefined> = {
  pro: process.env.STRIPE_PRICE_PRO,
  team: process.env.STRIPE_PRICE_TEAM,
};

function planFromPrice(priceId?: string): "pro" | "team" | null {
  if (priceId && priceId === PRICES.pro) return "pro";
  if (priceId && priceId === PRICES.team) return "team";
  return null;
}

export const billingRoutes: FastifyPluginAsync = async (app) => {
  if (!stripe) {
    app.all("/*", async (_req, reply) => reply.code(501).send({ error: "stripe_disabled" }));
    return;
  }

  app.post("/checkout", { preHandler: app.authenticate }, async (req, reply) => {
    const body = z.object({ plan: z.enum(["pro", "team"]) }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_input" });

    const price = PRICES[body.data.plan];
    if (!price) return reply.code(500).send({ error: "price_not_configured" });

    const user = await prisma.user.findUniqueOrThrow({ where: { id: req.user.sub } });
    let customerId = user.stripeCustomerId;
    if (!customerId) {
      const customer = await stripe.customers.create({ email: user.email, metadata: { userId: user.id } });
      customerId = customer.id;
      await prisma.user.update({ where: { id: user.id }, data: { stripeCustomerId: customerId } });
    }

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      customer: customerId,
      line_items: [{ price, quantity: 1 }],
      success_url: `${process.env.APP_URL}/billing/success`,
      cancel_url: `${process.env.APP_URL}/billing/cancel`,
    });
    return { url: session.url };
  });

  // Портал клиента: смена тарифа, отмена, карты — всё на стороне Stripe.
  app.post("/portal", { preHandler: app.authenticate }, async (req, reply) => {
    const user = await prisma.user.findUniqueOrThrow({ where: { id: req.user.sub } });
    if (!user.stripeCustomerId) return reply.code(400).send({ error: "no_customer" });
    const session = await stripe.billingPortal.sessions.create({
      customer: user.stripeCustomerId,
      return_url: process.env.APP_URL!,
    });
    return { url: session.url };
  });

  // Webhook: нужен сырой body для проверки подписи.
  await app.register(async (hook) => {
    hook.addContentTypeParser("application/json", { parseAs: "buffer" }, (_req, body, done) =>
      done(null, body)
    );

    hook.post("/webhook", async (req, reply) => {
      const sig = req.headers["stripe-signature"];
      let event: Stripe.Event;
      try {
        event = stripe.webhooks.constructEvent(
          req.body as Buffer,
          sig as string,
          process.env.STRIPE_WEBHOOK_SECRET!
        );
      } catch {
        return reply.code(400).send({ error: "bad_signature" });
      }

      if (
        event.type === "customer.subscription.created" ||
        event.type === "customer.subscription.updated" ||
        event.type === "customer.subscription.deleted"
      ) {
        const sub = event.data.object as Stripe.Subscription;
        const user = await prisma.user.findUnique({ where: { stripeCustomerId: sub.customer as string } });
        if (user) {
          const plan = planFromPrice(sub.items.data[0]?.price.id) ?? "free";
          const active = sub.status === "active" || sub.status === "trialing";
          await prisma.subscription.upsert({
            where: { userId: user.id },
            update: {
              plan: active ? plan : "free",
              status: active ? "active" : sub.status,
              stripeSubscriptionId: sub.id,
              source: "stripe",
              currentPeriodEnd: new Date(sub.current_period_end * 1000),
            },
            create: {
              userId: user.id,
              plan: active ? plan : "free",
              status: active ? "active" : sub.status,
              stripeSubscriptionId: sub.id,
              source: "stripe",
              currentPeriodEnd: new Date(sub.current_period_end * 1000),
            },
          });
        }
      }
      return { received: true };
    });
  });
};

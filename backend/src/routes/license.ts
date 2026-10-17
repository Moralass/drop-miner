import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { prisma } from "../db.js";
import { ACCOUNT_LIMITS, DEVICE_LIMITS, type PlanName } from "../limits.js";
import { hashCode, normalizeCode } from "../keys.js";

const RANK: Record<PlanName, number> = { free: 0, pro: 1, team: 2 };
const DAY_MS = 86_400_000;

export interface LicenseInfo {
  plan: PlanName;
  /** null у платного тарифа = бессрочно */
  expiresAt: Date | null;
  source: "stripe" | "key" | null;
}

/** Эффективный тариф: платный только пока подписка active и период не истёк. */
export async function licenseInfo(userId: string): Promise<LicenseInfo> {
  const sub = await prisma.subscription.findUnique({ where: { userId } });
  const free: LicenseInfo = { plan: "free", expiresAt: null, source: null };
  if (!sub || sub.status !== "active" || sub.plan === "free") return free;
  if (sub.currentPeriodEnd && sub.currentPeriodEnd < new Date()) return free;
  // Заблокированный администратором ключ сразу перестаёт давать тариф; после разблокировки всё возвращается.
  if (sub.source === "key" && sub.keyId) {
    const key = await prisma.licenseKey.findUnique({ where: { id: sub.keyId }, select: { blockedAt: true } });
    if (key?.blockedAt) return free;
  }
  return {
    plan: sub.plan,
    expiresAt: sub.currentPeriodEnd,
    source: sub.source === "key" ? "key" : "stripe",
  };
}

export async function effectivePlan(userId: string): Promise<PlanName> {
  return (await licenseInfo(userId)).plan;
}

class KeyError extends Error {}

export const licenseRoutes: FastifyPluginAsync = async (app) => {
  app.get("/", { preHandler: app.authenticate }, async (req) => {
    const info = await licenseInfo(req.user.sub);
    return { ...info, accountLimit: ACCOUNT_LIMITS[info.plan] };
  });

  /**
   * Активация подписки ключом.
   *  - тот же тариф уже активен → срок продлевается (добавляется к текущему окончанию);
   *  - ключ выше текущего тарифа → переход на него, отсчёт с сегодняшнего дня;
   *  - ключ ниже активного тарифа, активная подписка Stripe или бессрочная лицензия → отказ,
   *    ключ при этом НЕ сгорает.
   */
  app.post(
    "/redeem",
    {
      preHandler: app.authenticate,
      // Жёсткий лимит попыток: ключи 80-битные, но спамить эндпоинт незачем.
      config: { rateLimit: { max: 5, timeWindow: "1 minute" } },
    },
    async (req, reply) => {
      const body = z.object({ code: z.string().min(1).max(64) }).safeParse(req.body);
      if (!body.success) return reply.code(400).send({ error: "invalid_input" });

      const normalized = normalizeCode(body.data.code);
      if (!normalized) return reply.code(400).send({ error: "invalid_key" });
      const codeHash = hashCode(normalized);
      const userId = req.user.sub;

      try {
        const result = await prisma.$transaction(
          async (tx) => {
            const key = await tx.licenseKey.findUnique({ where: { codeHash } });
            if (!key || key.blockedAt) throw new KeyError("invalid_key");
            if (key.redeemedAt) throw new KeyError("key_used");

            const sub = await tx.subscription.findUnique({ where: { userId } });
            const now = new Date();
            const active =
              !!sub &&
              sub.status === "active" &&
              sub.plan !== "free" &&
              (!sub.currentPeriodEnd || sub.currentPeriodEnd > now);

            let start = now;
            if (active && sub) {
              if (sub.source !== "key") throw new KeyError("stripe_active");
              if (RANK[key.plan] < RANK[sub.plan]) throw new KeyError("lower_plan_active");
              if (key.plan === sub.plan) {
                if (!sub.currentPeriodEnd) throw new KeyError("lifetime_active");
                start = sub.currentPeriodEnd; // продление
              }
            }
            const end = key.durationDays ? new Date(start.getTime() + key.durationDays * DAY_MS) : null;

            await tx.subscription.upsert({
              where: { userId },
              update: { plan: key.plan, status: "active", source: "key", keyId: key.id, currentPeriodEnd: end, stripeSubscriptionId: null },
              create: { userId, plan: key.plan, status: "active", source: "key", keyId: key.id, currentPeriodEnd: end },
            });
            await tx.licenseKey.update({
              where: { id: key.id },
              data: { redeemedById: userId, redeemedAt: now },
            });
            return { plan: key.plan, expiresAt: end };
          },
          { isolationLevel: "Serializable" }
        );
        return result;
      } catch (e) {
        if (e instanceof KeyError) {
          return reply.code(e.message === "invalid_key" ? 400 : 409).send({ error: e.message });
        }
        // P2034 — конфликт сериализации (два параллельных запроса с одним ключом).
        if ((e as { code?: string }).code === "P2034") return reply.code(409).send({ error: "busy" });
        throw e;
      }
    }
  );

  /**
   * Список аккаунтов + какие из них активны.
   * Если подписка закончилась, активными остаются самые старые аккаунты в пределах лимита,
   * остальные блокируются (данные не удаляются — вернутся после продления).
   */
  app.get("/accounts", { preHandler: app.authenticate }, async (req) => {
    const userId = req.user.sub;
    const info = await licenseInfo(userId);
    const limit = ACCOUNT_LIMITS[info.plan];
    const rows = await prisma.linkedAccount.findMany({
      where: { userId },
      orderBy: { createdAt: "asc" },
    });
    return {
      plan: info.plan,
      expiresAt: info.expiresAt,
      source: info.source,
      limit,
      accounts: rows.map((a, i) => ({ id: a.id, label: a.label, active: i < limit })),
    };
  });

  app.post("/accounts", { preHandler: app.authenticate }, async (req, reply) => {
    const body = z
      .object({ id: z.string().uuid(), label: z.string().trim().min(1).max(60) })
      .safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_input" });

    const userId = req.user.sub;
    const plan = await effectivePlan(userId);
    const limit = ACCOUNT_LIMITS[plan];

    const existing = await prisma.linkedAccount.findUnique({ where: { id: body.data.id } });
    if (existing) {
      if (existing.userId !== userId) return reply.code(409).send({ error: "id_taken" });
      return { ok: true };
    }

    // Транзакция: проверка лимита и вставка не должны гоняться между собой.
    try {
      await prisma.$transaction(
        async (tx) => {
          const count = await tx.linkedAccount.count({ where: { userId } });
          if (count >= limit) throw new Error("account_limit");
          await tx.linkedAccount.create({ data: { ...body.data, userId } });
        },
        { isolationLevel: "Serializable" }
      );
    } catch (e) {
      if (e instanceof Error && e.message === "account_limit") {
        return reply.code(403).send({ error: "account_limit", limit, plan });
      }
      throw e;
    }
    return { ok: true };
  });

  app.delete("/accounts/:id", { preHandler: app.authenticate }, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const res = await prisma.linkedAccount.deleteMany({ where: { id, userId: req.user.sub } });
    if (res.count === 0) return reply.code(404).send({ error: "not_found" });
    return { ok: true };
  });

  // Регистрация устройства: ограничиваем число установок по тарифу.
  app.post("/devices", { preHandler: app.authenticate }, async (req, reply) => {
    const body = z
      .object({ fingerprint: z.string().min(8).max(128), name: z.string().max(80).optional() })
      .safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_input" });

    const userId = req.user.sub;
    const plan = await effectivePlan(userId);
    const existing = await prisma.device.findUnique({
      where: { userId_fingerprint: { userId, fingerprint: body.data.fingerprint } },
    });
    if (existing) {
      await prisma.device.update({ where: { id: existing.id }, data: { lastSeenAt: new Date() } });
      return { ok: true };
    }
    const count = await prisma.device.count({ where: { userId } });
    if (count >= DEVICE_LIMITS[plan]) {
      return reply.code(403).send({ error: "device_limit", limit: DEVICE_LIMITS[plan] });
    }
    await prisma.device.create({ data: { userId, ...body.data } });
    return { ok: true };
  });
};

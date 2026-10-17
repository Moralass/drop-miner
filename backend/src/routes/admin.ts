import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { prisma } from "../db.js";
import { generateCode, hashCode, hintOf, normalizeCode } from "../keys.js";
import { twitch } from "../twitch.js";

const campaignInput = z.object({
  game: z.string().min(1).max(120),
  name: z.string().min(1).max(200),
  startsAt: z.coerce.date(),
  endsAt: z.coerce.date(),
  requiredMinutes: z.number().int().min(1).max(100000),
  channels: z.array(z.string().regex(/^[A-Za-z0-9_]{1,25}$/)).default([]),
  rewards: z.array(z.string().max(200)).default([]),
  published: z.boolean().default(true),
});

export const adminRoutes: FastifyPluginAsync = async (app) => {
  app.addHook("preHandler", app.requireAdmin);

  const audit = (actorId: string, action: string, target?: string, meta?: object) =>
    prisma.auditLog.create({ data: { actorId, action, target, meta } });

  // Сводка для дашборда админ-панели.
  app.get("/stats", async () => {
    const [users, paying, campaigns, aiToday] = await Promise.all([
      prisma.user.count(),
      prisma.subscription.count({ where: { status: "active", plan: { not: "free" } } }),
      prisma.campaign.count({ where: { endsAt: { gt: new Date() } } }),
      prisma.aiRequest.count({ where: { createdAt: { gt: new Date(Date.now() - 86400000) } } }),
    ]);
    return { users, paying, activeCampaigns: campaigns, aiRequests24h: aiToday };
  });

  // Раздел «Система»: состояние сервиса без секретов.
  app.get("/system", async () => {
    let db = true;
    try {
      await prisma.$queryRaw`SELECT 1`;
    } catch {
      db = false;
    }
    const [keysFree, keysActive, keysBlocked] = await Promise.all([
      prisma.licenseKey.count({ where: { redeemedAt: null, blockedAt: null } }),
      prisma.licenseKey.count({ where: { redeemedAt: { not: null }, blockedAt: null } }),
      prisma.licenseKey.count({ where: { blockedAt: { not: null } } }),
    ]);
    return {
      version: process.env.npm_package_version ?? "0.4.0",
      node: process.version,
      uptimeSec: Math.round(process.uptime()),
      memoryMb: Math.round(process.memoryUsage().rss / 1048576),
      db: { ok: db },
      twitch: twitch.stats(),
      keys: { free: keysFree, activated: keysActive, blocked: keysBlocked },
    };
  });

  app.get("/users", async (req) => {
    const { cursor } = z.object({ cursor: z.string().optional() }).parse(req.query);
    const rows = await prisma.user.findMany({
      take: 50,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      orderBy: { createdAt: "desc" },
      select: { id: true, email: true, role: true, createdAt: true, subscription: true },
    });
    return { rows, nextCursor: rows.length === 50 ? rows[rows.length - 1].id : null };
  });

  // Ручная выдача/снятие тарифа (поддержка, промо). Следующий webhook Stripe может её перезаписать.
  app.put("/users/:id/plan", async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = z.object({ plan: z.enum(["free", "pro", "team"]) }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_input" });
    const { plan } = body.data;
    const status = plan === "free" ? "inactive" : "active";
    await prisma.subscription.upsert({
      where: { userId: id },
      update: { plan, status, source: "key", currentPeriodEnd: null },
      create: { userId: id, plan, status, source: "key" },
    });
    await audit(req.user.sub, "user.plan", id, { plan });
    return { ok: true };
  });

  // ---- Ключи активации ----

  // Генерация пачки. Открытые ключи возвращаются ТОЛЬКО в этом ответе; в БД — HMAC-хэши.
  app.post("/keys", async (req, reply) => {
    const body = z
      .object({
        plan: z.enum(["pro", "team"]),
        durationDays: z.number().int().min(1).max(3650).nullable(),
        count: z.number().int().min(1).max(200).default(1),
        note: z.string().trim().max(200).optional(),
      })
      .safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_input" });
    const { plan, durationDays, count, note } = body.data;

    const batch = randomUUID();
    const codes: string[] = [];
    const rows = [];
    for (let i = 0; i < count; i++) {
      const code = generateCode();
      const normalized = normalizeCode(code)!;
      codes.push(code);
      rows.push({
        codeHash: hashCode(normalized),
        hint: hintOf(normalized),
        plan,
        durationDays,
        note: note || null,
        batch,
        createdById: req.user.sub,
      });
    }
    await prisma.licenseKey.createMany({ data: rows });
    // В аудит попадают параметры пачки, но не сами ключи.
    await audit(req.user.sub, "keys.create", batch, { plan, durationDays, count, note });
    return { batch, codes };
  });

  app.get("/keys", async (req) => {
    const { cursor } = z.object({ cursor: z.string().optional() }).parse(req.query);
    const rows = await prisma.licenseKey.findMany({
      take: 50,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        hint: true,
        plan: true,
        durationDays: true,
        note: true,
        batch: true,
        createdAt: true,
        redeemedAt: true,
        blockedAt: true,
        redeemedBy: { select: { email: true } },
      },
    });
    return { rows, nextCursor: rows.length === 50 ? rows[rows.length - 1].id : null };
  });

  // Блокировка работает и для уже активированных ключей: тариф пользователя перестаёт действовать,
  // пока ключ не разблокирован (срок при этом не «съедается»: окончание хранится в подписке).
  app.post("/keys/:id/block", async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const res = await prisma.licenseKey.updateMany({ where: { id, blockedAt: null }, data: { blockedAt: new Date() } });
    if (res.count === 0) return reply.code(409).send({ error: "already_blocked_or_missing" });
    await audit(req.user.sub, "keys.block", id);
    return { ok: true };
  });

  app.post("/keys/:id/unblock", async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const res = await prisma.licenseKey.updateMany({ where: { id, blockedAt: { not: null } }, data: { blockedAt: null } });
    if (res.count === 0) return reply.code(409).send({ error: "not_blocked_or_missing" });
    await audit(req.user.sub, "keys.unblock", id);
    return { ok: true };
  });

  app.get("/campaigns", async () => prisma.campaign.findMany({ orderBy: { endsAt: "desc" } }));

  app.post("/campaigns", async (req, reply) => {
    const data = campaignInput.safeParse(req.body);
    if (!data.success) return reply.code(400).send({ error: "invalid_input", details: data.error.flatten() });
    if (data.data.endsAt <= data.data.startsAt) return reply.code(400).send({ error: "bad_dates" });
    const created = await prisma.campaign.create({ data: data.data });
    await audit(req.user.sub, "campaign.create", created.id);
    return created;
  });

  app.put("/campaigns/:id", async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const data = campaignInput.partial().safeParse(req.body);
    if (!data.success) return reply.code(400).send({ error: "invalid_input" });
    const updated = await prisma.campaign.update({ where: { id }, data: data.data });
    await audit(req.user.sub, "campaign.update", id);
    return updated;
  });

  app.delete("/campaigns/:id", async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    await prisma.campaign.delete({ where: { id } });
    await audit(req.user.sub, "campaign.delete", id);
    return { ok: true };
  });

  app.get("/audit", async () =>
    prisma.auditLog.findMany({ orderBy: { createdAt: "desc" }, take: 100 })
  );
};

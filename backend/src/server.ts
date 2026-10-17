import Fastify from "fastify";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import jwt from "@fastify/jwt";
import rateLimit from "@fastify/rate-limit";
import { prisma } from "./db.js";
import { ensureAdmin } from "./bootstrap.js";
import { twitch } from "./twitch.js";
import { authRoutes } from "./routes/auth.js";
import { licenseRoutes } from "./routes/license.js";
import { billingRoutes } from "./routes/billing.js";
import { campaignRoutes } from "./routes/campaigns.js";
import { channelRoutes } from "./routes/channels.js";
import { adminRoutes } from "./routes/admin.js";
import { aiRoutes } from "./routes/ai.js";

declare module "fastify" {
  interface FastifyInstance {
    authenticate: (req: any, reply: any) => Promise<void>;
    requireAdmin: (req: any, reply: any) => Promise<void>;
  }
}

declare module "@fastify/jwt" {
  interface FastifyJWT {
    payload: { sub: string; role: "USER" | "ADMIN" };
    user: { sub: string; role: "USER" | "ADMIN" };
  }
}

export const VERSION = process.env.npm_package_version ?? "0.4.0";
const startedAt = Date.now();

const secret = process.env.JWT_SECRET;
if (!secret || secret.length < 32) {
  throw new Error("JWT_SECRET must be set and at least 32 characters long");
}

const app = Fastify({
  trustProxy: true,
  logger: {
    level: process.env.LOG_LEVEL ?? "info",
    // Токены сессий и cookie никогда не попадают в логи. Тела запросов (пароли, ключи) Fastify не логирует.
    redact: ["req.headers.authorization", "req.headers.cookie"],
  },
});

await app.register(helmet);
await app.register(cors, {
  origin: (process.env.CORS_ORIGINS ?? "").split(",").filter(Boolean),
  credentials: true,
});
await app.register(rateLimit, { max: 120, timeWindow: "1 minute" });
await app.register(jwt, { secret, sign: { expiresIn: "7d" } });

app.decorate("authenticate", async (req: any, reply: any) => {
  try {
    await req.jwtVerify();
  } catch {
    return reply.code(401).send({ error: "unauthorized" });
  }
});

app.decorate("requireAdmin", async (req: any, reply: any) => {
  try {
    await req.jwtVerify();
  } catch {
    return reply.code(401).send({ error: "unauthorized" });
  }
  // Роль проверяем по БД, а не только по токену — отзыв прав действует сразу.
  const user = await prisma.user.findUnique({ where: { id: req.user.sub } });
  if (user?.role !== "ADMIN") return reply.code(403).send({ error: "forbidden" });
});

/** Безопасная сводка: без секретов, строк подключения и текстов ошибок. */
async function health() {
  let db = false;
  try {
    await Promise.race([
      prisma.$queryRaw`SELECT 1`,
      new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 2000)),
    ]);
    db = true;
  } catch {
    db = false;
  }
  const t = twitch.stats();
  return {
    ok: db,
    version: VERSION,
    uptimeSec: Math.round((Date.now() - startedAt) / 1000),
    db: { ok: db },
    twitch: { configured: t.configured, lastError: t.lastError },
    time: new Date().toISOString(),
  };
}

app.get("/health", async (_req, reply) => {
  const h = await health();
  return reply.code(h.ok ? 200 : 503).send(h);
});
app.get("/v1/health", async (_req, reply) => {
  const h = await health();
  return reply.code(h.ok ? 200 : 503).send(h);
});

await app.register(authRoutes, { prefix: "/v1/auth" });
await app.register(licenseRoutes, { prefix: "/v1/license" });
await app.register(billingRoutes, { prefix: "/v1/billing" });
await app.register(campaignRoutes, { prefix: "/v1/campaigns" });
await app.register(channelRoutes, { prefix: "/v1/channels" });
await app.register(aiRoutes, { prefix: "/v1/ai" });
await app.register(adminRoutes, { prefix: "/v1/admin" });

await ensureAdmin(app.log);

const port = Number(process.env.PORT ?? 4000);
await app.listen({ port, host: "0.0.0.0" });

// Корректное завершение: дожидаемся текущих запросов и закрываем соединение с БД.
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, async () => {
    app.log.info({ sig }, "shutting down");
    await app.close();
    await prisma.$disconnect();
    process.exit(0);
  });
}

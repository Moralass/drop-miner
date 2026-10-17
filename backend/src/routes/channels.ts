import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { twitch, TwitchUnavailable } from "../twitch.js";

const login = z.string().regex(/^[A-Za-z0-9_]{1,25}$/);

export const channelRoutes: FastifyPluginAsync = async (app) => {
  /**
   * LIVE/OFFLINE для списка каналов одним запросом (до 25).
   * Приложение опрашивает этот эндпоинт, а не Twitch напрямую: ключи Twitch остаются на сервере,
   * а лимиты Helix экономятся общим кэшем.
   */
  app.get(
    "/live",
    { preHandler: app.authenticate, config: { rateLimit: { max: 60, timeWindow: "1 minute" } } },
    async (req, reply) => {
      const q = z
        .object({ logins: z.string().min(1).max(1000) })
        .safeParse(req.query);
      if (!q.success) return reply.code(400).send({ error: "invalid_input" });
      const logins = q.data.logins.split(",").map((s) => s.trim()).filter(Boolean);
      if (logins.length < 1 || logins.length > 25 || !logins.every((l) => login.safeParse(l).success)) {
        return reply.code(400).send({ error: "invalid_input" });
      }

      try {
        const { channels, stale } = await twitch.getLive(logins);
        return { checkedAt: new Date().toISOString(), stale, channels };
      } catch (e) {
        if (e instanceof TwitchUnavailable) {
          if (e.reason === "not_configured") return reply.code(503).send({ error: "twitch_not_configured" });
          if (e.reason === "rate_limited") {
            if (e.retryAfterSec) reply.header("Retry-After", String(e.retryAfterSec));
            return reply.code(429).send({ error: "twitch_rate_limited", retryAfterSec: e.retryAfterSec });
          }
          return reply.code(502).send({ error: "twitch_unavailable" });
        }
        throw e;
      }
    }
  );

  /** Официальные обложки игр из каталога Twitch для списка кампаний (до 50 названий). */
  app.get(
    "/games",
    { preHandler: app.authenticate, config: { rateLimit: { max: 30, timeWindow: "1 minute" } } },
    async (req, reply) => {
      const q = z.object({ names: z.string().min(1).max(3000) }).safeParse(req.query);
      if (!q.success) return reply.code(400).send({ error: "invalid_input" });
      const names = q.data.names.split("|").map((s) => s.trim()).filter(Boolean);
      if (names.length < 1 || names.length > 50) return reply.code(400).send({ error: "invalid_input" });
      try {
        return { games: await twitch.getGameArt(names) };
      } catch (e) {
        if (e instanceof TwitchUnavailable) {
          if (e.reason === "not_configured") return reply.code(503).send({ error: "twitch_not_configured" });
          if (e.reason === "rate_limited") return reply.code(429).send({ error: "twitch_rate_limited", retryAfterSec: e.retryAfterSec });
          return reply.code(502).send({ error: "twitch_unavailable" });
        }
        throw e;
      }
    }
  );
};

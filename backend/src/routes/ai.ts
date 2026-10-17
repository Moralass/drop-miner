import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { prisma } from "../db.js";
import { effectivePlan } from "./license.js";

const LIMITS = {
  free: 0,
  pro: Number(process.env.AI_DAILY_LIMIT_PRO ?? 50),
  team: Number(process.env.AI_DAILY_LIMIT_TEAM ?? 200),
} as const;

const SYSTEM = `Ты — ассистент приложения Drop Miner, которое помогает планировать получение Twitch Drops
при обычном просмотре стримов. Отвечай по-русски, коротко и по делу.
Тебе дают список аккаунтов с прогрессом и список кампаний. Предложи, какому аккаунту какую кампанию
выгоднее проходить и почему, учитывая дедлайны и оставшееся время просмотра.
Не предлагай обходить правила Twitch, накручивать просмотры или имитировать зрителей.`;

const input = z.object({
  accounts: z
    .array(
      z.object({
        label: z.string().max(60),
        progress: z.record(z.string(), z.number()).default({}),
      })
    )
    .max(20),
  campaigns: z
    .array(
      z.object({
        id: z.string(),
        game: z.string().max(120),
        name: z.string().max(200),
        endsAt: z.string(),
        requiredMinutes: z.number(),
      })
    )
    .max(50),
});

export const aiRoutes: FastifyPluginAsync = async (app) => {
  // ИИ-совет по расписанию: доступен на платных тарифах, с дневным лимитом.
  app.post("/plan-advice", { preHandler: app.authenticate }, async (req, reply) => {
    const body = input.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_input" });

    const userId = req.user.sub;
    const plan = await effectivePlan(userId);
    const limit = LIMITS[plan];
    if (limit === 0) return reply.code(402).send({ error: "upgrade_required" });

    const used = await prisma.aiRequest.count({
      where: { userId, createdAt: { gt: new Date(Date.now() - 86400000) } },
    });
    if (used >= limit) return reply.code(429).send({ error: "daily_limit" });

    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY ?? "",
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: process.env.AI_MODEL ?? "claude-sonnet-5-5",
        max_tokens: 600,
        system: SYSTEM,
        messages: [{ role: "user", content: JSON.stringify(body.data) }],
      }),
    });
    if (!res.ok) return reply.code(502).send({ error: "ai_unavailable" });

    const data: any = await res.json();
    const text = data.content?.find((b: any) => b.type === "text")?.text ?? "";
    await prisma.aiRequest.create({
      data: {
        userId,
        kind: "plan-advice",
        tokens: (data.usage?.input_tokens ?? 0) + (data.usage?.output_tokens ?? 0),
      },
    });
    return { advice: text };
  });
};

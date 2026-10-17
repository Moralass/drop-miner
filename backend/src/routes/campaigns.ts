import type { FastifyPluginAsync } from "fastify";
import { prisma } from "../db.js";

export const campaignRoutes: FastifyPluginAsync = async (app) => {
  // Публичный список кампаний команды Drop Miner: активные, будущие и закончившиеся не более 7 дней назад.
  app.get("/", async () => {
    const rows = await prisma.campaign.findMany({
      where: { published: true, endsAt: { gt: new Date(Date.now() - 7 * 86_400_000) } },
      orderBy: { endsAt: "asc" },
    });
    return rows.map((c) => ({
      id: c.id,
      game: c.game,
      name: c.name,
      startsAt: c.startsAt.toISOString(),
      endsAt: c.endsAt.toISOString(),
      requiredMinutes: c.requiredMinutes,
      channels: c.channels,
      rewards: c.rewards,
    }));
  });
};

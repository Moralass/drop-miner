import type { FastifyPluginAsync } from "fastify";
import argon2 from "argon2";
import { z } from "zod";
import { prisma } from "../db.js";

const creds = z.object({
  email: z.string().email().max(254).transform((s) => s.toLowerCase()),
  password: z.string().min(10).max(128),
});

export const authRoutes: FastifyPluginAsync = async (app) => {
  // Строже общего лимита: защита от перебора паролей.
  const strict = { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } };

  app.post("/register", strict, async (req, reply) => {
    const parsed = creds.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_input" });
    const { email, password } = parsed.data;

    if (await prisma.user.findUnique({ where: { email } })) {
      return reply.code(409).send({ error: "email_taken" });
    }
    const user = await prisma.user.create({
      data: {
        email,
        passwordHash: await argon2.hash(password, { type: argon2.argon2id }),
        subscription: { create: {} },
      },
    });
    const token = app.jwt.sign({ sub: user.id, role: user.role });
    return { token };
  });

  app.post("/login", strict, async (req, reply) => {
    const parsed = creds.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_input" });
    const { email, password } = parsed.data;

    const user = await prisma.user.findUnique({ where: { email } });
    // Одинаковый ответ для «нет пользователя» и «неверный пароль».
    if (!user || !(await argon2.verify(user.passwordHash, password))) {
      return reply.code(401).send({ error: "invalid_credentials" });
    }
    return { token: app.jwt.sign({ sub: user.id, role: user.role }) };
  });
};

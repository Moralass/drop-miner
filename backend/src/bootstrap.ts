import argon2 from "argon2";
import { prisma } from "./db.js";

/**
 * Первый администратор создаётся из переменных окружения ADMIN_EMAIL / ADMIN_PASSWORD.
 * Существующему пользователю пароль не меняется — только выдаётся роль ADMIN.
 * Роль назначается только сервером; через API получить её нельзя.
 */
export async function ensureAdmin(log: { info: (m: string) => void }): Promise<void> {
  const email = process.env.ADMIN_EMAIL?.trim().toLowerCase();
  const password = process.env.ADMIN_PASSWORD;
  if (!email || !password) return;
  if (password.length < 12) throw new Error("ADMIN_PASSWORD must be at least 12 characters");

  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) {
    await prisma.user.create({
      data: {
        email,
        passwordHash: await argon2.hash(password, { type: argon2.argon2id }),
        role: "ADMIN",
        subscription: { create: {} },
      },
    });
    log.info("admin user created from environment");
  } else if (user.role !== "ADMIN") {
    await prisma.user.update({ where: { id: user.id }, data: { role: "ADMIN" } });
    log.info("existing user promoted to admin from environment");
  }
}

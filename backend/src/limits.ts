export type PlanName = "free" | "pro" | "team";

/** Сколько Twitch-аккаунтов можно подключить. Без подписки — только 1. */
export const ACCOUNT_LIMITS: Record<PlanName, number> = { free: 1, pro: 5, team: 20 };

/** Сколько устройств (установок приложения) можно привязать к лицензии. */
export const DEVICE_LIMITS: Record<PlanName, number> = { free: 1, pro: 2, team: 5 };

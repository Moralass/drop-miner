export type Plan = "free" | "pro" | "team";

/** Должно совпадать с backend/src/limits.ts. Реальная проверка — на сервере. */
export const ACCOUNT_LIMITS: Record<Plan, number> = {
  free: 1,
  pro: 5,
  team: 20,
};

export interface Campaign {
  id: string;
  game: string;
  name: string;
  startsAt: string; // ISO
  endsAt: string; // ISO
  requiredMinutes: number;
  /** Пустой массив = подходит любой стример игры */
  channels: string[];
  rewards: string[];
}

export interface Account {
  id: string; // uuid, он же id на сервере и имя папки профиля
  label: string; // название для отображения
  /** false = аккаунт сверх лимита тарифа: заблокирован, пока не продлите подписку */
  active: boolean;
  minutesByCampaign: Record<string, number>;
  /** Не используется как «получено»: награду подтверждает только источник (Twitch), которого у нас нет */
  claimed: string[];
  /** Канал, выбранный вручную (приоритетнее каналов кампании) */
  channel?: string;
  /** Кампания, выбранная вручную кнопкой «Начать» (приоритетнее автоподбора) */
  pinned?: string;
}

export interface Assignment {
  accountId: string;
  campaignId: string;
  /** Кандидаты из кампании (пусто = подходит любой стример, канал выбирается вручную) */
  channels: string[];
}

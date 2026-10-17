import type { MonitorEvent } from "./engine";

export type Severity = "info" | "warning" | "error";

export interface AppNotification {
  id: string;
  at: number;
  severity: Severity;
  title: string;
  message?: string;
  accountId?: string;
  /** Ключ дедупликации: одинаковые события в окне схлопываются в одно с счётчиком */
  key: string;
  count: number;
  read: boolean;
}

export interface NewNotification {
  severity: Severity;
  title: string;
  message?: string;
  accountId?: string;
  key: string;
}

export const DEDUPE_WINDOW_MS = 10 * 60_000;
export const MAX_NOTIFICATIONS = 200;

let seq = 0;

/** Добавляет уведомление. Повтор с тем же key в пределах окна увеличивает счётчик, а не засоряет список. */
export function addNotification(
  items: AppNotification[],
  n: NewNotification,
  now: number,
  windowMs = DEDUPE_WINDOW_MS,
  max = MAX_NOTIFICATIONS
): AppNotification[] {
  const idx = items.findIndex((i) => i.key === n.key && now - i.at < windowMs);
  if (idx >= 0) {
    const next = items.slice();
    next[idx] = { ...items[idx], at: now, count: items[idx].count + 1, message: n.message ?? items[idx].message };
    return next;
  }
  const item: AppNotification = { ...n, id: `${now}-${++seq}`, at: now, count: 1, read: false };
  return [item, ...items].slice(0, max);
}

export const markRead = (items: AppNotification[], id: string): AppNotification[] =>
  items.map((i) => (i.id === id ? { ...i, read: true } : i));

export const markAllRead = (items: AppNotification[]): AppNotification[] =>
  items.every((i) => i.read) ? items : items.map((i) => (i.read ? i : { ...i, read: true }));

export const unreadCount = (items: AppNotification[]): number => items.filter((i) => !i.read).length;

/** События движка -> уведомления. Первое определение статуса при запуске (CHECKING -> LIVE) шума не создаёт. */
export function eventToNotification(e: MonitorEvent, label: string): NewNotification | null {
  const base = { accountId: e.accountId };
  switch (e.type) {
    case "status":
      if (e.from === "OFFLINE" && e.to === "LIVE") {
        return { ...base, severity: "info", title: `${label}: трансляция началась`, message: e.channel, key: `live:${e.accountId}` };
      }
      if (e.from === "LIVE" && e.to === "OFFLINE") {
        return { ...base, severity: "info", title: `${label}: трансляция закончилась`, key: `offline:${e.accountId}` };
      }
      if (e.to === "DISCONNECTED" && e.from && e.from !== "CHECKING") {
        return { ...base, severity: "warning", title: `${label}: канал не выбран`, key: `disc:${e.accountId}` };
      }
      return null;
    case "error":
      return { ...base, severity: "error", title: `${label}: ошибка проверки`, message: e.message, key: `error:${e.accountId}:${e.message}` };
    case "rate_limit":
      return { ...base, severity: "warning", title: `${label}: лимит запросов`, message: "Проверки замедлены, повтор позже", key: `rate:${e.accountId}` };
    case "recovered":
      return { ...base, severity: "info", title: `${label}: проверка восстановлена`, key: `recovered:${e.accountId}` };
  }
}

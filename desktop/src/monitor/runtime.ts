import { useSyncExternalStore } from "react";
import { api, ApiError } from "../lib/api";
import { useStore } from "../lib/store";
import { createBatchedAdapter, type LiveInfo } from "./batch";
import { MonitorEngine, RateLimitError, type AccountState } from "./engine";

/** Один запрос на пачку каналов. Токены Twitch в приложении не используются: опрос идёт через наш сервер. */
export async function fetchBatch(logins: string[]): Promise<Record<string, LiveInfo>> {
  try {
    const r = await api<{ channels: Record<string, LiveInfo> }>(
      `/v1/channels/live?logins=${encodeURIComponent(logins.join(","))}`,
      { token: useStore.getState().token }
    );
    return r.channels;
  } catch (e) {
    if (e instanceof ApiError) {
      if (e.status === 429) throw new RateLimitError((Number(e.data?.retryAfterSec) || 30) * 1000);
      if (e.status === 503) throw new Error("Мониторинг недоступен (N/A): на сервере не настроен Twitch API");
      if (e.status === 502) throw new Error("Twitch API временно недоступен");
      if (e.status === 401) {
        useStore.getState().logout();
        throw new Error("Сессия истекла");
      }
      if (e.status === 0) throw new Error("Нет связи с сервером");
      throw new Error(`Ошибка сервера (${e.status})`);
    }
    throw e;
  }
}

/** Единственный экземпляр на приложение: задачи аккаунтов живут независимо от открытого экрана. */
export const engine = new MonitorEngine({
  adapter: createBatchedAdapter(fetchBatch),
  intervalMs: 60_000,
  maxConcurrency: 8,
  onEvent: (e) => useStore.getState().handleMonitorEvent(e),
});

interface Snapshot {
  states: AccountState[];
  stats: ReturnType<MonitorEngine["stats"]>;
}

// Снимок кэшируется до следующего изменения: useSyncExternalStore требует стабильную ссылку.
let snap: Snapshot | null = null;
engine.subscribe(() => {
  snap = null;
});
const getSnapshot = (): Snapshot => (snap ??= { states: engine.snapshot(), stats: engine.stats() });

export function useMonitor(): Snapshot {
  return useSyncExternalStore((cb) => engine.subscribe(cb), getSnapshot);
}

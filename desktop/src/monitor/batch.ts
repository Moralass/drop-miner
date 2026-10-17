import type { Adapter, CheckResult, Target } from "./engine";

export interface LiveInfo {
  live: boolean;
  game?: string;
  viewers?: number;
}

export type FetchBatch = (logins: string[]) => Promise<Record<string, LiveInfo>>;

interface Pending {
  target: Target;
  signal: AbortSignal;
  resolve: (r: CheckResult) => void;
  reject: (e: unknown) => void;
  onAbort: () => void;
}

const abortError = () => Object.assign(new Error("aborted"), { name: "AbortError" });

/**
 * Склеивает проверки многих аккаунтов, пришедшие почти одновременно, в один сетевой запрос
 * (50 аккаунтов = 1-2 запроса вместо 50). Результат каждому аккаунту считается отдельно;
 * отмена одного аккаунта не отменяет общий запрос и не влияет на остальных.
 */
export function createBatchedAdapter(fetchBatch: FetchBatch, opts: { windowMs?: number; maxLogins?: number } = {}): Adapter {
  const windowMs = opts.windowMs ?? 50;
  const maxLogins = opts.maxLogins ?? 25;
  let pending: Pending[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;

  const flush = () => {
    timer = null;
    const batch = pending;
    pending = [];

    // Жадно собираем группы так, чтобы в группе было не больше maxLogins уникальных каналов.
    const groups: { entries: Pending[]; logins: Set<string> }[] = [];
    for (const entry of batch) {
      entry.signal.removeEventListener("abort", entry.onAbort);
      if (entry.signal.aborted) continue;
      const logins = entry.target.channels.slice(0, maxLogins);
      let g = groups.find((x) => new Set([...x.logins, ...logins]).size <= maxLogins);
      if (!g) groups.push((g = { entries: [], logins: new Set() }));
      g.entries.push(entry);
      logins.forEach((l) => g!.logins.add(l.toLowerCase()));
    }

    for (const g of groups) {
      fetchBatch([...g.logins]).then(
        (channels) => {
          for (const entry of g.entries) {
            if (entry.signal.aborted) {
              entry.reject(abortError());
              continue;
            }
            const found = entry.target.channels
              .slice(0, maxLogins)
              .map((c) => ({ c, info: channels[c.toLowerCase()] }))
              .find((x) => x.info?.live);
            entry.resolve(
              found
                ? { live: true, channel: found.c, game: found.info!.game, viewers: found.info!.viewers }
                : { live: false }
            );
          }
        },
        (err) => g.entries.forEach((entry) => entry.reject(err))
      );
    }
  };

  return {
    check(target, signal) {
      return new Promise<CheckResult>((resolve, reject) => {
        if (signal.aborted) return reject(abortError());
        const entry: Pending = {
          target,
          signal,
          resolve,
          reject,
          onAbort: () => {
            pending = pending.filter((p) => p !== entry);
            reject(abortError());
          },
        };
        signal.addEventListener("abort", entry.onAbort, { once: true });
        pending.push(entry);
        if (!timer) timer = setTimeout(flush, windowMs);
      });
    },
  };
}

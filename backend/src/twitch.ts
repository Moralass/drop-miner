/**
 * Клиент официального Twitch Helix API: только публичные данные о трансляциях (Get Streams)
 * по app access token (client credentials). Токены пользователей Twitch сервер не получает и не хранит.
 *
 * Что учтено: кэш на 45 секунд, дедупликация одновременных запросов, пачки до 100 логинов,
 * повторное получение токена при 401, 429 (пауза до Ratelimit-Reset / Retry-After), 5xx, таймаут, сетевые ошибки.
 * Не проверено на реальных credentials — см. docs/PLAN.md.
 */

export interface LiveInfo {
  live: boolean;
  game?: string;
  viewers?: number;
}

export type UnavailableReason = "not_configured" | "rate_limited" | "upstream";

export class TwitchUnavailable extends Error {
  constructor(public reason: UnavailableReason, public retryAfterSec?: number) {
    super(reason);
  }
}

export interface TwitchOptions {
  clientId?: string;
  clientSecret?: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  ttlMs?: number;
  /** Сколько держим устаревший кэш как запасной ответ при сбое Twitch */
  staleMs?: number;
  timeoutMs?: number;
  urls?: { id: string; api: string };
}

interface CacheEntry {
  info: LiveInfo;
  at: number;
}

const LOGIN_RE = /^[a-z0-9_]{1,25}$/;
const BATCH = 100;
const GAME_TTL_MS = 24 * 3600_000;

export class TwitchLive {
  private readonly o: Required<Omit<TwitchOptions, "clientId" | "clientSecret">> & Pick<TwitchOptions, "clientId" | "clientSecret">;
  private token: { value: string; expiresAt: number } | null = null;
  private cache = new Map<string, CacheEntry>();
  private inflight = new Map<string, Promise<void>>();
  private gameCache = new Map<string, { at: number; art: string | null }>();
  private blockedUntil = 0;
  /** Код последней ошибки (не текст ответа Twitch) — для /health и админки */
  lastError: UnavailableReason | null = null;
  requests = 0;

  constructor(opts: TwitchOptions = {}) {
    this.o = {
      clientId: opts.clientId,
      clientSecret: opts.clientSecret,
      fetchImpl: opts.fetchImpl ?? fetch,
      now: opts.now ?? Date.now,
      ttlMs: opts.ttlMs ?? 45_000,
      staleMs: opts.staleMs ?? 10 * 60_000,
      timeoutMs: opts.timeoutMs ?? 8_000,
      urls: opts.urls ?? { id: "https://id.twitch.tv", api: "https://api.twitch.tv" },
    };
  }

  get configured(): boolean {
    return !!this.o.clientId && !!this.o.clientSecret;
  }

  async getLive(input: string[]): Promise<{ channels: Record<string, LiveInfo>; stale: boolean }> {
    if (!this.configured) throw new TwitchUnavailable("not_configured");

    const logins = [...new Set(input.map((l) => l.toLowerCase()))].filter((l) => LOGIN_RE.test(l));
    const now = this.o.now();
    const fresh = (l: string) => {
      const e = this.cache.get(l);
      return !!e && now - e.at < this.o.ttlMs;
    };
    const need = logins.filter((l) => !fresh(l));

    let stale = false;
    if (need.length) {
      try {
        await this.refresh(need);
      } catch (e) {
        // При сбое отдаём недавний кэш, если он есть для всех запрошенных каналов.
        const usable = need.every((l) => {
          const c = this.cache.get(l);
          return !!c && this.o.now() - c.at < this.o.staleMs;
        });
        if (!usable) throw e;
        stale = true;
      }
    }

    const channels: Record<string, LiveInfo> = {};
    for (const l of logins) channels[l] = this.cache.get(l)?.info ?? { live: false };
    return { channels, stale };
  }

  /**
   * Официальные обложки игр из каталога Twitch (Helix Get Games, поле box_art_url).
   * Картинки не копируются на наш сервер: отдаём только ссылку на CDN Twitch, кэш 24 часа.
   * Если игра не найдена, значение null, и приложение показывает нейтральную заглушку.
   */
  async getGameArt(input: string[]): Promise<Record<string, string | null>> {
    if (!this.configured) throw new TwitchUnavailable("not_configured");
    const names = [...new Set(input.map((n) => n.trim()).filter((n) => n.length > 0 && n.length <= 100))].slice(0, 100);
    const now = this.o.now();
    const need = names.filter((n) => {
      const e = this.gameCache.get(n.toLowerCase());
      return !e || now - e.at > GAME_TTL_MS;
    });

    if (need.length) {
      if (now < this.blockedUntil) throw new TwitchUnavailable("rate_limited", Math.ceil((this.blockedUntil - now) / 1000));
      const call = async () => {
        const token = await this.ensureToken();
        this.requests++;
        const qs = need.map((n) => `name=${encodeURIComponent(n)}`).join("&");
        return this.http(`${this.o.urls.api}/helix/games?${qs}`, {
          headers: { "Client-Id": this.o.clientId!, Authorization: `Bearer ${token}` },
        });
      };
      let res = await call();
      if (res.status === 401) {
        this.token = null;
        res = await call();
      }
      if (res.status === 429) {
        const wait = this.retryAfterSec(res);
        this.blockedUntil = this.o.now() + wait * 1000;
        this.lastError = "rate_limited";
        throw new TwitchUnavailable("rate_limited", wait);
      }
      const body = res.ok ? ((await res.json().catch(() => null)) as { data?: any[] } | null) : null;
      if (!body || !Array.isArray(body.data)) {
        this.lastError = "upstream";
        throw new TwitchUnavailable("upstream");
      }
      const found = new Map<string, string>();
      for (const g of body.data) {
        const url = typeof g?.box_art_url === "string" ? g.box_art_url.replace("{width}x{height}", "144x192") : "";
        // Принимаем только https-ссылки на CDN Twitch.
        if (typeof g?.name === "string" && url.startsWith("https://static-cdn.jtvnw.net/")) found.set(g.name.toLowerCase(), url);
      }
      const at = this.o.now();
      for (const n of need) this.gameCache.set(n.toLowerCase(), { at, art: found.get(n.toLowerCase()) ?? null });
      this.lastError = null;
    }

    const out: Record<string, string | null> = {};
    for (const n of names) out[n] = this.gameCache.get(n.toLowerCase())?.art ?? null;
    return out;
  }

  /** Запрашивает только то, чего ещё нет в полёте; параллельные вызовы ждут общий запрос. */
  private async refresh(need: string[]): Promise<void> {
    const waiting: Promise<void>[] = [];
    const toFetch: string[] = [];
    for (const l of need) {
      const p = this.inflight.get(l);
      if (p) waiting.push(p);
      else toFetch.push(l);
    }

    for (let i = 0; i < toFetch.length; i += BATCH) {
      const chunk = toFetch.slice(i, i + BATCH);
      const p = this.fetchChunk(chunk).finally(() => {
        for (const l of chunk) this.inflight.delete(l);
      });
      for (const l of chunk) this.inflight.set(l, p);
      waiting.push(p);
    }
    await Promise.all(waiting);
  }

  private async fetchChunk(chunk: string[]): Promise<void> {
    const now = this.o.now();
    if (now < this.blockedUntil) {
      throw new TwitchUnavailable("rate_limited", Math.ceil((this.blockedUntil - now) / 1000));
    }

    let res = await this.callStreams(chunk);
    if (res.status === 401) {
      this.token = null; // токен отозван или истёк раньше срока — получаем новый и повторяем один раз
      res = await this.callStreams(chunk);
    }
    if (res.status === 429) {
      const wait = this.retryAfterSec(res);
      this.blockedUntil = this.o.now() + wait * 1000;
      this.lastError = "rate_limited";
      throw new TwitchUnavailable("rate_limited", wait);
    }
    if (!res.ok) {
      this.lastError = "upstream";
      throw new TwitchUnavailable("upstream");
    }

    const body = (await res.json().catch(() => null)) as { data?: any[] } | null;
    if (!body || !Array.isArray(body.data)) {
      this.lastError = "upstream";
      throw new TwitchUnavailable("upstream");
    }

    const at = this.o.now();
    const live = new Map<string, any>();
    for (const s of body.data) {
      if (s?.type === "live" && typeof s.user_login === "string") live.set(s.user_login.toLowerCase(), s);
    }
    for (const l of chunk) {
      const s = live.get(l);
      this.cache.set(l, {
        at,
        info: s ? { live: true, game: s.game_name || undefined, viewers: Number(s.viewer_count) || 0 } : { live: false },
      });
    }
    this.lastError = null;
    this.prune();
  }

  private async callStreams(chunk: string[]): Promise<Response> {
    const token = await this.ensureToken();
    const qs = chunk.map((l) => `user_login=${encodeURIComponent(l)}`).join("&");
    this.requests++;
    return this.http(`${this.o.urls.api}/helix/streams?first=${BATCH}&${qs}`, {
      headers: { "Client-Id": this.o.clientId!, Authorization: `Bearer ${token}` },
    });
  }

  private async ensureToken(): Promise<string> {
    const now = this.o.now();
    if (this.token && now < this.token.expiresAt - 60_000) return this.token.value;

    const res = await this.http(`${this.o.urls.id}/oauth2/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: this.o.clientId!,
        client_secret: this.o.clientSecret!,
        grant_type: "client_credentials",
      }),
    });
    if (res.status === 429) {
      const wait = this.retryAfterSec(res);
      this.blockedUntil = this.o.now() + wait * 1000;
      this.lastError = "rate_limited";
      throw new TwitchUnavailable("rate_limited", wait);
    }
    const data = (await res.json().catch(() => null)) as { access_token?: string; expires_in?: number } | null;
    if (!res.ok || !data?.access_token) {
      this.lastError = "upstream";
      throw new TwitchUnavailable("upstream");
    }
    this.token = { value: data.access_token, expiresAt: this.o.now() + (data.expires_in ?? 3600) * 1000 };
    return this.token.value;
  }

  /** fetch с таймаутом; сетевые ошибки превращаются в TwitchUnavailable("upstream"). */
  private async http(url: string, init: RequestInit): Promise<Response> {
    try {
      return await this.o.fetchImpl(url, { ...init, signal: AbortSignal.timeout(this.o.timeoutMs) });
    } catch {
      this.lastError = "upstream";
      throw new TwitchUnavailable("upstream");
    }
  }

  private retryAfterSec(res: Response): number {
    const ra = Number(res.headers.get("retry-after"));
    if (Number.isFinite(ra) && ra > 0) return Math.min(Math.ceil(ra), 300);
    const reset = Number(res.headers.get("ratelimit-reset")); // epoch-секунды
    if (Number.isFinite(reset) && reset > 0) {
      return Math.min(Math.max(1, Math.ceil(reset - this.o.now() / 1000)), 300);
    }
    return 30;
  }

  private prune(): void {
    if (this.cache.size < 5000) return;
    const cutoff = this.o.now() - this.o.staleMs;
    for (const [k, v] of this.cache) if (v.at < cutoff) this.cache.delete(k);
  }

  stats() {
    return { configured: this.configured, cached: this.cache.size, requests: this.requests, lastError: this.lastError };
  }
}

export const twitch = new TwitchLive({
  clientId: process.env.TWITCH_CLIENT_ID,
  clientSecret: process.env.TWITCH_CLIENT_SECRET,
});

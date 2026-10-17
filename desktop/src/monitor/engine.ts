/**
 * Движок мониторинга: у каждого аккаунта своя независимая задача.
 *
 *  - Аккаунты проверяются ПАРАЛЛЕЛЬНО (async-задачи), а не по очереди. Общий потолок `maxConcurrency`
 *    нужен только чтобы не завалить API; очередь ожидания не превращает мониторинг в последовательный.
 *  - Состояние, ошибки и таймеры хранятся отдельно для каждого аккаунта: сбой одного не трогает остальных.
 *  - Повторы идут с экспоненциальным backoff и джиттером; 429 уважает Retry-After. Тугих циклов нет:
 *    следующая проверка всегда ставится таймером не раньше `minDelayMs`.
 *  - Удаление аккаунта отменяет его задачу (AbortSignal) и таймер; результат отменённой проверки отбрасывается.
 *  - Дедупликация: пока проверка аккаунта в полёте, повторный `checkNow` возвращает тот же промис.
 *  - События пишутся только при смене статуса; одинаковая ошибка подряд не плодит события.
 */

export type MonitorStatus = "DISCONNECTED" | "CHECKING" | "LIVE" | "OFFLINE" | "ERROR";

export interface Target {
  accountId: string;
  /** Кандидаты: берётся первый, который в эфире. Пусто = канал не выбран (DISCONNECTED). */
  channels: string[];
}

export interface CheckResult {
  live: boolean;
  /** Какой из каналов в эфире */
  channel?: string;
  game?: string;
  viewers?: number;
}

export interface Adapter {
  check(target: Target, signal: AbortSignal): Promise<CheckResult>;
}

/** Адаптер бросает это при 429, чтобы движок выдержал паузу. */
export class RateLimitError extends Error {
  constructor(public retryAfterMs: number) {
    super("rate_limited");
  }
}

export interface AccountState {
  accountId: string;
  status: MonitorStatus;
  channel?: string;
  game?: string;
  viewers?: number;
  lastCheckAt: number | null;
  nextCheckAt: number | null;
  lastError: string | null;
  consecutiveErrors: number;
  rateLimited: boolean;
}

export type MonitorEventType = "status" | "error" | "recovered" | "rate_limit";

export interface MonitorEvent {
  accountId: string;
  at: number;
  type: MonitorEventType;
  from?: MonitorStatus;
  to?: MonitorStatus;
  message?: string;
  channel?: string;
}

export interface EngineOptions {
  adapter: Adapter;
  /** Пауза между успешными проверками, мс */
  intervalMs?: number;
  /** Верхний предел одновременных проверок */
  maxConcurrency?: number;
  backoff?: { baseMs: number; maxMs: number; factor: number; jitter: number };
  /** Нижняя граница задержки: защита от тугого цикла при intervalMs=0 */
  minDelayMs?: number;
  onEvent?: (e: MonitorEvent) => void;
  now?: () => number;
  random?: () => number;
}

interface Task {
  target: Target;
  state: AccountState;
  timer: ReturnType<typeof setTimeout> | null;
  abort: AbortController | null;
  inflight: Promise<void> | null;
  removed: boolean;
}

export class MonitorEngine {
  private o: Required<Omit<EngineOptions, "onEvent">> & Pick<EngineOptions, "onEvent">;
  private tasks = new Map<string, Task>();
  private waiters: (() => void)[] = [];
  private running = 0;
  private stopped = false;
  private subscribers = new Set<() => void>();
  peakConcurrency = 0;

  constructor(opts: EngineOptions) {
    this.o = {
      adapter: opts.adapter,
      intervalMs: opts.intervalMs ?? 60_000,
      maxConcurrency: opts.maxConcurrency ?? 8,
      backoff: opts.backoff ?? { baseMs: 5_000, maxMs: 10 * 60_000, factor: 2, jitter: 0.2 },
      minDelayMs: opts.minDelayMs ?? 1,
      onEvent: opts.onEvent,
      now: opts.now ?? Date.now,
      random: opts.random ?? Math.random,
    };
  }

  /** Приводит набор задач к списку целей: новые запускаются, изменённые перезапускаются, лишние отменяются. */
  setTargets(targets: Target[]): void {
    if (this.stopped) return;
    const want = new Map(targets.map((t) => [t.accountId, t]));

    for (const [id, task] of this.tasks) {
      if (!want.has(id)) this.removeTask(id, task);
    }
    for (const t of targets) {
      const existing = this.tasks.get(t.accountId);
      if (!existing) {
        this.addTask(t);
      } else if (existing.target.channels.join("|") !== t.channels.join("|")) {
        // Сменился список каналов — отменяем текущую проверку и начинаем заново.
        existing.abort?.abort();
        existing.target = t;
        existing.state.consecutiveErrors = 0;
        existing.state.lastError = null;
        this.schedule(existing, 0);
      }
    }
    this.notify();
  }

  /** Принудительная проверка. Если проверка уже идёт — возвращает тот же промис (дедупликация). */
  checkNow(accountId: string): Promise<void> {
    const task = this.tasks.get(accountId);
    if (!task || this.stopped) return Promise.resolve();
    if (task.inflight) return task.inflight;
    if (task.timer) {
      clearTimeout(task.timer);
      task.timer = null;
    }
    return this.run(task);
  }

  getState(accountId: string): AccountState | undefined {
    const t = this.tasks.get(accountId);
    return t ? { ...t.state } : undefined;
  }

  snapshot(): AccountState[] {
    return [...this.tasks.values()].map((t) => ({ ...t.state }));
  }

  /** Для дашборда: очередь и воркеры. */
  stats() {
    return {
      accounts: this.tasks.size,
      activeWorkers: this.running,
      queued: this.waiters.length,
      maxConcurrency: this.o.maxConcurrency,
      peakConcurrency: this.peakConcurrency,
    };
  }

  subscribe(fn: () => void): () => void {
    this.subscribers.add(fn);
    return () => this.subscribers.delete(fn);
  }

  /** Полная остановка: таймеры сняты, проверки отменены, ожидающие освобождены. */
  stop(): void {
    this.stopped = true;
    for (const [id, task] of [...this.tasks]) this.removeTask(id, task);
    this.subscribers.clear();
  }

  /* ---------------- внутреннее ---------------- */

  private addTask(target: Target): void {
    const task: Task = {
      target,
      timer: null,
      abort: null,
      inflight: null,
      removed: false,
      state: {
        accountId: target.accountId,
        status: "DISCONNECTED",
        lastCheckAt: null,
        nextCheckAt: null,
        lastError: null,
        consecutiveErrors: 0,
        rateLimited: false,
      },
    };
    this.tasks.set(target.accountId, task);
    this.schedule(task, 0);
  }

  private removeTask(id: string, task: Task): void {
    task.removed = true;
    if (task.timer) clearTimeout(task.timer);
    task.timer = null;
    task.abort?.abort();
    this.tasks.delete(id);
  }

  private schedule(task: Task, delayMs: number): void {
    if (task.removed || this.stopped) return;
    if (task.timer) clearTimeout(task.timer);
    const delay = Math.max(this.o.minDelayMs, delayMs);
    task.state.nextCheckAt = this.o.now() + delay;
    task.timer = setTimeout(() => {
      task.timer = null;
      void this.run(task);
    }, delay);
  }

  private run(task: Task): Promise<void> {
    if (task.inflight) return task.inflight;
    const p = this.execute(task).finally(() => {
      task.inflight = null;
    });
    task.inflight = p;
    return p;
  }

  private async execute(task: Task): Promise<void> {
    if (task.removed) return;

    if (task.target.channels.length === 0) {
      this.transition(task, "DISCONNECTED");
      task.state.lastCheckAt = this.o.now();
      this.schedule(task, this.o.intervalMs);
      this.notify();
      return;
    }

    const prev = task.state.status;
    // CHECKING показываем только если статус ещё неизвестен, чтобы LIVE/OFFLINE не мигали при каждом опросе.
    if (prev === "DISCONNECTED") this.transition(task, "CHECKING");

    await this.acquire();
    const abort = new AbortController();
    task.abort = abort;
    try {
      if (task.removed) return;
      const res = await this.o.adapter.check(task.target, abort.signal);
      if (task.removed || abort.signal.aborted) return this.afterDiscard(task); // результат отменённой проверки отбрасываем

      const hadError = task.state.consecutiveErrors > 0;
      task.state.consecutiveErrors = 0;
      task.state.lastError = null;
      task.state.rateLimited = false;
      task.state.lastCheckAt = this.o.now();
      task.state.channel = res.live ? res.channel : undefined;
      task.state.game = res.live ? res.game : undefined;
      task.state.viewers = res.live ? res.viewers : undefined;
      if (hadError) this.emit(task, { type: "recovered", message: "проверка снова проходит" });
      this.transition(task, res.live ? "LIVE" : "OFFLINE", res.channel);
      this.schedule(task, this.o.intervalMs);
    } catch (e) {
      if (task.removed || abort.signal.aborted) return this.afterDiscard(task);
      this.onFailure(task, e);
    } finally {
      this.release();
      if (task.abort === abort) task.abort = null;
      this.notify();
    }
  }

  /** Проверку отменили из-за смены каналов, но задача жива: гарантируем, что следующая проверка запланирована. */
  private afterDiscard(task: Task): void {
    if (!task.removed && !this.stopped && !task.timer) this.schedule(task, 0);
  }

  private onFailure(task: Task, e: unknown): void {
    const s = task.state;
    s.consecutiveErrors += 1;
    s.lastCheckAt = this.o.now();
    const message = e instanceof Error ? e.message : "ошибка проверки";
    const isRate = e instanceof RateLimitError;
    const newMessage = s.lastError !== message || s.status !== "ERROR";
    s.lastError = message;
    s.rateLimited = isRate;

    // Событие об ошибке — только при первой ошибке или смене её текста (дедупликация).
    if (newMessage) this.emit(task, { type: isRate ? "rate_limit" : "error", message });
    this.transition(task, "ERROR");

    const { baseMs, maxMs, factor, jitter } = this.o.backoff;
    let delay = Math.min(maxMs, baseMs * Math.pow(factor, s.consecutiveErrors - 1));
    delay *= 1 + (this.o.random() * 2 - 1) * jitter;
    if (isRate) delay = Math.max(delay, e.retryAfterMs);
    this.schedule(task, delay);
  }

  private transition(task: Task, to: MonitorStatus, channel?: string): void {
    const from = task.state.status;
    if (from === to) return;
    task.state.status = to;
    this.emit(task, { type: "status", from, to, channel });
  }

  private emit(task: Task, e: Omit<MonitorEvent, "accountId" | "at">): void {
    this.o.onEvent?.({ accountId: task.target.accountId, at: this.o.now(), ...e });
  }

  private notify(): void {
    for (const fn of this.subscribers) fn();
  }

  private acquire(): Promise<void> {
    if (this.running < this.o.maxConcurrency) {
      this.running++;
      this.peakConcurrency = Math.max(this.peakConcurrency, this.running);
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.waiters.push(() => {
        this.running++;
        this.peakConcurrency = Math.max(this.peakConcurrency, this.running);
        resolve();
      });
    });
  }

  private release(): void {
    this.running--;
    const next = this.waiters.shift();
    if (next) next();
  }
}

import { test } from "node:test";
import assert from "node:assert/strict";
import { MonitorEngine, RateLimitError, type Adapter, type MonitorEvent, type Target } from "./engine";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const targets = (n: number): Target[] =>
  Array.from({ length: n }, (_, i) => ({ accountId: `acc${i + 1}`, channels: [`ch${i + 1}`] }));

async function until(cond: () => boolean, timeoutMs = 4000, step = 4) {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > timeoutMs) throw new Error("timeout waiting for condition");
    await sleep(step);
  }
}

const zeroJitter = { baseMs: 30, maxMs: 400, factor: 2, jitter: 0 };

test("ОБЯЗАТЕЛЬНЫЙ СЦЕНАРИЙ: 5 аккаунтов проверяются параллельно (времена перекрываются)", async () => {
  const spans: { id: string; start: number; end: number }[] = [];
  const adapter: Adapter = {
    async check(t) {
      const start = performance.now();
      await sleep(120);
      spans.push({ id: t.accountId, start, end: performance.now() });
      return { live: true, channel: t.channels[0] };
    },
  };
  const engine = new MonitorEngine({ adapter, intervalMs: 10_000 });
  engine.setTargets(targets(5));
  await until(() => spans.length === 5);
  engine.stop();

  const lastStart = Math.max(...spans.map((s) => s.start));
  const firstEnd = Math.min(...spans.map((s) => s.end));
  const wall = Math.max(...spans.map((s) => s.end)) - Math.min(...spans.map((s) => s.start));
  assert.ok(lastStart < firstEnd, "все 5 проверок стартовали до окончания первой — выполнение перекрывается");
  assert.ok(wall < 120 * 2, `общее время ${wall.toFixed(0)} мс сильно меньше последовательных ${120 * 5} мс`);
});

test("изоляция: ошибка одного аккаунта не останавливает 4 остальных; backoff растёт; восстановление; дедупликация событий", async () => {
  let broken = true;
  const calls: Record<string, number[]> = {};
  const events: MonitorEvent[] = [];
  const adapter: Adapter = {
    async check(t) {
      (calls[t.accountId] ??= []).push(performance.now());
      await sleep(2);
      if (t.accountId === "acc3" && broken) throw new Error("boom");
      return { live: true, channel: t.channels[0], viewers: 10 };
    },
  };
  const engine = new MonitorEngine({ adapter, intervalMs: 40, backoff: zeroJitter, onEvent: (e) => events.push(e) });
  engine.setTargets(targets(5));

  await until(() => (calls["acc3"]?.length ?? 0) >= 4);

  // acc3 в ошибке, остальные работают и продолжают проверяться
  const s3 = engine.getState("acc3")!;
  assert.equal(s3.status, "ERROR");
  assert.equal(s3.lastError, "boom");
  assert.ok(s3.consecutiveErrors >= 3);
  for (const id of ["acc1", "acc2", "acc4", "acc5"]) {
    assert.equal(engine.getState(id)!.status, "LIVE", `${id} продолжает работать`);
    assert.ok(calls[id].length >= 5, `${id} проверялся ${calls[id].length} раз, пока acc3 в ошибке`);
  }

  // backoff: интервалы между неудачными попытками растут (≈30, 60, 120 мс)
  const t = calls["acc3"];
  const gaps = t.slice(1, 4).map((x, i) => x - t[i]);
  assert.ok(gaps[1] >= gaps[0] * 1.4, `gap2 ${gaps[1].toFixed(0)} >= 1.4*gap1 ${gaps[0].toFixed(0)}`);
  assert.ok(gaps[2] >= gaps[1] * 1.4, `gap3 ${gaps[2].toFixed(0)} >= 1.4*gap2 ${gaps[1].toFixed(0)}`);

  // событие об одинаковой ошибке записано один раз
  assert.equal(events.filter((e) => e.accountId === "acc3" && e.type === "error").length, 1);

  // восстановление
  broken = false;
  await until(() => engine.getState("acc3")!.status === "LIVE");
  engine.stop();
  const after = engine.snapshot();
  assert.equal(after.length, 0);
  assert.ok(events.some((e) => e.accountId === "acc3" && e.type === "recovered"), "событие recovered записано");
  assert.equal(events.filter((e) => e.type === "error").length, 1, "ошибок других аккаунтов не было");
});

test("429: пауза не короче Retry-After, статус rateLimited, событие rate_limit", async () => {
  let n = 0;
  const times: number[] = [];
  const events: MonitorEvent[] = [];
  const adapter: Adapter = {
    async check(t) {
      times.push(performance.now());
      if (++n === 1) throw new RateLimitError(200);
      return { live: false };
    },
  };
  const engine = new MonitorEngine({ adapter, intervalMs: 10_000, backoff: { ...zeroJitter, baseMs: 10 }, onEvent: (e) => events.push(e) });
  engine.setTargets(targets(1));
  await until(() => n === 1);
  await sleep(5);
  assert.equal(engine.getState("acc1")!.rateLimited, true);
  await until(() => n === 2);
  engine.stop();
  assert.ok(times[1] - times[0] >= 190, `пауза ${(times[1] - times[0]).toFixed(0)} мс >= 190`);
  assert.ok(events.some((e) => e.type === "rate_limit"));
});

test("отмена: удаление аккаунта прерывает проверку, таймеры сняты, состояние не меняется", async () => {
  let aborted = false;
  let started = 0;
  const events: MonitorEvent[] = [];
  const adapter: Adapter = {
    check(_t, signal) {
      started++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => resolve({ live: true, channel: "x" }), 300);
        signal.addEventListener("abort", () => {
          aborted = true;
          clearTimeout(timer);
          reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
        });
      });
    },
  };
  const engine = new MonitorEngine({ adapter, intervalMs: 20, onEvent: (e) => events.push(e) });
  engine.setTargets(targets(2));
  await until(() => started === 2);
  engine.setTargets([targets(2)[1]]); // acc1 удалён
  await sleep(10);
  assert.equal(aborted, true, "сигнал отмены дошёл до адаптера");
  assert.equal(engine.getState("acc1"), undefined);
  const startedBefore = started;
  await sleep(150);
  assert.equal(events.filter((e) => e.accountId === "acc1" && e.to === "LIVE").length, 0, "результат отменённой проверки отброшен");
  assert.equal(engine.stats().accounts, 1);
  engine.stop();
  await sleep(60);
  assert.equal(started, startedBefore + 0, "после stop() новых проверок нет");
});

test("дедупликация: checkNow во время проверки возвращает тот же промис, адаптер вызван один раз", async () => {
  let calls = 0;
  const adapter: Adapter = {
    async check() {
      calls++;
      await sleep(80);
      return { live: true, channel: "c" };
    },
  };
  const engine = new MonitorEngine({ adapter, intervalMs: 10_000 });
  engine.setTargets(targets(1));
  await until(() => calls === 1);
  const p1 = engine.checkNow("acc1");
  const p2 = engine.checkNow("acc1");
  assert.strictEqual(p1, p2);
  await p1;
  assert.equal(calls, 1);
  engine.stop();
});

test("потолок параллельности: пик не выше лимита, но проверки всё равно идут одновременно", async () => {
  let active = 0;
  let peak = 0;
  let done = 0;
  const adapter: Adapter = {
    async check() {
      peak = Math.max(peak, ++active);
      await sleep(60);
      active--;
      done++;
      return { live: true, channel: "c" };
    },
  };
  const engine = new MonitorEngine({ adapter, intervalMs: 10_000, maxConcurrency: 3 });
  const t0 = performance.now();
  engine.setTargets(targets(10));
  await until(() => done === 10);
  const wall = performance.now() - t0;
  engine.stop();
  assert.ok(peak <= 3, `пик ${peak} <= 3`);
  assert.ok(peak >= 2, "проверки не последовательные");
  assert.ok(wall < 10 * 60 * 0.7, `время ${wall.toFixed(0)} мс заметно меньше последовательных 600 мс`);
});

test("смена каналов отменяет текущую проверку и перезапускает задачу", async () => {
  const seen: string[] = [];
  const adapter: Adapter = {
    check(t, signal) {
      seen.push(t.channels[0]);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => resolve({ live: true, channel: t.channels[0] }), 100);
        signal.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
        });
      });
    },
  };
  const engine = new MonitorEngine({ adapter, intervalMs: 10_000 });
  engine.setTargets([{ accountId: "acc1", channels: ["old"] }]);
  await until(() => seen.length === 1);
  engine.setTargets([{ accountId: "acc1", channels: ["new"] }]);
  await until(() => engine.getState("acc1")!.status === "LIVE");
  engine.stop();
  assert.deepEqual(seen, ["old", "new"]);
});

test("аккаунт без канала — DISCONNECTED, адаптер не вызывается", async () => {
  let calls = 0;
  const engine = new MonitorEngine({ adapter: { check: async () => (calls++, { live: true }) }, intervalMs: 10_000 });
  engine.setTargets([{ accountId: "acc1", channels: [] }]);
  await sleep(30);
  assert.equal(engine.getState("acc1")!.status, "DISCONNECTED");
  assert.equal(calls, 0);
  engine.stop();
});

test("НАГРУЗКА через тестовый адаптер: 1/5/10/25/50 аккаунтов (не подтверждает реальные лимиты внешних API)", async () => {
  const rows: string[] = [];
  for (const n of [1, 5, 10, 25, 50]) {
    let active = 0;
    let peak = 0;
    const adapter: Adapter = {
      async check() {
        peak = Math.max(peak, ++active);
        await sleep(30);
        active--;
        return { live: true, channel: "c", viewers: 1 };
      },
    };
    const cap = 50;
    const engine = new MonitorEngine({ adapter, intervalMs: 10_000, maxConcurrency: cap });
    const t0 = performance.now();
    engine.setTargets(targets(n));
    await until(() => engine.snapshot().length === n && engine.snapshot().every((s) => s.status === "LIVE"));
    const wall = performance.now() - t0;
    engine.stop();
    rows.push(`${String(n).padStart(2)} аккаунтов: первый круг за ${wall.toFixed(0)} мс, пик параллельных проверок ${peak}`);
    assert.ok(wall < 30 * 3 + 100, `n=${n}: ${wall.toFixed(0)} мс — не растёт линейно с числом аккаунтов`);
    assert.equal(peak, n, `n=${n}: все проверки шли одновременно`);
  }
  console.log("\n" + rows.join("\n"));
});

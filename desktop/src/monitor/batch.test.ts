import { test } from "node:test";
import assert from "node:assert/strict";
import { createBatchedAdapter, type LiveInfo } from "./batch";
import { MonitorEngine, type Target } from "./engine";

const t = (id: string, ...channels: string[]): Target => ({ accountId: id, channels });
const never = new AbortController().signal;

test("одновременные проверки склеиваются в один запрос, результат считается для каждого аккаунта отдельно", async () => {
  const calls: string[][] = [];
  const adapter = createBatchedAdapter(
    async (logins) => {
      calls.push(logins);
      const out: Record<string, LiveInfo> = {};
      for (const l of logins) out[l] = l.startsWith("on") ? { live: true, game: "G", viewers: 7 } : { live: false };
      return out;
    },
    { windowMs: 10 }
  );
  const [a, b, c] = await Promise.all([
    adapter.check(t("a", "off1", "on1"), never), // выбирает первый в эфире из кандидатов
    adapter.check(t("b", "off2"), never),
    adapter.check(t("c", "ON1"), never), // регистр не важен
  ]);
  assert.equal(calls.length, 1);
  assert.deepEqual([...calls[0]].sort(), ["off1", "off2", "on1"]);
  assert.deepEqual(a, { live: true, channel: "on1", game: "G", viewers: 7 });
  assert.deepEqual(b, { live: false });
  assert.equal(c.live, true);
});

test("ошибка запроса отклоняет все проверки группы", async () => {
  const adapter = createBatchedAdapter(async () => {
    throw new Error("down");
  }, { windowMs: 5 });
  const results = await Promise.allSettled([adapter.check(t("a", "x"), never), adapter.check(t("b", "y"), never)]);
  assert.ok(results.every((r) => r.status === "rejected" && (r.reason as Error).message === "down"));
});

test("больше 25 уникальных каналов разбиваются на несколько запросов", async () => {
  const calls: string[][] = [];
  const adapter = createBatchedAdapter(async (logins) => (calls.push(logins), {}), { windowMs: 5, maxLogins: 25 });
  const chans = (p: string) => Array.from({ length: 12 }, (_, i) => `${p}${i}`);
  await Promise.all(["a", "b", "c"].map((p) => adapter.check(t(p, ...chans(p)), never)));
  assert.ok(calls.length >= 2);
  assert.ok(calls.every((c) => c.length <= 25));
});

test("отмена одного аккаунта не мешает остальным и не отменяет общий запрос", async () => {
  let fetches = 0;
  const adapter = createBatchedAdapter(async () => (fetches++, { x: { live: true }, y: { live: false } }), { windowMs: 20 });
  const ac = new AbortController();
  const aborted = adapter.check(t("a", "x"), ac.signal);
  const ok = adapter.check(t("b", "y"), never);
  ac.abort();
  await assert.rejects(aborted, (e: any) => e.name === "AbortError");
  assert.deepEqual(await ok, { live: false });
  assert.equal(fetches, 1);
});

test("интеграция: 50 аккаунтов через движок = 2 сетевых запроса, все LIVE", async () => {
  let fetches = 0;
  const adapter = createBatchedAdapter(
    async (logins) => (fetches++, Object.fromEntries(logins.map((l) => [l, { live: true, viewers: 1 }]))),
    { windowMs: 20 }
  );
  const engine = new MonitorEngine({ adapter, intervalMs: 10_000, maxConcurrency: 50 });
  engine.setTargets(Array.from({ length: 50 }, (_, i) => t(`acc${i}`, `ch${i}`)));
  const t0 = Date.now();
  while (!engine.snapshot().every((s) => s.status === "LIVE")) {
    if (Date.now() - t0 > 3000) throw new Error("timeout");
    await new Promise((r) => setTimeout(r, 5));
  }
  engine.stop();
  assert.equal(fetches, 2, `50 аккаунтов → ${fetches} запроса`);
});

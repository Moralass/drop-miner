import { test } from "node:test";
import assert from "node:assert/strict";
import { TwitchLive, TwitchUnavailable } from "./twitch.js";

type Handler = (url: URL, init: RequestInit) => Response | Promise<Response>;

function setup(handler: Handler, extra: Partial<ConstructorParameters<typeof TwitchLive>[0]> = {}) {
  const calls: { url: URL; init: RequestInit }[] = [];
  let t = 1_000_000;
  const fetchImpl = (async (input: any, init: RequestInit = {}) => {
    const url = new URL(String(input));
    calls.push({ url, init });
    return handler(url, init);
  }) as typeof fetch;
  const tw = new TwitchLive({ clientId: "id", clientSecret: "secret", fetchImpl, now: () => t, ...extra });
  return { tw, calls, advance: (ms: number) => (t += ms), streams: () => calls.filter((c) => c.url.pathname === "/helix/streams") };
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const token = () => json({ access_token: "tok", expires_in: 3600 });

const ok: Handler = (url) => {
  if (url.pathname === "/oauth2/token") return token();
  const logins = url.searchParams.getAll("user_login");
  return json({
    data: logins
      .filter((l) => l.startsWith("on"))
      .map((l) => ({ user_login: l, type: "live", game_name: "Hollow Reef", viewer_count: 42 })),
  });
};

test("без credentials — not_configured", async () => {
  const tw = new TwitchLive({});
  await assert.rejects(tw.getLive(["a"]), (e: any) => e instanceof TwitchUnavailable && e.reason === "not_configured");
});

test("LIVE/OFFLINE разбираются, регистр логина не важен, токен берётся один раз", async () => {
  const { tw, calls } = setup(ok);
  const r = await tw.getLive(["ON_one", "off_two"]);
  assert.deepEqual(r.channels["on_one"], { live: true, game: "Hollow Reef", viewers: 42 });
  assert.deepEqual(r.channels["off_two"], { live: false });
  assert.equal(r.stale, false);
  await tw.getLive(["on_three"]);
  assert.equal(calls.filter((c) => c.url.pathname === "/oauth2/token").length, 1);
});

test("кэш: повторный запрос в пределах TTL не ходит в Twitch", async () => {
  const { tw, streams, advance } = setup(ok);
  await tw.getLive(["on_a"]);
  await tw.getLive(["on_a"]);
  assert.equal(streams().length, 1);
  advance(46_000);
  await tw.getLive(["on_a"]);
  assert.equal(streams().length, 2);
});

test("одновременные запросы одного канала объединяются", async () => {
  const { tw, streams } = setup(async (u, i) => {
    await new Promise((r) => setTimeout(r, 30));
    return ok(u, i);
  });
  const [a, b] = await Promise.all([tw.getLive(["on_a", "on_b"]), tw.getLive(["on_a", "on_b"])]);
  assert.equal(streams().length, 1);
  assert.deepEqual(a.channels, b.channels);
});

test("150 каналов уходят двумя пачками не больше 100", async () => {
  const { tw, streams } = setup(ok);
  const logins = Array.from({ length: 150 }, (_, i) => `ch${i}`);
  const r = await tw.getLive(logins);
  assert.equal(Object.keys(r.channels).length, 150);
  const sizes = streams().map((c) => c.url.searchParams.getAll("user_login").length).sort((x, y) => y - x);
  assert.deepEqual(sizes, [100, 50]);
});

test("401: токен обновляется и запрос повторяется один раз", async () => {
  let streamCalls = 0;
  const { tw, calls } = setup((url) => {
    if (url.pathname === "/oauth2/token") return token();
    streamCalls++;
    return streamCalls === 1 ? json({}, 401) : ok(url, {});
  });
  const r = await tw.getLive(["on_a"]);
  assert.equal(r.channels["on_a"].live, true);
  assert.equal(calls.filter((c) => c.url.pathname === "/oauth2/token").length, 2);
});

test("429: ошибка с Retry-After, повторных запросов в окне блокировки нет", async () => {
  const { tw, streams } = setup((url) => (url.pathname === "/oauth2/token" ? token() : json({}, 429, { "retry-after": "20" })));
  await assert.rejects(tw.getLive(["on_a"]), (e: any) => e.reason === "rate_limited" && e.retryAfterSec === 20);
  await assert.rejects(tw.getLive(["on_a"]), (e: any) => e.reason === "rate_limited");
  assert.equal(streams().length, 1, "во время паузы запрос в Twitch не уходит");
});

test("сбой Twitch: отдаётся устаревший кэш с stale=true, без кэша — ошибка", async () => {
  let fail = false;
  const { tw, advance } = setup((url, init) => (fail && url.pathname === "/helix/streams" ? json({}, 503) : ok(url, init)));
  await tw.getLive(["on_a"]);
  fail = true;
  advance(60_000);
  const r = await tw.getLive(["on_a"]);
  assert.equal(r.stale, true);
  assert.equal(r.channels["on_a"].live, true);
  await assert.rejects(tw.getLive(["on_never_seen"]), (e: any) => e.reason === "upstream");
  advance(11 * 60_000);
  await assert.rejects(tw.getLive(["on_a"]), (e: any) => e.reason === "upstream", "слишком старый кэш не используется");
});

test("сетевая ошибка превращается в upstream, секреты в ошибку не попадают", async () => {
  const { tw } = setup(() => {
    throw new Error("connect ECONNREFUSED secret");
  });
  await assert.rejects(tw.getLive(["a"]), (e: any) => {
    assert.equal(e.reason, "upstream");
    assert.ok(!String(e.message).includes("secret"));
    return true;
  });
});

test("невалидные логины отбрасываются", async () => {
  const { tw, streams } = setup(ok);
  const r = await tw.getLive(["ok_name", "bad name!", "x".repeat(40)]);
  assert.deepEqual(Object.keys(r.channels), ["ok_name"]);
  assert.equal(streams()[0].url.searchParams.getAll("user_login").length, 1);
});

test("обложки игр: берём box_art_url с CDN Twitch, кэшируем, чужие хосты отбрасываем", async () => {
  let games = 0;
  const { tw, calls } = setup((url) => {
    if (url.pathname === "/oauth2/token") return token();
    games++;
    return json({
      data: [
        { name: "Hollow Reef", box_art_url: "https://static-cdn.jtvnw.net/ttv-boxart/1-{width}x{height}.jpg" },
        { name: "Evil", box_art_url: "https://evil.example/x-{width}x{height}.jpg" },
      ],
    });
  });
  const r = await tw.getGameArt(["Hollow Reef", "evil", "Unknown"]);
  assert.equal(r["Hollow Reef"], "https://static-cdn.jtvnw.net/ttv-boxart/1-144x192.jpg");
  assert.equal(r["evil"], null);
  assert.equal(r["Unknown"], null);
  await tw.getGameArt(["Hollow Reef"]);
  assert.equal(games, 1);
  assert.ok(calls.some((c) => c.url.pathname === "/helix/games"));
});

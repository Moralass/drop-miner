import { test } from "node:test";
import assert from "node:assert/strict";
import {
  addNotification,
  eventToNotification,
  markAllRead,
  markRead,
  unreadCount,
  MAX_NOTIFICATIONS,
  type AppNotification,
} from "./notifications";

const n = (key: string, sev: "info" | "warning" | "error" = "error") => ({ severity: sev, title: "t", key });

test("повтор того же события в окне схлопывается в одно со счётчиком", () => {
  let items: AppNotification[] = [];
  items = addNotification(items, n("k"), 1000);
  items = addNotification(items, n("k"), 2000);
  items = addNotification(items, n("k"), 3000);
  assert.equal(items.length, 1);
  assert.equal(items[0].count, 3);
  assert.equal(items[0].at, 3000);
});

test("вне окна дедупликации создаётся новое уведомление", () => {
  let items: AppNotification[] = [];
  items = addNotification(items, n("k"), 0, 1000);
  items = addNotification(items, n("k"), 5000, 1000);
  assert.equal(items.length, 2);
});

test("unread/read, mark all as read", () => {
  let items: AppNotification[] = [];
  items = addNotification(items, n("a"), 1);
  items = addNotification(items, n("b"), 2);
  assert.equal(unreadCount(items), 2);
  items = markRead(items, items[0].id);
  assert.equal(unreadCount(items), 1);
  items = markAllRead(items);
  assert.equal(unreadCount(items), 0);
});

test("список ограничен, свежие сверху", () => {
  let items: AppNotification[] = [];
  for (let i = 0; i < MAX_NOTIFICATIONS + 20; i++) items = addNotification(items, n(`k${i}`), i);
  assert.equal(items.length, MAX_NOTIFICATIONS);
  assert.equal(items[0].key, `k${MAX_NOTIFICATIONS + 19}`);
});

test("события движка → уведомления; первичное определение статуса шума не создаёт", () => {
  const e = (x: object) => ({ accountId: "a1", at: 1, ...x }) as any;
  assert.equal(eventToNotification(e({ type: "status", from: "CHECKING", to: "LIVE" }), "Основной"), null);
  assert.equal(eventToNotification(e({ type: "status", from: "DISCONNECTED", to: "CHECKING" }), "Основной"), null);
  assert.match(eventToNotification(e({ type: "status", from: "OFFLINE", to: "LIVE" }), "Основной")!.title, /началась/);
  assert.match(eventToNotification(e({ type: "status", from: "LIVE", to: "OFFLINE" }), "Основной")!.title, /закончилась/);
  assert.equal(eventToNotification(e({ type: "error", message: "x" }), "Основной")!.severity, "error");
  assert.equal(eventToNotification(e({ type: "rate_limit" }), "Основной")!.severity, "warning");
  assert.equal(eventToNotification(e({ type: "recovered" }), "Основной")!.severity, "info");
});

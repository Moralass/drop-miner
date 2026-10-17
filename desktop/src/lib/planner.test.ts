import { test } from "node:test";
import assert from "node:assert/strict";
import { planAssignments } from "./planner.js";
import type { Account, Campaign } from "../types.js";

const day = 86_400_000;
const mk = (id: string, startDays: number, endDays: number, need = 60): Campaign => ({
  id, game: "G" + id, name: id, requiredMinutes: need, channels: [], rewards: [],
  startsAt: new Date(Date.now() + startDays * day).toISOString(),
  endsAt: new Date(Date.now() + endDays * day).toISOString(),
});
const acc = (id: string, extra: Partial<Account> = {}): Account => ({ id, label: id, active: true, minutesByCampaign: {}, claimed: [], ...extra });

test("кампании, которые ещё не начались или закончились, не назначаются", () => {
  const r = planAssignments([acc("a")], [mk("soon", 3, 10), mk("old", -10, -1), mk("now", -1, 5)]);
  assert.deepEqual(r.map((x) => x.campaignId), ["now"]);
});

test("закреплённая кампания приоритетнее автоподбора, если выполнима", () => {
  const camps = [mk("urgent", -1, 1), mk("later", -1, 9)];
  assert.equal(planAssignments([acc("a")], camps)[0].campaignId, "urgent");
  assert.equal(planAssignments([acc("a", { pinned: "later" })], camps)[0].campaignId, "later");
});

test("закреплённая, но уже невыполнимая кампания игнорируется", () => {
  const camps = [mk("ok", -1, 5), mk("tight", -1, 0.001, 600)];
  assert.equal(planAssignments([acc("a", { pinned: "tight" })], camps)[0].campaignId, "ok");
});

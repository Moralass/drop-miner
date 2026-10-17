import type { Account, Assignment, Campaign, Plan } from "../types";
import type { AccountState } from "../monitor/engine";
import type { LiveInfo } from "../monitor/batch";
import type { View } from "../components/Shell";

export interface Ctx {
  plan: Plan;
  limit: number;
  accounts: Account[];
  campaigns: Campaign[];
  assignments: Assignment[];
  states: AccountState[];
  stateById: Map<string, AccountState>;
  stats: { accounts: number; activeWorkers: number; queued: number; maxConcurrency: number };
  unread: number;
  /** Кто из стримеров кампаний в эфире (логин → данные) */
  live: Record<string, LiveInfo>;
  liveError: string | null;
  /** Аккаунты с открытым окном стрима */
  open: Set<string>;
  go: (v: View) => void;
  /** Возвращает текст ошибки или null, если всё прошло */
  startCampaign: (c: Campaign) => Promise<string | null>;
  stopAccount: (accountId: string) => Promise<void>;
}

export type CampaignKind = "active" | "soon" | "ended";

export function campaignKind(c: Campaign, now = Date.now()): CampaignKind {
  if (new Date(c.endsAt).getTime() <= now) return "ended";
  if (new Date(c.startsAt).getTime() > now) return "soon";
  return "active";
}

export const fmtMinutes = (m: number) => `${Math.floor(m / 60)} ч ${m % 60} м`;

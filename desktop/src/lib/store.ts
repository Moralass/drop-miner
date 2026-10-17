import { create } from "zustand";
import { persist } from "zustand/middleware";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { Account, Campaign, Plan } from "../types";
import { ACCOUNT_LIMITS } from "../types";
import { api, ApiError } from "./api";
import type { MonitorEvent } from "../monitor/engine";
import {
  addNotification,
  eventToNotification,
  markAllRead,
  markRead,
  type AppNotification,
} from "../monitor/notifications";

interface ServerAccount {
  id: string;
  label: string;
  active: boolean;
}

interface State {
  token: string | null;
  email: string | null;
  plan: Plan;
  /** Окончание платного тарифа; null у платного тарифа = бессрочно */
  expiresAt: string | null;
  limit: number;
  accounts: Account[];
  campaigns: Campaign[];
  notifications: AppNotification[];

  authenticate: (mode: "login" | "register", email: string, password: string) => Promise<void>;
  logout: () => void;
  refreshLicense: () => Promise<void>;
  addAccount: (label: string) => Promise<void>;
  removeAccount: (id: string) => Promise<void>;
  addMinutes: (accountId: string, campaignId: string, minutes: number) => void;
  markClaimed: (accountId: string, campaignId: string) => void;
  /** Ручной выбор канала (для кампаний «любой стример»). null = сбросить */
  setChannel: (accountId: string, channel: string | null) => void;
  /** Закрепить кампанию за аккаунтом (null = вернуть автоподбор) */
  setPinned: (accountId: string, campaignId: string | null) => void;
  handleMonitorEvent: (e: MonitorEvent) => void;
  markNotificationRead: (id: string) => void;
  markAllNotificationsRead: () => void;
  refreshCampaigns: () => Promise<void>;
  redeemKey: (code: string) => Promise<void>;
  startCheckout: (plan: "pro" | "team") => Promise<void>;
  openPortal: () => Promise<void>;
}

const signedOut = {
  token: null,
  email: null,
  plan: "free" as Plan,
  expiresAt: null as string | null,
  limit: ACCOUNT_LIMITS.free,
};

export const useStore = create<State>()(
  persist(
    (set, get) => {
      /** Любой 401 от сервера = токен протух → выходим. */
      const guarded = async <T>(fn: (token: string) => Promise<T>): Promise<T> => {
        const token = get().token;
        if (!token) throw new ApiError(401, "unauthorized");
        try {
          return await fn(token);
        } catch (e) {
          if (e instanceof ApiError && e.status === 401) set({ ...signedOut });
          throw e;
        }
      };

      return {
        ...signedOut,
        accounts: [],
        campaigns: [],
        notifications: [],

        authenticate: async (mode, email, password) => {
          const { token } = await api<{ token: string }>(`/v1/auth/${mode}`, {
            method: "POST",
            body: { email, password },
          });
          set({ token, email: email.toLowerCase() });
          await get().refreshLicense();
        },

        logout: () => set({ ...signedOut, accounts: [], notifications: [] }),

        // Сервер — источник истины: какие аккаунты существуют и какие активны.
        // Локально остаётся только прогресс по кампаниям.
        refreshLicense: async () => {
          const data = await guarded((token) =>
            api<{ plan: Plan; expiresAt: string | null; limit: number; accounts: ServerAccount[] }>("/v1/license/accounts", { token })
          );
          const local = new Map(get().accounts.map((a) => [a.id, a]));
          const accounts: Account[] = data.accounts.map((s) => ({
            minutesByCampaign: {},
            claimed: [],
            ...local.get(s.id),
            id: s.id,
            label: s.label,
            active: s.active,
          }));
          set({ plan: data.plan, expiresAt: data.expiresAt, limit: data.limit, accounts });
        },

        addAccount: async (label) => {
          const id = crypto.randomUUID();
          await guarded((token) =>
            api("/v1/license/accounts", { method: "POST", token, body: { id, label } })
          );
          await get().refreshLicense();
        },

        removeAccount: async (id) => {
          await guarded((token) => api(`/v1/license/accounts/${id}`, { method: "DELETE", token }));
          await get().refreshLicense();
        },

        addMinutes: (accountId, campaignId, minutes) =>
          set({
            accounts: get().accounts.map((a) =>
              a.id === accountId
                ? {
                    ...a,
                    minutesByCampaign: {
                      ...a.minutesByCampaign,
                      [campaignId]: (a.minutesByCampaign[campaignId] ?? 0) + minutes,
                    },
                  }
                : a
            ),
          }),

        markClaimed: (accountId, campaignId) =>
          set({
            accounts: get().accounts.map((a) =>
              a.id === accountId && !a.claimed.includes(campaignId)
                ? { ...a, claimed: [...a.claimed, campaignId] }
                : a
            ),
          }),

        setChannel: (accountId, channel) => {
          const clean = channel?.trim().toLowerCase() || undefined;
          if (clean && !/^[a-z0-9_]{1,25}$/.test(clean)) return;
          set({ accounts: get().accounts.map((a) => (a.id === accountId ? { ...a, channel: clean } : a)) });
        },

        setPinned: (accountId, campaignId) =>
          set({ accounts: get().accounts.map((a) => (a.id === accountId ? { ...a, pinned: campaignId ?? undefined } : a)) }),

        // События движка превращаются в уведомления (с дедупликацией повторов).
        handleMonitorEvent: (e) => {
          const acc = get().accounts.find((a) => a.id === e.accountId);
          const n = eventToNotification(e, acc?.label ?? "Аккаунт");
          if (n) set({ notifications: addNotification(get().notifications, n, e.at) });
        },

        markNotificationRead: (id) => set({ notifications: markRead(get().notifications, id) }),
        markAllNotificationsRead: () => set({ notifications: markAllRead(get().notifications) }),

        refreshCampaigns: async () => {
          set({ campaigns: await api<Campaign[]>("/v1/campaigns") });
        },

        // Активация подписки ключом: сервер проверяет ключ, срок и конфликты тарифов.
        redeemKey: async (code) => {
          await guarded((token) => api("/v1/license/redeem", { method: "POST", token, body: { code } }));
          await get().refreshLicense();
        },

        // Оплата проходит на странице Stripe во внешнем браузере: карточные данные приложение не видит.
        startCheckout: async (plan) => {
          const { url } = await guarded((token) =>
            api<{ url: string }>("/v1/billing/checkout", { method: "POST", token, body: { plan } })
          );
          await openUrl(url);
        },

        openPortal: async () => {
          const { url } = await guarded((token) =>
            api<{ url: string }>("/v1/billing/portal", { method: "POST", token })
          );
          await openUrl(url);
        },
      };
    },
    {
      name: "dropminer-store",
      // Токен и кэш аккаунтов храним локально; кампании подтягиваем заново при каждом запуске.
      partialize: (s) => ({
        token: s.token,
        email: s.email,
        plan: s.plan,
        expiresAt: s.expiresAt,
        limit: s.limit,
        accounts: s.accounts,
        notifications: s.notifications,
      }),
    }
  )
);

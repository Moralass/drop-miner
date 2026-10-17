import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useStore } from "./lib/store";
import { planAssignments } from "./lib/planner";
import { useOpenWindows } from "./lib/windows";
import { engine, useMonitor } from "./monitor/runtime";
import { useCampaignLive } from "./monitor/campaignLive";
import { unreadCount } from "./monitor/notifications";
import AuthScreen from "./components/AuthScreen";
import Plans from "./components/Plans";
import Notifications from "./components/Notifications";
import Shell, { type View } from "./components/Shell";
import Home from "./views/Home";
import Accounts from "./views/Accounts";
import Drops from "./views/Drops";
import Monitor from "./views/Monitor";
import type { Ctx } from "./views/ctx";
import { errorText } from "./lib/api";

export default function App() {
  const { token, email, plan, limit, accounts, campaigns, notifications, logout, setChannel, setPinned, addMinutes, refreshCampaigns, refreshLicense } =
    useStore();
  const [view, setView] = useState<View>("home");

  useEffect(() => {
    if (!token) return;
    refreshCampaigns().catch(() => {});
    refreshLicense().catch(() => {});
    const t = setInterval(() => refreshCampaigns().catch(() => {}), 10 * 60 * 1000);
    // После активации ключа в другом окне статус подтянется, как только вы вернётесь.
    const onFocus = () => refreshLicense().catch(() => {});
    window.addEventListener("focus", onFocus);
    return () => {
      clearInterval(t);
      window.removeEventListener("focus", onFocus);
    };
  }, [token, refreshCampaigns, refreshLicense]);

  const activeAccounts = useMemo(() => accounts.filter((a) => a.active), [accounts]);
  const assignments = useMemo(() => planAssignments(activeAccounts, campaigns), [activeAccounts, campaigns]);
  const { states, stats } = useMonitor();
  const stateById = useMemo(() => new Map(states.map((s) => [s.accountId, s])), [states]);
  const unread = unreadCount(notifications);
  const { live, error: liveError } = useCampaignLive(campaigns, !!token);
  const open = useOpenWindows(useMemo(() => activeAccounts.map((a) => a.id), [activeAccounts]), !!token);

  // Цели мониторинга: канал, выбранный вручную, приоритетнее каналов кампании; не больше 25 за раз.
  useEffect(() => {
    if (!token) {
      engine.setTargets([]);
      return;
    }
    engine.setTargets(
      activeAccounts.map((a) => {
        const asg = assignments.find((x) => x.accountId === a.id);
        const channels = a.channel ? [a.channel] : (asg?.channels ?? []);
        return { accountId: a.id, channels: channels.slice(0, 25) };
      })
    );
  }, [token, activeAccounts, assignments]);

  // Локальный счётчик: +1 минута, только если аккаунт активен, назначена кампания,
  // канал в эфире и окно стрима реально открыто.
  const latest = useRef({ assignments, stateById, open });
  latest.current = { assignments, stateById, open };
  useEffect(() => {
    if (!token) return;
    const t = setInterval(() => {
      const { assignments: asg, stateById: st, open: opened } = latest.current;
      for (const a of useStore.getState().accounts) {
        const as = asg.find((x) => x.accountId === a.id);
        if (a.active && as && st.get(a.id)?.status === "LIVE" && opened.has(a.id)) addMinutes(a.id, as.campaignId, 1);
      }
    }, 60_000);
    return () => clearInterval(t);
  }, [token, addMinutes]);

  const startCampaign = useCallback<Ctx["startCampaign"]>(
    async (c) => {
      const free = activeAccounts.filter((a) => !open.has(a.id));
      if (!free.length) return "Нет свободного аккаунта: остановите один из просмотров или добавьте аккаунт.";
      const channel = c.channels.find((l) => live[l]?.live);
      if (!channel) return "Сейчас никто из стримеров этой кампании не в эфире.";
      const acc = free.find((a) => assignments.find((x) => x.accountId === a.id)?.campaignId === c.id) ?? free[0];
      try {
        setPinned(acc.id, c.id);
        setChannel(acc.id, null);
        await invoke("open_stream_window", { accountId: acc.id, channel });
        return null;
      } catch (e) {
        return errorText(e);
      }
    },
    [activeAccounts, open, live, assignments, setPinned, setChannel]
  );

  const stopAccount = useCallback(
    async (id: string) => {
      await invoke("close_stream_window", { accountId: id }).catch(() => undefined);
      setPinned(id, null);
    },
    [setPinned]
  );

  if (!token) return <AuthScreen />;

  const ctx: Ctx = {
    plan, limit, accounts, campaigns, assignments, states, stateById, stats, unread,
    live, liveError, open, go: setView, startCampaign, stopAccount,
  };

  return (
    <Shell view={view} onView={setView} plan={plan} email={email} unread={unread} onLogout={logout}>
      {view === "home" && <Home ctx={ctx} />}
      {view === "accounts" && <Accounts ctx={ctx} />}
      {view === "drops" && <Drops ctx={ctx} />}
      {view === "monitor" && <Monitor ctx={ctx} />}
      {view === "notifications" && <Notifications />}
      {view === "plans" && <Plans />}
    </Shell>
  );
}

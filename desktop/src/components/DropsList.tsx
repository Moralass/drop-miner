import { useState } from "react";
import GameArt from "./GameArt";
import { campaignKind, type Ctx } from "../views/ctx";

type Filter = "all" | "live" | "soon" | "ended";
const TABS: [Filter, string][] = [["all", "Все"], ["live", "LIVE"], ["soon", "Скоро"], ["ended", "Завершённые"]];

export default function DropsList({ ctx }: { ctx: Ctx }) {
  const [filter, setFilter] = useState<Filter>("all");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const liveChannel = (channels: string[]) => channels.find((l) => ctx.live[l]?.live);
  const rows = ctx.campaigns.filter((c) => {
    const k = campaignKind(c);
    return filter === "all" ? true : filter === "live" ? k === "active" && !!liveChannel(c.channels) : filter === k;
  });

  const start = async (id: string, run: () => Promise<string | null>) => {
    setError(null);
    setBusy(id);
    setError(await run());
    setBusy(null);
  };

  return (
    <section className="panel">
      <div className="ph"><h2>Доступные Drops</h2></div>
      <div className="tabs" role="group" aria-label="Фильтр кампаний">
        {TABS.map(([id, label]) => (
          <button key={id} aria-pressed={filter === id} onClick={() => setFilter(id)}>{label}</button>
        ))}
      </div>
      {error && <p className="error" role="alert">{error}</p>}
      {ctx.liveError && <p className="muted small">Статус эфиров недоступен: {ctx.liveError}</p>}
      <div className="drops">
        {rows.length === 0 && <p className="muted">В этой категории пока ничего нет. Каталог кампаний ведёт команда Drop Miner.</p>}
        {rows.map((c) => {
          const k = campaignKind(c);
          const ch = liveChannel(c.channels);
          const running = ctx.accounts.some((a) => ctx.open.has(a.id) && ctx.assignments.find((x) => x.accountId === a.id)?.campaignId === c.id);
          const days = Math.ceil((new Date(c.startsAt).getTime() - Date.now()) / 86_400_000);
          const chip =
            k === "ended" ? <span className="chip">Завершена</span>
            : k === "soon" ? <span className="chip">Скоро · через {days} дн.</span>
            : ch ? <span className="chip live-red">● LIVE · {ctx.live[ch].viewers ?? 0} зрителей</span>
            : c.channels.length ? <span className="chip">Нет эфира</span>
            : <span className="chip DISCONNECTED">Нужен канал</span>;
          let action;
          if (running) action = <button onClick={() => { const a = ctx.accounts.find((x) => ctx.open.has(x.id) && ctx.assignments.find((y) => y.accountId === x.id)?.campaignId === c.id); if (a) void ctx.stopAccount(a.id); }}>Остановить</button>;
          else if (k === "active" && ch) action = <button className="go" disabled={busy === c.id} onClick={() => start(c.id, () => ctx.startCampaign(c))}>Начать</button>;
          else if (k === "active" && c.channels.length === 0) action = <button onClick={() => ctx.go("accounts")}>Выбрать канал</button>;
          else action = <button disabled>Начать</button>;
          return (
            <div className="drop" key={c.id}>
              <GameArt game={c.game} size={40} />
              <div className="grow">
                <strong>{c.game}</strong>
                <div className="muted small">{c.name}</div>
                <div className="chips">{chip}</div>
              </div>
              <div className="rw"><span>Награда</span><b>{c.rewards[0] ?? "—"}</b></div>
              {action}
            </div>
          );
        })}
      </div>
    </section>
  );
}

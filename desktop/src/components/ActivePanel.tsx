import GameArt from "./GameArt";
import { fmtMinutes, type Ctx } from "../views/ctx";

export default function ActivePanel({ ctx }: { ctx: Ctx }) {
  const items = ctx.accounts.filter((a) => ctx.open.has(a.id));
  return (
    <section className={`panel ${items.length ? "hl" : ""}`}>
      <h2>Активный мониторинг</h2>
      {items.length === 0 && (
        <p className="muted">Просмотр не запущен. Выберите кампанию в списке Drops и нажмите «Начать».</p>
      )}
      {items.map((a) => {
        const asg = ctx.assignments.find((x) => x.accountId === a.id);
        const c = ctx.campaigns.find((x) => x.id === asg?.campaignId);
        const st = ctx.stateById.get(a.id);
        const channel = st?.channel ?? a.channel ?? asg?.channels[0];
        const done = c ? a.minutesByCampaign[c.id] ?? 0 : 0;
        const pct = c ? Math.min(100, Math.round((done / c.requiredMinutes) * 100)) : 0;
        return (
          <div className="active-item" key={a.id}>
            <div className="row nowrap">
              {c && <GameArt game={c.game} size={40} />}
              <div className="grow">
                <strong>{c ? c.game : "Кампания не выбрана"}</strong>
                <div className="muted small">{a.label} · {channel ? `канал ${channel}` : "канал не выбран"}</div>
              </div>
            </div>
            {c && (
              <>
                <div className="track" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
                  <div className="fill" style={{ width: `${pct}%` }} />
                </div>
                <div className="muted small">{pct}% · {fmtMinutes(done)} / {fmtMinutes(c.requiredMinutes)}</div>
                {st?.status !== "LIVE" && <p className="muted small">Минуты не идут: канал сейчас не в эфире.</p>}
              </>
            )}
            <button className="primary" onClick={() => void ctx.stopAccount(a.id)}>Остановить</button>
          </div>
        );
      })}
      <p className="muted small">Локальный счётчик. Twitch этот прогресс не подтверждает.</p>
    </section>
  );
}

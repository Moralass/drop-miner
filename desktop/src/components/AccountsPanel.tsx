import type { Ctx } from "../views/ctx";
import type { MonitorStatus } from "../monitor/engine";

export const STATUS_TEXT: Record<MonitorStatus, string> = {
  LIVE: "В эфире",
  OFFLINE: "Не в эфире",
  CHECKING: "Проверка…",
  ERROR: "Ошибка",
  DISCONNECTED: "Канал не выбран",
};

export default function AccountsPanel({ ctx }: { ctx: Ctx }) {
  return (
    <section className="panel">
      <div className="ph">
        <h2>Аккаунты</h2>
        <span className="spacer" />
        <span className="muted small">{ctx.accounts.length} / {ctx.limit}</span>
      </div>
      {ctx.accounts.length === 0 && <p className="muted">Добавьте аккаунт на вкладке «Аккаунты».</p>}
      {ctx.accounts.map((a) => {
        const st = ctx.stateById.get(a.id)?.status ?? "DISCONNECTED";
        return (
          <div className="acc" key={a.id}>
            <span className="av">{a.label.charAt(0).toUpperCase()}</span>
            <div className="meta">
              <strong>{a.label}</strong>
              <span className="muted small">Twitch{a.active ? "" : " · сверх лимита"}</span>
            </div>
            {a.active ? <span className={`chip ${st}`}>{STATUS_TEXT[st]}</span> : <span className="chip">Заблокирован</span>}
          </div>
        );
      })}
      <button onClick={() => ctx.go("accounts")}>Управление аккаунтами</button>
    </section>
  );
}

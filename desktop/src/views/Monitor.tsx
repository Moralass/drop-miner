import Summary from "../components/Summary";
import { STATUS_TEXT } from "../components/AccountsPanel";
import type { Ctx } from "./ctx";

const time = (t: number | null) => (t ? new Date(t).toLocaleTimeString("ru-RU") : "—");

export default function Monitor({ ctx }: { ctx: Ctx }) {
  return (
    <>
      <div className="ph"><h1>Мониторинг</h1></div>
      <Summary accounts={ctx.accounts} states={ctx.states} stats={ctx.stats} unread={ctx.unread} onOpenNotifications={() => ctx.go("notifications")} />
      <section className="panel">
        <h2>Состояние по аккаунтам</h2>
        <p className="muted small">Каждый аккаунт проверяется своей независимой задачей: сбой одного не влияет на остальных.</p>
        <div className="tw">
          <table>
            <thead>
              <tr><th>Аккаунт</th><th>Статус</th><th>Канал</th><th>Проверено</th><th>Следующая</th><th>Ошибка</th></tr>
            </thead>
            <tbody>
              {ctx.accounts.map((a) => {
                const st = ctx.stateById.get(a.id);
                return (
                  <tr key={a.id}>
                    <td>{a.label}</td>
                    <td>{a.active ? <span className={`chip ${st?.status ?? "DISCONNECTED"}`}>{STATUS_TEXT[st?.status ?? "DISCONNECTED"]}</span> : <span className="chip">Заблокирован</span>}</td>
                    <td>{st?.channel ?? "—"}</td>
                    <td>{time(st?.lastCheckAt ?? null)}</td>
                    <td>{time(st?.nextCheckAt ?? null)}</td>
                    <td>{st?.lastError ?? ""}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}

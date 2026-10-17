import { useStore } from "../lib/store";
import { unreadCount } from "../monitor/notifications";

const SEVERITY: Record<string, string> = { info: "Инфо", warning: "Внимание", error: "Ошибка" };

export default function Notifications() {
  const { notifications, markNotificationRead, markAllNotificationsRead } = useStore();
  const unread = unreadCount(notifications);

  return (
    <>
      <div className="ph">
        <h1>Уведомления</h1>
        <span className="spacer" />
        <button disabled={!unread} onClick={markAllNotificationsRead}>Прочитать все</button>
      </div>

      {notifications.length === 0 ? (
        <p className="muted">
          Пока нет уведомлений. Здесь появятся начало и конец трансляций, ошибки проверки, лимиты запросов и восстановление.
        </p>
      ) : (
        <ul className="nts">
          {notifications.map((n) => (
            <li key={n.id}>
              <button className={`nt ${n.read ? "read" : ""}`} onClick={() => markNotificationRead(n.id)}>
                <span className="nt-top">
                  <span className={`pill sev-${n.severity}`}>{SEVERITY[n.severity]}</span>
                  {!n.read && <span className="dot" aria-label="не прочитано" />}
                  <span className="muted small">{new Date(n.at).toLocaleString("ru-RU")}</span>
                  {n.count > 1 && <span className="muted small">× {n.count}</span>}
                </span>
                <span className="nt-title">{n.title}</span>
                {n.message && <span className="muted small">{n.message}</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

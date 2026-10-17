import type { ReactNode } from "react";
import Brand from "./Brand";

export type View = "home" | "accounts" | "drops" | "monitor" | "notifications" | "plans";

const NAV: { id: View; label: string; icon: string }[] = [
  { id: "home", label: "Главная", icon: "M3 11l9-8 9 8v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z" },
  { id: "accounts", label: "Аккаунты", icon: "M16 8a4 4 0 1 0-8 0 4 4 0 0 0 8 0zM4 21c0-4 4-6 8-6s8 2 8 6" },
  { id: "drops", label: "Drops", icon: "M4 10h16v10H4zM2 7h20v3H2zM12 7v13M12 7c-2-4-6-3-5 0M12 7c2-4 6-3 5 0" },
  { id: "monitor", label: "Мониторинг", icon: "M3 4h18v12H3zM8 20h8M12 16v4" },
  { id: "notifications", label: "Уведомления", icon: "M6 16V11a6 6 0 0 1 12 0v5l2 2H4zM10 21h4" },
  { id: "plans", label: "Подписка", icon: "M3 6h18v12H3zM3 10h18" },
];

interface Props {
  view: View;
  onView: (v: View) => void;
  plan: string;
  email: string | null;
  unread: number;
  onLogout: () => void;
  children: ReactNode;
}

export default function Shell({ view, onView, plan, email, unread, onLogout, children }: Props) {
  return (
    <div className="shell">
      <header className="tb">
        <h1 className="brand-h">
          <img src="/logo.png" alt="" width={26} height={30} />
          <span>
            DROP <em>MINER</em>
          </span>
        </h1>
        <span className="spacer" />
        <span className="muted small">{email}</span>
        <span className="pro">♛ {plan.toUpperCase()}</span>
        <button className="bell" onClick={() => onView("notifications")} aria-label="Уведомления">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 16V11a6 6 0 0 1 12 0v5l2 2H4zM10 21h4" /></svg>
          {unread > 0 && <span className="cnt">{unread}</span>}
        </button>
      </header>
      <div className="body">
        <nav className="side" aria-label="Разделы">
          {NAV.map((n) => (
            <button key={n.id} aria-current={view === n.id ? "page" : undefined} onClick={() => onView(n.id)}>
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d={n.icon} /></svg>
              {n.label}
              {n.id === "notifications" && unread > 0 && <span className="cnt push">{unread}</span>}
            </button>
          ))}
          <span className="sp" />
          <Brand />
          <button className="ghost" onClick={onLogout}>Выйти</button>
        </nav>
        <main className="main">{children}</main>
      </div>
    </div>
  );
}

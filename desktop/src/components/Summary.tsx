import { useEffect, useState } from "react";
import { api } from "../lib/api";
import type { Account } from "../types";
import type { AccountState } from "../monitor/engine";

type Health = "loading" | "down" | { version: string; twitchConfigured: boolean };

interface Props {
  accounts: Account[];
  states: AccountState[];
  stats: { activeWorkers: number; queued: number; maxConcurrency: number };
  unread: number;
  onOpenNotifications: () => void;
}

export default function Summary({ accounts, states, stats, unread, onOpenNotifications }: Props) {
  const [health, setHealth] = useState<Health>("loading");

  useEffect(() => {
    let alive = true;
    const load = () =>
      api<{ version: string; twitch: { configured: boolean } }>("/health")
        .then((h) => alive && setHealth({ version: h.version, twitchConfigured: h.twitch.configured }))
        .catch(() => alive && setHealth("down"));
    load();
    const t = setInterval(load, 30_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  const count = (s: AccountState["status"]) => states.filter((x) => x.status === s).length;
  const active = accounts.filter((a) => a.active).length;
  const errors = count("ERROR");

  const tiles: { label: string; value: string; sub?: string; tone?: "ok" | "bad" | "muted"; onClick?: () => void }[] = [
    { label: "Аккаунты", value: String(accounts.length), sub: `активных: ${active}` },
    { label: "В эфире", value: String(count("LIVE")), tone: count("LIVE") ? "ok" : "muted" },
    { label: "Не в эфире", value: String(count("OFFLINE")), tone: "muted" },
    { label: "Ошибки", value: String(errors), tone: errors ? "bad" : "muted" },
    { label: "Уведомления", value: String(unread), sub: unread ? "непрочитанных" : "нет новых", onClick: onOpenNotifications },
    { label: "Очередь", value: `${stats.activeWorkers}/${stats.maxConcurrency}`, sub: `ожидают: ${stats.queued}` },
    health === "loading"
      ? { label: "Сервер", value: "…", tone: "muted" }
      : health === "down"
        ? { label: "Сервер", value: "Недоступен", tone: "bad" }
        : {
            label: "Сервер",
            value: `OK · v${health.version}`,
            tone: "ok",
            sub: health.twitchConfigured ? "Twitch API подключён" : "Twitch API не настроен (N/A)",
          },
  ];

  return (
    <section className="tiles" aria-label="Сводка">
      {tiles.map((t) => {
        const inner = (
          <>
            <span className="tile-l">{t.label}</span>
            <span className={`tile-v ${t.tone ?? ""}`}>{t.value}</span>
            {t.sub && <span className="tile-s">{t.sub}</span>}
          </>
        );
        return t.onClick ? (
          <button key={t.label} className="tile" onClick={t.onClick}>
            {inner}
          </button>
        ) : (
          <div key={t.label} className="tile">
            {inner}
          </div>
        );
      })}
    </section>
  );
}

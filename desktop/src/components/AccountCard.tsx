import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { Account, Assignment, Campaign } from "../types";
import type { AccountState, MonitorStatus } from "../monitor/engine";
import { remainingMinutes } from "../lib/planner";
import GameArt from "./GameArt";

interface Props {
  account: Account;
  assignment?: Assignment;
  campaign?: Campaign;
  state?: AccountState;
  onRemove: () => void;
  onUpgrade: () => void;
  onSetChannel: (channel: string | null) => void;
  onCheck: () => void;
}

const STATUS_TEXT: Record<MonitorStatus, string> = {
  LIVE: "В эфире",
  OFFLINE: "Не в эфире",
  CHECKING: "Проверка…",
  ERROR: "Ошибка",
  DISCONNECTED: "Канал не выбран",
};

export default function AccountCard({ account, assignment, campaign, state, onRemove, onUpgrade, onSetChannel, onCheck }: Props) {
  const [draft, setDraft] = useState("");
  const locked = !account.active;

  const done = campaign ? account.minutesByCampaign[campaign.id] ?? 0 : 0;
  const pct = campaign ? Math.min(100, Math.round((done / campaign.requiredMinutes) * 100)) : 0;

  // Если какой-то из каналов кампании в эфире — открываем именно его, иначе первый кандидат.
  const candidate = account.channel ?? assignment?.channels[0];
  const channelToOpen = state?.status === "LIVE" && state.channel ? state.channel : candidate;

  const openLogin = () => invoke("open_login_window", { accountId: account.id }).catch((e) => alert(String(e)));
  const openStream = () => {
    if (!channelToOpen) return;
    invoke("open_stream_window", { accountId: account.id, channel: channelToOpen }).catch((e) => alert(String(e)));
  };

  const needsManualChannel = !!assignment && (assignment.channels.length === 0 || !!account.channel);

  return (
    <article className={`panel ${locked ? "locked" : ""}`}>
      <header className="ph">
        <h3>{account.label}</h3>
        <span className="spacer" />
        <button className="ghost" onClick={onRemove} aria-label="Удалить аккаунт">
          ✕
        </button>
      </header>

      {locked ? (
        <>
          <p className="muted">Аккаунт заблокирован: он сверх лимита вашего тарифа. Данные сохранены.</p>
          <button className="primary" onClick={onUpgrade}>Открыть тарифы</button>
        </>
      ) : (
        <>
          <div className="status-row">
            <span className={`chip st-${state?.status ?? "DISCONNECTED"}`}>{STATUS_TEXT[state?.status ?? "DISCONNECTED"]}</span>
            {state?.status === "LIVE" && (
              <span className="muted small">
                {state.channel}
                {state.game ? ` · ${state.game}` : ""}
                {state.viewers != null ? ` · ${state.viewers} зрителей` : ""}
              </span>
            )}
          </div>
          {state?.lastError && <p className="error small">{state.lastError}{state.consecutiveErrors > 1 ? ` (повторов: ${state.consecutiveErrors})` : ""}</p>}
          {state?.lastCheckAt && (
            <p className="muted small">
              Проверено в {new Date(state.lastCheckAt).toLocaleTimeString("ru-RU")}
              {state.nextCheckAt ? `, следующая в ${new Date(state.nextCheckAt).toLocaleTimeString("ru-RU")}` : ""}
            </p>
          )}

          {campaign ? (
            <>
              <div className="row">
                <GameArt game={campaign.game} size={36} />
                <p className="muted">
                  {campaign.game} — {campaign.name}
                </p>
              </div>
              <div className="track" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
                <div className="fill" style={{ width: `${pct}%` }} />
              </div>
              <p className="muted small">
                {done} / {campaign.requiredMinutes} мин · осталось {remainingMinutes(account, campaign)} мин
              </p>
              <p className="muted small">
                Локальный счётчик: идёт, пока открыто окно стрима и канал в эфире. Twitch этот прогресс не подтверждает.
              </p>
            </>
          ) : (
            <p className="muted">Нет подходящих кампаний</p>
          )}

          {needsManualChannel && (
            <div className="row">
              {account.channel ? (
                <>
                  <span className="muted small">Свой канал: {account.channel}</span>
                  <button className="ghost" onClick={() => onSetChannel(null)}>Сбросить</button>
                </>
              ) : (
                <>
                  <input
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    placeholder="Канал на Twitch (логин)"
                    maxLength={25}
                    aria-label="Канал на Twitch"
                  />
                  <button
                    disabled={!draft.trim()}
                    onClick={() => {
                      onSetChannel(draft);
                      setDraft("");
                    }}
                  >
                    Задать
                  </button>
                </>
              )}
            </div>
          )}

          <div className="row">
            <button onClick={openLogin}>Войти в Twitch</button>
            <button className="primary" onClick={openStream} disabled={!channelToOpen}>
              Открыть стрим
            </button>
            <button onClick={onCheck} disabled={!candidate}>Проверить сейчас</button>
          </div>
        </>
      )}
    </article>
  );
}

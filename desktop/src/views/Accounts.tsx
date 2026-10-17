import { useState } from "react";
import AccountCard from "../components/AccountCard";
import { useStore } from "../lib/store";
import { errorText } from "../lib/api";
import { engine } from "../monitor/runtime";
import type { Ctx } from "./ctx";

export default function Accounts({ ctx }: { ctx: Ctx }) {
  const { addAccount, removeAccount, setChannel } = useStore();
  const [label, setLabel] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const atLimit = ctx.accounts.length >= ctx.limit;

  const onAdd = async () => {
    const name = label.trim();
    if (!name) return;
    setError(null);
    setBusy(true);
    try {
      await addAccount(name);
      setLabel("");
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const onRemove = async (id: string) => {
    try {
      await removeAccount(id);
    } catch (e) {
      setError(errorText(e));
    }
  };

  return (
    <>
      <div className="ph"><h1>Аккаунты</h1></div>
      <div className="row nowrap">
        <input
          value={label}
          maxLength={60}
          disabled={atLimit}
          onChange={(e) => setLabel(e.target.value)}
          placeholder={atLimit ? "Лимит аккаунтов исчерпан" : "Название аккаунта (для вас)"}
          onKeyDown={(e) => e.key === "Enter" && onAdd()}
        />
        {atLimit ? (
          <button className="primary" onClick={() => ctx.go("plans")}>
            {ctx.plan === "free" ? "Подписка: больше аккаунтов" : "Повысить тариф"}
          </button>
        ) : (
          <button className="primary" disabled={busy} onClick={onAdd}>Добавить аккаунт</button>
        )}
      </div>
      {error && <p className="error" role="alert">{error}</p>}
      <section className="grid">
        {ctx.accounts.map((acc) => {
          const assignment = ctx.assignments.find((a) => a.accountId === acc.id);
          const campaign = ctx.campaigns.find((c) => c.id === assignment?.campaignId);
          return (
            <AccountCard
              key={acc.id}
              account={acc}
              assignment={assignment}
              campaign={campaign}
              state={ctx.stateById.get(acc.id)}
              onSetChannel={(c) => setChannel(acc.id, c)}
              onCheck={() => void engine.checkNow(acc.id)}
              onRemove={() => void onRemove(acc.id)}
              onUpgrade={() => ctx.go("plans")}
            />
          );
        })}
        {ctx.accounts.length === 0 && <p className="muted">Добавьте аккаунт и войдите в Twitch в отдельном окне-профиле.</p>}
      </section>
    </>
  );
}

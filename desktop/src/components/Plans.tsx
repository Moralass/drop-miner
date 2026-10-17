import { useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useStore } from "../lib/store";
import { errorText } from "../lib/api";
import type { Plan } from "../types";

// Покупка по умолчанию — ключом. Stripe оставлен в коде и включается флагом при сборке.
const STRIPE_ENABLED = import.meta.env.VITE_STRIPE_ENABLED === "true";
const BUY_URL: string | undefined = import.meta.env.VITE_BUY_URL || undefined;

const TIERS: { id: Plan; name: string; price: string; features: string[] }[] = [
  { id: "free", name: "Free", price: "$0", features: ["1 аккаунт Twitch", "Каталог кампаний", "1 устройство"] },
  { id: "pro", name: "Pro", price: "$4.99/мес", features: ["До 5 аккаунтов", "ИИ-помощник (50/день)", "2 устройства"] },
  { id: "team", name: "Team", price: "$14.99/мес", features: ["До 20 аккаунтов", "ИИ-помощник (200/день)", "5 устройств"] },
];

function expiryText(plan: Plan, expiresAt: string | null): string {
  if (plan === "free") return "Без подписки";
  if (!expiresAt) return "Бессрочно";
  const d = new Date(expiresAt);
  const days = Math.max(0, Math.ceil((d.getTime() - Date.now()) / 86_400_000));
  return `до ${d.toLocaleDateString("ru-RU")} (осталось ${days} дн.)`;
}

export default function Plans() {
  const { plan, expiresAt, redeemKey, startCheckout, openPortal, refreshLicense } = useStore();
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const run = async (fn: () => Promise<void>, success?: string) => {
    setError(null);
    setOk(null);
    setBusy(true);
    try {
      await fn();
      if (success) setOk(success);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const activate = (e: React.FormEvent) => {
    e.preventDefault();
    if (!code.trim()) return;
    run(async () => {
      await redeemKey(code.trim());
      setCode("");
    }, "Ключ активирован. Тариф обновлён.");
  };

  return (
    <>
      <div className="ph"><h1>Подписка</h1></div>

      <section className="panel hl">
        <h3>Ваш тариф: {plan.toUpperCase()}</h3>
        <p className="muted">{expiryText(plan, expiresAt)}</p>
      </section>

      <form className="panel key-form" onSubmit={activate}>
        <h3>Активация по ключу</h3>
        <p className="muted small">
          Введите ключ вида DM-XXXX-XXXX-XXXX-XXXX. Если у вас уже есть тариф такого же уровня, срок продлится.
        </p>
        <div className="row">
          <input
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase())}
            placeholder="DM-XXXX-XXXX-XXXX-XXXX"
            maxLength={40}
            spellCheck={false}
            autoComplete="off"
            aria-label="Ключ активации"
          />
          <button className="primary" disabled={busy || !code.trim()}>Активировать</button>
        </div>
        {BUY_URL && (
          <button type="button" className="ghost" onClick={() => openUrl(BUY_URL)}>
            Где купить ключ →
          </button>
        )}
        {error && <p className="error" role="alert">{error}</p>}
        {ok && <p className="success" role="status">{ok}</p>}
      </form>

      <h2>Тарифы</h2>
      <section className="grid">
        {TIERS.map((t) => (
          <article key={t.id} className={`panel ${t.id === plan ? "hl" : ""}`}>
            <h3>{t.name}</h3>
            <div className="price">{t.price}</div>
            <ul className="feat">
              {t.features.map((f) => (
                <li key={f}>{f}</li>
              ))}
            </ul>
            {t.id === plan && <span className="pro self-start">Ваш тариф</span>}
            {STRIPE_ENABLED && t.id !== "free" && t.id !== plan && (
              <button className="primary" disabled={busy} onClick={() => run(() => startCheckout(t.id as "pro" | "team"))}>
                Оплатить картой
              </button>
            )}
          </article>
        ))}
      </section>

      <div className="row" style={{ marginTop: 20 }}>
        <button disabled={busy} onClick={() => run(refreshLicense)}>Обновить статус</button>
        {STRIPE_ENABLED && plan !== "free" && (
          <button disabled={busy} onClick={() => run(openPortal)}>Управлять подпиской Stripe</button>
        )}
      </div>
    </>
  );
}

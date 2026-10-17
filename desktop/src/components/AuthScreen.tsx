import { useState } from "react";
import { useStore } from "../lib/store";
import { errorText } from "../lib/api";

export default function AuthScreen() {
  const authenticate = useStore((s) => s.authenticate);
  const [mode, setMode] = useState<"login" | "register">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await authenticate(mode, email.trim(), password);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth">
      <form className="panel auth-card" onSubmit={submit}>
        <h1 className="brand-h">
          <img src="/logo.png" alt="" width={26} height={30} />
          <span>
            DROP <em>MINER</em>
          </span>
        </h1>
        <p className="muted">
          {mode === "login" ? "Войдите в аккаунт Drop Miner" : "Создайте аккаунт Drop Miner — это бесплатно"}
        </p>

        <label>
          Email
          <input type="email" required autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        </label>
        <label>
          Пароль
          <input
            type="password"
            required
            minLength={10}
            autoComplete={mode === "login" ? "current-password" : "new-password"}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>

        {error && <p className="error" role="alert">{error}</p>}

        <button className="primary" disabled={busy}>
          {busy ? "Подождите…" : mode === "login" ? "Войти" : "Зарегистрироваться"}
        </button>
        <button
          type="button"
          className="ghost"
          onClick={() => {
            setMode(mode === "login" ? "register" : "login");
            setError(null);
          }}
        >
          {mode === "login" ? "Нет аккаунта? Регистрация" : "Уже есть аккаунт? Войти"}
        </button>

        <p className="muted small">
          Это аккаунт Drop Miner, не Twitch. Пароли от Twitch мы не получаем: вход в Twitch происходит в отдельном окне.
        </p>
      </form>
    </div>
  );
}

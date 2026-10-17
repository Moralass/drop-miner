export const API: string = import.meta.env.VITE_API_URL ?? "http://localhost:4000";

export class ApiError extends Error {
  constructor(public status: number, public code: string, public data?: any) {
    super(code);
  }
}

interface Options {
  method?: "GET" | "POST" | "PUT" | "DELETE";
  token?: string | null;
  body?: unknown;
}

export async function api<T = any>(path: string, opts: Options = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API}${path}`, {
      method: opts.method ?? "GET",
      headers: {
        ...(opts.body ? { "content-type": "application/json" } : {}),
        ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
      },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
  } catch {
    throw new ApiError(0, "network");
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data?.error ?? "error", data);
  return data as T;
}

const MESSAGES: Record<string, string> = {
  network: "Нет связи с сервером. Проверьте интернет.",
  invalid_input: "Проверьте введённые данные (пароль — минимум 10 символов).",
  email_taken: "Этот email уже зарегистрирован.",
  invalid_credentials: "Неверный email или пароль.",
  account_limit: "Достигнут лимит аккаунтов вашего тарифа.",
  device_limit: "Достигнут лимит устройств вашего тарифа.",
  unauthorized: "Сессия истекла. Войдите заново.",
  invalid_key: "Ключ не найден или отозван. Проверьте, что ввели его без ошибок.",
  key_used: "Этот ключ уже активирован.",
  stripe_active: "У вас активна подписка через Stripe — ключ нельзя наложить. Он не сгорел.",
  lower_plan_active: "У вас уже активен более высокий тариф. Ключ не сгорел — активируйте его после окончания текущего.",
  lifetime_active: "У вас уже бессрочный тариф такого уровня. Ключ не сгорел.",
  busy: "Сервер занят, повторите через секунду.",
};

export function errorText(e: unknown): string {
  if (e instanceof ApiError) return MESSAGES[e.code] ?? `Ошибка сервера (${e.status})`;
  return "Неизвестная ошибка";
}

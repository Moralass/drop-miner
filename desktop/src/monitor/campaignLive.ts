import { useEffect, useState } from "react";
import type { Campaign } from "../types";
import type { LiveInfo } from "./batch";
import { fetchBatch } from "./runtime";

/** Кто из стримеров кампаний сейчас в эфире. Один запрос на все каналы раз в минуту (до 25 каналов). */
export function useCampaignLive(campaigns: Campaign[], enabled: boolean) {
  const [live, setLive] = useState<Record<string, LiveInfo>>({});
  const [error, setError] = useState<string | null>(null);
  const key = campaigns
    .filter((c) => new Date(c.endsAt).getTime() > Date.now())
    .flatMap((c) => c.channels)
    .join(",");

  useEffect(() => {
    if (!enabled) return;
    const logins = [...new Set(key.split(",").filter(Boolean))].slice(0, 25);
    if (!logins.length) {
      setLive({});
      return;
    }
    let alive = true;
    const load = () =>
      fetchBatch(logins)
        .then((r) => alive && (setLive(r), setError(null)))
        .catch((e) => alive && setError(e instanceof Error ? e.message : "Ошибка проверки"));
    load();
    const t = setInterval(load, 60_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [key, enabled]);

  return { live, error };
}

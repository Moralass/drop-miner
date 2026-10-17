import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

/** Для каких аккаунтов сейчас открыто окно стрима (опрос раз в 5 секунд). */
export function useOpenWindows(ids: string[], enabled: boolean): Set<string> {
  const [open, setOpen] = useState<Set<string>>(new Set());
  const key = ids.join(",");
  useEffect(() => {
    if (!enabled) {
      setOpen(new Set());
      return;
    }
    let alive = true;
    const tick = async () => {
      const list = key ? key.split(",") : [];
      const res = await Promise.all(
        list.map((id) => invoke<boolean>("is_stream_window_open", { accountId: id }).catch(() => false))
      );
      if (!alive) return;
      const next = new Set(list.filter((_, i) => res[i]));
      setOpen((prev) => (prev.size === next.size && [...next].every((x) => prev.has(x)) ? prev : next));
    };
    void tick();
    const t = setInterval(tick, 5000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [key, enabled]);
  return open;
}

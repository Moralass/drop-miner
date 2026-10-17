import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { useStore } from "../lib/store";

// Обложки берутся из каталога Twitch через наш сервер; в памяти хранится одна запись на игру.
const cache = new Map<string, string | null>();
const pending = new Map<string, Promise<void>>();

function load(game: string, token: string | null): Promise<void> {
  if (cache.has(game)) return Promise.resolve();
  let p = pending.get(game);
  if (!p) {
    p = api<{ games: Record<string, string | null> }>(`/v1/channels/games?names=${encodeURIComponent(game)}`, { token })
      .then((r) => void cache.set(game, r.games[game] ?? null))
      .catch(() => undefined) // не кэшируем сбой: попробуем снова при следующем показе
      .finally(() => void pending.delete(game));
    pending.set(game, p);
  }
  return p;
}

/** Официальная обложка игры. Пока нет данных (или Twitch API не настроен), показываем нейтральную заглушку. */
export default function GameArt({ game, size = 48 }: { game: string; size?: number }) {
  const token = useStore((s) => s.token);
  const [, bump] = useState(0);
  useEffect(() => {
    let alive = true;
    load(game, token).then(() => alive && bump((n) => n + 1));
    return () => {
      alive = false;
    };
  }, [game, token]);

  const src = cache.get(game);
  const style = { width: size, height: Math.round(size * 1.33) };
  return src ? (
    <img className="game-art" src={src} alt={game} style={style} loading="lazy" referrerPolicy="no-referrer" />
  ) : (
    <span className="game-art ph" style={style} aria-label={game}>
      {game.slice(0, 2).toUpperCase()}
    </span>
  );
}

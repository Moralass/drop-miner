import { openUrl } from "@tauri-apps/plugin-opener";

const URL = "https://t.me/steamnewsby";

/** Подпись компании-разработчика: кликабельная ссылка, открывается в обычном браузере. */
export default function Brand() {
  return (
    <a
      className="brand-link"
      href={URL}
      onClick={(e) => {
        e.preventDefault();
        openUrl(URL).catch(() => window.open(URL, "_blank", "noopener"));
      }}
    >
      SteamNews · t.me/steamnewsby
    </a>
  );
}

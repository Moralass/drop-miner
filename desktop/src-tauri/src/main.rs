#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri::{Manager, Url, WebviewUrl, WebviewWindowBuilder};

/// Выполняется на странице стрима: звук выключен, минимальное качество.
/// Это настройки обычного плеера Twitch — видео воспроизводится по-настоящему.
const STREAM_INIT_JS: &str = r#"
try {
  localStorage.setItem('video-quality', '{"default":"160p30"}');
  localStorage.setItem('video-muted', '{"default":true}');
  localStorage.setItem('volume', '0');
} catch (_) {}
"#;

fn is_valid_id(s: &str) -> bool {
    !s.is_empty() && s.len() <= 64 && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
}

fn is_valid_channel(s: &str) -> bool {
    !s.is_empty() && s.len() <= 25 && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
}

fn profile_dir(app: &tauri::AppHandle, account_id: &str) -> Result<std::path::PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("profiles")
        .join(account_id);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

/// Окно входа в Twitch с изолированным профилем (cookies/localStorage отдельно для каждого аккаунта).
#[tauri::command]
async fn open_login_window(app: tauri::AppHandle, account_id: String) -> Result<(), String> {
    if !is_valid_id(&account_id) {
        return Err("invalid account id".into());
    }
    let label = format!("login-{account_id}");
    if let Some(w) = app.get_webview_window(&label) {
        return w.set_focus().map_err(|e| e.to_string());
    }
    let url: Url = "https://www.twitch.tv/login".parse().map_err(|_| "bad url")?;
    WebviewWindowBuilder::new(&app, label, WebviewUrl::External(url))
        .title("Вход в Twitch")
        .data_directory(profile_dir(&app, &account_id)?)
        .inner_size(520.0, 760.0)
        .build()
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Окно с реальным стримом в профиле аккаунта.
#[tauri::command]
async fn open_stream_window(
    app: tauri::AppHandle,
    account_id: String,
    channel: String,
) -> Result<(), String> {
    if !is_valid_id(&account_id) || !is_valid_channel(&channel) {
        return Err("invalid arguments".into());
    }
    let label = format!("stream-{account_id}");
    let url: Url = format!("https://www.twitch.tv/{channel}")
        .parse()
        .map_err(|_| "bad url")?;

    if let Some(w) = app.get_webview_window(&label) {
        w.navigate(url).map_err(|e| e.to_string())?;
        return Ok(());
    }

    WebviewWindowBuilder::new(&app, label, WebviewUrl::External(url))
        .title(format!("Drop Miner · {channel}"))
        .data_directory(profile_dir(&app, &account_id)?)
        .initialization_script(STREAM_INIT_JS)
        .inner_size(960.0, 540.0)
        .build()
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Открыто ли окно стрима аккаунта. Минуты локального счётчика идут только при true.
#[tauri::command]
fn is_stream_window_open(app: tauri::AppHandle, account_id: String) -> bool {
    is_valid_id(&account_id) && app.get_webview_window(&format!("stream-{account_id}")).is_some()
}

/// Закрывает окно стрима аккаунта (если оно открыто).
#[tauri::command]
fn close_stream_window(app: tauri::AppHandle, account_id: String) -> Result<(), String> {
    if !is_valid_id(&account_id) {
        return Err("invalid account id".into());
    }
    if let Some(w) = app.get_webview_window(&format!("stream-{account_id}")) {
        w.close().map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![open_login_window, open_stream_window, is_stream_window_open, close_stream_window])
        .run(tauri::generate_context!())
        .expect("error while running Drop Miner");
}

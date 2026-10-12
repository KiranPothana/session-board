// Session Board's window for macOS, Windows and Linux: every Claude Code session on this
// computer, in one floating window. The board itself is the web page in ../ui; this side gives
// it what a page can't reach on its own: the files Claude Code and the mod write, the tray item,
// the global shortcut, and showing or hiding the window.
//
// It reads, every time the page asks (every 2 seconds):
//   ~/.claude/plugins/store/session-board_*.json  each session's record, written by the mod
//   ~/.claude/sessions/*.json                     Claude Code's registry of live sessions
//   the shared folder (shared_dir below): settings.json, removed.json, status.json, show-request
// and writes only settings.json, removed.json and status.json in the shared folder.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde_json::{json, Map, Value};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, WebviewWindow};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

const TRAY_ID: &str = "board";
// The files in the shared folder the page may write
const WRITABLE: [&str; 3] = ["settings.json", "removed.json", "status.json"];

fn home() -> PathBuf {
    let key = if cfg!(windows) { "USERPROFILE" } else { "HOME" };
    std::env::var_os(key).map(PathBuf::from).unwrap_or_default()
}

// The folder the mod and the window share. The mod works out the same path (dataDir in
// hooks/register.js), so the two must change together.
fn shared_dir() -> PathBuf {
    if cfg!(target_os = "macos") {
        home().join("Library/Application Support/session-board")
    } else if cfg!(windows) {
        std::env::var_os("APPDATA").map(PathBuf::from).unwrap_or_else(|| home().join("AppData/Roaming")).join("session-board")
    } else {
        std::env::var_os("XDG_DATA_HOME").map(PathBuf::from).unwrap_or_else(|| home().join(".local/share")).join("session-board")
    }
}

fn read_json(path: &Path) -> Option<Value> {
    serde_json::from_str(&fs::read_to_string(path).ok()?).ok()
}

fn millis(t: SystemTime) -> u64 {
    t.duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

// Every JSON file in a folder whose name passes `keep`, by file name
fn json_files(dir: &Path, keep: impl Fn(&str) -> bool) -> Map<String, Value> {
    let mut out = Map::new();
    let Ok(entries) = fs::read_dir(dir) else { return out };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if name.ends_with(".json") && keep(&name) {
            if let Some(v) = read_json(&entry.path()) {
                out.insert(name, v);
            }
        }
    }
    out
}

// Everything the board is drawn from, as one snapshot
#[tauri::command]
fn read_state() -> Value {
    let claude = home().join(".claude");
    let shared = shared_dir();
    let show_request = fs::metadata(shared.join("show-request")).and_then(|m| m.modified()).map(millis).unwrap_or(0);
    json!({
        "platform": std::env::consts::OS,
        "now": millis(SystemTime::now()),
        "store": json_files(&claude.join("plugins/store"), |n| n.starts_with("session-board_")),
        "registry": json_files(&claude.join("sessions"), |_| true),
        "settings": read_json(&shared.join("settings.json")).unwrap_or(json!({})),
        "removed": read_json(&shared.join("removed.json")).unwrap_or(json!({})),
        "showRequest": show_request,
    })
}

#[tauri::command]
fn write_shared(name: String, text: String) -> Result<(), String> {
    if !WRITABLE.contains(&name.as_str()) {
        return Err(format!("{name} isn't one of the files the window writes"));
    }
    let dir = shared_dir();
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    // Write beside it, then move it into place, so the mod never reads half a file
    let tmp = dir.join(format!(".{name}.tmp"));
    fs::write(&tmp, text).map_err(|e| e.to_string())?;
    fs::rename(&tmp, dir.join(&name)).map_err(|e| e.to_string())
}

// The tray item's text (macOS shows it beside the icon) and tooltip: "◉ 3 · 1!"
#[tauri::command]
fn set_tray(app: AppHandle, title: String, tooltip: String) {
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        let _ = tray.set_title(Some(&title));
        let _ = tray.set_tooltip(Some(&tooltip));
    }
}

fn board(app: &AppHandle) -> Option<WebviewWindow> {
    app.get_webview_window("board")
}

fn toggle(app: &AppHandle) {
    let Some(w) = board(app) else { return };
    if w.is_visible().unwrap_or(false) {
        let _ = w.hide();
    } else {
        let _ = w.show();
        let _ = w.set_focus();
    }
}

#[tauri::command]
fn show_board(app: AppHandle) {
    if let Some(w) = board(&app) {
        let _ = w.show();
    }
}

// Pressing the shortcut shows or hides the board; the page chooses the keys (Settings)
#[tauri::command]
fn set_shortcut(app: AppHandle, keys: String) -> Result<(), String> {
    let shortcut: Shortcut = keys.parse().map_err(|e| format!("{e}"))?;
    let gs = app.global_shortcut();
    let _ = gs.unregister_all();
    gs.on_shortcut(shortcut, |app, _, event| {
        if event.state == ShortcutState::Pressed {
            toggle(app);
        }
    })
    .map_err(|e| e.to_string())
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .invoke_handler(tauri::generate_handler![read_state, write_shared, set_tray, show_board, set_shortcut])
        .setup(|app| {
            let show = MenuItem::with_id(app, "toggle", "Show or hide the window", true, None::<&str>)?;
            let settings = MenuItem::with_id(app, "settings", "Settings…", true, None::<&str>)?;
            let report = MenuItem::with_id(app, "report", "Report a Problem…", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit Session Board", true, None::<&str>)?;
            let sep = PredefinedMenuItem::separator(app)?;
            let menu = Menu::with_items(app, &[&show, &settings, &report, &sep, &quit])?;
            TrayIconBuilder::with_id(TRAY_ID)
                .icon(app.default_window_icon().cloned().expect("the bundle has an icon"))
                .icon_as_template(false)
                .title("◉")
                .tooltip("Session Board")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id().as_ref() {
                    "toggle" => toggle(app),
                    "quit" => app.exit(0),
                    other => {
                        if let Some(w) = board(app) {
                            let _ = w.show();
                        }
                        let _ = app.emit("menu", other.to_string());
                    }
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                        toggle(tray.app_handle());
                    }
                })
                .build(app)?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("Session Board couldn't start");
}

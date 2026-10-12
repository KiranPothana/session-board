// Session Board's window for macOS, Windows and Linux: every Claude Code session on this
// computer, in one floating window. The board itself is the web page in ../ui; this side gives
// it what a page can't reach on its own: the files Claude Code and the mod write, the tray item,
// the global shortcut, and showing or hiding the window.
//
// It reads, every time the page asks (every 2 seconds):
//   ~/.claude/plugins/store/session-board_*.json  each session's record, written by the mod
//   ~/.claude/sessions/*.json                     Claude Code's registry of live sessions
//   the shared folder (shared_dir below): settings.json, removed.json, status.json, show-request
//   Claude Desktop's config.json, for its theme
// and writes only settings.json, removed.json and status.json in the shared folder. It also says
// which app is in front (front_app), for "hide when you switch away"; on Wayland it can't know.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod platform;

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
    // For trying the window without touching the real shared folder
    if let Some(dir) = std::env::var_os("SESSION_BOARD_SHARED_DIR") {
        return PathBuf::from(dir);
    }
    if cfg!(target_os = "macos") {
        home().join("Library/Application Support/session-board")
    } else if cfg!(windows) {
        std::env::var_os("APPDATA").map(PathBuf::from).unwrap_or_else(|| home().join("AppData/Roaming")).join("session-board")
    } else {
        std::env::var_os("XDG_DATA_HOME").map(PathBuf::from).unwrap_or_else(|| home().join(".local/share")).join("session-board")
    }
}

// Claude Desktop's own settings folder, where its config.json says which theme you picked
fn claude_desktop_dir() -> PathBuf {
    if cfg!(target_os = "macos") {
        home().join("Library/Application Support/Claude")
    } else if cfg!(windows) {
        std::env::var_os("APPDATA").map(PathBuf::from).unwrap_or_else(|| home().join("AppData/Roaming")).join("Claude")
    } else {
        std::env::var_os("XDG_CONFIG_HOME").map(PathBuf::from).unwrap_or_else(|| home().join(".config")).join("Claude")
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
    // A test popup, as the macOS app's test-toast file: "0", "1" or "2" for its kind, read once
    let test_toast = fs::read_to_string(shared.join("test-toast")).ok().map(|t| t.trim().to_string());
    if test_toast.is_some() {
        let _ = fs::remove_file(shared.join("test-toast"));
    }
    let registry = json_files(&claude.join("sessions"), |_| true);
    // Project names for the registry's folders, and the commands each session left running
    let home = home();
    let mut projects = Map::new();
    let mut sessions = vec![];
    for entry in registry.values() {
        if let Some(cwd) = entry.get("cwd").and_then(Value::as_str) {
            projects.insert(cwd.to_string(), json!(platform::project_name(cwd, &home)));
        }
        if let (Some(id), Some(started)) = (entry.get("sessionId").and_then(Value::as_str), entry.get("startedAt").and_then(Value::as_u64)) {
            sessions.push((id.to_string(), started));
        }
    }
    let procs = platform::processes();
    json!({
        "platform": std::env::consts::OS,
        "projects": projects,
        "jobs": platform::jobs(&procs, &sessions),
        "desktopRunning": platform::desktop_running(&procs),
        "accessibility": accessibility(),
        "now": millis(SystemTime::now()),
        "store": json_files(&claude.join("plugins/store"), |n| n.starts_with("session-board_")),
        "registry": registry,
        "settings": read_json(&shared.join("settings.json")).unwrap_or(json!({})),
        "removed": read_json(&shared.join("removed.json")).unwrap_or(json!({})),
        "showRequest": show_request,
        "registryReadable": claude.join("sessions").is_dir(),
        "testToast": test_toast,
        // Trying the window (SESSION_BOARD_SHARED_DIR set): it stays shown, whatever app is in front
        "testing": std::env::var_os("SESSION_BOARD_SHARED_DIR").is_some(),
        "claudeTheme": read_json(&claude_desktop_dir().join("config.json")).and_then(|c| c.get("userThemeMode").cloned()).unwrap_or(Value::Null),
    })
}

// The app in front: its name, executable path and process id (null where the OS won't say,
// such as on Wayland)
#[tauri::command]
fn front_app() -> Value {
    match active_win_pos_rs::get_active_window() {
        Ok(w) => json!({ "app": w.app_name, "path": w.process_path.to_string_lossy(), "pid": w.process_id, "title": w.title }),
        Err(_) => Value::Null,
    }
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

// macOS: the board and the popups are non-activating panels, as the SwiftUI app's were. Only a
// panel shows over another app's full-screen Space, and clicking one never takes the focus from
// the app you're in.
#[cfg(target_os = "macos")]
tauri_nspanel::tauri_panel! {
    panel!(BoardPanel {
        config: {
            can_become_key_window: true,
            becomes_key_only_if_needed: true,
            is_floating_panel: true
        }
    })
    panel!(ToastPanel {
        config: {
            can_become_key_window: false,
            is_floating_panel: true
        }
    })
}

#[cfg(target_os = "macos")]
fn make_panel(app: &AppHandle, label: &str) {
    use tauri_nspanel::{CollectionBehavior, PanelLevel, StyleMask, WebviewWindowExt};
    let Some(w) = app.get_webview_window(label) else { return };
    let panel = if label == "board" { w.to_panel::<BoardPanel>() } else { w.to_panel::<ToastPanel>() };
    let panel = match panel {
        Ok(p) => p,
        Err(e) => {
            eprintln!("[panel] {label} couldn't become a panel: {e}");
            return;
        }
    };
    let style = if label == "board" { StyleMask::empty().nonactivating_panel().resizable().full_size_content_view() } else { StyleMask::empty().nonactivating_panel().full_size_content_view() };
    if let Err(e) = panel.set_style_mask(style.value()) {
        eprintln!("[panel] {label} style: {e:?}");
    }
    panel.set_level(PanelLevel::Floating.value());
    panel.set_hides_on_deactivate(false);
    panel.set_collection_behavior(CollectionBehavior::new().can_join_all_spaces().full_screen_auxiliary().stationary().value());
}

// Shows a window without taking the focus from the app you're in
fn show_quietly(w: &WebviewWindow) {
    #[cfg(target_os = "macos")]
    {
        use tauri_nspanel::ManagerExt;
        // AppKit only takes window calls on the main thread; commands run elsewhere
        if w.app_handle().get_webview_panel(w.label()).is_ok() {
            let app = w.app_handle().clone();
            let label = w.label().to_string();
            let _ = w.app_handle().run_on_main_thread(move || {
                if let Ok(panel) = app.get_webview_panel(&label) {
                    panel.order_front_regardless();
                    if std::env::var_os("SESSION_BOARD_SHARED_DIR").is_some() {
                        let w = panel.to_window();
                        eprintln!("[panel] {label} ordered in: visible={:?} pos={:?} size={:?}", w.as_ref().map(|w| w.is_visible()), w.as_ref().map(|w| w.outer_position()), w.as_ref().map(|w| w.outer_size()));
                    }
                }
            });
            return;
        }
    }
    let _ = w.show();
}

// The popup window stays ordered in from the start (a window ordered in later can land on
// another Space); with no popups it is see-through and lets clicks pass
#[tauri::command]
fn set_toasts_visible(app: AppHandle, visible: bool) {
    let Some(w) = app.get_webview_window("toasts") else { return };
    #[cfg(target_os = "macos")]
    {
        use tauri_nspanel::ManagerExt;
        let app2 = app.clone();
        let _ = app.run_on_main_thread(move || {
            if let Ok(panel) = app2.get_webview_panel("toasts") {
                use tauri_nspanel::{CollectionBehavior, PanelLevel};
                panel.set_level(PanelLevel::Floating.value());
                panel.set_collection_behavior(CollectionBehavior::new().can_join_all_spaces().full_screen_auxiliary().stationary().value());
                panel.set_alpha_value(if visible { 1.0 } else { 0.0 });
                panel.set_ignores_mouse_events(!visible);
                panel.order_front_regardless();
            }
        });
        let _ = w;
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = if visible { w.show() } else { w.hide() };
    }
}

#[tauri::command]
fn show_window(app: AppHandle, label: String) {
    if let Some(w) = app.get_webview_window(&label) {
        show_quietly(&w);
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
        show_quietly(&w);
    }
}

#[tauri::command]
fn show_board(app: AppHandle) {
    if let Some(w) = board(&app) {
        show_quietly(&w);
    }
}

// Pressing the shortcut shows or hides the board; the page chooses it (Settings). Keys such as
// "Ctrl+Alt+S", or on macOS "tap:<key code>" for a right-hand modifier tapped on its own.
#[tauri::command]
fn set_shortcut(app: AppHandle, keys: String) -> Result<(), String> {
    let gs = app.global_shortcut();
    let _ = gs.unregister_all();
    #[cfg(target_os = "macos")]
    platform::taps::set(None);
    if let Some(code) = keys.strip_prefix("tap:") {
        #[cfg(target_os = "macos")]
        {
            platform::taps::set(code.parse().ok());
            return Ok(());
        }
        #[cfg(not(target_os = "macos"))]
        return Err(format!("a modifier tap ({code}) works only on macOS for now"));
    }
    let shortcut: Shortcut = keys.parse().map_err(|e| format!("{e}"))?;
    gs.on_shortcut(shortcut, |app, _, event| {
        if event.state == ShortcutState::Pressed {
            toggle(app);
        }
    })
    .map_err(|e| e.to_string())
}

// While you record a new shortcut the board takes the keyboard, and gives it back after
#[tauri::command]
fn take_keyboard(app: AppHandle, take: bool) {
    #[cfg(target_os = "macos")]
    {
        use tauri_nspanel::ManagerExt;
        let app2 = app.clone();
        let _ = app.run_on_main_thread(move || {
            if let Ok(panel) = app2.get_webview_panel("board") {
                if take {
                    panel.show_and_make_key();
                } else {
                    panel.resign_key_window();
                }
            }
        });
    }
    #[cfg(not(target_os = "macos"))]
    if take {
        if let Some(w) = board(&app) {
            let _ = w.set_focus();
        }
    }
}

// macOS: the SwiftUI app's settings, to carry over once
#[tauri::command]
fn legacy_settings() -> Value {
    #[cfg(target_os = "macos")]
    return platform::legacy_settings();
    #[cfg(not(target_os = "macos"))]
    Value::Null
}

// The pages' errors, in the app's log (stderr), where they can be read
#[tauri::command]
fn log(msg: String) {
    eprintln!("[page] {msg}");
}

// Whether this app may read Claude Desktop's open session (macOS Accessibility); always on elsewhere
fn accessibility() -> bool {
    #[cfg(target_os = "macos")]
    return platform::mac::trusted();
    #[cfg(not(target_os = "macos"))]
    true
}

// Shows macOS's Accessibility prompt for this app (once, from the page)
#[tauri::command]
fn ask_accessibility() {
    #[cfg(target_os = "macos")]
    platform::mac::ask_trust();
}

// What's in front: the session Claude Desktop shows, or the sessions under the terminal in front
#[tauri::command]
async fn focus(pids: Vec<u32>) -> Value {
    platform::focus(&pids)
}

#[tauri::command]
async fn open_session(app: AppHandle, id: String, bridge_id: String, is_desktop: bool, pid: Option<u32>) {
    platform::open_session(&app, &id, &bridge_id, is_desktop, pid);
}

// The newest crash since the last one offered
#[tauri::command]
fn read_crash(since: u64) -> Value {
    platform::newest_crash(&shared_dir(), since)
}

// ---- Sounds beyond the bundled ones: macOS's alert sounds and your own (in the shared folder's
// sounds/), handed to the page as data it can play

const MAC_ALERTS: [&str; 14] = ["Glass", "Ping", "Hero", "Submarine", "Purr", "Funk", "Pop", "Tink", "Blow", "Bottle", "Frog", "Morse", "Sosumi", "Basso"];
const SOUND_MAX_BYTES: usize = 5 * 1024 * 1024;

fn sound_path(id: &str) -> Option<PathBuf> {
    if let Some(name) = id.strip_prefix("mac:") {
        return MAC_ALERTS.contains(&name).then(|| PathBuf::from(format!("/System/Library/Sounds/{name}.aiff")));
    }
    let file = id.strip_prefix("custom:")?;
    // A file name only, never a path out of the folder
    if file.contains('/') || file.contains('\\') || file.starts_with('.') {
        return None;
    }
    Some(shared_dir().join("sounds").join(file))
}

// The sounds besides the bundled ones: macOS's (on a Mac) and yours
#[tauri::command]
fn list_sounds() -> Value {
    let mac: Vec<&str> = if cfg!(target_os = "macos") { MAC_ALERTS.to_vec() } else { vec![] };
    let mut own: Vec<String> = fs::read_dir(shared_dir().join("sounds"))
        .into_iter()
        .flatten()
        .flatten()
        .map(|e| e.file_name().to_string_lossy().to_string())
        .filter(|n| !n.starts_with('.'))
        .collect();
    own.sort();
    json!({ "mac": mac, "own": own })
}

// A sound's bytes, base64, for the page to play
#[tauri::command]
fn read_sound(id: String) -> Result<String, String> {
    use base64::Engine;
    let path = sound_path(&id).ok_or("not a sound")?;
    let bytes = fs::read(&path).map_err(|e| e.to_string())?;
    Ok(base64::engine::general_purpose::STANDARD.encode(bytes))
}

// Keeps a file you picked as one of your sounds; answers its name (made unique)
#[tauri::command]
fn add_sound(name: String, data: String) -> Result<String, String> {
    use base64::Engine;
    let bytes = base64::engine::general_purpose::STANDARD.decode(data).map_err(|e| e.to_string())?;
    if bytes.len() > SOUND_MAX_BYTES {
        return Err("it's over 5 MB".into());
    }
    let clean: String = name.chars().filter(|c| !matches!(c, '/' | '\\' | ':' | '\0')).collect();
    let clean = clean.trim_start_matches('.').to_string();
    if clean.is_empty() {
        return Err("it has no name".into());
    }
    let dir = shared_dir().join("sounds");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let (stem, ext) = match clean.rsplit_once('.') {
        Some((s, e)) => (s.to_string(), format!(".{e}")),
        None => (clean.clone(), String::new()),
    };
    let mut file = clean.clone();
    let mut n = 2;
    while dir.join(&file).exists() {
        file = format!("{stem} {n}{ext}");
        n += 1;
    }
    fs::write(dir.join(&file), bytes).map_err(|e| e.to_string())?;
    Ok(file)
}

#[tauri::command]
fn remove_sound(id: String) -> Result<(), String> {
    match (id.starts_with("custom:"), sound_path(&id)) {
        (true, Some(path)) => fs::remove_file(path).map_err(|e| e.to_string()),
        _ => Err("not one of your sounds".into()),
    }
}

// macOS: the output volume (0-100) and whether it's muted, and setting it, so an alert can play
// at the volume you chose and put yours back after, as the SwiftUI app did
#[tauri::command]
fn mac_volume(set: Option<u8>) -> Value {
    #[cfg(target_os = "macos")]
    {
        if let Some(v) = set {
            let _ = std::process::Command::new("osascript").args(["-e", &format!("set volume output volume {}", v.min(100))]).output();
        }
        let out = std::process::Command::new("osascript").args(["-e", "set s to get volume settings", "-e", "(output volume of s as text) & \",\" & (output muted of s as text)"]).output();
        let text = out.map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string()).unwrap_or_default();
        let mut parts = text.split(',');
        let volume = parts.next().and_then(|v| v.trim().parse::<u8>().ok());
        let muted = parts.next().map(|m| m.trim() == "true").unwrap_or(false);
        return json!({ "volume": volume, "muted": muted });
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = set;
        Value::Null
    }
}

// Floating (above other apps, on every Space, no Dock icon) or Regular (a normal window with a
// Dock or taskbar icon that other windows can cover)
#[tauri::command]
fn set_window_mode(app: AppHandle, regular: bool) {
    let Some(w) = board(&app) else { return };
    #[cfg(target_os = "macos")]
    {
        use tauri_nspanel::{CollectionBehavior, ManagerExt, PanelLevel};
        let _ = app.set_activation_policy(if regular { tauri::ActivationPolicy::Regular } else { tauri::ActivationPolicy::Accessory });
        let app2 = app.clone();
        let _ = app.run_on_main_thread(move || {
            if let Ok(panel) = app2.get_webview_panel("board") {
                if regular {
                    panel.set_level(PanelLevel::Normal.value());
                    panel.set_collection_behavior(CollectionBehavior::new().value());
                } else {
                    panel.set_level(PanelLevel::Floating.value());
                    panel.set_collection_behavior(CollectionBehavior::new().can_join_all_spaces().full_screen_auxiliary().stationary().value());
                }
                panel.order_front_regardless();
            }
        });
        let _ = w;
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = w.set_always_on_top(!regular);
        let _ = w.set_skip_taskbar(!regular);
        let _ = w.set_visible_on_all_workspaces(!regular);
    }
}

// This app's process id, so the page can tell its own window being in front from another app's
#[tauri::command]
fn own_pid() -> u32 {
    std::process::id()
}

fn main() {
    platform::record_panics(shared_dir());
    let builder = tauri::Builder::default();
    // Starting never takes the focus from the app you're in (with LSUIElement in Info.plist, as
    // the SwiftUI app had: a background app with no Dock icon)
    #[cfg(target_os = "macos")]
    let builder = builder.activate_ignoring_other_apps(false);
    #[cfg(target_os = "macos")]
    let builder = builder.plugin(tauri_nspanel::init());
    builder
        // Started again while it runs (the plugin starts it on each new session): show the board
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(w) = board(app) {
                show_quietly(&w);
            }
        }))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .invoke_handler(tauri::generate_handler![read_state, write_shared, set_tray, show_board, set_shortcut, front_app, own_pid, log, show_window, set_toasts_visible, ask_accessibility, focus, open_session, read_crash, take_keyboard, legacy_settings, list_sounds, read_sound, add_sound, remove_sound, mac_volume, set_window_mode])
        .setup(|app| {

            let show = MenuItem::with_id(app, "toggle", "Show or hide the window", true, None::<&str>)?;
            let settings = MenuItem::with_id(app, "settings", "Settings…", true, None::<&str>)?;
            let report = MenuItem::with_id(app, "report", "Report a Problem…", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit Session Board", true, None::<&str>)?;
            let sep = PredefinedMenuItem::separator(app)?;
            let menu = Menu::with_items(app, &[&show, &settings, &report, &sep, &quit])?;
            #[cfg(target_os = "macos")]
            for label in ["board", "toasts"] {
                make_panel(app.handle(), label);
            }
            // Windows 11 rounds a frameless window only when asked (Windows 10 keeps it square)
            #[cfg(windows)]
            if let Some(w) = board(app.handle()) {
                if let Ok(hwnd) = w.hwnd() {
                    use windows::Win32::Graphics::Dwm::{DwmSetWindowAttribute, DWMWA_WINDOW_CORNER_PREFERENCE, DWMWCP_ROUND};
                    let pref = DWMWCP_ROUND;
                    unsafe {
                        let _ = DwmSetWindowAttribute(windows::Win32::Foundation::HWND(hwnd.0 as _), DWMWA_WINDOW_CORNER_PREFERENCE, &pref as *const _ as *const _, std::mem::size_of_val(&pref) as u32);
                    }
                }
            }
            if let Some(w) = board(app.handle()) {
                show_quietly(&w);
            }
            set_toasts_visible(app.handle().clone(), false);
            #[cfg(target_os = "macos")]
            {
                let handle = app.handle().clone();
                platform::taps::install(move || {
                    let h = handle.clone();
                    let _ = handle.run_on_main_thread(move || toggle(&h));
                });
            }
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
                            show_quietly(&w);
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
        .build(tauri::generate_context!())
        .expect("Session Board couldn't start")
        .run(|app, event| {
            // macOS: clicking the Dock icon (Regular window) brings the board back
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Reopen { .. } = event {
                if let Some(w) = board(app) {
                    show_quietly(&w);
                }
            }
            let _ = (app, event);
        });
}

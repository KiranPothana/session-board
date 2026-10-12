// What the board needs from the operating system, per OS: which session you're looking at,
// taking you to a session, the commands sessions left running, project names and crash reports.
// Ported from the macOS app (board/main.swift); docs/PORT-INVENTORY.md section 4 lists what each
// OS can and can't do. Where an OS can't say (Wayland, a terminal with no scripting), these return
// nothing and the board does without.

use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Mutex;
use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System, UpdateKind};

// ---- Processes

pub struct Proc {
    pub parent: Option<u32>,
    pub name: String,
    pub exe: String,
    pub cmd: String,
    pub minutes: u64,
}

pub fn processes() -> HashMap<u32, Proc> {
    let mut sys = System::new();
    sys.refresh_processes_specifics(
        ProcessesToUpdate::All,
        true,
        ProcessRefreshKind::nothing().with_cmd(UpdateKind::Always).with_exe(UpdateKind::OnlyIfNotSet),
    );
    sys.processes()
        .iter()
        .map(|(pid, p)| {
            let cmd = p.cmd().iter().map(|a| a.to_string_lossy()).collect::<Vec<_>>().join(" ");
            (
                pid.as_u32(),
                Proc {
                    parent: p.parent().map(Pid::as_u32),
                    name: p.name().to_string_lossy().to_string(),
                    exe: p.exe().map(|e| e.to_string_lossy().to_string()).unwrap_or_default(),
                    cmd,
                    minutes: p.run_time() / 60,
                },
            )
        })
        .collect()
}

// A process and the ones above it, nearest first, at most 12 hops
fn ancestors(procs: &HashMap<u32, Proc>, pid: u32) -> Vec<u32> {
    let mut out = vec![pid];
    let mut current = pid;
    for _ in 0..12 {
        match procs.get(&current).and_then(|p| p.parent) {
            Some(parent) if parent > 1 && !out.contains(&parent) => {
                out.push(parent);
                current = parent;
            }
            _ => break,
        }
    }
    out
}

// Claude Desktop's main process (not Claude Code's CLI, which is also called claude)
fn is_claude_desktop(p: &Proc) -> bool {
    let exe = p.exe.replace('\\', "/");
    if cfg!(target_os = "macos") {
        exe.ends_with("Claude.app/Contents/MacOS/Claude")
    } else if cfg!(windows) {
        // Installed under %LOCALAPPDATA%\AnthropicClaude (verify on Windows)
        p.name.eq_ignore_ascii_case("claude.exe") && exe.to_lowercase().contains("anthropicclaude")
    } else {
        // Claude Desktop has no official Linux build
        false
    }
}

pub fn desktop_running(procs: &HashMap<u32, Proc>) -> bool {
    procs.values().any(is_claude_desktop)
}

// ---- Commands a session left running ("Browser tests still running · 6m")

// A command a session runs carries its shell snapshot's path, named for when the snapshot was
// made: .../shell-snapshots/snapshot-<shell>-<13-digit ms>-...
fn snapshot_ms(cmd: &str) -> Option<u64> {
    let i = cmd.find("shell-snapshots")?;
    let rest = &cmd[i..];
    let j = rest.find("snapshot-")? + "snapshot-".len();
    let rest = &rest[j..];
    let dash = rest.find('-')?;
    if !rest[..dash].chars().all(|c| c.is_ascii_alphabetic()) {
        return None;
    }
    let digits: String = rest[dash + 1..].chars().take_while(|c| c.is_ascii_digit()).collect();
    if digits.len() == 13 && rest[dash + 1 + 13..].starts_with('-') {
        digits.parse().ok()
    } else {
        None
    }
}

fn job_label(cmd: &str) -> &'static str {
    let c = cmd.to_lowercase();
    let has = |xs: &[&str]| xs.iter().any(|x| c.contains(x));
    if has(&["playwright test"]) {
        "browser tests"
    } else if has(&["vitest", "jest ", "npm test", "npm run test", "bun test", "pytest", "go test", "cargo test", "swift test", "plugin test"]) {
        "tests"
    } else if has(&["vite preview", "vite dev", "npm run dev", "next dev", "http.server", "npm start"]) {
        "a local server"
    } else if has(&["build.sh", "npm run build", "vite build", "swiftc ", "xcodebuild", "cargo build", "go build", "docker build"]) {
        "a build"
    } else if has(&["deploy", "rsync ", "scp ", "ssh "]) {
        "work on a server"
    } else {
        "a command"
    }
}

// Each session's running commands, by session id. sessions: (id, when it started, ms). A command
// belongs to the live session that started last before its shell snapshot was made.
pub fn jobs(procs: &HashMap<u32, Proc>, sessions: &[(String, u64)]) -> Value {
    let mut out: Map<String, Value> = Map::new();
    for p in procs.values() {
        let Some(ms) = snapshot_ms(&p.cmd) else { continue };
        let owner = sessions.iter().filter(|(_, started)| *started <= ms).max_by_key(|(_, started)| *started);
        if let Some((id, _)) = owner {
            let list = out.entry(id.clone()).or_insert_with(|| json!([]));
            list.as_array_mut().unwrap().push(json!({ "label": job_label(&p.cmd), "minutes": p.minutes }));
        }
    }
    Value::Object(out)
}

// ---- Project names: the Git repo a folder belongs to (a worktree counts as its main repo)

static PROJECTS: Mutex<Option<HashMap<String, String>>> = Mutex::new(None);

pub fn project_name(cwd: &str, home: &Path) -> String {
    if let Some(name) = PROJECTS.lock().unwrap().get_or_insert_with(HashMap::new).get(cwd) {
        return name.clone();
    }
    let base = |p: &Path| p.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
    let unified = cwd.replace('\\', "/");
    let cut = unified.find("/.claude/worktrees/").map(|i| &cwd[..i]).unwrap_or(cwd);
    let start = PathBuf::from(cut);
    let mut dir = start.as_path();
    let mut name = base(&start);
    while dir.starts_with(home) && dir != home {
        let git = dir.join(".git");
        if git.is_dir() {
            name = base(dir);
            break;
        }
        if git.is_file() {
            // A worktree's .git file points into the main repo's .git/worktrees/
            let text = fs::read_to_string(&git).unwrap_or_default();
            let gitdir = text.lines().find_map(|l| l.strip_prefix("gitdir:")).map(str::trim).unwrap_or("");
            let unified = gitdir.replace('\\', "/");
            name = match unified.find("/.git/worktrees/") {
                Some(i) => base(Path::new(&gitdir[..i])),
                None => base(dir),
            };
            break;
        }
        match dir.parent() {
            Some(parent) => dir = parent,
            None => break,
        }
    }
    PROJECTS.lock().unwrap().get_or_insert_with(HashMap::new).insert(cwd.to_string(), name.clone());
    name
}

// ---- Which session you're looking at

const DESKTOP_SUFFIX: &str = " - Claude Code";

// What's in front, for the board to match against its sessions: the session Claude Desktop shows
// (its name), or the session processes under the terminal in front (their pids, with the front
// window's title to tell several apart). session_pids: the live sessions' Claude Code pids.
pub fn focus(session_pids: &[u32]) -> Value {
    let Ok(front) = active_win_pos_rs::get_active_window() else { return Value::Null };
    let front_pid = front.process_id as u32;
    let procs = processes();
    let front_is_desktop = procs.get(&front_pid).map(is_claude_desktop).unwrap_or(false);
    if front_is_desktop {
        #[cfg(target_os = "macos")]
        return json!({ "desktopName": mac::desktop_session_name(front_pid as i32) });
        #[cfg(not(target_os = "macos"))]
        return json!({ "desktopName": front.title.strip_suffix(DESKTOP_SUFFIX).map(str::to_string) });
    }
    #[cfg(target_os = "macos")]
    if let Some(pids) = mac::terminal_tab_pids(&front.app_name) {
        let hits: Vec<u32> = session_pids.iter().copied().filter(|p| pids.contains(p)).collect();
        return json!({ "pids": hits, "title": front.title });
    }
    // Any other app: the sessions running somewhere under it
    let hits: Vec<u32> = session_pids.iter().copied().filter(|p| ancestors(&procs, *p).contains(&front_pid)).collect();
    json!({ "pids": hits, "title": front.title })
}

// ---- Taking you to a session

// In Claude Desktop, while it runs: a Remote Control session by its claude.ai page, one of
// Desktop's own by its id there. Otherwise the terminal it runs in (on macOS its very tab, in
// Terminal or iTerm2), or the app above it. A Remote Control session with no Desktop opens in the
// browser.
pub fn open_session(app: &tauri::AppHandle, id: &str, bridge_id: &str, is_desktop: bool, pid: Option<u32>) {
    use tauri_plugin_opener::OpenerExt;
    let procs = processes();
    let desktop = desktop_running(&procs);
    if !bridge_id.is_empty() {
        let url = if desktop { format!("claude://claude.ai/code/{bridge_id}") } else { format!("https://claude.ai/code/{bridge_id}") };
        let _ = app.opener().open_url(url, None::<&str>);
        return;
    }
    if desktop && is_desktop {
        if let Some(local) = desktop_local_id(id) {
            let _ = app.opener().open_url(format!("claude://code/continue?session={local}&source=session_board"), None::<&str>);
            return;
        }
    }
    let Some(pid) = pid else { return };
    #[cfg(target_os = "macos")]
    if mac::select_terminal_tab(pid) {
        return;
    }
    for p in ancestors(&procs, pid) {
        if bring_forward(p) {
            return;
        }
    }
}

// Claude Desktop's own folder of session files
pub fn claude_desktop_dir(home: &Path) -> PathBuf {
    if cfg!(target_os = "macos") {
        home.join("Library/Application Support/Claude")
    } else if cfg!(windows) {
        std::env::var_os("APPDATA").map(PathBuf::from).unwrap_or_else(|| home.join("AppData/Roaming")).join("Claude")
    } else {
        std::env::var_os("XDG_CONFIG_HOME").map(PathBuf::from).unwrap_or_else(|| home.join(".config")).join("Claude")
    }
}

// Claude Desktop's id ("local_…") for a session it runs, from its session files
fn desktop_local_id(cli_id: &str) -> Option<String> {
    let home = super::home();
    let mut stack = vec![claude_desktop_dir(&home).join("claude-code-sessions")];
    while let Some(dir) = stack.pop() {
        for entry in fs::read_dir(&dir).ok()?.flatten() {
            let path = entry.path();
            if path.is_dir() {
                stack.push(path);
                continue;
            }
            let name = entry.file_name().to_string_lossy().to_string();
            if name.starts_with("local_") && name.ends_with(".json") {
                let d: Value = serde_json::from_str(&fs::read_to_string(&path).unwrap_or_default()).unwrap_or(Value::Null);
                if d.get("cliSessionId").and_then(Value::as_str) == Some(cli_id) {
                    return d.get("sessionId").and_then(Value::as_str).map(str::to_string);
                }
            }
        }
    }
    None
}

// Brings a process's window forward, if it has one; true when it did
#[cfg(target_os = "macos")]
fn bring_forward(pid: u32) -> bool {
    let script = format!("tell application \"System Events\" to set frontmost of (first process whose unix id is {pid} and background only is false) to true");
    Command::new("osascript").args(["-e", &script]).output().map(|o| o.status.success()).unwrap_or(false)
}

#[cfg(windows)]
fn bring_forward(pid: u32) -> bool {
    win::bring_forward(pid)
}

// X11, with xdotool installed; Wayland lets no app raise another's window
#[cfg(all(unix, not(target_os = "macos")))]
fn bring_forward(pid: u32) -> bool {
    let Ok(out) = Command::new("xdotool").args(["search", "--onlyvisible", "--pid", &pid.to_string()]).output() else { return false };
    let Some(window) = String::from_utf8_lossy(&out.stdout).lines().next().map(str::to_string) else { return false };
    Command::new("xdotool").args(["windowactivate", &window]).status().map(|s| s.success()).unwrap_or(false)
}

// ---- Crash reports

// The newest crash since `since_ms`: this app's own panic file (any OS), or on macOS the report
// macOS wrote. { kind: "panic" | "ips", text, at } or null.
pub fn newest_crash(shared: &Path, since_ms: u64) -> Value {
    // The home folder (it names you) comes out of what a report could send
    let home = super::home().to_string_lossy().to_string();
    let clean = |t: String| if home.len() > 1 { t.replace(&home, "~") } else { t };
    let modified = |p: &Path| fs::metadata(p).and_then(|m| m.modified()).map(super::millis).unwrap_or(0);
    let panic = shared.join("crash.txt");
    if panic.is_file() && modified(&panic) > since_ms {
        return json!({ "kind": "panic", "text": clean(fs::read_to_string(&panic).unwrap_or_default()), "at": modified(&panic) });
    }
    #[cfg(target_os = "macos")]
    {
        let dir = super::home().join("Library/Logs/DiagnosticReports");
        let newest = fs::read_dir(&dir)
            .into_iter()
            .flatten()
            .flatten()
            .map(|e| e.path())
            .filter(|p| {
                let n = p.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
                (n.starts_with("session-board") || n.starts_with("Session Board")) && n.ends_with(".ips")
            })
            .filter(|p| modified(p) > since_ms)
            .max_by_key(|p| modified(p));
        if let Some(p) = newest {
            return json!({ "kind": "ips", "text": clean(fs::read_to_string(&p).unwrap_or_default()), "at": modified(&p) });
        }
    }
    Value::Null
}

// A panic writes what happened to the shared folder, for the crash prompt at the next launch
pub fn record_panics(shared: PathBuf) {
    let default = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let text = format!(
            "{info}\n\nSession Board {} on {} {}\n\n{}",
            env!("CARGO_PKG_VERSION"),
            std::env::consts::OS,
            std::env::consts::ARCH,
            std::backtrace::Backtrace::force_capture()
        );
        let _ = fs::create_dir_all(&shared);
        let _ = fs::write(shared.join("crash.txt"), text);
        default(info);
    }));
}

// ---- macOS: Accessibility for Claude Desktop, AppleScript for Terminal and iTerm2

#[cfg(target_os = "macos")]
pub mod mac {
    use objc2_application_services::{AXError, AXIsProcessTrusted, AXUIElement};
    use objc2_core_foundation::{CFArray, CFBoolean, CFRetained, CFString, CFType};
    use std::process::Command;
    use std::ptr::NonNull;

    pub fn trusted() -> bool {
        unsafe { AXIsProcessTrusted() }
    }

    // Asks macOS to show its Accessibility prompt for this app
    pub fn ask_trust() {
        use objc2_core_foundation::{CFDictionary, kCFBooleanTrue};
        extern "C" {
            static kAXTrustedCheckOptionPrompt: &'static CFString;
            fn AXIsProcessTrustedWithOptions(options: Option<&CFDictionary>) -> bool;
        }
        unsafe {
            let Some(yes) = kCFBooleanTrue else { return };
            let options = CFDictionary::from_slices(&[kAXTrustedCheckOptionPrompt], &[yes]);
            AXIsProcessTrustedWithOptions(Some(options.as_opaque()));
        }
    }

    fn attr(e: &AXUIElement, name: &str) -> Option<CFRetained<CFType>> {
        let mut value: *const CFType = std::ptr::null();
        let err = unsafe { e.copy_attribute_value(&CFString::from_str(name), NonNull::from(&mut value)) };
        if err != AXError::Success || value.is_null() {
            return None;
        }
        Some(unsafe { CFRetained::from_raw(NonNull::new_unchecked(value as *mut CFType)) })
    }

    fn string(e: &AXUIElement, name: &str) -> Option<String> {
        attr(e, name)?.downcast::<CFString>().ok().map(|s| s.to_string())
    }

    fn elements(e: &AXUIElement, name: &str) -> Vec<CFRetained<AXUIElement>> {
        let Some(v) = attr(e, name) else { return vec![] };
        let Ok(array) = v.downcast::<CFArray>() else { return vec![] };
        let array: CFRetained<CFArray<CFType>> = unsafe { CFRetained::cast_unchecked(array) };
        array.iter().filter_map(|x| x.downcast::<AXUIElement>().ok()).collect()
    }

    // The session open in Claude Desktop: the title of its page ("<session> - Claude Code"),
    // found breadth-first in the focused window. Electron builds this tree only once a client asks
    // for it (AXManualAccessibility). Needs the Accessibility permission.
    pub fn desktop_session_name(pid: i32) -> Option<String> {
        if !trusted() {
            return None;
        }
        let app = unsafe { AXUIElement::new_application(pid) };
        unsafe {
            app.set_attribute_value(&CFString::from_str("AXManualAccessibility"), CFBoolean::new(true).as_ref());
        }
        let window = attr(&app, "AXFocusedWindow")
            .and_then(|w| w.downcast::<AXUIElement>().ok())
            .or_else(|| elements(&app, "AXWindows").into_iter().next())?;
        let mut level = vec![window];
        for _ in 0..14 {
            let mut next = vec![];
            for e in &level {
                if string(e, "AXRole").as_deref() == Some("AXWebArea") {
                    if let Some(title) = string(e, "AXTitle") {
                        if let Some(name) = title.strip_suffix(super::DESKTOP_SUFFIX) {
                            return Some(name.to_string());
                        }
                    }
                }
                next.extend(elements(e, "AXChildren"));
            }
            if next.is_empty() || next.len() > 400 {
                break;
            }
            level = next;
        }
        None
    }

    fn osascript(script: &str) -> Option<String> {
        let out = Command::new("osascript").args(["-e", script]).output().ok()?;
        out.status.success().then(|| String::from_utf8_lossy(&out.stdout).trim().to_string())
    }

    // The processes in the tab Terminal or iTerm2 has selected, when one of them is in front
    pub fn terminal_tab_pids(app: &str) -> Option<Vec<u32>> {
        let script = match app {
            "Terminal" => "tell application \"Terminal\" to get tty of selected tab of front window",
            "iTerm2" | "iTerm" => "tell application \"iTerm2\" to get tty of current session of current window",
            _ => return None,
        };
        let tty = osascript(script)?;
        let tty = tty.strip_prefix("/dev/")?;
        let out = Command::new("ps").args(["-t", tty, "-o", "pid="]).output().ok()?;
        Some(String::from_utf8_lossy(&out.stdout).lines().filter_map(|l| l.trim().parse().ok()).collect())
    }

    // Selects the Terminal or iTerm2 tab a process runs in and brings it forward. Only asks an app
    // that's already open, since asking one that isn't would launch it.
    pub fn select_terminal_tab(pid: u32) -> bool {
        let Ok(out) = Command::new("ps").args(["-o", "tty=", "-p", &pid.to_string()]).output() else { return false };
        let tty = String::from_utf8_lossy(&out.stdout).trim().to_string();
        if tty.is_empty() || tty == "??" {
            return false;
        }
        let dev = format!("/dev/{tty}");
        let running = |name: &str| osascript(&format!("application \"{name}\" is running")).as_deref() == Some("true");
        if running("Terminal") {
            let script = format!(
                "tell application \"Terminal\"\nrepeat with w in windows\nrepeat with t in tabs of w\nif tty of t is \"{dev}\" then\nset selected of t to true\nset index of w to 1\nactivate\nreturn \"ok\"\nend if\nend repeat\nend repeat\nend tell"
            );
            if osascript(&script).as_deref() == Some("ok") {
                return true;
            }
        }
        if running("iTerm2") {
            let script = format!(
                "tell application \"iTerm2\"\nrepeat with w in windows\nrepeat with t in tabs of w\nrepeat with s in sessions of t\nif tty of s is \"{dev}\" then\nselect w\nselect t\nselect s\nactivate\nreturn \"ok\"\nend if\nend repeat\nend repeat\nend repeat\nend tell"
            );
            if osascript(&script).as_deref() == Some("ok") {
                return true;
            }
        }
        false
    }
}

// ---- Windows: bring a process's top-level window forward

#[cfg(windows)]
mod win {
    use windows::core::BOOL;
    use windows::Win32::Foundation::{HWND, LPARAM};
    use windows::Win32::UI::WindowsAndMessaging::{
        EnumWindows, GetWindowThreadProcessId, IsIconic, IsWindowVisible, SetForegroundWindow, ShowWindow, SW_RESTORE,
    };

    struct Search {
        pid: u32,
        found: Option<HWND>,
    }

    unsafe extern "system" fn each(hwnd: HWND, lparam: LPARAM) -> BOOL {
        let search = &mut *(lparam.0 as *mut Search);
        let mut pid = 0u32;
        GetWindowThreadProcessId(hwnd, Some(&mut pid));
        if pid == search.pid && IsWindowVisible(hwnd).as_bool() {
            search.found = Some(hwnd);
            return BOOL(0);
        }
        BOOL(1)
    }

    pub fn bring_forward(pid: u32) -> bool {
        let mut search = Search { pid, found: None };
        unsafe {
            let _ = EnumWindows(Some(each), LPARAM(&mut search as *mut Search as isize));
            let Some(hwnd) = search.found else { return false };
            if IsIconic(hwnd).as_bool() {
                let _ = ShowWindow(hwnd, SW_RESTORE);
            }
            SetForegroundWindow(hwnd).as_bool()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn snapshot_stamps_and_labels() {
        assert_eq!(snapshot_ms("zsh -c source /Users/x/.claude/shell-snapshots/snapshot-zsh-1791503599219-3ffs90.sh && npx playwright test"), Some(1791503599219));
        assert_eq!(snapshot_ms("bash /tmp/shell-snapshots/snapshot-bash-123-x.sh"), None);
        assert_eq!(snapshot_ms("vim notes.txt"), None);
        assert_eq!(job_label("npx playwright test --project=webkit"), "browser tests");
        assert_eq!(job_label("npm run dev"), "a local server");
        assert_eq!(job_label("cargo build --release"), "a build");
        assert_eq!(job_label("sleep 100"), "a command");
    }

    #[test]
    fn jobs_belong_to_the_session_that_started_last_before_the_snapshot() {
        let mut procs = HashMap::new();
        procs.insert(1, Proc { parent: None, name: "zsh".into(), exe: String::new(), cmd: "zsh -c source ~/.claude/shell-snapshots/snapshot-zsh-1000000000500-ab.sh && npm test".into(), minutes: 6 });
        let sessions = vec![("old".to_string(), 1000000000000), ("new".to_string(), 1000000000400), ("later".to_string(), 1000000000900)];
        let j = jobs(&procs, &sessions);
        assert_eq!(j["new"][0]["label"], "tests");
        assert_eq!(j["new"][0]["minutes"], 6);
        assert!(j.get("old").is_none() && j.get("later").is_none());
    }

    #[test]
    fn project_names_follow_git_and_worktrees() {
        let root = std::env::temp_dir().join(format!("sb-proj-{}", std::process::id()));
        let repo = root.join("web-app");
        fs::create_dir_all(repo.join(".git/worktrees/fix")).unwrap();
        fs::create_dir_all(repo.join("src/deep")).unwrap();
        let wt = root.join("wt-fix");
        fs::create_dir_all(&wt).unwrap();
        fs::write(wt.join(".git"), format!("gitdir: {}/.git/worktrees/fix\n", repo.display())).unwrap();
        assert_eq!(project_name(&repo.join("src/deep").to_string_lossy(), &root), "web-app");
        assert_eq!(project_name(&wt.to_string_lossy(), &root), "web-app");
        assert_eq!(project_name(&root.join("loose").to_string_lossy(), &root), "loose");
        let _ = fs::remove_dir_all(&root);
    }
}

// Session Board: one floating window that lists every Claude Code session on this Mac,
// with what each is working on (active) and what is waiting (pending).
//
// It reads two things the rest of the plugin keeps up to date:
//   ~/.claude/sessions/<pid>.json                    the live-session registry Claude Code writes
//   ~/.claude/plugins/store/session-board_*.json     each session's record, written by the mod
// so it works for terminal, Remote Control and Desktop sessions alike, and needs no server.
// It shares ~/Library/Application Support/session-board with the mod (see hooks/register.js).
//
// Build: ./build.sh [path/to/Session Board.app]
// Snapshot for checking the layout: SessionBoard --snapshot out.png [--settings]

import AppKit
import ApplicationServices
import Carbon.HIToolbox
import Combine
import SwiftUI
import UniformTypeIdentifiers
import CoreAudio
import AudioToolbox

let home = FileManager.default.homeDirectoryForCurrentUser.path
let registryDir = home + "/.claude/sessions"
let storeDir = home + "/.claude/plugins/store"
// The store files to read: one per install of the plugin (its id is name@marketplace)
var storePrefix = "session-board_"
// Settings, removed bullets, show requests and the highlight's status, shared with the mod
let appDir = home + "/Library/Application Support/session-board"
// An idle session left alone this long is quiet: off the board unless it's the one you're viewing
let quietSeconds: Double = 12 * 3600
// A record whose session left the registry is ignored after this, when the registry can't be read
let staleSeconds: Double = 10 * 60

struct Item: Hashable {
    let text: String
    let isActive: Bool
    let waitsOnYou: Bool
}

let waitsSuffix = " · waits on you"

struct Row: Identifiable {
    let id: String
    let pid: Int?
    let name: String
    let place: String
    let status: String // working, needs-you or idle
    let since: Double // seconds in that status
    let isRemote: Bool
    let isDesktop: Bool
    let hasMod: Bool
    // What the session last finished, in plain words (from its summary)
    let justDid: String
    // Background agents it started that haven't finished (from its conversation)
    let agentsRunning: Int
    // Workflows it started that are still running (their own agents aren't counted)
    let workflowsRunning: Int
    let items: [Item]
    // The last request typed: shown, as what you asked, when there are no items to show
    let request: String
    // What it asks you while it needs you: the permission prompt or the question
    let ask: String
    // A side task you raised mid-way, and the planned work it paused (violet on the card)
    let side: String
    let paused: String
    // The items come from the session's own task list (exact), not a summary
    let fromTaskList: Bool
    // The project it works in: the Git repo its folder belongs to, or the folder
    var project: String = ""
    // Its Remote Control session ("session_01…"), the claude.ai page Claude Desktop opens it by
    var bridgeId: String = ""
    // The descriptions Claude gave the commands it still runs, by command key (from the mod)
    var runningLabels: [String: String] = [:]
    // Names Claude Desktop may still show for it after a rename: the ones it had before (the
    // registry's formerNames) and the name without its project in front. Desktop keeps the name it
    // first had, so these let the highlight find a session renamed since.
    var otherNames: [String] = []
    // A cloud session, read from Claude Desktop's sidebar (cloudRows): a name, a project and a status only
    var isCloud = false
    // The task the session is on, in a line anyone could follow (the summary's), kept across summaries
    var task = ""
    // For a side session Claude Desktop started from another: that session's name
    var parent = ""

    // Idle for 12 hours; Board.isQuiet keeps the session you're viewing
    var isQuiet: Bool { status == "idle" && since > quietSeconds }
}

// A session's other names (Row.otherNames): its former names, and its name without the project
// the rename put in front ("OTC · Fix the login" is also "Fix the login")
func otherNames(name: String, project: String, former: [String]) -> [String] {
    var names = former
    let lead = project + " · "
    if !project.isEmpty, name.hasPrefix(lead) { names.append(String(name.dropFirst(lead.count))) }
    return names.filter { !$0.isEmpty && !sameName($0, name) }
}

func ago(_ seconds: Double) -> String {
    let m = Int(max(0, seconds) / 60)
    if m < 1 { return "now" }
    if m < 60 { return "\(m)m" }
    let h = m / 60
    return h < 48 ? "\(h)h" : "\(h / 24)d"
}

func baseName(_ path: String?) -> String {
    (path ?? "").split(separator: "/").last.map(String.init) ?? "?"
}

// Takes you to a session. In Claude Desktop, while it runs: a Remote Control session by its
// claude.ai page, one of Desktop's own by its id there (claude:// links Desktop itself uses for its
// "Continue" menu and Spotlight, checked 2026-10-11). Otherwise its tab in Terminal or iTerm2, or
// failing that, the app it runs in is brought forward.
func openSession(_ row: Row) {
    // You're going to it: its popup has done its job
    (NSApp.delegate as? AppDelegate)?.toasts.removeRow(row.id)
    if row.isCloud {
        if let id = cloudIds[plainName(row.name)], let url = URL(string: "claude://claude.ai/code/" + id) {
            NSWorkspace.shared.open(url)
        } else {
            // Its row, found again now: the sidebar redraws, and an element read earlier stops answering
            let name = row.name
            cloudQueue.async {
                let element = desktopSidebarRows()?.first { sameName($0.name, name) }?.element
                DispatchQueue.main.async {
                    NSRunningApplication.runningApplications(withBundleIdentifier: desktopBundle).first?.activate()
                    if let element { AXUIElementPerformAction(element, kAXPressAction as CFString) }
                }
            }
        }
        return
    }
    let desktopOpen = !NSRunningApplication.runningApplications(withBundleIdentifier: desktopBundle).isEmpty
    if desktopOpen, !row.bridgeId.isEmpty, let url = URL(string: "claude://claude.ai/code/" + row.bridgeId) {
        NSWorkspace.shared.open(url)
        return
    }
    let id = row.id, pid = row.pid, isDesktop = row.isDesktop
    DispatchQueue.global(qos: .userInitiated).async {
        if desktopOpen, isDesktop, let local = desktopLocalId(id),
           let url = URL(string: "claude://code/continue?session=" + local + "&source=session_board") {
            NSWorkspace.shared.open(url)
        } else if let pid {
            focusTerminal(pid: pid)
        }
    }
}

// Claude Desktop's own id ("local_…") for a session it runs, from its session files
func desktopLocalId(_ cliId: String) -> String? {
    let dir = NSHomeDirectory() + "/Library/Application Support/Claude/claude-code-sessions"
    guard let walker = FileManager.default.enumerator(atPath: dir) else { return nil }
    for case let path as String in walker where path.hasSuffix(".json") && (path as NSString).lastPathComponent.hasPrefix("local_") {
        if let d = readJSON(dir + "/" + path), d["cliSessionId"] as? String == cliId { return d["sessionId"] as? String }
    }
    return nil
}

// The terminal tab a session's process runs in, selected and brought forward; else the app above
// it (VS Code, Cursor, Ghostty…) is
func focusTerminal(pid: Int) {
    let ps = Process()
    ps.executableURL = URL(fileURLWithPath: "/bin/ps")
    ps.arguments = ["-o", "tty=", "-p", String(pid)]
    let out = Pipe()
    ps.standardOutput = out
    try? ps.run()
    ps.waitUntilExit()
    let tty = String(data: out.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    if !tty.isEmpty && tty != "??" {
        let dev = "/dev/" + tty
        let scripts = [
            ("com.apple.Terminal", """
             tell application "Terminal"
               repeat with w in windows
                 repeat with t in tabs of w
                   if tty of t is "\(dev)" then
                     set selected of t to true
                     set index of w to 1
                     activate
                     return "ok"
                   end if
                 end repeat
               end repeat
             end tell
             """),
            ("com.googlecode.iterm2", """
             tell application "iTerm2"
               repeat with w in windows
                 repeat with t in tabs of w
                   repeat with s in sessions of t
                     if tty of s is "\(dev)" then
                       select w
                       select t
                       select s
                       activate
                       return "ok"
                     end if
                   end repeat
                 end repeat
               end repeat
             end tell
             """),
        ]
        // Only apps already open: asking one that isn't would launch it
        for (bundle, source) in scripts where !NSRunningApplication.runningApplications(withBundleIdentifier: bundle).isEmpty {
            var error: NSDictionary?
            if NSAppleScript(source: source)?.executeAndReturnError(&error).stringValue == "ok" { return }
        }
    }
    // The nearest app above the process
    var current = pid_t(pid)
    for _ in 0..<12 {
        if let app = NSRunningApplication(processIdentifier: current), app.activationPolicy == .regular {
            DispatchQueue.main.async { app.activate() }
            return
        }
        var info = kinfo_proc()
        var size = MemoryLayout<kinfo_proc>.stride
        var mib: [Int32] = [CTL_KERN, KERN_PROC, KERN_PROC_PID, current]
        guard sysctl(&mib, 4, &info, &size, nil, 0) == 0, info.kp_eproc.e_ppid > 1 else { return }
        current = info.kp_eproc.e_ppid
    }
}

// The project a folder belongs to: the Git repo it is in (a worktree counts as its main repo,
// Claude Desktop's .claude/worktrees ones too), or else the folder itself. Looked up once per folder.
private var projectCache: [String: String] = [:]
func projectName(_ cwd: String?) -> String {
    guard let cwd, !cwd.isEmpty else { return "" }
    if let known = projectCache[cwd] { return known }
    var root = cwd
    if let r = cwd.range(of: "/.claude/worktrees/") { root = String(cwd[..<r.lowerBound]) }
    let home = NSHomeDirectory()
    var dir = root
    while dir.hasPrefix(home + "/") {
        let git = dir + "/.git"
        var isDir: ObjCBool = false
        if FileManager.default.fileExists(atPath: git, isDirectory: &isDir) {
            root = dir
            // A worktree's .git is a file: "gitdir: <main repo>/.git/worktrees/<name>"
            if !isDir.boolValue, let text = try? String(contentsOfFile: git, encoding: .utf8),
               let line = text.split(separator: "\n").first(where: { $0.hasPrefix("gitdir:") }),
               let r = line.range(of: "/.git/worktrees/") {
                root = String(line[line.index(line.startIndex, offsetBy: 7)..<r.lowerBound]).trimmingCharacters(in: .whitespaces)
            }
            break
        }
        dir = (dir as NSString).deletingLastPathComponent
    }
    let name = baseName(root)
    projectCache[cwd] = name
    return name
}

func readJSON(_ path: String) -> [String: Any]? {
    guard let data = FileManager.default.contents(atPath: path) else { return nil }
    return (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
}

func number(_ value: Any?) -> Double? { (value as? NSNumber)?.doubleValue }

func strings(_ value: Any?) -> [String] {
    ((value as? [Any]) ?? []).compactMap { $0 as? String }.filter { !$0.trimmingCharacters(in: .whitespaces).isEmpty }
}

let desktopBundle = "com.anthropic.claudefordesktop"
// Terminals and code editors Claude Code runs in. With "count as Claude" on, the window stays
// up while one of them is in front.
let terminalBundles: Set<String> = [
    "com.apple.Terminal", "com.googlecode.iterm2", "com.mitchellh.ghostty", "dev.warp.Warp-Stable",
    "com.github.wez.wezterm", "net.kovidgoyal.kitty", "org.alacritty", "com.microsoft.VSCode",
    "com.todesktop.230313mzl4w4u92", "dev.zed.Zed",
]

func axAttr(_ e: AXUIElement, _ name: String) -> AnyObject? {
    var value: AnyObject?
    return AXUIElementCopyAttributeValue(e, name as CFString, &value) == .success ? value : nil
}

// The page element whose title names the open session, once found: reading its title again
// takes under a millisecond, where finding it takes about 40. Used on the focus queue only.
var cachedSessionPage: AXUIElement?

// Needs the Accessibility permission. Electron builds its accessibility tree only once a
// client asks for it (AXManualAccessibility); the page's title then names the open session.
// Two session names are the same one: case, spacing and curly or straight quotes aside
func sameName(_ a: String, _ b: String) -> Bool { plainName(a) == plainName(b) }

func plainName(_ s: String) -> String {
    s.replacingOccurrences(of: "\u{2019}", with: "'").replacingOccurrences(of: "\u{2018}", with: "'")
        .replacingOccurrences(of: "\u{201C}", with: "\"").replacingOccurrences(of: "\u{201D}", with: "\"")
        .lowercased().split(whereSeparator: \.isWhitespace).joined(separator: " ")
}

// The names the front Desktop window gives its chat: the session page's title (it ends in
// " - Claude Code"), or, when no page is titled that way (a window laid out another way), every
// titled page in the window, for the caller to match against the sessions it knows
func desktopOpenSessionNames() -> [String] {
    guard AXIsProcessTrusted(),
          let app = NSRunningApplication.runningApplications(withBundleIdentifier: desktopBundle).first
    else { return [] }
    let ax = AXUIElementCreateApplication(app.processIdentifier)
    AXUIElementSetAttributeValue(ax, "AXManualAccessibility" as CFString, kCFBooleanTrue)
    guard let window = (axAttr(ax, kAXFocusedWindowAttribute) as! AXUIElement?)
            ?? (axAttr(ax, kAXWindowsAttribute) as? [AXUIElement])?.first
    else { return [] }
    let suffix = " - Claude Code"
    // The page found last time, while it's still in the window in front and still names a session
    if let page = cachedSessionPage, let pageWindow = axAttr(page, kAXWindowAttribute), CFEqual(pageWindow, window),
       let title = axAttr(page, kAXTitleAttribute) as? String, title.hasSuffix(suffix) {
        noteCloudId(page: page, name: String(title.dropLast(suffix.count)))
        return [String(title.dropLast(suffix.count))]
    }
    cachedSessionPage = nil
    var others: [String] = []
    // The page sits about eight levels down, inside two outer web areas with blank titles;
    // look breadth-first, and not far
    var level = [window]
    for _ in 0..<14 {
        var next: [AXUIElement] = []
        for e in level {
            if (axAttr(e, kAXRoleAttribute) as? String) == "AXWebArea", let title = axAttr(e, kAXTitleAttribute) as? String {
                if title.hasSuffix(suffix) {
                    cachedSessionPage = e
                    noteCloudId(page: e, name: String(title.dropLast(suffix.count)))
                    return [String(title.dropLast(suffix.count))]
                }
                if !title.trimmingCharacters(in: .whitespaces).isEmpty { others.append(title) }
            }
            next += (axAttr(e, kAXChildrenAttribute) as? [AXUIElement]) ?? []
        }
        if next.isEmpty || next.count > 400 { break }
        level = next
    }
    // A window of its own may be titled after its chat
    if let title = axAttr(window, kAXTitleAttribute) as? String, !title.trimmingCharacters(in: .whitespaces).isEmpty { others.append(title) }
    return others
}

// ---- Cloud sessions
// They run on Anthropic's machines and leave nothing on this Mac, and no `claude` command lists
// them (checked 2026-10-17). Claude Desktop's sidebar shows them, so the board reads it, with the
// Accessibility permission the highlight already has. A sidebar row gives its name, the group it's
// in and a status word ("Running"). Nothing on the row says "cloud", but a group of cloud sessions
// has a cloud badge on its heading (and Desktop has a Cloud section): a row there is a cloud
// session unless it's one this Mac knows (one of Desktop's own, or one on the board). Only rows the
// sidebar shows are found: none in a collapsed group or behind "Show more", and none while
// Desktop's window is closed or on another Space (the last ones read stay until Desktop quits).

struct SidebarRow {
    let name: String
    let group: String
    // The badge on its group's heading: "Cloud" for a group of cloud sessions, "Remote Control" for one of those
    let badge: String
    let state: String
    // The row's own element, for opening it: Desktop opens a row it's asked to press. Read it fresh:
    // one kept from an earlier read stops answering once the sidebar redraws
    let element: AXUIElement
}

// The sidebar element, once found (finding it walks most of the window). Used on the cloud queue only.
var cachedSidebar: AXUIElement?

// The session rows in Desktop's sidebar while it shows Code sessions, or nil when it can't be
// read (no permission, no window, Chat mode), so the caller keeps what it had
func desktopSidebarRows() -> [SidebarRow]? {
    guard AXIsProcessTrusted(),
          let app = NSRunningApplication.runningApplications(withBundleIdentifier: desktopBundle).first
    else { return nil }
    let ax = AXUIElementCreateApplication(app.processIdentifier)
    AXUIElementSetMessagingTimeout(ax, 0.5)
    AXUIElementSetAttributeValue(ax, "AXManualAccessibility" as CFString, kCFBooleanTrue)
    func isSidebar(_ e: AXUIElement) -> Bool {
        (axAttr(e, kAXSubroleAttribute) as? String) == "AXLandmarkComplementary" && (axAttr(e, kAXDescriptionAttribute) as? String) == "Sidebar"
    }
    if let s = cachedSidebar, axAttr(s, kAXRoleAttribute) == nil || !isSidebar(s) { cachedSidebar = nil }
    if cachedSidebar == nil {
        // A full-screen window, or one on another Space, is missing from AXWindows but is still the
        // focused or main window
        var windows = (axAttr(ax, kAXWindowsAttribute) as? [AXUIElement]) ?? []
        for name in [kAXFocusedWindowAttribute, kAXMainWindowAttribute] where windows.isEmpty {
            if let w = axAttr(ax, name), CFGetTypeID(w) == AXUIElementGetTypeID() { windows = [w as! AXUIElement] }
        }
        guard !windows.isEmpty else { return nil }
        var level = windows
        search: for _ in 0..<16 {
            var next: [AXUIElement] = []
            for e in level {
                if isSidebar(e) { cachedSidebar = e; break search }
                next += (axAttr(e, kAXChildrenAttribute) as? [AXUIElement]) ?? []
            }
            if next.isEmpty || next.count > 2000 { break }
            level = next
        }
    }
    guard let sidebar = cachedSidebar else { return nil }
    var rows: [SidebarRow] = []
    var group = "", badge = ""
    var codeMode: Bool?
    // The status a row announces to screen readers ("Running"), from the element around the row
    func state(_ e: AXUIElement, _ depth: Int = 0) -> String {
        if (axAttr(e, kAXSubroleAttribute) as? String) == "AXApplicationStatus" {
            let texts = ((axAttr(e, kAXChildrenAttribute) as? [AXUIElement]) ?? []).compactMap { axAttr($0, kAXValueAttribute) as? String }
            return texts.joined(separator: " ").trimmingCharacters(in: .whitespaces)
        }
        if depth > 4 { return "" }
        for c in (axAttr(e, kAXChildrenAttribute) as? [AXUIElement]) ?? [] {
            let s = state(c, depth + 1)
            if !s.isEmpty { return s }
        }
        return ""
    }
    // In document order: a group's heading comes before its rows
    func walk(_ e: AXUIElement, _ depth: Int) {
        if depth > 30 { return }
        let role = axAttr(e, kAXRoleAttribute) as? String ?? ""
        let desc = axAttr(e, kAXDescriptionAttribute) as? String ?? ""
        if role == "AXRadioButton", desc == "Code" { codeMode = (axAttr(e, kAXValueAttribute) as? NSNumber)?.boolValue ?? false }
        if role == "AXImage", desc == "Cloud" || desc == "Remote Control" { badge = desc }
        // Each session row has a "More options for <name>" menu next to it
        if role == "AXPopUpButton", desc.hasPrefix("More options for "),
           let holder = axAttr(e, kAXParentAttribute).flatMap({ axAttr($0 as! AXUIElement, kAXParentAttribute) }) {
            let around = holder as! AXUIElement
            let name = String(desc.dropFirst("More options for ".count))
            let button = ((axAttr(around, kAXChildrenAttribute) as? [AXUIElement]) ?? [])
                .first { (axAttr($0, kAXRoleAttribute) as? String) == "AXButton" } ?? around
            rows.append(SidebarRow(name: name, group: group, badge: badge, state: state(around), element: button))
            return
        }
        // A group's heading: its name, then its "Group and sort" menu (and a badge, read above)
        var heading = ""
        for c in (axAttr(e, kAXChildrenAttribute) as? [AXUIElement]) ?? [] {
            let role = axAttr(c, kAXRoleAttribute) as? String
            if role == "AXPopUpButton", (axAttr(c, kAXDescriptionAttribute) as? String) == "Group and sort", !heading.isEmpty {
                group = heading
                badge = ""
            }
            heading = role == "AXButton" ? (axAttr(c, kAXTitleAttribute) as? String ?? "") : ""
            walk(c, depth + 1)
        }
    }
    walk(sidebar, 0)
    return codeMode == true ? rows : nil
}

// What a cloud session is doing, read from its chat while Desktop shows it: your last request, what
// it's doing now and what it last did. A finished reply is labelled for screen readers with its
// first sentence ("Claude responded: …"), which is what it did. A reply still streaming has no
// label: its latest narration is what it's doing, and its last named step is what it did. Desktop
// keeps only the latest messages on the page, so a request scrolled away is kept from an earlier read.
struct ChatGist: Equatable {
    var request = ""
    var now = ""
    var did = ""
}

// The first sentence of a paragraph, for a card line
func firstSentence(_ text: String) -> String {
    let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
    if let r = t.range(of: #"[.!?:](\s|$)"#, options: .regularExpression) { return String(t[..<r.lowerBound]) }
    return t
}

// The cloud or Remote Control chat Desktop shows (its page is claude.ai/…/session_…), by name,
// with its gist; nil when it shows something else. On the cloud queue.
struct ChatExchange: Equatable {
    var ask: String
    var reply: String
}
func desktopOpenChat() -> (name: String, id: String, gist: ChatGist, exchanges: [ChatExchange])? {
    guard AXIsProcessTrusted(),
          let app = NSRunningApplication.runningApplications(withBundleIdentifier: desktopBundle).first
    else { return nil }
    let ax = AXUIElementCreateApplication(app.processIdentifier)
    AXUIElementSetMessagingTimeout(ax, 0.5)
    guard let window = (axAttr(ax, kAXFocusedWindowAttribute) as! AXUIElement?) ?? (axAttr(ax, kAXWindowsAttribute) as? [AXUIElement])?.first
    else { return nil }
    let suffix = " - Claude Code"
    var page: AXUIElement?
    var level = [window]
    search: for _ in 0..<14 {
        var next: [AXUIElement] = []
        for e in level {
            if (axAttr(e, kAXRoleAttribute) as? String) == "AXWebArea", let t = axAttr(e, kAXTitleAttribute) as? String, t.hasSuffix(suffix) {
                page = e
                break search
            }
            next += (axAttr(e, kAXChildrenAttribute) as? [AXUIElement]) ?? []
        }
        if next.isEmpty || next.count > 400 { break }
        level = next
    }
    guard let page, let title = axAttr(page, kAXTitleAttribute) as? String,
          let id = (axAttr(page, kAXURLAttribute) as? URL)?.lastPathComponent, id.hasPrefix("session_") || id.hasPrefix("cse_")
    else { return nil }
    // The messages, in reading order. A long reply still streaming is an article holding its top;
    // the rest of it comes after a "Load the rest of this message" marker, outside the article. So
    // each line belongs to the last message before it.
    struct Message {
        var heading = ""
        var streaming = false
        // The last named step (a group described by its own words; a group of tool calls is
        // described by a folder path instead) and the last paragraph of prose
        var step = ""
        var prose = ""
        // Everything it says, in order, for the summary (a step's own output is left out)
        var lines: [String] = []
    }
    var messages: [Message] = []
    func walk(_ e: AXUIElement, _ depth: Int) {
        if depth > 40 { return }
        let role = axAttr(e, kAXRoleAttribute) as? String ?? ""
        let desc = axAttr(e, kAXDescriptionAttribute) as? String ?? ""
        if (axAttr(e, kAXSubroleAttribute) as? String) == "AXDocumentArticle" {
            messages.append(Message(streaming: desc == "Currently streaming message"))
        } else if !messages.isEmpty {
            let i = messages.count - 1
            if role == "AXHeading", messages[i].heading.isEmpty, let t = axAttr(e, kAXTitleAttribute) as? String { messages[i].heading = t }
            // (one word is the spinner on the step under way: "Creating")
            if role == "AXGroup", desc.contains(" "), !desc.hasPrefix("/"), !desc.hasPrefix("~"), !desc.contains("\\") {
                messages[i].step = desc
                return
            }
            if role == "AXStaticText", let v = axAttr(e, kAXValueAttribute) as? String,
               !v.hasPrefix("You said: "), !v.hasPrefix("Claude responded: "), !v.trimmingCharacters(in: .whitespaces).isEmpty {
                messages[i].lines.append(v)
            }
            if role == "AXStaticText", let v = axAttr(e, kAXValueAttribute) as? String, v.count >= 30,
               let first = v.first, first.isUppercase, !v.hasPrefix("Ran "), !v.hasPrefix("Read "),
               !v.hasPrefix("You said: "), !v.hasPrefix("Claude responded: ") {
                messages[i].prose = v
            }
        }
        for c in (axAttr(e, kAXChildrenAttribute) as? [AXUIElement]) ?? [] { walk(c, depth + 1) }
    }
    func find(_ e: AXUIElement, _ depth: Int) -> AXUIElement? {
        if depth > 40 { return nil }
        if (axAttr(e, kAXSubroleAttribute) as? String) == "AXApplicationGroup", (axAttr(e, kAXDescriptionAttribute) as? String) == "Chat messages" { return e }
        for c in (axAttr(e, kAXChildrenAttribute) as? [AXUIElement]) ?? [] { if let f = find(c, depth + 1) { return f } }
        return nil
    }
    if let chat = find(page, 0) { walk(chat, 0) }
    var gist = ChatGist()
    var replied = false
    for m in messages.reversed() {
        if m.heading.hasPrefix("You said: ") {
            gist.request = String(m.heading.dropFirst("You said: ".count))
            break
        }
        if replied { continue }
        replied = true
        // A reply still streaming may be labelled too, but with the first sentence of a turn that
        // has gone on since: its latest lines say more
        if m.streaming {
            gist.now = firstSentence(m.prose)
            gist.did = m.step
        }
        if gist.now.isEmpty && gist.did.isEmpty && m.heading.hasPrefix("Claude responded: ") {
            gist.did = String(m.heading.dropFirst("Claude responded: ".count))
        }
    }
    // The exchanges on the page: each request and what was said after it, cut to what a summary reads
    var exchanges: [ChatExchange] = []
    for m in messages {
        if m.heading.hasPrefix("You said: ") {
            exchanges.append(ChatExchange(ask: String(m.heading.dropFirst("You said: ".count)), reply: ""))
        } else if !exchanges.isEmpty {
            let i = exchanges.count - 1
            exchanges[i].reply += (exchanges[i].reply.isEmpty ? "" : "\n") + m.lines.joined(separator: "\n")
        }
    }
    exchanges = exchanges.suffix(5).map { x in
        var x = x
        if x.reply.count > 20000 { x.reply = String(x.reply.prefix(8000)) + "\n…\n" + String(x.reply.suffix(12000)) }
        return x
    }
    return (String(title.dropLast(suffix.count)), id, gist, exchanges)
}

// What a sidebar status word means on the board. Desktop's words aren't documented: "Running"
// is the one seen (2026-10-17); one that asks for you counts as needing you; anything else is idle.
func cloudStatus(_ state: String) -> String {
    let s = state.lowercased()
    if ["input", "approv", "permission", "waiting", "needs", "question"].contains(where: { s.contains($0) }) { return "needs-you" }
    if ["running", "working", "thinking", "busy"].contains(where: { s.contains($0) }) { return "working" }
    return "idle"
}

// Desktop's own sessions (its Local ones), from the files it keeps for them: the title its sidebar
// shows, its former titles, and for a side session the session it was started from (Desktop's id).
// By Desktop's id ("local_…") and by Claude Code's. Read at most every 30 seconds.
struct DesktopSession {
    let id: String
    let title: String
    let previousTitles: [String]
    let parent: String
}
var desktopSessionCache: (at: Date, all: [String: DesktopSession]) = (.distantPast, [:])
func desktopSessions() -> [String: DesktopSession] {
    if Date().timeIntervalSince(desktopSessionCache.at) < 30 { return desktopSessionCache.all }
    let root = NSHomeDirectory() + "/Library/Application Support/Claude/claude-code-sessions"
    var all: [String: DesktopSession] = [:]
    let fm = FileManager.default
    for account in (try? fm.contentsOfDirectory(atPath: root)) ?? [] {
        for org in (try? fm.contentsOfDirectory(atPath: root + "/" + account)) ?? [] {
            let dir = root + "/" + account + "/" + org
            for file in (try? fm.contentsOfDirectory(atPath: dir)) ?? [] where file.hasPrefix("local_") && file.hasSuffix(".json") {
                guard let d = readJSON(dir + "/" + file), let id = d["sessionId"] as? String else { continue }
                let session = DesktopSession(id: id, title: (d["title"] as? String) ?? "", previousTitles: strings(d["previousTitles"]),
                                             parent: ((d["spawnedFrom"] as? [String: Any])?["sessionId"] as? String) ?? "")
                all[id] = session
                if let cli = d["cliSessionId"] as? String, !cli.isEmpty { all[cli] = session }
            }
        }
    }
    desktopSessionCache = (Date(), all)
    return all
}

// The names of Desktop's own sessions: a sidebar row with one of these names isn't a cloud session
func localDesktopNames() -> Set<String> {
    var names = Set<String>()
    for session in desktopSessions().values {
        if !session.title.isEmpty { names.insert(plainName(session.title)) }
        for t in session.previousTitles { names.insert(plainName(t)) }
    }
    return names
}

// A cloud session's id, by name, from the page Desktop shows it in (claude.ai/…/session_…): with
// it, the card opens the session by its link rather than by pressing its sidebar row
var cloudIds: [String: String] = [:]
// Reading the sidebar takes a few hundred milliseconds: on a queue of its own, so the highlight doesn't wait
let cloudQueue = DispatchQueue(label: "cloud")
func noteCloudId(page: AXUIElement, name: String) {
    guard let url = axAttr(page, kAXURLAttribute) as? URL else { return }
    let id = url.lastPathComponent
    guard id.hasPrefix("session_") || id.hasPrefix("cse_") else { return }
    DispatchQueue.main.async { cloudIds[plainName(name)] = id }
}

// The shortcut that shows or hides the window from any app: a key and its modifiers, the way
// Carbon's hot keys take them, and the key's label
struct Shortcut: Equatable {
    var keyCode: UInt32
    var mods: UInt32
    var key: String

    static let standard = Shortcut(keyCode: UInt32(kVK_ANSI_S), mods: UInt32(controlKey | optionKey), key: "S")

    // ⌃⌥⇧⌘ in the order macOS writes them, then the key
    var display: String { modifierSymbols(mods) + key }

    // F1 to F20 (their key codes aren't in order)
    var isFunctionKey: Bool { specialKeyLabels[Int(keyCode)]?.hasPrefix("F") == true }

    // A right-hand ⌥, ⌘ or ⌃ tapped on its own (mods is 0)
    var isModifierTap: Bool { mods == 0 && modifierTaps[Int(keyCode)] != nil }

    static func load() -> Shortcut {
        let d = UserDefaults.standard
        guard let key = d.string(forKey: "shortcutKey"), d.object(forKey: "shortcutKeyCode") != nil else { return .standard }
        return Shortcut(keyCode: UInt32(d.integer(forKey: "shortcutKeyCode")), mods: UInt32(d.integer(forKey: "shortcutMods")), key: key)
    }

    func save() {
        let d = UserDefaults.standard
        d.set(Int(keyCode), forKey: "shortcutKeyCode")
        d.set(Int(mods), forKey: "shortcutMods")
        d.set(key, forKey: "shortcutKey")
    }
}

extension Shortcut {
    // A key pressed while recording
    init(event: NSEvent) {
        let label = specialKeyLabels[Int(event.keyCode)] ?? (event.characters(byApplyingModifiers: [])?.uppercased() ?? "?")
        self.init(keyCode: UInt32(event.keyCode), mods: carbonModifiers(event.modifierFlags), key: label)
    }
}

let shortcutModifierMask = UInt32(cmdKey | shiftKey | optionKey | controlKey)

// The modifiers that work as a shortcut tapped on their own: the right-hand ones, which typing
// rarely uses alone. Each with its label, its own bit in the event's flags (so the left one
// held doesn't count) and the modifier it is.
let modifierTaps: [Int: (label: String, deviceBit: UInt, flag: NSEvent.ModifierFlags)] = [
    kVK_RightOption: ("Right ⌥", 0x40, .option),
    kVK_RightCommand: ("Right ⌘", 0x10, .command),
    kVK_RightControl: ("Right ⌃", 0x2000, .control),
]

// Follows one modifier key's taps: pressed with no other modifier, then let go within half a
// second with no key, click or other modifier in between. Returns true on the release that ends a tap.
struct TapWatch {
    var down: (code: Int, at: TimeInterval)?

    mutating func feed(_ event: NSEvent, code: Int) -> Bool {
        guard event.type == .flagsChanged, Int(event.keyCode) == code, let tap = modifierTaps[code] else {
            down = nil
            return false
        }
        if event.modifierFlags.rawValue & tap.deviceBit != 0 {
            down = carbonModifiers(event.modifierFlags) == carbonModifiers(tap.flag) ? (code, event.timestamp) : nil
            return false
        }
        defer { down = nil }
        guard let down, down.code == code else { return false }
        return event.timestamp - down.at < 0.5
    }
}

func carbonModifiers(_ flags: NSEvent.ModifierFlags) -> UInt32 {
    var m: UInt32 = 0
    if flags.contains(.command) { m |= UInt32(cmdKey) }
    if flags.contains(.option) { m |= UInt32(optionKey) }
    if flags.contains(.control) { m |= UInt32(controlKey) }
    if flags.contains(.shift) { m |= UInt32(shiftKey) }
    return m
}

func modifierSymbols(_ mods: UInt32) -> String {
    (mods & UInt32(controlKey) != 0 ? "⌃" : "") + (mods & UInt32(optionKey) != 0 ? "⌥" : "")
        + (mods & UInt32(shiftKey) != 0 ? "⇧" : "") + (mods & UInt32(cmdKey) != 0 ? "⌘" : "")
}

let specialKeyLabels: [Int: String] = {
    var labels: [Int: String] = [
        kVK_Space: "Space", kVK_Return: "↩", kVK_Tab: "⇥", kVK_Delete: "⌫", kVK_ForwardDelete: "⌦", kVK_Escape: "⎋",
        kVK_LeftArrow: "←", kVK_RightArrow: "→", kVK_UpArrow: "↑", kVK_DownArrow: "↓",
        kVK_Home: "↖", kVK_End: "↘", kVK_PageUp: "⇞", kVK_PageDown: "⇟",
    ]
    let fKeys = [kVK_F1, kVK_F2, kVK_F3, kVK_F4, kVK_F5, kVK_F6, kVK_F7, kVK_F8, kVK_F9, kVK_F10,
                 kVK_F11, kVK_F12, kVK_F13, kVK_F14, kVK_F15, kVK_F16, kVK_F17, kVK_F18, kVK_F19, kVK_F20]
    for (i, code) in fKeys.enumerated() { labels[code] = "F\(i + 1)" }
    return labels
}()

// macOS's own shortcuts, by the id System Settings keeps them under
let macOSShortcutNames: [Int: String] = [
    7: "Move focus to the menu bar", 8: "Move focus to the Dock", 9: "Move focus to the active window",
    10: "Move focus to the window toolbar", 11: "Move focus to the floating window", 12: "Turn keyboard access on or off",
    13: "Change the way Tab moves focus", 15: "Turn zoom on or off", 17: "Zoom in", 19: "Zoom out", 21: "Invert colors",
    27: "Move focus to the next window", 28: "Save a picture of the screen", 29: "Copy a picture of the screen",
    30: "Save a picture of a selected area", 31: "Copy a picture of a selected area", 32: "Mission Control",
    33: "Application windows", 36: "Show Desktop", 52: "Turn Dock hiding on or off", 57: "Move focus to the status menus",
    59: "Turn VoiceOver on or off", 60: "Select the previous input source", 61: "Select the next input source",
    64: "Show Spotlight search", 65: "Show Finder search window", 79: "Move left a space", 80: "Move left a space",
    81: "Move right a space", 82: "Move right a space", 118: "Switch to Desktop 1", 119: "Switch to Desktop 2",
    120: "Switch to Desktop 3", 121: "Switch to Desktop 4", 160: "Show Launchpad", 162: "Show Accessibility controls",
    163: "Show Notification Center", 175: "Turn Do Not Disturb on or off", 184: "Screenshot and recording options",
    190: "Quick Note", 222: "Turn Stage Manager on or off",
]

// The keys of the common ones as macOS ships them: System Settings records only the ones you change
let macOSDefaultShortcuts: [(id: Int, keyCode: Int, mods: Int)] = [
    (64, kVK_Space, cmdKey), (65, kVK_Space, cmdKey | optionKey), (60, kVK_Space, controlKey),
    (61, kVK_Space, controlKey | optionKey), (28, kVK_ANSI_3, cmdKey | shiftKey), (29, kVK_ANSI_3, cmdKey | shiftKey | controlKey),
    (30, kVK_ANSI_4, cmdKey | shiftKey), (31, kVK_ANSI_4, cmdKey | shiftKey | controlKey), (184, kVK_ANSI_5, cmdKey | shiftKey),
    (32, kVK_UpArrow, controlKey), (33, kVK_DownArrow, controlKey), (79, kVK_LeftArrow, controlKey),
    (81, kVK_RightArrow, controlKey), (27, kVK_ANSI_Grave, cmdKey), (52, kVK_ANSI_D, cmdKey | optionKey),
    (36, kVK_F11, 0), (118, kVK_ANSI_1, controlKey), (119, kVK_ANSI_2, controlKey), (7, kVK_F2, controlKey),
    (8, kVK_F3, controlKey), (59, kVK_F5, cmdKey),
]

// Shortcuts nearly every Mac app has, for when the apps' menus can't be read
let commonAppShortcuts: [(keyCode: Int, mods: Int, name: String)] = [
    (kVK_ANSI_Q, cmdKey, "Quit"), (kVK_ANSI_W, cmdKey, "Close"), (kVK_ANSI_H, cmdKey, "Hide"), (kVK_ANSI_M, cmdKey, "Minimize"),
    (kVK_ANSI_C, cmdKey, "Copy"), (kVK_ANSI_V, cmdKey, "Paste"), (kVK_ANSI_X, cmdKey, "Cut"), (kVK_ANSI_Z, cmdKey, "Undo"),
    (kVK_ANSI_Z, cmdKey | shiftKey, "Redo"), (kVK_ANSI_A, cmdKey, "Select All"), (kVK_ANSI_S, cmdKey, "Save"),
    (kVK_ANSI_N, cmdKey, "New"), (kVK_ANSI_T, cmdKey, "New Tab"), (kVK_ANSI_F, cmdKey, "Find"), (kVK_ANSI_P, cmdKey, "Print"),
    (kVK_ANSI_O, cmdKey, "Open"), (kVK_ANSI_Comma, cmdKey, "Settings"), (kVK_Tab, cmdKey, "the app switcher"),
    (kVK_ANSI_Q, cmdKey | controlKey, "Lock Screen"), (kVK_ANSI_F, cmdKey | controlKey, "Full Screen"),
    (kVK_Escape, cmdKey | optionKey, "Force Quit"), (kVK_ANSI_Q, cmdKey | shiftKey, "Log Out"),
]

// The macOS shortcut this one is, if that shortcut is on: its name, or "" when its name isn't known
func macOSShortcutClash(_ s: Shortcut) -> String? {
    var list: Unmanaged<CFArray>?
    guard CopySymbolicHotKeys(&list) == noErr, let items = list?.takeRetainedValue() as? [[String: Any]] else { return nil }
    let isOn = items.contains { item in
        (item[kHISymbolicHotKeyEnabled as String] as? Bool) == true
            && (item[kHISymbolicHotKeyCode as String] as? NSNumber)?.uint32Value == s.keyCode
            && ((item[kHISymbolicHotKeyModifiers as String] as? NSNumber)?.uint32Value ?? 0) & shortcutModifierMask == s.mods
    }
    guard isOn else { return nil }
    // Its name: from the shortcuts you changed in System Settings, else from macOS's defaults
    if let changed = UserDefaults(suiteName: "com.apple.symbolichotkeys")?.dictionary(forKey: "AppleSymbolicHotKeys") {
        for (id, value) in changed {
            guard let entry = value as? [String: Any], (entry["enabled"] as? Bool) == true,
                  let p = (entry["value"] as? [String: Any])?["parameters"] as? [Int], p.count == 3,
                  UInt32(p[1]) == s.keyCode, carbonModifiers(NSEvent.ModifierFlags(rawValue: UInt(p[2]))) == s.mods,
                  let name = macOSShortcutNames[Int(id) ?? -1] else { continue }
            return name
        }
    }
    let known = macOSDefaultShortcuts.first { UInt32($0.keyCode) == s.keyCode && UInt32($0.mods) == s.mods }
    return known.flatMap { macOSShortcutNames[$0.id] } ?? ""
}

// Where this shortcut is a menu item in Claude Desktop or an open terminal or editor, read
// through Accessibility: "“New Session” in Claude"
func appMenuClashes(_ s: Shortcut) -> [String] {
    guard AXIsProcessTrusted() else { return [] }
    let apps = NSWorkspace.shared.runningApplications.filter {
        let id = $0.bundleIdentifier ?? ""
        return id == desktopBundle || terminalBundles.contains(id)
    }
    var found: [String] = []
    for app in apps {
        let ax = AXUIElementCreateApplication(app.processIdentifier)
        AXUIElementSetMessagingTimeout(ax, 0.5)
        guard let bar = axAttr(ax, kAXMenuBarAttribute), CFGetTypeID(bar) == AXUIElementGetTypeID() else { continue }
        var visited = 0
        func walk(_ e: AXUIElement, _ depth: Int) {
            visited += 1
            if depth > 6 || visited > 3000 { return }
            if menuItem(e, is: s), let title = axAttr(e, kAXTitleAttribute) as? String, !title.isEmpty {
                let clash = "“\(title)” in \(app.localizedName ?? "an open app")"
                if !found.contains(clash) { found.append(clash) }
                return
            }
            for child in (axAttr(e, kAXChildrenAttribute) as? [AXUIElement]) ?? [] { walk(child, depth + 1) }
        }
        // The Apple menu, first, is macOS's own: the common list names those
        for menu in ((axAttr(bar as! AXUIElement, kAXChildrenAttribute) as? [AXUIElement]) ?? []).dropFirst() { walk(menu, 1) }
    }
    return found
}

func menuItem(_ e: AXUIElement, is s: Shortcut) -> Bool {
    let axMods = (axAttr(e, kAXMenuItemCmdModifiersAttribute) as? Int) ?? 0
    // Accessibility's menu modifiers: 1 shift, 2 option, 4 control, 8 no command
    var m: UInt32 = axMods & 8 == 0 ? UInt32(cmdKey) : 0
    if axMods & 1 != 0 { m |= UInt32(shiftKey) }
    if axMods & 2 != 0 { m |= UInt32(optionKey) }
    if axMods & 4 != 0 { m |= UInt32(controlKey) }
    guard m == s.mods else { return false }
    if let vk = axAttr(e, kAXMenuItemCmdVirtualKeyAttribute) as? Int { return UInt32(vk) == s.keyCode }
    guard let ch = axAttr(e, kAXMenuItemCmdCharAttribute) as? String, !ch.isEmpty else { return false }
    return ch.uppercased() == s.key.uppercased()
}

// Why a shortcut can't be used at all, if it can't
func shortcutProblem(_ s: Shortcut) -> String? {
    if s.mods & UInt32(cmdKey | optionKey | controlKey) == 0 && !s.isFunctionKey && !s.isModifierTap {
        return "Add ⌘, ⌃ or ⌥: without one, \(s.display) would stop working as a key everywhere."
    }
    return nil
}

// What a shortcut clashes with: macOS's shortcuts, the menus of Claude and the open terminals
// and editors, and the shortcuts most apps share. Other apps' own global shortcuts can't be
// seen: macOS keeps no list of them.
func shortcutClashes(_ s: Shortcut) -> [String] {
    // A tap is no key combination: nothing can clash with it, but other apps' taps reach
    // Session Board only with the Accessibility permission
    if s.isModifierTap {
        return AXIsProcessTrusted() ? [] : ["Tapping \(s.display) in other apps reaches Session Board only with the Accessibility permission (System Settings → Privacy & Security → Accessibility)."]
    }
    var clashes: [String] = []
    if let name = macOSShortcutClash(s) {
        clashes.append(name.isEmpty ? "\(s.display) is a macOS shortcut, so it may not reach Session Board."
                                    : "\(s.display) is macOS's “\(name)” shortcut, so it may not reach Session Board.")
    }
    let inApps = appMenuClashes(s)
    if !inApps.isEmpty {
        clashes.append("\(s.display) is " + inApps.prefix(2).joined(separator: " and ") + ". Session Board would take it over in every app.")
    } else if let common = commonAppShortcuts.first(where: { UInt32($0.keyCode) == s.keyCode && UInt32($0.mods) == s.mods }) {
        clashes.append("\(s.display) is \(common.name) in most apps. Session Board would take it over in every app.")
    }
    return clashes
}

// Light or dark. "claude": like Claude Desktop, which keeps its choice in its config.json
// (userThemeMode), or like macOS when Desktop follows the system or isn't installed. "system":
// like macOS.
let claudeConfigPath = home + "/Library/Application Support/Claude/config.json"

func claudeDesktopTheme() -> String? {
    guard let mode = readJSON(claudeConfigPath)?["userThemeMode"] as? String, mode == "dark" || mode == "light" else { return nil }
    return mode
}

func systemIsDark() -> Bool { UserDefaults.standard.string(forKey: "AppleInterfaceStyle") == "Dark" }

// Your pick; or Claude Desktop's theme; or, when Desktop follows macOS (or isn't installed), macOS's
func themeIsDark(_ choice: String?) -> Bool {
    if choice == "dark" || choice == "light" { return choice == "dark" }
    if let theme = claudeDesktopTheme() { return theme == "dark" }
    return systemIsDark()
}

// A command a session started that is still running: tests, a build, a local server
struct BackgroundJob: Hashable {
    let label: String
    let minutes: Int
    // The command it runs, as the mod keys it (commandKey), to find the description Claude gave it
    var key: String = ""
}

// The command a session ran, read from its shell's command line: Claude Code runs it as
// `… && eval '<command>' < /dev/null && pwd -P …` (the mod reads it the same way, commandOf)
func commandOf(_ line: String) -> String {
    guard let start = line.range(of: "eval '") else { return "" }
    let rest = line[start.upperBound...]
    let raw = rest.range(of: "' < /dev/null", options: .backwards).map { String(rest[..<$0.lowerBound]) } ?? String(rest)
    return raw.replacingOccurrences(of: "'\"'\"'", with: "'")
}

// Spaces collapsed and the first 200 characters (UTF-16, as JavaScript counts), as the mod keys it
func commandKey(_ command: String) -> String {
    let collapsed = command.split(whereSeparator: \.isWhitespace).joined(separator: " ")
    return String(decoding: Array(collapsed.utf16.prefix(200)), as: UTF16.self)
}

// What a command does, in plain words, from its command line
func jobLabel(_ command: String) -> String {
    let c = command.lowercased()
    let has = { (words: [String]) in words.contains { c.contains($0) } }
    if c.contains("playwright test") { return "browser tests" }
    if has(["vitest", "jest ", "npm test", "npm run test", "bun test", "pytest", "go test", "cargo test", "swift test", "plugin test"]) { return "tests" }
    if has(["vite preview", "vite dev", "npm run dev", "next dev", "http.server", "npm start"]) { return "a local server" }
    if has(["build.sh", "npm run build", "vite build", "swiftc ", "xcodebuild", "cargo build", "go build", "docker build"]) { return "a build" }
    if has(["deploy", "rsync ", "scp ", "ssh "]) { return "work on a server" }
    return "a command"
}

// ps's elapsed time, [[dd-]hh:]mm:ss, in minutes
func elapsedMinutes(_ etime: String) -> Int {
    let dayParts = etime.split(separator: "-")
    let days = dayParts.count == 2 ? Int(dayParts[0]) ?? 0 : 0
    let clock = (dayParts.last ?? "").split(separator: ":").compactMap { Int($0) }
    let seconds = clock.reduce(0) { $0 * 60 + $1 }
    return days * 1440 + seconds / 60
}

// The commands each session still has running, by session id. Claude Code runs each command in
// a shell started from the session's shell snapshot (~/.claude/shell-snapshots/snapshot-zsh-<ms>-…),
// made the first time the session ran a command: the session is the one that started last
// before that moment.
func backgroundJobs(sessions: [(id: String, startedAt: Double)]) -> [String: [BackgroundJob]] {
    let ps = Process()
    ps.executableURL = URL(fileURLWithPath: "/bin/ps")
    ps.arguments = ["-axo", "etime=,command="]
    let pipe = Pipe()
    ps.standardOutput = pipe
    ps.standardError = FileHandle.nullDevice
    guard (try? ps.run()) != nil else { return [:] }
    let data = pipe.fileHandleForReading.readDataToEndOfFile()
    ps.waitUntilExit()
    let snapshot = try! NSRegularExpression(pattern: #"/\.claude/shell-snapshots/snapshot-[a-z]+-(\d{13})-"#)
    var jobs: [String: [BackgroundJob]] = [:]
    for line in (String(data: data, encoding: .utf8) ?? "").split(separator: "\n") {
        let text = line.trimmingCharacters(in: .whitespaces)
        guard let space = text.firstIndex(of: " ") else { continue }
        let command = String(text[space...])
        let range = NSRange(command.startIndex..., in: command)
        guard let match = snapshot.firstMatch(in: command, range: range), let r = Range(match.range(at: 1), in: command),
              let made = Double(command[r]),
              let owner = sessions.filter({ $0.startedAt <= made }).max(by: { $0.startedAt < $1.startedAt }) else { continue }
        let key = commandKey(commandOf(command))
        // One command can show as more than one process (a subshell): count it once
        if !key.isEmpty && jobs[owner.id, default: []].contains(where: { $0.key == key }) { continue }
        jobs[owner.id, default: []].append(BackgroundJob(label: jobLabel(command), minutes: elapsedMinutes(String(text[..<space])), key: key))
    }
    return jobs
}

// Each live session's id and when it started, from the registry
func liveSessionStarts() -> [(id: String, startedAt: Double)] {
    let names = (try? FileManager.default.contentsOfDirectory(atPath: registryDir)) ?? []
    return names.filter { $0.hasSuffix(".json") }.compactMap { name in
        guard let reg = readJSON(registryDir + "/" + name), let id = reg["sessionId"] as? String, let started = number(reg["startedAt"]) else { return nil }
        return (id, started)
    }
}

// The same merge the mod's pane does: registry for who is alive, records for what they do
// A summary's active and pending lists as a card's items
func summaryItems(_ summary: [String: Any], status: String) -> [Item] {
    // Something that waits on you isn't work under way, whatever list it came in
    let active = strings(summary["active"])
    return active.filter { !$0.hasSuffix(waitsSuffix) }.map { Item(text: $0, isActive: true, waitsOnYou: false) }
        + (active.filter { $0.hasSuffix(waitsSuffix) } + strings(summary["pending"])).map { text in
            // "waits on you" anywhere in it (older summaries put it first); a working
            // session isn't waiting on you, whatever its last summary said
            let waits = text.range(of: "waits on you", options: .caseInsensitive) != nil
            let plain = waits ? text.replacingOccurrences(of: #"\s*[·•-]?\s*\(?waits on you\)?\s*[:–-]?\s*"#, with: " ",
                                                          options: [.regularExpression, .caseInsensitive])
                .trimmingCharacters(in: .whitespaces) : text
            return Item(text: plain, isActive: false, waitsOnYou: waits && status == "idle")
        }
}

// Where the window keeps the cloud chats it read, and the mod their summaries (hooks/register.js)
let cloudDir = appDir + "/cloud"

// The cloud chats' summaries the mod wrote, by row id ("cloud:<name>")
func cloudSummaries() -> [String: [String: Any]] {
    var all: [String: [String: Any]] = [:]
    for file in (try? FileManager.default.contentsOfDirectory(atPath: cloudDir)) ?? [] where file.hasSuffix(".summary.json") {
        if let d = readJSON(cloudDir + "/" + file), let row = d["rowId"] as? String, !row.isEmpty, let s = d["summary"] as? [String: Any] { all[row] = s }
    }
    return all
}

// A stable fingerprint of a chat (Swift's own hashes change with every launch), so the mod
// summarizes it again only when it changed
func fingerprint(_ text: String) -> String {
    var h: UInt64 = 1469598103934665603
    for b in text.utf8 { h = (h ^ UInt64(b)) &* 1099511628211 }
    return String(h, radix: 16)
}

func loadRows(now: Double) -> [Row] {
    var live: [String: [String: Any]] = [:]
    var hasRegistry = false
    if let names = try? FileManager.default.contentsOfDirectory(atPath: registryDir) {
        hasRegistry = true
        for name in names where name.hasSuffix(".json") {
            if let reg = readJSON(registryDir + "/" + name), let sid = reg["sessionId"] as? String { live[sid] = reg }
        }
    }

    var records: [String: [String: Any]] = [:]
    // Also the records of an older install, while its sessions still run (a hidden setting:
    // defaults write <bundle id> extraStorePrefixes -array name_)
    var titles: [String: String] = [:]
    let prefixes = [storePrefix] + (UserDefaults.standard.stringArray(forKey: "extraStorePrefixes") ?? [])
    if let names = try? FileManager.default.contentsOfDirectory(atPath: storeDir) {
        for name in names where prefixes.contains(where: { name.hasPrefix($0) }) && name.hasSuffix(".json") {
            guard let store = readJSON(storeDir + "/" + name) else { continue }
            for (key, value) in store where key.hasPrefix("s:") {
                guard let rec = value as? [String: Any], let id = rec["id"] as? String else { continue }
                // The title Claude gave the conversation, from whichever copy has it
                if let title = rec["title"] as? String, !title.isEmpty { titles[id] = title }
                let updated = (number(rec["updatedAt"]) ?? 0) / 1000
                if live[id] == nil && (hasRegistry || now - updated > staleSeconds) { continue }
                // A session's own record knows more than a caught-up copy of it; otherwise the newer one
                if let old = records[id] {
                    let oldOwn = (old["shadow"] as? Bool) != true, newOwn = (rec["shadow"] as? Bool) != true
                    if oldOwn != newOwn ? oldOwn : (number(old["updatedAt"]) ?? 0) > (number(rec["updatedAt"]) ?? 0) { continue }
                }
                records[id] = rec
            }
        }
    }

    let rank = ["needs-you": 0, "working": 1, "idle": 2]
    let ids = Set(live.keys).union(records.keys)
    let desktop = desktopSessions()
    return ids.map { id -> Row in
        let reg = live[id]
        let rec = records[id]
        // A record the catch-up pass wrote (shadow) knows what a session does, but only the
        // registry knows whether it is busy
        let own = rec != nil && (rec?["shadow"] as? Bool) != true
        // The registry: "busy" or "shell" is working, but it keeps saying so after the turn has
        // ended while a command or background agent the turn started still runs. Only the
        // conversation shows the end of the turn (the catch-up record's turnEnded): then it's
        // idle, with that job. "waiting" is waiting on you.
        // That end holds only until the status changes again: a new message makes the session busy
        // before the next catch-up (every 30 s) reads the conversation, so it's working at once.
        let regRaw = (reg?["status"] as? String) ?? "idle"
        let readAt = number(rec?["updatedAt"]) ?? 0
        let turnEnded = (rec?["turnEnded"] as? Bool) == true && (number(reg?["statusUpdatedAt"]) ?? 0) <= readAt
        let regStatus = regRaw == "waiting" ? "needs-you" : (regRaw == "idle" || turnEnded) ? "idle" : "working"
        let status = own ? ((rec?["status"] as? String) ?? regStatus) : regStatus
        // When it entered its status: the mod's statusSince (a tool call is no change), or the
        // registry's statusUpdatedAt for a session without the mod. Orders each status group,
        // newest first, and is the time shown on the row.
        var changedMs: Double = (own ? number(rec?["statusSince"]) ?? number(rec?["updatedAt"])
                             : number(reg?["statusUpdatedAt"]) ?? number(reg?["updatedAt"]))
            ?? number(rec?["updatedAt"]) ?? 0
        // Idle since its last message, at the latest: reopening an old chat in Claude Desktop starts
        // a new process, and that alone isn't activity
        if status == "idle", let last = number(rec?["lastMessageAt"]), last > 0 { changedMs = changedMs > 0 ? min(changedMs, last) : last }
        let cwd = (rec?["cwd"] as? String) ?? (reg?["cwd"] as? String)
        // A session the registry only knows by a placeholder ("site-54", derived from the folder)
        // shows the title Claude gave the conversation, the one Claude Desktop shows
        let derived = (reg?["nameSource"] as? String) == "derived"
        let aiTitle = titles[id] ?? ""
        let regName = derived && !aiTitle.isEmpty ? aiTitle : ((reg?["name"] as? String) ?? "")
        // A session Claude Desktop runs goes by the title Desktop's sidebar shows: a name given in
        // Claude Code since (by a hook, or the plugin naming a resumed session) never reaches Desktop
        let hosted = desktop[(reg?["hostSessionId"] as? String) ?? ""] ?? desktop[id]
        let shownName = !(hosted?.title ?? "").isEmpty ? hosted!.title : regName

        var items: [Item] = []
        if let rec {
            let tasks = ((rec["tasks"] as? [Any]) ?? []).compactMap { $0 as? [String: Any] }
                .filter { ["pending", "in_progress"].contains($0["status"] as? String ?? "") }
            let summary = rec["summary"] as? [String: Any]
            if !tasks.isEmpty {
                items = tasks.map {
                    Item(text: ($0["subject"] as? String) ?? "", isActive: ($0["status"] as? String) == "in_progress", waitsOnYou: false)
                }
            } else if let summary {
                items = summaryItems(summary, status: status)
            }
        }

        return Row(
            id: id,
            pid: (reg?["pid"] as? NSNumber)?.intValue,
            name: shownName.isEmpty ? baseName(cwd) : shownName,
            place: baseName(cwd),
            status: status,
            since: now - changedMs / 1000,
            isRemote: !((reg?["bridgeSessionId"] as? String) ?? "").isEmpty,
            isDesktop: (reg?["entrypoint"] as? String) == "claude-desktop",
            hasMod: rec != nil,
            justDid: ((rec?["summary"] as? [String: Any])?["done"] as? String) ?? "",
            agentsRunning: (rec?["agentsRunning"] as? NSNumber)?.intValue ?? 0,
            workflowsRunning: (rec?["workflowsRunning"] as? NSNumber)?.intValue ?? 0,
            items: items,
            request: (rec?["request"] as? String) ?? "",
            ask: status == "needs-you" ? ((rec?["ask"] as? String) ?? "") : "",
            side: ((rec?["summary"] as? [String: Any])?["side"] as? String) ?? "",
            paused: ((rec?["summary"] as? [String: Any])?["paused"] as? String) ?? "",
            fromTaskList: !(((rec?["tasks"] as? [Any]) ?? []).compactMap { $0 as? [String: Any] }
                .filter { ["pending", "in_progress"].contains($0["status"] as? String ?? "") }.isEmpty),
            // The folder the session was opened in (the registry's), not one it moved into since
            project: projectName((reg?["cwd"] as? String) ?? cwd),
            bridgeId: (reg?["bridgeSessionId"] as? String) ?? "",
            runningLabels: (rec?["runningLabels"] as? [String: String]) ?? [:],
            otherNames: otherNames(name: shownName.isEmpty ? baseName(cwd) : shownName, project: projectName((reg?["cwd"] as? String) ?? cwd),
                                   former: ((reg?["formerNames"] as? [Any]) ?? []).compactMap { ($0 as? [String: Any])?["name"] as? String }
                                       + [regName] + (hosted?.previousTitles ?? [])),
            task: ((rec?["summary"] as? [String: Any])?["task"] as? String) ?? "",
            parent: desktop[hosted?.parent ?? ""]?.title ?? ""
        )
    }
    .sorted { (rank[$0.status] ?? 3, $0.since) < (rank[$1.status] ?? 3, $1.since) }
}

final class Board: ObservableObject {
    @Published var rows: [Row] = []
    // A crash since the last one offered, and whether the prompt has sent it
    @Published var crash: CrashReport?
    @Published var crashSent = false
    // Collapsed to one line of counts; kept between launches
    @Published var collapsed = UserDefaults.standard.bool(forKey: "collapsed") {
        didSet { UserDefaults.standard.set(collapsed, forKey: "collapsed") }
    }
    // Sessions you dismissed, by id; kept between launches until restored or ended
    @Published var dismissed = Set(UserDefaults.standard.stringArray(forKey: "dismissed") ?? []) {
        didSet { UserDefaults.standard.set(Array(dismissed), forKey: "dismissed") }
    }
    // When each was dismissed: one that needs you after that comes back by itself
    var dismissedAt: [String: Double] = (UserDefaults.standard.dictionary(forKey: "dismissedAt") as? [String: Double]) ?? [:] {
        didSet { UserDefaults.standard.set(dismissedAt, forKey: "dismissedAt") }
    }
    @Published var showDismissed = false
    // The last dismissal, undoable for a few seconds (the toast, and ⌘Z)
    @Published var undoable: (id: String, name: String)?
    private var undoTimer: Timer?

    func dismiss(_ row: Row) {
        dismissed.insert(row.id)
        dismissedAt[row.id] = Date().timeIntervalSince1970
        undoable = (row.id, row.name)
        undoTimer?.invalidate()
        undoTimer = Timer.scheduledTimer(withTimeInterval: 6, repeats: false) { [weak self] _ in self?.undoable = nil }
    }

    func restore(_ id: String) {
        dismissed.remove(id)
        dismissedAt[id] = nil
    }

    func undoDismiss() {
        guard let last = undoable else { return }
        restore(last.id)
        undoable = nil
    }

    // Sounds: on or off, and each moment on its own; Done is off at first (chatty with many sessions)
    @Published var soundsOn = UserDefaults.standard.object(forKey: "soundsOn") as? Bool ?? true {
        didSet { UserDefaults.standard.set(soundsOn, forKey: "soundsOn") }
    }
    @Published var soundNeedsYou = UserDefaults.standard.object(forKey: "soundNeedsYou") as? Bool ?? true {
        didSet { UserDefaults.standard.set(soundNeedsYou, forKey: "soundNeedsYou") }
    }
    @Published var soundYourTurn = UserDefaults.standard.object(forKey: "soundYourTurn") as? Bool ?? true {
        didSet { UserDefaults.standard.set(soundYourTurn, forKey: "soundYourTurn") }
    }
    @Published var soundDone = UserDefaults.standard.object(forKey: "soundDone") as? Bool ?? false {
        didSet { UserDefaults.standard.set(soundDone, forKey: "soundDone") }
    }
    // The sound each moment plays (needs you, your turn, done), by id; and why a file of yours
    // couldn't be added
    @Published var soundChoices = (UserDefaults.standard.stringArray(forKey: "soundChoices") ?? defaultSoundChoices) {
        didSet { if !drawingSnapshot { UserDefaults.standard.set(soundChoices, forKey: "soundChoices") } }
    }
    @Published var soundError: String?
    // Alert volume, 0.1 to 1 (0 = "Mine": leave the Mac's volume alone)
    @Published var alertVolume = UserDefaults.standard.object(forKey: "alertVolume") as? Double ?? 0.5 {
        didSet { if !drawingSnapshot { UserDefaults.standard.set(alertVolume, forKey: "alertVolume") } }
    }
    // The moment whose sound chooser is open in Settings (one at a time)
    @Published var openSoundPicker: Int?

    func chooseSound(_ id: String, for moment: Int) {
        var choices = soundChoices
        while choices.count < defaultSoundChoices.count { choices.append(defaultSoundChoices[choices.count]) }
        choices[moment] = id
        soundChoices = choices
        soundError = nil
        playSound(id, fallback: defaultSoundChoices[moment])
    }
    // Each session's status once seen on two reloads in a row (a one-reload flicker, such as a
    // prompt that approves itself, never sounds); the status seen last and how many times; when
    // a turn ended, until that end has had its sound; when a sound last played (one per 8 s)
    private var settled: [String: String] = [:]
    private var lastSeen: [String: (status: String, count: Int)] = [:]
    private var turnEnded: [String: Double] = [:]
    private var lastSound = Date.distantPast

    // A session wants you to look:
    // - needs you: it newly stopped on a permission prompt or a question;
    // - your turn: its turn ended with something waiting on you;
    // - done: its turn ended with nothing for you, and nothing it started still runs (it waits
    //   for its tests or agents to finish, however long they take).
    // Each happens once per change of status, never for the session you're viewing, and the
    // most urgent wins when several come together.
    // A session wants you (0 needs you, 1 your turn, 2 done): the app shows the popup
    var onAttention: ((Int, Row) -> Void)?
    // How far below the top of the board's content the list of cards starts, while it shows: where
    // the top session shows, however far it's scrolled. The popups line up with it. Not published:
    // only their placement reads it.
    var listTop: CGFloat?

    func considerSounds(_ rows: [Row]) {
        let now = Date().timeIntervalSince1970
        var moments: [(kind: Int, row: Row)] = []
        for r in rows where !isQuiet(r) {
            let seen = lastSeen[r.id]
            lastSeen[r.id] = (r.status, seen?.status == r.status ? (seen?.count ?? 0) + 1 : 1)
            guard (lastSeen[r.id]?.count ?? 0) >= 2 else { continue }
            let before = settled[r.id]
            settled[r.id] = r.status
            // The first status seen for a session (at launch, or when it opens) makes no sound
            guard let before else { continue }
            if before != r.status {
                if r.status == "needs-you" && r.id != focusedId { moments.append((0, r)) }
                if r.status == "idle" && before == "working" { turnEnded[r.id] = now } else if r.status != "idle" { turnEnded[r.id] = nil }
            }
            guard r.status == "idle", let ended = turnEnded[r.id] else { continue }
            let waits = r.items.contains { $0.waitsOnYou }
            let running = !(jobs[r.id] ?? []).isEmpty || r.agentsRunning > 0 || r.workflowsRunning > 0
            // The summary needs a few seconds after the turn ends to say whether something waits
            if waits && now - ended < 90 {
                turnEnded[r.id] = nil
                if r.id != focusedId { moments.append((1, r)) }
            } else if !waits && !running && now - ended >= 15 {
                turnEnded[r.id] = nil
                if r.id != focusedId { moments.append((2, r)) }
            }
        }
        // The popup beside the board, for every moment (its sound may be off)
        for m in moments { onAttention?(m.kind, m.row) }
        let wanted = moments.filter { [soundNeedsYou, soundYourTurn, soundDone][$0.kind] }
        guard soundsOn, let most = wanted.min(by: { $0.kind < $1.kind }), Date().timeIntervalSince(lastSound) >= 8 else { return }
        lastSound = Date()
        let name = soundChoices.indices.contains(most.kind) ? soundChoices[most.kind] : defaultSoundChoices[most.kind]
        playAlert(name, fallback: defaultSoundChoices[most.kind])
        logSound(["needs-you", "your-turn", "done"][most.kind] + " (" + name + ")", most.row)
    }

    // Each sound and why, so a false one can be traced: ~/Library/Application Support/session-board/sounds.log
    func logSound(_ name: String, _ row: Row) {
        let path = appDir + "/sounds.log"
        let line = ISO8601DateFormatter().string(from: Date()) + "  " + name + "  " + row.name + "  status=" + row.status
            + " since=\(Int(row.since))s waits=\(row.items.filter(\.waitsOnYou).map(\.text)) jobs=\((jobs[row.id] ?? []).map(\.label)) agents=\(row.agentsRunning) workflows=\(row.workflowsRunning)\n"
        if let size = (try? FileManager.default.attributesOfItem(atPath: path))?[.size] as? Int, size > 200_000 {
            try? FileManager.default.removeItem(atPath: path)
        }
        if let handle = FileHandle(forWritingAtPath: path) {
            handle.seekToEndOfFile()
            handle.write(Data(line.utf8))
            try? handle.close()
        } else {
            try? line.write(toFile: path, atomically: true, encoding: .utf8)
        }
    }
    // The colour you gave each session (a swatch name), by session id; forgotten when it ends
    @Published var sessionColors = (UserDefaults.standard.dictionary(forKey: "sessionColors") as? [String: String]) ?? [:] {
        didSet { if !drawingSnapshot { UserDefaults.standard.set(sessionColors, forKey: "sessionColors") } }
    }
    // The colour each session got by itself, kept while it's open, so it never changes under you
    @Published var autoColors = (UserDefaults.standard.dictionary(forKey: "autoColors") as? [String: String]) ?? [:] {
        didSet { if !drawingSnapshot { UserDefaults.standard.set(autoColors, forKey: "autoColors") } }
    }

    func colorName(_ id: String) -> String? { sessionColors[id] ?? autoColors[id] }

    // A session without a colour gets one at random that no other open session shows, and that
    // looks clearly different from all of them (pink next to magenta reads as one colour): of the
    // free colours, only those nearly as far from the nearest one in use as the farthest are
    // candidates, the popular ones first. When all are shown, one of the least shown.
    // A snapshot takes the first instead, so it draws the same each time.
    func assignColors() {
        var next = autoColors
        let pick = { (from: [String]) -> String? in drawingSnapshot ? from.first : from.randomElement() }
        for r in rows where next[r.id] == nil {
            let shown = rows.compactMap { $0.id == r.id ? nil : sessionColors[$0.id] ?? next[$0.id] }
            let free = autoColorOrder.filter { !shown.contains($0) }
            if !free.isEmpty {
                let inUse = shown.compactMap { swatch($0)?.dark }
                let apart = { (c: String) -> Double in
                    guard let v = swatch(c)?.dark else { return 0 }
                    return inUse.map { colorDistance(v, $0) }.min() ?? 1
                }
                let farthest = free.map(apart).max() ?? 0
                let distinct = free.filter { apart($0) >= farthest * distinctShare }
                next[r.id] = pick(distinct.filter { popularAutoColors.contains($0) }) ?? pick(distinct)
            } else {
                let uses = { (c: String) in shown.filter { $0 == c }.count }
                let fewest = autoColorOrder.map(uses).min() ?? 0
                next[r.id] = pick(autoColorOrder.filter { uses($0) == fewest })
            }
        }
        if next != autoColors { autoColors = next }
    }

    // The session the needs-you strip asked the list to scroll to
    @Published var scrollRequest: String?
    // Settings, behind the gear in the top bar
    @Published var showSettings = false
    // Light or dark as you picked it ("light" or "dark"); until you pick, like Claude Desktop
    @Published var themeChoice = UserDefaults.standard.string(forKey: "theme") {
        didSet {
            UserDefaults.standard.set(themeChoice, forKey: "theme")
            updateTheme()
        }
    }
    @Published var isDark = themeIsDark(UserDefaults.standard.string(forKey: "theme")) {
        didSet { tooltipIsDark = isDark }
    }
    // Claude Desktop is open: only then does its highlight, and the permission it needs, matter
    @Published var desktopRunning = false
    // Commands sessions still have running, by session id
    @Published var jobs: [String: [BackgroundJob]] = [:]
    private let jobQueue = DispatchQueue(label: "jobs")

    func updateTheme() {
        let dark = themeIsDark(themeChoice)
        if dark != isDark { isDark = dark }
    }
    // The show/hide shortcut, and changing it: recording a new one, the modifiers held so far,
    // one that clashes and waits for "Use anyway", and why one can't be used
    @Published var shortcut = Shortcut.load()
    @Published var recording = false
    @Published var heldModifiers = ""
    @Published var pendingShortcut: Shortcut?
    @Published var shortcutClashNotes: [String] = []
    @Published var shortcutError: String?
    // A regular window on the desktop, with a Dock icon, instead of the floating popup
    @Published var regularWindow = UserDefaults.standard.bool(forKey: "regularWindow") {
        didSet { UserDefaults.standard.set(regularWindow, forKey: "regularWindow") }
    }
    // Hide the window while an app other than Claude is in front
    @Published var hideWhenAway = UserDefaults.standard.object(forKey: "hideWhenAway") as? Bool ?? true {
        didSet { UserDefaults.standard.set(hideWhenAway, forKey: "hideWhenAway") }
    }
    // Terminals and code editors count as Claude, for sessions run in them
    @Published var terminalsCount = UserDefaults.standard.object(forKey: "terminalsCount") as? Bool ?? true {
        didSet { UserDefaults.standard.set(terminalsCount, forKey: "terminalsCount") }
    }
    // Names show their project first, so sessions of one project share a greyed first word
    @Published var projectNames = (readJSON(appDir + "/settings.json")?["projectNames"] as? Bool) ?? true {
        didSet { writeSettings() }
    }
    // Advanced, off unless switched on: the mod also renames the session itself that way, so
    // Claude Code and Claude Desktop show the same name. It reads settings.json when it names one.
    @Published var renameSessions = (readJSON(appDir + "/settings.json")?["renameSessions"] as? Bool) ?? false {
        didSet { writeSettings() }
    }
    // Summaries (Sonnet). The mod reads settings.json before each one.
    @Published var summaries = (readJSON(appDir + "/settings.json")?["summaries"] as? Bool) ?? true {
        didSet { writeSettings() }
    }

    func writeSettings() {
        try? FileManager.default.createDirectory(atPath: appDir, withIntermediateDirectories: true)
        if let data = try? JSONSerialization.data(withJSONObject: ["summaries": summaries, "projectNames": projectNames, "renameSessions": renameSessions], options: [.prettyPrinted]) {
            try? data.write(to: URL(fileURLWithPath: appDir + "/settings.json"), options: .atomic)
        }
    }

    // Bullets you removed, by session id. Also written to removed.json, which the mod reads so
    // The summary leaves them out of the next one instead of bringing them back.
    @Published var removedItems: [String: [String]] = (UserDefaults.standard.dictionary(forKey: "removedItems") as? [String: [String]]) ?? [:] {
        didSet {
            UserDefaults.standard.set(removedItems, forKey: "removedItems")
            writeRemoved()
        }
    }

    func writeRemoved() {
        try? FileManager.default.createDirectory(atPath: appDir, withIntermediateDirectories: true)
        if let data = try? JSONSerialization.data(withJSONObject: removedItems, options: [.prettyPrinted]) {
            try? data.write(to: URL(fileURLWithPath: appDir + "/removed.json"), options: .atomic)
        }
    }

    func removeItem(_ text: String, of id: String) {
        if !(removedItems[id] ?? []).contains(text) { removedItems[id, default: []].append(text) }
    }

    func restoreItem(_ text: String, of id: String) {
        let left = (removedItems[id] ?? []).filter { $0 != text }
        removedItems[id] = left.isEmpty ? nil : left
    }

    // The session in the front Terminal or iTerm tab, or open in Desktop, highlighted in the list
    @Published var focusedId: String? {
        didSet {
            writeStatus()
        }
    }
    // Quiet: idle for 12 hours, and not the session you're viewing
    func isQuiet(_ row: Row) -> Bool { row.isQuiet && row.id != focusedId }
    // Accessibility on: needed to read which session Desktop has open
    @Published var canReadDesktop = AXIsProcessTrusted()
    var lastDesktopName: String?
    // The names Desktop's front window gave its chat, last read
    var lastDesktopPages: [String] = []
    // Reads in a row that found no session open in Desktop
    var desktopMisses = 0

    // status.json in the shared folder: what the highlight last saw, for troubleshooting
    func writeStatus() {
        try? FileManager.default.createDirectory(atPath: appDir, withIntermediateDirectories: true)
        let status: [String: Any] = [
            "at": Date().timeIntervalSince1970, "accessibility": canReadDesktop,
            "front": NSWorkspace.shared.frontmostApplication?.bundleIdentifier ?? "",
            "desktopName": lastDesktopName ?? "", "desktopPages": lastDesktopPages, "focusedId": focusedId ?? "",
            "focusedName": rows.first { $0.id == focusedId }?.name ?? "",
            // Where the popups line up: the list's top, below the top of the board's content
            "listTop": listTop.map { Double($0) } ?? -1,
        ]
        if let data = try? JSONSerialization.data(withJSONObject: status, options: [.prettyPrinted]) {
            try? data.write(to: URL(fileURLWithPath: appDir + "/status.json"))
        }
    }
    private var timer: Timer?
    private var focusTimer: Timer?
    private let focusQueue = DispatchQueue(label: "focus")
    // A focus check still running, so slow ones don't pile up; and when a terminal was last
    // asked (by AppleScript, which is slower), at most once a second
    private var focusCheckRunning = false
    private var lastTerminalCheck = Date.distantPast

    func start() {
        writeRemoved()
        reload()
        // The list every 2 seconds; the highlight four times a second, so it follows a switch at once
        timer = Timer.scheduledTimer(withTimeInterval: 2, repeats: true) { [weak self] _ in self?.reload() }
        focusTimer = Timer.scheduledTimer(withTimeInterval: 0.25, repeats: true) { [weak self] _ in self?.pollFocus() }
    }

    // Cloud sessions as Desktop's sidebar showed them last, by row id ("cloud:<name>"), with when
    // each took its status (the first read, for one already in it)
    private var cloud: [String: (row: SidebarRow, status: String, since: Double)] = [:]
    private var cloudScanRunning = false
    // What each cloud session was doing when Desktop last showed it, by row id
    private var cloudGists: [String: ChatGist] = [:]
    // The last chat written for the mod to summarize, by cloud session id
    private var cloudMarks: [String: String] = [:]

    // The cloud sessions to show: the sidebar rows that are no session this Mac knows
    func cloudRows(now: Double, local: [Row]) -> [Row] {
        let known = Set(local.flatMap { [$0.name] + $0.otherNames }.map(plainName)).union(localDesktopNames())
        let summaries = cloudSummaries()
        return cloud.compactMap { id, c in
            if known.contains(plainName(c.row.name)) { return nil }
            let gist = cloudGists[id]
            let summary = summaries[id]
            // The summary of its chat, as a local card's; while it works, the line Desktop shows it on
            var items = summary.map { summaryItems($0, status: c.status) } ?? []
            if c.status == "working", let now = gist?.now, !now.isEmpty, !items.contains(where: \.isActive) {
                items.insert(Item(text: now, isActive: true, waitsOnYou: false), at: 0)
            }
            let done = (summary?["done"] as? String) ?? ""
            return Row(id: id, pid: nil, name: c.row.name, place: c.row.group.isEmpty ? "cloud" : c.row.group, status: c.status,
                       since: now - c.since, isRemote: false, isDesktop: false, hasMod: gist != nil || summary != nil,
                       justDid: done.isEmpty ? gist?.did ?? "" : done, agentsRunning: 0,
                       workflowsRunning: 0, items: items, request: gist?.request ?? "", ask: "",
                       side: (summary?["side"] as? String) ?? "", paused: (summary?["paused"] as? String) ?? "", fromTaskList: false,
                       project: c.row.group, isCloud: true, task: (summary?["task"] as? String) ?? "")
        }
    }

    // Reads Desktop's sidebar off the main thread; the next reload shows what it found
    func scanCloud() {
        guard desktopRunning else {
            if !cloud.isEmpty { cloud = [:] }
            return
        }
        if cloudScanRunning || !AXIsProcessTrusted() { return }
        cloudScanRunning = true
        cloudQueue.async { [weak self] in
            let found = desktopSidebarRows()
            let open = desktopOpenChat()
            DispatchQueue.main.async {
                guard let self else { return }
                self.cloudScanRunning = false
                if let found { self.takeCloud(found) }
                if let open, open.gist != ChatGist() { self.takeGist(open.name, open.gist) }
                if let open, !open.exchanges.isEmpty { self.keepChat(open.name, id: open.id, exchanges: open.exchanges) }
            }
        }
    }

    // The chat Desktop shows, for the mod to summarize (cloud/<id>.json), when it changed
    func keepChat(_ name: String, id: String, exchanges: [ChatExchange]) {
        let row = "cloud:" + plainName(name)
        guard cloud[row] != nil, id.range(of: #"^[\w-]+$"#, options: .regularExpression) != nil else { return }
        let status = cloud[row]?.status ?? "idle"
        let list = exchanges.map { ["ask": $0.ask, "reply": $0.reply] }
        guard let body = try? JSONSerialization.data(withJSONObject: list, options: [.sortedKeys]) else { return }
        let mark = fingerprint(status + (String(data: body, encoding: .utf8) ?? ""))
        if cloudMarks[id] == mark { return }
        let doc: [String: Any] = ["rowId": row, "name": name, "status": status, "readAt": Date().timeIntervalSince1970 * 1000,
                                  "mark": mark, "exchanges": list]
        guard let data = try? JSONSerialization.data(withJSONObject: doc) else { return }
        try? FileManager.default.createDirectory(atPath: cloudDir, withIntermediateDirectories: true)
        if (try? data.write(to: URL(fileURLWithPath: cloudDir + "/" + id + ".json"), options: .atomic)) != nil { cloudMarks[id] = mark }
    }

    // A request no longer on the page is kept from the read before
    func takeGist(_ name: String, _ gist: ChatGist) {
        let id = "cloud:" + plainName(name)
        var g = gist
        if g.request.isEmpty { g.request = cloudGists[id]?.request ?? "" }
        cloudGists[id] = g
    }

    func takeCloud(_ found: [SidebarRow]) {
        let at = Date().timeIntervalSince1970
        var next: [String: (row: SidebarRow, status: String, since: Double)] = [:]
        // Rows in a group Desktop badges as cloud, or in its Cloud section
        for r in found where r.badge == "Cloud" || r.group == "Cloud" {
            let id = "cloud:" + plainName(r.name)
            let status = cloudStatus(r.state)
            let old = cloud[id]
            next[id] = (r, status, old.map { $0.status == status ? $0.since : at } ?? at)
        }
        cloud = next
        cloudGists = cloudGists.filter { next[$0.key] != nil }
        // A cloud chat not read for a week, and its summary, are thrown away
        let fm = FileManager.default
        for file in (try? fm.contentsOfDirectory(atPath: cloudDir)) ?? [] {
            let path = cloudDir + "/" + file
            if let m = (try? fm.attributesOfItem(atPath: path))?[.modificationDate] as? Date, at - m.timeIntervalSince1970 > 7 * 86400 {
                try? fm.removeItem(atPath: path)
            }
        }
    }

    func reload() {
        let now = Date().timeIntervalSince1970
        let local = loadRows(now: now)
        let rank = ["needs-you": 0, "working": 1, "idle": 2]
        rows = (local + cloudRows(now: now, local: local)).sorted { (rank[$0.status] ?? 3, $0.since) < (rank[$1.status] ?? 3, $1.since) }
        assignColors()
        // A dismissed session that needs you since it was dismissed comes back by itself
        for r in rows where dismissed.contains(r.id) && r.status == "needs-you" && now - r.since > (dismissedAt[r.id] ?? now) {
            restore(r.id)
        }
        considerSounds(rows)
        let sessions = liveSessionStarts()
        jobQueue.async { [weak self] in
            let found = backgroundJobs(sessions: sessions)
            DispatchQueue.main.async {
                guard let self, self.jobs != found else { return }
                self.jobs = found
            }
        }
        updateTheme()
        let running = !NSRunningApplication.runningApplications(withBundleIdentifier: desktopBundle).isEmpty
        if running != desktopRunning { desktopRunning = running }
        scanCloud()
        // Forget dismissals of sessions that have ended (never on an empty read)
        if !rows.isEmpty {
            let ids = Set(rows.map(\.id))
            if !dismissed.isSubset(of: ids) { dismissed = dismissed.intersection(ids) }
            if !Set(removedItems.keys).isSubset(of: ids) { removedItems = removedItems.filter { ids.contains($0.key) } }
            if !Set(sessionColors.keys).isSubset(of: ids) { sessionColors = sessionColors.filter { ids.contains($0.key) } }
            if !Set(autoColors.keys).isSubset(of: ids) { autoColors = autoColors.filter { ids.contains($0.key) } }
        }
    }

    // The name a row shows: with its project first, unless the setting is off or the name
    // already starts with it (a session renamed that way, or a placeholder like "app-a6")
    func shownName(_ row: Row) -> String {
        guard projectNames, !row.project.isEmpty else { return row.name }
        func plain(_ s: String) -> String { s.lowercased().components(separatedBy: CharacterSet.alphanumerics.inverted).joined() }
        return plain(row.name).hasPrefix(plain(row.project)) ? row.name : row.project + " · " + row.name
    }

    // Two-tone names, by session id: the words a name shares with another open session's, or
    // else the project it starts with, greyed so the part that tells sessions apart reads first
    var sharedPrefixes: [String: String] {
        let names = shown.map { ($0.id, shownName($0), $0.project) }
        var out: [String: String] = [:]
        for (id, name, project) in names {
            let words = name.split(separator: " ").map(String.init)
            for k in stride(from: words.count - 1, through: 1, by: -1) {
                let prefix = words[0..<k].joined(separator: " ") + " "
                if names.contains(where: { $0.0 != id && $0.1.hasPrefix(prefix) }) { out[id] = prefix; break }
            }
            if out[id] == nil, !project.isEmpty, name.hasPrefix(project + " · ") { out[id] = project + " · " }
        }
        return out
    }

    // Shown: not quiet, not dismissed
    var shown: [Row] { rows.filter { !isQuiet($0) && !dismissed.contains($0.id) } }
    var hidden: [Row] { rows.filter { dismissed.contains($0.id) } }
    var working: Int { shown.filter { $0.status == "working" }.count }
    var needsYou: Int { shown.filter { $0.status == "needs-you" }.count }
    var idle: Int { shown.filter { $0.status == "idle" }.count }

    // Which session is in the front terminal tab: the tab's tty, the claude process on it,
    // and that process's registry entry. Other apps leave the last highlight in place.
    func pollFocus() {
        let front = NSWorkspace.shared.frontmostApplication?.bundleIdentifier ?? ""
        let trusted = AXIsProcessTrusted()
        if trusted != canReadDesktop { canReadDesktop = trusted }
        if focusCheckRunning { return }
        if front == desktopBundle {
            let candidates = rows.map { ($0.id, $0.name, $0.otherNames, $0.since) }
            focusCheckRunning = true
            focusQueue.async { [weak self] in
                let names = desktopOpenSessionNames()
                // Same name twice: the one active most recently. Names compare without caring about
                // curly or straight quotes, case or spacing.
                // A session's current name first; failing that, a name it had before a rename, which
                // Desktop goes on showing
                let match = { (n: String) in
                    (candidates.filter { sameName($0.1, n) }.min { $0.3 < $1.3 }
                        ?? candidates.filter { $0.2.contains { sameName($0, n) } }.min { $0.3 < $1.3 })?.0
                }
                let found = names.lazy.compactMap { n in match(n).map { (n, $0) } }.first
                DispatchQueue.main.async {
                    guard let self else { return }
                    self.focusCheckRunning = false
                    let name = found?.0 ?? names.first
                    let changed = name != self.lastDesktopName || names != self.lastDesktopPages
                    self.lastDesktopName = name
                    self.lastDesktopPages = names
                    self.desktopMisses = found == nil ? self.desktopMisses + 1 : 0
                    if let id = found?.1, self.focusedId != id {
                        self.focusedId = id
                    } else if found == nil, self.desktopMisses >= 4, self.focusedId != nil {
                        // No session open in Desktop that the board knows, for a second: highlight
                        // nothing, rather than the one open before, which points at the wrong chat
                        self.focusedId = nil
                    } else if changed {
                        self.writeStatus()
                    }
                }
            }
            return
        }
        if Date().timeIntervalSince(lastTerminalCheck) < 1 { return }
        lastTerminalCheck = Date()
        let script: String
        switch front {
        case "com.apple.Terminal": script = "tell application \"Terminal\" to get tty of selected tab of front window"
        case "com.googlecode.iterm2": script = "tell application \"iTerm2\" to get tty of current session of current window"
        default: return
        }
        let sessionByPid = Dictionary(rows.compactMap { r in r.pid.map { ($0, r.id) } }, uniquingKeysWith: { a, _ in a })
        focusQueue.async { [weak self] in
            var error: NSDictionary?
            guard let tty = NSAppleScript(source: script)?.executeAndReturnError(&error).stringValue, !tty.isEmpty else { return }
            let ps = Process()
            ps.executableURL = URL(fileURLWithPath: "/bin/ps")
            ps.arguments = ["-t", String(tty.dropFirst("/dev/".count)), "-o", "pid="]
            let pipe = Pipe()
            ps.standardOutput = pipe
            ps.standardError = FileHandle.nullDevice
            guard (try? ps.run()) != nil else { return }
            ps.waitUntilExit()
            let out = String(data: pipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
            let id = out.split(separator: "\n").compactMap { Int($0.trimmingCharacters(in: .whitespaces)) }.compactMap { sessionByPid[$0] }.first
            DispatchQueue.main.async {
                if let id, self?.focusedId != id { self?.focusedId = id }
            }
        }
    }
}

// The sounds each moment can play, by id ("kind:name"):
// - board: the three made for the board (board/sounds, synthesised, MIT);
// - system: macOS's own alert sounds, on every Mac (/System/Library/Sounds), most familiar first;
// - kenney: a CC0 set from Kenney's Interface Sounds (kenney.nl), bundled (board/sounds/kenney-*);
// - custom: your own, copied to ~/Library/Application Support/session-board/sounds.
struct SoundOption: Hashable {
    let id: String
    let name: String
}

let boardSounds = [
    SoundOption(id: "board:needs-you", name: "Mallet"), SoundOption(id: "board:your-turn", name: "Soft chime"),
    SoundOption(id: "board:done", name: "Bell"),
]
let systemSounds = ["Glass", "Ping", "Hero", "Submarine", "Purr", "Funk", "Pop", "Tink", "Blow", "Bottle", "Frog", "Morse", "Sosumi", "Basso"]
    .map { SoundOption(id: "system:" + $0, name: $0) }
let kenneySounds = [
    ("confirmation_001", "Confirm 1"), ("confirmation_002", "Confirm 2"), ("confirmation_003", "Confirm 3"), ("confirmation_004", "Confirm 4"),
    ("question_001", "Question 1"), ("question_002", "Question 2"), ("question_003", "Question 3"), ("glass_001", "Glass tap"),
    ("maximize_006", "Rise"), ("bong_001", "Bong"), ("pluck_002", "Pluck"),
].map { SoundOption(id: "kenney:" + $0.0, name: $0.1) }
let defaultSoundChoices = ["board:needs-you", "board:your-turn", "board:done"]
let customSoundsDir = appDir + "/sounds"

func customSounds() -> [SoundOption] {
    ((try? FileManager.default.contentsOfDirectory(atPath: customSoundsDir)) ?? []).filter { !$0.hasPrefix(".") }.sorted()
        .map { SoundOption(id: "custom:" + $0, name: ($0 as NSString).deletingPathExtension) }
}

func soundURL(_ id: String) -> URL? {
    let parts = id.split(separator: ":", maxSplits: 1).map(String.init)
    guard parts.count == 2 else { return nil }
    switch parts[0] {
    case "board": return Bundle.main.url(forResource: parts[1], withExtension: "wav")
    case "kenney": return Bundle.main.url(forResource: "kenney-" + parts[1], withExtension: "wav")
    case "system": return URL(fileURLWithPath: "/System/Library/Sounds/" + parts[1] + ".aiff")
    case "custom": return URL(fileURLWithPath: customSoundsDir + "/" + parts[1])
    default: return nil
    }
}

func soundName(_ id: String) -> String {
    (boardSounds + systemSounds + kenneySounds + customSounds()).first { $0.id == id }?.name ?? "Missing sound"
}

// A sound by id; one that's gone (a removed file of yours) gives the moment's own sound
func loadSound(_ id: String, fallback: String? = nil) -> NSSound? {
    if let url = soundURL(id), FileManager.default.fileExists(atPath: url.path), let sound = NSSound(contentsOf: url, byReference: true) {
        return sound
    }
    if let fallback, fallback != id { return loadSound(fallback) }
    return nil
}

// Previews (▶ Play, picking a sound) play at your volume as it is
func playSound(_ id: String, fallback: String? = nil) {
    loadSound(id, fallback: fallback)?.play()
}

// The Mac's output volume and mute, on the default output device. A device without its own
// volume control (some HDMI and USB outputs) reads nil, and is left alone.
enum SystemVolume {
    static func device() -> AudioObjectID? {
        var id = AudioObjectID(0)
        var size = UInt32(MemoryLayout<AudioObjectID>.size)
        var address = AudioObjectPropertyAddress(mSelector: kAudioHardwarePropertyDefaultOutputDevice,
                                                 mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
        guard AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size, &id) == noErr, id != 0 else { return nil }
        return id
    }

    static var volumeAddress = AudioObjectPropertyAddress(mSelector: kAudioHardwareServiceDeviceProperty_VirtualMainVolume,
                                                          mScope: kAudioDevicePropertyScopeOutput, mElement: kAudioObjectPropertyElementMain)

    static func get() -> Float32? {
        guard let id = device(), AudioObjectHasProperty(id, &volumeAddress) else { return nil }
        var volume = Float32(0)
        var size = UInt32(MemoryLayout<Float32>.size)
        return AudioObjectGetPropertyData(id, &volumeAddress, 0, nil, &size, &volume) == noErr ? volume : nil
    }

    static func set(_ volume: Float32) -> Bool {
        guard let id = device(), AudioObjectHasProperty(id, &volumeAddress) else { return false }
        var settable = DarwinBoolean(false)
        guard AudioObjectIsPropertySettable(id, &volumeAddress, &settable) == noErr, settable.boolValue else { return false }
        var value = volume
        return AudioObjectSetPropertyData(id, &volumeAddress, 0, nil, UInt32(MemoryLayout<Float32>.size), &value) == noErr
    }

    static func muted() -> Bool {
        guard let id = device() else { return false }
        var address = AudioObjectPropertyAddress(mSelector: kAudioDevicePropertyMute, mScope: kAudioDevicePropertyScopeOutput,
                                                 mElement: kAudioObjectPropertyElementMain)
        guard AudioObjectHasProperty(id, &address) else { return false }
        var mute = UInt32(0)
        var size = UInt32(MemoryLayout<UInt32>.size)
        return AudioObjectGetPropertyData(id, &address, 0, nil, &size, &mute) == noErr && mute != 0
    }
}

// The sound a moment plays on its own: at 50% of the Mac's volume, whatever the volume is set to,
// then the volume back as it was. Muted stays muted. If you change the volume
// while it plays, yours is kept.
var alertPlaying: NSSound?

// The volume sounds that play on their own use: a setting, 50% unless changed; 0 is "Mine",
// which leaves the Mac's volume alone
func alertVolumeSetting() -> Float32 {
    Float32(UserDefaults.standard.object(forKey: "alertVolume") as? Double ?? 0.5)
}

// The volume to put back is saved before it's changed: if the app quits or crashes while a sound
// plays, the next launch puts it back (when it's still at the alert's 50%)
func playAlert(_ id: String, fallback: String, volume: Float32? = nil, done: (() -> Void)? = nil) {
    guard let sound = loadSound(id, fallback: fallback) else { return }
    alertPlaying = sound
    let target = volume ?? alertVolumeSetting()
    guard target > 0, !SystemVolume.muted(), let before = SystemVolume.get(), abs(before - target) > 0.01 else {
        sound.play()
        done.map { d in DispatchQueue.main.asyncAfter(deadline: .now() + max(0.3, sound.duration) + 0.25) { d() } }
        return
    }
    UserDefaults.standard.set(Double(before), forKey: "volumeToRestore")
    UserDefaults.standard.set(Double(target), forKey: "volumeAlertTarget")
    guard SystemVolume.set(target) else {
        UserDefaults.standard.removeObject(forKey: "volumeToRestore")
        sound.play()
        return
    }
    sound.play()
    DispatchQueue.main.asyncAfter(deadline: .now() + max(0.3, sound.duration) + 0.25) {
        restoreVolume(before, from: target)
        if alertPlaying === sound { alertPlaying = nil }
        done?()
    }
}

// Back to the volume you had, unless you changed it meanwhile
func restoreVolume(_ before: Float32, from target: Float32) {
    if let now = SystemVolume.get(), abs(now - target) < 0.02 { _ = SystemVolume.set(before) }
    UserDefaults.standard.removeObject(forKey: "volumeToRestore")
}

// At launch: a sound that never got to put the volume back
func restoreVolumeLeftByAlert() {
    guard let saved = UserDefaults.standard.object(forKey: "volumeToRestore") as? Double else { return }
    let target = UserDefaults.standard.object(forKey: "volumeAlertTarget") as? Double ?? 0.5
    restoreVolume(Float32(saved), from: Float32(target))
}

// The board's colours, dark and light, one token per meaning: amber needs you, green working, grey idle, blue the session you're viewing (or
// the colour you gave it), violet a side task. Controls carry no colour.
struct Palette {
    let gap, cell, cellHover, sunken, text, idleName, prefix, muted, soft, doing, chipBorder, track: Color
    let amber, amberInk, amberText, green, greenInk, greenText, idle, idleInk: Color
    let blue, violet, violetBorder: Color
    let segTrack, switchOn, knobOn, switchOff, knobOff, switchOffBorder, keyBorder: Color
    let isDark: Bool

    static let dark = Palette(
        gap: hex(0x0B0B0C), cell: hex(0x131416), cellHover: hex(0x1A1B1E), sunken: hex(0x101113), text: hex(0xF2F2F3),
        idleName: hex(0xD5D6D9), prefix: hex(0x8D8E91), muted: hex(0x9A9AA0), soft: hex(0xB4B5B9), doing: hex(0xDADADF),
        chipBorder: hex(0x45464B), track: hex(0x26272B),
        amber: hex(0xE8A93A), amberInk: hex(0x1A1203), amberText: hex(0xF0BE62), green: hex(0x4CC38A), greenInk: hex(0x04140B),
        greenText: hex(0x4CC38A), idle: hex(0x8D8E91), idleInk: hex(0x131416),
        blue: hex(0x4B92FF), violet: hex(0xC4B5FD), violetBorder: hex(0x8B6CF0),
        segTrack: hex(0x22232A), switchOn: hex(0xE6E6EA), knobOn: hex(0x131416), switchOff: hex(0x2E2F34), knobOff: hex(0x8D8E91),
        switchOffBorder: hex(0x2E2F34), keyBorder: hex(0x45464B), isDark: true)

    static let light = Palette(
        gap: hex(0xE2E3E6), cell: hex(0xFFFFFF), cellHover: hex(0xF6F7F9), sunken: hex(0xF4F5F7), text: hex(0x141518),
        idleName: hex(0x2E3035), prefix: hex(0x6B6D73), muted: hex(0x696B71), soft: hex(0x4A4C52), doing: hex(0x23252A),
        chipBorder: hex(0xC4C6CB), track: hex(0xE6E7EA),
        amber: hex(0xC27C00), amberInk: hex(0x1A1203), amberText: hex(0x9A5B00), green: hex(0x2E9E6A), greenInk: hex(0x04140B),
        greenText: hex(0x1E7A4F), idle: hex(0x6B6D73), idleInk: hex(0xFFFFFF),
        blue: hex(0x2F6FD6), violet: hex(0x6D4FD8), violetBorder: hex(0x8B6CF0),
        segTrack: hex(0xECEDF0), switchOn: hex(0x23252A), knobOn: hex(0xFFFFFF), switchOff: hex(0xE6E7EA), knobOff: hex(0x8A8C92),
        switchOffBorder: hex(0x8A8C92), keyBorder: hex(0xC4C6CB), isDark: false)
}

func hex(_ v: UInt32) -> Color {
    Color(red: Double((v >> 16) & 0xFF) / 255, green: Double((v >> 8) & 0xFF) / 255, blue: Double(v & 0xFF) / 255)
}

// The colours you can give a session, in the board's tones, the most popular first. Each has
// a deeper value for the light theme.
struct Swatch {
    let name: String
    let dark: UInt32
    let light: UInt32
}

let swatches: [Swatch] = [
    Swatch(name: "Blue", dark: 0x4B92FF, light: 0x2F6FD6), Swatch(name: "Purple", dark: 0x9B7CFF, light: 0x6D4FD8),
    Swatch(name: "Teal", dark: 0x2EC4B6, light: 0x0F8B80), Swatch(name: "Pink", dark: 0xF472B6, light: 0xC23D86),
    Swatch(name: "Red", dark: 0xF0605A, light: 0xC73A35), Swatch(name: "Orange", dark: 0xF28C3B, light: 0xC05A10),
    Swatch(name: "Green", dark: 0x5CCB6A, light: 0x2F8F3E), Swatch(name: "Sky", dark: 0x38BDF8, light: 0x0B7FB5),
    Swatch(name: "Indigo", dark: 0x7C83FF, light: 0x4A52D6), Swatch(name: "Gold", dark: 0xF5C542, light: 0xA67C00),
    Swatch(name: "Rose", dark: 0xFB7185, light: 0xC8364E), Swatch(name: "Coral", dark: 0xFF8A65, light: 0xC4512A),
    Swatch(name: "Mint", dark: 0x5EE6B0, light: 0x138A60), Swatch(name: "Lime", dark: 0xA3E635, light: 0x5C8A08),
    Swatch(name: "Cyan", dark: 0x22D3EE, light: 0x0A8AA3), Swatch(name: "Lavender", dark: 0xB9A6FF, light: 0x7A5FD8),
    Swatch(name: "Magenta", dark: 0xE05BE0, light: 0xA8329F), Swatch(name: "Plum", dark: 0xB57BD9, light: 0x844CA8),
    Swatch(name: "Crimson", dark: 0xE5484D, light: 0xB0232A), Swatch(name: "Peach", dark: 0xFFB385, light: 0xB8642F),
    Swatch(name: "Sand", dark: 0xD9B98C, light: 0x8F6C3A), Swatch(name: "Olive", dark: 0xB5BD5A, light: 0x6E751B),
    Swatch(name: "Forest", dark: 0x3FA36B, light: 0x1E7447), Swatch(name: "Ocean", dark: 0x3B82C4, light: 0x1F5C96),
    Swatch(name: "Steel", dark: 0x8CA3BF, light: 0x52698A), Swatch(name: "Slate", dark: 0x94A3B8, light: 0x56657A),
    Swatch(name: "Graphite", dark: 0xA1A1AA, light: 0x5F5F68), Swatch(name: "Brown", dark: 0xC08A5B, light: 0x875730),
    Swatch(name: "Turquoise", dark: 0x40E0D0, light: 0x0D8F84), Swatch(name: "Fuchsia", dark: 0xD946EF, light: 0xA01DAD),
]

func swatch(_ name: String?) -> Swatch? { swatches.first { $0.name == name } }

// The colours a session gets by itself, one per open session, picked at random (popular first):
// none that reads as a state (amber, gold or orange is needs you, green is working,
// grey is idle, violet is a side task). You can still pick any of the 30.
let autoColorOrder = ["Blue", "Pink", "Teal", "Magenta", "Sky", "Rose", "Cyan", "Plum", "Ocean", "Fuchsia", "Turquoise", "Coral"]
// A new session's colour is picked among the free ones at least this share as far from the nearest
// colour in use as the farthest free one is: clearly different, with some choice left
let distinctShare = 0.9

// How different two colours look: the distance between them in OKLab, which follows the eye
func colorDistance(_ x: UInt32, _ y: UInt32) -> Double {
    func lab(_ v: UInt32) -> (Double, Double, Double) {
        func linear(_ c: UInt32) -> Double {
            let s = Double(c) / 255
            return s <= 0.04045 ? s / 12.92 : pow((s + 0.055) / 1.055, 2.4)
        }
        let r = linear((v >> 16) & 0xFF), g = linear((v >> 8) & 0xFF), b = linear(v & 0xFF)
        let l = cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b)
        let m = cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b)
        let s = cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)
        return (0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
                1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
                0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s)
    }
    let a = lab(x), b = lab(y)
    return sqrt(pow(a.0 - b.0, 2) + pow(a.1 - b.1, 2) + pow(a.2 - b.2, 2))
}

// The popular ones, given first, in no set order
let popularAutoColors = Array(autoColorOrder.prefix(6))

// Near-black or white, whichever reads better on the colour
func inkFor(_ v: UInt32) -> Color {
    func channel(_ c: UInt32) -> Double {
        let x = Double(c) / 255
        return x <= 0.03928 ? x / 12.92 : pow((x + 0.055) / 1.055, 2.4)
    }
    let l = 0.2126 * channel((v >> 16) & 0xFF) + 0.7152 * channel((v >> 8) & 0xFF) + 0.0722 * channel(v & 0xFF)
    return (l + 0.05) / 0.0545 >= 1.05 / (l + 0.05) ? hex(0x0B0B0C) : .white
}

// A session's number square: the colour you gave it, or its state's
func squareColors(_ row: Row, colorName: String?, _ p: Palette) -> (fill: Color, ink: Color) {
    if let s = swatch(colorName) {
        let v = p.isDark ? s.dark : s.light
        return (hex(v), inkFor(v))
    }
    switch row.status {
    case "needs-you": return (p.amber, p.amberInk)
    case "working": return (p.green, p.greenInk)
    default: return (p.idle, p.idleInk)
    }
}

// The state in words, in its colour: it carries the state when the square has your colour
func stateTextColor(_ status: String, _ p: Palette) -> Color {
    switch status {
    case "needs-you": return p.amberText
    case "working": return p.greenText
    default: return p.muted
    }
}

func statusColor(_ status: String, _ p: Palette) -> Color {
    switch status {
    case "needs-you": return p.amber
    case "working": return p.green
    default: return p.idle
    }
}

func copyToPasteboard(_ text: String) {
    NSPasteboard.general.clearContents()
    NSPasteboard.general.setString(text, forType: .string)
}

// A session as plain text, for pasting into a chat with Claude
func sessionText(_ row: Row, removed: [String], jobs: [BackgroundJob] = []) -> String {
    var lines = [row.name + " (" + (row.status == "needs-you" ? "needs you" : row.status) + " " + ago(row.since) + " · " + row.place + ")"]
    if !row.parent.isEmpty { lines.append("↳ side session of " + row.parent) }
    if !row.task.isEmpty { lines.append("◎ task: " + row.task) }
    if !row.ask.isEmpty { lines.append("? " + row.ask) }
    if !row.side.isEmpty { lines.append("↪ side task: " + row.side) }
    if !row.paused.isEmpty { lines.append("⏸ paused: " + row.paused) }
    for item in row.items where row.status == "working" && item.isActive && !removed.contains(item.text) { lines.append("▸ " + item.text) }
    if row.status != "working" && (!jobs.isEmpty || row.agentsRunning > 0 || row.workflowsRunning > 0) {
        lines.append("◷ still running: " + runningItems(jobs, agents: row.agentsRunning, workflows: row.workflowsRunning, labels: row.runningLabels).joined(separator: "; "))
    }
    if !row.justDid.isEmpty { lines.append("✓ " + row.justDid) }
    for item in row.items where (row.status != "working" || !item.isActive) && !removed.contains(item.text) {
        lines.append((item.waitsOnYou ? "! " : "· ") + item.text + (item.waitsOnYou ? " · waits on you" : ""))
    }
    if row.items.isEmpty && row.justDid.isEmpty && !row.request.isEmpty { lines.append("you asked: " + row.request) }
    return lines.joined(separator: "\n")
}

// What a session still runs, each by the description Claude gave it (else what its command line
// suggests), the longest-running first, then workflows and background agents
func runningItems(_ jobs: [BackgroundJob], agents: Int = 0, workflows: Int = 0, labels: [String: String] = [:]) -> [String] {
    var items: [String] = []
    for job in jobs.sorted(by: { $0.minutes > $1.minutes }) {
        let label = labels[job.key] ?? job.label
        if !items.contains(label) { items.append(label) }
    }
    if workflows > 0 { items.append(workflows == 1 ? "a workflow" : "\(workflows) workflows") }
    if agents > 0 { items.append(agents == 1 ? "a background agent" : "\(agents) background agents") }
    return items
}

// One line however many run: "Still running: run the browser suite · 6m", or with more
// "Still running: run the browser suite, +2 more · 6m" (the card's tooltip lists them all)
func stillRunning(_ jobs: [BackgroundJob], agents: Int = 0, workflows: Int = 0, labels: [String: String] = [:]) -> String {
    let items = runningItems(jobs, agents: agents, workflows: workflows, labels: labels)
    guard let first = items.first else { return "" }
    return "Still running: " + first + (items.count > 1 ? ", +\(items.count - 1) more" : "")
        + (jobs.isEmpty ? "" : " · " + ago(Double((jobs.map(\.minutes).max() ?? 0) * 60)))
}

let monoFont = Font.system(size: 11.5, design: .monospaced)

// The number square, filled with the session's state colour
struct Square: View {
    let text: String
    let fill: Color
    let ink: Color
    var size: CGFloat = 10

    var body: some View {
        Text(text).font(.system(size: size, weight: .bold, design: .monospaced)).tracking(size < 10 ? 0.9 : 0)
            .foregroundStyle(ink).padding(.horizontal, 5).padding(.vertical, 2)
            .background(RoundedRectangle(cornerRadius: 2).fill(fill))
    }
}

// An outlined mono tag: RC, DESKTOP, SIDE TASK
struct Chip: View {
    let text: String
    let ink: Color
    let border: Color

    var body: some View {
        Text(text).font(.system(size: 9, weight: .semibold, design: .monospaced)).tracking(0.9).foregroundStyle(ink)
            .padding(.horizontal, 4).padding(.vertical, 1).overlay(Rectangle().stroke(border, lineWidth: 1))
    }
}

// "NEEDS YOU · 1m": the state in capitals, the time as written
struct StatusLabel: View {
    let status: String
    let since: Double
    let color: Color

    var body: some View {
        Text("\(Text(status == "needs-you" ? "NEEDS YOU" : status.uppercased()).tracking(1.2)) · \(ago(since))")
            .font(.system(size: 10, weight: .bold, design: .monospaced)).foregroundColor(color).lineLimit(1).fixedSize()
    }
}

// The name with the words it shares with other open sessions greyed. When it doesn't fit, the
// grey part goes first, so the part that tells sessions apart is never cut.
struct TwoToneName: View {
    let name: String
    let prefix: String?
    let bright: Color
    let grey: Color
    var size: CGFloat = 17
    @State private var cut = false

    var body: some View {
        let rest = prefix.map { String(name.dropFirst($0.count)) } ?? name
        ViewThatFits(in: .horizontal) {
            Text("\(Text(prefix ?? "").foregroundColor(grey))\(Text(rest).foregroundColor(bright))").lineLimit(1).fixedSize()
            Text(rest).foregroundColor(bright).lineLimit(1).truncationMode(.tail)
        }
        .font(.system(size: size, weight: .semibold)).kerning(-size / 100)
        // The whole name in the tooltip when even the name alone doesn't fit
        .background(GeometryReader { shown in
            Text(rest).font(.system(size: size, weight: .semibold)).kerning(-size / 100).lineLimit(1).fixedSize().hidden()
                .background(GeometryReader { full in
                    Color.clear
                        .onAppear { cut = full.size.width > shown.size.width + 1 }
                        .onChange(of: shown.size) { _, s in cut = full.size.width > s.width + 1 }
                })
        })
        .tooltip(cut ? name : nil)
    }
}

// One list line: its glyph, its text, and (for summary items) a × on hover that removes it
struct ListLine: View {
    let glyph: String
    let text: String
    let color: Color
    var bold = false
    var symbol: String?
    var glyphColor: Color?
    var onRemove: (() -> Void)?
    // At most this many lines (the rest cut with …, and shown whole in a tooltip), or as many as it needs
    var maxLines: Int? = 2
    // What the tooltip shows when it says more than the line (the line itself, when cut, otherwise)
    var fullText: String?
    @State private var hovering = false
    @State private var cut = false

    var body: some View {
        // The glyph in its own column, so a wrapped line hangs under the text
        HStack(alignment: .firstTextBaseline, spacing: 0) {
            Group {
                if let symbol {
                    Image(systemName: symbol).font(.system(size: 7, weight: .bold)).alignmentGuide(.firstTextBaseline) { $0[.bottom] + 1 }
                } else {
                    Text(glyph)
                }
            }
            .foregroundStyle(glyphColor ?? color).frame(width: 14, alignment: .leading)
            Text(text).lineLimit(maxLines).fixedSize(horizontal: false, vertical: true).truncationReported($cut, Text(text))
            Spacer(minLength: 4)
            if let onRemove {
                Button(action: onRemove) {
                    Image(systemName: "xmark").font(.system(size: 8, weight: .bold)).frame(width: 16, height: 14).contentShape(Rectangle())
                }
                .buttonStyle(.plain).foregroundStyle(color).opacity(hovering ? 0.9 : 0)
                .help("Remove this line; the summary won't add it back")
            }
        }
        .font(.system(size: 11.5, weight: bold ? .bold : .regular, design: .monospaced)).foregroundStyle(color)
        .contentShape(Rectangle())
        .onHover { hovering = $0 }
        .tooltip(cut || (fullText != nil && fullText != text) ? fullText ?? text : nil)
        .contextMenu { Button("Copy") { copyToPasteboard(fullText ?? text) } }
    }
}

// Whether a Text was cut short by its line limit: the same text laid out with no limit, unseen,
// behind it, is taller (or wider, for one line that doesn't wrap)
struct TruncationReport: ViewModifier {
    @Binding var cut: Bool
    let text: Text
    func body(content: Content) -> some View {
        content.background(GeometryReader { shown in
            Color.clear.overlay(alignment: .topLeading) {
                text.lineLimit(nil).fixedSize(horizontal: false, vertical: true).frame(width: shown.size.width, alignment: .leading)
                    .hidden()
                    .background(GeometryReader { full in
                        Color.clear
                            .onAppear { cut = full.size.height > shown.size.height + 1 }
                            .onChange(of: full.size) { _, size in cut = size.height > shown.size.height + 1 }
                            .onChange(of: shown.size) { _, size in cut = full.size.height > size.height + 1 }
                    })
            }
        })
    }
}
extension View {
    func truncationReported(_ cut: Binding<Bool>, _ text: Text) -> some View { modifier(TruncationReport(cut: cut, text: text)) }
    // The board's own tooltip, quick and in its colours, for text that's cut short (nil: none)
    func tooltip(_ text: String?) -> some View { modifier(TooltipHover(text: text)) }
}

struct TooltipHover: ViewModifier {
    let text: String?
    // Where the hovered text is, in its window (from the top left), so the tooltip sits beside it
    @State private var frame: CGRect = .zero
    func body(content: Content) -> some View {
        content
            .background(GeometryReader { g in
                Color.clear.onAppear { frame = g.frame(in: .global) }.onChange(of: g.frame(in: .global)) { _, f in frame = f }
            })
            .onHover { inside in
                if inside, let text, !text.isEmpty { Tooltip.shared.show(text, line: frame) } else { Tooltip.shared.hide() }
            }
            .onDisappear { Tooltip.shared.hide() }
    }
}

// The board's theme, for the tooltip, which isn't in its view tree
var tooltipIsDark = themeIsDark(UserDefaults.standard.string(forKey: "theme"))

// One tooltip panel for the whole app: shown a moment after the pointer rests on cut-short text,
// beside the pointer and kept on its screen, wrapped at a reading width, in the board's colours
@MainActor
final class Tooltip {
    static let shared = Tooltip()
    private var panel: NSPanel?
    private var pending: DispatchWorkItem?
    private let delay = 0.25

    func show(_ text: String, line: CGRect) {
        pending?.cancel()
        let work = DispatchWorkItem { [weak self] in self?.present(text, line: line) }
        pending = work
        // Already showing one: move to the next line at once
        DispatchQueue.main.asyncAfter(deadline: .now() + (panel?.isVisible == true ? 0 : delay), execute: work)
    }

    func hide() {
        pending?.cancel()
        pending = nil
        panel?.orderOut(nil)
    }

    private func present(_ text: String, line: CGRect) {
        let p: Palette = tooltipIsDark ? .dark : .light
        // As wide as its longest line, up to a reading width it wraps at; as tall as that makes it
        let font = NSFont.monospacedSystemFont(ofSize: 11.5, weight: .regular)
        let natural = text.split(separator: "\n").map { (String($0) as NSString).size(withAttributes: [.font: font]).width }.max() ?? 0
        let width = min(320, ceil(natural) + 2)
        let view = Text(text)
            .font(.system(size: 11.5, design: .monospaced)).foregroundStyle(p.text).lineSpacing(3)
            .frame(width: width, alignment: .leading)
            .fixedSize(horizontal: false, vertical: true)
            .padding(.horizontal, 10).padding(.vertical, 9)
            .background(RoundedRectangle(cornerRadius: 6).fill(p.cellHover))
            .overlay(RoundedRectangle(cornerRadius: 6).stroke(p.chipBorder, lineWidth: 1))
        let host = NSHostingView(rootView: view)
        let size = NSHostingController(rootView: view).sizeThatFits(in: CGSize(width: width + 20, height: 2000))
        let panel = self.panel ?? {
            let made = NSPanel(contentRect: .zero, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: true)
            made.isOpaque = false
            made.backgroundColor = .clear
            made.hasShadow = true
            made.ignoresMouseEvents = true
            made.level = NSWindow.Level(rawValue: NSWindow.Level.floating.rawValue + 2)
            made.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .transient]
            self.panel = made
            return made
        }()
        panel.contentView = host
        // Just below the hovered text, lined up with it, so it covers none of the line itself; above
        // it where the screen ends. The pointer's place when the text's isn't known.
        let mouse = NSEvent.mouseLocation
        let screen = NSScreen.screens.first { NSMouseInRect(mouse, $0.frame, false) }?.visibleFrame ?? NSScreen.main?.visibleFrame ?? .zero
        let window = NSApp.windows.first { $0.isVisible && $0 !== self.panel && NSMouseInRect(mouse, $0.frame, false) }
        let gap: CGFloat = 6
        let text: NSRect = window.map { w in
            NSRect(x: w.frame.minX + line.minX, y: w.frame.maxY - line.maxY, width: line.width, height: line.height)
        } ?? NSRect(x: mouse.x, y: mouse.y - 8, width: 0, height: 16)
        var origin = NSPoint(x: text.minX - 2, y: text.minY - gap - size.height)
        if origin.y < screen.minY + 4 { origin.y = text.maxY + gap }
        origin.x = min(max(origin.x, screen.minX + 4), screen.maxX - size.width - 4)
        origin.y = min(max(origin.y, screen.minY + 4), screen.maxY - size.height - 4)
        panel.setFrame(NSRect(origin: origin, size: size), display: true)
        panel.orderFrontRegardless()
    }
}

// A borderless button in the board's quiet style: Restore, Restore all, Open, Play
struct QuietButton: View {
    let title: String
    var key: String?
    let p: Palette
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 6) {
                Text(title).font(.system(size: 11.5, weight: .semibold))
                if let key {
                    Text(key).font(.system(size: 10, weight: .semibold, design: .monospaced)).foregroundStyle(p.muted)
                        .padding(.horizontal, 4).overlay(RoundedRectangle(cornerRadius: 3).stroke(p.keyBorder, lineWidth: 1))
                }
            }
            .foregroundStyle(p.text).padding(.horizontal, 8).padding(.vertical, 3)
            .background(RoundedRectangle(cornerRadius: 5).fill(p.segTrack))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }
}

// One session: the F card with D's lines (board G)
struct SessionCard: View {
    let row: Row
    // The name it shows (with its project first, unless that setting is off)
    let name: String
    let number: Int
    let prefix: String?
    let viewing: Bool
    let jobs: [BackgroundJob]
    let removed: [String]
    let summariesOff: Bool
    // Drag across the text to select it, then ⌘C (in the floating board, the drag takes the keyboard)
    let selectable: Bool
    // The colour you gave this session, if any (its square, and the ring while you view it)
    let colorName: String?
    // You picked the colour (not the automatic one)
    let picked: Bool
    let p: Palette
    let onDismiss: () -> Void
    let onRemove: (String) -> Void
    let onRestore: (String) -> Void
    let onRestoreAll: () -> Void
    let onPickColor: (String?) -> Void
    // Clicking the name takes you to the session
    var onOpen: () -> Void = {}
    @State private var hovering = false
    @State private var hoveringX = false
    @State private var showRemoved = false
    @State private var picking = false

    // Where the lines come from, when it isn't a summary
    var caption: String? {
        if row.isCloud { return row.hasMod ? "Cloud · as Claude Desktop last showed it" : "Cloud · open it in Claude Desktop to see what it's doing" }
        if !row.hasMod { return "No task data yet" }
        if row.fromTaskList { return "From the session's own task list" }
        if summariesOff && row.items.isEmpty { return "Summaries are off · no task list in this session" }
        return nil
    }

    var body: some View {
        let square = squareColors(row, colorName: colorName, p)
        let ring = swatch(colorName).map { hex(p.isDark ? $0.dark : $0.light) } ?? p.blue
        // Only the card you're viewing wears its colour: a tint behind the text, and the ring
        // (light enough that every text grey keeps 4.5:1 on it)
        let tint = p.isDark ? 0.12 : 0.08
        let visible = row.items.filter { !removed.contains($0.text) }
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 6) {
                Button { picking = true } label: { Square(text: String(format: "%02d", number), fill: square.fill, ink: square.ink) }
                    .buttonStyle(.plain).help("Pick a colour for this session")
                    .popover(isPresented: $picking, arrowEdge: .bottom) {
                        SwatchPicker(selected: colorName, picked: picked, p: p) {
                            onPickColor($0)
                            picking = false
                        }
                    }
                Chip(text: row.isCloud ? "CLOUD" : row.isDesktop ? "DESKTOP" : row.isRemote ? "RC" : "CLI", ink: p.muted, border: p.chipBorder)
                if !row.side.isEmpty { Chip(text: "SIDE TASK", ink: p.violet, border: p.violetBorder) }
                Spacer(minLength: 4)
                if hoveringX {
                    Text("Dismiss?").font(.system(size: 11, weight: .semibold)).foregroundStyle(p.cell)
                        .padding(.horizontal, 7).padding(.vertical, 2)
                        .background(RoundedRectangle(cornerRadius: 5).fill(p.text)).fixedSize()
                } else {
                    StatusLabel(status: row.status, since: row.since, color: stateTextColor(row.status, p))
                }
                if hovering {
                    Button(action: onDismiss) {
                        Image(systemName: "xmark").font(.system(size: 9, weight: .bold)).frame(width: 20, height: 18)
                            .background(RoundedRectangle(cornerRadius: 5).fill(p.segTrack)).contentShape(Rectangle())
                    }
                    .buttonStyle(.plain).foregroundStyle(p.text)
                    .onHover { hoveringX = $0 }
                }
            }
            Button(action: onOpen) {
                TwoToneName(name: name, prefix: prefix, bright: row.status == "idle" ? p.idleName : p.text, grey: p.prefix)
            }
            .buttonStyle(.plain)
            .onHover { inside in if inside { NSCursor.pointingHand.push() } else { NSCursor.pop() } }
            VStack(alignment: .leading, spacing: 3) {
                // The task, so anyone reading the card knows what the session is for
                if !row.parent.isEmpty { ListLine(glyph: "↳", text: "Side session of " + row.parent, color: p.muted, maxLines: 1) }
                if !row.task.isEmpty { ListLine(glyph: "◎", text: row.task, color: p.text, bold: true, maxLines: 2) }
                if !row.ask.isEmpty { ListLine(glyph: "?", text: row.ask, color: p.amberText, bold: true, maxLines: 4) }
                if !row.side.isEmpty {
                    ListLine(glyph: "↪", text: row.side, color: p.violet)
                    if !row.paused.isEmpty { ListLine(glyph: "⏸", text: "Paused: " + row.paused, color: p.muted) }
                }
                // Doing now: the green ▶, only while the session works. Once its turn has ended,
                // nothing is under way but what still runs (◷); what it called active is next.
                ForEach(row.status == "working" ? visible.filter(\.isActive) : [], id: \.self) { item in
                    ListLine(glyph: "", text: item.text, color: p.doing, symbol: "play.fill", glyphColor: p.green, onRemove: { onRemove(item.text) })
                }
                if row.status != "working" && (!jobs.isEmpty || row.agentsRunning > 0 || row.workflowsRunning > 0) {
                    ListLine(glyph: "◷", text: stillRunning(jobs, agents: row.agentsRunning, workflows: row.workflowsRunning, labels: row.runningLabels), color: p.doing, maxLines: 2,
                             fullText: runningItems(jobs, agents: row.agentsRunning, workflows: row.workflowsRunning, labels: row.runningLabels).joined(separator: "\n"))
                }
                if !row.justDid.isEmpty { ListLine(glyph: "✓", text: row.justDid, color: p.muted) }
                ForEach(row.status == "working" ? visible.filter { !$0.isActive } : visible.filter(\.isActive) + visible.filter { !$0.isActive },
                        id: \.self) { item in
                    ListLine(glyph: item.waitsOnYou ? "!" : "·", text: item.text, color: item.waitsOnYou ? p.amberText : p.soft,
                             onRemove: { onRemove(item.text) })
                }
                if row.items.isEmpty && row.justDid.isEmpty && row.ask.isEmpty && !row.request.isEmpty {
                    Text("You asked: \u{201C}\(row.request)\u{201D}").font(.system(size: 12.5)).italic().foregroundStyle(p.soft).lineLimit(2)
                }
                if let caption {
                    Text(caption).font(.system(size: 10.5, design: .monospaced)).foregroundStyle(p.prefix)
                }
                if !removed.isEmpty {
                    Button { showRemoved.toggle() } label: {
                        Text((showRemoved ? "⌄ " : "› ") + "\(removed.count) removed").font(monoFont).foregroundStyle(p.prefix).contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    if showRemoved {
                        ForEach(removed, id: \.self) { text in
                            HStack(spacing: 8) {
                                Text(text).font(monoFont).strikethrough().foregroundStyle(p.prefix).lineLimit(1)
                                Spacer(minLength: 4)
                                QuietButton(title: "Restore", p: p) { onRestore(text) }
                            }
                            .padding(.leading, 14)
                        }
                        if removed.count > 1 { QuietButton(title: "Restore all", p: p, action: onRestoreAll).padding(.leading, 14) }
                    }
                }
            }
        }
        .padding(.horizontal, 14).padding(.top, 12).padding(.bottom, 13)
        .frame(maxWidth: .infinity, alignment: .leading)
        // The ring sits behind the text, inside the card's padding
        .background {
            ZStack {
                hovering && !viewing ? p.cellHover : p.cell
                if viewing {
                    ring.opacity(tint)
                    Rectangle().strokeBorder(ring, lineWidth: 2)
                }
            }
        }
        .modifier(Selectable(on: selectable))
        .contentShape(Rectangle())
        .onHover {
            hovering = $0
            if !$0 { hoveringX = false }
        }
        .contextMenu { Button("Copy session") { copyToPasteboard(sessionText(row, removed: removed, jobs: jobs)) } }
    }
}

struct Selectable: ViewModifier {
    let on: Bool
    func body(content: Content) -> some View {
        if on { content.textSelection(.enabled) } else { content.textSelection(.disabled) }
    }
}

// The swatches, popular first, and the way back to the state colour
struct SwatchPicker: View {
    let selected: String?
    let picked: Bool
    let p: Palette
    let onPick: (String?) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Colour for this session").font(.system(size: 12, weight: .semibold)).foregroundStyle(p.text)
            LazyVGrid(columns: Array(repeating: GridItem(.fixed(24), spacing: 8), count: 6), spacing: 8) {
                ForEach(swatches, id: \.name) { s in
                    Button { onPick(s.name) } label: {
                        RoundedRectangle(cornerRadius: 4).fill(hex(p.isDark ? s.dark : s.light)).frame(width: 24, height: 24)
                            .overlay(RoundedRectangle(cornerRadius: 6).stroke(p.text, lineWidth: s.name == selected ? 2 : 0).padding(-3))
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain).help(s.name)
                }
            }
            .padding(3)
            if picked { QuietButton(title: "Back to automatic", p: p) { onPick(nil) } }
        }
        .padding(14)
        .background(p.cell)
    }
}

// The bar of real counts per state, with the legend of the states there are
struct StateBar: View {
    let counts: [(String, Int, Color)]
    let p: Palette

    var body: some View {
        let shown = counts.filter { $0.1 > 0 }
        let total = CGFloat(max(1, shown.map(\.1).reduce(0, +)))
        VStack(alignment: .leading, spacing: 8) {
            GeometryReader { g in
                let width = g.size.width - CGFloat(max(0, shown.count - 1)) * 2
                HStack(spacing: 2) {
                    if shown.isEmpty { Rectangle().fill(p.track) }
                    ForEach(shown, id: \.0) { seg in Rectangle().fill(seg.2).frame(width: width * CGFloat(seg.1) / total) }
                }
                .animation(.easeOut(duration: 0.3), value: shown.map(\.1))
            }
            .frame(height: 6).clipShape(RoundedRectangle(cornerRadius: 3))
            if !shown.isEmpty { HStack(spacing: 12) {
                ForEach(shown, id: \.0) { seg in
                    HStack(spacing: 5) {
                        Circle().fill(seg.2).frame(width: 6, height: 6)
                        Text("\(Text(seg.0).foregroundColor(p.soft)) \(Text("\(seg.1)").bold().foregroundColor(p.text))").font(.system(size: 11.5))
                    }
                }
            } }
        }
    }
}

// The top: Sessions and counts, the controls, the state bar (or ‹ Sessions in Settings)
struct HeaderView: View {
    @ObservedObject var board: Board
    let p: Palette

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 10) {
                if board.showSettings {
                    Button { board.showSettings = false } label: {
                        HStack(spacing: 2) { Image(systemName: "chevron.left").font(.system(size: 11, weight: .semibold)); Text("Sessions") }
                            .font(.system(size: 12.5)).foregroundStyle(p.soft).contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    Text("Settings").font(.system(size: 13, weight: .bold)).foregroundStyle(p.text)
                    Spacer()
                } else {
                    Text("Sessions").font(.system(size: 13, weight: .bold)).foregroundStyle(p.text)
                    Text(board.shown.isEmpty ? "none open" : "\(board.shown.count) open")
                        .font(.system(size: 12)).foregroundStyle(p.muted).lineLimit(1)
                    Spacer(minLength: 4)
                    Button {
                        board.collapsed = false
                        board.showSettings = true
                    } label: { Image(systemName: "gearshape").font(.system(size: 12, weight: .medium)).frame(width: 18, height: 18).contentShape(Rectangle()) }
                    .buttonStyle(.plain).foregroundStyle(p.muted).help("Settings")
                    Button { (NSApp.delegate as? AppDelegate)?.toggleWindow() } label: {
                        HStack(spacing: 4) {
                            Text(board.shortcut.display).font(.system(size: 10, weight: .semibold, design: .monospaced))
                                .padding(.horizontal, 4).padding(.vertical, 1)
                                .overlay(RoundedRectangle(cornerRadius: 4).stroke(p.keyBorder, lineWidth: 1))
                            Text("hide").font(.system(size: 11))
                        }
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain).foregroundStyle(p.muted).help("Hide the window. Press \(board.shortcut.display) in any app to bring it back.")
                    Button { board.collapsed.toggle() } label: {
                        Image(systemName: board.collapsed ? "chevron.down" : "chevron.up").font(.system(size: 11, weight: .semibold))
                            .frame(width: 18, height: 18).contentShape(Rectangle())
                    }
                    .buttonStyle(.plain).foregroundStyle(board.collapsed ? p.text : p.muted)
                    .help(board.collapsed ? "Show the sessions" : "Collapse to the summary")
                }
            }
            if !board.showSettings {
                StateBar(counts: [("Needs you", board.needsYou, p.amber), ("Working", board.working, p.green), ("Idle", board.idle, p.idle)], p: p)
            }
        }
        .padding(.horizontal, 14).padding(.top, 4).padding(.bottom, 12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(p.cell)
    }
}

// Who needs you, under the counts: always in the collapsed window, and in the open one while
// a session does. Clicking it scrolls the list to that session; it doesn't switch chats.
struct NeedsYouStrip: View {
    @ObservedObject var board: Board
    let p: Palette
    var showsNone = false

    var body: some View {
        let waiting = Array(board.shown.enumerated().filter { $0.element.status == "needs-you" })
        if let first = waiting.first {
            let row = first.element
            let square = squareColors(row, colorName: board.colorName(row.id), p)
            Button {
                board.collapsed = false
                board.scrollRequest = row.id
            } label: {
                HStack(spacing: 8) {
                    Square(text: String(format: "%02d", first.offset + 1), fill: square.fill, ink: square.ink)
                    TwoToneName(name: board.shownName(row), prefix: board.sharedPrefixes[row.id], bright: p.text, grey: p.prefix, size: 13)
                    if waiting.count > 1 {
                        Text("+\(waiting.count - 1)").font(.system(size: 10, weight: .bold, design: .monospaced)).foregroundStyle(p.amberText)
                            .fixedSize().help("\(waiting.count) sessions need you")
                    }
                    Spacer(minLength: 6)
                    StatusLabel(status: "needs-you", since: row.since, color: p.amberText)
                }
                .padding(.leading, 14).padding(.trailing, 14).padding(.vertical, 9)
                .background {
                    ZStack(alignment: .leading) {
                        p.cell
                        p.amber.opacity(p.isDark ? 0.10 : 0.12)
                        Rectangle().fill(p.amber).frame(width: 3)
                    }
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain).help("Show it in the list")
        } else if showsNone {
            HStack {
                Text("Nothing needs you right now").font(.system(size: 12)).foregroundStyle(p.muted)
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 14).padding(.vertical, 10)
            .background(p.cell)
        }
    }
}

// The one switch the Desktop highlight needs, named
// "Session Board quit unexpectedly": one click sends the crash to the team
struct CrashNote: View {
    @ObservedObject var board: Board
    let p: Palette
    @State private var sending = false

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 8) {
                Circle().fill(board.crashSent ? p.doing : p.amber).frame(width: 6, height: 6)
                Text(board.crashSent ? "Sent. Thanks for the report." : "Session Board quit unexpectedly")
                    .font(.system(size: 12.5, weight: .semibold)).foregroundStyle(p.text)
                Spacer(minLength: 4)
            }
            if !board.crashSent {
                Text("Send the crash details to the Session Board team? Nothing from your sessions is included.")
                    .font(.system(size: 11.5)).foregroundStyle(p.muted).fixedSize(horizontal: false, vertical: true)
                HStack(spacing: 8) {
                    QuietButton(title: sending ? "Sending…" : "Report", p: p) { report() }.disabled(sending)
                    QuietButton(title: "Not now", p: p) { close() }
                }
                .padding(.top, 2)
            }
        }
        .padding(.horizontal, 14).padding(.vertical, 10)
        .background(p.cell)
    }

    func report() {
        guard let crash = board.crash, !drawingSnapshot else { return }
        sending = true
        sendCrash(crash) { sent in
            sending = false
            if sent {
                board.crashSent = true
                DispatchQueue.main.asyncAfter(deadline: .now() + 3) { close() }
            } else {
                close()
            }
        }
    }

    func close() {
        if let crash = board.crash, !drawingSnapshot { UserDefaults.standard.set(crash.at.timeIntervalSince1970, forKey: "crashSeenAt") }
        board.crash = nil
        board.crashSent = false
    }
}

struct AccessibilityNote: View {
    let p: Palette

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: "info.circle").font(.system(size: 11)).foregroundStyle(p.muted)
                .help("Without it, the session open in Claude Desktop gets no highlight")
            Text("Turn on \(Text("Session Board").bold()) in Accessibility").font(.system(size: 11.5)).foregroundStyle(p.soft).lineLimit(1)
            Spacer(minLength: 4)
            QuietButton(title: "Open Settings", p: p) {
                NSWorkspace.shared.open(URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility")!)
            }
        }
        .padding(.horizontal, 14).padding(.vertical, 9)
        .background(p.cell)
    }
}

struct EmptyBoard: View {
    let p: Palette

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("No sessions in the last 12 hours").font(.system(size: 15, weight: .semibold)).foregroundStyle(p.text)
            Text("Start Claude Code in a terminal, or open a session in Claude Desktop. It shows up here within a few seconds.")
                .font(.system(size: 12.5)).lineSpacing(4).foregroundStyle(p.soft).fixedSize(horizontal: false, vertical: true)
            VStack(alignment: .leading, spacing: 4) {
                Text("\(Text("claude").foregroundColor(p.doing))\(Text(" · in any terminal").foregroundColor(p.muted))")
                Text("\(Text("/session-board").foregroundColor(p.doing))\(Text(" · brings this window back").foregroundColor(p.muted))")
            }
            .font(monoFont).padding(.top, 6)
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 18).padding(.vertical, 26)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background(p.cell)
    }
}

// Dismissed sessions, pinned under the list: one line each with Restore
struct DismissedSection: View {
    @ObservedObject var board: Board
    let p: Palette

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Button { board.showDismissed.toggle() } label: {
                HStack(spacing: 8) {
                    Text("\(Text("DISMISSED").tracking(1.4)) · \(board.hidden.count)")
                        .font(.system(size: 10, weight: .bold, design: .monospaced)).foregroundStyle(p.soft)
                    Spacer()
                    Image(systemName: board.showDismissed ? "chevron.down" : "chevron.right").font(.system(size: 10, weight: .semibold)).foregroundStyle(p.soft)
                }
                .padding(.horizontal, 14).padding(.vertical, 11).contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            if board.showDismissed {
                VStack(spacing: 8) {
                    ForEach(board.hidden) { row in
                        HStack(spacing: 9) {
                            Circle().fill(statusColor(row.status, p)).frame(width: 7, height: 7)
                            Text(board.shownName(row)).font(.system(size: 13, weight: .semibold)).foregroundStyle(p.text).lineLimit(1).truncationMode(.tail)
                            Spacer(minLength: 4)
                            StatusLabel(status: row.status, since: row.since, color: p.muted)
                            QuietButton(title: "Restore", p: p) { board.restore(row.id) }
                        }
                    }
                }
                .padding(.horizontal, 14).padding(.bottom, 10)
                HStack(spacing: 10) {
                    Text("Comes back when it needs you.").font(.system(size: 11, design: .monospaced)).foregroundStyle(p.muted)
                    Spacer(minLength: 4)
                    if board.hidden.count > 1 { QuietButton(title: "Restore all", p: p) { board.hidden.forEach { board.restore($0.id) } } }
                }
                .padding(.horizontal, 14).padding(.vertical, 9)
                .overlay(alignment: .top) { Rectangle().fill(p.gap).frame(height: 1) }
            }
        }
        .background(p.sunken)
    }
}

// "Mac storage cleanup dismissed · Undo ⌘Z", for six seconds
// The popup beside the board when a session wants you: its number, its name and why, for 8 seconds, with a white outline around it running down until it goes. Hovering holds
// it; a click takes you to the session, the × just closes it. One per session, newest on top.
struct AttentionToast: Identifiable {
    let id = UUID()
    let rowId: String
    let number: Int
    let name: String
    // 0 needs you, 1 your turn, 2 done: the moments the sounds play for
    let kind: Int
    let detail: String
    let colorName: String?
    // Seconds it has counted down, not counting while it's hovered
    var elapsed: TimeInterval = 0
}

// The popups and their countdown, apart from the board, so the countdown redraws only them
final class ToastCenter: ObservableObject {
    static let seconds: TimeInterval = 8
    static let most = 4
    @Published var toasts: [AttentionToast] = []
    var hovered: UUID?
    // After every change and countdown step: the app places the popups' window
    var onTick: (() -> Void)?
    private var timer: Timer?

    func add(_ toast: AttentionToast) {
        toasts.removeAll { $0.rowId == toast.rowId }
        toasts.insert(toast, at: 0)
        if toasts.count > Self.most { toasts.removeLast(toasts.count - Self.most) }
        if timer == nil {
            let t = Timer(timeInterval: 1.0 / 30, repeats: true) { [weak self] _ in self?.tick(1.0 / 30) }
            RunLoop.main.add(t, forMode: .common)
            timer = t
        }
        onTick?()
    }

    func remove(_ id: UUID) {
        toasts.removeAll { $0.id == id }
        onTick?()
    }

    // A session's popup, once you're on that session
    func removeRow(_ rowId: String) {
        guard toasts.contains(where: { $0.rowId == rowId }) else { return }
        toasts.removeAll { $0.rowId == rowId }
        onTick?()
    }

    private func tick(_ dt: TimeInterval) {
        for i in toasts.indices where toasts[i].id != hovered { toasts[i].elapsed += dt }
        toasts.removeAll { $0.elapsed >= Self.seconds }
        if toasts.isEmpty {
            timer?.invalidate()
            timer = nil
            hovered = nil
        }
        onTick?()
    }
}

// The popup is small, only as big as a card's number needs: 40 points (with a badge and a heavy
// outline it looked bulky; at 26 points, too small). The session's number in its colour, the thin white outline running down around it, and a dot, amber
// when it wants you, grey when it's done. Hovering shows its name and why, and turns
// the dot into ×.
struct ToastCard: View {
    let toast: AttentionToast
    // 1 when it appears, 0 when it goes: how much of the outline is left
    let progress: Double
    let p: Palette
    let onOpen: () -> Void
    let onClose: () -> Void
    let onHover: (Bool) -> Void
    @State private var hovering = false

    var body: some View {
        let label = ["Needs you", "Your turn", "Done"][min(max(toast.kind, 0), 2)]
        let square: (fill: Color, ink: Color) = {
            if let s = swatch(toast.colorName) {
                let v = p.isDark ? s.dark : s.light
                return (hex(v), inkFor(v))
            }
            return toast.kind == 2 ? (p.idle, p.idleInk) : (p.amber, p.amberInk)
        }()
        Text(String(format: "%02d", toast.number))
            .font(.system(size: 15, weight: .bold, design: .monospaced)).foregroundStyle(square.ink)
            .frame(width: 40, height: 40)
            .background(RoundedRectangle(cornerRadius: 9).fill(square.fill))
            // The countdown: the white outline shrinks around the tile until it's gone
            .overlay(RoundedRectangle(cornerRadius: 11.5).inset(by: -2.5).trim(from: 0, to: progress)
                .stroke(p.text, style: StrokeStyle(lineWidth: 1.5, lineCap: .round)))
            .overlay(alignment: .topTrailing) {
                Button(action: onClose) {
                    ZStack {
                        Circle().fill(hovering ? p.text : toast.kind == 2 ? p.idle : p.amber)
                        if hovering { Image(systemName: "xmark").font(.system(size: 7, weight: .heavy)).foregroundStyle(p.gap) }
                    }
                    .frame(width: hovering ? 14 : 9, height: hovering ? 14 : 9)
                    .overlay(Circle().stroke(p.gap, lineWidth: 1.5))
                    .frame(width: 16, height: 16).contentShape(Circle())
                }
                .buttonStyle(.plain).offset(x: 6, y: -6).help("Close")
            }
            .shadow(color: .black.opacity(p.isDark ? 0.35 : 0.12), radius: 3, y: 1)
            .contentShape(Rectangle())
            .onTapGesture(perform: onOpen)
            .onHover { inside in
                hovering = inside
                onHover(inside)
                if inside { NSCursor.pointingHand.push() } else { NSCursor.pop() }
            }
            .help(String(format: "%02d", toast.number) + " · " + toast.name + "\n" + label + (toast.detail.isEmpty ? "" : ": " + toast.detail) + "\nClick to open")
    }
}

struct ToastStack: View {
    @ObservedObject var center: ToastCenter
    @ObservedObject var board: Board

    var body: some View {
        let p = board.isDark ? Palette.dark : Palette.light
        VStack(alignment: .trailing, spacing: 9) {
            ForEach(center.toasts) { t in
                ToastCard(toast: t, progress: max(0, 1 - t.elapsed / ToastCenter.seconds), p: p,
                          onOpen: {
                              if let row = board.rows.first(where: { $0.id == t.rowId }) { openSession(row) }
                              center.remove(t.id)
                          },
                          onClose: { center.remove(t.id) },
                          onHover: { inside in
                              if inside { center.hovered = t.id } else if center.hovered == t.id { center.hovered = nil }
                          })
            }
        }
        // Room for the outline, the dot and the shadow
        .padding(8)
        .environment(\.colorScheme, board.isDark ? .dark : .light)
    }
}

// The popups' window: floats just above the board, never takes the keyboard or the front
final class ToastPanel: NSPanel {
    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }
}

// Where the popups go: whichever side of the board is free, left first. Left of the board, else
// right of it, else above, else below. With no room on any side (a board as wide and tall as the
// screen), over the board itself, just under its header, which always fits.
// Beside the board, its top sits `below` points under the board's top: in line with the first card.
func toastFrame(size: NSSize, board b: NSRect, screen s: NSRect, below: CGFloat = 0, gap: CGFloat = 4) -> (frame: NSRect, side: String) {
    let w = size.width, h = size.height
    let topY = min(max(b.maxY - below - h, s.minY), s.maxY - h)
    if b.minX - gap - w >= s.minX { return (NSRect(x: b.minX - gap - w, y: topY, width: w, height: h), "left") }
    if b.maxX + gap + w <= s.maxX { return (NSRect(x: b.maxX + gap, y: topY, width: w, height: h), "right") }
    let x = min(max(b.midX - w / 2, s.minX), s.maxX - w)
    if b.maxY + gap + h <= s.maxY { return (NSRect(x: x, y: b.maxY + gap, width: w, height: h), "above") }
    if b.minY - gap - h >= s.minY { return (NSRect(x: x, y: b.minY - gap - h, width: w, height: h), "below") }
    return (NSRect(x: x, y: max(b.maxY - 70 - h, s.minY), width: w, height: h), "over")
}

struct UndoToast: View {
    let name: String
    var showsKey = true
    let p: Palette
    let undo: () -> Void

    var body: some View {
        HStack(spacing: 10) {
            Text(name + " dismissed").font(.system(size: 12)).foregroundStyle(hex(0xDADADF)).lineLimit(1).truncationMode(.middle)
            Spacer(minLength: 4)
            Button(action: undo) {
                HStack(spacing: 6) {
                    Text("Undo").font(.system(size: 12, weight: .semibold)).foregroundStyle(hex(0xF2F2F3))
                    if showsKey {
                        Text("⌘Z").font(.system(size: 10, weight: .semibold, design: .monospaced)).foregroundStyle(hex(0xB4B5B9))
                            .padding(.horizontal, 4).overlay(RoundedRectangle(cornerRadius: 3).stroke(hex(0x55565C), lineWidth: 1))
                    }
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
        }
        .padding(.leading, 12).padding(.trailing, 10).padding(.vertical, 9)
        .background(RoundedRectangle(cornerRadius: 8).fill(hex(0x26272B)).shadow(color: .black.opacity(0.5), radius: 12, y: 8))
        .overlay(RoundedRectangle(cornerRadius: 8).stroke(hex(0x3A3B40), lineWidth: 1))
    }
}

// The settings' controls: colourless, since every colour on the board already means a state
struct BoardSwitch: View {
    @Binding var isOn: Bool
    let p: Palette
    var small = false

    var body: some View {
        let w: CGFloat = small ? 26 : 30, h: CGFloat = small ? 16 : 18
        Button { isOn.toggle() } label: {
            Capsule().fill(isOn ? p.switchOn : p.switchOff).frame(width: w, height: h)
                .overlay(Capsule().strokeBorder(isOn ? Color.clear : p.switchOffBorder, lineWidth: 1))
                .overlay(alignment: isOn ? .trailing : .leading) { Circle().fill(isOn ? p.knobOn : p.knobOff).frame(width: h - 4, height: h - 4).padding(2) }
                .animation(.easeOut(duration: 0.15), value: isOn)
                .contentShape(Capsule())
        }
        .buttonStyle(.plain)
    }
}

struct TwoWay: View {
    let options: [String]
    let selected: Int
    let p: Palette
    let onSelect: (Int) -> Void

    var body: some View {
        HStack(spacing: 2) {
            ForEach(options.indices, id: \.self) { i in
                Button { onSelect(i) } label: {
                    Text(options[i]).font(.system(size: 11.5, weight: .semibold))
                        .foregroundStyle(i == selected ? p.cell : p.soft)
                        .padding(.horizontal, 9).padding(.vertical, 4)
                        .background(RoundedRectangle(cornerRadius: 4).fill(i == selected ? p.text : Color.clear))
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            }
        }
        .padding(2).background(RoundedRectangle(cornerRadius: 6).fill(p.segTrack))
    }
}

struct SettingLine<Control: View>: View {
    let title: String
    let detail: String
    let p: Palette
    @ViewBuilder let control: Control

    var body: some View {
        HStack(alignment: .center, spacing: 10) {
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(.system(size: 13, weight: .semibold)).foregroundStyle(p.text)
                Text(detail).font(.system(size: 11.5)).foregroundStyle(p.muted).fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 6)
            control
        }
    }
}

struct SectionLabel: View {
    let text: String
    let p: Palette
    var body: some View { Text(text).font(.system(size: 10, weight: .bold, design: .monospaced)).tracking(1.4).foregroundStyle(p.muted) }
}

// Settings, its own page (‹ Sessions goes back)
let appVersion = (Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String) ?? "?"

enum FeedbackKind { case bug, idea }

// Session Board's report inbox (reports-worker/ in the repo): files a report privately for the
// team, with no GitHub account needed
let inboxURL = URL(string: "https://session-board-reports.kiran-987.workers.dev/report")!

// A crash of this app that macOS wrote a report for, as the crash prompt offers to send it:
// the exception and the top of the crashed thread, never anything from the sessions
struct CrashReport {
    let at: Date
    let title: String
    let details: String
}

// The newest crash report since the last one offered, or nil. The first run only notes the time,
// so crashes from before the prompt existed are never offered.
func newCrash() -> CrashReport? {
    let key = "crashSeenAt"
    let seen = UserDefaults.standard.double(forKey: key)
    if seen == 0 {
        UserDefaults.standard.set(Date().timeIntervalSince1970, forKey: key)
        return nil
    }
    let dir = home + "/Library/Logs/DiagnosticReports"
    let fm = FileManager.default
    let newest = ((try? fm.contentsOfDirectory(atPath: dir)) ?? [])
        .filter { $0.hasPrefix("SessionBoard") && $0.hasSuffix(".ips") }
        .compactMap { name -> (String, Date)? in
            guard let at = (try? fm.attributesOfItem(atPath: dir + "/" + name))?[.modificationDate] as? Date,
                  at.timeIntervalSince1970 > seen else { return nil }
            return (name, at)
        }
        .max { $0.1 < $1.1 }
    guard let (name, at) = newest, let text = try? String(contentsOfFile: dir + "/" + name, encoding: .utf8) else { return nil }
    return parseCrash(text, at: at)
}

// An .ips file is a line of JSON (the header) and then the report as JSON
func parseCrash(_ text: String, at: Date) -> CrashReport? {
    guard let nl = text.firstIndex(of: "\n"),
          let body = try? JSONSerialization.jsonObject(with: Data(text[text.index(after: nl)...].utf8)) as? [String: Any] else { return nil }
    let exception = body["exception"] as? [String: Any]
    let type = (exception?["type"] as? String) ?? "crash"
    let signal = (exception?["signal"] as? String) ?? ""
    let images = (body["usedImages"] as? [[String: Any]]) ?? []
    let thread = ((body["threads"] as? [[String: Any]]) ?? []).first { ($0["triggered"] as? Bool) == true } ?? [:]
    let frames = ((thread["frames"] as? [[String: Any]]) ?? []).prefix(10).map { frame -> String in
        let image = (frame["imageIndex"] as? Int).flatMap { images.indices.contains($0) ? images[$0]["name"] as? String : nil } ?? "?"
        let line = (frame["sourceLine"] as? Int).map { " (\((frame["sourceFile"] as? String) ?? "?"):\($0))" } ?? ""
        return "    \(image) \((frame["symbol"] as? String) ?? "?")\(line)"
    }
    // Swift's own message for the crash, such as "Fatal error: Index out of range"
    let messages = ((body["asi"] as? [String: Any]) ?? [:]).values.compactMap { $0 as? [String] }.flatMap { $0 }
    let os = ProcessInfo.processInfo.operatingSystemVersion
    let when = ISO8601DateFormatter().string(from: at)
    let details = """
    ### The window app crashed

    \(type) \(signal) at \(when)
    \(messages.isEmpty ? "" : "\n" + messages.joined(separator: "\n") + "\n")
    ```
    \(frames.joined(separator: "\n"))
    ```

    - Session Board: \(appVersion)
    - macOS: \(os.majorVersion).\(os.minorVersion).\(os.patchVersion)
    """
    return CrashReport(at: at, title: "Window app crashed: \(type)", details: details.replacingOccurrences(of: home, with: "~"))
}

// Sends a crash to the inbox; if it can't be reached, opens GitHub with it filled in instead
func sendCrash(_ crash: CrashReport, done: @escaping (Bool) -> Void) {
    var request = URLRequest(url: inboxURL, timeoutInterval: 15)
    request.httpMethod = "POST"
    request.setValue("application/json", forHTTPHeaderField: "content-type")
    request.httpBody = try? JSONSerialization.data(withJSONObject: ["kind": "crash", "source": "crash", "title": crash.title, "body": crash.details])
    URLSession.shared.dataTask(with: request) { data, response, _ in
        let sent = (response as? HTTPURLResponse)?.statusCode == 201
            && ((data.flatMap { try? JSONSerialization.jsonObject(with: $0) } as? [String: Any])?["ok"] as? Bool) == true
        DispatchQueue.main.async {
            if !sent {
                var url = URLComponents(string: "https://github.com/KiranPothana/session-board/issues/new")!
                url.queryItems = [URLQueryItem(name: "title", value: "Crash: " + crash.title), URLQueryItem(name: "body", value: crash.details)]
                if let link = url.url { NSWorkspace.shared.open(link) }
            }
            done(sent)
        }
    }.resume()
}

// A new GitHub issue, opened in the browser with the versions and settings filled in (never
// anything from the sessions), for the user to describe what happened and send
func openFeedback(_ kind: FeedbackKind, board: Board) {
    let os = ProcessInfo.processInfo.operatingSystemVersion
    var arch = utsname()
    uname(&arch)
    let machine = withUnsafeBytes(of: &arch.machine) { String(decoding: $0.prefix { $0 != 0 }, as: UTF8.self) }
    let settings = [
        "theme=\(board.themeChoice ?? "auto")", "regularWindow=\(board.regularWindow)", "hideWhenAway=\(board.hideWhenAway)",
        "terminalsCount=\(board.terminalsCount)", "soundsOn=\(board.soundsOn)", "summaries=\(board.summaries)",
        "accessibility=\(board.canReadDesktop)",
    ].joined(separator: ", ")
    let body = """
    \(kind == .bug ? "### What happened\n\n\n\n### What you expected" : "### The idea")


    <details><summary>Details sent with the report</summary>

    - Session Board: \(appVersion)
    - macOS: \(os.majorVersion).\(os.minorVersion).\(os.patchVersion) (\(machine))
    - Settings: \(settings)
    - Sessions on the board: \(board.rows.count)
    </details>

    _Sent from the Session Board window._
    """
    var url = URLComponents(string: "https://github.com/KiranPothana/session-board/issues/new")!
    url.queryItems = [URLQueryItem(name: "title", value: kind == .bug ? "Bug: " : "Idea: "), URLQueryItem(name: "body", value: body)]
    if let link = url.url { NSWorkspace.shared.open(link) }
}

struct SettingsPage: View {
    @ObservedObject var board: Board
    let p: Palette

    var body: some View {
        ScrollView { SettingsContent(board: board, p: p) }.background(p.cell)
    }
}

// The settings without their scroll view, so a snapshot can render them
struct SettingsContent: View {
    @ObservedObject var board: Board
    let p: Palette
    private var app: AppDelegate? { NSApp?.delegate as? AppDelegate }

    var body: some View {
            VStack(spacing: 1) {
                VStack(alignment: .leading, spacing: 12) {
                    SectionLabel(text: "WINDOW", p: p)
                    SettingLine(title: "Floating or Regular",
                                detail: board.regularWindow
                                    ? "A normal window with a Dock icon. Other windows can cover it, and it doesn't show over full-screen apps."
                                    : "Floating stays above other apps, on every Space.", p: p) {
                        TwoWay(options: ["Floating", "Regular"], selected: board.regularWindow ? 1 : 0, p: p) { board.regularWindow = $0 == 1 }
                    }
                    // A regular window stays where you put it: hiding it on an app switch is the popup's
                    if !board.regularWindow {
                        SettingLine(title: "Hide when you switch away", detail: "Shows only while Claude is in front.", p: p) {
                            BoardSwitch(isOn: $board.hideWhenAway, p: p)
                        }
                        SettingLine(title: "Terminals and editors count as Claude", detail: "Terminal, iTerm2, Ghostty, Warp, VS\u{00A0}Code, Cursor.", p: p) {
                            BoardSwitch(isOn: $board.terminalsCount, p: p)
                        }
                        .padding(.leading, 14).disabled(!board.hideWhenAway).opacity(board.hideWhenAway ? 1 : 0.45)
                    }
                }
                .settingsCell(p)

                HStack(spacing: 10) {
                    VStack(alignment: .leading, spacing: 6) {
                        SectionLabel(text: "THEME", p: p)
                        Text(board.themeChoice == nil ? "Like Claude Desktop until you pick one." : "Stays as you picked it.")
                            .font(.system(size: 11.5)).foregroundStyle(p.muted).fixedSize(horizontal: false, vertical: true)
                    }
                    Spacer(minLength: 6)
                    TwoWay(options: ["Light", "Dark"], selected: board.isDark ? 1 : 0, p: p) { board.themeChoice = $0 == 1 ? "dark" : "light" }
                }
                .settingsCell(p)

                VStack(alignment: .leading, spacing: 6) {
                    SectionLabel(text: "NAMES", p: p)
                    SettingLine(title: "Project first", detail: "Each name starts with its project: the Git repo or folder the session runs in.", p: p) {
                        BoardSwitch(isOn: $board.projectNames, p: p)
                    }
                    SettingLine(title: "Also rename in Claude Code", detail: "Advanced. Renames each session once, so Claude Code and Claude Desktop show the project too. A new session's first message waits up to 4 s for its name (one small Sonnet call).", p: p) {
                        BoardSwitch(isOn: $board.renameSessions, p: p)
                    }
                    .padding(.leading, 14).disabled(!board.projectNames).opacity(board.projectNames ? 1 : 0.45)
                }
                .settingsCell(p)

                VStack(alignment: .leading, spacing: 6) {
                    SectionLabel(text: "SUMMARIES", p: p)
                    SettingLine(title: "Summaries by Sonnet", detail: "A few small calls per turn, on your account. Off: each card shows what you asked and its task list.", p: p) {
                        BoardSwitch(isOn: $board.summaries, p: p)
                    }
                }
                .settingsCell(p)

                VStack(alignment: .leading, spacing: 6) {
                    SectionLabel(text: "SOUNDS", p: p)
                    SettingLine(title: "Sounds", detail: "Never for ordinary work, never for the session you're viewing.", p: p) {
                        BoardSwitch(isOn: $board.soundsOn, p: p)
                    }
                    VStack(spacing: 10) {
                        AlertVolumeBars(board: board, p: p)
                        soundRow("Needs you", "A permission prompt or a question", dot: p.amber, moment: 0, isOn: $board.soundNeedsYou)
                        soundRow("Your turn", "A turn ends with something for you", dot: p.amber, moment: 1, isOn: $board.soundYourTurn)
                        soundRow("Done", "Finished, with nothing left running", dot: p.idle, moment: 2, isOn: $board.soundDone)
                        if let error = board.soundError {
                            Text(error).font(.system(size: 11)).foregroundStyle(p.amberText).fixedSize(horizontal: false, vertical: true)
                        }
                    }
                    .padding(.top, 6)
                    .disabled(!board.soundsOn).opacity(board.soundsOn ? 1 : 0.45)
                }
                .settingsCell(p)

                VStack(alignment: .leading, spacing: 6) {
                    SectionLabel(text: "DESKTOP HIGHLIGHT", p: p)
                    SettingLine(title: board.canReadDesktop ? "Accessibility is on" : "Accessibility is off",
                                detail: board.canReadDesktop ? "The session open in Claude Desktop gets its highlight box."
                                    : "Turn on Session Board in Accessibility, and the session open in Claude Desktop gets its highlight box.", p: p) {
                        QuietButton(title: "Open", p: p) {
                            NSWorkspace.shared.open(URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility")!)
                        }
                    }
                }
                .settingsCell(p)

                VStack(alignment: .leading, spacing: 6) {
                    SectionLabel(text: "SHORTCUT", p: p)
                    SettingLine(title: "Show or hide, from any app", detail: board.recording ? "Press the new keys, or tap a right-hand ⌥, ⌘ or ⌃. Esc cancels." : "Click, then press the new keys, or tap a right-hand ⌥, ⌘ or ⌃. Esc cancels.", p: p) {
                        HStack(spacing: 8) {
                            if board.shortcut != .standard && !board.recording {
                                Button("Reset") { app?.useShortcut(.standard) }
                                    .buttonStyle(.plain).font(.system(size: 11)).foregroundStyle(p.muted).help("Back to \(Shortcut.standard.display)")
                            }
                            Button {
                                if board.recording { app?.stopRecording() } else { app?.startRecording() }
                            } label: {
                                Text(board.recording ? (board.heldModifiers.isEmpty ? "Type it…" : board.heldModifiers + "…")
                                     : (board.pendingShortcut ?? board.shortcut).display)
                                    .font(.system(size: 12, weight: .bold, design: .monospaced)).foregroundStyle(p.text)
                                    .padding(.horizontal, 10).padding(.vertical, 4)
                                    .background(RoundedRectangle(cornerRadius: 6).fill(p.segTrack))
                                    .overlay(RoundedRectangle(cornerRadius: 6).stroke(board.recording ? p.text : board.pendingShortcut != nil ? p.amber : p.keyBorder,
                                                                                        lineWidth: board.recording ? 1.5 : 1))
                                    .contentShape(Rectangle())
                            }
                            .buttonStyle(.plain).help(board.recording ? "Click to cancel" : "Click, then press the new keys")
                        }
                    }
                    if let error = board.shortcutError {
                        Text(error).font(.system(size: 11)).foregroundStyle(p.amberText).fixedSize(horizontal: false, vertical: true)
                    }
                    if let pending = board.pendingShortcut {
                        VStack(alignment: .leading, spacing: 6) {
                            ForEach(board.shortcutClashNotes, id: \.self) { note in
                                Text(note).font(.system(size: 11)).foregroundStyle(p.amberText).fixedSize(horizontal: false, vertical: true)
                            }
                            HStack(spacing: 8) {
                                QuietButton(title: "Use \(pending.display) anyway", p: p) { app?.useShortcut(pending) }
                                QuietButton(title: "Pick another", p: p) { app?.startRecording() }
                            }
                        }
                        .padding(.top, 2)
                    }
                }
                .settingsCell(p)

                VStack(alignment: .leading, spacing: 6) {
                    SectionLabel(text: "FEEDBACK", p: p)
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Something wrong, or an idea?").font(.system(size: 13, weight: .semibold)).foregroundStyle(p.text)
                        Text("Opens GitHub with your versions filled in. Or tell Claude in any session, and say report.")
                            .font(.system(size: 11.5)).foregroundStyle(p.muted).fixedSize(horizontal: false, vertical: true)
                    }
                    HStack(spacing: 8) {
                        QuietButton(title: "Report a problem", p: p) { openFeedback(.bug, board: board) }
                        QuietButton(title: "Suggest an idea", p: p) { openFeedback(.idea, board: board) }
                    }
                    .padding(.top, 4)
                    HStack {
                        Text("Session Board " + appVersion)
                        Spacer()
                    }
                    .font(.system(size: 10.5, design: .monospaced)).foregroundStyle(p.prefix).padding(.top, 14)
                }
                .settingsCell(p)
            }
            .background(p.gap)
    }

    func soundRow(_ title: String, _ detail: String, dot: Color, moment: Int, isOn: Binding<Bool>) -> some View {
        let choice = board.soundChoices.indices.contains(moment) ? board.soundChoices[moment] : defaultSoundChoices[moment]
        let open = board.openSoundPicker == moment
        return VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .top, spacing: 10) {
                Circle().fill(dot).frame(width: 6, height: 6).frame(width: 10).padding(.top, 5)
                VStack(alignment: .leading, spacing: 1) {
                    Text(title).font(.system(size: 12.5, weight: .semibold)).foregroundStyle(p.text)
                    Text(detail).font(.system(size: 11)).foregroundStyle(p.muted).fixedSize(horizontal: false, vertical: true)
                    Button {
                        board.openSoundPicker = open ? nil : moment
                        board.soundError = nil
                    } label: {
                        HStack(spacing: 4) {
                            Text(soundName(choice)).font(.system(size: 11, weight: .semibold, design: .monospaced))
                            Image(systemName: open ? "chevron.up" : "chevron.down").font(.system(size: 8, weight: .bold))
                        }
                        .foregroundStyle(open ? p.text : p.soft).contentShape(Rectangle())
                    }
                    .buttonStyle(.plain).padding(.top, 3).help(open ? "Close" : "Choose the sound")
                }
                Spacer(minLength: 4)
                Button { playSound(choice, fallback: defaultSoundChoices[moment]) } label: {
                    Text("▶ Play").font(.system(size: 11, weight: .semibold, design: .monospaced)).foregroundStyle(p.doing)
                        .padding(.horizontal, 6).padding(.vertical, 2)
                        .overlay(RoundedRectangle(cornerRadius: 4).stroke(p.chipBorder, lineWidth: 1)).contentShape(Rectangle())
                }
                .buttonStyle(.plain).help("Play the \(title.lowercased()) sound")
                BoardSwitch(isOn: isOn, p: p, small: true)
            }
            if open {
                SoundChooser(choice: choice, defaultChoice: defaultSoundChoices[moment], p: p) { board.chooseSound($0, for: moment) }
                    onAdd: { app?.addCustomSound(for: moment) }
                    .padding(.leading, 20)
            }
        }
    }
}

// Alert volume as bars: "Mine" (leave the volume alone), then 10% to 100%. A click sets it and plays
// a sample at that volume. Clicks rather than a drag, so it never starts a text selection.
struct AlertVolumeBars: View {
    @ObservedObject var board: Board
    let p: Palette

    var body: some View {
        let level = Int((board.alertVolume * 10).rounded())
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 8) {
                Text("Alert volume").font(.system(size: 12.5, weight: .semibold)).foregroundStyle(p.text)
                Spacer(minLength: 4)
                Text(level == 0 ? "Your volume" : "\(level * 10)%").font(.system(size: 11, weight: .semibold, design: .monospaced))
                    .foregroundStyle(p.soft)
            }
            HStack(alignment: .bottom, spacing: 3) {
                Button { board.alertVolume = 0 } label: {
                    Text("Mine").font(.system(size: 11, weight: .semibold))
                        .foregroundStyle(level == 0 ? p.cell : p.soft)
                        .padding(.horizontal, 7).frame(height: 20)
                        .background(RoundedRectangle(cornerRadius: 4).fill(level == 0 ? p.text : p.segTrack))
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain).help("Leave the Mac's volume as it is").padding(.trailing, 5)
                ForEach(1...10, id: \.self) { step in
                    Button {
                        board.alertVolume = Double(step) / 10
                        playAlert(board.soundChoices.first ?? defaultSoundChoices[0], fallback: defaultSoundChoices[0], volume: Float32(step) / 10)
                    } label: {
                        RoundedRectangle(cornerRadius: 2)
                            .fill(level > 0 && step <= level ? p.text : p.segTrack)
                            .frame(width: 14, height: 8 + CGFloat(step) * 1.2)
                            .frame(height: 20, alignment: .bottom)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain).help("\(step * 10)%")
                }
            }
            Text(level == 0 ? "Sounds play at your Mac's volume." : "Sounds that play on their own play at this volume, then yours goes back.")
                .font(.system(size: 11)).foregroundStyle(p.muted).fixedSize(horizontal: false, vertical: true)
        }
        .padding(.top, 4)
    }
}

// The sound a moment plays, chosen in the board's own style, under its row: Default (shown by
// its sound's name once picked), then the board's three, macOS's, Kenney's and yours, as chips.
// Picking one plays it.
struct SoundChooser: View {
    let choice: String
    let defaultChoice: String
    let p: Palette
    let onPick: (String) -> Void
    let onAdd: () -> Void

    var body: some View {
        let custom = customSounds()
        VStack(alignment: .leading, spacing: 10) {
            group("DEFAULT", [SoundOption(id: defaultChoice, name: "Default · " + soundName(defaultChoice))])
            group("SESSION BOARD", boardSounds)
            group("MAC ALERTS", systemSounds)
            group("KENNEY · CC0", kenneySounds)
            VStack(alignment: .leading, spacing: 6) {
                SectionLabel(text: "YOURS", p: p)
                FlowLayout(spacing: 6) {
                    ForEach(custom, id: \.self) { option in
                        SoundChip(option: option, selected: option.id == choice, p: p, onPick: { onPick(option.id) },
                                  onRemove: { removeCustomSound(option.id) })
                    }
                    Button(action: onAdd) {
                        Text("+ Add your own…").font(.system(size: 11.5, weight: .semibold)).foregroundStyle(p.soft)
                            .padding(.horizontal, 8).padding(.vertical, 4)
                            .overlay(RoundedRectangle(cornerRadius: 5).strokeBorder(p.chipBorder, style: StrokeStyle(lineWidth: 1, dash: [3, 2])))
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain).help("A file of yours: under 10 seconds and 5 MB")
                }
            }
        }
        .padding(10)
        .background(RoundedRectangle(cornerRadius: 8).fill(p.sunken))
        .overlay(RoundedRectangle(cornerRadius: 8).stroke(p.gap, lineWidth: 1))
    }

    func group(_ title: String, _ options: [SoundOption]) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            SectionLabel(text: title, p: p)
            FlowLayout(spacing: 6) {
                ForEach(options, id: \.self) { option in
                    SoundChip(option: option, selected: option.id == choice, p: p, onPick: { onPick(option.id) })
                }
            }
        }
    }
}

// One sound: white when chosen, like the board's other selected controls; yours carry an × on hover
struct SoundChip: View {
    let option: SoundOption
    let selected: Bool
    let p: Palette
    let onPick: () -> Void
    var onRemove: (() -> Void)?
    @State private var hovering = false

    var body: some View {
        HStack(spacing: 4) {
            Button(action: onPick) {
                Text(option.name).font(.system(size: 11.5, weight: .semibold)).lineLimit(1)
                    .foregroundStyle(selected ? p.cell : hovering ? p.text : p.soft)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            if let onRemove, hovering {
                Button(action: onRemove) {
                    Image(systemName: "xmark").font(.system(size: 7, weight: .bold)).foregroundStyle(selected ? p.cell : p.soft)
                        .frame(width: 12, height: 12).contentShape(Rectangle())
                }
                .buttonStyle(.plain).help("Remove this sound")
            }
        }
        .padding(.horizontal, 8).padding(.vertical, 4)
        .background(RoundedRectangle(cornerRadius: 5).fill(selected ? p.text : hovering ? p.chipBorder.opacity(0.6) : p.segTrack))
        .onHover { hovering = $0 }
    }
}

// Lays its views out in rows, wrapping to the width it's given
struct FlowLayout: Layout {
    var spacing: CGFloat = 6

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let width = proposal.width ?? .infinity
        var x: CGFloat = 0, y: CGFloat = 0, row: CGFloat = 0, widest: CGFloat = 0
        for view in subviews {
            let size = view.sizeThatFits(.unspecified)
            if x > 0 && x + size.width > width {
                x = 0
                y += row + spacing
                row = 0
            }
            x += size.width + spacing
            row = max(row, size.height)
            widest = max(widest, x - spacing)
        }
        return CGSize(width: width.isFinite ? width : widest, height: y + row)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var x = bounds.minX, y = bounds.minY, row: CGFloat = 0
        for view in subviews {
            let size = view.sizeThatFits(.unspecified)
            if x > bounds.minX && x + size.width > bounds.maxX {
                x = bounds.minX
                y += row + spacing
                row = 0
            }
            view.place(at: CGPoint(x: x, y: y), proposal: ProposedViewSize(size))
            x += size.width + spacing
            row = max(row, size.height)
        }
    }
}

// A file of yours goes; any moment that played it goes back to its own sound
func removeCustomSound(_ id: String) {
    guard let url = soundURL(id), id.hasPrefix("custom:") else { return }
    try? FileManager.default.removeItem(at: url)
    if let board = (NSApp.delegate as? AppDelegate)?.board {
        board.soundChoices = board.soundChoices.enumerated().map { $0.element == id ? defaultSoundChoices[$0.offset] : $0.element }
    }
}

extension View {
    func settingsCell(_ p: Palette) -> some View {
        padding(.horizontal, 14).padding(.vertical, 12).frame(maxWidth: .infinity, alignment: .leading).background(p.cell)
    }
}

// The cards, in the order the list shows them
struct CardsList: View {
    @ObservedObject var board: Board
    let p: Palette

    var body: some View {
        let prefixes = board.sharedPrefixes
        VStack(spacing: 1) {
            ForEach(Array(board.shown.enumerated()), id: \.element.id) { index, row in
                SessionCard(row: row, name: board.shownName(row), number: index + 1, prefix: prefixes[row.id], viewing: row.id == board.focusedId,
                            jobs: board.jobs[row.id] ?? [], removed: board.removedItems[row.id] ?? [], summariesOff: !board.summaries, selectable: true,
                            colorName: board.colorName(row.id), picked: board.sessionColors[row.id] != nil, p: p,
                            onDismiss: { board.dismiss(row) },
                            onRemove: { board.removeItem($0, of: row.id) },
                            onRestore: { board.restoreItem($0, of: row.id) },
                            onRestoreAll: { board.removedItems[row.id] = nil },
                            onPickColor: { board.sessionColors[row.id] = $0 },
                            onOpen: { openSession(row) })
                    .id(row.id)
            }
        }
        .background(p.gap)
    }
}

struct BoardView: View {
    @ObservedObject var board: Board
    // You scrolled the list yourself: stop keeping the highlighted session at the top until
    // you switch sessions
    @State private var userScrolled = false
    @State private var followedIndex: Int?

    var body: some View {
        let p = board.isDark ? Palette.dark : Palette.light
        VStack(spacing: 1) {
            HeaderView(board: board, p: p)
            if !board.showSettings { NeedsYouStrip(board: board, p: p, showsNone: board.collapsed) }
            if board.collapsed {
                EmptyView()
            } else if board.showSettings {
                SettingsPage(board: board, p: p)
            } else {
                if board.crash != nil { CrashNote(board: board, p: p) }
                if !board.canReadDesktop && board.desktopRunning { AccessibilityNote(p: p) }
                if board.shown.isEmpty {
                    EmptyBoard(p: p).overlay(alignment: .bottom) { toast(p) }
                } else {
                    ScrollViewReader { proxy in
                        ScrollView { CardsList(board: board, p: p) }
                            .background(p.cell)
                            // Where the top session shows, however far the list is scrolled
                            .background {
                                GeometryReader { g in
                                    Color.clear
                                        .onAppear { board.listTop = g.frame(in: .global).minY }
                                        .onChange(of: g.frame(in: .global).minY) { _, top in board.listTop = top }
                                        .onDisappear { board.listTop = nil }
                                }
                            }
                            // Over the bottom of the list, which scrolls clear of it, and never over Dismissed
                            .safeAreaInset(edge: .bottom, spacing: 0) { toast(p) }
                            .onChange(of: board.scrollRequest) { _, id in
                                guard let id else { return }
                                userScrolled = true
                                withAnimation(.easeOut(duration: 0.25)) { proxy.scrollTo(id, anchor: .top) }
                                board.scrollRequest = nil
                            }
                            .onScrollPhaseChange { _, phase in
                                if phase == .interacting || phase == .tracking { userScrolled = true }
                            }
                            .onChange(of: board.focusedId) { _, _ in
                                userScrolled = false
                                follow(proxy, animated: true)
                            }
                            .onReceive(board.$rows) { _ in
                                DispatchQueue.main.async { if !userScrolled { follow(proxy, animated: nil) } }
                            }
                            .onAppear {
                                userScrolled = false
                                DispatchQueue.main.async { follow(proxy, animated: false) }
                            }
                    }
                }
                if !board.hidden.isEmpty { DismissedSection(board: board, p: p) }
            }
        }
        .background(p.gap)
        .animation(.easeOut(duration: 0.2), value: board.undoable?.id)
        .frame(minWidth: 260)
    }

    // "… dismissed · Undo ⌘Z", for six seconds
    @ViewBuilder func toast(_ p: Palette) -> some View {
        if let last = board.undoable {
            UndoToast(name: last.name, showsKey: board.regularWindow, p: p) { board.undoDismiss() }
                .padding(.horizontal, 14).padding(.vertical, 12)
                .transition(.move(edge: .bottom).combined(with: .opacity))
        }
    }

    // animated nil: animate only when the row moved to another place in the list
    func follow(_ proxy: ScrollViewProxy, animated: Bool?) {
        guard let id = board.focusedId, let index = board.shown.firstIndex(where: { $0.id == id }) else { return }
        let moved = index != followedIndex
        followedIndex = index
        if animated ?? moved {
            withAnimation(.easeOut(duration: 0.25)) { proxy.scrollTo(id, anchor: .top) }
        } else {
            proxy.scrollTo(id, anchor: .top)
        }
    }
}

// The floating board's default size, tall enough for four or five cards
let defaultSize = NSSize(width: 330, height: 705)

// The window's first frame, as a share of the screen's usable area, so it fits any screen the
// way it does on the Mac it was tuned on: there the floating board is 330 x 705, flush with the
// right edge and its top 23% of the way down, on 1728 x 1025; a regular window is 764 x 458,
// centred. (app/ui/geometry.js does the same on Windows and Linux.)
func defaultFrame(on s: NSRect, regular: Bool) -> NSRect {
    func clamp(_ v: CGFloat, _ lo: CGFloat, _ hi: CGFloat) -> CGFloat { max(lo, min(hi, v)) }
    if regular {
        let w = round(clamp(s.width * 764 / 1728, 560, min(1100, s.width)))
        let h = round(clamp(s.height * 458 / 1025, 360, min(760, s.height)))
        return NSRect(x: round(s.midX - w / 2), y: round(s.midY - h / 2), width: w, height: h)
    }
    let w = round(clamp(s.width * 330 / 1728, 300, min(520, s.width)))
    let h = round(clamp(s.height * 705 / 1025, 420, min(900, s.height)))
    let top = round(clamp(s.maxY - s.height * 235 / 1025, s.minY + h, s.maxY))
    return NSRect(x: s.maxX - w, y: top - h, width: w, height: h)
}

// A wider grab band along the window's four edges, and larger corners, for resizing: the
// system's own band is a few points wide, and the cards run right to the edge. Everywhere
// else, clicks go through to the board.
final class ResizeEdges: NSView {
    let band: CGFloat = 6
    let corner: CGFloat = 16
    private var startMouse = NSPoint.zero
    private var startFrame = NSRect.zero
    private var dragging: (left: Bool, right: Bool, top: Bool, bottom: Bool)?
    private var showingResizeCursor = false

    override func hitTest(_ point: NSPoint) -> NSView? {
        edges(at: convert(point, from: superview)) != nil ? self : nil
    }

    // Which edges a point is on; near a corner, both. A collapsed window resizes only sideways.
    func edges(at p: NSPoint) -> (left: Bool, right: Bool, top: Bool, bottom: Bool)? {
        let b = bounds
        guard b.contains(p) else { return nil }
        let vertical = (NSApp.delegate as? AppDelegate)?.board.collapsed != true
        var left = p.x < band, right = p.x > b.width - band
        var bottom = vertical && p.y < band, top = vertical && p.y > b.height - band
        if left || right {
            bottom = bottom || (vertical && p.y < corner)
            top = top || (vertical && p.y > b.height - corner)
        }
        if top || bottom {
            left = left || p.x < corner
            right = right || p.x > b.width - corner
        }
        return left || right || top || bottom ? (left, right, top, bottom) : nil
    }

    func cursor(for e: (left: Bool, right: Bool, top: Bool, bottom: Bool)) -> NSCursor {
        let position: NSCursor.FrameResizePosition =
            e.top ? (e.left ? .topLeft : e.right ? .topRight : .top)
            : e.bottom ? (e.left ? .bottomLeft : e.right ? .bottomRight : .bottom)
            : e.left ? .left : .right
        return NSCursor.frameResize(position: position, directions: .all)
    }

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        trackingAreas.forEach(removeTrackingArea)
        addTrackingArea(NSTrackingArea(rect: .zero, options: [.mouseMoved, .mouseEnteredAndExited, .activeAlways, .inVisibleRect],
                                       owner: self, userInfo: nil))
    }

    override func mouseMoved(with event: NSEvent) {
        guard dragging == nil else { return }
        if let e = edges(at: convert(event.locationInWindow, from: nil)) {
            cursor(for: e).set()
            showingResizeCursor = true
        } else if showingResizeCursor {
            NSCursor.arrow.set()
            showingResizeCursor = false
        }
    }

    override func mouseExited(with event: NSEvent) {
        if showingResizeCursor && dragging == nil {
            NSCursor.arrow.set()
            showingResizeCursor = false
        }
    }

    override func mouseDown(with event: NSEvent) {
        guard let window, let e = edges(at: convert(event.locationInWindow, from: nil)) else { return }
        dragging = e
        startMouse = NSEvent.mouseLocation
        startFrame = window.frame
    }

    override func mouseDragged(with event: NSEvent) {
        guard let window, let e = dragging else { return }
        let now = NSEvent.mouseLocation
        let dx = now.x - startMouse.x, dy = now.y - startMouse.y
        let minSize = window.minSize, maxSize = window.maxSize
        var f = startFrame
        if e.right { f.size.width = min(maxSize.width, max(minSize.width, startFrame.width + dx)) }
        if e.left {
            f.size.width = min(maxSize.width, max(minSize.width, startFrame.width - dx))
            f.origin.x = startFrame.maxX - f.width
        }
        if e.top { f.size.height = min(maxSize.height, max(minSize.height, startFrame.height + dy)) }
        if e.bottom {
            f.size.height = min(maxSize.height, max(minSize.height, startFrame.height - dy))
            f.origin.y = startFrame.maxY - f.height
        }
        window.setFrame(f, display: true)
    }

    override func mouseUp(with event: NSEvent) {
        dragging = nil
    }
}

// The regular window's default: 5:3, wide enough for long names
let regularDefaultSize = NSSize(width: 765, height: 459)

// How far the mouse moves with the button down before it's a drag that selects text (and takes the
// keyboard for ⌘C). A trackpad click can wobble a few points: at 3 an ordinary click took the
// keyboard away from Claude Desktop, so typing there stopped working.
let selectDragDistance: CGFloat = 10

// Each time the floating board takes the keyboard, and why, so a lost cursor can be traced:
// ~/Library/Application Support/session-board/keyboard.log
func logKeyboard(_ why: String) {
    let path = appDir + "/keyboard.log"
    let line = ISO8601DateFormatter().string(from: Date()) + "  " + why + "\n"
    if let size = (try? FileManager.default.attributesOfItem(atPath: path))?[.size] as? Int, size > 100_000 {
        try? FileManager.default.removeItem(atPath: path)
    }
    if let handle = FileHandle(forWritingAtPath: path) {
        handle.seekToEndOfFile()
        handle.write(Data(line.utf8))
        try? handle.close()
    } else {
        try? line.write(toFile: path, atomically: true, encoding: .utf8)
    }
}

// The popup: never makes this app the front one, so Claude Desktop stays in front, and answers
// ⌘C and ⌘A itself, since an app with no Dock icon has no Edit menu to route them
final class BoardPanel: NSPanel {
    // A click on the floating board never takes the keyboard, so the text cursor stays where you
    // left it, in Claude Desktop or a terminal, and typing goes on there. It takes it only while text is being selected (until ⌘C) or a new
    // shortcut is being typed.
    var wantsKeyboard = false
    override var canBecomeKey: Bool { wantsKeyboard }

    // Selecting text needs the keyboard for ⌘C: a drag across the board takes it (a click never
    // does), and ⌘C, or clicking another app, gives it back
    private var downAt: NSPoint?
    private(set) var selecting = false

    override func sendEvent(_ event: NSEvent) {
        switch event.type {
        case .leftMouseDown:
            // Not a drag on the resize edges or a scroll bar
            let hit = contentView?.hitTest(contentView?.convert(event.locationInWindow, from: nil) ?? .zero)
            downAt = hit is ResizeEdges || hit is NSScroller ? nil : event.locationInWindow
        case .leftMouseDragged:
            if let start = downAt, !wantsKeyboard,
               hypot(event.locationInWindow.x - start.x, event.locationInWindow.y - start.y) > selectDragDistance {
                selecting = true
                wantsKeyboard = true
                makeKey()
                logKeyboard("drag to select text")
            }
        case .leftMouseUp:
            downAt = nil
        default:
            break
        }
        super.sendEvent(event)
    }

    // After ⌘C: the keyboard goes back to the app in front. Ordering the panel out and straight back
    // in drops its key status without hiding it.
    func releaseKeyboard() {
        guard selecting else { return }
        selecting = false
        wantsKeyboard = false
        let behavior = animationBehavior
        animationBehavior = .none
        orderOut(nil)
        orderFrontRegardless()
        animationBehavior = behavior
    }

    // Another app took the keyboard back
    func keyboardTaken() {
        if selecting {
            selecting = false
            wantsKeyboard = false
        }
    }

    override func performKeyEquivalent(with event: NSEvent) -> Bool {
        if event.modifierFlags.intersection(.deviceIndependentFlagsMask) == .command {
            switch event.charactersIgnoringModifiers {
            case "c":
                if NSApp.sendAction(#selector(NSText.copy(_:)), to: nil, from: self) {
                    DispatchQueue.main.async { [weak self] in self?.releaseKeyboard() }
                    return true
                }
            case "a": if NSApp.sendAction(#selector(NSText.selectAll(_:)), to: nil, from: self) { return true }
            case "z":
                if let board = (NSApp.delegate as? AppDelegate)?.board, board.undoable != nil {
                    board.undoDismiss()
                    return true
                }
            default: break
            }
        }
        return super.performKeyEquivalent(with: event)
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate {
    let board = Board()
    // The popups beside the board, and their window
    let toasts = ToastCenter()
    var toastPanel: ToastPanel?
    var toastHost: NSHostingView<ToastStack>?
    // The floating popup (a BoardPanel) or the regular window, as the settings say
    var panel: NSWindow!
    var statusItem: NSStatusItem!
    var watch: AnyCancellable?
    // You hid it (the shortcut, its close button, "hide", the menu bar): it stays hidden, whatever app
    // you switch to and across relaunches, until you show it again the same way
    var userHidden = UserDefaults.standard.bool(forKey: "userHidden") {
        didSet { UserDefaults.standard.set(userHidden, forKey: "userHidden") }
    }
    var showRequests: Timer?
    var style: AnyCancellable?
    var theme: AnyCancellable?
    // The session you're viewing: its popup goes, however you got there
    var viewing: AnyCancellable?
    var background: NSView?

    // A session wants you: its popup, unless it isn't on the board (dismissed)
    func attention(_ kind: Int, _ row: Row) {
        guard let n = board.shown.firstIndex(where: { $0.id == row.id }) else { return }
        let detail = kind == 0 ? row.ask : kind == 1 ? (row.items.first { $0.waitsOnYou }?.text ?? "") : row.justDid
        toasts.add(AttentionToast(rowId: row.id, number: n + 1, name: board.shownName(row), kind: kind, detail: detail,
                                  colorName: board.colorName(row.id)))
    }

    // The popups' window beside the board, on whichever side is free; only while the board shows
    func placeToasts() {
        guard !toasts.toasts.isEmpty, let panel, panel.isVisible, let screen = (panel.screen ?? NSScreen.main)?.visibleFrame else {
            toastPanel?.orderOut(nil)
            return
        }
        if toastPanel == nil {
            let tp = ToastPanel(contentRect: .zero, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
            tp.isFloatingPanel = true
            // After isFloatingPanel, which sets the floating level: one above the board, so the
            // popups stay over it when they have to sit on it
            tp.level = NSWindow.Level(rawValue: NSWindow.Level.floating.rawValue + 1)
            tp.backgroundColor = .clear
            tp.isOpaque = false
            tp.hasShadow = false
            tp.hidesOnDeactivate = false
            tp.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .ignoresCycle]
            let host = NSHostingView(rootView: ToastStack(center: toasts, board: board))
            tp.contentView = host
            toastPanel = tp
            toastHost = host
        }
        guard let tp = toastPanel, let host = toastHost else { return }
        // The first tile level with the top of the list, where the top session shows, a little inside
        // it (the stack has 8 points of padding around its tiles). The list's top is measured in the
        // board's content, which starts under the title bar.
        let below = board.collapsed || board.showSettings || board.listTop == nil ? 0
            : titleBarHeight + max(0, board.listTop ?? 0) + 4
        let frame = toastFrame(size: host.fittingSize, board: panel.frame, screen: screen, below: below).frame
        if tp.frame != frame { tp.setFrame(frame, display: true) }
        if !tp.isVisible { tp.orderFrontRegardless() }
    }

    // Light or dark: the window's appearance (SwiftUI's colors follow it) and its background
    func applyTheme(_ dark: Bool) {
        panel?.appearance = NSAppearance(named: dark ? .darkAqua : .aqua)
        // The title bar sits on the card colour of the boards: #131416, or white
        background?.layer?.backgroundColor = (dark ? NSColor(srgbRed: 0x13 / 255.0, green: 0x14 / 255.0, blue: 0x16 / 255.0, alpha: 1)
                                                   : NSColor.white).cgColor
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        restoreVolumeLeftByAlert()
        board.start()
        board.crash = newCrash()
        board.onAttention = { [weak self] kind, row in self?.attention(kind, row) }
        toasts.onTick = { [weak self] in self?.placeToasts() }
        NSApp.applicationIconImage = appIcon(size: 512)
        setUpMenu()
        makeWindow()

        // Shown while Claude is the app in front, hidden in any other app (see the settings)
        NSWorkspace.shared.notificationCenter.addObserver(
            forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: .main
        ) { [weak self] _ in self?.followFrontApp() }
        // Right after launch macOS can still report this app in front: look again once it settles
        followFrontApp(launching: true)
        DispatchQueue.main.asyncAfter(deadline: .now() + 1) { [weak self] in self?.followFrontApp(launching: true) }
        // /session-board asks for the window by writing show-request: that is you asking, so it shows
        showRequests = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in self?.checkShowRequest() }
        checkShowRequest()

        // The menu bar item: working count; click to show or hide, right-click to quit
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        statusItem.button?.target = self
        statusItem.button?.action = #selector(statusClicked)
        statusItem.button?.sendAction(on: [.leftMouseUp, .rightMouseUp])
        watch = board.$rows.receive(on: RunLoop.main).sink { [weak self] _ in
            self?.updateTitle()
            DispatchQueue.main.async { self?.fitCollapsed() }
        }
        updateTitle()
        fold = board.$collapsed.removeDuplicates().receive(on: RunLoop.main).sink { [weak self] in self?.applyCollapsed($0) }
        // A changed setting applies at once
        prefs = board.$hideWhenAway.combineLatest(board.$terminalsCount).dropFirst()
            .receive(on: RunLoop.main).sink { [weak self] _ in self?.followFrontApp() }
        style = board.$regularWindow.dropFirst().removeDuplicates().receive(on: RunLoop.main).sink { [weak self] _ in
            guard let self else { return }
            self.makeWindow()
            self.userHidden = false
            self.bringForward()
        }
        installShortcut()
        theme = board.$isDark.removeDuplicates().receive(on: RunLoop.main).sink { [weak self] in self?.applyTheme($0) }
        viewing = board.$focusedId.removeDuplicates().receive(on: RunLoop.main).sink { [weak self] id in
            if let id { self?.toasts.removeRow(id) }
        }
        // macOS switching light and dark (also on a schedule): follow at once, not on the next reload
        DistributedNotificationCenter.default().addObserver(
            forName: Notification.Name("AppleInterfaceThemeChangedNotification"), object: nil, queue: .main
        ) { [weak self] _ in self?.board.updateTheme() }
        // Once: ask for Accessibility, which the Desktop highlight needs
        if !AXIsProcessTrusted() && !UserDefaults.standard.bool(forKey: "askedAccessibility") {
            UserDefaults.standard.set(true, forKey: "askedAccessibility")
            _ = AXIsProcessTrustedWithOptions([kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary)
        }
    }

    @objc func undoDismiss() { board.undoDismiss() }

    // A sound of yours: any file macOS can play, under 10 seconds and 5 MB, copied into the
    // app's folder so it keeps working if the original moves
    func addCustomSound(for moment: Int) {
        let open = NSOpenPanel()
        open.allowedContentTypes = [.audio]
        open.allowsMultipleSelection = false
        open.message = "Choose a short sound for Session Board (under 10 seconds)"
        open.prompt = "Use This Sound"
        NSApp.activate()
        guard open.runModal() == .OK, let url = open.url else { return }
        board.soundError = nil
        guard let sound = NSSound(contentsOf: url, byReference: true) else {
            board.soundError = "macOS can't play \(url.lastPathComponent). Try a WAV, AIFF, MP3 or M4A file."
            return
        }
        guard sound.duration <= 10 else {
            board.soundError = "\(url.lastPathComponent) is \(Int(sound.duration.rounded())) seconds long. Pick one under 10 seconds."
            return
        }
        let size = ((try? FileManager.default.attributesOfItem(atPath: url.path))?[.size] as? Int) ?? 0
        guard size <= 5_000_000 else {
            board.soundError = "\(url.lastPathComponent) is over 5 MB. Pick a smaller file."
            return
        }
        try? FileManager.default.createDirectory(atPath: customSoundsDir, withIntermediateDirectories: true)
        let base = (url.lastPathComponent as NSString).deletingPathExtension, ext = url.pathExtension
        var name = url.lastPathComponent, n = 2
        while FileManager.default.fileExists(atPath: customSoundsDir + "/" + name) {
            name = "\(base) \(n)" + (ext.isEmpty ? "" : "." + ext)
            n += 1
        }
        do {
            try FileManager.default.copyItem(at: url, to: URL(fileURLWithPath: customSoundsDir + "/" + name))
        } catch {
            board.soundError = "Couldn't copy \(url.lastPathComponent): \(error.localizedDescription)"
            return
        }
        board.chooseSound("custom:" + name, for: moment)
    }

    // The app menu and an Edit menu, so Copy and Select All reach the selected text by their usual keys
    func setUpMenu() {
        let menu = NSMenu()
        let appItem = NSMenuItem()
        appItem.submenu = NSMenu()
        let settings = NSMenuItem(title: "Settings…", action: #selector(openSettings), keyEquivalent: ",")
        settings.target = self
        appItem.submenu?.addItem(settings)
        appItem.submenu?.addItem(.separator())
        appItem.submenu?.addItem(NSMenuItem(title: "Quit Session Board", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q"))
        let editItem = NSMenuItem()
        editItem.submenu = NSMenu(title: "Edit")
        let undo = NSMenuItem(title: "Undo Dismiss", action: #selector(undoDismiss), keyEquivalent: "z")
        undo.target = self
        editItem.submenu?.addItem(undo)
        editItem.submenu?.addItem(.separator())
        editItem.submenu?.addItem(NSMenuItem(title: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c"))
        editItem.submenu?.addItem(NSMenuItem(title: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a"))
        menu.addItem(appItem)
        menu.addItem(editItem)
        NSApp.mainMenu = menu
    }

    // Builds the window the settings ask for, in place of the one there is, at the same place
    // and size. The popup floats above other apps on every Space, and never makes this app the
    // front one; the regular window is an ordinary app window with a Dock icon.
    func makeWindow() {
        let regular = board.regularWindow
        let old = panel
        old?.setFrameAutosaveName("")
        old?.delegate = nil
        old?.orderOut(nil)
        // At launch main() has already set it: an app that turns regular while it launches
        // can't show a window until it's brought to the front
        let policy: NSApplication.ActivationPolicy = regular ? .regular : .accessory
        if NSApp.activationPolicy() != policy { NSApp.setActivationPolicy(policy) }

        // Each kind keeps its own place and size
        let frameName = regular ? "SessionBoardWindow" : "SessionBoardPanel"
        let rect = NSRect(origin: .zero, size: regular ? regularDefaultSize : defaultSize)
        if regular {
            panel = NSWindow(contentRect: rect, styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
                             backing: .buffered, defer: false)
            panel.level = .normal
        } else {
            let popup = BoardPanel(contentRect: rect, styleMask: [.titled, .closable, .resizable, .utilityWindow, .nonactivatingPanel, .fullSizeContentView],
                                   backing: .buffered, defer: false)
            popup.level = .floating
            popup.isFloatingPanel = true
            popup.becomesKeyOnlyIfNeeded = false
            popup.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
            panel = popup
        }
        panel.title = "Session Board"
        panel.hidesOnDeactivate = false
        panel.titlebarAppearsTransparent = true
        // Off, so dragging over text selects it; the title bar still moves the window
        panel.isMovableByWindowBackground = false
        panel.isReleasedWhenClosed = false

        // The list starts under the title bar, whose height differs between the two kinds
        titleBarHeight = max(22, panel.frame.height - panel.contentLayoutRect.height)
        let background = NSView()
        background.wantsLayer = true
        self.background = background
        applyTheme(board.isDark)
        let host = NSHostingView(rootView: BoardView(board: board))
        host.translatesAutoresizingMaskIntoConstraints = false
        background.addSubview(host)
        NSLayoutConstraint.activate([
            host.leadingAnchor.constraint(equalTo: background.leadingAnchor),
            host.trailingAnchor.constraint(equalTo: background.trailingAnchor),
            host.topAnchor.constraint(equalTo: background.topAnchor, constant: titleBarHeight),
            host.bottomAnchor.constraint(equalTo: background.bottomAnchor),
        ])
        let edges = ResizeEdges()
        edges.translatesAutoresizingMaskIntoConstraints = false
        background.addSubview(edges)
        NSLayoutConstraint.activate([
            edges.leadingAnchor.constraint(equalTo: background.leadingAnchor),
            edges.trailingAnchor.constraint(equalTo: background.trailingAnchor),
            edges.topAnchor.constraint(equalTo: background.topAnchor),
            edges.bottomAnchor.constraint(equalTo: background.bottomAnchor),
        ])
        panel.contentView = background

        // Where this kind was last put; the first time, sized and placed for this screen
        if !panel.setFrameUsingName(frameName), let screen = NSScreen.main?.visibleFrame {
            panel.setFrame(defaultFrame(on: screen, regular: regular), display: false)
        }
        panel.setFrameAutosaveName(frameName)
        panel.minSize = NSSize(width: 260, height: board.collapsed ? collapsedHeight : 160)
        panel.delegate = self
    }

    // The show/hide shortcut (⌃⌥S unless changed in Settings), from any app: hide the window
    // completely, or bring it back
    var hotKey: EventHotKeyRef?
    var keyMonitor: Any?
    // A tapped modifier as the shortcut: watched in every app and in this one
    var tapMonitors: [Any] = []
    var tapWatch = TapWatch()
    // While recording: a right-hand modifier pressed alone, so letting it go records it
    var recordTap = TapWatch()

    func installShortcut() {
        var spec = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
        InstallEventHandler(GetApplicationEventTarget(), { _, _, _ -> OSStatus in
            DispatchQueue.main.async { (NSApp.delegate as? AppDelegate)?.toggleWindow() }
            return noErr
        }, 1, &spec, nil, nil)
        if !register(board.shortcut) {
            board.shortcutError = "macOS didn't accept \(board.shortcut.display), so it's back to \(Shortcut.standard.display)."
            board.shortcut = .standard
            register(.standard)
        }
    }

    @discardableResult func register(_ s: Shortcut) -> Bool {
        unregisterShortcut()
        if s.isModifierTap {
            // Carbon hot keys need a key: a tap is watched instead. Other apps' events reach the
            // global monitor only with the Accessibility permission.
            let code = Int(s.keyCode)
            let events: NSEvent.EventTypeMask = [.flagsChanged, .keyDown, .leftMouseDown, .rightMouseDown]
            let seen = { [weak self] (event: NSEvent) in
                guard let self, self.tapWatch.feed(event, code: code) else { return }
                self.toggleWindow()
            }
            if let global = NSEvent.addGlobalMonitorForEvents(matching: events, handler: seen) { tapMonitors.append(global) }
            if let local = NSEvent.addLocalMonitorForEvents(matching: events, handler: { seen($0); return $0 }) { tapMonitors.append(local) }
            return !tapMonitors.isEmpty
        }
        let id = EventHotKeyID(signature: OSType(0x5345_5353), id: 1)
        return RegisterEventHotKey(s.keyCode, s.mods, id, GetApplicationEventTarget(), 0, &hotKey) == noErr
    }

    func unregisterShortcut() {
        if let hotKey { UnregisterEventHotKey(hotKey) }
        hotKey = nil
        tapMonitors.forEach(NSEvent.removeMonitor)
        tapMonitors = []
        tapWatch = TapWatch()
    }

    // Record the next key press as the new shortcut. The current one is let go meanwhile, so
    // pressing it records it instead of hiding the window.
    func startRecording() {
        board.pendingShortcut = nil
        board.shortcutClashNotes = []
        board.shortcutError = nil
        board.heldModifiers = ""
        board.recording = true
        unregisterShortcut()
        (panel as? BoardPanel)?.wantsKeyboard = true
        panel.makeKey()
        logKeyboard("recording a shortcut")
        if keyMonitor == nil {
            keyMonitor = NSEvent.addLocalMonitorForEvents(matching: [.keyDown, .flagsChanged]) { [weak self] event in
                guard let self, self.board.recording else { return event }
                if event.type == .flagsChanged {
                    self.board.heldModifiers = modifierSymbols(carbonModifiers(event.modifierFlags))
                    // A right-hand modifier tapped alone is a shortcut too
                    let code = Int(event.keyCode)
                    if self.recordTap.feed(event, code: code), let tap = modifierTaps[code] {
                        self.consider(Shortcut(keyCode: UInt32(code), mods: 0, key: tap.label))
                    }
                    return event
                }
                self.recordTap = TapWatch()
                if event.keyCode == UInt16(kVK_Escape) && carbonModifiers(event.modifierFlags) == 0 {
                    self.stopRecording()
                } else {
                    self.consider(Shortcut(event: event))
                }
                return nil
            }
        }
    }

    func stopRecording() {
        if let keyMonitor { NSEvent.removeMonitor(keyMonitor) }
        keyMonitor = nil
        (panel as? BoardPanel)?.wantsKeyboard = false
        board.recording = false
        board.heldModifiers = ""
        register(board.shortcut)
    }

    // A recorded shortcut: refused if it has no ⌘, ⌃ or ⌥; used at once if it clashes with
    // nothing; otherwise held until "Use anyway"
    func consider(_ s: Shortcut) {
        if let problem = shortcutProblem(s) {
            board.shortcutError = problem
            return
        }
        board.shortcutError = nil
        stopRecording()
        DispatchQueue.global(qos: .userInitiated).async {
            let clashes = shortcutClashes(s)
            DispatchQueue.main.async {
                if clashes.isEmpty {
                    self.useShortcut(s)
                } else {
                    self.board.pendingShortcut = s
                    self.board.shortcutClashNotes = clashes
                }
            }
        }
    }

    func useShortcut(_ s: Shortcut) {
        board.pendingShortcut = nil
        board.shortcutClashNotes = []
        if register(s) {
            board.shortcut = s
            s.save()
            board.shortcutError = nil
        } else {
            board.shortcutError = "macOS didn't accept \(s.display). Pick another."
            register(board.shortcut)
        }
    }

    // Clicking away while recording cancels it
    func windowDidResignKey(_ notification: Notification) {
        (panel as? BoardPanel)?.keyboardTaken()
        if board.recording { stopRecording() }
    }

    // The shortcut, "hide", the menu bar: hide and keep it hidden, or show it now (in any app); after
    // showing, switching apps follows the settings again
    func toggleWindow() {
        if panel.isVisible {
            userHidden = true
            panel.orderOut(nil)
        } else {
            userHidden = false
            bringForward()
        }
    }

    // Shown and ready to use: the regular window also makes this app the front one
    func bringForward() {
        if board.regularWindow {
            NSApp.activate(ignoringOtherApps: true)
            panel.makeKeyAndOrderFront(nil)
        } else {
            show()
        }
    }

    func followFrontApp(launching: Bool = false) {
        if userHidden {
            panel.orderOut(nil)
            return
        }
        // A regular window stays where you put it, like any other app's
        if board.regularWindow {
            if launching { show() }
            return
        }
        if !board.hideWhenAway {
            show()
            return
        }
        let front = NSWorkspace.shared.frontmostApplication?.bundleIdentifier ?? ""
        // Our own menu bar item can bring this app forward: leave the window as it is
        // (at launch, show it: the launch itself put this app in front)
        if front == Bundle.main.bundleIdentifier {
            if launching { show() }
            return
        }
        let isClaude = front == desktopBundle || (board.terminalsCount && terminalBundles.contains(front))
        if isClaude { show() } else { panel.orderOut(nil) }
    }

    func checkShowRequest() {
        // A debugging aid: test-toast in the shared folder ("0", "1" or "2": needs you, your turn,
        // done) shows that popup for the first session you aren't viewing
        let test = appDir + "/test-toast"
        if let kind = (try? String(contentsOfFile: test, encoding: .utf8)).flatMap({ Int($0.trimmingCharacters(in: .whitespacesAndNewlines)) }) {
            try? FileManager.default.removeItem(atPath: test)
            if let row = board.shown.first(where: { $0.id != board.focusedId }) { attention(min(max(kind, 0), 2), row) }
        }
        let path = appDir + "/show-request"
        guard let text = try? String(contentsOfFile: path, encoding: .utf8),
              let at = Double(text.trimmingCharacters(in: .whitespacesAndNewlines)),
              at > UserDefaults.standard.double(forKey: "handledShowRequest")
        else { return }
        UserDefaults.standard.set(at, forKey: "handledShowRequest")
        userHidden = false
        show()
    }

    // The red close button hides it the same way the shortcut does
    func windowShouldClose(_ sender: NSWindow) -> Bool {
        userHidden = true
        panel.orderOut(nil)
        return false
    }

    var fold: AnyCancellable?
    var prefs: AnyCancellable?
    var titleBarHeight: CGFloat = 28
    // Title bar, the header (counts and bar) and the needs-you line, measured at the window's width
    var collapsedHeight: CGFloat {
        let p = board.isDark ? Palette.dark : Palette.light
        let measure = NSHostingView(rootView: VStack(spacing: 1) { HeaderView(board: board, p: p); NeedsYouStrip(board: board, p: p, showsNone: true) }
            .frame(width: panel?.frame.width ?? 360))
        return titleBarHeight + ceil(measure.fittingSize.height)
    }

    // The header grows a line when the first session opens: keep a collapsed window fitted
    func fitCollapsed() {
        guard board.collapsed, let panel else { return }
        let height = collapsedHeight
        guard abs(panel.frame.height - height) > 0.5 else { return }
        var frame = panel.frame
        frame.origin.y = frame.maxY - height
        frame.size.height = height
        panel.minSize = NSSize(width: 260, height: height)
        panel.setFrame(frame, display: true, animate: false)
    }

    // Collapsing keeps the open height (one per window kind) to grow back to; a window that is
    // already open keeps the size it has
    func applyCollapsed(_ collapsed: Bool) {
        var frame = panel.frame
        let top = frame.maxY
        let key = board.regularWindow ? "expandedHeightRegular" : "expandedHeight"
        if collapsed {
            if frame.height > collapsedHeight + 20 { UserDefaults.standard.set(Double(frame.height), forKey: key) }
            panel.minSize = NSSize(width: 260, height: collapsedHeight)
            frame.size.height = collapsedHeight
        } else {
            panel.minSize = NSSize(width: 260, height: 160)
            guard frame.height <= collapsedHeight + 20 else { return }
            let saved = UserDefaults.standard.double(forKey: key)
            frame.size.height = saved > 120 ? saved : (board.regularWindow ? regularDefaultSize : defaultSize).height
        }
        frame.origin.y = top - frame.height
        panel.setFrame(frame, display: true, animate: true)
    }

    func updateTitle() {
        let needs = board.needsYou
        statusItem.button?.title = "◉ \(board.working)" + (needs > 0 ? " · \(needs)!" : "")
    }

    @objc func statusClicked() {
        if NSApp.currentEvent?.type == .rightMouseUp {
            let menu = NSMenu()
            let hide = NSMenuItem(title: (panel.isVisible ? "Hide window   " : "Show window   ") + board.shortcut.display, action: #selector(toggleFromMenu), keyEquivalent: "")
            hide.target = self
            menu.addItem(hide)
            let settings = NSMenuItem(title: "Settings…", action: #selector(openSettings), keyEquivalent: "")
            settings.target = self
            menu.addItem(settings)
            let report = NSMenuItem(title: "Report a Problem…", action: #selector(reportProblem), keyEquivalent: "")
            report.target = self
            menu.addItem(report)
            menu.addItem(.separator())
            menu.addItem(NSMenuItem(title: "Quit Session Board", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q"))
            statusItem.menu = menu
            statusItem.button?.performClick(nil)
            statusItem.menu = nil
        } else {
            toggleWindow()
        }
    }

    func show() { panel.orderFrontRegardless() }

    @objc func toggleFromMenu() { toggleWindow() }

    @objc func reportProblem() { openFeedback(.bug, board: board) }

    @objc func openSettings() {
        board.collapsed = false
        board.showSettings = true
        userHidden = false
        bringForward()
    }

    // `open -g` on the running app (a new session does this): only keeps it running, and a
    // window you hid stays hidden. A click on the Dock icon (the app is then in front) shows it.
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows: Bool) -> Bool {
        if board.regularWindow && NSApp.isActive {
            userHidden = false
            bringForward()
        } else {
            followFrontApp()
        }
        return false
    }
}

// The app's icon: three session rows on a dark tile, in the board's colors (needs you,
// working, idle). Drawn here, so the Dock icon and the built app's icon file need no artwork.
func appIcon(size: CGFloat) -> NSImage {
    NSImage(size: NSSize(width: size, height: size), flipped: false) { rect in
        let s = rect.width / 1024
        let tile = NSRect(x: 100 * s, y: 100 * s, width: 824 * s, height: 824 * s)
        NSColor(calibratedWhite: 0.13, alpha: 1).setFill()
        NSBezierPath(roundedRect: tile, xRadius: 185 * s, yRadius: 185 * s).fill()
        let rows: [(NSColor, CGFloat)] = [(.systemOrange, 0.62), (.systemGreen, 0.78), (NSColor(white: 0.55, alpha: 1), 0.5)]
        for (i, (color, length)) in rows.enumerated() {
            let y = tile.maxY - (250 + CGFloat(i) * 190) * s
            color.setFill()
            NSBezierPath(ovalIn: NSRect(x: tile.minX + 120 * s, y: y, width: 90 * s, height: 90 * s)).fill()
            NSColor(calibratedWhite: 0.88, alpha: i == 2 ? 0.45 : 0.9).setFill()
            NSBezierPath(roundedRect: NSRect(x: tile.minX + 260 * s, y: y + 25 * s, width: 450 * s * length, height: 40 * s),
                         xRadius: 20 * s, yRadius: 20 * s).fill()
        }
        return true
    }
}

// Write the icon at every size an .iconset needs, for build.sh to turn into the app's icon file
func writeIconset(to dir: String) -> Int32 {
    try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
    for points in [16, 32, 128, 256, 512] {
        for scale in [1, 2] {
            let pixels = points * scale
            guard let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: pixels, pixelsHigh: pixels, bitsPerSample: 8,
                                             samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB,
                                             bytesPerRow: 0, bitsPerPixel: 0) else { return 1 }
            NSGraphicsContext.saveGraphicsState()
            NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
            appIcon(size: CGFloat(pixels)).draw(in: NSRect(x: 0, y: 0, width: pixels, height: pixels))
            NSGraphicsContext.restoreGraphicsState()
            let name = "icon_\(points)x\(points)" + (scale == 2 ? "@2x" : "") + ".png"
            guard let png = rep.representation(using: .png, properties: [:]),
                  (try? png.write(to: URL(fileURLWithPath: dir + "/" + name))) != nil else { return 1 }
        }
    }
    return 0
}

// Render the list to a PNG, for checking the layout without a screen
// Set while --snapshot draws: settings it changes for the picture are not saved
var drawingSnapshot = false

// Example sessions with every kind of line, for screenshots (--sample): none of it is read from disk
func sampleRows() -> [Row] {
    func row(_ id: String, _ name: String, _ status: String, _ minutes: Double, desktop: Bool = false, justDid: String = "",
             agents: Int = 0, workflows: Int = 0, items: [Item] = [], request: String = "", ask: String = "", side: String = "", paused: String = "",
             taskList: Bool = false, task: String = "") -> Row {
        Row(id: id, pid: nil, name: name, place: "~/Projects/" + id, status: status, since: minutes * 60, isRemote: !desktop,
            isDesktop: desktop, hasMod: true, justDid: justDid, agentsRunning: agents, workflowsRunning: workflows, items: items, request: request, ask: ask,
            side: side, paused: paused, fromTaskList: taskList, task: task)
    }
    func next(_ text: String) -> Item { Item(text: text, isActive: false, waitsOnYou: false) }
    func yours(_ text: String) -> Item { Item(text: text, isActive: false, waitsOnYou: true) }
    let long = CommandLine.arguments.contains("--long")
    func doing(_ text: String) -> Item { Item(text: text, isActive: true, waitsOnYou: false) }
    return [
        row("tracker", "Payments Deposit Tracker", "needs-you", 1, justDid: "Console suite passed · 1,180 tests",
            ask: "Allow: deploy v2.4.1 to the sandbox", task: "Ship v2.4.1, the deposit matching fix: sandbox, then live"),
        // --long: lines too long to fit, for the tooltip
        long ? row("mobile", "Payments Mobile Build for the phone layout, the Trades tab and the money forms", "working", 6,
                   justDid: "Phone layout, Trades tab, money forms",
                   items: [doing("View-only note on Review and Staff"),
                           next("Test on your iPhone and an Android phone, in light and dark, with each desk’s own branding and a long payee list"),
                           next("Release: sandbox, then live")],
                   task: "Design and build the signup invite email for people invited without an account, with each desk’s own branding")
        : row("mobile", "Payments Mobile Build", "working", 6, justDid: "Phone layout, Trades tab, money forms",
            items: [doing("View-only note on Review and Staff"), next("Test on your iPhone"), next("Release: sandbox, then live")],
            task: "Make the payments app work on phones"),
        row("board", "Session Board", "working", 7, justDid: "Dismiss flow drawn",
            items: [next("Settings panel"), next("Sound behaviour, as an mp4")],
            side: "Fixing the board/chat status mismatch", paused: "Light theme and remaining states"),
        row("seo", "Landing SEO checks", "idle", 22, desktop: true, justDid: "Opened PR #159 for llms.txt", workflows: 1,
            items: [yours("Review the copy in PR #159"), yours("Merge PR #159 or hold it"), next("LinkedIn, Crunchbase and X profiles")]),
        row("tests", "Ops console tests", "working", 12, justDid: "Fix the fixture balances",
            items: [doing("Write the Review screen tests"), next("Run the browser suite")], taskList: true),
        row("cleanup", "Mac storage cleanup", "idle", 180, desktop: true, request: "find what's using 200 GB in Library"),
    ]
}

// Renders the window to a PNG, to compare against the boards. Flags: --settings, --light/--dark,
// --collapsed, --dismissed (opens that section), --undo (the toast), --empty, --viewing <n>,
// --shortcut-clash, --no-accessibility, --crash (the crash prompt)
@MainActor func snapshot(to path: String) -> Int32 {
    drawingSnapshot = true
    let args = CommandLine.arguments
    let board = Board()
    // The cloud sessions in Desktop's sidebar, read now rather than by the next reload
    if let found = desktopSidebarRows() { board.takeCloud(found) }
    if let open = desktopOpenChat() { board.takeGist(open.name, open.gist) }
    board.reload()
    board.jobs = backgroundJobs(sessions: liveSessionStarts())
    board.showSettings = args.contains("--settings") || args.contains("--shortcut-clash")
    if args.contains("--light") { board.isDark = false }
    if args.contains("--dark") { board.isDark = true }
    // Collapsed is a saved setting: drawn here, then put back as it was
    let wasCollapsed = board.collapsed
    board.collapsed = args.contains("--collapsed")
    defer { if board.collapsed != wasCollapsed { board.collapsed = wasCollapsed } }
    board.showDismissed = args.contains("--dismissed")
    if args.contains("--empty") { board.rows = [] }
    if args.contains("--crash") { board.crash = CrashReport(at: Date(), title: "Window app crashed: EXC_BREAKPOINT", details: "") }
    if args.contains("--sample") {
        // Their ids match no saved dismissal or removed line, so nothing saved is touched
        board.rows = sampleRows()
        board.jobs = ["seo": [BackgroundJob(label: "browser tests", minutes: 6)]]
        // Two sessions with a colour you gave them; a snapshot never saves this
        board.sessionColors = [:]
        board.autoColors = [:]
        board.assignColors()
    }
    if let i = args.firstIndex(of: "--viewing"), i + 1 < args.count, let n = Int(args[i + 1]), n >= 1, n <= board.shown.count {
        board.focusedId = board.shown[n - 1].id
    }
    if args.contains("--undo"), let row = board.hidden.first { board.undoable = (id: row.id, name: row.name) }
    // The clash warning for ⌘N, to check its layout
    if args.contains("--shortcut-clash") {
        let s = Shortcut(keyCode: UInt32(kVK_ANSI_N), mods: UInt32(cmdKey), key: "N")
        board.pendingShortcut = s
        board.shortcutClashNotes = shortcutClashes(s)
    }
    if args.contains("--sound-chooser") {
        board.showSettings = true
        board.openSoundPicker = 0
    }
    if args.contains("--no-accessibility") {
        board.canReadDesktop = false
        board.desktopRunning = true
    }
    let p = board.isDark ? Palette.dark : Palette.light
    // The popups, at three points of their countdown
    if args.contains("--toasts") {
        let center = ToastCenter()
        center.toasts = [
            AttentionToast(rowId: "a", number: 1, name: "web-app · Checkout redesign", kind: 1, detail: "Pick a layout for the cart", colorName: "Pink"),
            AttentionToast(rowId: "b", number: 3, name: "api · Rate limiter review", kind: 0, detail: "Allow: git push origin fix/limits", colorName: nil, elapsed: 3),
            AttentionToast(rowId: "c", number: 4, name: "docs · Quick-start guide", kind: 2, detail: "Published the quick-start page", colorName: "Teal", elapsed: 6),
        ]
        let renderer = ImageRenderer(content: ToastStack(center: center, board: board).background(Color(white: board.isDark ? 0.2 : 0.85)))
        renderer.scale = 2
        guard let image = renderer.nsImage, let tiff = image.tiffRepresentation,
              let png = NSBitmapImageRep(data: tiff)?.representation(using: .png, properties: [:]),
              (try? png.write(to: URL(fileURLWithPath: path))) != nil else { return 1 }
        print("snapshot", path, "toasts")
        return 0
    }
    let view = VStack(spacing: 1) {
        ZStack {
            Text("Session Board").font(.system(size: 12)).foregroundStyle(p.prefix)
        }
        .frame(maxWidth: .infinity).frame(height: 28).background(p.cell)
        .padding(.bottom, -1).zIndex(1)
        HeaderView(board: board, p: p)
        if !board.showSettings { NeedsYouStrip(board: board, p: p, showsNone: board.collapsed) }
        if board.collapsed {
            EmptyView()
        } else if board.showSettings {
            SettingsContent(board: board, p: p)
        } else {
            if board.crash != nil { CrashNote(board: board, p: p) }
            if !board.canReadDesktop && board.desktopRunning { AccessibilityNote(p: p) }
            if board.shown.isEmpty { EmptyBoard(p: p).frame(height: 230) } else { CardsList(board: board, p: p) }
            if let last = board.undoable {
                UndoToast(name: last.name, p: p) {}.padding(.horizontal, 14).padding(.vertical, 12).background(p.cell).padding(.top, -1)
            }
            if !board.hidden.isEmpty { DismissedSection(board: board, p: p) }
        }
    }
    .frame(width: 360).background(p.gap)
    .environment(\.colorScheme, board.isDark ? .dark : .light)
    let renderer = ImageRenderer(content: view)
    renderer.scale = 2
    guard let image = renderer.nsImage, let tiff = image.tiffRepresentation,
          let png = NSBitmapImageRep(data: tiff)?.representation(using: .png, properties: [:]),
          (try? png.write(to: URL(fileURLWithPath: path))) != nil
    else {
        print("snapshot failed")
        return 1
    }
    print("snapshot", path, board.rows.count, "rows")
    return 0
}

let args = CommandLine.arguments
// For trying the window against another install's records
if let i = args.firstIndex(of: "--store-prefix"), i + 1 < args.count { storePrefix = args[i + 1] }
// The rows as the board reads them, one per line: name, status, and the session it was started from
if args.contains("--rows") {
    for row in loadRows(now: Date().timeIntervalSince1970) { print([row.name, row.status, row.parent].joined(separator: " | ")) }
    exit(0)
}
if let i = args.firstIndex(of: "--snapshot"), i + 1 < args.count {
    exit(MainActor.assumeIsolated { snapshot(to: args[i + 1]) })
}
// What the crash prompt would send for a crash report: --crash-report <file.ips>
if let i = args.firstIndex(of: "--crash-report"), i + 1 < args.count {
    let text = (try? String(contentsOfFile: args[i + 1], encoding: .utf8)) ?? ""
    if let crash = parseCrash(text, at: Date()) { print(crash.title + "\n\n" + crash.details); exit(0) }
    print("not a crash report this can read"); exit(1)
}
// Check a shortcut the way Settings does: --check-shortcut <keyCode> <carbon modifiers> <key label>
if let i = args.firstIndex(of: "--check-shortcut"), i + 3 < args.count,
   let code = UInt32(args[i + 1]), let mods = UInt32(args[i + 2]) {
    let s = Shortcut(keyCode: code, mods: mods, key: args[i + 3])
    print(s.display, "→", shortcutProblem(s) ?? (shortcutClashes(s).isEmpty ? "free" : shortcutClashes(s).joined(separator: " | ")))
    exit(0)
}
// Prints the session rows in Claude Desktop's sidebar and which count as cloud, for troubleshooting
// The open chat's exchanges as the mod gets them, for troubleshooting
if args.contains("--open-chat") {
    guard let open = desktopOpenChat() else { print("no claude.ai chat open in Claude Desktop"); exit(1) }
    let list = open.exchanges.map { ["ask": $0.ask, "reply": $0.reply] }
    if let data = try? JSONSerialization.data(withJSONObject: ["name": open.name, "id": open.id, "exchanges": list], options: [.prettyPrinted]) {
        print(String(data: data, encoding: .utf8) ?? "")
    }
    exit(0)
}
if args.contains("--desktop-sidebar") {
    let start = Date()
    guard let rows = desktopSidebarRows() else { print("Desktop's sidebar can't be read (no permission, no window, or not in Code)"); exit(1) }
    let local = localDesktopNames()
    print("read in", Int(Date().timeIntervalSince(start) * 1000), "ms ·", rows.count, "rows ·", local.count, "local names")
    if let open = desktopOpenChat() {
        print("open chat:", open.name, "·", open.id, "· request:", open.gist.request, "· now:", open.gist.now, "· did:", open.gist.did)
        for x in open.exchanges { print("  exchange · asked", x.ask.count, "chars · reply", x.reply.count, "chars ·", String(x.reply.suffix(160)).replacingOccurrences(of: "\n", with: " ")) }
    }
    for r in rows {
        let kind = !(r.badge == "Cloud" || r.group == "Cloud") ? "not cloud" : local.contains(plainName(r.name)) ? "local" : "CLOUD"
        print(kind, "·", r.group, r.badge.isEmpty ? "" : "[\(r.badge)]", "·", r.name, "·", r.state.isEmpty ? "-" : r.state, "→", cloudStatus(r.state))
    }
    exit(0)
}
// Prints each Claude Desktop window and the page titles in it, for troubleshooting the highlight
if args.contains("--desktop-pages") {
    guard let app = NSRunningApplication.runningApplications(withBundleIdentifier: desktopBundle).first else { print("Claude Desktop isn't running"); exit(1) }
    let ax = AXUIElementCreateApplication(app.processIdentifier)
    AXUIElementSetAttributeValue(ax, "AXManualAccessibility" as CFString, kCFBooleanTrue)
    let focused = axAttr(ax, kAXFocusedWindowAttribute)
    print("accessibility", AXIsProcessTrusted(), "· open session:", desktopOpenSessionNames())
    let kids = (axAttr(ax, kAXChildrenAttribute) as? [AXUIElement]) ?? []
    print("windows:", ((axAttr(ax, kAXWindowsAttribute) as? [AXUIElement]) ?? []).count, "· focused:", focused != nil, "· main:", axAttr(ax, kAXMainWindowAttribute) != nil,
          "· children:", kids.map { axAttr($0, kAXRoleAttribute) as? String ?? "?" })
    for (i, w) in ((axAttr(ax, kAXWindowsAttribute) as? [AXUIElement]) ?? []).enumerated() {
        print("window", i, focused.map { CFEqual($0, w) } == true ? "(front)" : "", axAttr(w, kAXTitleAttribute) as? String ?? "")
        var level = [w]
        for depth in 0..<20 {
            var next: [AXUIElement] = []
            for e in level {
                if (axAttr(e, kAXRoleAttribute) as? String) == "AXWebArea" { print("  depth", depth, "page:", axAttr(e, kAXTitleAttribute) as? String ?? "(none)") }
                next += (axAttr(e, kAXChildrenAttribute) as? [AXUIElement]) ?? []
            }
            if next.isEmpty { break }
            if next.count > 400 { print("  depth", depth, next.count, "elements") }
            level = next
        }
    }
    exit(0)
}

if args.contains("--test-alert") {
    let before = SystemVolume.get()
    print("output volume before:", before.map { String(format: "%.0f%%", $0 * 100) } ?? "no volume control", "| muted:", SystemVolume.muted())
    playAlert(defaultSoundChoices[0], fallback: defaultSoundChoices[0]) {
        print("after:", SystemVolume.get().map { String(format: "%.0f%%", $0 * 100) } ?? "?")
        exit(0)
    }
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.15) {
        print("while playing:", SystemVolume.get().map { String(format: "%.0f%%", $0 * 100) } ?? "?")
    }
    DispatchQueue.main.asyncAfter(deadline: .now() + 5) { print("after (no change made):", SystemVolume.get().map { String(format: "%.0f%%", $0 * 100) } ?? "?"); exit(0) }
    RunLoop.main.run()
}
if let i = args.firstIndex(of: "--iconset"), i + 1 < args.count {
    exit(writeIconset(to: args[i + 1]))
}

// The floating board never takes the keyboard, so to macOS it's a background app, and a
// background app's cursor changes are ignored: the resize arrows wouldn't show. This connection
// property (also used by window managers) lets it set the cursor from the background. Looked up
// at run time, so a macOS without it simply keeps the default.
func allowCursorInBackground() {
    guard let graphics = dlopen("/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics", RTLD_LAZY),
          let defaultConnection = dlsym(graphics, "_CGSDefaultConnection"),
          let setProperty = dlsym(graphics, "CGSSetConnectionProperty")
    else { return }
    typealias DefaultConnection = @convention(c) () -> Int32
    typealias SetProperty = @convention(c) (Int32, Int32, CFString, CFTypeRef) -> Int32
    let connection = unsafeBitCast(defaultConnection, to: DefaultConnection.self)()
    _ = unsafeBitCast(setProperty, to: SetProperty.self)(connection, connection, "SetsCursorInBackground" as CFString, kCFBooleanTrue)
}
allowCursorInBackground()

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
// The regular window comes with a Dock icon; the popup doesn't
app.setActivationPolicy(UserDefaults.standard.bool(forKey: "regularWindow") ? .regular : .accessory)
app.run()

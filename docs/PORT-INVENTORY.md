# Session Board: port inventory (macOS Swift app -> Tauri v2)

Source: `board/main.swift` (3,934 lines), `board/build.sh`, `README.md`. Numbers like `L612` are line numbers in main.swift.
Goal: nothing lost silently. Every behaviour below either gets ported or gets an explicit "dropped / changed" decision.

Glossary: **registry** = `~/.claude/sessions/*.json`; **store** = `~/.claude/plugins/store/session-board_*.json`; **appDir** = `~/Library/Application Support/session-board` (L28; on Win/Linux use a per-OS config dir, and the mod in `hooks/register.js` must agree on it); **row** = one session card.

---

## 1. Data in / out

### 1.1 Files and directories

| Path | R/W | What / fields used | Lines |
|---|---|---|---|
| `~/.claude/sessions/<pid>.json` | R | Registry, one file per live claude process. Fields: `sessionId` (key), `pid`, `cwd`, `name`, `nameSource` ("derived" = placeholder from folder), `status` (busy / shell / waiting / idle), `statusUpdatedAt` (ms), `updatedAt` (ms), `startedAt` (ms; used for background-job ownership), `bridgeSessionId` ("session_01..." => Remote Control), `entrypoint` ("claude-desktop" => Desktop) | L23, L603-609, L615-620, L649-726 |
| `~/.claude/plugins/store/session-board_*.json` | R | Store, one per plugin install. Prefix `storePrefix` (default `session-board_`, overridable by `--store-prefix`, L3879) plus hidden pref `extraStorePrefixes` (string array, L626). Only keys starting `s:` are read; value = record (below). Files must end `.json` | L24-26, L622-644 |
| record fields (`s:<id>` value) | R | `id`, `title` (AI title Claude gave the chat), `updatedAt` (ms), `shadow` (bool: catch-up copy, not the live mod's own record), `turnEnded` (bool, catch-up only), `status` (needs-you/working/idle, trusted only when not shadow), `statusSince` (ms), `cwd`, `tasks[]` (`subject`, `status` pending/in_progress), `summary{done, active[], pending[], side, paused}`, `agentsRunning`, `workflowsRunning`, `request`, `ask` | L630-726 |
| `<appDir>/settings.json` | R+W | `{summaries, projectNames, renameSessions}` all bool, pretty-printed, atomic write. Read once at launch (L964-974); written on every change of any of the three (L977-982). The mod reads it before each summary and at session naming | L964-982 |
| `<appDir>/removed.json` | W | `{ "<sessionId>": ["bullet text", ...] }`. Written at start() and on every change (L986-998, L1039). Mod reads it so summaries drop removed bullets | L984-998 |
| `<appDir>/show-request` | R | Text = epoch number (seconds or ms as the mod writes; compared as Double). If `> UserDefaults handledShowRequest`, store it, set userHidden=false, show window. Polled every 1 s | L3590-3597 |
| `<appDir>/test-toast` | R+delete | Debug: contains "0"/"1"/"2"; file removed; shows that popup kind for first shown session that is not the focused one | L3585-3589 |
| `<appDir>/status.json` | W | Highlight debug: `at` (epoch s), `accessibility` (bool), `front` (front app bundle id), `desktopName`, `focusedId`, `focusedName`, `listTop` (-1 if none). Written whenever `focusedId` changes or Desktop name changes | L1016-1029 |
| `<appDir>/built.sha` | W (by build.sh only) | sha256 of main.swift:build.sh joined by ":". The mod rebuilds when it changes. NOT written by the app. Tauri port needs its own "is the installed app current" scheme (version check) or the mod's rebuild logic drops | build.sh L88 |
| `<appDir>/sounds/` | R/W | User's custom sounds. Files copied here (non-dot files listed, sorted; id `custom:<filename>`; name = filename without extension). Dupes renamed "name 2.ext" | L1191-1196, L3284-3297 |
| `<appDir>/sounds.log` | W | One line per sound played: ISO8601, kind(+sound name), row name, status, since, waits[], jobs[], agents, workflows. Truncated (deleted) when >200,000 bytes | L865-880 |
| `<appDir>/keyboard.log` | W | One line each time the floating board takes the keyboard (ISO8601 + reason). Deleted when >100,000 bytes | L3037-3050 |
| `~/.claude/shell-snapshots/snapshot-<shell>-<13-digit ms>-*` | R (via `ps` command lines) | Used to attribute running commands to a session (see 1.5) | L573-600 |
| `~/Library/Application Support/Claude/claude-code-sessions/**/local_*.json` | R | Claude Desktop session files: `cliSessionId` -> `sessionId` ("local_..."), for the deep link | L112-119 |
| `~/Library/Application Support/Claude/config.json` | R | `userThemeMode` = "dark"/"light" (else follow system) | L530-535 |
| `~/Library/Logs/DiagnosticReports/SessionBoard*.ips` | R | Crash reports newer than `crashSeenAt` | L2327-2346 |
| `/System/Library/Sounds/<Name>.aiff` | R | macOS alert sounds (14 names) | L1204 |
| App bundle `Resources/*.wav` | R | `needs-you.wav`, `your-turn.wav`, `done.wav` (board), `kenney-<name>.wav` x11 (from `board/sounds/*.wav`) | L1202-1203, build.sh L59 |
| `.git` of each cwd (walking up to $HOME) | R | Project name (see 1.6) | L191-216 |
| UserDefaults (bundle `io.github.kiranpothana.session-board`) | R+W | see table 1.2 | throughout |

### 1.2 Persisted app state (UserDefaults keys; port to a JSON store or Tauri store plugin)

| Key | Type | Default | Meaning | Lines |
|---|---|---|---|---|
| `collapsed` | bool | false | Collapse to counts line | L737 |
| `dismissed` | [id] | [] | Dismissed sessions | L741 |
| `dismissedAt` | {id: epoch s} | {} | When dismissed (auto-restore rule) | L745 |
| `soundsOn` | bool | true | Master | L773 |
| `soundNeedsYou` | bool | true | Per moment | L776 |
| `soundYourTurn` | bool | true | Per moment | L779 |
| `soundDone` | bool | **false** | Per moment (chatty) | L782 |
| `soundChoices` | [3 ids] | `board:needs-you`, `board:your-turn`, `board:done` | Sound per moment | L787, L1190 |
| `alertVolume` | double | 0.5 | 0 = "Mine" (leave system volume alone), else 0.1..1.0 | L792 |
| `volumeToRestore`, `volumeAlertTarget` | double | - | Crash-safe volume restore (see 4) | L1291-1317 |
| `sessionColors` | {id: swatch name} | {} | User-picked colour | L882 |
| `autoColors` | {id: swatch name} | {} | Auto-assigned colour, sticky while session lives | L886 |
| `theme` | "light"/"dark"/nil | nil | nil = follow Claude Desktop, else macOS | L926 |
| `shortcutKeyCode`, `shortcutMods`, `shortcutKey` | int,int,string | S, ctrl+opt, "S" | Global shortcut (Carbon codes) | L312-323 |
| `regularWindow` | bool | false | Floating vs Regular | L952 |
| `hideWhenAway` | bool | true | Hide when non-Claude app in front | L956 |
| `terminalsCount` | bool | true | Terminals/editors count as Claude | L960 |
| `removedItems` | {id: [text]} | {} | Removed bullets (mirrored to removed.json) | L986 |
| `userHidden` | bool | false | You hid it; persists across launches | L3142 |
| `handledShowRequest` | double | 0 | Last show-request handled | L3593 |
| `askedAccessibility` | bool | false | Prompted once | L3252 |
| `crashSeenAt` | double | 0 (first run sets now, offers nothing) | Crash dedupe | L2328-2333, L1964 |
| `expandedHeight`, `expandedHeightRegular` | double | - | Height to restore after un-collapse, per window kind | L3635-3644 |
| `extraStorePrefixes` | [string] | [] | Hidden: read older install's records | L626 |
| NSWindow autosave frames `SessionBoardPanel`, `SessionBoardWindow` | frame | floating: right edge of screen -16 pt, vertically centred; regular: centred | Each kind remembers own pos/size | L3338-3395 |

Cleanup rule (L1066-1073): when the row list is non-empty (never on an empty read), drop entries for ids no longer present from `dismissed`, `removedItems`, `sessionColors`, `autoColors`.

### 1.3 Polling / timers

| Interval | What | Lines |
|---|---|---|
| 2 s | `reload()`: rows, colours, auto-restore, sounds, jobs, theme, Desktop-running | L1042, L1046-1074 |
| 0.25 s | `pollFocus()` highlight | L1043, L1109 |
| >=1 s between | Terminal/iTerm AppleScript tty check (throttle) | L1140 |
| 1 s | `checkShowRequest()` (also test-toast) | L3219 |
| 1/30 s | Toast countdown tick (only while toasts exist) | L2083 |
| 6 s | Undo-dismiss toast lifetime | L758 |
| 1 s after launch | second `followFrontApp(launching:)` | L3217 |
| (mod, not app) | README: reads others' conversations every 30 s (catch-up); summaries per turn / 90 s | README |

### 1.4 Row building (`loadRows`, L612-729)

1. **Live set**: every registry file with a `sessionId`. `hasRegistry` = the directory was readable (even if empty).
2. **Records**: for each store file matching a prefix, each `s:` key with `id`.
   - Collect `titles[id]` from any copy that has a non-empty `title`.
   - Skip a record whose session is not live when `hasRegistry` is true, or (registry unreadable) when `now - updatedAt/1000 > staleSeconds` = **600 s**.
   - Duplicate ids across files: a non-shadow ("own") record beats a shadow; otherwise the one with larger `updatedAt`.
3. Row set = union of live ids and kept record ids.
4. **own** = record exists and `shadow != true`.
5. **Status**:
   - `regRaw` = registry `status` (default "idle"). Mapping: "waiting" -> `needs-you`; "idle" -> `idle`; anything else ("busy"/"shell") -> `working`, EXCEPT if `turnEnded`.
   - `turnEnded` = record.turnEnded == true AND registry `statusUpdatedAt <= record.updatedAt` (a newer status change overrides the stale end). Then -> `idle`.
   - Final status = own ? (record.status ?? mapped) : mapped.
6. **since** = `now - changedMs/1000` where `changedMs` = own ? (rec.statusSince ?? rec.updatedAt) : (reg.statusUpdatedAt ?? reg.updatedAt), falling back to rec.updatedAt, else 0.
7. **cwd** = rec.cwd ?? reg.cwd. **place** = basename(cwd). **project** = projectName(reg.cwd ?? cwd) (the folder the session was opened in).
8. **name**: if registry `nameSource == "derived"` and an AI title exists -> the title; else registry `name`; if empty -> basename(cwd) (or "?").
9. **pid** = reg.pid; **isRemote** = reg.bridgeSessionId non-empty; **bridgeId** = same; **isDesktop** = reg.entrypoint == "claude-desktop"; **hasMod** = record exists.
10. **Items** (only if record):
    - Filter `tasks` to status pending / in_progress. If any: items = tasks (`subject`; active = in_progress; never waitsOnYou). `fromTaskList` = true.
    - Else if `summary.active` or `summary.pending` has non-blank strings: 
      - active strings NOT ending with " · waits on you" -> active items.
      - then (active strings ending with that suffix + all pending strings) -> non-active items; `waitsOnYou` = text contains "waits on you" (case-insens) AND session status == idle (a working session is not waiting on you). The phrase is stripped with regex `\s*[·•-]?\s*\(?waits on you\)?\s*[:–-]?\s*` -> " ", trimmed.
    - strings() drops blank/whitespace-only entries.
11. `justDid` = summary.done; `side` = summary.side; `paused` = summary.paused; `request` = rec.request; `ask` = rec.ask only when status == needs-you; `agentsRunning`, `workflowsRunning` from record (default 0).
12. **Sort**: by (rank needs-you=0, working=1, idle=2; else 3) then `since` ascending (most recently entered that state first).
13. **isQuiet** = status idle AND since > **12 h (43,200 s)** -> not shown on the board (also not counted). It is NOT in Dismissed.
14. **Shown** = rows not quiet and not dismissed (L1101). **Hidden** (Dismissed list) = all rows whose id is in `dismissed`, including quiet ones (L1102). Counts (needs-you/working/idle) are over Shown only (L1103-1105).
15. **Number tile** = 1-based index in `shown` order, "%02d". It changes as order changes.
16. **Auto-restore**: a dismissed row with status needs-you and `now - since > dismissedAt[id]` (entered needs-you after dismissal) is restored automatically (L1051-1053).

### 1.5 Background jobs ("Still running") (L546-609)

- `ps -axo etime=,command=` every reload on a background queue; result diffed to avoid redraw.
- A process is a job if its command line contains `/.claude/shell-snapshots/snapshot-<letters>-<13 digit ms>-`. The ms timestamp = when the owning session's shell snapshot was made; **owner = live session with the largest `startedAt <= that ms`**.
- Label by lowercase substring (first match wins): "playwright test" -> "browser tests"; vitest, "jest ", "npm test", "npm run test", "bun test", pytest, "go test", "cargo test", "swift test", "plugin test" -> "tests"; "vite preview", "vite dev", "npm run dev", "next dev", "http.server", "npm start" -> "a local server"; "build.sh", "npm run build", "vite build", "swiftc ", xcodebuild, "cargo build", "go build", "docker build" -> "a build"; deploy, "rsync ", "scp ", "ssh " -> "work on a server"; else "a command".
- `elapsedMinutes`: parses ps etime `[[dd-]hh:]mm:ss` -> minutes.
- **Port note**: this is Unix `ps` + the snapshot path convention. Windows needs a process-list API (command lines via WMI/sysinfo) and Claude Code's Windows shell-snapshot naming is unverified. Mark as "verify per OS".
- "Still running" line text (L1475-1483): unique job labels in order, then "a workflow"/"N workflows", then "a background agent"/"N background agents"; joined ", "; first letter uppercased; + " still running"; if any jobs, + " · " + ago(max job minutes). Examples: "Browser tests still running · 6m".

### 1.6 Project name (L188-216)

Cache per cwd. If cwd contains `/.claude/worktrees/`, cut there. Walk up while path starts with `$HOME/`; first dir containing `.git`: if `.git` is a FILE, read first `gitdir:` line, and if it contains `/.git/worktrees/` the repo root = text before that; project = basename(root). No git found -> basename of the (cut) folder.

### 1.7 Formatting helpers

- `ago(s)`: <1 min "now"; <60 "Nm"; hours <48 "Nh"; else "Nd" (L76-82).
- `shownName` (L1078): if `projectNames` on and project non-empty: if normalised (lowercase alphanumerics only) name starts with normalised project, name as is; else `project + " · " + name`.
- `sharedPrefixes` (L1086-1098): over Shown rows' shown names, for each name try word prefixes from longest (words-1) down to 1 word; the first prefix (with trailing space) that another session's name also starts with is rendered grey. Else if name starts with `project + " · "`, that prefix is grey.
- `sameName` (L250): case-insensitive, whitespace-collapsed, curly->straight quotes. Used for Desktop highlight matching.

### 1.8 Colours / number tiles

- **State colours**: amber = needs you, green = working, grey = idle, blue = session you're viewing (ring), violet = side task. (L1319)
- **Tile** (`squareColors`, L1422): if the session has a colour (user or auto): fill = swatch (dark or light value by theme), ink = `inkFor` (near-black #0B0B0C or white, whichever has better WCAG-ish contrast: pick black if `(L+0.05)/0.0545 >= 1.05/(L+0.05)`). Else by status: needs-you amber/amberInk, working green/greenInk, idle idle/idleInk.
- **Swatches** (30, name: dark / light) (L1361-1377):
  Blue 4B92FF/2F6FD6; Purple 9B7CFF/6D4FD8; Teal 2EC4B6/0F8B80; Pink F472B6/C23D86; Red F0605A/C73A35; Orange F28C3B/C05A10; Green 5CCB6A/2F8F3E; Sky 38BDF8/0B7FB5; Indigo 7C83FF/4A52D6; Gold F5C542/A67C00; Rose FB7185/C8364E; Coral FF8A65/C4512A; Mint 5EE6B0/138A60; Lime A3E635/5C8A08; Cyan 22D3EE/0A8AA3; Lavender B9A6FF/7A5FD8; Magenta E05BE0/A8329F; Plum B57BD9/844CA8; Crimson E5484D/B0232A; Peach FFB385/B8642F; Sand D9B98C/8F6C3A; Olive B5BD5A/6E751B; Forest 3FA36B/1E7447; Ocean 3B82C4/1F5C96; Steel 8CA3BF/52698A; Slate 94A3B8/56657A; Graphite A1A1AA/5F5F68; Brown C08A5B/875730; Turquoise 40E0D0/0D8F84; Fuchsia D946EF/A01DAD.
- **Auto colour assignment** (`assignColors`, L897-919): for each row without an auto colour, from `autoColorOrder` = [Blue, Pink, Teal, Magenta, Sky, Rose, Cyan, Plum, Ocean, Fuchsia, Turquoise, Coral] (never state-like colours): `shown` = colours used by other rows (user pick else auto). `free` = order minus shown. If free non-empty: `apart(c)` = min OKLab distance (dark values) from c to any colour in use (1 if none in use); keep candidates with `apart >= 0.9 * max(apart)` (`distinctShare`); pick **random** among those in the "popular" subset (first 6 of order) else random among all candidates. If none free: pick random among the least-used colours. Stored in `autoColors` (sticky). Snapshots take `first` instead of random. OKLab implementation L1390-1406.

---

## 2. UI

Fonts: system UI font (SF) for prose, **monospaced system** for tags/glyph lines/timers. Sizes: see per-element. Name kerning `-size/100`. Port: use a system font stack + `ui-monospace`.

### 2.1 Palettes (L1321-1347). Tokens by meaning

| Token | Dark | Light |
|---|---|---|
| gap (between cards / window bg) | 0B0B0C | E2E3E6 |
| cell (card/header bg) | 131416 | FFFFFF |
| cellHover | 1A1B1E | F6F7F9 |
| sunken (Dismissed/chooser bg) | 101113 | F4F5F7 |
| text | F2F2F3 | 141518 |
| idleName | D5D6D9 | 2E3035 |
| prefix (grey project/shared prefix, captions) | 8D8E91 | 6B6D73 |
| muted | 9A9AA0 | 696B71 |
| soft | B4B5B9 | 4A4C52 |
| doing | DADADF | 23252A |
| chipBorder | 45464B | C4C6CB |
| track (empty state bar) | 26272B | E6E7EA |
| amber | E8A93A | C27C00 |
| amberInk | 1A1203 | 1A1203 |
| amberText | F0BE62 | 9A5B00 |
| green | 4CC38A | 2E9E6A |
| greenInk | 04140B | 04140B |
| greenText | 4CC38A | 1E7A4F |
| idle | 8D8E91 | 6B6D73 |
| idleInk | 131416 | FFFFFF |
| blue (viewing ring) | 4B92FF | 2F6FD6 |
| violet | C4B5FD | 6D4FD8 |
| violetBorder | 8B6CF0 | 8B6CF0 |
| segTrack (button/segmented bg) | 22232A | ECEDF0 |
| switchOn | E6E6EA | 23252A |
| knobOn | 131416 | FFFFFF |
| switchOff | 2E2F34 | E6E7EA |
| knobOff | 8D8E91 | 8A8C92 |
| switchOffBorder | 2E2F34 | 8A8C92 |
| keyBorder | 45464B | C4C6CB |

Undo toast always uses fixed dark colours: bg 26272B, border 3A3B40, text DADADF, "Undo" F2F2F3, key hint text B4B5B9 / border 55565C, shadow black 50% r12 y8 (L2222-2238). Window title bar background = cell colour (131416 or white) (L3197). Controls carry no colour (monochrome); colour is reserved for state. Contrast intent: every text grey keeps 4.5:1 on the viewing tint (L1649).

**Theme choice** (L527-544, L926-942): `theme` pref "light"/"dark" wins; else Claude Desktop `userThemeMode` if dark/light; else macOS `AppleInterfaceStyle == Dark`. Re-evaluated every 2 s reload, and immediately on macOS `AppleInterfaceThemeChangedNotification`.

### 2.2 Window shell (BoardView, L2839-2925)

- Vertical stack with 1 px gaps (gap colour shows through). Min width 260.
- Order: Header -> (NeedsYouStrip if not Settings) -> body.
- Body: collapsed => nothing; Settings => SettingsPage (scrolls); else CrashNote (if crash) -> AccessibilityNote (if no AX && Desktop running) -> EmptyBoard or scrolling cards list -> Dismissed section (if any hidden).
- Undo toast overlays the bottom of the list (safe-area inset) or bottom of the empty board; slides up + fades (0.2 s).
- **Scrolling rules** (L2861-2924): list auto-scrolls so the viewing (focused) session is at top (anchor top). Animated 0.25 s only when its index changed or on focus change; instant otherwise/at appear. Any user scroll (`interacting/tracking`) sets `userScrolled`, which stops auto-follow until the focused session changes. Needs-you strip click sets `scrollRequest` -> scroll that card to top (also sets userScrolled).
- Measures `listTop` (top of the card list in global coords) for popup alignment (L2865-2872).

### 2.3 Header (HeaderView, L1819-1870)

Normal: "Sessions" (13 bold) + count text "none open" / "N open" (12, muted; N = shown.count) + spacer + [gear icon (Settings; also un-collapses)] + ["⌃⌥S hide" keycap button: toggles window; tooltip "Hide the window. Press <shortcut> in any app to bring it back."] + [chevron up/down: collapse toggle; tooltip "Collapse to the summary"/"Show the sessions"; chevron.down highlighted when collapsed]. Under it the **StateBar**.
Settings mode: "‹ Sessions" back button (text soft 12.5) + "Settings" (13 bold); no state bar.
Padding 14 h, 4 top, 12 bottom, cell bg.

**StateBar** (L1789-1816): 6 pt tall rounded bar, segments with 2 px gaps, widths proportional to counts of Needs you (amber) / Working (green) / Idle (idle grey); only non-zero segments shown; when none, a single `track` bar. Animates 0.3 s. Legend row: dot 6 pt + "Needs you N"/"Working N"/"Idle N" (label soft, number bold text, 11.5), only non-zero.

### 2.4 Needs-you strip (L1874-1918)

- Shows the **first** needs-you row in shown order (not the oldest): tile (number + state/colour square), TwoToneName (13), "+N" (mono 10 bold amberText; tooltip "N sessions need you") when more, right-aligned "NEEDS YOU · <ago>" label. Background: cell + amber @10% (dark) / 12% (light) + 3 px amber bar on left. Click: un-collapse + scroll list to that card ("Show it in the list"); does not open the chat.
- When none and the window is **collapsed**: "Nothing needs you right now" (12, muted).
- Strip is hidden in Settings.

### 2.5 Card (SessionCard, L1608-1751)

Top row (spacing 6): number tile (button -> colour popover) | chip: `DESKTOP` if isDesktop, else `RC` if isRemote, else `CLI` | chip `SIDE TASK` (violet) if side non-empty | spacer | status label OR "Dismiss?" (shown while hovering the x) | x dismiss button (only on card hover).
- Tile: mono bold 10, "%02d", radius 2, padding 5x2; tracking 0.9 if size<10. Tooltip "Pick a colour for this session".
- Chip: mono 9 semibold, tracking 0.9, 1 px square border (chipBorder; SIDE TASK uses violetBorder and violet ink); ink muted.
- StatusLabel: mono 10 bold, `NEEDS YOU`/`WORKING`/`IDLE` (tracking 1.2) + " · " + ago; colour: needs-you amberText, working greenText, idle muted.
- "Dismiss?" pill: 11 semibold, text colour = cell, bg = text colour, radius 5.
- Dismiss x: 9 bold xmark in 20x18 box, segTrack bg radius 5.

Name row: button, TwoToneName size 17 semibold; bright colour = text (idleName when idle); grey prefix = `prefix` colour. If it doesn't fit, the grey prefix is dropped first (ViewThatFits), then tail-truncated. Tooltip "Open this session · <place>". Pointing-hand cursor. Click = open session (see 4).

Lines (VStack spacing 3), **in this order** (L1686-1729), all mono 11.5:

| # | Line | Glyph | Colour | Condition | Remove x |
|---|---|---|---|---|---|
| 1 | ask | `?` | amberText, bold | `ask` non-empty (only set while needs-you) | no |
| 2 | side | `↪` | violet | `side` non-empty | no |
| 3 | paused | `⏸` "Paused: <text>" | muted | side non-empty AND paused non-empty | no |
| 4 | doing | `▶` (SF play.fill 7 pt, green) | doing | **only while status == working**: visible items with isActive | yes |
| 5 | still running | `◷` | doing | status != working AND (jobs or agents or workflows) | no |
| 6 | done | `✓` | muted | `justDid` non-empty | no |
| 7 | next/pending | `·` (or `!` amberText if waitsOnYou) | soft (amberText for waits) | working: non-active visible items; otherwise: active items first then non-active | yes |
| 8 | request fallback | italic 12.5 `You asked: "<request>"` (curly quotes, 2 lines max) | soft | items empty AND justDid empty AND ask empty AND request non-empty | no |
| 9 | caption | mono 10.5 prefix colour | - | `!hasMod` => "No task data yet"; else `fromTaskList` => "From the session's own task list"; else summaries off AND no items => "Summaries are off · no task list in this session" | no |
| 10 | removed | `› N removed` / `⌄ N removed` toggle (mono 11.5 prefix colour); expanded: each removed text struck-through (1 line) + Restore button; "Restore all" when N>1 | - | removed non-empty | - |

- Glyph in its own 14 pt column so wrapped text hangs; line text wraps (fixed vertical size).
- Remove "x" per line: 8 bold xmark in 16x14; visible only on that line's hover (opacity 0.9); tooltip "Remove this line; the summary won't add it back". Writes `removedItems[id]` (also removed.json). Items are filtered by `removed` text equality; restore removes that text.
- Card background: cell; on hover (and not viewing) cellHover. **Viewing** card (focusedId): ring colour (user/auto swatch else blue) at 12% (dark) / 8% (light) tint fill + 2 px inside border.
- Padding: 14 h, 12 top, 13 bottom. Cards separated by the 1 px gap.
- Context menus: right-click a line -> "Copy" (that line); right-click a card -> "Copy session" (plain text, below). Text is selectable by drag (see 4); ⌘C copies.

**Copy session text** (`sessionText`, L1457-1472): header `name (needs you|working|idle <ago> · <place>)`; then `? ask`; `↪ side task: ...`; `⏸ paused: ...`; for working: `▸ <active item>` lines; for non-working with jobs/agents/workflows: `◷ <still-running text>`; `✓ done`; then non-active (or all, for non-working) items as `· text` or `! text · waits on you`; if no items and no done and request: `you asked: <request>`. Removed items excluded.

**Colour picker popover** (SwatchPicker, L1761-1786): title "Colour for this session" (12 semibold); 6-column grid of 24 pt swatches (radius 4, 8 gap); selected one gets a 2 px text-coloured outline; tooltip = name; if user-picked, a "Back to automatic" quiet button. Padding 14, cell bg.

### 2.6 Dismissed section (L2010-2050)

Pinned below the list, sunken bg. Header button: "DISMISSED · N" (mono 10 bold, tracking 1.4, soft) + chevron right/down. Expanded: one line per hidden row: 7 pt status dot, shown name (13 semibold, 1 line), StatusLabel (muted), Restore button. Footer: "Comes back when it needs you." (mono 11 muted) + "Restore all" if >1; 1 px gap-coloured top rule. `showDismissed` is not persisted.

### 2.7 Undo toast (L2214-2240, Board L753-770)

"<name> dismissed" (12; middle-truncated) + "Undo" with "⌘Z" keycap (keycap shown only in the Regular window, `showsKey = regularWindow`). 6 s timer; one at a time (new dismissal replaces). Undo = restore. ⌘Z also works: floating panel handles it in `performKeyEquivalent` (L3118-3123); app menu Edit > "Undo Dismiss" (⌘Z, L3312).

### 2.8 Empty board (L1988-2007)

Title "No sessions in the last 12 hours" (15 semibold); body "Start Claude Code in a terminal, or open a session in Claude Desktop. It shows up here within a few seconds." (12.5, line spacing 4, soft); two mono lines: `claude` + " · in any terminal"; `/session-board` + " · brings this window back". Padding 18 h / 26 v.

### 2.9 Accessibility note (L1970-1986)

Shown only when Accessibility not granted AND Claude Desktop is running. Info icon (tooltip "Without it, the session open in Claude Desktop gets no highlight") + "Turn on **Session Board** in Accessibility" + "Open Settings" button -> `x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility`. **macOS-only; drop on Win/Linux.**

### 2.10 Crash note (L1922-1968)

Shown when `board.crash != nil` (newCrash at launch, L3204). Dot (amber; doing colour after sent) + "Session Board quit unexpectedly". Body: "Send the crash details to the Session Board team? Nothing from your sessions is included." Buttons "Report" (-> "Sending…" while posting) and "Not now". After sent: "Sent. Thanks for the report." then closes after 3 s. Close records `crashSeenAt = crash.at`. On send fail, GitHub issue URL opens instead and the note closes. Details in section 4.

### 2.11 Settings page (L2432-2633) order, keys, defaults, effect

| Section | Control | Key | Default | Effect |
|---|---|---|---|---|
| WINDOW | "Floating or Regular" two-way | `regularWindow` | Floating | Rebuilds window (L3236-3241); Regular = normal window + Dock icon, not over full-screen; Floating = above other apps on every Space. Subtitle changes with mode |
| WINDOW (floating only) | "Hide when you switch away" switch | `hideWhenAway` | on | Window only shows while Claude is frontmost |
| WINDOW (floating only, indented, disabled when hideWhenAway off) | "Terminals and editors count as Claude" | `terminalsCount` | on | Detail: "Terminal, iTerm2, Ghostty, Warp, VS Code, Cursor." Bundle list L232-236 incl. WezTerm, kitty, Alacritty, Zed |
| THEME | Light / Dark two-way | `theme` | unset | Text: "Like Claude Desktop until you pick one." / "Stays as you picked it."; selected segment reflects `isDark`. No way back to "auto" in UI |
| NAMES | "Project first" | settings.json `projectNames` | on | Prefix project to names |
| NAMES (indented; disabled when Project first off) | "Also rename in Claude Code" | settings.json `renameSessions` | off | Mod renames session itself; "A new session's first message waits up to 4 s" |
| SUMMARIES | "Summaries by Sonnet" | settings.json `summaries` | on | Mod calls Sonnet; off => cards show request + task list |
| SOUNDS | "Sounds" master | `soundsOn` | on | Subtitle "Never for ordinary work, never for the session you're viewing." Rest dims/disabled (opacity 0.45) when off |
| SOUNDS | Alert volume bars | `alertVolume` | 0.5 | "Mine" + 10 bars (10%..100%, heights 8+step*1.2); click sets + plays sample at that volume (first moment's sound); label "Your volume" or "N%"; footer text switches: "Sounds play at your Mac's volume." / "Sounds that play on their own play at this volume, then yours goes back." |
| SOUNDS | Row "Needs you" (dot amber): "A permission prompt or a question" | `soundNeedsYou`, choice[0] | on | |
| SOUNDS | Row "Your turn" (dot amber): "A turn ends with something for you" | `soundYourTurn`, choice[1] | on | |
| SOUNDS | Row "Done" (dot idle): "Finished, with nothing left running" | `soundDone`, choice[2] | **off** | |
| each row | sound-name dropdown toggle, "▶ Play", small switch | | | Opens SoundChooser (one open at a time) |
| SOUNDS | error text | | | e.g. unplayable/too long/too big/copy failed messages |
| DESKTOP HIGHLIGHT | "Accessibility is on/off" + "Open" | (live `AXIsProcessTrusted`) | | macOS only |
| SHORTCUT | "Show or hide, from any app"; recorder button; "Reset" (when not standard and not recording) | shortcut keys | ⌃⌥S | Hint: "Click, then press the new keys, or tap a right-hand ⌥, ⌘ or ⌃. Esc cancels." (while recording: "Press the new keys, ..."). Button shows "Type it..." / held modifiers + "..." / current. Border: recording = text 1.5 px; pending clash = amber; else keyBorder. Error text amber. Pending clash: notes + "Use <X> anyway" + "Pick another" |
| FEEDBACK | "Report a problem", "Suggest an idea" | | | Opens GitHub new-issue URL prefilled. Footer "Session Board <version>" (mono 10.5) |

**SoundChooser** (L2683-2729): groups as chips (FlowLayout wrapping, 6 gap): DEFAULT ("Default · <name of the moment's default>"), SESSION BOARD (Mallet=`board:needs-you`, Soft chime=`board:your-turn`, Bell=`board:done`), MAC ALERTS (Glass, Ping, Hero, Submarine, Purr, Funk, Pop, Tink, Blow, Bottle, Frog, Morse, Sosumi, Basso), KENNEY · CC0 (Confirm 1-4, Question 1-3, Glass tap, Rise, Bong, Pluck = files confirmation_001..004, question_001..003, glass_001, maximize_006, bong_001, pluck_002), YOURS (custom chips with hover x to delete + dashed "+ Add your own..." tooltip "A file of yours: under 10 seconds and 5 MB"). Selected chip = text-colour fill. Picking plays it (`chooseSound`, L798-805). Missing sound shows "Missing sound" and falls back to the moment's default (L1215-1221). Deleting a custom sound resets any moment using it to that moment's default (L2800-2806). 28 sounds total (README). Mac alerts are macOS-only: Win/Linux need a substitute list.

### 2.12 Collapsed / sizing

- Collapsed = title bar + header + needs-you strip ("Nothing needs you right now" when none). Window height fitted to measured content, resizes sideways only; re-fitted when rows change (L3619-3628). On collapse the open height is saved per window kind (`expandedHeight`/`expandedHeightRegular`, only if > collapsed+20); on expand restores saved (if >120) else default. Expand only if current height is collapsed-ish (<= collapsed+20). Window min size 260 x 160 (open) or 260 x collapsedHeight.
- Default sizes: floating 330 x 705; regular 765 x 459 (5:3) (L2928, L3028).
- Resize: custom invisible grab band 6 pt on all edges, 16 pt corners, resize cursors; click-through elsewhere (L2933-3025). On Tauri the OS handles resize; a wider hit band may need custom handling (undecorated window).
- Title bar: transparent, content extends underneath (`fullSizeContentView`); list starts below `titleBarHeight` (>= 22). Window title "Session Board". Floating: titled+closable+resizable+utility+nonactivating; Regular: titled+closable+miniaturizable+resizable. Close button hides (sets userHidden) instead of closing (L3601-3605).

### 2.13 Visible-text / tooltip catalogue (extra strings for QA)

Tooltips: "Pick a colour for this session", "Open this session · <place>", "Remove this line; the summary won't add it back", "Settings", "Close", "Click to open" (toast), "Show it in the list", "Remove this sound", "Play the <moment> sound", "Choose the sound"/"Close", "Click to cancel"/"Click, then press the new keys", "Back to <default shortcut>", "Leave the Mac's volume as it is" (Mine). Toast tooltip: `NN · <name>\n<Needs you|Your turn|Done>: <detail>\nClick to open`.

---

## 3. Popup tiles (toasts beside the board)

Source: `ToastCenter` L2069-2112, `ToastCard` L2118-2166, `ToastStack` L2168-2191, `toastFrame` L2203-2212, `placeToasts` L3161-3191, `attention` L3153-3158, `considerSounds` L828-863.

**When created** (`considerSounds`, runs every 2 s reload over non-quiet rows):
- A status counts only after being seen on **2 consecutive reloads** (anti-flicker). First settled status per session produces no event (launch / session appearing).
- Kind 0 "Needs you": settled status changed to needs-you AND `id != focusedId`.
- A turn end is noted when status changes working -> idle (`turnEnded[id]=now`); cleared when it goes to any non-idle status.
- While idle with a recorded end: 
  - Kind 1 "Your turn": any item waitsOnYou AND `now - ended < 90 s` (summary needs a few seconds) -> fires, clears end.
  - Kind 2 "Done": no waits AND nothing running (no jobs, agents or workflows) AND `now - ended >= 15 s` -> fires, clears end. Waits for background jobs however long.
- Both only if `id != focusedId` (never for the session you're viewing).
- Popup shown for **every** moment (even when its sound is off, or sounds are off). `attention()` ignores rows not in Shown (dismissed). Number = index in shown + 1; name = shownName; detail = kind0 ask, kind1 first waits-on-you item text, kind2 justDid; colour = row's colour.
- Popups only appear while the board is visible (`placeToasts` hides the popup window when board hidden/no toasts, L3162-3165). 

**Countdown**: 8 s (`seconds`), 30 fps tick; ring = outline trimmed to `progress = 1 - elapsed/8`. Max 4 on screen; newest on top; one per session (a new one replaces the old for that row). **Hover holds** that one toast's countdown (others keep going). Timer runs only while toasts exist.
**Look**: 40x40 tile radius 9, number mono bold 15 in swatch colour (user/auto) else amber (kinds 0/1) or idle grey (kind 2) with matching ink; 1.5 px text-colour rounded outline ring, inset -2.5, radius 11.5, round caps; dot top-right (9 pt amber, or idle grey for done; ring of gap colour 1.5) which on hover grows to 14 pt, turns text-colour with an x; drop shadow (black 35% dark/12% light, r3 y1). Stack: right-aligned column, 9 spacing, 8 padding. Hover tooltip as 2.13. Pointer-hand cursor.
**Click**: tile = open that session (`openSession`) and remove toast; dot/x = close only.
**Removal**: when you switch to a session (any way: `focusedId` change removes that row's toast, L3244-3246) and when `openSession` runs for it (L94).
**Placement** (`toastFrame`): the popups live in a separate borderless, non-activating, click-through-to-key (can't become key/main) floating window, level = board level + 1, join all Spaces + full-screen auxiliary, transparent, no shadow. Rules relative to the board frame B on its screen's visible frame S, gap 4:
1. Left of the board if it fits; 2. else right; 3. else above (centred, clamped); 4. else below; 5. else "over" the board, 70 pt under its top.
For sides 1-2: top aligned `below` pt under the board's top: `below = 0` if collapsed / settings / list top unknown, else `titleBarHeight + listTop + 4` (so the first tile lines up with the first card). Y clamped into S.
Test hook: `test-toast` file (see 5).

---

## 4. OS integrations

Feasibility legend: easy / possible / hard / not possible. "Tauri" notes the likely mechanism.

| # | Feature (what it does) | macOS API used (lines) | Windows equivalent | Linux equivalent |
|---|---|---|---|---|
| 1 | **Floating always-on-top panel on all Spaces**, doesn't steal focus/activate the app, utility window, joins full-screen aux | `NSPanel` `.nonactivatingPanel`, level `.floating`, `collectionBehavior [.canJoinAllSpaces,.fullScreenAuxiliary]`, `canBecomeKey=false` unless selecting (L3054-3128, L3345-3351) | **easy-possible**: `alwaysOnTop` + `visibleOnAllWorkspaces` (no-op; Windows has one desktop per virtual-desktop unless using pinned-window API, possible via `IVirtualDesktopManager`/`WS_EX_TOOLWINDOW`); non-activating via `WS_EX_NOACTIVATE` through a Rust crate (possible); shows over fullscreen apps only for borderless-windowed, not exclusive fullscreen | **possible**: X11: `_NET_WM_STATE_ABOVE`+sticky works; Wayland: always-on-top and all-workspaces are NOT guaranteed (compositor-dependent; GNOME blocks; wlroots layer-shell via gtk-layer-shell works) => **hard on GNOME/Wayland** |
| 2 | **Regular window mode + Dock icon** (switch activation policy accessory/regular at runtime) | `NSApp.setActivationPolicy`, `NSWindow` (L3334-3351, L3933) | easy: taskbar entry via `skipTaskbar` toggle; floating mode should be `skipTaskbar=true` | easy: `skipTaskbar` (X11/most Wayland) |
| 3 | **Remembered frame per window kind** | `setFrameAutosaveName` (L3338, L3388-3395) | easy: tauri-plugin-window-state, key per mode | easy |
| 4 | **Custom edge-resize band, click-through hit testing, resize cursors in background app** | `ResizeEdges` NSView, `CGSSetConnectionProperty("SetsCursorInBackground")` private API (L2933-3025, L3917-3927) | easy if native decorations; if frameless, implement in web (`startResizeDragging`) | easy-possible (Wayland: `startResizeDragging` works) |
| 5 | **Transparent title bar with content under it** | `titlebarAppearsTransparent`, `fullSizeContentView` (L3354-3361) | possible: custom frameless titlebar in web UI (`decorations:false`, own drag region) | same |
| 6 | **Select text with drag, ⌘C copies, without stealing keyboard focus until drag >10 pt** | `BoardPanel.sendEvent` drag threshold `selectDragDistance=10`, `wantsKeyboard`/`makeKey`, `releaseKeyboard` (orderOut/orderFront trick), `performKeyEquivalent` for c/a/z (L3030-3128) | **hard**: non-activating window cannot receive keys; alternative: offer a "Copy" context menu/button only (right-click copy already exists) or briefly focus on drag. Decision needed | **hard** (same; Wayland never lets an unfocused window take keys) |
| 7 | **Right-click Copy / Copy session; clipboard** | `NSPasteboard` (L1451) | easy (`tauri-plugin-clipboard-manager` or `navigator.clipboard`) | easy |
| 8 | **Menu-bar status item: "◉ N" working, " · M!" when M need you; left click toggles window; right-click menu "Show/Hide window <shortcut>", "Settings…", "Report a Problem…", separator, "Quit Session Board"** | `NSStatusItem` title text + `performClick` menu (L3222-3231, L3650-3675) | **possible**: system tray icon. Windows tray cannot show text beside the icon; need a **generated icon with number** (render PNG dynamically) and tooltip. Left/right click events supported | **possible/hard**: AppIndicator/StatusNotifier; GNOME needs the AppIndicator extension; text label via `set_title` works on some DEs (KDE); icon-with-number fallback. Left-click events not delivered on all SNI hosts (menu only) |
| 9 | **App menu + Edit menu**: "Settings…" (⌘,), "Quit Session Board" (⌘Q), Undo Dismiss (⌘Z), Copy, Select All (L3301-3321) | `NSMenu` mainMenu | possible: Tauri menus; Windows has no app menu bar for this style app; map to in-window shortcuts (Ctrl+,/Ctrl+Z) | possible, same |
| 10 | **Global hotkey show/hide, default ⌃⌥S (Ctrl+Alt+S)**, recorded in Settings; Esc cancels; key labels (arrows, F1-F20, Space etc.); modifier symbols order ⌃⌥⇧⌘ | Carbon `RegisterEventHotKey` + app event handler (L3410-3448, L296-392) | easy: `tauri-plugin-global-shortcut` (RegisterHotKey). ⌘ becomes Win key/Super (reserved on Windows: many Win+X combos can't be registered) | easy-possible on X11; **hard on Wayland** (no global hotkeys without the GlobalShortcuts portal/compositor binding; use xdg-desktop-portal GlobalShortcuts where available) |
| 11 | **Right-hand modifier tap as shortcut** (Right ⌥/⌘/⌃ pressed alone and released <0.5 s, no key/click/other modifier between); display "Right ⌥" etc.; needs Accessibility for other apps' events | `NSEvent` global+local monitors for flagsChanged/keyDown/mouseDown, `TapWatch` with device bits 0x40/0x10/0x2000 (L339-363, L3423-3440) | **possible**: low-level keyboard hook (`WH_KEYBOARD_LL`, distinguishes VK_RMENU/VK_RCONTROL/VK_RWIN) in Rust (rdev/`windows` crate); no permission prompt. Right Alt is AltGr on many layouts: warn | **hard**: X11 via XInput2/rdev OK; Wayland not possible (no global key capture) |
| 12 | **Shortcut recording UI + validation**: recording unregisters current; refuse combos without ⌘/⌃/⌥ unless F-key or modifier tap; Esc cancels; click-away cancels; if registration fails revert to ⌃⌥S with message ("macOS didn't accept ..."); on clash hold as "pending" with notes + "Use anyway"/"Pick another" | `consider/useShortcut/stopRecording`, `windowDidResignKey` (L3450-3533), `shortcutProblem` L497-502 | easy (web key capture; Rust re-register) | easy |
| 13 | **Shortcut clash checking**: (a) macOS symbolic hotkeys that are enabled (`CopySymbolicHotKeys`) + names from `com.apple.symbolichotkeys` prefs + built-in default list; (b) menus of running Claude Desktop & terminals/editors via Accessibility (menu item cmd char/virtual key + modifiers; depth<=6, <=3000 nodes, 0.5 s timeout), notes like “New Session” in Claude; (c) common app shortcuts list (Quit, Close, Copy ... Force Quit, Log Out); modifier tap => only note about AX permission. Message text: "<X> is macOS's “<name>” shortcut, so it may not reach Session Board." / "<X> is <menu items> . Session Board would take it over in every app." / "<X> is <name> in most apps. Session Board would take it over in every app." | `CopySymbolicHotKeys`, `AXUIElement` menu bar walk, tables L392-427, L430-525 | **possible (reduced)**: only a static list of OS shortcuts (Win+L, Win+D, Alt+Tab, Alt+F4, Ctrl+Shift+Esc, ...) and "failed to register" detection (RegisterHotKey fails if taken by another app = a real clash signal). App-menu scanning via UI Automation = hard, skip | **possible (reduced)**: registration failure is the signal on X11; static list for DE shortcuts; menu scanning not possible |
| 14 | **Which Claude Desktop session is focused** (highlight): when Claude Desktop is frontmost, read its focused window's AXWebArea title ending " - Claude Code", match to rows by `sameName` (ties: smallest `since`); page element cached; `AXManualAccessibility` set to make Electron expose tree; BFS depth 14, <=400 per level; no match with a name => clear highlight (don't keep old); status.json updated | `AXIsProcessTrusted`, `AXUIElement*`, `NSRunningApplication` (L229-292, L1109-1139) | **possible**: Claude Desktop window title via `GetForegroundWindow`+`GetWindowText` (no special permission) -- the title is likely "<session> - Claude Code" or similar (**verify the real Windows title**); UI Automation for web area title if needed | **hard**: X11 `_NET_ACTIVE_WINDOW` + `_NET_WM_NAME` easy; Wayland no way to read other apps' titles (some DEs via portals/extensions) ; Claude Desktop has no official Linux build anyway |
| 15 | **Highlight for terminals**: when Terminal/iTerm2 frontmost, get tty of selected tab/current session (AppleScript), `ps -t <tty> -o pid=`, match pid to registry pid -> focusedId. Throttled to >=1/s, async | `NSAppleScript`, `/bin/ps` (L1140-1165) | **hard/possible**: Windows Terminal has no scripting API for active tab; heuristic: foreground window process tree (find `claude` pid under front terminal) or window title match; VS Code/others unknown. Likely "partial: only when exactly one claude under the focused terminal window" | **hard**: kitty/wezterm have CLIs (`kitty @ ls`, `wezterm cli list`) => possible per-terminal; gnome-terminal/konsole: no; X11 active window pid -> child process search is a workable generic fallback |
| 16 | **Focus a session's terminal tab** (open): AppleScript finds tab whose tty == session's tty, selects, raises, activates (Terminal: `selected of t`, `index of w`; iTerm2: select w/t/s); only if that app already running; else walk parent pids (max 12 hops via `sysctl kinfo_proc` ppid) to the nearest `.regular` app and activate it (VS Code, Cursor, Ghostty...) | `NSAppleScript`, `ps -o tty=`, `sysctl KERN_PROC_PID`, `NSRunningApplication.activate` (L123-186) | **possible (app-level only)**: walk parent pid chain to the owning GUI process (`sysinfo`/ToolHelp), `SetForegroundWindow` for its main window (foreground-lock rules may need `AllowSetForegroundWindow`/ALT-key trick); per-tab selection **not possible** for Windows Terminal (can use `wt` CLI only to open new tabs) | **possible (app-level)**: X11 `_NET_ACTIVE_WINDOW` by pid via wmctrl/xdotool-like; Wayland **not possible** generally (activation tokens only via `xdg-activation` for apps you launch) |
| 17 | **Open a session**: if Claude Desktop is running and the session has `bridgeSessionId` => `claude://claude.ai/code/<bridgeId>`; else if desktop-entrypoint and a local id is found in Desktop's `claude-code-sessions` => `claude://code/continue?session=<local_id>&source=session_board`; else focus terminal (#16). Removes the row's popup first | `NSWorkspace.open(url)`, `NSRunningApplication` bundle `com.anthropic.claudefordesktop` (L92-109) | easy for URL scheme (`tauri-plugin-opener`/shell open; registered `claude://` handler on Windows if Claude Desktop installed). Detect "Desktop running" by process name (`Claude.exe`). `claude-code-sessions` path = `%APPDATA%\Claude\claude-code-sessions` (verify) | `claude://` handled only if a Linux Desktop exists; else fall back to claude.ai URL `https://claude.ai/code/<bridgeId>` in browser (consider as a general fallback on all OSes when Desktop isn't running; the Swift app doesn't do this) |
| 18 | **Front-app following ("hide when away")**: floating window shows when Claude Desktop (bundle `com.anthropic.claudefordesktop`) is frontmost, or a terminal/editor (list of 10 bundle ids) if `terminalsCount`; hides otherwise; ignores own app being front; `userHidden` overrides everything (persisted); regular window ignores this except at launch (show); a second check 1 s after launch because the OS may still report this app frontmost; reacts to setting changes immediately | `NSWorkspace.didActivateApplicationNotification`, `frontmostApplication` (L3211-3217, L3557-3580) | **possible**: poll foreground window (`GetForegroundWindow` -> process exe name) every ~250-500 ms (no event for it without WinEvent hook `EVENT_SYSTEM_FOREGROUND`, which is possible); process list: `Claude.exe`, `WindowsTerminal.exe`, `Code.exe`, `Cursor.exe`, `wezterm-gui.exe`, `alacritty.exe`, `Warp.exe`, `kitty.exe`, `zed.exe`, `iTerm` n/a | X11 easy (`_NET_ACTIVE_WINDOW` + `_NET_WM_PID`); **not possible on Wayland** (fall back to "always show") |
| 19 | **Dock/launch behaviour**: `applicationShouldHandleReopen` (open -g on running app only keeps it running; a window you hid stays hidden; Dock click in regular mode shows it); `show-request` file shows window; launch shows window; app started with `LSUIElement` (no Dock) | AppKit delegate (L3692-3700, L3582-3598, build.sh L72) | single-instance plugin: second launch should do the same ("show only if regular & active else follow rules") | same |
| 20 | **Show request from `/session-board`**: poll `show-request` 1 s, compare with handled stamp, un-hide and show | file poll (L3582-3598) | easy | easy |
| 21 | **Theme following**: pick -> Claude Desktop `userThemeMode` -> system. Instant on macOS appearance notification; also each 2 s | `UserDefaults AppleInterfaceStyle`, `DistributedNotificationCenter` (L527-544, L3247-3250) | easy: `prefers-color-scheme` / Tauri `theme` + `%APPDATA%\Claude\config.json` (verify path/key) | easy: `prefers-color-scheme`; `~/.config/Claude/config.json` if exists |
| 22 | **Sounds**: three moments, each chosen from 28 sounds + custom files (<=10 s, <=5 MB, any audio macOS plays, copied into `<appDir>/sounds`); ▶ Play preview at the system volume as is; automatic alerts at the "alert volume" (default 50%, "Mine" = leave volume): **save current system volume + store `volumeToRestore`/`volumeAlertTarget` in prefs, set output volume to target unless already within 0.01 or muted (muted stays muted) or device has no settable volume, play, restore after `max(0.3, duration)+0.25 s` only if the volume is still ≈ target (±0.02, i.e. you didn't change it); at next launch, if `volumeToRestore` still set, restore it (crash safety)**. Rate limit: at most **one automatic sound per 8 s**; among simultaneous moments the most urgent (lowest kind) wins; respects per-moment switch and master. Each sound logged to sounds.log | `NSSound`, CoreAudio `kAudioHardwareServiceDeviceProperty_VirtualMainVolume`, `kAudioDevicePropertyMute` on default output (L1169-1317, L3262-3298) | **possible**: play via Rust `rodio` (or HTML audio with per-element `volume`). **Simpler and recommended: scale the playback gain instead of changing the system volume** (loses "alert is 50% of Mac volume" semantic, but nothing to restore). To keep parity, use Core Audio Windows `IAudioEndpointVolume` (set/restore master volume, GetMute) via `windows` crate: easy-possible. Mac system sounds do not exist: provide bundled substitutes or Windows `C:\Windows\Media\*.wav` list | **possible**: `rodio`/cpal; system volume via `pactl`/`wpctl`/ALSA (possible but varied); recommend gain scaling. System sound dir `/usr/share/sounds/freedesktop/stereo/*.oga` as the "system" group |
| 23 | **Custom sound file picker** | `NSOpenPanel` audio (L3262-3298) | easy (`tauri-plugin-dialog`); validate duration via audio decode in Rust; error strings at L3272-3294 | easy |
| 24 | **Accessibility permission prompt** once at launch (`askedAccessibility`), live status in Settings, note on board | `AXIsProcessTrustedWithOptions` (L3251-3255, L1012) | n/a (no permission model) -> drop UI, always "on" | n/a |
| 25 | **Automation permission (Terminal/iTerm)** | `NSAppleEventsUsageDescription` Info.plist (build.sh L77) | n/a | n/a |
| 26 | **Crash report prompt**: on launch, look at `~/Library/Logs/DiagnosticReports/SessionBoard*.ips` newer than `crashSeenAt`; first run only records the time; parse `.ips` (line 1 JSON header, rest JSON): exception type/signal, first 10 frames of the triggered thread (`imageIndex`->`usedImages[].name`, symbol, sourceFile:line), `asi` messages; body = "### The window app crashed" + "<type> <signal> at <ISO>" + messages + fenced frames + "- Session Board: <ver>" + "- macOS: M.m.p"; home dir replaced with "~"; title "Window app crashed: <type>". Send: POST JSON `{kind:"crash",source:"crash",title,body}` to `https://session-board-reports.kiran-987.workers.dev/report`, 15 s timeout, success = HTTP 201 and `{ok:true}`; failure => open `https://github.com/KiranPothana/session-board/issues/new?title=Crash: <title>&body=<details>` | file read, `URLSession`, `NSWorkspace.open` (L2317-2399) | **Port decision**: Windows Error Reporting has no equivalent file; use a Rust panic hook / `tauri-plugin-log` crash file + `minidump` optional. Keep the same worker endpoint/body shape if the report inbox is reused | same (panic hook; coredump not practical) |
| 27 | **Feedback**: "Report a problem"/"Suggest an idea"/status-item "Report a Problem…" open `https://github.com/KiranPothana/session-board/issues/new` with title "Bug: "/"Idea: " and a body: template ("### What happened ... ### What you expected" or "### The idea") + `<details>` block: Session Board version, macOS version + arch (`uname` machine), Settings (theme(or auto), regularWindow, hideWhenAway, terminalsCount, soundsOn, summaries, accessibility), Sessions on the board (rows.count), footer "_Sent from the Session Board window._" (L2403-2430) | `NSWorkspace.open`, `uname` | easy (opener plugin; OS string via `os_info`) | easy |
| 28 | **App icon**: drawn in code (dark rounded tile 0.13 grey at 100/1024 inset, radius 185; three rows: orange / green / grey dots 90 px + bars 450 px x length 0.62/0.78/0.5 at 0.9/0.9/0.45 alpha); `--iconset` emits 16/32/128/256/512 @1x/@2x PNGs for `iconutil` (L3703-3743) | CoreGraphics/AppKit | port: ship PNG/ICO/ICNS assets (generate once from this drawing; `tauri icon`) | ship PNG set |
| 29 | **Process/pid helpers**: `ps -o tty=`, `ps -t`, `ps -axo etime=,command=`, `sysctl` ppid walk | POSIX | use `sysinfo` crate (cross-platform process list, start time, cmdline, parent) -- replaces all ps/sysctl use; Windows tty concept n/a | same |
| 30 | **Single instance**, pkill of old build in build.sh, build lock with 10 min stale takeover, ad hoc/Apple Dev codesign to keep Accessibility grant, Info.plist (LSUIElement, LSMinimumSystemVersion 15.0, bundle id `io.github.kiranpothana.session-board`, version from `.claude-plugin/plugin.json`) | build.sh | The whole "build on the user's Mac from source" install model disappears with a prebuilt Tauri bundle: the mod (`hooks/register.js`) must be changed to download/launch the signed binary and use an app-version check instead of `built.sha`. Notarization/SmartScreen/AppImage signing become new requirements | same |
| 31 | **Auto-start / "open -g"** by the mod; keep-running without showing | mod-side | mod must launch with a "background" flag so it does not show (Swift: reopen event while hidden stays hidden) | same |

Port gotchas not tied to one row:
- Everything runs on the same-process timers; Tauri can do the file polling/`sysinfo` work in Rust and push a `rows` snapshot event to the web UI (diff it, like `jobs != found`, L1059).
- `focusedId` write triggers `status.json` writes; keep the file for the "troubleshooting" claim in README (drop `accessibility` or hard-code true on Win/Linux).
- The README's "○ what's next" glyph is **not** what the code draws: code uses `·` (pending) and `!` (waits on you). Port the code behaviour, update README.
- Time units: registry/store timestamps are milliseconds; `since`/`ago` are in seconds.

---

## 5. CLI / test hooks the app exposes (L3877-3934, L3745-3875)

| Flag | Behaviour |
|---|---|
| `--store-prefix <p>` | Override store file prefix (default `session-board_`) for trying another install's records (L3879) |
| `--snapshot <out.png> [...]` | Render the board to PNG at 360 px width, 2x scale, no window; **exits**. Prints `snapshot <path> <n> rows`. Does not save settings (`drawingSnapshot` guards `soundChoices`, `alertVolume`, `sessionColors`, `autoColors` writes; collapsed restored via defer). Draws a 28 px fake title bar "Session Board" (L3840-3845) |
| `--settings` | Show the Settings page (SettingsContent) |
| `--light` / `--dark` | Force theme for the snapshot |
| `--collapsed` | Collapsed layout |
| `--dismissed` | Open the Dismissed section |
| `--undo` | Show the undo toast for the first hidden row |
| `--empty` | Force an empty board |
| `--viewing <n>` | Mark the n-th shown card as the focused/viewing one |
| `--shortcut-clash` | Settings with a pending ⌘N clash warning (uses real `shortcutClashes`) |
| `--no-accessibility` | Simulates AX off + Desktop running (accessibility note, Settings text) |
| `--crash` | Shows the crash note with a fake EXC_BREAKPOINT crash |
| `--sample` | Use built-in `sampleRows()` (6 fake sessions: tracker needs-you w/ ask, mobile working w/ doing+next, board working w/ side+paused, seo idle desktop w/ yours waits + 1 workflow + "browser tests 6m", tests working w/ task-list, cleanup idle 3 h desktop w/ request) instead of real data; colours reset and auto-assigned deterministically (L3750-3775, L3796-3804) |
| `--sound-chooser` | Settings with the first sound picker open |
| `--toasts` | Render three popup tiles (kinds 1, 0, 2 at elapsed 0/3/6 s; colours Pink/none/Teal) on a grey backdrop and exit (L3825-3839) |
| `--crash-report <file.ips>` | Print title + details the crash prompt would send; exit 0, or "not a crash report this can read" exit 1 (L3884-3888) |
| `--check-shortcut <keyCode> <carbonMods> <label>` | Prints `<display> → <problem|free|clashes joined " | ">`; exit 0 (L3890-3895). Carbon mods: cmd 256, shift 512, option 2048, control 4096 |
| `--test-alert` | Prints system volume before/while/after playing the default needs-you alert (checks set-and-restore; exits after the callback or 5 s) (L3896-3908) |
| `--iconset <dir>` | Write the .iconset PNGs and exit (used by build.sh) (L3725-3743, L3909) |
| `<appDir>/test-toast` file | Runtime popup trigger (see 1.1) |
| `defaults write <bundle id> extraStorePrefixes -array name_` | Hidden pref (L623-626) |
| build.sh `[APP_PATH]` | Build/sign/install; writes `built.sha` only when an explicit path is given |

Porting suggestion: keep an equivalent of `--snapshot` (headless render of the web UI through a webview screenshot or Playwright) and `--sample`, since they are how the layout is regression-tested; `--check-shortcut` and `--crash-report` become Rust unit tests or `cargo` bins.

---

## 6. Behaviour rules that are easy to lose (checklist)

1. Needs-you sort first, then working, then idle; inside each, most recently entered first (L728).
2. 12 h idle cutoff hides rows; Dismissed shows all dismissed rows, even quiet.
3. Stale-record rule (10 min) applies only if the registry dir cannot be read.
4. Shadow records never decide status; turnEnded only wins if no newer registry status change.
5. "Waits on you" only applies when the session is idle; a working session never shows `!`.
6. Active ▶ lines render only while working; once idle they fall into the list as `·` (active items first), with ◷ for jobs.
7. 2-reload debounce, first-sighting silence, 8 s global sound limit, 15 s done delay, 90 s your-turn window, most-urgent-wins.
8. Sound + popup suppressed for the focused session; dismissed sessions get no popup.
9. Dismissed session returns automatically when it enters needs-you after dismissal.
10. Ids pruned from dismissed/removed/colours only when rows non-empty.
11. Auto colours: sticky, random, perceptually distinct, state-like colours excluded; user pick persists and "Back to automatic".
12. Window: userHidden persists across relaunch; close button = hide; `show-request` always unhides; regular window ignores hide-away rules (except showing at launch).
13. Settings.json holds only the three mod-shared flags; all other prefs live in app prefs.
14. Collapsed height fitted dynamically and restored per window kind.
15. Cleanup: logs capped (200 KB sounds.log, 100 KB keyboard.log).

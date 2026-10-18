# Session Board

**[sessionboard.dev](https://sessionboard.dev)** · [Privacy](https://sessionboard.dev/privacy)

**Session Board is a Claude Code mod that shows every Claude Code session on your computer in one floating window**, with a live summary of each: what it just did, what it's doing, what's next, and which sessions need you. Terminal, Remote Control and Claude Desktop. Mac, Windows and Linux.

✓ what it did · ▶ what it's doing · · what's next · ! what's waiting on you

<details><summary><b>Copy for AI</b>: paste this into Claude and it explains Session Board and installs it for you</summary>

<!-- ai-overview -->

````text
I'd like to try Session Board. Read this, explain it to me in two short lines (I don't like reading much), then offer to install it for me.

# Session Board (https://sessionboard.dev)

Free, open source (MIT) Claude Code plugin for Mac, Windows and Linux: https://github.com/KiranPothana/session-board

What it is: one small floating window that lists every Claude Code chat running on this computer (terminal, Remote Control, Claude Desktop). Each chat gets a card that keeps a live stand-up:
- ✓ what it just finished
- ▶ what it's doing now
- ○ what's next, with "waits on you" on anything blocked on me
- ↪ a side task, when I've sent it off on a detour

Also:
- Cards are ordered: needs me, then working, then idle.
- A small popup tile shows when a chat needs me or finishes.
- Clicking a chat's name opens it.
- Control-Option-S shows or hides the window.
- Optional sounds; light and dark.

Needs: Claude Code 2.1.287+, and macOS 15+ with Apple's command-line tools (`xcode-select --install`), Windows 10/11, or a 64-bit Linux desktop.

Install (run these for me):
```sh
claude plugin marketplace add KiranPothana/session-board
claude plugin install session-board@session-board
```
Then I start a new Claude Code session, or type /session-board in one. The first time, it gets the window app ready (on a Mac it builds it in under a minute; on Windows and Linux it downloads it and checks its checksum) and opens it. Chats already running show up too.

Cost: the summaries are small Sonnet calls billed to my Claude account (about 2,000 tokens in, a few per turn). They can be turned off in Settings. Everything else stays on my computer. Bug reports are sent only when I say "report" (or click Report), and never include anything from my chats.

Update: `claude plugin update session-board@session-board`. Uninstall: `claude plugin uninstall session-board@session-board`, then quit it from the menu bar.

Something wrong or an idea? Tell Claude in any session and say "report", or open https://github.com/KiranPothana/session-board/issues
````

<!-- /ai-overview -->

</details>

## In more words

One floating window on your computer (Mac, Windows or Linux) that lists every Claude Code session you have running (in the terminal, over Remote Control, and in Claude Desktop) with what each one is working on, what is still to do, and which ones need you.

It's a Claude Code [mod](https://code.claude.com/docs/en/plugins/mods/overview) plus a small window app: on a Mac a native one the plugin builds the first time you use it, on Windows and Linux one the plugin downloads (and checks) the first time.

## What you get

- **A row per session** active in the last 12 hours: needs you, working or idle, and for how long; the task it's on, in a line anyone could follow (◎); what it just finished; and a short list of active and pending items.
- **Cloud sessions, summarized.** When Claude Desktop shows a cloud session's chat, the board keeps its latest exchanges and summarizes them like a local session's: the task, what it did, what's under way and what's next. The card then shows the last summary until Desktop shows the chat again.
- **Claude Desktop's names.** A session Claude Desktop runs goes by the name its sidebar shows, and a side session it started from another says which one ("↳ Side session of …").
- **Long sessions keep their thread.** The task line and the steps still ahead (review, sandbox, go live) carry over from summary to summary until the session finishes them or moves to other work, so a session 50 turns in still says what it's for, not just its latest command.
- **Idle doesn't mean nothing is happening.** If a session finished its turn but left tests, a build or a server running, its row says "Still running: browser tests · 6m". The summary knows too, so it doesn't call work active once the command has ended. Until that work reports back, the session's "done" alert waits: it comes when the run ends, not while it's still going. Besides the running processes, the board reads the session's conversation for commands it started in the background that haven't reported back, so one the process check misses still counts.
- **Needs you** shows when a permission prompt, a question or a plan approval is on screen. Items that wait on your answer are marked "waits on you".
- **Follows what you're looking at.** The session open in Claude Desktop, Terminal or iTerm2 is highlighted and kept at the top of the list.
- **Order:** needs you, then working, then idle. Within each group, the session that most recently entered that state comes first.
- **A popup when a session wants you.** When a session needs you, ends its turn with something for you, or finishes, a small tile with its number shows beside the board for 8 seconds; the white outline around it runs down until it goes. Its dot is amber when it wants you, grey when it's done; hover for the name and why (hovering also holds it), click to go to the session, or click the dot (×) to close it. It sits left of the board, else right, else above or below, and over the board's top when no side has room. Never for the session you're viewing, and only while the board shows.
- **Click a name to go there.** Clicking a session's name (or its popup) opens it: in Claude Desktop (a Remote Control session by its claude.ai page, one of Desktop's own by its id there), otherwise its tab in Terminal or iTerm2, or the app it runs in.
- **Remove a bullet** with the × that shows on hover, and summaries won't bring it back. Each session lists what you removed, with Restore. You can also dismiss a whole session and restore it from Dismissed.
- **Nothing cut short for good.** Each card line shows at most two lines; hover one cut with "…" (or a name that doesn't fit) and its whole text shows in a tooltip.
- **Copy.** Select text and press ⌘C, or right-click for Copy and Copy session.
- **Out of the way.** Press ⌃⌥S (Control-Option-S) in any app to show or hide the window. You can collapse it to one line of counts. The menu bar item shows how many sessions are working.
- **Project first.** Each name starts with its project, in grey: the Git repo the session's folder belongs to (a worktree counts as its main repo), or the folder itself. Sessions of one project then read as a group. Turn it off in Settings → Names.
  - **Also rename in Claude Code** (advanced, off by default) renames each session itself that way ("web-app · Fix the login"), so Claude Code and Claude Desktop show the project too. On a first request the mod asks Sonnet for the rest of the name (one small call; the request waits up to 4 seconds for it); a session Claude already named gets the project put in front on your next request. It renames each session once, so a name you give it later stays. The plugin's command hook (`hooks/session-title.mjs`, on UserPromptSubmit) sets the name, since Claude Code lets only such hooks set a session's title.
- **Your own shortcut.** In Settings, click the shortcut and press a new one, or tap the right-hand ⌥, ⌘ or ⌃ on its own to use that tap. A tap works in other apps only with the Accessibility permission.
  - Before using it, Session Board checks it against macOS's shortcuts and the menus of Claude Desktop and your open terminals and editors.
  - On a clash it tells you what the shortcut already does and lets you use it anyway or pick another.
  - Other apps' own global shortcuts can't be checked, because macOS keeps no list of them.
- **Settings** (the gear):
  - **Theme: Light or Dark.** Until you pick one, it follows Claude Desktop (or macOS, when Desktop follows the system or isn't installed).
  - **Window: Floating or Regular.** Floating is a popup above other apps on every Space. Regular is a normal window on your desktop, with a Dock icon, that other windows can cover.
  - Hide the popup when you switch away from Claude.
  - Count terminals and code editors as Claude.
  - Turn the summaries off.

You don't need Claude Desktop. With terminal sessions only, the window works the same; it just has no Desktop session to highlight.

## Requirements

- **Claude Code 2.1.287 or later**, the first version with mods. It's tested with 2.1.296, and the mods API can still change between Claude Code releases.
- **Mac:** macOS 15 or later, and Apple's command-line tools to build the window app (`xcode-select --install`). It's tested with Swift 6.4 on macOS 27.
- **Windows:** Windows 10 or 11 (64-bit), with the WebView2 runtime that comes with them. *New in 0.2.0: tested on GitHub's Windows build machines, not yet by people.*
- **Linux:** a 64-bit desktop with X11, or Wayland with the limits below. The app is an AppImage. *New in 0.2.0, as Windows.*

### What works where

Everything works on a Mac. On Windows and Linux, the board, summaries, popups, sounds, dismiss, colours and Settings
are the same; some things depend on what the system lets an app see:

| | Mac | Windows | Linux X11 | Linux Wayland |
|---|---|---|---|---|
| Floats over other windows, shortcut from any app | yes | yes | yes | no: open it from the tray |
| Highlights the Claude Desktop chat you're in | yes | yes | (no Claude Desktop) | no |
| Highlights the terminal session you're in | Terminal, iTerm2 by tab; others by window | by window | by window | no |
| Click a name to go to a terminal session | its tab (Terminal, iTerm2), else its app | its app | its app (with `xdotool`) | no |
| Hide when you switch away from Claude | yes | yes | yes | no |
| Your own shortcut and your own sounds | yes | yes | yes | sounds yes; no global shortcut |
| A right-hand ⌥, ⌘ or ⌃ tapped on its own as the shortcut | yes | no | no | no |

## Install

```sh
claude plugin marketplace add KiranPothana/session-board
claude plugin install session-board@session-board
```

Then start a new Claude Code session, or type `/session-board` in one.

- **Mac:** the first time, the plugin builds the window app into `~/Applications/Session Board.app` (under a minute) and opens it. It builds again only when an update changes the app's source.
- **Windows and Linux:** the first time, the plugin downloads the window app from this repo's release for its version, checks it against the SHA-256 in `app/release.json` (part of the plugin; a download that doesn't match is thrown away), and starts it. Windows: `%LOCALAPPDATA%\Programs\Session Board`. Linux: `~/.local/share/session-board/app`. When several sessions start together, one installs it: an `install.lock` file in that folder, which only one session can create, holds the others off, and each download goes under a name of its own.
- Sessions that were already running show up too, with no restart. Once one session runs the plugin, it reads the others' saved conversations every 30 seconds.

To update: `claude plugin update session-board@session-board`.

## Permissions

On a Mac the window asks for these permissions (Windows and Linux ask for none):

- **Accessibility**, to read which session Claude Desktop has open, for the highlight, and the cloud sessions in its sidebar. Without it, everything else still works. It's in System Settings → Privacy & Security → Accessibility.
- **Automation for Terminal or iTerm2**, asked the first time one of them is in front, for the highlight there.

The app is signed ad hoc unless you have an Apple Development certificate. An ad hoc rebuild after an update counts as a new app to macOS. If the highlight stops following Claude Desktop after an update, turn Session Board off and on again in the Accessibility list.

## Cost and privacy

**Summary calls:** the plugin asks Sonnet (low effort) for each session's short active/pending list:
- when you send a message, so the board shows the new work right away;
- when a turn ends;
- during a long turn, at most every 90 seconds, and only when the session has written something new.

Each call is small: about 2,000 tokens in and 100 out.

That's a few small calls per turn, per session, billed to your Claude account like the rest of your Claude Code use.
- Each call sends the last four requests and replies (about 15,000 characters at most), up to eight earlier requests cut to a line each, and the previous list.
- The list is rebuilt from those each time: finished or abandoned items drop off instead of piling up, and the task and the steps still ahead carry over while they're open.
- To stop the calls, turn **Summaries by Sonnet** off in Settings. The board then shows each session's request and its own task list.

**Everything else stays on your Mac.**
- The window reads files Claude Code already writes: the session registry in `~/.claude/sessions` and the plugin's store.
- On a Mac it also reads Claude Desktop's window, through Accessibility: which session is open (for the highlight), and the names and status of the sessions in its sidebar, and the latest exchanges of a cloud chat you have open there (for cloud cards). None of it leaves your Mac, except a cloud chat's exchanges, which go to the summary like any session's (unless summaries are off) and are kept in `~/Library/Application Support/session-board/cloud` for a week at most. Session names from Desktop's own session files (`~/Library/Application Support/Claude/claude-code-sessions`) tell its local sessions apart from cloud ones.
- It talks to no server on its own.

**Reports, only when you choose to send one.** Nothing is sent until you say **report** in a chat or click Report
(a crash) or a Feedback button in the window:
- **What's sent:** your description, the versions of Session Board, Claude Code, macOS and Swift, the window's
  settings, how many sessions are on the board, Session Board's recent error messages, and the top of the stack of a
  crash. Your home folder and user name are removed. Nothing from your chats is sent: no session names, summaries,
  requests or project names.
- **Where it goes:** with the GitHub CLI signed in, a public issue on this repo, under your GitHub account. Without
  it, Session Board's report inbox (a Cloudflare Worker, `reports-worker/`), which files it as an issue in a private
  repo only the team reads. The Feedback buttons open GitHub in your browser for you to send.

## What the mod does on your computer

Everything here is in `hooks/register.js` (the mod) and `hooks/session-title.mjs` (the one command hook).

**What it sends, and where**
- **Summaries:** the last few requests and replies of a session (about 15,000 characters at most; for a cloud session, those Claude Desktop last showed), its earlier requests cut to a line each, and its previous list, to Claude through Claude Code's own model call (`$.model.complete`, Sonnet at low effort), billed to your Claude account. Turn them off in Settings.
- **Naming** (only with "Also rename in Claude Code" on): a session's first request, to Claude the same way, for a short name.
- **Bug reports, only when you ask** (you say "report", or click Report or a Feedback button): your description, versions, the window's settings, session counts, error messages and a crash's stack, with your home folder and user name removed and nothing from your chats. With the GitHub CLI signed in, to a public issue on this repo; otherwise to Session Board's report inbox (`session-board-reports.kiran-987.workers.dev`, a Cloudflare Worker that files it as an issue in a private repo).
- **Windows and Linux:** the window app is downloaded from this repo's GitHub release for the plugin's version (`curl`), and checked against the SHA-256 in `app/release.json` before it's installed.
- Nothing else leaves your computer. There's no analytics.

**Programs it runs, and why**
- `sh` with `tail`, `sed` and `awk` (macOS, Linux), or `powershell` (Windows): to read the end of a session's saved conversation, without its image data, for the summary and the step under way.
- `ps` (macOS, Linux), or `powershell` with `Get-CimInstance Win32_Process` (Windows): to find the commands sessions left running, for "Still running".
- `uname`: to tell macOS from Linux, and the processor.
- macOS: `xcode-select -p` to check Apple's command-line tools, `sh board/build.sh` to build the window app (it runs `swiftc`, `codesign` and `iconutil`), and `open -g` to start it.
- Windows and Linux: `curl` to download the window app, `sha256sum` or `Get-FileHash` to check it, `mkdir`, `mv`, `chmod` or `Move-Item`, `taskkill` to stop an old copy before replacing it, then `cmd /c start` or `nohup` to start it. For the install lock: `ln`, `mv` and `rm` on Linux; on Windows, PowerShell's `[IO.File]::Move` and `Remove-Item`.

**What it writes**
- Each session's record in Claude Code's plugin store (its status, its requests cut to a line each, step, task list and summary), deleted when the session ends.
- In the shared folder (`~/Library/Application Support/session-board`, `%APPDATA%\session-board` or `~/.local/share/session-board`): `show-request` (from `/session-board`), `last-error.json` (a failed build, for a report), `built.sha`, and on Linux the downloaded app.
- macOS: the window app in `~/Applications/Session Board.app`. Windows: `%LOCALAPPDATA%\Programs\Session Board`. Windows and Linux: `install.lock` in the app's folder while an install runs, removed after.
- It edits no build, start-up, settings or instructions file of yours.

**What its hooks do.** They watch; none of them blocks, changes or answers anything, and none takes part in a permission decision. Each passes its event on unchanged.
- `session.start`: registers `/session-board`, starts the window app, and starts a check every 30 seconds (catching up sessions that started before the plugin, and noticing commands that ended).
- `prompt.submit`, `turn.start`, `turn.complete`: note the request, that the session is working, and that the turn ended; start a summary.
- `tool.call`: notes the step under way and the session's task list (TodoWrite, TaskCreate, TaskUpdate), and that a question or plan approval is on screen.
- `classic.Notification`: notes that a permission prompt is open, so the board shows the session needs you.
- `classic.SessionStart` (clear, resume, branch) and `session.end`: start a new record, or delete the old one.
- `command.run`: answers `/session-board` by showing the window.
- The command hook (`UserPromptSubmit`, `hooks/session-title.mjs`): with "Also rename in Claude Code" on, sets the session's title with its project in front. It never blocks a prompt.

## How it works

- **The mod** (`hooks/register.js`) keeps a record for each session in the plugin's shared store.
  - The record holds the status, the step under way, the request, the task list and the summary.
  - It's updated from the session's own events: prompts, turns, tool calls and permission prompts.
  - Sessions that started before the plugin loaded get a record built from their saved conversations.
  - `claude -p` runs and SDK jobs are skipped.
- **The window** joins those records with Claude Code's session registry every 2 seconds. On a Mac it's the native app in `board/` (`board/main.swift`, built by `board/build.sh`). On Windows and Linux it's `app/`, a [Tauri](https://tauri.app) app (a small Rust side in `app/src-tauri`, the board as a web page in `app/ui`) that the release workflow builds.
- **A shared folder** connects the two: `~/Library/Application Support/session-board` on a Mac, `%APPDATA%\session-board` on Windows, `~/.local/share/session-board` on Linux. It holds:
  - the settings;
  - the bullets you removed;
  - requests from `/session-board` to show the window;
  - `status.json`, which records what the highlight last saw.
- **Cloud sessions** (on a Mac, with Claude Desktop): they run on Anthropic's machines, and nothing on your computer lists them, no file and no `claude` command. Claude Desktop's sidebar does, so the window reads it with the Accessibility permission the highlight uses. A cloud card shows the session's name, its group and whether it's running. Each time the session is open in Desktop, the window also reads its chat there, the latest exchanges Desktop has on the page, and the summary turns them into the card's task, done, under way and next lines, as for a local session. The card keeps that summary until the next time you open it. `--open-chat` prints the exchanges it reads. A row counts as cloud when its group has Desktop's cloud badge (or it's in the Cloud section) and it's no session this Mac knows. Only rows the sidebar shows are found: none in a collapsed group or behind "Show more". Clicking a card opens the session in Desktop.

## Uninstall

```sh
claude plugin uninstall session-board@session-board
```

Then quit Session Board from its menu bar item (right-click → Quit Session Board). Delete `~/Applications/Session Board.app` and `~/Library/Application Support/session-board`.

## Bugs and ideas

- **In any Claude Code session:** say what's wrong with Session Board. Claude offers to report it, and you say
  **report** to send it.
  - It goes on GitHub as a public issue, with versions, settings and error messages, and nothing from your chats.
  - With the GitHub CLI signed in, it's filed at once. Otherwise GitHub opens in your browser with it filled in.
  - A failed build's notice says to tell Claude "report the Session Board error".
  - The skill is `skills/feedback`.
- **In the window:** Settings → Feedback → Report a problem or Suggest an idea, or right-click the menu bar item →
  Report a Problem…
- **On GitHub:** [open an issue](https://github.com/KiranPothana/session-board/issues/new/choose).

You'll get GitHub's notifications when it's answered or fixed.

## Troubleshooting

- **No window:**
  - Press your shortcut (⌃⌥S unless you changed it), or click the ◉ in the menu bar.
  - With "Hide when you switch away from Claude" on, the popup only shows while Claude Desktop is in front, or a terminal or editor if that setting is on too.
  - A Regular window lives on the Space you put it on, so it doesn't show over a full-screen app. Its Dock icon brings it back.
- **The build failed:** the error shows under the prompt in a terminal session. To see the whole output, run the build yourself from the plugin's folder:
  `sh board/build.sh "$HOME/Applications/Session Board.app"`
- **"no task data yet":** the session hasn't finished a turn since the plugin started watching it.
- **The highlight doesn't follow Claude Desktop:**
  - Check the Accessibility permission. `status.json` in the shared folder shows what the window saw.
  - The highlight reads Claude Desktop's window title ("<session> - Claude Code"), so a Desktop update can break it.
- **A cloud session is missing:** open its group in Claude Desktop's sidebar (cloud cards come from the rows it shows), and keep Desktop's window on the current Space. `"$HOME/Applications/Session Board.app/Contents/MacOS/SessionBoard" --desktop-sidebar` prints the rows the window reads and which count as cloud. Desktop's sidebar isn't a documented interface, so an update can break this.

## Development

```sh
claude --plugin-dir .                 # load your working copy
claude plugin test                    # the mod's tests
claude plugin validate --strict .
cd app && npm ci && npm test          # the window's rules (node) ...
cargo test --manifest-path src-tauri/Cargo.toml   # ... and its Rust side
npx tauri dev                         # run the window from source
SESSION_BOARD_SHARED_DIR=/tmp/sb npx tauri dev   # with its own shared folder: silent, always shown
```

Open `app/ui/index.html` through any local web server to see the board with sample sessions (`?theme=light`, `?viewing=2`, `?empty`).

Don't load a working copy and an installed copy at the same time: both would run every hook.

## Sounds

Session Board can play a sound when a session needs you, when a turn ends with something for you, and (if you turn it on) when a session is done. Each moment can use any of its sounds, or a file of your own:

- **Session Board**: three sounds made for it (`app/ui/sounds`, MIT).
- **macOS**: the system alert sounds every Mac has (Glass, Ping, Hero, Submarine…), played from `/System/Library/Sounds`, not bundled. Mac only.
- **Kenney · CC0**: eleven sounds from [Kenney's Interface Sounds](https://kenney.nl/assets/interface-sounds) (public domain, CC0; thanks, Kenney). Licence in `app/ui/sounds/KENNEY-LICENSE.txt`.
- **Your own**: Settings › Sounds › the sound's menu › Add your own… (any audio file, under 10 seconds and 5 MB). It's copied to the shared folder's `sounds`.

On a Mac, sounds that play on their own play at the alert volume you chose (50% unless you change it), then put your volume back (muted stays muted). On Windows and Linux they play at that share of your volume.

## License

MIT. The bundled Kenney sounds are CC0.

# Session Board

**[sessionboard.dev](https://sessionboard.dev)**

**Every Claude Code chat on your Mac, in one window.**
✓ what it did · ▶ what it's doing · ○ what's next · what's waiting on you.

<details><summary><b>Copy for AI</b>: paste this into Claude and it explains Session Board and installs it for you</summary>

<!-- ai-overview -->

````text
I'd like to try Session Board. Read this, explain it to me in two short lines (I don't like reading much), then offer to install it for me.

# Session Board (https://sessionboard.dev)

Free, open source (MIT) Claude Code plugin for the Mac: https://github.com/KiranPothana/session-board

What it is: one small floating window that lists every Claude Code chat running on this Mac (terminal, Remote Control, Claude Desktop). Each chat gets a card that keeps a live stand-up:
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

Needs: macOS 15+, Claude Code 2.1.287+, Apple's command-line tools (`xcode-select --install`).

Install (run these for me):
```sh
claude plugin marketplace add KiranPothana/session-board
claude plugin install session-board@session-board
```
Then I start a new Claude Code session, or type /session-board in one. The first time, it builds the window app on my Mac (under a minute) and opens it. Chats already running show up too.

Cost: the summaries are small Sonnet calls billed to my Claude account (about 2,000 tokens in, a few per turn). They can be turned off in Settings. Everything else stays on my Mac and talks to no server.

Update: `claude plugin update session-board@session-board`. Uninstall: `claude plugin uninstall session-board@session-board`, then quit it from the menu bar.

Something wrong or an idea? Tell Claude in any session and say "report", or open https://github.com/KiranPothana/session-board/issues
````

<!-- /ai-overview -->

</details>

## In more words

One floating window on your Mac that lists every Claude Code session you have running (in the terminal, over Remote Control, and in Claude Desktop) with what each one is working on, what is still to do, and which ones need you.

It's a Claude Code [mod](https://code.claude.com/docs/en/plugins/mods/overview) plus a small native macOS app that the plugin builds on your Mac the first time you use it.

## What you get

- **A row per session** active in the last 12 hours: needs you, working or idle, and for how long; what it just finished; and a short list of active and pending items.
- **Idle doesn't mean nothing is happening.** If a session finished its turn but left tests, a build or a server running, its row says "Still running: browser tests · 6m". The summary knows too, so it doesn't call work active once the command has ended.
- **Needs you** shows when a permission prompt, a question or a plan approval is on screen. Items that wait on your answer are marked "waits on you".
- **Follows what you're looking at.** The session open in Claude Desktop, Terminal or iTerm2 is highlighted and kept at the top of the list.
- **Order:** needs you, then working, then idle. Within each group, the session that most recently entered that state comes first.
- **A popup when a session wants you.** When a session needs you, ends its turn with something for you, or finishes, a small tile with its number shows beside the board for 8 seconds; the white outline around it runs down until it goes. Its dot is amber when it wants you, grey when it's done; hover for the name and why (hovering also holds it), click to go to the session, or click the dot (×) to close it. It sits left of the board, else right, else above or below, and over the board's top when no side has room. Never for the session you're viewing, and only while the board shows.
- **Click a name to go there.** Clicking a session's name (or its popup) opens it: in Claude Desktop (a Remote Control session by its claude.ai page, one of Desktop's own by its id there), otherwise its tab in Terminal or iTerm2, or the app it runs in.
- **Remove a bullet** with the × that shows on hover, and summaries won't bring it back. Each session lists what you removed, with Restore. You can also dismiss a whole session and restore it from Dismissed.
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

- **macOS 15 or later.**
- **Claude Code 2.1.287 or later**, the first version with mods. It's tested with 2.1.293 on macOS 27, and the mods API can still change between Claude Code releases.
- **Apple's command-line tools**, to build the window app on your Mac. Install them with `xcode-select --install`. It's tested with Swift 6.4.

## Install

```sh
claude plugin marketplace add KiranPothana/session-board
claude plugin install session-board@session-board
```

Then start a new Claude Code session, or type `/session-board` in one.

- The first time, the plugin builds the window app into `~/Applications/Session Board.app` (under a minute) and opens it. It builds again only when an update changes the app's source.
- Sessions that were already running show up too, with no restart. Once one session runs the plugin, it reads the others' saved conversations every 30 seconds.

To update: `claude plugin update session-board@session-board`.

## Permissions

The window asks for these permissions:

- **Accessibility**, to read which session Claude Desktop has open, for the highlight. Without it, everything else still works. It's in System Settings → Privacy & Security → Accessibility.
- **Automation for Terminal or iTerm2**, asked the first time one of them is in front, for the highlight there.

The app is signed ad hoc unless you have an Apple Development certificate. An ad hoc rebuild after an update counts as a new app to macOS. If the highlight stops following Claude Desktop after an update, turn Session Board off and on again in the Accessibility list.

## Cost and privacy

**Summary calls:** the plugin asks Sonnet (low effort) for each session's short active/pending list:
- when you send a message, so the board shows the new work right away;
- when a turn ends;
- during a long turn, at most every 90 seconds, and only when the session has written something new.

Each call is small: about 2,000 tokens in and 100 out.

That's a few small calls per turn, per session, billed to your Claude account like the rest of your Claude Code use.
- Each call sends the last four requests and replies (about 15,000 characters at most) and the previous list.
- The list is rebuilt from those exchanges each time, so finished or abandoned items drop off instead of piling up.
- To stop the calls, turn **Summaries by Sonnet** off in Settings. The board then shows each session's request and its own task list.

**Everything else stays on your Mac.**
- The window reads files Claude Code already writes: the session registry in `~/.claude/sessions` and the plugin's store.
- It talks to no server.

## How it works

- **The mod** (`hooks/register.js`) keeps a record for each session in the plugin's shared store.
  - The record holds the status, the step under way, the request, the task list and the summary.
  - It's updated from the session's own events: prompts, turns, tool calls and permission prompts.
  - Sessions that started before the plugin loaded get a record built from their saved conversations.
  - `claude -p` runs and SDK jobs are skipped.
- **The window** (`board/main.swift`, built by `board/build.sh`) joins those records with Claude Code's session registry every 2 seconds.
- **A shared folder**, `~/Library/Application Support/session-board`, connects the two. It holds:
  - the settings;
  - the bullets you removed;
  - requests from `/session-board` to show the window;
  - `status.json`, which records what the highlight last saw.

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

## Development

```sh
claude --plugin-dir .                 # load your working copy
claude plugin test                    # the mod's tests
claude plugin validate --strict .
sh board/build.sh                     # builds board/Session Board.app
"board/Session Board.app/Contents/MacOS/SessionBoard" --snapshot out.png --settings   # render the window to a PNG
```

Don't load a working copy and an installed copy at the same time: both would run every hook.

## Sounds

Session Board can play a sound when a session needs you, when a turn ends with something for you, and (if you turn it on) when a session is done. Each moment can use any of 28 sounds, or a file of your own:

- **Session Board**: three sounds made for it (`board/sounds`, MIT).
- **macOS**: the system alert sounds every Mac has (Glass, Ping, Hero, Submarine…), played from `/System/Library/Sounds`, not bundled.
- **Kenney · CC0**: eleven sounds from [Kenney's Interface Sounds](https://kenney.nl/assets/interface-sounds) (public domain, CC0; thanks, Kenney). Licence in `board/sounds/KENNEY-LICENSE.txt`.
- **Your own**: Settings › Sounds › the sound's menu › Add your own… (any file macOS can play, under 10 seconds and 5 MB). It's copied to `~/Library/Application Support/session-board/sounds`.

Sounds that play on their own play at 50% of your Mac's volume, then put your volume back (muted stays muted).

## License

MIT. The bundled Kenney sounds are CC0.

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

Needs: Claude Code 2.1.287+, and macOS 12+, Windows 10/11, or a 64-bit Linux desktop.

Install (run these for me):
```sh
claude plugin marketplace add KiranPothana/session-board
claude plugin install session-board@session-board
```
Then I start a new Claude Code session, or type /session-board in one. The first time, it downloads the window app, checks its checksum and opens it. Chats already running show up too.

Cost: the summaries are small Sonnet calls billed to my Claude account (about 2,000 tokens in, a few per turn). They can be turned off in Settings. Everything else stays on my computer. Bug reports are sent only when I say "report" (or click Report), and never include anything from my chats.

Update: `claude plugin update session-board@session-board`. Uninstall: `claude plugin uninstall session-board@session-board`, then quit it from the menu bar.

Something wrong or an idea? Tell Claude in any session and say "report", or open https://github.com/KiranPothana/session-board/issues

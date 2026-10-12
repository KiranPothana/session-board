---
name: feedback
description: Offer to report a Session Board problem or idea to the people who make it, so the user only has to say "report". Use whenever the user complains that something in Session Board is wrong or broken (the floating window, a card or its summary, the popup, the highlight, sounds, the shortcut, the menu bar item, the build), asks to report a Session Board bug or error (its error notices say "report the Session Board error"), or wishes Session Board did something it doesn't.
---

# Report it to the Session Board team

The user said something in Session Board is wrong, or wished it did something. Reporting must cost them one word, and that word is **report**: never "yes", which can be an answer to something
else in the same reply.

**Skip this skill** when the current project is Session Board's own source (its `.claude-plugin/plugin.json` is named
`session-board`): they are the team.

## 1. Help, then ask once

- Answer them first as you normally would. Session Board's README is two folders up from this skill's base directory
  (`<base>/../../README.md`). Where its Troubleshooting has a fix, give it.
- End that same reply with one short question. Don't use a question tool, which would stop their work.
  - Bug:
    > Want me to report this to the Session Board team? I'd send **"Shortcut stops working after the Mac sleeps"**, plus
    > versions and settings, and nothing from your chats. It may be posted publicly on GitHub. Say **report** to send it.
  - Wish: the same, with "send this idea".
- Write the title in under 70 characters, in plain words.
- Ask once for each problem. If they say no, or ignore the question, drop it and don't ask again this session.
- Asking you to report it in their own words ("report this", "send it to them") is a clear go too. A bare yes, ok or
  sure is not: reply "Say **report** to send it." and send nothing.

## 2. Write the report

- The title, then a blank line, then one to three lines: what happened and what they expected. Use their own words where
  you can.
- Make the report generic, because it goes public:
  - Say "a session", "a card", "the popup".
  - Never include project names, repo or folder names, file paths, session names or titles, the work the chats are
    doing, code, people's names, emails, keys or tokens.
- If they only asked to report "the Session Board error" (its error notice tells them to), run the script below with
  `--dry-run` first and write the title from its **Errors** section. Then ask the question as in step 1.

## 3. Send it, when they say report

Run this with your Bash tool, using this skill's base directory:

```sh
node "<this skill's base directory>/report.mjs" --kind bug <<'EOF'
Shortcut stops working after the Mac sleeps

After the Mac wakes, Control-Option-S no longer shows the window until I quit and reopen it.
EOF
```

- Use `--kind idea` for a wish.
- The script adds what the team needs to look into it: versions, the window's settings, error messages and crashes.
  It removes the home folder and the user name.
- With the GitHub CLI signed in, it opens a public issue at once and prints `Reported: <link>`. Otherwise it sends it
  privately to the team's inbox, which needs no account. Only if that fails does it open GitHub in the browser, filled in.

Then tell them in one line:
- "Reported: <link>. You'll get GitHub notifications when it's answered."
- Or, from the inbox: "Sent to the Session Board team (report #12). Thanks."
- Or, from the browser: "It's open in your browser, filled in. Press Create to send it."

If the script fails, give them https://github.com/KiranPothana/session-board/issues/new instead.

// Session Board: keeps, for every Claude Code session on this Mac, a record of what it is
// working on (active) and what is waiting (pending), for the Session Board window
// (~/Applications/Session Board.app, built from board/main.swift), which shows them all in
// one floating panel.
//
// Each session's copy of this mod keeps its own record in the shared $.store, under
// "s:<sessionId>". Sessions that started before the mod loaded get a record too, written
// by the catch-up pass from their saved conversations. The window joins these records with
// the live-session registry Claude Code writes to ~/.claude/sessions/<pid>.json.
//
// The mod and the window also share a folder, ~/Library/Application Support/session-board:
//   settings.json  the window's settings the mod follows ({"summaries": false} turns the summaries off)
//   removed.json   bullets removed in the window, by session id, which summaries leave out
//   show-request   written by /session-board, so the window shows even if it was hidden
//   built.sha      what the installed app was built from (written by board/build.sh)
//   last-error.json  the last failed build, for the feedback skill's reports

const PREFIX = 's:'
// A record whose session left the registry this long ago is deleted
const STALE_MS = 10 * 60 * 1000
// Catch-up for sessions started before the mod loaded: how often one session reads their
// saved conversations
const CATCHUP_MS = 30 * 1000
const CATCHUP_LEASE = 'lease:catchup'
// Raised when the catch-up pass changes, so a session running newer code takes the lease from
// one still running older code (which yields to any lease another session holds)
const LEASE_VERSION = 4
// How much of a saved conversation's end is read: first this much, then four times more
// until the last few requests are in it (screenshots and tool output make a turn megabytes
// long), up to the cap
const TAIL_START_BYTES = 1000000
const TAIL_MAX_BYTES = 32000000
// The tail as the summary needs it: without the base64 data of images, without lines over
// 20 KB (tool output and file contents, never read), and only its last READ_OUT_BYTES. A
// command's output is cut at a limit, and a cut keeps the start: the cap keeps the end instead.
const READ_OUT_BYTES = 600000
const READ_TAIL = `tail -c "$1" "$2" | sed -E 's/"data":"[A-Za-z0-9+\\/=]{200,}"/"data":""/g' | awk 'length($0) <= 20000' | tail -c ${READ_OUT_BYTES}`
// A long turn's tool output can fill that whole read before it reaches back to the turn's
// request, and a summary without the request keeps the card it had. Then the requests (and the
// notices of background work, and messages sent mid-turn) are read on their own from further
// back: the user lines that aren't tool results, and queued messages, the last READ_ASK_LINES.
const READ_ASK_LINES = 300
const READ_ASKS = `tail -c "$1" "$2" | grep -v '"tool_result"' | grep -E '"type":"user"|"queued_command"' | sed -E 's/"data":"[A-Za-z0-9+\\/=]{200,}"/"data":""/g' | awk 'length($0) <= 20000' | tail -n ${READ_ASK_LINES}`

// How often, and for how long after a request, a session without a name looks for the one
// Claude gives it; and the last name line in its saved conversation
const TITLE_POLL_MS = 3000
const TITLE_WATCH_MS = 2 * 60 * 1000
const READ_TITLE = `tail -c 2000000 "$1" | grep '"type":"ai-title"' | tail -n 1`
// Naming a session with its project first: how long the first request waits for a name, and
// what the model is asked
const TITLE_TIMEOUT_MS = 4000
const TITLE_SYSTEM = 'You name a Claude Code conversation from its first request, the way a chat app titles one: 2 to 6 words, sentence case, plain words, no quotes and no full stop. Reply with the name only.'

// A turn that runs long is summarized again this often, so the board keeps up with it
// Through a long turn, a new summary at most this often, and only once the assistant has written
// something new: the board keeps up with the chat without spending calls on nothing
const BUSY_RESUMMARY_MS = 90 * 1000
// A failed summary is tried again this much later, at most this many times in a row
const SUMMARY_RETRY_MS = 15 * 1000
const SUMMARY_RETRIES = 2
// A summary call that hasn't answered after this long is given up on, so one that hangs can't
// hold back every summary after it
const SUMMARY_TIMEOUT_MS = 90 * 1000
// A summary still going after this long (a step besides the model call that never answered) is
// given up on, so the next one can run
const SUMMARY_STUCK_MS = 3 * 60 * 1000
// How long a summary after a turn waits for the turn's last reply to reach the saved conversation
const ANSWER_WAIT_MS = 1000
const ANSWER_TRIES = 3
// What a summary reads: the last few exchanges, the latest reply at most this long, older
// replies and the requests shorter
const EXCHANGES = 4
// The session's requests, kept on its record (each cut to a line): a long session's earlier ones,
// beyond the exchanges a summary reads, tell it what the work is for
const ASKS_KEPT = 12
const ASK_LINE = 200
// The model that writes the summaries, and how hard it thinks
const SUMMARY_MODEL = 'sonnet'
const SUMMARY_EFFORT = 'low'
const LATEST_REPLY_CHARS = 5000
const OLDER_REPLY_CHARS = 1600
const ASK_CHARS = 1500
// Building the window app: one session at a time, for at most this long
const BUILD_LEASE = 'lease:build'
const BUILD_MS = 10 * 60 * 1000
const APP_NAME = 'Session Board.app'

const SUMMARY_SYSTEM = [
  'You keep a short to-do board for one Claude Code session. Someone at the company who has never seen the chat reads it to learn, at a glance, what task the session is on, what it is doing and what is still to do.',
  "You get the session's earlier requests (cut short, oldest first), its last few exchanges, oldest first (each the user's request and the assistant's final reply; for the latest, first its notes along the way, oldest first: what it said as it worked), then the board as it was before.",
  'Rebuild the board. Reply with JSON only: {"task": "...", "done": "...", "side": "...", "paused": "...", "active": [...], "pending": [...]}.',
  'task: the task the session is on, in one line that person would understand without the chat: what is being built, fixed, shipped or decided, and what for, not the step under way ("Ship v1.20.195, the credit line coin fix: sandbox, then live"; "Show cloud sessions on the Mac board"). Name the product or feature, not the files. Keep the task from the board before, reworded only to make it clearer, while the session is still on it; a new one only when the user has moved the session to different work. Under 80 characters.',
  'side: when the user raised something in the middle of other work that still has open steps (a bug they spotted, a quick question, a detour), the work the session is doing for it right now; paused: the planned work it set aside for it. Both "" otherwise, and both "" again once the side task is finished and the planned work goes on. A request can be finished partway through a turn: when the notes show the assistant answered or finished the latest request and went back to earlier work, that request is done, side and paused are "", and the work it went back to is active. The board shows them on their own lines: while there is a side task, active does not name it again and pending does not repeat the paused work.',
  'done: the last piece of work the session finished, as one short line in plain words: what was achieved, not the commands run. "" when the exchanges show nothing finished yet.',
  'active: the work the session is doing now for the latest request, 0 to 2 items. When the latest request has no reply yet, or the assistant is still working on it, name that work, reading it in the light of the earlier exchanges (a "go ahead" continues what was planned). Work the assistant is still doing never waits on the user. When the latest reply is the assistant\'s final reply (its turn has ended), active is empty, even while a command or agent it left running goes on: the board shows those on their own line. What it will do once they finish (release after the tests pass) is pending, not active.',
  'pending: what is still to do for the task, 0 to 5 items, the ones that wait on the user first: the steps still ahead at the level someone would plan the work (review, sandbox, go live, the next feature), not the next command or check. One item per piece of work: never split one piece of work into its steps.',
  'Mark a pending item "· waits on you" only when the session is stopped on the user for it right now: a reply asked them a question, asked for their approval or go, or asked them to do something themselves now, such as try, test, check, review, choose, run or tell it something ("please try it", "check it on your phone", "tell me which you prefer", "run this yourself"), and they have not answered it or done it since. A later message of theirs about something else (a side question, a detour) does not answer it: it still waits on them. Word that item as the user\'s step ("Test the new login · waits on you"). A step that needs the user later, after work the session is still doing or will do first (an iPhone check after the deploy it is running, a go for live after the sandbox), does not wait on them yet. While the session is still working, or a command it left running is still going, nothing waits on the user unless a reply asked them something they haven\'t answered. Never mark an active item.',
  'You also get the commands this session left running (tests, builds, servers, agents). Never list one that is still running as an item, since the board shows it; list what comes after it as pending. When none is left, work a reply said was running in the background has finished.',
  'Drop an item the exchanges show as done, replaced, handled elsewhere or no longer wanted.',
  'The board before holds what earlier exchanges planned, which the few you see may not repeat: keep its pending items that are still part of the task unless the exchanges show them done, replaced or no longer wanted, or the replies since never mention them while saying the work is finished or shipped. When the task is new, start pending afresh: drop every item of the task before except those marked "· waits on you". Its active items are no evidence: they are rebuilt from the exchanges. When an item is the same work as one on it, reuse that wording, so the board does not churn. An item on it marked "· waits on you" was asked of the user in a reply that may be older than the exchanges you see; keep it, still marked, unless the exchanges show the user answered it, did it, or the session dropped it.',
  'List only what this session itself is doing or still has to do. Leave out remarks about other sessions.',
  'Never list an item the user removed from the board, even reworded.',
  'Each item is under 70 characters, in plain words, with no markdown and no ids.',
].join('\n')

// This session's record, as it is stored
let me = null
// The request just sent, while the assistant hasn't replied to it: the summary names the
// work it starts
let awaitingReply = ''
let summarizing = false
// When the summary under way started, and a count of runs, so a stuck one can be given up on
let summarizingSince = 0
let summaryRun = 0
// A summary was asked for while one ran: run again once it's done, with what's new
let summarizeAgain = false
// The reply the last turn ended with, until the next one starts
let turnAnswer = ''
// The session changed its task list during this turn: while it works, that list is the board
let tasksMoved = false
// Summaries that failed in a row, so a failure is retried only SUMMARY_RETRIES times
let summaryFailures = 0
// The reply checkOwnJobs last summarized because the board had missed it, so it tries once per reply
let healedReply = ''
// When the last summary started, so a long turn asks again only every BUSY_RESUMMARY_MS
let lastTry = 0
// The status the last publish wrote, so statusSince moves only when the status really changes
let publishedStatus = null
// watchTitle is looking for the conversation's name
let watchingTitle = false
// The live-session registry as last read, by session id
let liveReg = new Map()
// Each catch-up session's transcript size and mtime at the last read, so an unchanged file isn't read again
const seenTranscripts = new Map()
// This process's build of the window app, while it runs
let building = null
// The tool call under way (a permission prompt is for it)
let callInProgress = null

// A card line as kept: whole, up to this long (the window cuts it to fit and shows the rest on hover)
const LINE_CHARS = 240
const oneLine = (s, n) => {
  const line = String(s ?? '').split('\n').map((x) => x.trim()).find(Boolean) ?? ''
  return line.length > n ? line.slice(0, n - 1) + '…' : line
}

const baseName = (p) => String(p ?? '').split('/').filter(Boolean).pop() ?? '?'

// Which OS this is: Windows says so in OS; uname tells macOS from Linux. Asked once.
let osName = null
async function osOf($) {
  if (osName) return osName
  if ((await $.env.get('OS')) === 'Windows_NT') return (osName = 'windows')
  const r = await $.process.run(['uname', '-s'], { timeoutMs: 5000 }).catch(() => null)
  return (osName = String(r?.stdout ?? '').trim() === 'Linux' ? 'linux' : 'macos')
}

const homeOf = async ($) => (await $.env.get('HOME')) || (await $.env.get('USERPROFILE')) || ''

// The folder the mod and the window share, per OS (the window's shared_dir in app/src-tauri)
async function dataDir($) {
  const os = await osOf($)
  if (os === 'windows') return ((await $.env.get('APPDATA')) || (await homeOf($)) + '/AppData/Roaming') + '/session-board'
  if (os === 'linux') return ((await $.env.get('XDG_DATA_HOME')) || (await homeOf($)) + '/.local/share') + '/session-board'
  return (await homeOf($)) + '/Library/Application Support/session-board'
}

// PowerShell on Windows, which has no sh: a script run with its arguments as literals
const psQuote = (x) => "'" + String(x).replace(/'/g, "''") + "'"
const powershell = ($, script, timeoutMs) =>
  $.process.run(['powershell', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], { timeoutMs })

// A file's last `bytes` as text, read like READ_TAIL (the cap and the image data and long lines
// left out), on any OS
async function tailOf($, path, bytes, asksOnly = false) {
  if ((await osOf($)) !== 'windows') {
    const r = await $.process.run(['sh', '-c', asksOnly ? READ_ASKS : READ_TAIL, 'sh', String(bytes), path], { timeoutMs: 20000 })
    return r.exitCode === 0 ? r.stdout ?? '' : ''
  }
  const script = [
    `$f = [IO.File]::Open(${psQuote(path)}, 'Open', 'Read', 'ReadWrite,Delete')`,
    `try { $start = [Math]::Max(0, $f.Length - ${Number(bytes)}); [void]$f.Seek($start, 'Begin'); $buf = New-Object byte[] ($f.Length - $start); $n = 0`,
    `while ($n -lt $buf.Length) { $r = $f.Read($buf, $n, $buf.Length - $n); if ($r -le 0) { break }; $n += $r } } finally { $f.Close() }`,
    `$t = [Text.Encoding]::UTF8.GetString($buf, 0, $n) -replace '"data":"[A-Za-z0-9+/=]{200,}"', '"data":""'`,
    asksOnly
      ? `$t = ($t -split "\n" | Where-Object { $_.Length -le 20000 -and $_ -notmatch '"tool_result"' -and $_ -match '"type":"user"|"queued_command"' } | Select-Object -Last ${READ_ASK_LINES}) -join "\n"`
      : `$t = ($t -split "\n" | Where-Object { $_.Length -le 20000 }) -join "\n"`,
    `if ($t.Length -gt ${READ_OUT_BYTES}) { $t = $t.Substring($t.Length - ${READ_OUT_BYTES}) }`,
    `[Console]::OutputEncoding = [Text.Encoding]::UTF8; [Console]::Out.Write($t)`,
  ].join('\n')
  const r = await powershell($, script, 20000)
  return r.exitCode === 0 ? r.stdout ?? '' : ''
}

// One line naming what a tool call is doing, such as "Bash: Run the tests"
function stepOf(e) {
  const arg = [e.description, e.subject, e.command, e.file_path, e.pattern, e.url, e.query, e.prompt]
    .find((v) => typeof v === 'string' && v.trim())
  const shown = arg && arg === e.file_path ? baseName(arg) : arg
  return oneLine(e.tool + (shown ? ': ' + shown : ''), 90)
}

// Keep the record's task list in step with the session's own task tools
function trackTasks(e, r) {
  const before = me.tasks
  trackTaskTool(e, r)
  if (me.tasks !== before) tasksMoved = true
}
function trackTaskTool(e, r) {
  if (e.tool === 'TodoWrite' && Array.isArray(e.todos)) {
    me.tasks = e.todos.map((t, i) => ({ id: String(i + 1), subject: oneLine(t.content, LINE_CHARS), status: t.status }))
  } else if (e.tool === 'TaskCreate' && !r?.deny) {
    const id = r?.result?.task?.id ?? /#(\w+)/.exec(r?.text ?? '')?.[1] ?? String(me.tasks.length + 1)
    me.tasks = [...me.tasks, { id: String(id), subject: oneLine(e.subject, LINE_CHARS), status: 'pending' }].slice(-30)
  } else if (e.tool === 'TaskUpdate' && !r?.deny) {
    me.tasks = me.tasks.flatMap((t) => {
      if (t.id !== String(e.taskId)) return [t]
      if (e.status === 'deleted') return []
      return [{ ...t, subject: e.subject ? oneLine(e.subject, LINE_CHARS) : t.subject, status: e.status ?? t.status }]
    })
  }
}

const WAITS = ' · waits on you'
const answered = (item) => (item.endsWith(WAITS) ? item.slice(0, -WAITS.length) : item)

// What a session waiting on the user is asking, in one line
function askFor(tool, input) {
  if (tool === 'AskUserQuestion') return oneLine(input?.questions?.[0]?.question ?? 'A question for you', 120)
  if (tool === 'ExitPlanMode') return 'Approve the plan'
  return oneLine('Allow ' + stepOf({ tool, ...(input ?? {}) }), 120)
}

const openTasks = (rec) => (rec?.tasks ?? []).filter((t) => t.status === 'pending' || t.status === 'in_progress')

async function publish($) {
  if (!me) return
  const now = await $.clock.now()
  me.updatedAt = now
  // When it entered its status: the window orders each status group by it, and shows the
  // time since. A tool call is no change, so rows don't reshuffle while a session works.
  if (me.status !== publishedStatus || !me.statusSince) {
    me.statusSince = now
    // A change after the first publish is activity; the first one is only the process starting
    if (publishedStatus !== null) me.lastMessageAt = now
    publishedStatus = me.status
  }
  await $.store.set(PREFIX + me.id, me)
}

// Fire and forget: a failed write must never hold up a tool call or a turn
const publishSoon = ($) => void publish($).catch(() => {})

async function init($) {
  const id = await $.session.id()
  const saved = await $.store.get(PREFIX + id)
  me = {
    tasks: [],
    summary: null,
    request: '',
    ...(saved && typeof saved === 'object' ? saved : {}),
    id,
    cwd: await $.session.cwd(),
    status: 'idle',
    step: '',
  }
  // A record the catch-up pass wrote for this session before the mod loaded is now its own
  delete me.shadow
  // A reload keeps the saved statusSince unless the status differs from the saved one
  publishedStatus = saved?.shadow ? null : saved?.status ?? null
  lastTry = await $.clock.now()
  await publish($)
}

// The window's settings, as it last wrote them
async function settings($) {
  try {
    return JSON.parse(await $.fs.read((await dataDir($)) + '/settings.json')) ?? {}
  } catch {
    return {}
  }
}

// Summaries, unless they were switched off in the window's settings
async function summariesOn($) {
  return (await settings($)).summaries !== false
}

// The project a folder belongs to: the Git repo it is in (a worktree counts as its main repo,
// Claude Desktop's .claude/worktrees ones too), or else the folder itself. The window works it
// out the same way.
async function projectOf($, cwd) {
  if (!cwd) return ''
  let root = cwd
  const worktree = cwd.indexOf('/.claude/worktrees/')
  if (worktree >= 0) root = cwd.slice(0, worktree)
  const home = await homeOf($)
  for (let dir = root; home && dir.startsWith(home + '/'); dir = dir.slice(0, dir.lastIndexOf('/'))) {
    let git
    try {
      git = await $.fs.stat(dir + '/.git')
    } catch {
      continue
    }
    root = dir
    // A worktree's .git is a file: "gitdir: <main repo>/.git/worktrees/<name>"
    if (git.kind === 'file') {
      try {
        const main = /^gitdir:\s*(.+?)\/\.git\/worktrees\//m.exec(await $.fs.read(dir + '/.git'))
        if (main) root = main[1]
      } catch {
        // Unreadable: the folder holding it is the project
      }
    }
    break
  }
  return root.split('/').filter(Boolean).pop() ?? ''
}

// A name for a new conversation from its first request, the way Claude names one; '' when the
// model doesn't answer within TITLE_TIMEOUT_MS, since the request waits for it
async function titleFor($, request) {
  const answer = await Promise.race([
    $.model.complete({ model: SUMMARY_MODEL, effort: SUMMARY_EFFORT, maxTokens: 40, system: TITLE_SYSTEM, prompt: request.slice(0, ASK_CHARS) }),
    $.clock.sleep(TITLE_TIMEOUT_MS).then(() => null),
  ])
  const reply = typeof answer === 'string' ? answer : answer?.isAnswered === false ? '' : String(answer?.text ?? '')
  return oneLine(reply.replace(/^["'“‘\s]+|["'”’.\s]+$/g, ''), 60)
}

// Project first, renaming the session too (Settings → Names, off by default): name this session
// with its project first ("web-app · Fix the login"), once, so Claude Code and Claude Desktop show
// it. The project goes in front of the name Claude gave it, or a name is made from this first
// request. Only a settings-style hook can set a session's title, and Claude Code doesn't hand
// those to mods (classic.UserPromptSubmit never reached one in 2.1.296), so the name is left in
// title-<session>.json and the plugin's command hook (session-title.mjs), which runs right
// after, hands it to Claude Code.
async function nameWithProject($, request) {
  const set = await settings($)
  if (set.projectNames === false || set.renameSessions !== true) return
  // The folder the session was opened in, not one it moved into since
  const opened = liveReg.get(me.id)?.cwd ?? me.cwd
  const project = await projectOf($, opened)
  if (!project) return
  const plain = (x) => x.toLowerCase().replace(/[^a-z0-9]/g, '')
  let title = String(me.title ?? '').trim()
  if (title && plain(title).startsWith(plain(project))) {
    me.projectTitled = true
    return
  }
  if (!title) title = await titleFor($, request)
  if (!title || !me) return
  me.projectTitled = true
  me.title = project + ' · ' + title
  await $.fs.write((await dataDir($)) + '/title-' + me.id + '.json', JSON.stringify({ title: me.title }))
  publishSoon($)
}

// Bullets you removed in the window, by session id. The window writes this file; the
// summary leaves them out, so the model doesn't bring them back.
async function removedFor($, id) {
  try {
    const all = JSON.parse(await $.fs.read((await dataDir($)) + '/removed.json'))
    return Array.isArray(all?.[id]) ? all[id].filter((x) => typeof x === 'string') : []
  } catch {
    return []
  }
}

// The assistant's final reply in one exchange: its text after its last tool call. While it
// is still working, its latest text so far. Notes (the thinking text it shows as it works) count
// only when it wrote nothing else.
function finalReply(all) {
  const parts = all.filter((p) => !p.note)
  if (!parts.some((p) => p.text?.trim())) return all.filter((p) => p.text?.trim()).pop()?.text ?? ''
  let lastTool = -1
  parts.forEach((p, i) => {
    if (p.tool) lastTool = i
  })
  const after = parts.slice(lastTool + 1).map((p) => p.text).filter((t) => t?.trim())
  if (after.length > 0) return after.join('\n')
  const texts = parts.map((p) => p.text).filter((t) => t?.trim())
  return texts[texts.length - 1] ?? ''
}

// An exchange's notes along the way: the assistant's text before tool calls and the thinking text
// it shows as it works, each cut short, the last NOTES of them (its final reply is read on its
// own). A side question is often answered, and the planned work picked up again, in such a note:
// the final text alone misses both, and the board keeps showing a side task that's done.
// The cut that follows (clip) keeps the start and the end: why it switched to a side task is
// usually said first, and where it stands now last
const NOTES = 40
const NOTE_CHARS = 300
const LATEST_NOTES_CHARS = 3000
const OLDER_NOTES_CHARS = 800
function notesOf(parts) {
  const reply = finalReply(parts)
  const short = (t) => {
    const one = t.replace(/\s+/g, ' ').trim()
    return one.length > NOTE_CHARS ? one.slice(0, NOTE_CHARS - 1) + '…' : one
  }
  return parts.map((p) => p.text).filter((t) => t?.trim() && !reply.includes(t)).slice(-NOTES).map(short)
}

// The exchanges a summary reads. Those of the turn still going on get their notes along the way:
// the latest, and each one before it that a message sent mid-turn cut short (the turn went on
// into the next exchange, so its "final" text isn't where it ended up). Older ones are read by
// their final replies.
function asExchanges(list) {
  const recent = list.slice(-EXCHANGES)
  let first = recent.length - 1
  while (first > 0 && recent[first].midTurn) first--
  return recent.map((x, i) => ({ ask: x.ask, reply: finalReply(x.parts), notes: i >= first ? notesOf(x.parts) : [] }))
}

// A request the user typed, without the reminders and context Claude Code and Claude Desktop
// add around it; '' for a command's output, a task notification, an interruption marker or
// another message the user didn't type
function typedText(text) {
  let clean = String(text ?? '').replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim()
  if (/^(<(command-|local-command|task-notification)|\[Request interrupted)/.test(clean)) return ''
  // Context an app puts in front of the request, such as Claude Desktop's
  // <artifact-view-context>, an editor's <ide_opened_file>, or a lone marker such as
  // <artifact-content-authored-by-others/>
  const wrapper = /^(<([a-z][\w-]*)\b[^>]*>[\s\S]*?<\/\2>|<[a-z][\w-]*\b[^>]*\/>)\s*/
  while (wrapper.test(clean)) clean = clean.replace(wrapper, '')
  // The summary Claude Code writes when it compacts a conversation is not something typed
  if (/^(?:[^\n]*\n){0,3}This session is being continued from a previous conversation/.test(clean)) return ''
  return clean.trim()
}

// The session's own messages as exchanges: each request the user typed, and the replies to it
function exchangesFromMessages(msgs) {
  const out = []
  for (const m of msgs) {
    const ask = m.role === 'user' && !m.toolResults?.length ? typedText(m.text) : ''
    if (ask) out.push({ ask, parts: [] })
    else if (m.role === 'assistant' && out.length > 0) out[out.length - 1].parts.push({ text: m.text, tool: m.toolUses?.length > 0 })
  }
  return asExchanges(out)
}

// A reply cut to n characters, keeping its start and its end: replies tend to open with what
// was done and close with what's next
function clip(text, n) {
  if (text.length <= n) return text
  const head = Math.floor(n * 0.4)
  return text.slice(0, head) + '\n[…]\n' + text.slice(-(n - head))
}

// The requests before the exchanges a summary reads (those it reads in full are left out)
function earlierAsks(asks = [], exchanges = [], pendingAsk = '') {
  const read = new Set([...exchanges.map((x) => oneLine(x.ask, ASK_LINE)), pendingAsk ? oneLine(pendingAsk, ASK_LINE) : ''])
  return asks.filter((a) => !read.has(a)).slice(-8)
}

// What the summary model reads: the board before, the bullets the user removed, and the exchanges.
// working: the assistant is still on the latest request, so its reply is only its text so far.
// jobs: the commands it left running, as labels, or null when that isn't known.
function summaryPrompt(before, removed, exchanges, pendingAsk, working = false, jobs = null, earlier = []) {
  const earlierNote = earlier.length > 0 ? `--- Earlier requests in this session, oldest first (cut short)\n${earlier.map((a) => '- ' + a).join('\n')}\n\n` : ''
  const removedNote = removed.length > 0 ? `\n\nItems the user removed from the board (never list these): ${JSON.stringify(removed)}` : ''
  const turns = exchanges.map((x, i) => {
    const latest = i === exchanges.length - 1 && !pendingAsk
    const reply = clip(x.reply, latest ? LATEST_REPLY_CHARS : OLDER_REPLY_CHARS)
    const label = latest && working ? "Assistant, still working on it (its latest text so far)" : "Assistant's final reply"
    // What it said along the way, on its own allowance, so the final reply is cut no shorter
    const notes = x.notes?.length ? `Assistant's notes along the way, oldest first:\n${clip(x.notes.map((n) => '- ' + n).join('\n'), latest ? LATEST_NOTES_CHARS : OLDER_NOTES_CHARS)}\n\n` : ''
    return `User:\n${x.ask.slice(0, ASK_CHARS)}\n\n${notes}${label}:\n${reply || '(no reply yet)'}`
  })
  if (pendingAsk) turns.push(`User (latest request, no reply yet):\n${pendingAsk.slice(0, ASK_CHARS)}`)
  const conversation = turns.map((t, i) => `--- Exchange ${i + 1} of ${turns.length}\n${t}`).join('\n\n')
  const running = jobs === null ? ''
    : `\n\n--- Commands this session left running: ${jobs.length > 0 ? jobs.join(', ') : 'none'}`
  return `${earlierNote}${conversation}${running}\n\n--- The board before (its task and pending items carry over while still open; its active items are no evidence)\n${before}${removedNote}`
}

// What a command does, in plain words, from its command line (the window labels them the same way)
function jobLabel(command) {
  const c = command.toLowerCase()
  const has = (words) => words.some((w) => c.includes(w))
  if (c.includes('playwright test')) return 'browser tests'
  if (has(['vitest', 'jest ', 'npm test', 'npm run test', 'bun test', 'pytest', 'go test', 'cargo test', 'swift test', 'plugin test'])) return 'tests'
  if (has(['vite preview', 'vite dev', 'npm run dev', 'next dev', 'http.server', 'npm start'])) return 'a local server'
  if (has(['build.sh', 'npm run build', 'vite build', 'swiftc ', 'xcodebuild', 'cargo build', 'go build', 'docker build'])) return 'a build'
  if (has(['deploy', 'rsync ', 'scp ', 'ssh '])) return 'work on a server'
  return 'a command'
}

// The command a session ran, read from its shell's command line: Claude Code runs it as
// `… && eval '<command>' < /dev/null && pwd -P …`. Its key (spaces collapsed, the first 200
// characters) is how a running shell is matched to the description Claude gave the command,
// here and in the windows, which read it the same way.
function commandOf(line) {
  const start = line.indexOf("eval '")
  if (start < 0) return ''
  const end = line.lastIndexOf("' < /dev/null")
  const raw = end > start ? line.slice(start + 6, end) : line.slice(start + 6)
  return raw.split(`'"'"'`).join("'")
}
const commandKey = (command) => String(command).replace(/\s+/g, ' ').trim().slice(0, 200)

// A command's description as the board says it: "Run the browser tests" → "run the browser tests"
const asPhrase = (text) => (/^[A-Z][a-z]/.test(text) ? text[0].toLowerCase() + text.slice(1) : text)

// Labels for a session's running commands: the description Claude gave each when it ran it
// (from the session's conversation, `commands`, by key), else what the command line suggests
function describeJobs(jobs, commands = {}) {
  return jobs.map((j) => ({ ...j, label: commands[j.key] ? asPhrase(commands[j.key]) : j.label }))
}

// The running commands Claude described, by key: what the record keeps for the windows
const describedOnly = (jobs, commands = {}) => Object.fromEntries(jobs.filter((j) => commands[j.key]).map((j) => [j.key, asPhrase(commands[j.key])]))

// The commands each session still has running, by session id: { label, key } each. Claude Code
// runs a command in a shell started from the session's shell snapshot, named by when it was made
// (the session's first command): the session is the live one that started last before that.
const JOBS_CMD = "ps -axo command= | grep '/.claude/shell-snapshots/snapshot-' | grep -v grep"
async function runningJobs($, registry) {
  const jobs = new Map()
  const r = (await osOf($)) === 'windows'
    ? await powershell($, "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*shell-snapshots*snapshot-*' } | ForEach-Object { $_.CommandLine }", 15000).catch(() => null)
    : await $.process.run(['sh', '-c', JOBS_CMD], { timeoutMs: 10000 }).catch(() => null)
  const starts = [...registry.values()].filter((x) => x.startedAt).map((x) => ({ id: x.sessionId, startedAt: x.startedAt }))
  for (const line of String(r?.stdout ?? '').split('\n')) {
    const made = /[\\/]\.claude[\\/]shell-snapshots[\\/]snapshot-[a-z]+-(\d{13})-/.exec(line)
    if (!made) continue
    const owner = starts.filter((x) => x.startedAt <= Number(made[1])).sort((a, b) => b.startedAt - a.startedAt)[0]
    if (!owner) continue
    const key = commandKey(commandOf(line))
    const list = jobs.get(owner.id) ?? []
    // One command can show as more than one process (a subshell): count it once
    if (key && list.some((j) => j.key === key)) continue
    jobs.set(owner.id, [...list, { label: jobLabel(line), key }])
  }
  return jobs
}

// One summary call: the active and pending items, rebuilt from the last few exchanges. pendingAsk
// is a request sent since, which has no reply yet.
async function summarizeExchanges($, id, exchanges, pendingAsk, previous, working = false, jobs = null, earlier = []) {
  const removed = await removedFor($, id)
  const isRemoved = (item) => removed.includes(answered(item))
  const before = previous
    ? JSON.stringify({ task: previous.task ?? '', active: previous.active.filter((x) => !isRemoved(x)), pending: previous.pending.filter((x) => !isRemoved(x)) })
    : 'none'
  const call = $.model.complete({
    // Sonnet 5.5 at low effort: replayed on real moments, it read a long,
    // many-topic chat correctly where Haiku blended two unrelated things into one, answered
    // faster, and used about a tenth of the output tokens Haiku spent thinking
    model: SUMMARY_MODEL,
    effort: SUMMARY_EFFORT,
    maxTokens: 1000,
    system: SUMMARY_SYSTEM,
    prompt: summaryPrompt(before, removed, exchanges, pendingAsk, working, jobs, earlier),
  })
  const answer = await Promise.race([call, $.clock.sleep(SUMMARY_TIMEOUT_MS).then(() => null)])
  if (answer === null) throw new Error('the summary call timed out')
  // Older builds resolve the reply's text, newer ones { isAnswered, text, usage }
  const reply = typeof answer === 'string' ? answer : answer?.isAnswered === false ? '' : String(answer?.text ?? '')
  const json = JSON.parse(reply.slice(reply.indexOf('{'), reply.lastIndexOf('}') + 1))
  // "waits on you" goes at the end, however the model placed it
  const waitsLast = (x) => {
    const marker = /\s*[·•-]?\s*\(?waits on you\)?\s*[:–-]?\s*/i
    return marker.test(x) ? x.replace(marker, ' ').trim() + WAITS : x
  }
  const clean = (list, n) =>
    (Array.isArray(list) ? list : []).filter((x) => typeof x === 'string' && x.trim()).slice(0, n).map((x) => waitsLast(oneLine(x, LINE_CHARS)))
  const keep = (list) => list.filter((x) => !isRemoved(x))
  // Something waiting on the user isn't work under way: it goes with the pending items
  const active = keep(clean(json.active, 2))
  const side = typeof json.side === 'string' ? oneLine(json.side, LINE_CHARS) : ''
  const paused = side && typeof json.paused === 'string' ? oneLine(json.paused, LINE_CHARS) : ''
  // A side task is the work under way, and the board shows it and the work it paused on their
  // own lines: the lists don't repeat them
  const same = (a, b) => a.replace(WAITS, '').replace(/[^a-z0-9]+/gi, ' ').trim().toLowerCase() === b.replace(/[^a-z0-9]+/gi, ' ').trim().toLowerCase()
  const pending = keep(clean(json.pending, 5)).filter((x) => !paused || !same(x, paused))
  return {
    // Kept from before when the model leaves it out
    task: typeof json.task === 'string' && json.task.trim() ? oneLine(json.task, LINE_CHARS) : previous?.task ?? '',
    done: typeof json.done === 'string' ? oneLine(json.done, LINE_CHARS) : '',
    side,
    paused,
    active: side ? [] : active.filter((x) => !x.endsWith(WAITS)),
    pending: [...active.filter((x) => x.endsWith(WAITS)), ...pending].slice(0, 5),
    at: await $.clock.now(),
  }
}

// Ask a small model for the session's active and pending items: when a request is sent, when
// a turn ends, and every BUSY_RESUMMARY_MS through a long turn. Skipped while the session works
// through its own task list, which is exact about the work. Not once the turn has ended, nor
// for a list it left alone this turn: the list never says what waits on the user (the questions
// the last reply asked), and one left open from an older plan would hold the card forever.
async function summarize($, { onlyIfNew = false } = {}) {
  if (!me || (openTasks(me).length > 0 && me.status !== 'idle' && tasksMoved)) return
  let started
  try {
    started = await $.clock.now()
  } catch {
    // The session is going away
    return
  }
  // One at a time; but one stuck this long (a step that never answered) is given up on, so it
  // can't hold back every summary after it, the turn-end catch-up included
  if (summarizing && started - summarizingSince < SUMMARY_STUCK_MS) {
    summarizeAgain = true
    return
  }
  const run = ++summaryRun
  summarizing = true
  summarizingSince = started
  // Where the last summary got to, kept on the record, for when a board falls behind
  me.summaryTry = { at: started, stage: 'reading' }
  try {
    lastTry = started
    if (!(await summariesOn($))) return
    // The saved conversation records everything, messages sent mid-turn included; the
    // session's messages are the fallback
    let own = await ownTranscript($)
    // After a turn, the saved conversation can lag behind the reply the turn ended with: wait a
    // little for it, then use that reply, or the summary reads the turn as still under way
    const answer = me.status === 'idle' ? turnAnswer.trim() : ''
    const hasAnswer = (list) => list.length > 0 && list[list.length - 1].reply.includes(answer.slice(0, 200))
    for (let i = 0; answer && own.exchanges.length > 0 && !hasAnswer(own.exchanges) && i < ANSWER_TRIES; i++) {
      await $.clock.sleep(ANSWER_WAIT_MS)
      own = await ownTranscript($)
    }
    let exchanges = own.exchanges
    if (answer && exchanges.length > 0 && !hasAnswer(exchanges)) exchanges = [...exchanges.slice(0, -1), { ...exchanges[exchanges.length - 1], reply: answer }]
    me.agentsRunning = own.agents ?? 0
    me.workflowsRunning = own.workflows ?? 0
    me.commandsRunning = liveCommands(own.background, liveReg.get(me.id))
    if (own.title) me.title = own.title
    if (exchanges.length === 0) exchanges = exchangesFromMessages(await $.session.messages())
    const pendingAsk = awaitingReply
    // The request just sent may already be in the messages, with no reply yet
    if (pendingAsk && exchanges.length > 0 && exchanges[exchanges.length - 1].ask.trim() === pendingAsk.trim()) exchanges = exchanges.slice(0, -1)
    if (exchanges.length === 0 && !pendingAsk) return
    // Mid-turn: nothing new written since the last summary, nothing to redo
    const latestReply = exchanges[exchanges.length - 1]?.reply ?? ''
    if (onlyIfNew && !pendingAsk && me.summaryReply !== undefined && latestReply === me.summaryReply) return
    await syncRegistry($).catch(() => {})
    const running = describeJobs((await runningJobs($, liveReg)).get(me.id) ?? [], own.commands)
    me.runningLabels = describedOnly(running, own.commands)
    const jobs = [...running.map((j) => j.label), ...backgroundLabels(me.agentsRunning, me.workflowsRunning, me.commandsRunning, running.length)]
    me.jobsKey = [...jobs].sort().join(',')
    me.summaryTry = { at: started, stage: 'asking the model' }
    const shown = exchanges.slice(-EXCHANGES)
    me.summary = await summarizeExchanges($, me.id, shown, pendingAsk, me.summary, me.status !== 'idle', jobs, earlierAsks(me.asks, shown, pendingAsk))
    me.summaryTry = { at: started, stage: 'done' }
    me.summaryReply = latestReply
    delete me.summaryError
    summaryFailures = 0
    await publish($)
  } catch (err) {
    // A failed summary leaves the previous one in place; why it failed, for troubleshooting.
    // Tried once more a little later: after the turn's last summary, nothing else would, and the
    // board would keep showing the work as under way.
    if (me) {
      me.summaryTry = { ...(me.summaryTry ?? {}), stage: 'failed' }
      me.summaryError = oneLine(err?.message ?? err, 200)
      publishSoon($)
    }
    if (++summaryFailures <= SUMMARY_RETRIES) void $.clock.sleep(SUMMARY_RETRY_MS).then(() => summarize($)).catch(() => {})
  } finally {
    // A run given up on that ends late leaves the newer one alone
    if (run === summaryRun) {
      summarizing = false
      if (summarizeAgain) {
        summarizeAgain = false
        void summarize($)
      }
    }
  }
}

// Background commands its conversation says still run, unless Claude Code says the session is
// idle: it says "shell" while a command the session left running goes on, so a run that died
// without reporting back (killed, or lost with its process) stops counting
function liveCommands(count, reg) {
  return reg?.status === 'idle' ? 0 : count ?? 0
}

// Background agents and workflows, as the summary is told: one label each, without the count,
// so twenty agents finishing one by one don't redo the summary twenty times. Commands the
// conversation says still run, beyond those found among the running processes, count as one more.
function backgroundLabels(agents = 0, workflows = 0, commands = 0, found = 0) {
  return [
    ...(commands > found ? ['a background command'] : []),
    ...(workflows === 1 ? ['a workflow'] : workflows > 1 ? ['workflows'] : []),
    ...(agents === 1 ? ['a background agent'] : agents > 1 ? ['background agents'] : []),
  ]
}

// Where this session's own conversation is saved
async function ownTranscriptPath($) {
  const home = await homeOf($)
  let reg = liveReg.get(me.id)
  if (!reg) {
    for (const f of await $.fs.list(home + '/.claude/sessions')) {
      if (!f.name.endsWith('.json')) continue
      try {
        const r = JSON.parse(await $.fs.read(home + '/.claude/sessions/' + f.name))
        if (r?.sessionId === me.id) reg = r
      } catch {
        // A registry file mid-write
      }
    }
  }
  ownStartedAt = reg?.startedAt ?? ownStartedAt
  return transcriptPath(home, { cwd: reg?.cwd ?? me.cwd, sessionId: me.id })
}
// When this session's process started, from the registry
let ownStartedAt = 0

// This session's own saved conversation, read the way the catch-up pass reads the others'
async function ownTranscript($) {
  try {
    // One more request than the summary reads, so the oldest one it reads is whole
    const path = await ownTranscriptPath($)
    return await readExchanges($, path, EXCHANGES + 1, ownStartedAt)
  } catch {
    return { exchanges: [], step: '' }
  }
}

// Claude names a new conversation a few seconds after its first request. Until then the
// registry only has a placeholder ("app-a6"), and Claude Desktop already shows the new name,
// so the row neither matches nor highlights. Look for the name every TITLE_POLL_MS for a
// while after a request, instead of waiting for the turn to end.
async function watchTitle($) {
  if (!me || me.title || watchingTitle) return
  watchingTitle = true
  try {
    const until = (await $.clock.now()) + TITLE_WATCH_MS
    while (me && !me.title && (await $.clock.now()) < until) {
      await $.clock.sleep(TITLE_POLL_MS)
      if (!me || me.title) break
      const path = await ownTranscriptPath($)
      let line = ''
      if ((await osOf($)) === 'windows') {
        line = (await tailOf($, path, 2000000)).split('\n').filter((l) => l.includes('"type":"ai-title"')).pop() ?? ''
      } else {
        const r = await $.process.run(['sh', '-c', READ_TITLE, 'sh', path], { timeoutMs: 10000 })
        line = r.exitCode === 0 ? (r.stdout ?? '').trim().split('\n').pop() : ''
      }
      let title = ''
      try {
        title = String(JSON.parse(line).aiTitle ?? '').trim()
      } catch {
        // No name yet, or a line cut mid-write
      }
      if (title && me) {
        me.title = title
        await publish($)
      }
    }
  } finally {
    watchingTitle = false
  }
}

// Read the live-session registry, and delete the records of sessions that ended a while ago
async function syncRegistry($) {
  const home = await homeOf($)
  const dir = home + '/.claude/sessions'
  const live = new Map()
  try {
    for (const f of await $.fs.list(dir)) {
      if (!f.name.endsWith('.json')) continue
      try {
        const reg = JSON.parse(await $.fs.read(dir + '/' + f.name))
        if (reg?.sessionId) live.set(reg.sessionId, reg)
      } catch {
        // A registry file mid-write; the next pass reads it
      }
    }
  } catch {
    // No registry directory: delete nothing
    return
  }
  liveReg = live
  const now = await $.clock.now()
  for (const key of await $.store.keys()) {
    if (!key.startsWith(PREFIX)) continue
    const rec = await $.store.get(key)
    if (rec?.id && !live.has(rec.id) && rec.id !== me?.id && now - (rec.updatedAt ?? 0) > STALE_MS) {
      await $.store.delete(key).catch(() => {})
    }
  }
}

// Claude Code keeps each conversation at ~/.claude/projects/<cwd, every non-alphanumeric as ->/<id>.jsonl
const transcriptPath = (home, reg) => home + '/.claude/projects/' + String(reg.cwd).replace(/[^a-zA-Z0-9]/g, '-') + '/' + reg.sessionId + '.jsonl'

// The user's answer to the assistant's questions or plan, as a request of theirs
function answerText(tool, result, details) {
  const content = typeof result.content === 'string' ? result.content
    : Array.isArray(result.content) ? result.content.filter((b) => b?.type === 'text').map((b) => b.text).join('\n') : ''
  if (tool === 'ExitPlanMode') return result.is_error ? "Didn't approve the plan: " + content.slice(0, 500) : 'Approved the plan.'
  const answers = details?.answers && typeof details.answers === 'object' ? Object.entries(details.answers) : []
  if (answers.length > 0) return "Answered the assistant's questions:\n" + answers.map(([q, a]) => `- ${q} → ${a}`).join('\n')
  return "Answered the assistant's questions: " + content.replace(/\s*Read the answers carefully[\s\S]*$/, '').slice(0, 1500)
}

// From the end of a saved conversation: its last few exchanges, and the tool call under way
function exchangesFromTranscript(tail, since = 0) {
  const entries = []
  // The first line is likely cut by the tail
  for (const line of tail.split('\n').slice(1)) {
    try {
      entries.push(JSON.parse(line))
    } catch {
      // A partial or non-JSON line
    }
  }
  const out = []
  // The turn has ended: the last thing the assistant wrote ended its turn ("end_turn"), and
  // nothing came after it. Claude Code's registry can't tell: it keeps saying "shell" while a
  // command the turn left running goes on.
  let ended = false
  // The last tool call that has no result yet: what a "waiting" session is waiting on
  let pendingTool = null
  // Agents and workflows it started that keep running after their call returns, and that no
  // notification has reported finished, by tool call id. Claude Code marks such a call's result
  // "async_launched"; older versions set run_in_background on the call itself. The agents a
  // workflow runs are its own business: the workflow counts once. Commands it left running
  // (Bash or Monitor in the background) count the same way: their result names a background
  // task, and a notification reports it finished. Only what this process started can still run:
  // a session reopened later lost the old one's.
  const launched = new Map()
  const running = new Map()
  // The title Claude gave the conversation (Claude Desktop shows it; the registry may only hold a
  // placeholder name derived from the folder, like "site-54")
  let title = ''
  // A name given to it (a rename, or the project-first name), which Claude Code shows instead
  let customTitle = ''
  const finishedAgent = (text) => {
    const s = String(text ?? '')
    const id = /<tool-use-id>([^<]+)<\/tool-use-id>/.exec(s)?.[1]
    const task = /<task-id>([^<]+)<\/task-id>/.exec(s)?.[1]
    if (id) running.delete(id)
    if (task) for (const [k, v] of running) if (v.taskId === task) running.delete(k)
  }
  // The assistant's questions (AskUserQuestion) and plans (ExitPlanMode), by tool call id: the
  // user's answer to one comes back as that call's result, not as a typed message
  const asked = new Map()
  // The commands it ran, by key, with the description it gave each
  const commands = {}
  // When the last request or reply was written (ms)
  let lastAt = 0
  const startExchange = (ask, midTurn = false) => {
    // The same request recorded twice (queued, then delivered) is one exchange
    if (ask && out[out.length - 1]?.ask !== ask) out.push({ ask, parts: [], lastTool: null, midTurn })
  }
  for (const d of entries) {
    if (d.isSidechain) continue
    if ((d.type === 'user' || d.type === 'assistant') && !d.isMeta) lastAt = Date.parse(d.timestamp) || lastAt
    if (d.type === 'ai-title' && typeof d.aiTitle === 'string' && d.aiTitle.trim()) title = d.aiTitle.trim()
    if (d.type === 'custom-title' && typeof d.customTitle === 'string' && d.customTitle.trim()) customTitle = d.customTitle.trim()
    const c = d.message?.content
    if (d.type === 'user' && Array.isArray(c)) {
      for (const b of c) {
        if (b?.type !== 'tool_result') continue
        const r = d.toolUseResult
        const at = Date.parse(d.timestamp) || 0
        if (typeof r?.backgroundTaskId === 'string' && r.backgroundTaskId) running.set(b.tool_use_id, { kind: 'command', taskId: r.backgroundTaskId, at })
        if (!launched.has(b.tool_use_id)) continue
        if (r?.status === 'async_launched' || r?.isAsync === true) running.set(b.tool_use_id, { kind: launched.get(b.tool_use_id), taskId: r?.taskId ?? r?.agentId ?? '', at })
      }
    }
    if (d.type === 'assistant') ended = d.message?.stop_reason === 'end_turn'
    else if (d.type === 'user' && !d.isMeta) ended = false
    if (d.type === 'user' && Array.isArray(c) && pendingTool && c.some((b) => b?.type === 'tool_result' && b.tool_use_id === pendingTool.id)) pendingTool = null
    const answer = d.type === 'user' && Array.isArray(c) ? c.find((b) => b?.type === 'tool_result' && asked.has(b.tool_use_id)) : null
    if (answer) {
      startExchange(answerText(asked.get(answer.tool_use_id), answer, d.toolUseResult))
    } else if (d.type === 'user' && !d.isMeta && !d.isCompactSummary) {
      const text =
        typeof c === 'string' ? c
        : Array.isArray(c) && !c.some((b) => b?.type === 'tool_result') ? c.filter((b) => b?.type === 'text').map((b) => b.text).join('\n')
        : ''
      if (/<task-notification>/.test(text)) finishedAgent(text)
      startExchange(typedText(text))
    } else if (d.type === 'attachment' && d.attachment?.type === 'queued_command' && d.attachment.commandMode === 'task-notification') {
      finishedAgent(Array.isArray(d.attachment.prompt) ? d.attachment.prompt.map((b) => b?.text ?? '').join('') : d.attachment.prompt)
    } else if (d.type === 'attachment' && d.attachment?.type === 'queued_command' && d.attachment.commandMode === 'prompt') {
      // A message sent while the session was working: its text, or its text parts when it
      // came with images
      const prompt = d.attachment.prompt
      const text = Array.isArray(prompt) ? prompt.filter((b) => b?.type === 'text').map((b) => b.text).join('\n') : prompt
      startExchange(typedText(text), true)
    } else if (d.type === 'assistant' && out.length > 0 && Array.isArray(c)) {
      const x = out[out.length - 1]
      for (const b of c) {
        if (b?.type === 'text') x.parts.push({ text: b.text, tool: false })
        // Thinking it shows as it works (stored empty when it isn't shown): it can hold an answer
        if (b?.type === 'thinking' && b.thinking?.trim()) x.parts.push({ text: b.thinking, tool: false, note: true })
        if (b?.type === 'tool_use') {
          // The description Claude gave a command it ran, for when it's still running
          if ((b.name === 'Bash' || b.name === 'Monitor') && typeof b.input?.command === 'string' && typeof b.input?.description === 'string' && b.input.description.trim()) {
            commands[commandKey(b.input.command)] = oneLine(b.input.description, 120)
          }
          x.parts.push({ text: '', tool: true })
          x.lastTool = b
          pendingTool = b
          if (b.name === 'AskUserQuestion' || b.name === 'ExitPlanMode') asked.set(b.id, b.name)
          if (b.name === 'Agent' || b.name === 'Task' || b.name === 'Workflow') {
            const kind = b.name === 'Workflow' ? 'workflow' : 'agent'
            launched.set(b.id, kind)
            if (b.input?.run_in_background) running.set(b.id, { kind, taskId: '', at: Date.parse(d.timestamp) || 0 })
          }
        }
      }
    }
  }
  const last = out[out.length - 1]
  const step = last?.lastTool ? stepOf({ tool: last.lastTool.name, ...(last.lastTool.input ?? {}) }) : ''
  const live = [...running.values()].filter((r) => !since || !r.at || r.at >= since)
  return { exchanges: asExchanges(out), step, count: out.length, ended, agents: live.filter((r) => r.kind === 'agent').length,
    workflows: live.filter((r) => r.kind === 'workflow').length, background: live.filter((r) => r.kind === 'command').length, pendingTool, title: customTitle || title, commands, lastAt }
}

// A saved conversation's last exchanges, reading back until it has `want` requests (or the
// whole file, or the cap)
async function readExchanges($, path, want, since = 0) {
  let size = Infinity
  try {
    size = (await $.fs.stat(path)).size
  } catch {
    // Read what tail finds
  }
  for (let bytes = TAIL_START_BYTES; ; bytes = Math.min(bytes * 4, TAIL_MAX_BYTES)) {
    const out = await tailOf($, path, bytes)
    const parsed = exchangesFromTranscript(out, since)
    // Reading further back the same way can't help once the output is full: the requests
    // before it come from their own read
    const full = out.length >= READ_OUT_BYTES - 1000
    if (full && parsed.count < want) return withEarlierAsks(out, await tailOf($, path, Math.min(size, TAIL_MAX_BYTES), true), since)
    if (parsed.count >= want || full || bytes >= size || bytes >= TAIL_MAX_BYTES) return parsed
  }
}

// A full read, with the requests from before it put in front: only the ones older than its first
// whole line, so none is counted twice
function withEarlierAsks(out, asks, since) {
  const lines = out.split('\n').slice(1)
  const first = lines.map((l) => /"timestamp":"([^"]+)"/.exec(l)?.[1]).find(Boolean)
  const before = first ? Date.parse(first) : Infinity
  const earlier = asks.split('\n').filter((l) => {
    const at = /"timestamp":"([^"]+)"/.exec(l)?.[1]
    return at && Date.parse(at) < before
  })
  return exchangesFromTranscript(['cut', ...earlier, ...lines].join('\n'), since)
}

// This session's own commands: when one ends (or starts) while it's idle, its board is out of
// date, since no turn will come to summarize it again. Every session checks its own.
// The same goes for a turn whose last summary never happened: the mod reloaded as the turn
// ended (the new copy starts idle and gets no turn.complete), or the call failed for good.
async function checkOwnJobs($) {
  if (!me || me.status !== 'idle' || summarizing) return
  const registry = new Map()
  const home = await homeOf($)
  for (const f of await $.fs.list(home + '/.claude/sessions')) {
    if (!f.name.endsWith('.json')) continue
    try {
      const reg = JSON.parse(await $.fs.read(home + '/.claude/sessions/' + f.name))
      if (reg?.sessionId) registry.set(reg.sessionId, reg)
    } catch {
      // A registry file mid-write
    }
  }
  const own = await ownTranscript($)
  const latest = own.exchanges[own.exchanges.length - 1]?.reply ?? ''
  const missed = own.ended && latest !== '' && latest !== me.summaryReply && latest !== healedReply
  // What the last idle check saw, kept on the record, for when a board falls behind
  me.idleCheck = { at: await $.clock.now(), ended: !!own.ended, missed }
  // When the conversation last had a message, for a session that hasn't changed status since it
  // started: reopening an old chat in Claude Desktop starts a new process, and that alone isn't activity
  if (!me.lastMessageAt && own.lastAt) {
    me.lastMessageAt = own.lastAt
    await publish($)
  }
  if (missed) {
    healedReply = latest
    return summarize($)
  }
  if (!me.summary) return
  const found = describeJobs((await runningJobs($, registry)).get(me.id) ?? [], own.commands).map((j) => j.label)
  const background = liveCommands(own.background, registry.get(me.id))
  const mine = [...found, ...backgroundLabels(own.agents, own.workflows, background, found.length)].sort().join(',')
  if (me.jobsKey === undefined || me.jobsKey !== mine) await summarize($)
  else if ((own.agents ?? 0) !== (me.agentsRunning ?? 0) || (own.workflows ?? 0) !== (me.workflowsRunning ?? 0) || background !== (me.commandsRunning ?? 0)) {
    me.agentsRunning = own.agents ?? 0
    me.workflowsRunning = own.workflows ?? 0
    me.commandsRunning = background
    await publish($)
  }
}

// Sessions that started before the mod loaded keep no record of their own. One session at a
// time (a lease in the store) reads their saved conversations and keeps a record for them,
// marked shadow: what they are doing now, and the summary's items when a new request shows up, after
// a turn, and every BUSY_RESUMMARY_MS through a long one. The window takes their status from
// the registry.
// A debugging aid: the model call the summaries make, on request, to check a model on a real
// prompt. Put <name>.json in ~/Library/Application Support/session-board/replay with
// { model, effort?, maxTokens? } and either { system, prompt } or { transcript, working?, jobs? }
// (a saved conversation, read and turned into the summary prompt exactly as the catch-up pass
// does). The session holding the catch-up lease writes <name>.out.json next to it with the
// prompt, the answer and how long it took.
async function runReplays($) {
  const dir = (await dataDir($)) + '/replay'
  let files
  try {
    files = await $.fs.list(dir)
  } catch {
    return
  }
  for (const f of files) {
    if (!f.name.endsWith('.json') || f.name.endsWith('.out.json')) continue
    const out = dir + '/' + f.name.replace(/\.json$/, '.out.json')
    if (await $.fs.exists(out)) continue
    let req
    try {
      req = JSON.parse(await $.fs.read(dir + '/' + f.name))
    } catch {
      continue
    }
    const started = await $.clock.now()
    let result
    let system = req.system
    let prompt = req.prompt
    try {
      if (req.transcript) {
        const { exchanges: recent, ended } = await readExchanges($, req.transcript, 1)
        const latest = recent[recent.length - 1]
        const busy = !ended && !!req.working
        const pendingAsk = busy && latest && !latest.reply ? latest.ask : ''
        const { exchanges } = await readExchanges($, req.transcript, EXCHANGES + 1)
        const read = (pendingAsk ? exchanges.slice(0, -1) : exchanges).slice(-EXCHANGES)
        system = SUMMARY_SYSTEM
        prompt = summaryPrompt('none', [], read, pendingAsk, busy, req.jobs ?? [])
      }
      const answer = await $.model.complete({
        model: req.model ?? 'haiku',
        maxTokens: req.maxTokens ?? 400,
        system,
        prompt,
        ...(req.effort ? { effort: req.effort } : {}),
      })
      result = typeof answer === 'string' ? { text: answer } : { text: answer?.text ?? '', answered: answer?.isAnswered, reason: answer?.reason, usage: answer?.usage ?? null }
    } catch (err) {
      result = { error: String(err?.message ?? err) }
    }
    await $.fs.write(out, JSON.stringify({ ...result, model: req.model ?? 'haiku', effort: req.effort ?? null, ms: (await $.clock.now()) - started, prompt }, null, 2))
  }
}

// Cloud sessions leave nothing on this computer but what Claude Desktop shows of them: the Mac
// window reads the chat Desktop has open and keeps its latest exchanges in cloud/<id>.json. Each
// is summarized here like a local session's conversation, into cloud/<id>.summary.json, which
// the window shows on the cloud card. Only a chat read again since its last summary is asked about,
// and one still working at most every BUSY_RESUMMARY_MS.
const CLOUD_DAY_MS = 12 * 60 * 60 * 1000
async function summarizeCloud($) {
  const dir = (await dataDir($)) + '/cloud'
  let files
  try {
    files = await $.fs.list(dir)
  } catch {
    return
  }
  const now = await $.clock.now()
  for (const f of files) {
    if (!/^[\w-]+\.json$/.test(f.name) || f.name.endsWith('.summary.json')) continue
    const id = f.name.slice(0, -'.json'.length)
    let chat, prev
    try {
      chat = JSON.parse(await $.fs.read(dir + '/' + f.name))
    } catch {
      continue
    }
    const exchanges = (Array.isArray(chat?.exchanges) ? chat.exchanges : [])
      .filter((x) => typeof x?.ask === 'string' && typeof x?.reply === 'string')
      .map((x) => ({ ask: x.ask, reply: x.reply }))
    if (exchanges.length === 0 || !(now - (chat.readAt ?? 0) < CLOUD_DAY_MS)) continue
    try {
      prev = JSON.parse(await $.fs.read(dir + '/' + id + '.summary.json'))
    } catch {
      prev = null
    }
    if (prev?.mark === chat.mark) continue
    const working = chat.status === 'working'
    if (working && prev && now - (prev.at ?? 0) < BUSY_RESUMMARY_MS) continue
    try {
      const summary = await summarizeExchanges($, chat.rowId || 'cloud:' + id, exchanges.slice(-EXCHANGES), '', prev?.summary ?? null, working, null)
      await $.fs.write(dir + '/' + id + '.summary.json', JSON.stringify({ rowId: chat.rowId ?? '', mark: chat.mark, at: now, summary }))
    } catch {
      // The next read tries again
    }
  }
}

async function catchUp($) {
  if (!me) return
  const now = await $.clock.now()
  const lease = await $.store.get(CATCHUP_LEASE)
  if (lease && lease.id !== me.id && lease.until > now && (lease.v ?? 0) >= LEASE_VERSION) return
  await $.store.set(CATCHUP_LEASE, { id: me.id, until: now + 3 * CATCHUP_MS, v: LEASE_VERSION })
  await runReplays($).catch(() => {})
  await syncRegistry($)
  const home = await homeOf($)
  const summaries = await summariesOn($)
  if (summaries) await summarizeCloud($).catch(() => {})
  const jobs = await runningJobs($, liveReg)
  for (const [id, reg] of liveReg) {
    if (id === me.id || !reg.cwd) continue
    const rec = await $.store.get(PREFIX + id)
    if (rec && !rec.shadow) continue
    const running = jobs.get(id) ?? []
    let sessionJobs = running.map((j) => j.label)
    let jobsKey = [...sessionJobs].sort().join(',')
    // A record from before jobs were tracked counts as changed once, so it's checked against them
    const jobsChanged = rec?.jobsKey === undefined ? !!rec?.summary : rec.jobsKey !== jobsKey
    const path = transcriptPath(home, reg)
    let stat
    try {
      stat = await $.fs.stat(path)
    } catch {
      continue
    }
    const mark = stat.size + ':' + stat.mtimeMs
    // The registry's status moved since this record was read (a new turn, or a turn that ended
    // while its jobs run): read again, even when the conversation looks the same
    const statusMoved = (reg.statusUpdatedAt ?? 0) > (rec?.updatedAt ?? 0)
    if (seenTranscripts.get(id) === mark && !jobsChanged && !statusMoved) continue
    seenTranscripts.set(id, mark)
    // The latest request and step need only the end; a summary reads further back
    const { exchanges: recent, step, ended, agents, workflows, background: noted, pendingTool, title, commands, lastAt } = await readExchanges($, path, 1, reg.startedAt ?? 0)
    const background = liveCommands(noted, reg)
    // Its running commands by the descriptions it gave them
    const described = describeJobs(running, commands)
    sessionJobs = described.map((j) => j.label)
    const latest = recent[recent.length - 1]
    // Working: "busy" or "shell" while the turn goes on. The registry keeps saying so after
    // the turn has ended while a command or a background agent it started still runs: the
    // conversation's end of turn decides. "waiting" is waiting on the user.
    const busy = !ended && (reg.status === 'busy' || reg.status === 'shell')
    const next = { tasks: [], ...(rec ?? {}), id, cwd: reg.cwd, shadow: true, runningLabels: describedOnly(running, commands), step: busy ? step : '', turnEnded: ended, agentsRunning: agents, workflowsRunning: workflows, commandsRunning: background, title: title || rec?.title || '', lastMessageAt: lastAt || rec?.lastMessageAt, ask: reg.status === 'waiting' && pendingTool ? askFor(pendingTool.name, pendingTool.input) : '', updatedAt: now }
    // Background agents count as jobs too, for the summary and for noticing when they finish
    sessionJobs.push(...backgroundLabels(agents, workflows, background, sessionJobs.length))
    if (latest) next.request = oneLine(latest.ask, 140)
    // A request the board hasn't seen yet, a finished turn, or a long one
    const newAsk = !!latest && latest.ask !== rec?.summaryAsk
    const wroteMore = (latest?.reply ?? '') !== (rec?.summaryReply ?? '')
    const due = newAsk || !busy || jobsChanged || (wroteMore && now - (rec?.summary?.at ?? 0) > BUSY_RESUMMARY_MS)
    if (summaries && due && latest && (next.summaryMark !== mark || jobsChanged)) {
      try {
        // A request with no reply yet is the work starting
        const pendingAsk = busy && !latest.reply ? latest.ask : ''
        const { exchanges } = await readExchanges($, path, EXCHANGES + 1)
        next.summary = await summarizeExchanges($, id, pendingAsk ? exchanges.slice(0, -1) : exchanges, pendingAsk, rec?.summary, busy, sessionJobs)
        next.summaryMark = mark
        next.summaryAsk = latest.ask
        next.summaryReply = latest.reply ?? ''
        next.jobsKey = jobsKey
        delete next.summaryError
      } catch (err) {
        // Keep the previous items; the next change tries again. Why it failed, for troubleshooting
        next.summaryError = oneLine(err?.message ?? err, 200)
      }
    }
    await $.store.set(PREFIX + id, next)
  }
}

// The window app lives at ~/Applications/Session Board.app. It is built on this Mac from the
// plugin's source, the first time and again when an update changes that source: an app built
// here runs without the Apple notarization a downloaded one would need. `current` is false
// when it has to be (re)built.
async function appState($) {
  const app = (await homeOf($)) + '/Applications/' + APP_NAME
  const board = $.plugin.root + '/board'
  let want = ''
  try {
    const sum = await $.process.run(['shasum', '-a', '256', board + '/main.swift', board + '/build.sh'], { timeoutMs: 10000 })
    want = String(sum.stdout ?? '').split('\n').map((l) => l.split(' ')[0]).filter(Boolean).join(':')
  } catch {
    // Can't tell what the source is: an app that is there will do
  }
  let have = ''
  try {
    have = String(await $.fs.read((await dataDir($)) + '/built.sha')).trim()
  } catch {
    // Never built here
  }
  const exists = await $.fs.exists(app)
  return { app, current: exists && (!want || have === want) }
}

// Build the app when it isn't current. One session builds (a lease in the store); the others
// throw "building" and leave it to that one, which opens the window when it's done.
async function buildApp($) {
  const { app, current } = await appState($)
  if (current) return app
  const now = await $.clock.now()
  const lease = await $.store.get(BUILD_LEASE)
  if (lease && lease.id !== me?.id && lease.until > now) throw new Error('building')
  await $.store.set(BUILD_LEASE, { id: me?.id ?? '', until: now + BUILD_MS })
  try {
    const r = await $.process.run(['sh', $.plugin.root + '/board/build.sh', app], { timeoutMs: BUILD_MS })
    if (r.exitCode !== 0) throw new Error(oneLine(r.stderr || r.stdout, 200) || 'the build failed')
  } finally {
    await $.store.delete(BUILD_LEASE).catch(() => {})
  }
  return app
}

// Windows and Linux: the window app (app/ in this repo) is built for each OS by the release
// workflow and downloaded, then checked against the checksum in app/release.json, part of this
// plugin, before it is installed: a download that doesn't match is thrown away.
const RELEASES = 'https://github.com/KiranPothana/session-board/releases/download'

async function releaseOf($) {
  try {
    return JSON.parse(await $.fs.read($.plugin.root + '/app/release.json'))
  } catch {
    return null
  }
}

async function downloadedApp($) {
  const os = await osOf($)
  const release = await releaseOf($)
  if (!release) throw new Error("the plugin's app/release.json is missing")
  const machine = os === 'windows'
    ? String((await $.env.get('PROCESSOR_ARCHITECTURE')) ?? '')
    : String((await $.process.run(['uname', '-m'], { timeoutMs: 5000 }).catch(() => null))?.stdout ?? '').trim()
  const key = `${os}-${/arm64|aarch64/i.test(machine) ? 'arm64' : 'x64'}`
  const asset = release.assets?.[key]
  if (!asset?.file || !/^[0-9a-f]{64}$/.test(asset.sha256 ?? '')) throw new Error(`there's no Session Board window app for ${key} yet`)
  // Where it goes, and the file saying which version is there
  const dir = os === 'windows' ? ((await $.env.get('LOCALAPPDATA')) || (await homeOf($)) + '/AppData/Local') + '/Programs/Session Board' : (await dataDir($)) + '/app'
  const app = dir + '/' + asset.file
  const versionFile = dir + '/version.txt'
  let have = ''
  try {
    have = String(await $.fs.read(versionFile)).trim()
  } catch {
    // Not installed yet
  }
  return { os, dir, app, asset, versionFile, version: release.version, current: have === release.version && (await $.fs.exists(app)) }
}

// One install at a time across sessions, which can all start together. The lock is a file in
// the app's folder, made by an operation that fails when the file is already there (a hard link
// on Linux, a move that doesn't overwrite on Windows), so only one session gets it. It holds its
// owner's token and the time it runs out: a lock left by a session that died is taken over once
// it has run out, and a session removes a lock only while it still holds its own token.
async function fileOp($, os, op, from, to) {
  const ps = (script) => powershell($, script, 20000)
  let r
  if (op === 'remove') r = os === 'windows' ? await ps(`Remove-Item -Force -LiteralPath ${psQuote(from)}`) : await $.process.run(['rm', '-f', from], { timeoutMs: 20000 })
  // Put `from` at `to`, failing when `to` is there
  else if (op === 'place') r = os === 'windows' ? await ps(`try { [IO.File]::Move(${psQuote(from)}, ${psQuote(to)}) } catch { exit 1 }`) : await $.process.run(['ln', from, to], { timeoutMs: 20000 })
  // Move `from` to `to`, a name no other session uses, failing when `from` is gone
  else r = os === 'windows' ? await ps(`try { [IO.File]::Move(${psQuote(from)}, ${psQuote(to)}) } catch { exit 1 }`) : await $.process.run(['mv', from, to], { timeoutMs: 20000 })
  return r?.exitCode === 0
}

async function lockHolder($, path) {
  let text
  try {
    text = String(await $.fs.read(path))
  } catch {
    return null
  }
  try {
    const held = JSON.parse(text)
    return { token: String(held.token ?? ''), until: Number(held.until) || 0 }
  } catch {
    // Not a lock this code wrote: out of date
    return { token: text, until: 0 }
  }
}

// Puts a file made under a name of its own at `to` without overwriting, then clears the name
// (on Linux the link leaves it; on Windows the move took it)
async function placeOnce($, os, from, to) {
  const placed = await fileOp($, os, 'place', from, to)
  if (os !== 'windows' || !placed) await fileOp($, os, 'remove', from).catch(() => {})
  return placed
}

// Moves the lock aside under a name of its own, so of two sessions only one gets it, and keeps it
// only when it still holds `token`; another session's lock is put back. True when it was kept.
async function takeLock($, os, lock, token) {
  const aside = `${lock}.${crypto.randomUUID()}.old`
  if (!(await fileOp($, os, 'move', lock, aside))) return false
  const held = await lockHolder($, aside)
  if (held?.token === token) {
    await fileOp($, os, 'remove', aside).catch(() => {})
    return true
  }
  await placeOnce($, os, aside, lock)
  return false
}

async function lockInstall($, d) {
  const lock = d.dir + '/install.lock'
  const token = crypto.randomUUID()
  for (let i = 0; i < 3; i++) {
    const mine = `${lock}.${token}`
    await $.fs.write(mine, JSON.stringify({ token, until: (await $.clock.now()) + BUILD_MS }))
    if (await placeOnce($, d.os, mine, lock)) return { lock, token }
    const held = await lockHolder($, lock)
    // Released since: try again. Held by a session still in time: leave it to that one.
    if (!held) continue
    if (held.until > (await $.clock.now())) return null
    // Run out: whoever moves it aside first takes it over
    if (!(await takeLock($, d.os, lock, held.token))) return null
  }
  return null
}

async function unlockInstall($, d, held) {
  await takeLock($, d.os, held.lock, held.token).catch(() => {})
}

async function installApp($, d, held) {
  const run = (argv, timeoutMs = 60000) => $.process.run(argv, { timeoutMs })
  const ps = (script, timeoutMs = 60000) => powershell($, script, timeoutMs)
  if (d.os === 'windows') await ps(`New-Item -ItemType Directory -Force -Path ${psQuote(d.dir)} | Out-Null`)
  else await run(['mkdir', '-p', d.dir])
  // Downloads left by a session that stopped part way (each install downloads under a name of
  // its own); only the lock's holder gets here
  for (const f of await $.fs.list(d.dir).catch(() => [])) {
    if (f.name.endsWith('.download')) await fileOp($, d.os, 'remove', d.dir + '/' + f.name).catch(() => {})
  }
  const tmp = `${d.app}.${held.token}.download`
  const got = await run(['curl', '-fsSL', '--retry', '2', '-o', tmp, `${RELEASES}/v${d.version}/${d.asset.file}`], 5 * 60 * 1000)
  if (got.exitCode !== 0) throw new Error('the window app could not be downloaded: ' + oneLine(got.stderr, 120))
  const sum = d.os === 'windows'
    ? (await ps(`(Get-FileHash -Algorithm SHA256 -LiteralPath ${psQuote(tmp)}).Hash`)).stdout
    : (await run(['sha256sum', tmp])).stdout
  if (String(sum ?? '').trim().split(/\s+/)[0].toLowerCase() !== d.asset.sha256) {
    if (d.os === 'windows') await ps(`Remove-Item -Force -LiteralPath ${psQuote(tmp)}`).catch(() => {})
    else await run(['rm', '-f', tmp]).catch(() => {})
    throw new Error("the downloaded window app didn't match its checksum, so it wasn't installed")
  }
  // Still this session's turn? A session whose lock ran out and was taken over leaves it to the new holder
  if ((await lockHolder($, held.lock))?.token !== held.token) {
    await fileOp($, d.os, 'remove', tmp).catch(() => {})
    throw new Error('building')
  }
  if (d.os === 'windows') {
    // A running copy holds its file: stop it, then put the new one in place
    await run(['taskkill', '/IM', d.asset.file, '/F']).catch(() => {})
    await ps(`Move-Item -Force -LiteralPath ${psQuote(tmp)} -Destination ${psQuote(d.app)}`)
  } else {
    await run(['mv', '-f', tmp, d.app])
    await run(['chmod', '+x', d.app])
  }
  await $.fs.write(d.versionFile, d.version)
}

// Gets the window app ready: built on macOS, downloaded on Windows and Linux. One session at a
// time (build.sh's lock on macOS, the install lock elsewhere); the others throw "building" and
// leave it to that one.
export async function readyApp($) {
  if ((await osOf($)) === 'macos') return { os: 'macos', app: await buildApp($) }
  let d = await downloadedApp($)
  if (d.current) return d
  const held = await lockInstall($, d)
  if (!held) throw new Error('building')
  try {
    // Another session may have put it in place while this one waited for the lock
    d = await downloadedApp($)
    if (!d.current) await installApp($, d, held)
  } finally {
    await unlockInstall($, d, held)
  }
  return d
}

// Start the window app, getting it ready first if needed, or show its window again if it is
// running but hidden. macOS: `open` keeps it to one instance and -g leaves the focus where it
// is. Windows and Linux: the app keeps itself to one instance, and starts on its own, outliving
// this session.
async function openBoard($) {
  building ??= readyApp($).finally(() => {
    building = null
  })
  const { os, app } = await building
  if (os === 'macos') await $.process.run(['open', '-g', app], { timeoutMs: 10000 })
  else if (os === 'windows') await $.process.run(['cmd', '/c', 'start', '', app], { timeoutMs: 10000 })
  // The AppImage unpacks itself rather than mounting with FUSE, which many systems lack
  else await $.process.run(['sh', '-c', 'APPIMAGE_EXTRACT_AND_RUN=1 nohup "$0" >/dev/null 2>&1 &', app], { timeoutMs: 10000 })
}

// A build that failed says why under the prompt (in the terminal; Desktop draws no mod notices),
// and is kept in last-error.json, which the feedback skill sends when the user asks to report it
function reportFailure($, err) {
  if (err?.message === 'building') return
  const message = String(err?.message ?? err).slice(0, 2000)
  void (async () => {
    await $.fs.write((await dataDir($)) + '/last-error.json', JSON.stringify({ kind: 'build', at: await $.clock.now(), message }))
  })().catch(() => {})
  try {
    $.ui.toast('Session Board: ' + oneLine(message, 140) + ' · Tell Claude "report the Session Board error" to send it to us', { timeoutMs: 15000 })
  } catch {
    // No surface to show it on
  }
}

export function register(on) {
  on('session.start', async ($, e, next) => {
    // A `claude -p` run or an SDK job has no one watching: keep no record for it and make no
    // summary calls. `me` stays null, which turns every other hook into a pass-through. The
    // Desktop app runs Claude Code the SDK way too (not interactive, no surface until it
    // attaches), so it is told apart by the entrypoint it sets.
    const isDesktop = (await $.env.get('CLAUDE_CODE_ENTRYPOINT')) === 'claude-desktop'
    if (!e.isInteractive && !e.surface && !isDesktop) return next(e)
    await $.command.register({
      name: 'session-board',
      description: 'Show the Session Board window (or press its shortcut, Control-Option-S unless changed in Settings)',
      immediate: true,
    })
    await init($)
    $.clock.every(CATCHUP_MS, () => {
      void checkOwnJobs($).catch(() => {})
      void catchUp($).catch(() => {})
    })
    // A new session brings up the window, once per session, not per reload
    if (!me.boardOpened) {
      me.boardOpened = true
      publishSoon($)
      void openBoard($).catch((err) => reportFailure($, err))
    }
    return next(e)
  })

  // /clear, /resume and /branch start a new conversation without a new session.start
  on('classic.SessionStart', { source: ['clear', 'resume', 'fork'] }, async ($, e, next) => {
    if (me) {
      try {
        const oldId = me.id
        const id = await $.session.id()
        if (oldId !== id) await $.store.delete(PREFIX + oldId)
        if (e.source === 'clear') await $.store.delete(PREFIX + id)
        me = null
        awaitingReply = ''
        await init($)
      } catch {
        // A store that can't be written leaves the board behind, never the session
      }
    }
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    if (me && e.reason !== 'clear' && e.reason !== 'resume') await $.store.delete(PREFIX + me.id).catch(() => {})
    return next(e)
  })

  // Brings up the window on the Mac, wherever the command was typed. Typing it is asking for
  // the window, so it shows even if you had hidden it: the window acts on show-request.
  on('command.run', { command: 'session-board' }, async ($) => {
    try {
      await $.fs.write((await dataDir($)) + '/show-request', String((await $.clock.now()) / 1000))
    } catch {
      // Without the request the window still starts, following your settings as usual
    }
    if ((await osOf($)) !== 'macos') {
      const d = await downloadedApp($).catch((err) => ({ error: err }))
      if (d.error) return { text: 'Session Board: ' + oneLine(d.error.message, 200) }
      void openBoard($).catch((err) => reportFailure($, err))
      return d.current || building ? {} : { text: 'Downloading the Session Board app (first run or after an update); the window opens when it is done.' }
    }
    const { current } = await appState($)
    if (current || building) {
      void openBoard($).catch((err) => reportFailure($, err))
      return current ? {} : { text: 'Session Board is still being built; the window opens when it is done.' }
    }
    // The first run, or an update changed the app: say so, since the build takes a minute
    const tools = await $.process.run(['xcode-select', '-p'], { timeoutMs: 10000 }).catch(() => ({ exitCode: 1 }))
    if (tools.exitCode !== 0) {
      return { text: "Session Board builds its window app on your Mac and needs Apple's command-line tools for that. Run `xcode-select --install`, then /session-board again." }
    }
    void openBoard($).catch((err) => reportFailure($, err))
    return { text: 'Building the Session Board app on your Mac (first run or after an update; under a minute). The window opens when it is done.' }
  })

  on('prompt.submit', async ($, e, next) => {
    const kind = e.origin?.kind
    const typed = typedText(e.text)
    if (me && (kind === 'composer' || kind === 'bridge') && typed && !me.projectTitled) {
      await nameWithProject($, typed).catch(() => {})
    }
    if (me && (kind === 'composer' || kind === 'bridge') && typed) {
      awaitingReply = typed
      me.request = oneLine(typed, 140)
      me.asks = [...(me.asks ?? []), oneLine(typed, ASK_LINE)].slice(-ASKS_KEPT)
      // What waited on them stays marked until the next summary says it's answered: a message
      // about something else doesn't answer it. (The window shows the marks only while idle.)
      if (me.status === 'needs-you') me.status = 'working'
      me.ask = ''
      publishSoon($)
      // The board shows the new request's work now, not when the turn ends
      void summarize($)
      void watchTitle($).catch(() => {})
    }
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    if (me) {
      turnAnswer = ''
      tasksMoved = false
      me.status = 'working'
      me.step = ''
      publishSoon($)
    }
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (me) {
      me.status = 'idle'
      me.step = ''
      awaitingReply = ''
      turnAnswer = e.answer ?? ''
      publishSoon($)
      if (e.reason === 'answer') void summarize($)
    }
    return result
  })

  on('tool.call', async ($, e, next) => {
    if (!me || e.agentId) return next(e)
    me.step = stepOf(e)
    // The call a permission prompt would be for, while it waits
    callInProgress = { tool: e.tool, input: e }
    // A reload in the middle of a turn starts the record as idle; a tool call means it works
    if (me.status === 'idle') me.status = 'working'
    if (e.tool === 'AskUserQuestion' || e.tool === 'ExitPlanMode') {
      me.status = 'needs-you'
      me.ask = askFor(e.tool, e)
    }
    publishSoon($)
    // A long turn: catch the board up with it
    if (!summarizing && (await $.clock.now()) - lastTry > BUSY_RESUMMARY_MS) {
      awaitingReply = ''
      void summarize($, { onlyIfNew: true })
    }
    const r = await next(e)
    callInProgress = null
    try {
      trackTasks(e, r)
    } catch {
      // An unexpected task tool shape leaves the list as it was
    }
    if (me.status === 'needs-you') me.status = 'working'
    me.ask = ''
    publishSoon($)
    // An answered question or plan changes what's open: summarize once it's in the saved conversation
    if (e.tool === 'AskUserQuestion' || e.tool === 'ExitPlanMode') {
      void $.clock.sleep(3000).then(() => summarize($)).catch(() => {})
    }
    return r
  })

  // A permission prompt is on screen (Claude Code's notification says so): the session waits on
  // you until the call goes on, and the call waiting is the one in progress. The mod never
  // takes part in the permission decision itself. (tool.check's "ask" is no sign of a prompt:
  // in Auto mode the classifier settles it.)
  on('classic.Notification', async ($, e, next) => {
    if (me && e.notification_type === 'permission_prompt') {
      me.status = 'needs-you'
      me.ask = callInProgress ? askFor(callInProgress.tool, callInProgress.input) : me.ask || 'A permission prompt is open'
      publishSoon($)
    }
    return next(e)
  })
}

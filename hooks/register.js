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
// How long a summary after a turn waits for the turn's last reply to reach the saved conversation
const ANSWER_WAIT_MS = 1000
const ANSWER_TRIES = 3
// What a summary reads: the last few exchanges, the latest reply at most this long, older
// replies and the requests shorter
const EXCHANGES = 4
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
  'You keep a short to-do board for one Claude Code session: what the user would expect to see at a glance.',
  "You get the session's last few exchanges, oldest first (each the user's request and the assistant's final reply), then the board as it was before.",
  'Rebuild the board from the exchanges. Reply with JSON only: {"done": "...", "side": "...", "paused": "...", "active": [...], "pending": [...]}.',
  'side: when the user raised something in the middle of other work that still has open steps (a bug they spotted, a quick question, a detour), the work the session is doing for it right now; paused: the planned work it set aside for it. Both "" otherwise, and both "" again once the side task is finished and the planned work goes on. The board shows them on their own lines: while there is a side task, active does not name it again and pending does not repeat the paused work.',
  'done: the last piece of work the session finished, as one short line in plain words: what was achieved, not the commands run. "" when the exchanges show nothing finished yet.',
  'active: the work the session is doing now for the latest request, 0 to 2 items. When the latest request has no reply yet, or the assistant is still working on it, name that work, reading it in the light of the earlier exchanges (a "go ahead" continues what was planned). Work the assistant is still doing never waits on the user. When the latest reply is the assistant\'s final reply (its turn has ended), active is empty, even while a command or agent it left running goes on: the board shows those on their own line. What it will do once they finish (release after the tests pass) is pending, not active.',
  'pending: what is still to do, 0 to 5 items, the ones that wait on the user first. One item per piece of work: never split one piece of work into its steps.',
  'Mark a pending item "· waits on you" only when the session is stopped on the user for it right now: the latest reply asks them a question, asks for their approval or go, or asks them to do something themselves now, such as try, test, check, review, choose, run or tell it something ("please try it", "check it on your phone", "tell me which you prefer", "run this yourself"). Word that item as the user\'s step ("Test the new login · waits on you"). A step that needs the user later, after work the session is still doing or will do first (an iPhone check after the deploy it is running, a go for live after the sandbox), does not wait on them yet. While the session is still working, or a command it left running is still going, nothing waits on the user unless the latest reply asks them something. Never mark an active item.',
  'You also get the commands this session left running (tests, builds, servers, agents). Never list one that is still running as an item, since the board shows it; list what comes after it as pending. When none is left, work a reply said was running in the background has finished.',
  'Keep an item only while the exchanges show it is still open: work the latest replies list as still to do, a question still unanswered, or work under way. Drop what they show as done, replaced, handled elsewhere or no longer wanted, and anything only an older exchange mentioned that the later ones moved past.',
  'The board before is no evidence: an item on it that the exchanges do not show as still open is dropped. When an item is the same work as one on it, reuse that wording, so the board does not churn.',
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
// A summary was asked for while one ran: run again once it's done, with what's new
let summarizeAgain = false
// The reply the last turn ended with, until the next one starts
let turnAnswer = ''
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

const oneLine = (s, n) => {
  const line = String(s ?? '').split('\n').map((x) => x.trim()).find(Boolean) ?? ''
  return line.length > n ? line.slice(0, n - 1) + '…' : line
}

const baseName = (p) => String(p ?? '').split('/').filter(Boolean).pop() ?? '?'

const dataDir = async ($) => (await $.env.get('HOME')) + '/Library/Application Support/session-board'

// One line naming what a tool call is doing, such as "Bash: Run the tests"
function stepOf(e) {
  const arg = [e.description, e.subject, e.command, e.file_path, e.pattern, e.url, e.query, e.prompt]
    .find((v) => typeof v === 'string' && v.trim())
  const shown = arg && arg === e.file_path ? baseName(arg) : arg
  return oneLine(e.tool + (shown ? ': ' + shown : ''), 90)
}

// Keep the record's task list in step with the session's own task tools
function trackTasks(e, r) {
  if (e.tool === 'TodoWrite' && Array.isArray(e.todos)) {
    me.tasks = e.todos.map((t, i) => ({ id: String(i + 1), subject: oneLine(t.content, 90), status: t.status }))
  } else if (e.tool === 'TaskCreate' && !r?.deny) {
    const id = r?.result?.task?.id ?? /#(\w+)/.exec(r?.text ?? '')?.[1] ?? String(me.tasks.length + 1)
    me.tasks = [...me.tasks, { id: String(id), subject: oneLine(e.subject, 90), status: 'pending' }].slice(-30)
  } else if (e.tool === 'TaskUpdate' && !r?.deny) {
    me.tasks = me.tasks.flatMap((t) => {
      if (t.id !== String(e.taskId)) return [t]
      if (e.status === 'deleted') return []
      return [{ ...t, subject: e.subject ? oneLine(e.subject, 90) : t.subject, status: e.status ?? t.status }]
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
  const home = await $.env.get('HOME')
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
// is still working, its latest text so far.
function finalReply(parts) {
  let lastTool = -1
  parts.forEach((p, i) => {
    if (p.tool) lastTool = i
  })
  const after = parts.slice(lastTool + 1).map((p) => p.text).filter((t) => t?.trim())
  if (after.length > 0) return after.join('\n')
  const texts = parts.map((p) => p.text).filter((t) => t?.trim())
  return texts[texts.length - 1] ?? ''
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
  return out.slice(-EXCHANGES).map((x) => ({ ask: x.ask, reply: finalReply(x.parts) }))
}

// A reply cut to n characters, keeping its start and its end: replies tend to open with what
// was done and close with what's next
function clip(text, n) {
  if (text.length <= n) return text
  const head = Math.floor(n * 0.4)
  return text.slice(0, head) + '\n[…]\n' + text.slice(-(n - head))
}

// What the summary model reads: the board before, the bullets the user removed, and the exchanges.
// working: the assistant is still on the latest request, so its reply is only its text so far.
// jobs: the commands it left running, as labels, or null when that isn't known.
function summaryPrompt(before, removed, exchanges, pendingAsk, working = false, jobs = null) {
  const removedNote = removed.length > 0 ? `\n\nItems the user removed from the board (never list these): ${JSON.stringify(removed)}` : ''
  const turns = exchanges.map((x, i) => {
    const latest = i === exchanges.length - 1 && !pendingAsk
    const reply = clip(x.reply, latest ? LATEST_REPLY_CHARS : OLDER_REPLY_CHARS)
    const label = latest && working ? "Assistant, still working on it (its latest text so far)" : "Assistant's final reply"
    return `User:\n${x.ask.slice(0, ASK_CHARS)}\n\n${label}:\n${reply || '(no reply yet)'}`
  })
  if (pendingAsk) turns.push(`User (latest request, no reply yet):\n${pendingAsk.slice(0, ASK_CHARS)}`)
  const conversation = turns.map((t, i) => `--- Exchange ${i + 1} of ${turns.length}\n${t}`).join('\n\n')
  const running = jobs === null ? ''
    : `\n\n--- Commands this session left running: ${jobs.length > 0 ? jobs.join(', ') : 'none'}`
  return `${conversation}${running}\n\n--- The board before (for wording only; no evidence that an item is still open)\n${before}${removedNote}`
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

// The commands each session still has running, as labels by session id. Claude Code runs a
// command in a shell started from the session's shell snapshot, named by when it was made (the
// session's first command): the session is the live one that started last before that.
const JOBS_CMD = "ps -axo command= | grep '/.claude/shell-snapshots/snapshot-' | grep -v grep"
async function runningJobs($, registry) {
  const jobs = new Map()
  const r = await $.process.run(['sh', '-c', JOBS_CMD], { timeoutMs: 10000 }).catch(() => null)
  const starts = [...registry.values()].filter((x) => x.startedAt).map((x) => ({ id: x.sessionId, startedAt: x.startedAt }))
  for (const line of String(r?.stdout ?? '').split('\n')) {
    const made = /\/\.claude\/shell-snapshots\/snapshot-[a-z]+-(\d{13})-/.exec(line)
    if (!made) continue
    const owner = starts.filter((x) => x.startedAt <= Number(made[1])).sort((a, b) => b.startedAt - a.startedAt)[0]
    if (owner) jobs.set(owner.id, [...(jobs.get(owner.id) ?? []), jobLabel(line)])
  }
  return jobs
}

// One summary call: the active and pending items, rebuilt from the last few exchanges. pendingAsk
// is a request sent since, which has no reply yet.
async function summarizeExchanges($, id, exchanges, pendingAsk, previous, working = false, jobs = null) {
  const removed = await removedFor($, id)
  const isRemoved = (item) => removed.includes(answered(item))
  const before = previous
    ? JSON.stringify({ active: previous.active.filter((x) => !isRemoved(x)), pending: previous.pending.filter((x) => !isRemoved(x)) })
    : 'none'
  const call = $.model.complete({
    // Sonnet 5.5 at low effort: replayed on real moments, it read a long,
    // many-topic chat correctly where Haiku blended two unrelated things into one, answered
    // faster, and used about a tenth of the output tokens Haiku spent thinking
    model: SUMMARY_MODEL,
    effort: SUMMARY_EFFORT,
    maxTokens: 1000,
    system: SUMMARY_SYSTEM,
    prompt: summaryPrompt(before, removed, exchanges, pendingAsk, working, jobs),
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
    (Array.isArray(list) ? list : []).filter((x) => typeof x === 'string' && x.trim()).slice(0, n).map((x) => waitsLast(oneLine(x, 90)))
  const keep = (list) => list.filter((x) => !isRemoved(x))
  // Something waiting on the user isn't work under way: it goes with the pending items
  const active = keep(clean(json.active, 2))
  const side = typeof json.side === 'string' ? oneLine(json.side, 90) : ''
  const paused = side && typeof json.paused === 'string' ? oneLine(json.paused, 90) : ''
  // A side task is the work under way, and the board shows it and the work it paused on their
  // own lines: the lists don't repeat them
  const same = (a, b) => a.replace(WAITS, '').replace(/[^a-z0-9]+/gi, ' ').trim().toLowerCase() === b.replace(/[^a-z0-9]+/gi, ' ').trim().toLowerCase()
  const pending = keep(clean(json.pending, 5)).filter((x) => !paused || !same(x, paused))
  return {
    done: typeof json.done === 'string' ? oneLine(json.done, 90) : '',
    side,
    paused,
    active: side ? [] : active.filter((x) => !x.endsWith(WAITS)),
    pending: [...active.filter((x) => x.endsWith(WAITS)), ...pending].slice(0, 5),
    at: await $.clock.now(),
  }
}

// Ask a small model for the session's active and pending items: when a request is sent, when
// a turn ends, and every BUSY_RESUMMARY_MS through a long turn. Skipped when the session keeps
// its own task list, which is exact.
async function summarize($, { onlyIfNew = false } = {}) {
  if (!me || openTasks(me).length > 0) return
  if (summarizing) {
    summarizeAgain = true
    return
  }
  summarizing = true
  try {
    lastTry = await $.clock.now()
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
    const jobs = [...((await runningJobs($, liveReg)).get(me.id) ?? []), ...backgroundLabels(me.agentsRunning, me.workflowsRunning)]
    me.jobsKey = [...jobs].sort().join(',')
    me.summary = await summarizeExchanges($, me.id, exchanges.slice(-EXCHANGES), pendingAsk, me.summary, me.status !== 'idle', jobs)
    me.summaryReply = latestReply
    delete me.summaryError
    summaryFailures = 0
    await publish($)
  } catch (err) {
    // A failed summary leaves the previous one in place; why it failed, for troubleshooting.
    // Tried once more a little later: after the turn's last summary, nothing else would, and the
    // board would keep showing the work as under way.
    if (me) {
      me.summaryError = oneLine(err?.message ?? err, 200)
      publishSoon($)
    }
    if (++summaryFailures <= SUMMARY_RETRIES) void $.clock.sleep(SUMMARY_RETRY_MS).then(() => summarize($)).catch(() => {})
  } finally {
    summarizing = false
    if (summarizeAgain) {
      summarizeAgain = false
      void summarize($)
    }
  }
}

// Background agents and workflows, as the summary is told: one label each, without the count,
// so twenty agents finishing one by one don't redo the summary twenty times
function backgroundLabels(agents = 0, workflows = 0) {
  return [
    ...(workflows === 1 ? ['a workflow'] : workflows > 1 ? ['workflows'] : []),
    ...(agents === 1 ? ['a background agent'] : agents > 1 ? ['background agents'] : []),
  ]
}

// Where this session's own conversation is saved
async function ownTranscriptPath($) {
  const home = await $.env.get('HOME')
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
  return transcriptPath(home, { cwd: reg?.cwd ?? me.cwd, sessionId: me.id })
}

// This session's own saved conversation, read the way the catch-up pass reads the others'
async function ownTranscript($) {
  try {
    // One more request than the summary reads, so the oldest one it reads is whole
    return await readExchanges($, await ownTranscriptPath($), EXCHANGES + 1)
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
      const r = await $.process.run(['sh', '-c', READ_TITLE, 'sh', await ownTranscriptPath($)], { timeoutMs: 10000 })
      const line = r.exitCode === 0 ? (r.stdout ?? '').trim().split('\n').pop() : ''
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
  const home = await $.env.get('HOME')
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
function exchangesFromTranscript(tail) {
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
  // workflow runs are its own business: the workflow counts once.
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
  const startExchange = (ask) => {
    // The same request recorded twice (queued, then delivered) is one exchange
    if (ask && out[out.length - 1]?.ask !== ask) out.push({ ask, parts: [], lastTool: null })
  }
  for (const d of entries) {
    if (d.isSidechain) continue
    if (d.type === 'ai-title' && typeof d.aiTitle === 'string' && d.aiTitle.trim()) title = d.aiTitle.trim()
    if (d.type === 'custom-title' && typeof d.customTitle === 'string' && d.customTitle.trim()) customTitle = d.customTitle.trim()
    const c = d.message?.content
    if (d.type === 'user' && Array.isArray(c)) {
      for (const b of c) {
        if (b?.type !== 'tool_result' || !launched.has(b.tool_use_id)) continue
        const r = d.toolUseResult
        if (r?.status === 'async_launched' || r?.isAsync === true) running.set(b.tool_use_id, { kind: launched.get(b.tool_use_id), taskId: r?.taskId ?? r?.agentId ?? '' })
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
      startExchange(typedText(text))
    } else if (d.type === 'assistant' && out.length > 0 && Array.isArray(c)) {
      const x = out[out.length - 1]
      for (const b of c) {
        if (b?.type === 'text') x.parts.push({ text: b.text, tool: false })
        if (b?.type === 'tool_use') {
          x.parts.push({ text: '', tool: true })
          x.lastTool = b
          pendingTool = b
          if (b.name === 'AskUserQuestion' || b.name === 'ExitPlanMode') asked.set(b.id, b.name)
          if (b.name === 'Agent' || b.name === 'Task' || b.name === 'Workflow') {
            const kind = b.name === 'Workflow' ? 'workflow' : 'agent'
            launched.set(b.id, kind)
            if (b.input?.run_in_background) running.set(b.id, { kind, taskId: '' })
          }
        }
      }
    }
  }
  const last = out[out.length - 1]
  const step = last?.lastTool ? stepOf({ tool: last.lastTool.name, ...(last.lastTool.input ?? {}) }) : ''
  return { exchanges: out.slice(-EXCHANGES).map((x) => ({ ask: x.ask, reply: finalReply(x.parts) })), step, count: out.length, ended, agents: [...running.values()].filter((r) => r.kind === 'agent').length,
    workflows: [...running.values()].filter((r) => r.kind === 'workflow').length, pendingTool, title: customTitle || title }
}

// A saved conversation's last exchanges, reading back until it has `want` requests (or the
// whole file, or the cap)
async function readExchanges($, path, want) {
  let size = Infinity
  try {
    size = (await $.fs.stat(path)).size
  } catch {
    // Read what tail finds
  }
  for (let bytes = TAIL_START_BYTES; ; bytes = Math.min(bytes * 4, TAIL_MAX_BYTES)) {
    const r = await $.process.run(['sh', '-c', READ_TAIL, 'sh', String(bytes), path], { timeoutMs: 20000 })
    const out = r.exitCode === 0 ? r.stdout ?? '' : ''
    const parsed = exchangesFromTranscript(out)
    // Reading further back can't help once the output is full
    const full = out.length >= READ_OUT_BYTES - 1000
    if (parsed.count >= want || full || bytes >= size || bytes >= TAIL_MAX_BYTES) return parsed
  }
}

// This session's own commands: when one ends (or starts) while it's idle, its board is out of
// date, since no turn will come to summarize it again. Every session checks its own.
// The same goes for a turn whose last summary never happened: the mod reloaded as the turn
// ended (the new copy starts idle and gets no turn.complete), or the call failed for good.
async function checkOwnJobs($) {
  if (!me || me.status !== 'idle' || summarizing) return
  const registry = new Map()
  const home = await $.env.get('HOME')
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
  if (missed) {
    healedReply = latest
    return summarize($)
  }
  if (!me.summary) return
  const mine = [...((await runningJobs($, registry)).get(me.id) ?? []), ...backgroundLabels(own.agents, own.workflows)].sort().join(',')
  if (me.jobsKey === undefined || me.jobsKey !== mine) await summarize($)
  else if ((own.agents ?? 0) !== (me.agentsRunning ?? 0) || (own.workflows ?? 0) !== (me.workflowsRunning ?? 0)) {
    me.agentsRunning = own.agents ?? 0
    me.workflowsRunning = own.workflows ?? 0
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

async function catchUp($) {
  if (!me) return
  const now = await $.clock.now()
  const lease = await $.store.get(CATCHUP_LEASE)
  if (lease && lease.id !== me.id && lease.until > now && (lease.v ?? 0) >= LEASE_VERSION) return
  await $.store.set(CATCHUP_LEASE, { id: me.id, until: now + 3 * CATCHUP_MS, v: LEASE_VERSION })
  await runReplays($).catch(() => {})
  await syncRegistry($)
  const home = await $.env.get('HOME')
  const summaries = await summariesOn($)
  const jobs = await runningJobs($, liveReg)
  for (const [id, reg] of liveReg) {
    if (id === me.id || !reg.cwd) continue
    const rec = await $.store.get(PREFIX + id)
    if (rec && !rec.shadow) continue
    const sessionJobs = [...(jobs.get(id) ?? [])]
    const jobsKey = [...sessionJobs].sort().join(',')
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
    const { exchanges: recent, step, ended, agents, workflows, pendingTool, title } = await readExchanges($, path, 1)
    const latest = recent[recent.length - 1]
    // Working: "busy" or "shell" while the turn goes on. The registry keeps saying so after
    // the turn has ended while a command or a background agent it started still runs: the
    // conversation's end of turn decides. "waiting" is waiting on the user.
    const busy = !ended && (reg.status === 'busy' || reg.status === 'shell')
    const next = { tasks: [], ...(rec ?? {}), id, cwd: reg.cwd, shadow: true, step: busy ? step : '', turnEnded: ended, agentsRunning: agents, workflowsRunning: workflows, title: title || rec?.title || '', ask: reg.status === 'waiting' && pendingTool ? askFor(pendingTool.name, pendingTool.input) : '', updatedAt: now }
    // Background agents count as jobs too, for the summary and for noticing when they finish
    sessionJobs.push(...backgroundLabels(agents, workflows))
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
  const app = (await $.env.get('HOME')) + '/Applications/' + APP_NAME
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

// Start the window app, building it first if needed, or show its window again if it is
// running but hidden. `open` keeps it to one instance; -g leaves the focus where it is.
async function openBoard($) {
  building ??= buildApp($).finally(() => {
    building = null
  })
  const app = await building
  await $.process.run(['open', '-g', app], { timeoutMs: 10000 })
}

// A build that failed says why under the prompt (in the terminal; Desktop draws no mod notices)
function reportFailure($, err) {
  if (err?.message === 'building') return
  try {
    $.ui.toast('Session Board: ' + oneLine(err?.message ?? err, 160), { timeoutMs: 12000 })
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
      // They've just answered: nothing is waiting on them until the next summary says so
      if (me.summary) me.summary = { ...me.summary, pending: me.summary.pending.map(answered) }
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

  // A permission prompt is on screen: the session waits on you until the call goes on.
  // (tool.check's "ask" is no sign of that: in Auto mode the classifier settles it.)
  on('classic.PermissionRequest', async ($, e, next) => {
    if (me) {
      me.status = 'needs-you'
      me.ask = askFor(e.tool_name, e.tool_input)
      publishSoon($)
    }
    return next(e)
  })

  on('classic.Notification', async ($, e, next) => {
    if (me && e.notification_type === 'permission_prompt') {
      me.status = 'needs-you'
      if (!me.ask) me.ask = 'A permission prompt is open'
      publishSoon($)
    }
    return next(e)
  })
}

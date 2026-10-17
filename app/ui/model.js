// Session Board's rules, as plain functions the page and the tests share: how the mod's records
// and Claude Code's registry become the rows on the board, in what order, with which lines.
// Ported from the macOS app (board/main.swift); docs/PORT-INVENTORY.md lists each rule with the
// Swift line it came from. Timestamps in the files are milliseconds; `since` and ago() are seconds.

export const STATUS_RANK = { 'needs-you': 0, working: 1, idle: 2 }
// A session idle longer than this leaves the board (it stays in Dismissed if you dismissed it)
export const QUIET_SECONDS = 12 * 3600
// A record of a session that's no longer live is dropped, when the registry can't be read, this late
const STALE_SECONDS = 600
const WAITS = /\s*[·•-]?\s*\(?waits on you\)?\s*[:–-]?\s*/i

const baseName = (p) => String(p ?? '').split(/[\\/]/).filter(Boolean).pop() ?? ''
const strings = (xs) => (Array.isArray(xs) ? xs : []).filter((x) => typeof x === 'string' && x.trim())

// "now", "5m", "3h", "2d"
export function ago(s) {
  const m = Math.floor(s / 60)
  if (m < 1) return 'now'
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  return h < 48 ? `${h}h` : `${Math.floor(h / 24)}d`
}

// The rows, from what the window read: store records joined with the live-session registry.
// `projects` maps a folder to its project name (the Git repo it belongs to), from the window side.
export function buildRows({ store = {}, registry = {}, registryReadable = true, projects = {}, now = Date.now() }) {
  const live = new Map()
  for (const entry of Object.values(registry)) if (entry?.sessionId) live.set(entry.sessionId, entry)

  const records = new Map()
  const titles = new Map()
  for (const file of Object.values(store)) {
    for (const [key, rec] of Object.entries(file ?? {})) {
      if (!key.startsWith('s:') || !rec?.id) continue
      if (typeof rec.title === 'string' && rec.title.trim()) titles.set(rec.id, rec.title)
      const stale = registryReadable ? !live.has(rec.id) : now / 1000 - (rec.updatedAt ?? 0) / 1000 > STALE_SECONDS
      if (stale) continue
      const had = records.get(rec.id)
      // A session's own record beats a catch-up copy; otherwise the newer one
      if (!had || (had.shadow && !rec.shadow) || (!!had.shadow === !!rec.shadow && (rec.updatedAt ?? 0) > (had.updatedAt ?? 0))) {
        records.set(rec.id, rec)
      }
    }
  }

  const ids = new Set([...live.keys(), ...records.keys()])
  const rows = []
  for (const id of ids) {
    const reg = live.get(id) ?? {}
    const rec = records.get(id)
    const own = !!rec && !rec.shadow
    const regRaw = reg.status ?? 'idle'
    const turnEnded = rec?.turnEnded === true && (reg.statusUpdatedAt ?? 0) <= (rec.updatedAt ?? 0)
    const mapped = regRaw === 'waiting' ? 'needs-you' : regRaw === 'idle' || turnEnded ? 'idle' : 'working'
    const status = own ? (rec.status ?? mapped) : mapped
    let changedMs = (own ? (rec.statusSince ?? rec.updatedAt) : (reg.statusUpdatedAt ?? reg.updatedAt)) ?? rec?.updatedAt ?? 0
    // Idle since its last message, at the latest: reopening an old chat in Claude Desktop starts a
    // new process, and that alone isn't activity
    if (status === 'idle' && rec?.lastMessageAt > 0) changedMs = changedMs ? Math.min(changedMs, rec.lastMessageAt) : rec.lastMessageAt
    const since = changedMs ? Math.max(0, (now - changedMs) / 1000) : 0
    const cwd = rec?.cwd ?? reg.cwd ?? ''
    const project = projects[reg.cwd ?? cwd] ?? baseName(reg.cwd ?? cwd)
    const name = (reg.nameSource === 'derived' && titles.get(id)) || reg.name || baseName(cwd) || '?'

    let items = []
    let fromTaskList = false
    if (rec) {
      const tasks = (Array.isArray(rec.tasks) ? rec.tasks : []).filter((t) => t?.status === 'pending' || t?.status === 'in_progress')
      if (tasks.length) {
        items = tasks.map((t) => ({ text: String(t.subject ?? ''), active: t.status === 'in_progress', waitsOnYou: false }))
        fromTaskList = true
      } else {
        const active = strings(rec.summary?.active)
        const pending = strings(rec.summary?.pending)
        const endsWaiting = (x) => / · waits on you$/.test(x)
        items = [
          ...active.filter((x) => !endsWaiting(x)).map((text) => ({ text, active: true, waitsOnYou: false })),
          ...[...active.filter(endsWaiting), ...pending].map((x) => {
            // A working session isn't waiting on you, whatever the summary says
            const waits = /waits on you/i.test(x) && status === 'idle'
            return { text: x.replace(WAITS, ' ').trim(), active: false, waitsOnYou: waits }
          }),
        ]
      }
    }
    rows.push({
      id,
      status,
      since,
      cwd,
      place: baseName(cwd),
      project,
      name,
      pid: reg.pid,
      isRemote: !!reg.bridgeSessionId,
      bridgeId: reg.bridgeSessionId ?? '',
      isDesktop: reg.entrypoint === 'claude-desktop',
      hasMod: !!rec,
      items,
      fromTaskList,
      justDid: rec?.summary?.done ?? '',
      side: rec?.summary?.side ?? '',
      paused: rec?.summary?.paused ?? '',
      // The task the session is on, in a line anyone could follow (the summary's)
      task: rec?.summary?.task ?? '',
      request: rec?.request ?? '',
      ask: status === 'needs-you' ? (rec?.ask ?? '') : '',
      agentsRunning: rec?.agentsRunning ?? 0,
      // The descriptions Claude gave the commands it still runs, by command key (from the mod)
      runningLabels: rec?.runningLabels ?? {},
      // Names Claude Desktop may still show for it after a rename: its former names (the
      // registry's) and its name without the project in front. Desktop keeps the name it first had.
      otherNames: otherNames(name, project, (Array.isArray(reg.formerNames) ? reg.formerNames : []).map((f) => f?.name)),
      workflowsRunning: rec?.workflowsRunning ?? 0,
      startedAt: reg.startedAt ?? 0,
    })
  }
  // Needs you, then working, then idle; in each, the one that entered it most recently first
  rows.sort((a, b) => (STATUS_RANK[a.status] ?? 3) - (STATUS_RANK[b.status] ?? 3) || a.since - b.since)
  return rows
}

// Quiet: idle for 12 hours, and not the session you're viewing: off the board
export const isQuiet = (row, { focusedId = null } = {}) => row.status === 'idle' && row.since > QUIET_SECONDS && row.id !== focusedId

// What the board shows, what's in Dismissed, and the counts (over what it shows)
export function partition(rows, dismissed = [], seen = {}) {
  const gone = new Set(dismissed)
  const shown = rows.filter((r) => !isQuiet(r, seen) && !gone.has(r.id))
  const hidden = rows.filter((r) => gone.has(r.id))
  const count = (s) => shown.filter((r) => r.status === s).length
  return { shown, hidden, needsYou: count('needs-you'), working: count('working'), idle: count('idle') }
}

// A dismissed session comes back once it needs you again after you dismissed it
export function autoRestore(rows, dismissed, dismissedAt, now = Date.now()) {
  return dismissed.filter((id) => {
    const row = rows.find((r) => r.id === id)
    return !(row && row.status === 'needs-you' && now / 1000 - row.since > (dismissedAt[id] ?? Infinity))
  })
}

const normal = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '')

// The name as the board shows it: its project first, unless the name already starts with it
export function shownName(row, projectNames = true) {
  if (!projectNames || !row.project) return row.name
  return normal(row.name).startsWith(normal(row.project)) ? row.name : `${row.project} · ${row.name}`
}

// The grey part at the start of each shown name: words another session's name also starts with
// (longest first), else the project prefix. Returns { id: prefix }.
export function sharedPrefixes(shown, projectNames = true) {
  const names = new Map(shown.map((r) => [r.id, shownName(r, projectNames)]))
  const out = {}
  for (const [id, name] of names) {
    const words = name.split(' ')
    for (let n = words.length - 1; n >= 1; n--) {
      const prefix = words.slice(0, n).join(' ') + ' '
      if ([...names].some(([other, o]) => other !== id && o.startsWith(prefix))) {
        out[id] = prefix
        break
      }
    }
    const project = shown.find((r) => r.id === id)?.project
    if (!out[id] && project && name.startsWith(project + ' · ')) out[id] = project + ' · '
  }
  return out
}

// What a session still runs, each by the description Claude gave it (else what its command line
// suggests), the longest-running first, then workflows and background agents
export function runningItems(row, jobs = []) {
  const labels = row.runningLabels ?? {}
  const items = [...new Set([...jobs].sort((a, b) => b.minutes - a.minutes).map((j) => labels[j.key] ?? j.label))]
  if (row.workflowsRunning) items.push(row.workflowsRunning === 1 ? 'a workflow' : `${row.workflowsRunning} workflows`)
  if (row.agentsRunning) items.push(row.agentsRunning === 1 ? 'a background agent' : `${row.agentsRunning} background agents`)
  return items
}

// One line however many run: "Still running: run the browser suite · 6m", or with more
// "Still running: run the browser suite, +2 more · 6m" (its tooltip lists them all)
export function stillRunning(row, jobs = []) {
  const items = runningItems(row, jobs)
  if (!items.length) return ''
  const minutes = jobs.length ? Math.max(...jobs.map((j) => j.minutes)) : null
  return 'Still running: ' + items[0] + (items.length > 1 ? `, +${items.length - 1} more` : '') + (minutes !== null ? ' · ' + ago(minutes * 60) : '')
}

// A card's lines, top to bottom, as the macOS app draws them. `removed` is the bullets you took off.
export function cardLines(row, { jobs = [], removed = [], summaries = true } = {}) {
  const gone = new Set(removed)
  const visible = row.items.filter((i) => !gone.has(i.text))
  const working = row.status === 'working'
  const lines = []
  if (row.task) lines.push({ kind: 'task', glyph: '◎', text: row.task })
  if (row.ask) lines.push({ kind: 'ask', glyph: '?', text: row.ask })
  if (row.side) lines.push({ kind: 'side', glyph: '↪', text: row.side })
  if (row.side && row.paused) lines.push({ kind: 'paused', glyph: '⏸', text: 'Paused: ' + row.paused })
  if (working) for (const i of visible.filter((i) => i.active)) lines.push({ kind: 'doing', glyph: '▶', text: i.text, removable: true })
  const running = !working ? stillRunning(row, jobs) : ''
  if (running) lines.push({ kind: 'running', glyph: '◷', text: running, all: runningItems(row, jobs) })
  if (row.justDid) lines.push({ kind: 'done', glyph: '✓', text: row.justDid })
  const rest = working ? visible.filter((i) => !i.active) : [...visible.filter((i) => i.active), ...visible.filter((i) => !i.active)]
  for (const i of rest) lines.push({ kind: i.waitsOnYou ? 'waits' : 'next', glyph: i.waitsOnYou ? '!' : '·', text: i.text, removable: true })
  if (!row.items.length && !row.justDid && !row.ask && row.request) lines.push({ kind: 'request', text: `You asked: “${row.request}”` })
  if (!row.hasMod) lines.push({ kind: 'caption', text: 'No task data yet' })
  else if (row.fromTaskList) lines.push({ kind: 'caption', text: "From the session's own task list" })
  else if (!summaries && !row.items.length) lines.push({ kind: 'caption', text: 'Summaries are off · no task list in this session' })
  return lines
}

// A session as plain text, for "Copy session"
export function sessionText(row, { jobs = [], removed = [], projectNames = true } = {}) {
  const label = { 'needs-you': 'needs you', working: 'working', idle: 'idle' }[row.status] ?? row.status
  const out = [`${shownName(row, projectNames)} (${label} ${ago(row.since)} · ${row.place})`]
  for (const l of cardLines(row, { jobs, removed })) {
    if (l.kind === 'caption') continue
    if (l.kind === 'task') out.push('◎ task: ' + l.text)
    else if (l.kind === 'side') out.push('↪ side task: ' + l.text)
    else if (l.kind === 'paused') out.push('⏸ paused: ' + l.text.replace(/^Paused: /, ''))
    else if (l.kind === 'doing') out.push('▸ ' + l.text)
    else if (l.kind === 'waits') out.push('! ' + l.text + ' · waits on you')
    else if (l.kind === 'request') out.push('you asked: ' + row.request)
    else if (l.kind === 'running') out.push('◷ still running: ' + l.all.join('; '))
    else out.push(`${l.glyph} ${l.text}`)
  }
  return out.join('\n')
}

// ---- Colours: a number tile per session, in a colour of its own

export const SWATCHES = {
  Blue: ['#4B92FF', '#2F6FD6'], Purple: ['#9B7CFF', '#6D4FD8'], Teal: ['#2EC4B6', '#0F8B80'], Pink: ['#F472B6', '#C23D86'],
  Red: ['#F0605A', '#C73A35'], Orange: ['#F28C3B', '#C05A10'], Green: ['#5CCB6A', '#2F8F3E'], Sky: ['#38BDF8', '#0B7FB5'],
  Indigo: ['#7C83FF', '#4A52D6'], Gold: ['#F5C542', '#A67C00'], Rose: ['#FB7185', '#C8364E'], Coral: ['#FF8A65', '#C4512A'],
  Mint: ['#5EE6B0', '#138A60'], Lime: ['#A3E635', '#5C8A08'], Cyan: ['#22D3EE', '#0A8AA3'], Lavender: ['#B9A6FF', '#7A5FD8'],
  Magenta: ['#E05BE0', '#A8329F'], Plum: ['#B57BD9', '#844CA8'], Crimson: ['#E5484D', '#B0232A'], Peach: ['#FFB385', '#B8642F'],
  Sand: ['#D9B98C', '#8F6C3A'], Olive: ['#B5BD5A', '#6E751B'], Forest: ['#3FA36B', '#1E7447'], Ocean: ['#3B82C4', '#1F5C96'],
  Steel: ['#8CA3BF', '#52698A'], Slate: ['#94A3B8', '#56657A'], Graphite: ['#A1A1AA', '#5F5F68'], Brown: ['#C08A5B', '#875730'],
  Turquoise: ['#40E0D0', '#0D8F84'], Fuchsia: ['#D946EF', '#A01DAD'],
}
// The colours handed out on their own: never ones that read as a state (amber, green, grey)
export const AUTO_ORDER = ['Blue', 'Pink', 'Teal', 'Magenta', 'Sky', 'Rose', 'Cyan', 'Plum', 'Ocean', 'Fuchsia', 'Turquoise', 'Coral']
const POPULAR = 6
const DISTINCT_SHARE = 0.9

function oklab(hex) {
  const lin = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
  const [r, g, b] = [1, 3, 5].map((i) => lin(parseInt(hex.slice(i, i + 2), 16) / 255))
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b)
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b)
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)
  return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s]
}
const distance = (a, b) => Math.hypot(...oklab(SWATCHES[a][0]).map((v, i) => v - oklab(SWATCHES[b][0])[i]))

// Gives each row without one an automatic colour, as far as it can from the colours in use.
// Returns the new autoColors map (sticky: a colour stays with its session).
export function assignColors(rows, sessionColors = {}, autoColors = {}, random = Math.random) {
  const auto = { ...autoColors }
  for (const row of rows) {
    if (auto[row.id]) continue
    const inUse = rows.filter((r) => r.id !== row.id).map((r) => sessionColors[r.id] ?? auto[r.id]).filter(Boolean)
    const free = AUTO_ORDER.filter((c) => !inUse.includes(c))
    let pick
    if (free.length) {
      const apart = (c) => (inUse.length ? Math.min(...inUse.map((u) => distance(c, u))) : 1)
      const best = Math.max(...free.map(apart))
      const candidates = free.filter((c) => apart(c) >= DISTINCT_SHARE * best)
      const popular = candidates.filter((c) => AUTO_ORDER.indexOf(c) < POPULAR)
      const pool = popular.length ? popular : candidates
      pick = pool[Math.floor(random() * pool.length)]
    } else {
      const uses = (c) => inUse.filter((u) => u === c).length
      const least = Math.min(...AUTO_ORDER.map(uses))
      const pool = AUTO_ORDER.filter((c) => uses(c) === least)
      pick = pool[Math.floor(random() * pool.length)]
    }
    auto[row.id] = pick
  }
  return auto
}

// Near-black or white ink, whichever reads better on a fill
export function inkFor(hex) {
  const lin = (c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
  const [r, g, b] = [1, 3, 5].map((i) => lin(parseInt(hex.slice(i, i + 2), 16) / 255))
  const L = 0.2126 * r + 0.7152 * g + 0.0722 * b
  return (L + 0.05) / 0.0545 >= 1.05 / (L + 0.05) ? '#0B0B0C' : '#FFFFFF'
}

// ---- When a session wants you: popups and sounds (the macOS app's considerSounds)

export const NEEDS_YOU = 0
export const YOUR_TURN = 1
export const DONE = 2
const SETTLE_READS = 2
const YOUR_TURN_WINDOW_MS = 90_000
const DONE_DELAY_MS = 15_000
export const SOUND_GAP_MS = 8000

// Fed every read, it says which sessions just started needing you, ended a turn with something
// for you, or finished. A status counts once two reads in a row agree, and the first one seen
// for a session says nothing (the board just started, or the session just appeared).
export class Attention {
  constructor() {
    this.reads = new Map() // id -> { status, count }
    this.settled = new Map() // id -> status
    this.ended = new Map() // id -> when its turn ended (ms)
  }

  step(rows, { focusedId = null, now = Date.now(), jobs = {} } = {}) {
    const events = []
    for (const row of rows) {
      const read = this.reads.get(row.id)
      const count = read?.status === row.status ? read.count + 1 : 1
      this.reads.set(row.id, { status: row.status, count })
      const before = this.settled.get(row.id)
      if (count >= SETTLE_READS && before !== row.status) {
        this.settled.set(row.id, row.status)
        if (before !== undefined) {
          if (row.status === 'needs-you' && row.id !== focusedId) events.push({ kind: NEEDS_YOU, row })
          if (before === 'working' && row.status === 'idle') this.ended.set(row.id, now)
        }
        if (row.status !== 'idle') this.ended.delete(row.id)
      }
      const ended = this.ended.get(row.id)
      if (ended === undefined || this.settled.get(row.id) !== 'idle') continue
      const waits = row.items.some((i) => i.waitsOnYou)
      const running = (jobs[row.id] ?? []).length || row.agentsRunning || row.workflowsRunning
      let kind = null
      if (waits && now - ended < YOUR_TURN_WINDOW_MS) kind = YOUR_TURN
      else if (!waits && !running && now - ended >= DONE_DELAY_MS) kind = DONE
      if (kind === null) continue
      this.ended.delete(row.id)
      if (row.id !== focusedId) events.push({ kind, row })
    }
    return events
  }
}

// The sound to play for this read's events, if any: the most urgent switched-on moment, at most
// one every SOUND_GAP_MS
export function soundFor(events, { soundsOn = true, moments = [true, true, false], lastSoundAt = 0, now = Date.now() } = {}) {
  if (!soundsOn || now - lastSoundAt < SOUND_GAP_MS) return null
  const kinds = events.map((e) => e.kind).filter((k) => moments[k]).sort()
  return kinds.length ? kinds[0] : null
}

// What a popup says under its number: why it wants you
export function popupDetail(kind, row) {
  if (kind === NEEDS_YOU) return row.ask || 'Needs you'
  if (kind === YOUR_TURN) return row.items.find((i) => i.waitsOnYou)?.text ?? 'Your turn'
  return row.justDid || 'Done'
}

// ---- Which card is the session you're looking at

// Two session names are the same one: case, spacing and curly or straight quotes aside
export function sameName(a, b) {
  const plain = (s) => String(s ?? '').replace(/[‘’]/g, "'").replace(/[“”]/g, '"').toLowerCase().split(/\s+/).filter(Boolean).join(' ')
  return plain(a) === plain(b)
}

// A session's other names (row.otherNames): its former names, and its name without the project the
// rename put in front ("OTC · Fix the login" is also "Fix the login")
export function otherNames(name, project, former) {
  const names = former.filter((n) => typeof n === 'string')
  const lead = project + ' · '
  if (project && name.startsWith(lead)) names.push(name.slice(lead.length))
  return names.filter((n) => n && !sameName(n, name))
}

// From what the window side says is in front, the session you're looking at: the one Claude Desktop
// shows (by name; of two the same, the one active most recently), or the one under the terminal in
// front (by pid; of several, the one the window title names). `undefined` keeps the current one.
// misses: reads in a row before this one that found no session open in Desktop
export function focusedFrom(front, rows, current, misses = 0) {
  if (!front) return undefined
  if ('desktopName' in front) {
    // Its current name first; failing that, a name it had before a rename, which Desktop goes on showing
    const byName = (match) => rows.filter(match).sort((a, b) => a.since - b.since)
    const find = (name) => {
      const hits = byName((r) => sameName(r.name, name))
      if (!hits.length) hits.push(...byName((r) => (r.otherNames ?? []).some((n) => sameName(n, name))))
      return hits[0]?.id
    }
    // The session page's name, or else any title the window shows (a window laid out another way)
    for (const name of [front.desktopName, ...(front.desktopPages ?? [])]) {
      const id = name ? find(name) : undefined
      if (id) return id
    }
    // The chat open in Desktop isn't on the board, or can't be read for a second (three reads in a
    // row): highlight nothing rather than the wrong one
    return front.desktopName != null || misses >= 3 ? null : undefined
  }
  const hits = rows.filter((r) => r.pid && (front.pids ?? []).includes(r.pid))
  if (hits.length === 1) return hits[0].id
  if (hits.length > 1) {
    const title = String(front.title ?? '').toLowerCase()
    const named = hits.filter((r) => r.name && title.includes(r.name.toLowerCase()))
    if (named.length === 1) return named[0].id
    if (hits.some((r) => r.id === current)) return current
  }
  return undefined
}

// ---- Crash reports, as the crash prompt sends them: the exception and the top of the crashed
// thread, never anything from the sessions

export function parseCrash(kind, text, { at = Date.now(), version = '', os = '' } = {}) {
  const when = new Date(at).toISOString()
  const footer = `\n- Session Board: ${version}\n- OS: ${os}`
  if (kind === 'panic') {
    const lines = String(text).split('\n')
    const first = lines.find((l) => l.trim()) ?? 'panic'
    return {
      at,
      title: 'Window app crashed: ' + first.replace(/^panicked at /, '').slice(0, 80),
      details: `### The window app crashed\n\nA panic at ${when}\n\n\`\`\`\n${lines.slice(0, 60).join('\n')}\n\`\`\`\n${footer}`,
    }
  }
  // An .ips file is a line of JSON (the header) and then the report as JSON
  const nl = String(text).indexOf('\n')
  let body
  try {
    body = JSON.parse(String(text).slice(nl + 1))
  } catch {
    return null
  }
  const type = body.exception?.type ?? 'crash'
  const signal = body.exception?.signal ?? ''
  const images = body.usedImages ?? []
  const thread = (body.threads ?? []).find((t) => t.triggered) ?? {}
  const frames = (thread.frames ?? []).slice(0, 10).map((f) => `    ${images[f.imageIndex]?.name ?? '?'} ${f.symbol ?? '?'}${f.sourceLine ? ` (${f.sourceFile ?? '?'}:${f.sourceLine})` : ''}`)
  const messages = Object.values(body.asi ?? {}).flat().filter((m) => typeof m === 'string')
  return {
    at,
    title: `Window app crashed: ${type}`,
    details: `### The window app crashed\n\n${type} ${signal} at ${when}\n${messages.length ? '\n' + messages.join('\n') + '\n' : ''}\n\`\`\`\n${frames.join('\n')}\n\`\`\`\n${footer}`,
  }
}

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
    const changedMs = (own ? (rec.statusSince ?? rec.updatedAt) : (reg.statusUpdatedAt ?? reg.updatedAt)) ?? rec?.updatedAt ?? 0
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
      request: rec?.request ?? '',
      ask: status === 'needs-you' ? (rec?.ask ?? '') : '',
      agentsRunning: rec?.agentsRunning ?? 0,
      workflowsRunning: rec?.workflowsRunning ?? 0,
      startedAt: reg.startedAt ?? 0,
    })
  }
  // Needs you, then working, then idle; in each, the one that entered it most recently first
  rows.sort((a, b) => (STATUS_RANK[a.status] ?? 3) - (STATUS_RANK[b.status] ?? 3) || a.since - b.since)
  return rows
}

export const isQuiet = (row) => row.status === 'idle' && row.since > QUIET_SECONDS

// What the board shows, what's in Dismissed, and the counts (over what it shows)
export function partition(rows, dismissed = []) {
  const gone = new Set(dismissed)
  const shown = rows.filter((r) => !isQuiet(r) && !gone.has(r.id))
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

// "Browser tests still running · 6m"
export function stillRunning(row, jobs = []) {
  const parts = [...new Set(jobs.map((j) => j.label))]
  if (row.workflowsRunning) parts.push(row.workflowsRunning === 1 ? 'a workflow' : `${row.workflowsRunning} workflows`)
  if (row.agentsRunning) parts.push(row.agentsRunning === 1 ? 'a background agent' : `${row.agentsRunning} background agents`)
  if (!parts.length) return ''
  const text = parts.join(', ')
  const minutes = jobs.length ? Math.max(...jobs.map((j) => j.minutes)) : null
  return text[0].toUpperCase() + text.slice(1) + ' still running' + (minutes !== null ? ' · ' + ago(minutes * 60) : '')
}

// A card's lines, top to bottom, as the macOS app draws them. `removed` is the bullets you took off.
export function cardLines(row, { jobs = [], removed = [], summaries = true } = {}) {
  const gone = new Set(removed)
  const visible = row.items.filter((i) => !gone.has(i.text))
  const working = row.status === 'working'
  const lines = []
  if (row.ask) lines.push({ kind: 'ask', glyph: '?', text: row.ask })
  if (row.side) lines.push({ kind: 'side', glyph: '↪', text: row.side })
  if (row.side && row.paused) lines.push({ kind: 'paused', glyph: '⏸', text: 'Paused: ' + row.paused })
  if (working) for (const i of visible.filter((i) => i.active)) lines.push({ kind: 'doing', glyph: '▶', text: i.text, removable: true })
  const running = !working ? stillRunning(row, jobs) : ''
  if (running) lines.push({ kind: 'running', glyph: '◷', text: running })
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
    if (l.kind === 'side') out.push('↪ side task: ' + l.text)
    else if (l.kind === 'paused') out.push('⏸ paused: ' + l.text.replace(/^Paused: /, ''))
    else if (l.kind === 'doing') out.push('▸ ' + l.text)
    else if (l.kind === 'waits') out.push('! ' + l.text + ' · waits on you')
    else if (l.kind === 'request') out.push('you asked: ' + row.request)
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

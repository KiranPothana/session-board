// The board page: reads what the window side hands it every 2 seconds, builds the rows with
// model.js and draws them. In a plain browser (no Tauri) it draws sample sessions instead, which is
// how its layout is checked with screenshots.
import { buildRows, partition, autoRestore, shownName, sharedPrefixes, cardLines, sessionText, assignColors, inkFor, ago, SWATCHES } from './model.js'
import { sampleState } from './sample.js'

const tauri = window.__TAURI__
const invoke = (cmd, args) => (tauri ? tauri.core.invoke(cmd, args) : Promise.resolve(null))
const VERSION = '0.2.0'
const REPO = 'https://github.com/KiranPothana/session-board'
const DEFAULT_SHORTCUT = 'Ctrl+Alt+S'
const UNDO_MS = 6000

// ---- What the window keeps between launches (the macOS app's UserDefaults)
const PREFS_KEY = 'session-board-prefs'
const prefs = Object.assign(
  { collapsed: false, dismissed: [], dismissedAt: {}, sessionColors: {}, autoColors: {}, theme: null, regularWindow: false, hideWhenAway: true, terminalsCount: true, soundsOn: true, removedItems: {}, handledShowRequest: 0, shortcut: DEFAULT_SHORTCUT, userHidden: false },
  (() => { try { return JSON.parse(localStorage.getItem(PREFS_KEY)) ?? {} } catch { return {} } })(),
)
const savePrefs = () => { try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)) } catch {} }

// ---- What the page is showing
const ui = { settings: false, showDismissed: false, openRemoved: new Set(), dismissAsk: null, undo: null, focusedId: null }
let state = { rows: [], shared: { summaries: true, projectNames: true, renameSessions: false }, platform: 'browser' }

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
const params = new URLSearchParams(location.search)

async function read() {
  const snap = tauri ? await invoke('read_state') : sampleState(Date.now(), params)
  const rows = buildRows({ store: snap.store, registry: snap.registry, registryReadable: snap.registryReadable !== false, projects: snap.projects ?? {}, now: snap.now })
  state = { rows, shared: { summaries: true, projectNames: true, renameSessions: false, ...snap.settings }, platform: snap.platform, jobs: snap.jobs ?? {} }
  prefs.dismissed = autoRestore(rows, prefs.dismissed, prefs.dismissedAt, snap.now)
  // Forget sessions that are gone, but never on an empty read
  if (rows.length) {
    const ids = new Set(rows.map((r) => r.id))
    prefs.dismissed = prefs.dismissed.filter((id) => ids.has(id))
    for (const map of [prefs.removedItems, prefs.sessionColors, prefs.autoColors]) for (const id of Object.keys(map)) if (!ids.has(id)) delete map[id]
  }
  prefs.autoColors = assignColors(rows, prefs.sessionColors, prefs.autoColors, tauri ? Math.random : () => 0)
  if (snap.showRequest && snap.showRequest > prefs.handledShowRequest) {
    prefs.handledShowRequest = snap.showRequest
    prefs.userHidden = false
    invoke('show_board')
  }
  savePrefs()
  if (params.has('viewing')) ui.focusedId = partition(rows, prefs.dismissed).shown[Number(params.get('viewing')) - 1]?.id ?? null
  render()
}

// ---- Theme: your pick, else the system's
function applyTheme() {
  const dark = prefs.theme ? prefs.theme === 'dark' : params.get('theme') ? params.get('theme') === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches
  document.documentElement.dataset.theme = dark ? 'dark' : 'light'
  return dark
}
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => render())

function colourOf(id, dark) {
  const name = prefs.sessionColors[id] ?? prefs.autoColors[id]
  return name ? SWATCHES[name][dark ? 0 : 1] : null
}

function tileStyle(row, dark) {
  const fill = colourOf(row.id, dark)
  if (fill) return `background:${fill};color:${inkFor(fill)}`
  const by = { 'needs-you': ['--amber', '--amber-ink'], working: ['--green', '--green-ink'], idle: ['--idle', '--idle-ink'] }[row.status] ?? ['--idle', '--idle-ink']
  return `background:var(${by[0]});color:var(${by[1]})`
}

const STATUS_LABEL = { 'needs-you': 'NEEDS YOU', working: 'WORKING', idle: 'IDLE' }
const statusLabel = (row) => `<span class="status ${row.status}">${STATUS_LABEL[row.status] ?? ''} · ${ago(row.since)}</span>`

function twoTone(row, prefix) {
  const name = shownName(row, state.shared.projectNames)
  return prefix && name.startsWith(prefix) ? `<span class="pre">${esc(prefix)}</span>${esc(name.slice(prefix.length))}` : esc(name)
}

function card(row, n, prefix, dark) {
  const removed = prefs.removedItems[row.id] ?? []
  const lines = cardLines(row, { jobs: state.jobs[row.id] ?? [], removed, summaries: state.shared.summaries })
  const ring = colourOf(row.id, dark) ?? 'var(--blue)'
  const viewing = row.id === ui.focusedId
  const chip = row.isDesktop ? 'DESKTOP' : row.isRemote ? 'RC' : 'CLI'
  const body = lines.map((l, i) => {
    if (l.kind === 'request') return `<div class="request">${esc(l.text)}</div>`
    if (l.kind === 'caption') return `<div class="caption">${esc(l.text)}</div>`
    const rm = l.removable ? `<button class="rm" data-action="remove-line" data-id="${esc(row.id)}" data-text="${esc(l.text)}" title="Remove this line; the summary won't add it back">✕</button>` : ''
    return `<div class="line ${l.kind}" data-copy="${esc(l.text)}"><span class="g">${l.kind === 'doing' ? '▶' : esc(l.glyph ?? '')}</span><span class="t">${esc(l.text)}</span>${rm}</div>`
  }).join('')
  const open = ui.openRemoved.has(row.id)
  const removedBlock = removed.length
    ? `<button class="removed-toggle" data-action="toggle-removed" data-id="${esc(row.id)}">${open ? '⌄' : '›'} ${removed.length} removed</button>` +
      (open ? removed.map((t) => `<div class="removed-item"><s>${esc(t)}</s><button class="quiet-btn" data-action="restore-line" data-id="${esc(row.id)}" data-text="${esc(t)}">Restore</button></div>`).join('') + (removed.length > 1 ? `<div><button class="quiet-btn" data-action="restore-lines" data-id="${esc(row.id)}">Restore all</button></div>` : '') : '')
    : ''
  const asking = ui.dismissAsk === row.id
  return `<article class="card ${viewing ? 'viewing' : ''} ${row.status === 'idle' ? 'is-idle' : ''}" style="--ring:${ring}" data-card="${esc(row.id)}">
<div class="top"><span class="tile" style="${tileStyle(row, dark)}">${String(n).padStart(2, '0')}</span><span class="chip">${chip}</span>${row.side ? '<span class="chip side">SIDE TASK</span>' : ''}
${asking ? '<span class="dismiss-ask">Dismiss?</span>' : statusLabel(row)}<button class="dismiss" data-action="dismiss" data-id="${esc(row.id)}" title="Dismiss">✕</button></div>
<button class="name" data-action="open" data-id="${esc(row.id)}" title="Open this session · ${esc(row.place)}">${twoTone(row, prefix)}</button>
<div class="lines selectable">${body}${removedBlock}</div></article>`
}

function header(p) {
  if (ui.settings) return `<div class="header"><div class="header-row"><button class="back" data-action="settings">‹ Sessions</button><h1>Settings</h1></div></div>`
  const total = p.needsYou + p.working + p.idle
  const seg = (n, v) => (n ? `<span style="flex-grow:${n};background:var(${v})"></span>` : '')
  const bar = total ? seg(p.needsYou, '--amber') + seg(p.working, '--green') + seg(p.idle, '--idle') : '<span style="flex-grow:1;background:var(--track)"></span>'
  const leg = (n, v, t) => (n ? `<span><span class="dot" style="background:var(${v})"></span>${t} <b>${n}</b></span>` : '')
  return `<div class="header"><div class="header-row"><h1>Sessions</h1><span class="count">${p.shown.length ? p.shown.length + ' open' : 'none open'}</span><span class="spacer"></span>
<button class="icon-btn" data-action="settings" title="Settings">⚙</button>
<button class="key-btn" data-action="hide" title="Hide the window. Press ${esc(prefs.shortcut)} in any app to bring it back."><span class="keycap">${esc(keyLabel(prefs.shortcut))}</span>hide</button>
<button class="icon-btn ${prefs.collapsed ? 'on' : ''}" data-action="collapse" title="${prefs.collapsed ? 'Show the sessions' : 'Collapse to the summary'}">${prefs.collapsed ? '⌄' : '⌃'}</button></div>
<div class="state-bar">${bar}</div><div class="legend">${leg(p.needsYou, '--amber', 'Needs you')}${leg(p.working, '--green', 'Working')}${leg(p.idle, '--idle', 'Idle')}</div></div>`
}

const keyLabel = (k) => (state.platform === 'macos' ? k.replace('Ctrl+', '⌃').replace('Alt+', '⌥').replace('Shift+', '⇧').replace(/Cmd\+|Super\+/, '⌘') : k)

function strip(p, prefixes, dark) {
  if (ui.settings) return ''
  const first = p.shown.find((r) => r.status === 'needs-you')
  if (!first) return prefs.collapsed ? '<div class="strip-none">Nothing needs you right now</div>' : ''
  const n = p.shown.indexOf(first) + 1
  const more = p.needsYou > 1 ? `<span class="more" title="${p.needsYou} sessions need you">+${p.needsYou - 1}</span>` : ''
  return `<button class="strip" data-action="reveal" data-id="${esc(first.id)}" title="Show it in the list"><span class="tile" style="${tileStyle(first, dark)}">${String(n).padStart(2, '0')}</span><span style="font-size:13px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${twoTone(first, prefixes[first.id])}</span>${more}<span class="label">NEEDS YOU · ${ago(first.since)}</span></button>`
}

function dismissedSection(p) {
  if (!p.hidden.length) return ''
  const rows = ui.showDismissed
    ? p.hidden.map((r) => `<div class="row"><span class="dot" style="background:var(${r.status === 'needs-you' ? '--amber' : r.status === 'working' ? '--green' : '--idle'})"></span><span class="nm">${esc(shownName(r, state.shared.projectNames))}</span><span class="status idle">${STATUS_LABEL[r.status]} · ${ago(r.since)}</span><button class="quiet-btn" data-action="restore" data-id="${esc(r.id)}">Restore</button></div>`).join('') +
      `<div class="foot"><span>Comes back when it needs you.</span>${p.hidden.length > 1 ? '<button class="quiet-btn" data-action="restore-all">Restore all</button>' : ''}</div>`
    : ''
  return `<div class="dismissed"><button data-action="toggle-dismissed">DISMISSED · ${p.hidden.length} ${ui.showDismissed ? '⌄' : '›'}</button>${rows}</div>`
}

const EMPTY = `<div class="empty"><h2>No sessions in the last 12 hours</h2><p>Start Claude Code in a terminal, or open a session in Claude Desktop. It shows up here within a few seconds.</p>
<div class="cmds"><code>claude<span> · in any terminal</span></code><code>/session-board<span> · brings this window back</span></code></div></div>`

const sw = (on, action, extra = '') => `<button class="switch ${on ? 'on' : ''}" data-action="${action}" ${extra} role="switch" aria-checked="${on}"></button>`
function settingsPage() {
  const s = state.shared
  const floating = !prefs.regularWindow
  return `<div class="settings">
<div class="cell"><span class="section">WINDOW</span>
<div class="setting"><div class="txt"><b>Floating or Regular</b><span>${floating ? 'Floating stays above other apps.' : 'A normal window. Other windows can cover it.'}</span></div><div class="seg"><button class="${floating ? 'on' : ''}" data-action="window" data-v="floating">Floating</button><button class="${floating ? '' : 'on'}" data-action="window" data-v="regular">Regular</button></div></div></div>
<div class="cell"><div class="setting"><div class="txt"><span class="section">THEME</span><span style="margin-top:6px">${prefs.theme ? 'Stays as you picked it.' : 'Like your system until you pick one.'}</span></div><div class="seg"><button class="${applyTheme() ? '' : 'on'}" data-action="theme" data-v="light">Light</button><button class="${applyTheme() ? 'on' : ''}" data-action="theme" data-v="dark">Dark</button></div></div></div>
<div class="cell"><span class="section">NAMES</span>
<div class="setting"><div class="txt"><b>Project first</b><span>Each name starts with its project: the Git repo or folder the session runs in.</span></div>${sw(s.projectNames, 'shared', 'data-key="projectNames"')}</div>
<div class="setting indent ${s.projectNames ? '' : 'off'}"><div class="txt"><b>Also rename in Claude Code</b><span>Advanced. Renames each session once, so Claude Code and Claude Desktop show the project too. A new session's first message waits up to 4 s for its name (one small Sonnet call).</span></div>${sw(s.renameSessions, 'shared', 'data-key="renameSessions"')}</div></div>
<div class="cell"><span class="section">SUMMARIES</span>
<div class="setting"><div class="txt"><b>Summaries by Sonnet</b><span>A few small calls per turn, on your account. Off: each card shows what you asked and its task list.</span></div>${sw(s.summaries, 'shared', 'data-key="summaries"')}</div></div>
<div class="cell"><span class="section">SHORTCUT</span>
<div class="setting"><div class="txt"><b>Show or hide, from any app</b><span>${esc(keyLabel(prefs.shortcut))}</span></div></div></div>
<div class="cell"><span class="section">FEEDBACK</span>
<div class="setting"><div class="txt"><b>Something wrong, or an idea?</b><span>Opens GitHub with your versions filled in. Or tell Claude in any session, and say report.</span></div></div>
<div style="display:flex;gap:8px"><button class="quiet-btn" data-action="feedback" data-v="bug">Report a problem</button><button class="quiet-btn" data-action="feedback" data-v="idea">Suggest an idea</button></div>
<div class="version">Session Board ${VERSION}</div></div></div>`
}

function render() {
  const dark = applyTheme()
  const p = partition(state.rows, prefs.dismissed)
  const prefixes = sharedPrefixes(p.shown, state.shared.projectNames)
  let body = ''
  if (ui.settings) body = settingsPage()
  else if (!prefs.collapsed) {
    const list = p.shown.length ? `<div class="list" id="list">${p.shown.map((r, i) => card(r, i + 1, prefixes[r.id], dark)).join('')}</div>` : EMPTY
    const undo = ui.undo ? `<div class="undo"><span>${esc(ui.undo.name)} dismissed</span><button data-action="undo">Undo</button></div>` : ''
    body = list + undo + dismissedSection(p)
  }
  const scroll = document.getElementById('list')?.scrollTop ?? 0
  document.getElementById('app').innerHTML = `<div class="titlebar" data-tauri-drag-region>Session Board<button class="close" data-action="hide" title="Close">✕</button></div>${header(p)}${strip(p, prefixes, dark)}${body}`
  const list = document.getElementById('list')
  if (list) list.scrollTop = scroll
  const title = `◉ ${p.working}` + (p.needsYou ? ` · ${p.needsYou}!` : '')
  invoke('set_tray', { title, tooltip: `Session Board: ${p.working} working, ${p.needsYou} need you` })
}

// ---- What you click
function setShared(key, value) {
  state.shared[key] = value
  invoke('write_shared', { name: 'settings.json', text: JSON.stringify({ summaries: state.shared.summaries, projectNames: state.shared.projectNames, renameSessions: state.shared.renameSessions }, null, 2) })
}
const writeRemoved = () => invoke('write_shared', { name: 'removed.json', text: JSON.stringify(prefs.removedItems, null, 2) })

function openSession(row) {
  // Remote Control sessions open in the browser (or Claude Desktop, which takes claude.ai links)
  if (row.bridgeId) invoke('plugin:opener|open_url', { url: `https://claude.ai/code/${row.bridgeId}` })
}

function feedbackUrl(kind) {
  const settings = `theme=${prefs.theme ?? 'auto'}, regularWindow=${prefs.regularWindow}, summaries=${state.shared.summaries}`
  const body = `${kind === 'bug' ? '### What happened\n\n\n\n### What you expected' : '### The idea'}\n\n\n<details><summary>Details sent with the report</summary>\n\n- Session Board: ${VERSION}\n- OS: ${state.platform}\n- Settings: ${settings}\n- Sessions on the board: ${state.rows.length}\n</details>\n\n_Sent from the Session Board window._`
  return `${REPO}/issues/new?` + new URLSearchParams({ title: kind === 'bug' ? 'Bug: ' : 'Idea: ', body })
}

document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-action]')
  if (!el) return
  const { action, id, text, v, key } = el.dataset
  const row = state.rows.find((r) => r.id === id)
  switch (action) {
    case 'settings': ui.settings = !ui.settings; if (ui.settings) prefs.collapsed = false; break
    case 'collapse': prefs.collapsed = !prefs.collapsed; break
    case 'hide': prefs.userHidden = true; tauri?.window.getCurrentWindow().hide(); break
    case 'dismiss':
      if (ui.dismissAsk !== id) { ui.dismissAsk = id; break }
      ui.dismissAsk = null
      prefs.dismissed.push(id)
      prefs.dismissedAt[id] = Date.now() / 1000
      clearTimeout(ui.undo?.timer)
      ui.undo = { id, name: shownName(row, state.shared.projectNames), timer: setTimeout(() => { ui.undo = null; render() }, UNDO_MS) }
      break
    case 'undo': if (ui.undo) { prefs.dismissed = prefs.dismissed.filter((x) => x !== ui.undo.id); clearTimeout(ui.undo.timer); ui.undo = null } break
    case 'restore': prefs.dismissed = prefs.dismissed.filter((x) => x !== id); break
    case 'restore-all': prefs.dismissed = []; break
    case 'toggle-dismissed': ui.showDismissed = !ui.showDismissed; break
    case 'remove-line': (prefs.removedItems[id] ??= []).push(text); writeRemoved(); break
    case 'restore-line': prefs.removedItems[id] = (prefs.removedItems[id] ?? []).filter((t) => t !== text); writeRemoved(); break
    case 'restore-lines': delete prefs.removedItems[id]; writeRemoved(); break
    case 'toggle-removed': ui.openRemoved.has(id) ? ui.openRemoved.delete(id) : ui.openRemoved.add(id); break
    case 'reveal': prefs.collapsed = false; render(); document.querySelector(`[data-card="${CSS.escape(id)}"]`)?.scrollIntoView({ block: 'start', behavior: 'smooth' }); return
    case 'open': if (row) openSession(row); return
    case 'theme': prefs.theme = v; break
    case 'window': prefs.regularWindow = v === 'regular'; tauri?.window.getCurrentWindow().setAlwaysOnTop(!prefs.regularWindow); break
    case 'shared': setShared(key, !state.shared[key]); break
    case 'feedback': invoke('plugin:opener|open_url', { url: feedbackUrl(v) }); if (!tauri) window.open(feedbackUrl(v)); return
  }
  savePrefs()
  render()
})
// Leaving the ✕ un-arms "Dismiss?"
document.addEventListener('mouseover', (e) => {
  if (ui.dismissAsk && !e.target.closest(`[data-card="${CSS.escape(ui.dismissAsk)}"] .top`)) { ui.dismissAsk = null; render() }
})
document.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === 'z' && ui.undo) document.querySelector('[data-action="undo"]')?.click()
  if ((e.metaKey || e.ctrlKey) && e.key === ',') { ui.settings = true; render() }
})
// Right-click a card: copy the whole session as text
document.addEventListener('contextmenu', (e) => {
  const cardEl = e.target.closest('[data-card]')
  if (!cardEl) return
  e.preventDefault()
  const row = state.rows.find((r) => r.id === cardEl.dataset.card)
  const line = e.target.closest('[data-copy]')
  navigator.clipboard?.writeText(line ? line.dataset.copy : sessionText(row, { jobs: state.jobs[row.id] ?? [], removed: prefs.removedItems[row.id] ?? [], projectNames: state.shared.projectNames }))
})
tauri?.event.listen('menu', ({ payload }) => {
  if (payload === 'settings') { ui.settings = true; render() }
  if (payload === 'report') invoke('plugin:opener|open_url', { url: feedbackUrl('bug') })
})

if (tauri) invoke('set_shortcut', { keys: prefs.shortcut }).catch(() => {})
read()
setInterval(() => read().catch(() => {}), 2000)

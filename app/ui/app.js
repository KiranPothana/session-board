// The board page: reads what the window side hands it every 2 seconds, builds the rows with
// model.js and draws them. In a plain browser (no Tauri) it draws sample sessions instead, which is
// how its layout is checked with screenshots.
import { buildRows, partition, autoRestore, shownName, sharedPrefixes, cardLines, sessionText, assignColors, inkFor, ago, SWATCHES, isQuiet, Attention, soundFor, popupDetail, NEEDS_YOU, DONE } from './model.js'
import { sampleState } from './sample.js'

const tauri = window.__TAURI__
const invoke = (cmd, args) => (tauri ? tauri.core.invoke(cmd, args) : Promise.resolve(null))
const VERSION = '0.2.0'
// Errors go to the app's log, since a webview's console can't be seen
window.addEventListener('error', (e) => invoke('log', { msg: `board: ${e.message} at ${e.filename}:${e.lineno}` }))
window.addEventListener('unhandledrejection', (e) => invoke('log', { msg: `board: ${e.reason?.message ?? e.reason}` }))
const REPO = 'https://github.com/KiranPothana/session-board'
const DEFAULT_SHORTCUT = 'Ctrl+Alt+S'
const UNDO_MS = 6000
// The sounds every system has, bundled with the app: id -> [name, file]
const SOUNDS = {
  'board:needs-you': ['Mallet', 'sounds/needs-you.wav'], 'board:your-turn': ['Soft chime', 'sounds/your-turn.wav'], 'board:done': ['Bell', 'sounds/done.wav'],
  'kenney:confirmation_001': ['Confirm 1', 'sounds/kenney-confirmation_001.wav'], 'kenney:confirmation_002': ['Confirm 2', 'sounds/kenney-confirmation_002.wav'],
  'kenney:confirmation_003': ['Confirm 3', 'sounds/kenney-confirmation_003.wav'], 'kenney:confirmation_004': ['Confirm 4', 'sounds/kenney-confirmation_004.wav'],
  'kenney:question_001': ['Question 1', 'sounds/kenney-question_001.wav'], 'kenney:question_002': ['Question 2', 'sounds/kenney-question_002.wav'],
  'kenney:question_003': ['Question 3', 'sounds/kenney-question_003.wav'], 'kenney:glass_001': ['Glass tap', 'sounds/kenney-glass_001.wav'],
  'kenney:maximize_006': ['Rise', 'sounds/kenney-maximize_006.wav'], 'kenney:bong_001': ['Bong', 'sounds/kenney-bong_001.wav'], 'kenney:pluck_002': ['Pluck', 'sounds/kenney-pluck_002.wav'],
}
const DEFAULT_SOUNDS = ['board:needs-you', 'board:your-turn', 'board:done']
const MOMENTS = [['Needs you', 'A permission prompt or a question', '--amber'], ['Your turn', 'A turn ends with something for you', '--amber'], ['Done', 'Finished, with nothing left running', '--idle']]
// Apps that count as Claude for "hide when you switch away", by executable name, lowercased
const CLAUDE_APPS = ['claude', 'claude.exe']
const TERMINALS = ['terminal', 'iterm2', 'ghostty', 'warp', 'wezterm', 'wezterm-gui', 'kitty', 'alacritty', 'code', 'cursor', 'zed', 'windowsterminal', 'windowsterminal.exe', 'cmd.exe', 'powershell.exe', 'pwsh.exe', 'code.exe', 'cursor.exe', 'wezterm-gui.exe', 'alacritty.exe', 'warp.exe', 'gnome-terminal-server', 'konsole', 'xterm', 'tilix', 'foot']

// ---- What the window keeps between launches (the macOS app's UserDefaults)
const PREFS_KEY = 'session-board-prefs'
const prefs = Object.assign(
  { collapsed: false, dismissed: [], dismissedAt: {}, sessionColors: {}, autoColors: {}, theme: null, regularWindow: false, hideWhenAway: true, terminalsCount: true, soundsOn: true, removedItems: {}, handledShowRequest: 0, shortcut: DEFAULT_SHORTCUT, userHidden: false, soundMoments: [true, true, false], soundChoices: DEFAULT_SOUNDS, alertVolume: 0.5 },
  (() => { try { return JSON.parse(localStorage.getItem(PREFS_KEY)) ?? {} } catch { return {} } })(),
)
const savePrefs = () => { try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)) } catch {} }

// ---- What the page is showing
const ui = { settings: false, showDismissed: false, openRemoved: new Set(), dismissAsk: null, undo: null, focusedId: null, openChooser: null, toastCount: 0, lastSoundAt: 0, claudeTheme: null, ownPid: null, away: false }
const attention = new Attention()
let state = { rows: [], shared: { summaries: true, projectNames: true, renameSessions: false }, platform: 'browser' }

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
const params = new URLSearchParams(location.search)

async function read() {
  const snap = tauri ? await invoke('read_state') : sampleState(Date.now(), params)
  const rows = buildRows({ store: snap.store, registry: snap.registry, registryReadable: snap.registryReadable !== false, projects: snap.projects ?? {}, now: snap.now })
  state = { rows, shared: { summaries: true, projectNames: true, renameSessions: false, ...snap.settings }, platform: snap.platform, jobs: snap.jobs ?? {} }
  ui.testing = !!snap.testing
  ui.claudeTheme = snap.claudeTheme === 'dark' || snap.claudeTheme === 'light' ? snap.claudeTheme : null
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
  noticeAttention(rows, snap.now)
  // A test popup (the test-toast file): that kind, for the first session you aren't viewing
  if (snap.testToast) {
    const row = partition(rows, prefs.dismissed).shown.find((r) => r.id !== ui.focusedId)
    if (row) noticeAttention(rows, snap.now, [{ kind: Number(snap.testToast) || 0, row }])
  }
  if (params.has('viewing')) ui.focusedId = partition(rows, prefs.dismissed).shown[Number(params.get('viewing')) - 1]?.id ?? null
  render()
}

// ---- Popups and sounds when a session wants you
function noticeAttention(rows, now, forced = null) {
  const p = partition(rows, prefs.dismissed)
  const events = forced ?? attention.step(rows.filter((r) => !isQuiet(r)), { focusedId: ui.focusedId, now, jobs: state.jobs })
  const dark = applyTheme()
  for (const { kind, row } of events) {
    const n = p.shown.indexOf(row) + 1
    // Dismissed sessions get no popup
    if (!n) continue
    const swatch = colourOf(row.id, dark)
    const fill = swatch ?? (kind === DONE ? (dark ? '#8D8E91' : '#6B6D73') : dark ? '#E8A93A' : '#C27C00')
    debug(`toast-add ${row.id} kind ${kind} swatch ${colourOf(row.id, dark)} dark ${dark}`)
    tauri?.event.emitTo('toasts', 'toast-add', {
      id: row.id, n: String(n).padStart(2, '0'), kind, name: shownName(row, state.shared.projectNames), detail: popupDetail(kind, row),
      fill, ink: swatch ? inkFor(swatch) : kind === DONE ? (dark ? '#131416' : '#FFFFFF') : '#1A1203', dot: kind === DONE ? (dark ? '#8D8E91' : '#6B6D73') : dark ? '#E8A93A' : '#C27C00', dark,
    })
  }
  // Test popups and test runs (SESSION_BOARD_SHARED_DIR) make no sound
  const sound = forced || ui.testing ? null : soundFor(events, { soundsOn: prefs.soundsOn, moments: prefs.soundMoments, lastSoundAt: ui.lastSoundAt, now })
  if (sound !== null) {
    ui.lastSoundAt = now
    play(prefs.soundChoices[sound] ?? DEFAULT_SOUNDS[sound], prefs.alertVolume || 1, DEFAULT_SOUNDS[sound])
  }
}

function play(id, volume = 1, fallback) {
  const file = (SOUNDS[id] ?? SOUNDS[fallback] ?? SOUNDS[DEFAULT_SOUNDS[0]])[1]
  const audio = new Audio(file)
  audio.volume = Math.max(0, Math.min(1, volume))
  audio.play().catch(() => {})
}

// The popup window sits beside the board: left of it, else right, else above, else below, else
// over its top; level with the first card. Only while the board shows.
const debug = (msg) => ui.testing && invoke('log', { msg })
async function placeToasts() {
  if (!tauri) return
  debug(`placeToasts count=${ui.toastCount}`)
  const toastWin = await tauri.webviewWindow.WebviewWindow.getByLabel('toasts')
  const boardWin = tauri.window.getCurrentWindow()
  if (!toastWin) return
  const visible = await boardWin.isVisible()
  debug(`board visible=${visible}`)
  if (!ui.toastCount || !visible) return invoke('set_toasts_visible', { visible: false })
  const scale = await boardWin.scaleFactor()
  const pos = (await boardWin.outerPosition()).toLogical(scale)
  const size = (await boardWin.outerSize()).toLogical(scale)
  const mon = await tauri.window.currentMonitor()
  const area = mon?.workArea ?? { position: mon?.position, size: mon?.size }
  const S = { x: area.position.x / scale, y: area.position.y / scale, w: area.size.width / scale, h: area.size.height / scale }
  const w = 56, h = ui.toastCount * 40 + (ui.toastCount - 1) * 9 + 16, gap = 4
  const listTop = document.getElementById('list')?.getBoundingClientRect().top
  const below = prefs.collapsed || ui.settings || listTop === undefined ? 0 : listTop + 4 - 8
  const clampY = (y) => Math.max(S.y, Math.min(y, S.y + S.h - h))
  let x, y
  if (pos.x - gap - w >= S.x) { x = pos.x - gap - w; y = clampY(pos.y + below) }
  else if (pos.x + size.width + gap + w <= S.x + S.w) { x = pos.x + size.width + gap; y = clampY(pos.y + below) }
  else if (pos.y - gap - h >= S.y) { x = pos.x + (size.width - w) / 2; y = pos.y - gap - h }
  else if (pos.y + size.height + gap + h <= S.y + S.h) { x = pos.x + (size.width - w) / 2; y = pos.y + size.height + gap }
  else { x = pos.x + size.width - w - 8; y = pos.y + 70 }
  debug(`toasts at ${Math.round(x)},${Math.round(y)} size ${w}x${h}`)
  await toastWin.setSize(new tauri.dpi.LogicalSize(w, h))
  await toastWin.setPosition(new tauri.dpi.LogicalPosition(Math.round(x), Math.round(y)))
  await invoke('set_toasts_visible', { visible: true })
  debug('toasts shown')
}

// ---- Hide when you switch away: the floating board shows only while Claude is the app in front
async function followFrontApp() {
  if (!tauri || ui.testing || prefs.regularWindow || !prefs.hideWhenAway || prefs.userHidden) return
  const front = await invoke('front_app').catch(() => null)
  // The OS won't say (Wayland): leave the board as it is
  if (!front) return
  if (front.pid === ui.ownPid) return
  const exe = String(front.path || front.app || '').split(/[\\/]/).pop().toLowerCase().replace(/\.app$/, '')
  const app = String(front.app || '').toLowerCase()
  const isClaude = CLAUDE_APPS.includes(exe) || app === 'claude'
  const isTerminal = TERMINALS.includes(exe) || TERMINALS.includes(app)
  const away = !(isClaude || (prefs.terminalsCount && isTerminal))
  if (away === ui.away) return
  ui.away = away
  const w = tauri.window.getCurrentWindow()
  away ? await w.hide() : await invoke('show_window', { label: 'board' })
  placeToasts()
}

// ---- Theme: your pick, else Claude Desktop's, else the system's
function applyTheme() {
  const pick = prefs.theme ?? ui.claudeTheme
  const dark = pick ? pick === 'dark' : params.get('theme') ? params.get('theme') === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches
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
<div class="setting"><div class="txt"><b>Floating or Regular</b><span>${floating ? 'Floating stays above other apps.' : 'A normal window. Other windows can cover it.'}</span></div><div class="seg"><button class="${floating ? 'on' : ''}" data-action="window" data-v="floating">Floating</button><button class="${floating ? '' : 'on'}" data-action="window" data-v="regular">Regular</button></div></div>
${floating ? `<div class="setting"><div class="txt"><b>Hide when you switch away</b><span>Shows only while Claude is in front.</span></div>${sw(prefs.hideWhenAway, 'pref', 'data-key="hideWhenAway"')}</div>
<div class="setting indent ${prefs.hideWhenAway ? '' : 'off'}"><div class="txt"><b>Terminals and editors count as Claude</b><span>Terminals, VS Code, Cursor, Zed.</span></div>${sw(prefs.terminalsCount, 'pref', 'data-key="terminalsCount"')}</div>` : ''}</div>
<div class="cell"><div class="setting"><div class="txt"><span class="section">THEME</span><span style="margin-top:6px">${prefs.theme ? 'Stays as you picked it.' : 'Like your system until you pick one.'}</span></div><div class="seg"><button class="${applyTheme() ? '' : 'on'}" data-action="theme" data-v="light">Light</button><button class="${applyTheme() ? 'on' : ''}" data-action="theme" data-v="dark">Dark</button></div></div></div>
<div class="cell"><span class="section">NAMES</span>
<div class="setting"><div class="txt"><b>Project first</b><span>Each name starts with its project: the Git repo or folder the session runs in.</span></div>${sw(s.projectNames, 'shared', 'data-key="projectNames"')}</div>
<div class="setting indent ${s.projectNames ? '' : 'off'}"><div class="txt"><b>Also rename in Claude Code</b><span>Advanced. Renames each session once, so Claude Code and Claude Desktop show the project too. A new session's first message waits up to 4 s for its name (one small Sonnet call).</span></div>${sw(s.renameSessions, 'shared', 'data-key="renameSessions"')}</div></div>
<div class="cell"><span class="section">SUMMARIES</span>
<div class="setting"><div class="txt"><b>Summaries by Sonnet</b><span>A few small calls per turn, on your account. Off: each card shows what you asked and its task list.</span></div>${sw(s.summaries, 'shared', 'data-key="summaries"')}</div></div>
${soundsSection()}
<div class="cell"><span class="section">SHORTCUT</span>
<div class="setting"><div class="txt"><b>Show or hide, from any app</b><span>${esc(keyLabel(prefs.shortcut))}</span></div></div></div>
<div class="cell"><span class="section">FEEDBACK</span>
<div class="setting"><div class="txt"><b>Something wrong, or an idea?</b><span>Opens GitHub with your versions filled in. Or tell Claude in any session, and say report.</span></div></div>
<div style="display:flex;gap:8px"><button class="quiet-btn" data-action="feedback" data-v="bug">Report a problem</button><button class="quiet-btn" data-action="feedback" data-v="idea">Suggest an idea</button></div>
<div class="version">Session Board ${VERSION}</div></div></div>`
}

function soundsSection() {
  const bars = [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1]
  const vol = bars.map((v, i) => i === 0
    ? `<button class="quiet-btn ${prefs.alertVolume === 0 ? 'on-chip' : ''}" data-action="volume" data-v="0" title="Play at the volume your computer is set to">Mine</button>`
    : `<button class="bar ${prefs.alertVolume >= v - 0.001 && prefs.alertVolume ? 'on' : ''}" data-action="volume" data-v="${v}" style="height:${8 + i * 1.2}px" title="${Math.round(v * 100)}%"></button>`).join('')
  const rows = MOMENTS.map(([title, detail, dot], m) => {
    const choice = prefs.soundChoices[m] ?? DEFAULT_SOUNDS[m]
    const open = ui.openChooser === m
    const chips = Object.entries(SOUNDS).map(([id, [name]]) => `<button class="chip-btn ${id === choice ? 'on' : ''}" data-action="choose-sound" data-m="${m}" data-v="${id}">${esc(name)}</button>`).join('')
    return `<div class="sound-row"><span class="dot" style="background:var(${dot})"></span><div class="txt"><b>${title}</b><span>${detail}</span>
<button class="sound-name" data-action="chooser" data-m="${m}">${esc(SOUNDS[choice]?.[0] ?? 'Missing sound')} ${open ? '⌃' : '⌄'}</button></div>
<button class="play" data-action="play" data-v="${choice}">▶ Play</button>${sw(prefs.soundMoments[m], 'moment', `data-m="${m}"`)}</div>${open ? `<div class="chips">${chips}</div>` : ''}`
  }).join('')
  return `<div class="cell"><span class="section">SOUNDS</span>
<div class="setting"><div class="txt"><b>Sounds</b><span>Never for ordinary work, never for the session you're viewing.</span></div>${sw(prefs.soundsOn, 'pref', 'data-key="soundsOn"')}</div>
<div class="${prefs.soundsOn ? '' : 'off-block'}"><div class="setting"><div class="txt"><b>Alert volume</b></div><span class="vol-label">${prefs.alertVolume ? Math.round(prefs.alertVolume * 100) + '%' : 'Your volume'}</span></div>
<div class="bars">${vol}</div><div class="sounds">${rows}</div></div></div>`
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
    case 'pref': prefs[key] = !prefs[key]; if (key === 'hideWhenAway' || key === 'terminalsCount') { ui.away = false; invoke('show_window', { label: 'board' }) } break
    case 'moment': prefs.soundMoments[Number(el.dataset.m)] = !prefs.soundMoments[Number(el.dataset.m)]; break
    case 'volume': prefs.alertVolume = Number(v); if (prefs.alertVolume) play(prefs.soundChoices[0], prefs.alertVolume); break
    case 'chooser': ui.openChooser = ui.openChooser === Number(el.dataset.m) ? null : Number(el.dataset.m); break
    case 'choose-sound': prefs.soundChoices = prefs.soundChoices.map((c, i) => (i === Number(el.dataset.m) ? v : c)); play(v); break
    case 'play': play(v); return
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
tauri?.event.listen('toasts-count', ({ payload }) => { ui.toastCount = payload; placeToasts() })
tauri?.event.listen('toast-open', ({ payload }) => { const row = state.rows.find((r) => r.id === payload); if (row) openSession(row) })
tauri?.window.getCurrentWindow().onMoved(() => placeToasts())
tauri?.window.getCurrentWindow().onResized(() => placeToasts())
tauri?.event.listen('menu', ({ payload }) => {
  if (payload === 'settings') { ui.settings = true; render() }
  if (payload === 'report') invoke('plugin:opener|open_url', { url: feedbackUrl('bug') })
})

if (tauri) {
  invoke('set_shortcut', { keys: prefs.shortcut }).catch(() => {})
  invoke('own_pid').then((pid) => { ui.ownPid = pid })
  // Test runs report where the window is, in the app's log
  setTimeout(async () => {
    if (!ui.testing) return
    const w = tauri.window.getCurrentWindow()
    invoke('log', { msg: `board visible=${await w.isVisible()} at ${JSON.stringify(await w.outerPosition())} size ${JSON.stringify(await w.outerSize())}` })
  }, 4000)
  setInterval(() => followFrontApp().catch(() => {}), 500)
}
read()
setInterval(() => read().catch(() => {}), 2000)

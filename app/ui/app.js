// The board page: reads what the window side hands it every 2 seconds, builds the rows with
// model.js and draws them. In a plain browser (no Tauri) it draws sample sessions instead, which is
// how its layout is checked with screenshots.
import { buildRows, partition, autoRestore, shownName, sharedPrefixes, cardLines, sessionText, assignColors, inkFor, ago, SWATCHES, isQuiet, Attention, soundFor, popupDetail, NEEDS_YOU, DONE, focusedFrom, parseCrash } from './model.js'
import { sampleState } from './sample.js'
import { DEFAULT_SHORTCUT, label as shortcutLabel, Recorder, clash, fromLegacy } from './shortcut.js'
import { defaultFrame, fits, edgesAt } from './geometry.js'

const tauri = window.__TAURI__
const invoke = (cmd, args) => (tauri ? tauri.core.invoke(cmd, args) : Promise.resolve(null))
const VERSION = '0.3.3'
// Errors go to the app's log, since a webview's console can't be seen
window.addEventListener('error', (e) => invoke('log', { msg: `board: ${e.message} at ${e.filename}:${e.lineno}` }))
window.addEventListener('unhandledrejection', (e) => invoke('log', { msg: `board: ${e.reason?.message ?? e.reason}` }))
const REPO = 'https://github.com/KiranPothana/session-board'
// Session Board's report inbox (reports-worker/): files a report privately, no GitHub account needed
const INBOX = 'https://session-board-reports.kiran-987.workers.dev/report'
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
  { collapsed: false, dismissed: [], dismissedAt: {}, sessionColors: {}, autoColors: {}, theme: null, regularWindow: false, hideWhenAway: true, terminalsCount: true, soundsOn: true, removedItems: {}, handledShowRequest: 0, shortcut: DEFAULT_SHORTCUT, userHidden: false, soundMoments: [true, true, false], soundChoices: DEFAULT_SOUNDS, alertVolume: 0.5, askedAccessibility: false, crashSeenAt: 0 },
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
  ui.accessibility = snap.accessibility !== false
  ui.desktopRunning = !!snap.desktopRunning
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
  // The old Mac app's settings, once we know which system this is and whether it's a test run
  if (!ui.importTried) {
    ui.importTried = true
    importLegacy().catch(() => {})
  }
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
    play(prefs.soundChoices[sound] ?? DEFAULT_SOUNDS[sound], prefs.alertVolume || 1, DEFAULT_SOUNDS[sound], { alert: true })
  }
}

// The sounds besides the bundled ones: macOS's alert sounds (on a Mac) and your own
let extraSounds = { mac: [], own: [] }
async function loadSounds() {
  extraSounds = (await invoke('list_sounds').catch(() => null)) ?? { mac: [], own: [] }
}
const soundName = (id) => {
  if (SOUNDS[id]) return SOUNDS[id][0]
  if (id.startsWith('mac:') && extraSounds.mac.includes(id.slice(4))) return id.slice(4)
  if (id.startsWith('custom:') && extraSounds.own.includes(id.slice(7))) return id.slice(7).replace(/\.[^.]+$/, '')
  return null
}
const MIME = { aiff: 'audio/aiff', aif: 'audio/aiff', wav: 'audio/wav', mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac', ogg: 'audio/ogg', oga: 'audio/ogg', flac: 'audio/flac', caf: 'audio/x-caf' }

async function audioFor(id) {
  if (SOUNDS[id]) return new Audio(SOUNDS[id][1])
  if (!soundName(id)) return null
  const data = await invoke('read_sound', { id }).catch(() => null)
  if (!data) return null
  const ext = (id.startsWith('mac:') ? 'aiff' : id.split('.').pop() ?? '').toLowerCase()
  return new Audio(`data:${MIME[ext] ?? 'audio/mpeg'};base64,${data}`)
}

// Plays a sound; a missing one falls back to the moment's default. An automatic alert (alert:
// true) on a Mac plays at the alert volume you chose by setting the Mac's volume and putting
// yours back after, unless you changed it meanwhile; muted stays muted. Elsewhere, and for
// ▶ Play, the volume is the sound's own.
async function play(id, volume = 1, fallback, { alert = false } = {}) {
  const audio = (await audioFor(id)) ?? (await audioFor(fallback ?? DEFAULT_SOUNDS[0]))
  if (!audio) return
  const target = Math.round((prefs.alertVolume || 0) * 100)
  if (alert && state.platform === 'macos' && target && tauri) {
    const now = await invoke('mac_volume', { set: null }).catch(() => null)
    if (now?.muted) return
    if (now?.volume != null && Math.abs(now.volume - target) > 1) {
      prefs.volumeToRestore = now.volume
      savePrefs()
      await invoke('mac_volume', { set: target })
      audio.addEventListener('ended', () => setTimeout(restoreVolume, 250, target), { once: true })
      audio.addEventListener('error', () => restoreVolume(target), { once: true })
    }
    audio.volume = 1
  } else {
    audio.volume = Math.max(0, Math.min(1, volume))
  }
  audio.play().catch(() => {})
}

// Puts your volume back, only if it's still the alert's (you didn't change it meanwhile); also
// at launch, in case the app quit while an alert played
async function restoreVolume(target) {
  if (prefs.volumeToRestore == null) return
  const now = await invoke('mac_volume', { set: null }).catch(() => null)
  if (target == null || (now?.volume != null && Math.abs(now.volume - target) <= 2)) await invoke('mac_volume', { set: prefs.volumeToRestore })
  prefs.volumeToRestore = null
  savePrefs()
}

// Settings › Sounds › Add your own…: any file the system can play, under 10 seconds and 5 MB
function addOwnSound(moment) {
  const input = document.createElement('input')
  input.type = 'file'
  input.accept = 'audio/*'
  input.addEventListener('change', async () => {
    const file = input.files?.[0]
    if (!file) return
    ui.soundError = null
    if (file.size > 5 * 1024 * 1024) { ui.soundError = `${file.name} is over 5 MB.`; return render() }
    const url = URL.createObjectURL(file)
    const seconds = await new Promise((resolve) => {
      const a = new Audio()
      a.addEventListener('loadedmetadata', () => resolve(a.duration), { once: true })
      a.addEventListener('error', () => resolve(NaN), { once: true })
      a.src = url
    })
    URL.revokeObjectURL(url)
    if (!Number.isFinite(seconds)) { ui.soundError = `${file.name} isn't a sound this computer can play.`; return render() }
    if (seconds > 10) { ui.soundError = `${file.name} is ${Math.round(seconds)} seconds long. Use one under 10.`; return render() }
    const data = btoa(Array.from(new Uint8Array(await file.arrayBuffer()), (b) => String.fromCharCode(b)).join(''))
    try {
      const saved = await invoke('add_sound', { name: file.name, data })
      await loadSounds()
      prefs.soundChoices = prefs.soundChoices.map((c, i) => (i === moment ? 'custom:' + saved : c))
      savePrefs()
      play('custom:' + saved)
    } catch (err) {
      ui.soundError = `Couldn't add ${file.name}: ${err}`
    }
    render()
  })
  input.click()
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

// ---- Collapsed: the window fits the counts line, and gets its height back when you open it
// again (one height remembered per window kind)
async function fitCollapsed(changed = false) {
  if (!tauri) return
  const w = tauri.window.getCurrentWindow()
  const scale = await w.scaleFactor()
  const size = (await w.innerSize()).toLogical(scale)
  const key = prefs.regularWindow ? 'expandedHeightRegular' : 'expandedHeight'
  if (prefs.collapsed) {
    // The title bar, the header and the strip: everything above the list
    const app = document.getElementById('app')
    const h = [...app.children].reduce((sum, el) => sum + el.getBoundingClientRect().height + 1, 0)
    if (changed && size.height > h + 20) prefs[key] = size.height
    await w.setMinSize(new tauri.dpi.LogicalSize(260, Math.ceil(h)))
    if (Math.abs(size.height - h) > 1) await w.setSize(new tauri.dpi.LogicalSize(size.width, Math.ceil(h)))
  } else if (changed) {
    await w.setMinSize(new tauri.dpi.LogicalSize(260, 160))
    const back = prefs[key] > 120 ? prefs[key] : 640
    if (size.height <= 200) await w.setSize(new tauri.dpi.LogicalSize(size.width, back))
  }
  savePrefs()
}

// ---- The window's place and size: each window kind remembers its own; the first time (or when the
// saved place is off every screen now) it opens at the default for this screen (geometry.js)
async function workArea() {
  const mon = await tauri.window.currentMonitor()
  if (!mon) return null
  const scale = mon.scaleFactor
  const a = mon.workArea ?? { position: mon.position, size: mon.size }
  return { x: a.position.x / scale, y: a.position.y / scale, width: a.size.width / scale, height: a.size.height / scale }
}

async function placeWindow() {
  if (!tauri) return
  const area = await workArea()
  if (!area) return
  const key = prefs.regularWindow ? 'regular' : 'floating'
  const saved = prefs.frames?.[key]
  const f = fits(saved, area) ? saved : defaultFrame(area, prefs.regularWindow)
  const w = tauri.window.getCurrentWindow()
  ui.placing = true
  await w.setSize(new tauri.dpi.LogicalSize(f.width, prefs.collapsed ? Math.min(f.height, 120) : f.height))
  await w.setPosition(new tauri.dpi.LogicalPosition(f.x, f.y))
  setTimeout(() => { ui.placing = false }, 300)
}

let frameTimer = null
function rememberFrame() {
  if (!tauri || ui.placing) return
  clearTimeout(frameTimer)
  frameTimer = setTimeout(async () => {
    const w = tauri.window.getCurrentWindow()
    const scale = await w.scaleFactor()
    const pos = (await w.outerPosition()).toLogical(scale)
    const size = (await w.outerSize()).toLogical(scale)
    const key = prefs.regularWindow ? 'regular' : 'floating'
    // A collapsed window's height isn't its height
    const height = prefs.collapsed ? (prefs.frames?.[key]?.height ?? size.height) : size.height
    prefs.frames = { ...(prefs.frames ?? {}), [key]: { x: Math.round(pos.x), y: Math.round(pos.y), width: Math.round(size.width), height: Math.round(height) } }
    savePrefs()
  }, 400)
}

// Resizing from any edge or corner of the frameless window (Windows and Linux; a Mac panel has
// its own), with the cursor that says which way
const CURSORS = { North: 'ns-resize', South: 'ns-resize', East: 'ew-resize', West: 'ew-resize', NorthEast: 'nesw-resize', SouthWest: 'nesw-resize', NorthWest: 'nwse-resize', SouthEast: 'nwse-resize' }
function resizeEdges() {
  if (!tauri || state.platform === 'macos') return
  document.addEventListener('mousemove', (e) => {
    const dir = edgesAt(e.clientX, e.clientY, innerWidth, innerHeight, prefs.collapsed)
    document.documentElement.style.cursor = dir ? CURSORS[dir] : ''
  })
  document.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return
    const dir = edgesAt(e.clientX, e.clientY, innerWidth, innerHeight, prefs.collapsed)
    if (!dir) return
    e.preventDefault()
    e.stopPropagation()
    tauri.window.getCurrentWindow().startResizeDragging(dir)
  }, true)
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
// Linux draws the window's rounded corners in the page (Windows 11 rounds it natively)
function windowShape() {
  document.documentElement.classList.toggle('rounded', state.platform === 'linux')
}

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
    const tip = l.all ? ` title="${esc(l.all.join('\n'))}"` : ''
    return `<div class="line ${l.kind}" data-copy="${esc(l.text)}"${tip}><span class="g">${l.kind === 'doing' ? '▶' : esc(l.glyph ?? '')}</span><span class="t">${esc(l.text)}</span>${rm}</div>`
  }).join('')
  const open = ui.openRemoved.has(row.id)
  const removedBlock = removed.length
    ? `<button class="removed-toggle" data-action="toggle-removed" data-id="${esc(row.id)}">${open ? '⌄' : '›'} ${removed.length} removed</button>` +
      (open ? removed.map((t) => `<div class="removed-item"><s>${esc(t)}</s><button class="quiet-btn" data-action="restore-line" data-id="${esc(row.id)}" data-text="${esc(t)}">Restore</button></div>`).join('') + (removed.length > 1 ? `<div><button class="quiet-btn" data-action="restore-lines" data-id="${esc(row.id)}">Restore all</button></div>` : '') : '')
    : ''
  const asking = ui.dismissAsk === row.id
  return `<article class="card ${viewing ? 'viewing' : ''} ${row.status === 'idle' ? 'is-idle' : ''}" style="--ring:${ring}" data-card="${esc(row.id)}">
<div class="top"><button class="tile" data-action="colours" data-id="${esc(row.id)}" style="${tileStyle(row, dark)}" title="Pick a colour for this session">${String(n).padStart(2, '0')}</button><span class="chip">${chip}</span>${row.side ? '<span class="chip side">SIDE TASK</span>' : ''}
${asking ? '<span class="dismiss-ask">Dismiss?</span>' : statusLabel(row)}<button class="dismiss" data-action="dismiss" data-id="${esc(row.id)}" title="Dismiss">✕</button></div>
<button class="name" data-action="open" data-id="${esc(row.id)}" title="Open this session · ${esc(row.place)}">${twoTone(row, prefix)}</button>
${ui.coloursFor === row.id ? swatchPicker(row, dark) : ''}<div class="lines selectable">${body}${removedBlock}</div></article>`
}

// The colours a session's tile can take: pick one, or go back to the automatic one
function swatchPicker(row, dark) {
  const current = prefs.sessionColors[row.id] ?? prefs.autoColors[row.id]
  const swatches = Object.entries(SWATCHES).map(([name, [d, l]]) => `<button class="swatch ${name === current ? 'on' : ''}" data-action="colour" data-id="${esc(row.id)}" data-v="${name}" title="${name}" style="background:${dark ? d : l}"></button>`).join('')
  return `<div class="picker"><b>Colour for this session</b><div class="swatches">${swatches}</div>${prefs.sessionColors[row.id] ? `<button class="quiet-btn" data-action="colour" data-id="${esc(row.id)}" data-v="">Back to automatic</button>` : ''}</div>`
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

const keyLabel = (k) => shortcutLabel(k, state.platform)

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
${shortcutSection()}
<div class="cell"><span class="section">FEEDBACK</span>
<div class="setting"><div class="txt"><b>Something wrong, or an idea?</b><span>Opens GitHub with your versions filled in. Or tell Claude in any session, and say report.</span></div></div>
<div style="display:flex;gap:8px"><button class="quiet-btn" data-action="feedback" data-v="bug">Report a problem</button><button class="quiet-btn" data-action="feedback" data-v="idea">Suggest an idea</button></div>
<div class="version">Session Board ${VERSION}</div></div></div>`
}

// Settings › Shortcut: click, then press the new keys (or on a Mac tap a right-hand ⌥, ⌘ or ⌃)
function shortcutSection() {
  const rec = ui.recording
  const mac = state.platform === 'macos'
  const hint = (rec ? 'Press the new keys' : 'Click, then press the new keys') + (mac ? ', or tap a right-hand ⌥, ⌘ or ⌃' : '') + '. Esc cancels.'
  const pending = ui.pendingShortcut
  return `<div class="cell"><span class="section">SHORTCUT</span>
<div class="setting"><div class="txt"><b>Show or hide, from any app</b><span>${hint}</span></div>
${!rec && prefs.shortcut !== DEFAULT_SHORTCUT ? `<button class="quiet-btn plain" data-action="shortcut-reset" title="Back to ${esc(keyLabel(DEFAULT_SHORTCUT))}">Reset</button>` : ''}
<button class="recorder ${rec ? 'rec' : pending ? 'clash' : ''}" data-action="shortcut-record" title="${rec ? 'Click to cancel' : 'Click, then press the new keys'}">${rec ? 'Type it…' : esc(keyLabel(pending ?? prefs.shortcut))}</button></div>
${ui.shortcutError ? `<div class="warn">${esc(ui.shortcutError)}</div>` : ''}
${pending ? `<div class="warn">${esc(clash(pending, state.platform))}</div><div style="display:flex;gap:8px"><button class="quiet-btn" data-action="shortcut-anyway">Use ${esc(keyLabel(pending))} anyway</button><button class="quiet-btn" data-action="shortcut-record">Pick another</button></div>` : ''}</div>`
}

async function useShortcut(keys) {
  const before = prefs.shortcut
  try {
    await invoke('set_shortcut', { keys })
    prefs.shortcut = keys
    ui.shortcutError = null
  } catch (err) {
    ui.shortcutError = `${keyLabel(keys)} couldn't be set: ${String(err)}. It's still ${keyLabel(before)}.`
    await invoke('set_shortcut', { keys: before }).catch(() => {})
  }
  ui.pendingShortcut = null
  savePrefs()
  render()
}

function stopRecording() {
  ui.recording = false
  ui.recorder = null
  invoke('take_keyboard', { take: false })
}

function onRecordKey(e) {
  if (!ui.recording) return
  e.preventDefault()
  const got = ui.recorder.feed(e)
  if (!got) return
  stopRecording()
  if (got.cancel) {
    invoke('set_shortcut', { keys: prefs.shortcut }).catch(() => {})
  } else if (got.problem) {
    ui.shortcutError = got.problem
    invoke('set_shortcut', { keys: prefs.shortcut }).catch(() => {})
  } else if (clash(got.keys, state.platform)) {
    ui.pendingShortcut = got.keys
    invoke('set_shortcut', { keys: prefs.shortcut }).catch(() => {})
  } else {
    useShortcut(got.keys)
    return
  }
  render()
}
document.addEventListener('keydown', onRecordKey, true)
document.addEventListener('keyup', onRecordKey, true)

// macOS: the SwiftUI app's settings carry over, once
// (Test runs share this app's id, and so its stored settings: they never import, and only an
// import that found the old app's settings counts as done.)
async function importLegacy() {
  if (prefs.importedSwiftSettings || state.platform !== 'macos' || ui.testing) return
  const d = await invoke('legacy_settings').catch(() => null)
  if (d && typeof d === 'object' && Object.keys(d).length) {
    prefs.importedSwiftSettings = true
    if (d.shortcutKey != null && d.shortcutKeyCode != null) prefs.shortcut = fromLegacy(Number(d.shortcutKeyCode), Number(d.shortcutMods ?? 0), String(d.shortcutKey))
    for (const k of ['theme', 'regularWindow', 'hideWhenAway', 'terminalsCount', 'soundsOn', 'collapsed', 'askedAccessibility']) if (d[k] !== undefined) prefs[k] = d[k]
    for (const k of ['sessionColors', 'autoColors', 'dismissedAt', 'removedItems']) if (d[k] && typeof d[k] === 'object') prefs[k] = d[k]
    if (Array.isArray(d.dismissed)) prefs.dismissed = d.dismissed
    if (Array.isArray(d.soundChoices)) prefs.soundChoices = d.soundChoices
    if (typeof d.alertVolume === 'number') prefs.alertVolume = d.alertVolume
    prefs.soundMoments = [d.soundNeedsYou ?? true, d.soundYourTurn ?? true, d.soundDone ?? false]
    if (typeof d.crashSeenAt === 'number') prefs.crashSeenAt = d.crashSeenAt * 1000
    await invoke('set_shortcut', { keys: prefs.shortcut }).catch(() => {})
    invoke('set_window_mode', { regular: !!prefs.regularWindow })
    savePrefs()
    render()
    fitCollapsed(true).catch(() => {})
  }
}

function soundsSection() {
  const bars = [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1]
  const vol = bars.map((v, i) => i === 0
    ? `<button class="quiet-btn ${prefs.alertVolume === 0 ? 'on-chip' : ''}" data-action="volume" data-v="0" title="Play at the volume your computer is set to">Mine</button>`
    : `<button class="bar ${prefs.alertVolume >= v - 0.001 && prefs.alertVolume ? 'on' : ''}" data-action="volume" data-v="${v}" style="height:${8 + i * 1.2}px" title="${Math.round(v * 100)}%"></button>`).join('')
  const rows = MOMENTS.map(([title, detail, dot], m) => {
    const choice = prefs.soundChoices[m] ?? DEFAULT_SOUNDS[m]
    const open = ui.openChooser === m
    const chip = (id, name, own = false) => `<span class="chip-wrap"><button class="chip-btn ${id === choice ? 'on' : ''}" data-action="choose-sound" data-m="${m}" data-v="${esc(id)}">${esc(name)}</button>${own ? `<button class="chip-x" data-action="remove-sound" data-v="${esc(id)}" title="Remove this sound">✕</button>` : ''}</span>`
    const group = (title, items) => (items.length ? `<div class="chip-group"><span class="section">${title}</span><div class="chips">${items.join('')}</div></div>` : '')
    const chips = [
      group('DEFAULT', [chip(DEFAULT_SOUNDS[m], 'Default · ' + SOUNDS[DEFAULT_SOUNDS[m]][0])]),
      group('SESSION BOARD', Object.entries(SOUNDS).filter(([id]) => id.startsWith('board:')).map(([id, [n]]) => chip(id, n))),
      group(state.platform === 'macos' ? 'MAC ALERTS' : 'SYSTEM', extraSounds.mac.map((n) => chip('mac:' + n, n))),
      group('KENNEY · CC0', Object.entries(SOUNDS).filter(([id]) => id.startsWith('kenney:')).map(([id, [n]]) => chip(id, n))),
      `<div class="chip-group"><span class="section">YOURS</span><div class="chips">${extraSounds.own.map((f) => chip('custom:' + f, f.replace(/\.[^.]+$/, ''), true)).join('')}<button class="chip-btn add" data-action="add-sound" data-m="${m}" title="A file of yours: under 10 seconds and 5 MB">+ Add your own…</button></div></div>`,
    ].join('')
    return `<div class="sound-row"><span class="dot" style="background:var(${dot})"></span><div class="txt"><b>${title}</b><span>${detail}</span>
<button class="sound-name" data-action="chooser" data-m="${m}">${esc(soundName(choice) ?? 'Missing sound')} ${open ? '⌃' : '⌄'}</button></div>
<button class="play" data-action="play" data-v="${esc(choice)}" data-m="${m}">▶ Play</button>${sw(prefs.soundMoments[m], 'moment', `data-m="${m}"`)}</div>${open ? `<div class="chooser">${chips}</div>` : ''}`
  }).join('')
  return `<div class="cell"><span class="section">SOUNDS</span>
<div class="setting"><div class="txt"><b>Sounds</b><span>Never for ordinary work, never for the session you're viewing.</span></div>${sw(prefs.soundsOn, 'pref', 'data-key="soundsOn"')}</div>
<div class="${prefs.soundsOn ? '' : 'off-block'}"><div class="setting"><div class="txt"><b>Alert volume</b></div><span class="vol-label">${prefs.alertVolume ? Math.round(prefs.alertVolume * 100) + '%' : 'Your volume'}</span></div>
<div class="bars">${vol}</div><div class="vol-note">${prefs.alertVolume ? (state.platform === 'macos' ? "Sounds that play on their own play at this volume, then yours goes back." : 'Sounds that play on their own play this loud.') : (state.platform === 'macos' ? "Sounds play at your Mac's volume." : 'Sounds play at full volume.')}</div>${ui.soundError ? `<div class="warn">${esc(ui.soundError)}</div>` : ''}<div class="sounds">${rows}</div></div></div>`
}

function render() {
  windowShape()
  const dark = applyTheme()
  const p = partition(state.rows, prefs.dismissed)
  const prefixes = sharedPrefixes(p.shown, state.shared.projectNames)
  let body = ''
  if (ui.settings) body = settingsPage()
  else if (!prefs.collapsed) {
    const list = notes() + (p.shown.length ? `<div class="list" id="list">${p.shown.map((r, i) => card(r, i + 1, prefixes[r.id], dark)).join('')}</div>` : EMPTY)
    const undo = ui.undo ? `<div class="undo"><span>${esc(ui.undo.name)} dismissed</span><button data-action="undo">Undo</button></div>` : ''
    body = list + undo + dismissedSection(p)
  }
  const scroll = document.getElementById('list')?.scrollTop ?? 0
  const settingsScroll = document.querySelector('.settings')?.scrollTop ?? 0
  document.getElementById('app').innerHTML = `<div class="titlebar" data-tauri-drag-region>Session Board<button class="close" data-action="hide" title="Close">✕</button></div>${header(p)}${strip(p, prefixes, dark)}${body}`
  const list = document.getElementById('list')
  if (list) list.scrollTop = scroll
  // Redrawn every read: Settings stays where you scrolled it
  const settings = document.querySelector('.settings')
  if (settings) settings.scrollTop = settingsScroll
  if (prefs.collapsed) fitCollapsed().catch(() => {})
  const title = `◉ ${p.working}` + (p.needsYou ? ` · ${p.needsYou}!` : '')
  invoke('set_tray', { title, tooltip: `Session Board: ${p.working} working, ${p.needsYou} need you` })
}

// ---- What you click
function setShared(key, value) {
  state.shared[key] = value
  invoke('write_shared', { name: 'settings.json', text: JSON.stringify({ summaries: state.shared.summaries, projectNames: state.shared.projectNames, renameSessions: state.shared.renameSessions }, null, 2) })
}
const writeRemoved = () => invoke('write_shared', { name: 'removed.json', text: JSON.stringify(prefs.removedItems, null, 2) })

// Takes you to a session (in Claude Desktop, its terminal tab, or the app it runs in); its popup
// has done its job
function openSession(row) {
  tauri?.event.emitTo('toasts', 'toast-remove', row.id)
  invoke('open_session', { id: row.id, bridgeId: row.bridgeId, isDesktop: row.isDesktop, pid: row.pid ?? null })
}

// ---- The session you're looking at: its card gets the highlight and stays at the top
async function followFocus() {
  const pids = state.rows.map((r) => r.pid).filter(Boolean)
  const front = await invoke('focus', { pids }).catch(() => null)
  const id = focusedFrom(front, state.rows, ui.focusedId)
  if (id === undefined || id === ui.focusedId) return
  ui.focusedId = id
  ui.userScrolled = false
  // You're there now: its popup has done its job
  if (id) tauri?.event.emitTo('toasts', 'toast-remove', id)
  render()
  if (id) document.querySelector(`[data-card="${CSS.escape(id)}"]`)?.scrollIntoView({ block: 'start', behavior: 'smooth' })
}

// ---- A crash since the last one offered: one click sends it to the team
async function checkCrash() {
  // The first run only notes the time, so crashes from before the prompt are never offered
  if (!prefs.crashSeenAt) { prefs.crashSeenAt = Date.now(); savePrefs(); return }
  const found = await invoke('read_crash', { since: prefs.crashSeenAt }).catch(() => null)
  if (!found) return
  ui.crash = parseCrash(found.kind, found.text, { at: found.at, version: VERSION, os: state.platform })
  render()
}

async function sendCrash() {
  const crash = ui.crash
  if (!crash) return
  ui.crashSending = true
  render()
  let sent = false
  try {
    const res = await fetch(INBOX, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'crash', source: 'crash', title: crash.title, body: crash.details }) })
    sent = res.status === 201 && (await res.json()).ok === true
  } catch {}
  ui.crashSending = false
  if (sent) {
    ui.crashSent = true
    render()
    setTimeout(closeCrash, 3000)
  } else {
    invoke('plugin:opener|open_url', { url: `${REPO}/issues/new?` + new URLSearchParams({ title: 'Crash: ' + crash.title, body: crash.details }) })
    closeCrash()
  }
}

function closeCrash() {
  if (ui.crash) prefs.crashSeenAt = Math.max(prefs.crashSeenAt, ui.crash.at)
  ui.crash = null
  ui.crashSent = false
  savePrefs()
  render()
}

function notes() {
  let out = ''
  if (ui.crash) {
    out += `<div class="note"><div class="t"><span class="dot" style="background:var(${ui.crashSent ? '--green' : '--amber'})"></span>${ui.crashSent ? 'Sent. Thanks for the report.' : 'Session Board quit unexpectedly'}</div>${ui.crashSent ? '' : `<p>Send the crash details to the Session Board team? Nothing from your sessions is included.</p><div class="btns"><button class="quiet-btn" data-action="crash-send">${ui.crashSending ? 'Sending…' : 'Report'}</button><button class="quiet-btn" data-action="crash-close">Not now</button></div>`}</div>`
  }
  // macOS only: reading which chat Claude Desktop has open needs the Accessibility permission
  if (state.platform === 'macos' && !ui.accessibility && ui.desktopRunning) {
    out += `<div class="note"><div class="t" style="font-weight:400;font-size:11.5px;color:var(--soft)">Turn on <b style="margin:0 3px">Session Board</b> in Accessibility<span style="flex:1"></span><button class="quiet-btn" data-action="accessibility">Open Settings</button></div></div>`
  }
  return out
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
    case 'collapse': prefs.collapsed = !prefs.collapsed; savePrefs(); render(); fitCollapsed(true); return
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
    case 'window': prefs.regularWindow = v === 'regular'; invoke('set_window_mode', { regular: prefs.regularWindow }); placeWindow(); break
    case 'shared': setShared(key, !state.shared[key]); break
    case 'pref': prefs[key] = !prefs[key]; if (key === 'hideWhenAway' || key === 'terminalsCount') { ui.away = false; invoke('show_window', { label: 'board' }) } break
    case 'moment': prefs.soundMoments[Number(el.dataset.m)] = !prefs.soundMoments[Number(el.dataset.m)]; break
    case 'volume': prefs.alertVolume = Number(v); if (prefs.alertVolume) play(prefs.soundChoices[0], prefs.alertVolume); break
    case 'chooser': ui.openChooser = ui.openChooser === Number(el.dataset.m) ? null : Number(el.dataset.m); break
    case 'choose-sound': prefs.soundChoices = prefs.soundChoices.map((c, i) => (i === Number(el.dataset.m) ? v : c)); play(v); break
    case 'play': play(v, 1, DEFAULT_SOUNDS[Number(el.dataset.m)]); return
    case 'colours': ui.coloursFor = ui.coloursFor === id ? null : id; break
    case 'colour':
      if (v) prefs.sessionColors[id] = v
      else delete prefs.sessionColors[id]
      ui.coloursFor = null
      break
    case 'add-sound': addOwnSound(Number(el.dataset.m)); return
    case 'remove-sound':
      invoke('remove_sound', { id: v }).then(loadSounds).then(() => {
        // A moment that used it goes back to its default
        prefs.soundChoices = prefs.soundChoices.map((c, i) => (c === v ? DEFAULT_SOUNDS[i] : c))
        savePrefs()
        render()
      })
      return
    case 'shortcut-record':
      if (ui.recording) { stopRecording(); invoke('set_shortcut', { keys: prefs.shortcut }).catch(() => {}); break }
      ui.recording = true
      ui.pendingShortcut = null
      ui.shortcutError = null
      ui.recorder = new Recorder(state.platform)
      // While it records, the current shortcut is off, and the board takes the keyboard
      invoke('set_shortcut', { keys: 'tap:0' }).catch(() => {})
      invoke('take_keyboard', { take: true })
      break
    case 'shortcut-anyway': useShortcut(ui.pendingShortcut); return
    case 'shortcut-reset': useShortcut(DEFAULT_SHORTCUT); return
    case 'crash-send': sendCrash(); return
    case 'crash-close': closeCrash(); return
    case 'accessibility': invoke('ask_accessibility'); invoke('plugin:opener|open_url', { url: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility' }); return
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
tauri?.window.getCurrentWindow().onMoved(() => { placeToasts(); rememberFrame() })
tauri?.window.getCurrentWindow().onResized(() => { placeToasts(); rememberFrame() })
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
  setInterval(() => followFocus().catch(() => {}), 750)
  setTimeout(() => checkCrash().catch(() => {}), 1500)
  // The window kind and size you left it with
  setTimeout(async () => {
    invoke('set_window_mode', { regular: !!prefs.regularWindow })
    if (state.platform !== 'macos') await placeWindow().catch(() => {})
    fitCollapsed()
  }, 300)
  setTimeout(resizeEdges, 400)
  loadSounds().then(render)
  // An alert's volume change left behind when the app last quit: put it back
  if (prefs.volumeToRestore != null) restoreVolume(null)
  // macOS: ask once for the Accessibility permission the Desktop highlight needs
  setTimeout(() => {
    if (state.platform === 'macos' && !ui.accessibility && !prefs.askedAccessibility && !ui.testing) {
      prefs.askedAccessibility = true
      savePrefs()
      invoke('ask_accessibility')
    }
  }, 3000)
  // Scrolling the list yourself stops it following the session you're looking at, until you switch
  document.addEventListener('wheel', () => { ui.userScrolled = true }, { passive: true })
}
read()
setInterval(() => read().catch(() => {}), 2000)

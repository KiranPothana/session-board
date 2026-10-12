const tauri = window.__TAURI__
window.addEventListener('error', (e) => tauri?.core.invoke('log', { msg: `toasts: ${e.message}` }))
window.addEventListener('unhandledrejection', (e) => tauri?.core.invoke('log', { msg: `toasts: ${e.reason?.message ?? e.reason}` }))
const SECONDS = 8
const MAX = 4
// Each popup: { id, n, kind, name, detail, fill, ink, dot, dark, start, held, heldAt }
let toasts = []

const emit = (name, payload) => tauri?.event.emitTo('board', name, payload)

function render() {
  const now = performance.now()
  document.getElementById('stack').innerHTML = toasts.map((t) => {
    const elapsed = t.held ? t.heldAt - t.start : now - t.start
    const left = Math.max(0, 1 - elapsed / 1000 / SECONDS)
    const text = t.dark ? '#F2F2F3' : '#141518'
    const gap = t.dark ? '#0B0B0C' : '#E2E3E6'
    const label = ['Needs you', 'Your turn', 'Done'][t.kind]
    return `<div class="toast" data-id="${t.id}" title="${t.n} · ${t.name.replace(/"/g, '&quot;')}\n${label}: ${t.detail.replace(/"/g, '&quot;')}\nClick to open" style="--text:${text};--gap:${gap}">
<div class="tile" style="background:${t.fill};color:${t.ink}">${t.n}</div>
<svg class="ring" viewBox="0 0 45 45"><rect x="0.75" y="0.75" width="43.5" height="43.5" rx="11.5" stroke="${text}" pathLength="100" stroke-dasharray="${left * 100} 100"/></svg>
<div class="dot" data-close style="background:${t.dot}">✕</div></div>`
  }).join('')
}

function changed() {
  render()
  emit('toasts-count', toasts.length)
}

function tick() {
  const now = performance.now()
  const before = toasts.length
  toasts = toasts.filter((t) => t.held || now - t.start < SECONDS * 1000)
  if (toasts.length !== before) changed()
  else render()
  if (toasts.length) requestAnimationFrame(tick)
}

tauri?.event.listen('toast-add', ({ payload }) => {
  // One per session: a new one replaces that session's old one, newest on top
  toasts = [{ ...payload, start: performance.now(), held: false }, ...toasts.filter((t) => t.id !== payload.id)].slice(0, MAX)
  changed()
  requestAnimationFrame(tick)
})
tauri?.event.listen('toast-remove', ({ payload }) => {
  const before = toasts.length
  toasts = toasts.filter((t) => t.id !== payload)
  if (toasts.length !== before) changed()
})

// Outside Tauri, ?demo draws three popups part-way through their countdown, for screenshots
if (!tauri && location.search.includes('demo')) {
  const now = performance.now()
  toasts = [
    { id: 'a', n: '02', kind: 1, name: 'web · Fix login', detail: 'Review the copy', fill: '#F472B6', ink: '#0B0B0C', dot: '#E8A93A', dark: true, start: now },
    { id: 'b', n: '01', kind: 0, name: 'api · Limits', detail: 'Allow: run the migration', fill: '#E8A93A', ink: '#1A1203', dot: '#E8A93A', dark: true, start: now - 3000 },
    { id: 'c', n: '04', kind: 2, name: 'docs', detail: 'Published', fill: '#2EC4B6', ink: '#0B0B0C', dot: '#8D8E91', dark: true, start: now - 6000 },
  ]
  toasts.forEach((t) => { t.held = true; t.heldAt = now })
  render()
}
const stack = document.getElementById('stack')
stack.addEventListener('click', (e) => {
  const el = e.target.closest('.toast')
  if (!el) return
  const id = el.dataset.id
  toasts = toasts.filter((t) => t.id !== id)
  changed()
  if (!e.target.closest('[data-close]')) emit('toast-open', id)
})
// Hovering a popup holds its countdown; the others keep going
stack.addEventListener('mouseover', (e) => {
  const id = e.target.closest('.toast')?.dataset.id
  for (const t of toasts) {
    if (t.id === id && !t.held) { t.held = true; t.heldAt = performance.now() }
    if (t.id !== id && t.held) { t.start += performance.now() - t.heldAt; t.held = false }
  }
})
stack.addEventListener('mouseleave', () => {
  for (const t of toasts) if (t.held) { t.start += performance.now() - t.heldAt; t.held = false }
})

// The show-or-hide shortcut: keys Tauri's global shortcuts take ("Ctrl+Alt+S"), or on macOS a
// right-hand modifier tapped on its own ("tap:61"). Labels, recording a new one from key events,
// and the clashes worth a warning.

export const DEFAULT_SHORTCUT = 'Ctrl+Alt+S'
// Right-hand modifiers by macOS key code, and the key event codes that are them
export const TAPS = { 61: 'Right ⌥', 54: 'Right ⌘', 62: 'Right ⌃' }
const TAP_CODES = { AltRight: 61, MetaRight: 54, ControlRight: 62 }
const MAC_SYMBOLS = { Ctrl: '⌃', Alt: '⌥', Shift: '⇧', Cmd: '⌘' }
const ORDER = ['Ctrl', 'Alt', 'Shift', 'Cmd']

export function label(keys, platform) {
  if (keys.startsWith('tap:')) return TAPS[keys.slice(4)] ?? 'Right modifier'
  const parts = keys.split('+')
  const key = parts.pop()
  if (platform !== 'macos') return [...parts.map((p) => (p === 'Cmd' ? 'Win' : p)), key].join('+')
  return parts.map((p) => MAC_SYMBOLS[p] ?? p).join('') + key
}

// A key event's key as Tauri names it: S, 5, F5, Space, Up…
function keyName(code) {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3)
  if (/^Digit\d$/.test(code)) return code.slice(5)
  if (/^F\d{1,2}$/.test(code)) return code
  const named = { Space: 'Space', Enter: 'Enter', Tab: 'Tab', Backspace: 'Backspace', Delete: 'Delete', ArrowLeft: 'Left', ArrowRight: 'Right', ArrowUp: 'Up', ArrowDown: 'Down', Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown', Minus: '-', Equal: '=', Comma: ',', Period: '.', Slash: '/', Semicolon: ';', Quote: "'", BracketLeft: '[', BracketRight: ']', Backslash: '\\', Backquote: '`' }
  return named[code] ?? null
}

const MODIFIER_CODES = new Set(['ShiftLeft', 'ShiftRight', 'ControlLeft', 'ControlRight', 'AltLeft', 'AltRight', 'MetaLeft', 'MetaRight', 'CapsLock', 'Fn'])

// Follows key events while recording. feed() answers { keys } for a finished shortcut,
// { problem } for one that won't do, { cancel: true } on Esc, or null while it waits.
export class Recorder {
  constructor(platform) {
    this.platform = platform
    this.tapDown = null
  }

  feed(e) {
    if (e.type === 'keydown' && e.code === 'Escape' && !e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey) return { cancel: true }
    if (e.type === 'keydown' && e.code in TAP_CODES) {
      // A right-hand modifier pressed alone may be a tap: wait for its release
      const alone = [e.ctrlKey && e.code !== 'ControlRight', e.altKey && e.code !== 'AltRight', e.metaKey && e.code !== 'MetaRight', e.shiftKey].every((x) => !x)
      this.tapDown = alone ? { code: e.code, at: e.timeStamp } : null
      return null
    }
    if (e.type === 'keyup' && this.tapDown && e.code === this.tapDown.code) {
      const quick = e.timeStamp - this.tapDown.at < 500
      this.tapDown = null
      if (!quick) return null
      if (this.platform !== 'macos') return { problem: 'Tapping a modifier on its own works only on a Mac for now.' }
      return { keys: 'tap:' + TAP_CODES[e.code] }
    }
    if (e.type !== 'keydown' || MODIFIER_CODES.has(e.code)) return null
    this.tapDown = null
    const key = keyName(e.code)
    if (!key) return { problem: "That key can't be a shortcut." }
    const mods = { Ctrl: e.ctrlKey, Alt: e.altKey, Shift: e.shiftKey, Cmd: e.metaKey }
    const held = ORDER.filter((m) => mods[m])
    const isF = /^F\d{1,2}$/.test(key)
    if (!isF && !held.some((m) => m !== 'Shift')) {
      return { problem: `Use ${this.platform === 'macos' ? '⌘, ⌃ or ⌥' : 'Ctrl, Alt or Win'} with it, so it doesn't fire while you type.` }
    }
    return { keys: [...held, key].join('+') }
  }
}

// Shortcuts the system or most apps already use: taking one over is worth a warning
const COMMON = {
  macos: { 'Cmd+Q': 'Quit', 'Cmd+W': 'Close window', 'Cmd+Tab': 'switching apps', 'Cmd+Space': 'Spotlight', 'Cmd+C': 'Copy', 'Cmd+V': 'Paste', 'Cmd+X': 'Cut', 'Cmd+Z': 'Undo', 'Cmd+A': 'Select All', 'Cmd+S': 'Save', 'Cmd+N': 'New', 'Cmd+T': 'New Tab', 'Cmd+H': 'Hide', 'Cmd+M': 'Minimize', 'Cmd+F': 'Find', 'Cmd+P': 'Print', 'Ctrl+Space': 'switching input sources', 'Alt+Cmd+Escape': 'Force Quit', 'Ctrl+Cmd+Q': 'Lock Screen', 'Shift+Cmd+3': 'a screenshot', 'Shift+Cmd+4': 'a screenshot', 'Shift+Cmd+5': 'Screenshot' },
  windows: { 'Alt+Tab': 'switching windows', 'Alt+F4': 'closing a window', 'Ctrl+C': 'Copy', 'Ctrl+V': 'Paste', 'Ctrl+X': 'Cut', 'Ctrl+Z': 'Undo', 'Ctrl+A': 'Select All', 'Ctrl+S': 'Save', 'Ctrl+W': 'Close', 'Ctrl+T': 'New Tab', 'Ctrl+N': 'New', 'Ctrl+F': 'Find', 'Ctrl+P': 'Print', 'Cmd+L': 'locking the PC', 'Cmd+D': 'showing the desktop', 'Cmd+E': 'File Explorer', 'Cmd+R': 'Run', 'Ctrl+Shift+Escape': 'Task Manager' },
}
COMMON.linux = { ...COMMON.windows, 'Cmd+L': 'locking the screen', 'Ctrl+Alt+T': 'a terminal', 'Ctrl+Alt+L': 'locking the screen' }

export function clash(keys, platform) {
  const name = (COMMON[platform] ?? COMMON.linux)[keys]
  return name ? `${label(keys, platform)} is ${name} in ${platform === 'macos' ? 'macOS' : 'most apps'}. Session Board would take it over everywhere.` : null
}

// The SwiftUI app's shortcut (Carbon key code and modifiers, and its label), as keys here
export function fromLegacy(keyCode, mods, key) {
  if (!mods && TAPS[keyCode]) return 'tap:' + keyCode
  const held = [mods & 4096 && 'Ctrl', mods & 2048 && 'Alt', mods & 512 && 'Shift', mods & 256 && 'Cmd'].filter(Boolean)
  const names = { '←': 'Left', '→': 'Right', '↑': 'Up', '↓': 'Down', '↩': 'Enter', '⇥': 'Tab', '⌫': 'Backspace', '⌦': 'Delete', Space: 'Space' }
  return held.length || /^F\d+$/.test(key) ? [...held, names[key] ?? key].join('+') : DEFAULT_SHORTCUT
}

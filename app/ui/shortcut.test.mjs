// node --test ui/shortcut.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { label, Recorder, clash, fromLegacy } from './shortcut.js'

const key = (code, mods = {}, type = 'keydown', timeStamp = 0) => ({ type, code, timeStamp, ctrlKey: !!mods.ctrl, altKey: !!mods.alt, shiftKey: !!mods.shift, metaKey: !!mods.cmd })

test('labels', () => {
  assert.equal(label('Ctrl+Alt+S', 'macos'), '⌃⌥S')
  assert.equal(label('Ctrl+Alt+S', 'windows'), 'Ctrl+Alt+S')
  assert.equal(label('Shift+Cmd+K', 'windows'), 'Shift+Win+K')
  assert.equal(label('tap:61', 'macos'), 'Right ⌥')
})

test('recording keys, a tap, Esc, and keys that won\'t do', () => {
  const r = new Recorder('macos')
  assert.deepEqual(r.feed(key('KeyS', { ctrl: true, alt: true })), { keys: 'Ctrl+Alt+S' })
  assert.deepEqual(r.feed(key('F5')), { keys: 'F5' })
  assert.match(r.feed(key('KeyS', { shift: true })).problem, /⌘, ⌃ or ⌥/)
  assert.deepEqual(r.feed(key('Escape')), { cancel: true })
  assert.equal(r.feed(key('AltRight', { alt: true }, 'keydown', 100)), null)
  assert.deepEqual(r.feed(key('AltRight', {}, 'keyup', 300)), { keys: 'tap:61' })
  // Held too long, or with another modifier: not a tap
  r.feed(key('AltRight', { alt: true }, 'keydown', 0))
  assert.equal(r.feed(key('AltRight', {}, 'keyup', 900)), null)
  r.feed(key('MetaRight', { cmd: true, shift: true }, 'keydown', 0))
  assert.equal(r.feed(key('MetaRight', {}, 'keyup', 100)), null)
  // Windows and Linux: a tap is recognised but not offered yet
  const w = new Recorder('windows')
  assert.equal(w.feed(key('AltRight', { alt: true }, 'keydown', 0)), null)
  assert.match(w.feed(key('AltRight', {}, 'keyup', 100)).problem, /only on a Mac/)
})

test('clashes and the SwiftUI app\'s shortcut', () => {
  assert.match(clash('Cmd+Q', 'macos'), /Quit in macOS/)
  assert.equal(clash('Ctrl+Alt+S', 'macos'), null)
  assert.match(clash('Alt+F4', 'windows'), /closing a window/)
  assert.equal(fromLegacy(61, 0, 'Right ⌥'), 'tap:61')
  assert.equal(fromLegacy(1, 4096 | 2048, 'S'), 'Ctrl+Alt+S')
  assert.equal(fromLegacy(123, 256 | 512, '←'), 'Shift+Cmd+Left')
})

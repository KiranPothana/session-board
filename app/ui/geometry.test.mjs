// node --test ui/geometry.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { defaultFrame, fits, edgesAt } from './geometry.js'

test('on the Mac it was tuned on, the default is exactly that size and place', () => {
  // Usable area 1728 x 1025 below a 59 pt menu bar (in top-left coordinates, y starts at 0 under it)
  assert.deepEqual(defaultFrame({ x: 0, y: 0, width: 1728, height: 1025 }), { x: 1398, y: 235, width: 330, height: 705 })
  assert.deepEqual(defaultFrame({ x: 0, y: 0, width: 1728, height: 1025 }, true), { x: 482, y: 284, width: 764, height: 458 })
})

test('it scales with the screen, within limits', () => {
  const big = defaultFrame({ x: 0, y: 0, width: 2560, height: 1400 })
  assert.equal(big.width, Math.round(2560 * 330 / 1728))
  assert.equal(big.height, 900)
  assert.equal(big.x + big.width, 2560)
  const small = defaultFrame({ x: 0, y: 40, width: 1280, height: 680 })
  assert.equal(small.width, 300)
  assert.equal(small.height, Math.round(680 * 705 / 1025))
  assert.ok(small.y >= 40 && small.y + small.height <= 720)
  // A second screen to the left keeps its own coordinates
  const left = defaultFrame({ x: -1920, y: 0, width: 1920, height: 1040 })
  assert.equal(left.x + left.width, 0)
})

test('a saved frame is used only while it is on the screen', () => {
  const area = { x: 0, y: 0, width: 1728, height: 1025 }
  assert.equal(fits({ x: 1398, y: 235, width: 330, height: 705 }, area), true)
  assert.equal(fits({ x: 3000, y: 235, width: 330, height: 705 }, area), false)
  assert.equal(fits(null, area), false)
})

test('resizing from the edges and corners, sideways only when collapsed', () => {
  assert.equal(edgesAt(2, 300, 330, 705), 'West')
  assert.equal(edgesAt(328, 300, 330, 705), 'East')
  assert.equal(edgesAt(200, 703, 330, 705), 'South')
  assert.equal(edgesAt(10, 2, 330, 705), 'NorthWest')
  assert.equal(edgesAt(2, 10, 330, 705), 'NorthWest')
  assert.equal(edgesAt(320, 700, 330, 705), 'SouthEast')
  assert.equal(edgesAt(150, 300, 330, 705), null)
  assert.equal(edgesAt(200, 2, 330, 60, true), null)
  assert.equal(edgesAt(2, 30, 330, 60, true), 'West')
})

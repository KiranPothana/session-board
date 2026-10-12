// node --test ui/model.test.mjs: the board's rules, against the macOS app's behaviour
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildRows, partition, autoRestore, shownName, sharedPrefixes, cardLines, stillRunning, sessionText, assignColors, inkFor, ago, AUTO_ORDER } from './model.js'

const NOW = 1_800_000_000_000
const reg = (id, extra = {}) => ({ [`${id}.json`]: { sessionId: id, pid: 1, cwd: `/u/${id}`, name: id, status: 'idle', statusUpdatedAt: NOW - 60_000, startedAt: NOW - 3_600_000, ...extra } })
const store = (...recs) => ({ 'session-board_x.json': Object.fromEntries(recs.map((r) => [`s:${r.id}`, { updatedAt: NOW - 1000, ...r }])) })

test('ago', () => {
  assert.deepEqual([0, 59, 60, 3599, 3600, 47 * 3600, 48 * 3600].map(ago), ['now', 'now', '1m', '59m', '1h', '47h', '2d'])
})

test('needs you, then working, then idle; inside each, the most recent first', () => {
  const rows = buildRows({
    now: NOW,
    registry: { ...reg('a', { status: 'idle', statusUpdatedAt: NOW - 10_000 }), ...reg('b', { status: 'busy', statusUpdatedAt: NOW - 50_000 }), ...reg('c', { status: 'waiting', statusUpdatedAt: NOW - 90_000 }), ...reg('d', { status: 'busy', statusUpdatedAt: NOW - 5_000 }) },
  })
  assert.deepEqual(rows.map((r) => r.id), ['c', 'd', 'b', 'a'])
})

test("a session's own record decides its status; a catch-up copy doesn't", () => {
  const rows = buildRows({ now: NOW, registry: { ...reg('a', { status: 'busy' }), ...reg('b', { status: 'busy' }) }, store: store({ id: 'a', status: 'needs-you', statusSince: NOW - 1000 }, { id: 'b', status: 'idle', shadow: true }) })
  assert.equal(rows.find((r) => r.id === 'a').status, 'needs-you')
  assert.equal(rows.find((r) => r.id === 'b').status, 'working')
})

test('a turn that ended counts as idle, unless the registry changed after it', () => {
  const ended = buildRows({ now: NOW, registry: reg('a', { status: 'busy', statusUpdatedAt: NOW - 5000 }), store: store({ id: 'a', shadow: true, turnEnded: true, updatedAt: NOW - 1000 }) })
  assert.equal(ended[0].status, 'idle')
  const newer = buildRows({ now: NOW, registry: reg('a', { status: 'busy', statusUpdatedAt: NOW - 500 }), store: store({ id: 'a', shadow: true, turnEnded: true, updatedAt: NOW - 1000 }) })
  assert.equal(newer[0].status, 'working')
})

test('records of sessions no longer live are dropped; the 10-minute rule only without a registry', () => {
  assert.deepEqual(buildRows({ now: NOW, registry: {}, store: store({ id: 'gone' }) }), [])
  const unreadable = buildRows({ now: NOW, registryReadable: false, store: store({ id: 'fresh', updatedAt: NOW - 60_000 }, { id: 'old', updatedAt: NOW - 700_000 }) })
  assert.deepEqual(unreadable.map((r) => r.id), ['fresh'])
})

test("a placeholder name gives way to Claude's title for the chat", () => {
  const rows = buildRows({ now: NOW, registry: reg('a', { name: 'a', nameSource: 'derived' }), store: store({ id: 'a', title: 'Fix the login' }) })
  assert.equal(rows[0].name, 'Fix the login')
})

test('waits on you only while idle; the phrase comes off the text', () => {
  const rec = { id: 'a', summary: { active: ['Writing tests'], pending: ['Review the copy · waits on you', 'Release'] } }
  const idle = buildRows({ now: NOW, registry: reg('a'), store: store(rec) })[0]
  assert.deepEqual(idle.items.map((i) => [i.text, i.active, i.waitsOnYou]), [['Writing tests', true, false], ['Review the copy', false, true], ['Release', false, false]])
  const working = buildRows({ now: NOW, registry: reg('a', { status: 'busy' }), store: store(rec) })[0]
  assert.equal(working.items[1].waitsOnYou, false)
})

test("the session's own task list wins over the summary", () => {
  const row = buildRows({ now: NOW, registry: reg('a'), store: store({ id: 'a', tasks: [{ subject: 'Do it', status: 'in_progress' }, { subject: 'Done', status: 'completed' }], summary: { active: ['x'] } }) })[0]
  assert.equal(row.fromTaskList, true)
  assert.deepEqual(row.items.map((i) => i.text), ['Do it'])
})

test('quiet after 12 idle hours; dismissed ones go to Dismissed even when quiet; counts are over what shows', () => {
  const rows = buildRows({ now: NOW, registry: { ...reg('a', { statusUpdatedAt: NOW - 13 * 3_600_000 }), ...reg('b', { status: 'busy' }), ...reg('c', { status: 'waiting' }) } })
  const p = partition(rows, ['a', 'c'])
  assert.deepEqual(p.shown.map((r) => r.id), ['b'])
  assert.deepEqual(p.hidden.map((r) => r.id).sort(), ['a', 'c'])
  assert.deepEqual([p.needsYou, p.working, p.idle], [0, 1, 0])
})

test('a dismissed session comes back when it needs you after you dismissed it', () => {
  const rows = buildRows({ now: NOW, registry: reg('a', { status: 'waiting', statusUpdatedAt: NOW - 30_000 }) })
  // dismissedAt is when you dismissed it (epoch seconds). Dismissed 60 s ago, needs you since 30 s ago: back
  assert.deepEqual(autoRestore(rows, ['a'], { a: NOW / 1000 - 60 }, NOW), [])
  // Dismissed 10 s ago, already needed you: stays dismissed
  assert.deepEqual(autoRestore(rows, ['a'], { a: NOW / 1000 - 10 }, NOW), ['a'])
})

test('names start with the project, unless they already do; shared prefixes go grey', () => {
  const r = (id, name, project) => ({ id, name, project })
  assert.equal(shownName(r('a', 'Fix login', 'web-app')), 'web-app · Fix login')
  assert.equal(shownName(r('a', 'Web App tests', 'web-app')), 'Web App tests')
  assert.equal(shownName(r('a', 'Fix login', 'web-app'), false), 'Fix login')
  const prefixes = sharedPrefixes([r('a', 'Fix login', 'web'), r('b', 'Fix tests', 'web'), r('c', 'Docs', 'api')])
  assert.equal(prefixes.a, 'web · Fix ')
  assert.equal(prefixes.c, 'api · ')
})

test("a card's lines, in the macOS app's order", () => {
  const base = { items: [], justDid: '', side: '', paused: '', ask: '', request: '', hasMod: true, fromTaskList: false, agentsRunning: 0, workflowsRunning: 0 }
  const working = { ...base, status: 'working', side: 'Fix the bug', paused: 'Light theme', justDid: 'Drew it', items: [{ text: 'Testing', active: true }, { text: 'Ship', active: false }] }
  assert.deepEqual(cardLines(working).map((l) => l.kind), ['side', 'paused', 'doing', 'done', 'next'])
  const idle = { ...base, status: 'idle', justDid: 'Opened PR', workflowsRunning: 1, items: [{ text: 'Was doing', active: true }, { text: 'Review', active: false, waitsOnYou: true }] }
  const lines = cardLines(idle, { jobs: [{ label: 'browser tests', minutes: 6 }] })
  assert.deepEqual(lines.map((l) => [l.kind, l.glyph]), [['running', '◷'], ['done', '✓'], ['next', '·'], ['waits', '!']])
  assert.equal(lines[0].text, 'Browser tests, a workflow still running · 6m')
  assert.deepEqual(cardLines({ ...base, status: 'idle', request: 'find big files' }).map((l) => l.text), ['You asked: “find big files”'])
  assert.deepEqual(cardLines({ ...base, status: 'idle', hasMod: false }).map((l) => l.text), ['No task data yet'])
  assert.deepEqual(cardLines({ ...working, side: '' }, { removed: ['Ship'] }).map((l) => l.text), ['Testing', 'Drew it'])
})

test('still running reads naturally', () => {
  const row = { agentsRunning: 2, workflowsRunning: 0 }
  assert.equal(stillRunning(row), '2 background agents still running')
  assert.equal(stillRunning({ agentsRunning: 0, workflowsRunning: 0 }), '')
})

test('copy session', () => {
  const row = { id: 'a', name: 'Fix login', project: 'web', place: 'web', status: 'idle', since: 120, items: [{ text: 'Review', active: false, waitsOnYou: true }], justDid: 'Fixed it', side: '', paused: '', ask: '', request: '', hasMod: true, fromTaskList: false, agentsRunning: 0, workflowsRunning: 0 }
  assert.equal(sessionText(row), 'web · Fix login (idle 2m · web)\n✓ Fixed it\n! Review · waits on you')
})

test('automatic colours: sticky, distinct, never a state colour', () => {
  const rows = [{ id: 'a' }, { id: 'b' }, { id: 'c' }]
  const auto = assignColors(rows, {}, {}, () => 0)
  assert.equal(new Set(Object.values(auto)).size, 3)
  for (const c of Object.values(auto)) assert.ok(AUTO_ORDER.includes(c))
  assert.deepEqual(assignColors(rows, {}, auto, () => 0.99), auto)
  // A colour you picked counts as in use
  const withPick = assignColors([{ id: 'a' }, { id: 'b' }], { a: 'Blue' }, {}, () => 0)
  assert.notEqual(withPick.b, 'Blue')
})

test('ink on a tile', () => {
  assert.equal(inkFor('#F5C542'), '#0B0B0C')
  assert.equal(inkFor('#1F5C96'), '#FFFFFF')
})

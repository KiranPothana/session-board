// node --test ui/model.test.mjs: the board's rules, against the macOS app's behaviour
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildRows, partition, autoRestore, shownName, sharedPrefixes, cardLines, stillRunning, runningItems, sessionText, assignColors, inkFor, ago, AUTO_ORDER } from './model.js'

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

test('a quiet session shows while you view it and for 12 hours after you open it', () => {
  const rows = buildRows({ now: NOW, registry: reg('a', { statusUpdatedAt: NOW - 13 * 3_600_000 }) })
  assert.deepEqual(partition(rows, [], { now: NOW }).shown, [])
  assert.deepEqual(partition(rows, [], { focusedId: 'a', now: NOW }).shown.map((r) => r.id), ['a'])
  assert.deepEqual(partition(rows, [], { openedAt: { a: NOW / 1000 - 3600 }, now: NOW }).shown.map((r) => r.id), ['a'])
  assert.deepEqual(partition(rows, [], { openedAt: { a: NOW / 1000 - 13 * 3600 }, now: NOW }).shown, [])
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
  assert.equal(lines[0].text, 'Still running: browser tests, +1 more · 6m')
  assert.deepEqual(cardLines({ ...base, status: 'idle', request: 'find big files' }).map((l) => l.text), ['You asked: “find big files”'])
  assert.deepEqual(cardLines({ ...base, status: 'idle', hasMod: false }).map((l) => l.text), ['No task data yet'])
  assert.deepEqual(cardLines({ ...working, side: '' }, { removed: ['Ship'] }).map((l) => l.text), ['Testing', 'Drew it'])
})

test('still running: one line, by the description Claude gave each command, however many run', () => {
  assert.equal(stillRunning({ agentsRunning: 2, workflowsRunning: 0 }), 'Still running: 2 background agents')
  assert.equal(stillRunning({ agentsRunning: 0, workflowsRunning: 0 }), '')
  const row = { agentsRunning: 1, workflowsRunning: 0, runningLabels: { 'npm test': 'run the unit tests', 'gh run watch 7': 'wait for the release build' } }
  const jobs = [{ label: 'tests', minutes: 2, key: 'npm test' }, { label: 'a command', minutes: 9, key: 'gh run watch 7' }, { label: 'a build', minutes: 1, key: 'cargo build' }]
  assert.equal(stillRunning(row, jobs), 'Still running: wait for the release build, +3 more · 9m')
  assert.deepEqual(runningItems(row, jobs), ['wait for the release build', 'run the unit tests', 'a build', 'a background agent'])
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

import { Attention, soundFor, NEEDS_YOU, YOUR_TURN, DONE } from './model.js'

const r = (id, status, extra = {}) => ({ id, status, items: [], agentsRunning: 0, workflowsRunning: 0, justDid: '', ask: '', ...extra })

test('a status counts after two reads; the first one seen says nothing', () => {
  const a = new Attention()
  assert.deepEqual(a.step([r('a', 'needs-you')]), [])
  assert.deepEqual(a.step([r('a', 'needs-you')]), [])
  a.step([r('a', 'working')])
  assert.deepEqual(a.step([r('a', 'working')]), [])
  assert.deepEqual(a.step([r('a', 'needs-you')]), [])
  assert.deepEqual(a.step([r('a', 'needs-you')]).map((e) => e.kind), [NEEDS_YOU])
})

test('a blip of one read is ignored', () => {
  const a = new Attention()
  a.step([r('a', 'working')]); a.step([r('a', 'working')])
  a.step([r('a', 'needs-you')])
  assert.deepEqual(a.step([r('a', 'working')]), [])
  assert.deepEqual(a.step([r('a', 'working')]), [])
})

test('your turn when an ended turn leaves something waiting on you, within 90 s', () => {
  const a = new Attention(); const t = 1_000_000
  a.step([r('a', 'working')], { now: t }); a.step([r('a', 'working')], { now: t })
  a.step([r('a', 'idle')], { now: t + 2000 })
  assert.deepEqual(a.step([r('a', 'idle')], { now: t + 4000 }), [])
  const waiting = r('a', 'idle', { items: [{ text: 'Review it', waitsOnYou: true }] })
  assert.deepEqual(a.step([waiting], { now: t + 10_000 }).map((e) => e.kind), [YOUR_TURN])
  assert.deepEqual(a.step([waiting], { now: t + 12_000 }), [])
})

test('done 15 s after the turn ends, once nothing is still running', () => {
  const a = new Attention(); const t = 1_000_000
  a.step([r('a', 'working')], { now: t }); a.step([r('a', 'working')], { now: t })
  a.step([r('a', 'idle')], { now: t }); a.step([r('a', 'idle')], { now: t })
  assert.deepEqual(a.step([r('a', 'idle')], { now: t + 10_000 }), [])
  assert.deepEqual(a.step([r('a', 'idle')], { now: t + 20_000, jobs: { a: [{ label: 'tests', minutes: 1 }] } }), [])
  assert.deepEqual(a.step([r('a', 'idle')], { now: t + 30_000 }).map((e) => e.kind), [DONE])
})

test('never for the session you are viewing', () => {
  const a = new Attention()
  a.step([r('a', 'working')]); a.step([r('a', 'working')])
  a.step([r('a', 'needs-you')], { focusedId: 'a' })
  assert.deepEqual(a.step([r('a', 'needs-you')], { focusedId: 'a' }), [])
})

test('one sound at a time: the most urgent, at most every 8 s, only switched-on moments', () => {
  const ev = [{ kind: DONE }, { kind: NEEDS_YOU }]
  assert.equal(soundFor(ev, { moments: [true, true, true] }), NEEDS_YOU)
  assert.equal(soundFor(ev, { moments: [false, true, true] }), DONE)
  assert.equal(soundFor(ev, { moments: [true, true, true], lastSoundAt: 1000, now: 5000 }), null)
  assert.equal(soundFor(ev, { soundsOn: false }), null)
  assert.equal(soundFor([{ kind: DONE }]), null)
})

import { focusedFrom, sameName, parseCrash, otherNames } from './model.js'

test('the session you are looking at', () => {
  const rows = [{ id: 'a', name: 'Fix login', pid: 10, since: 50 }, { id: 'b', name: 'Fix login', pid: 11, since: 5 }, { id: 'c', name: 'Docs', pid: 12, since: 9 }]
  assert.equal(sameName('Don’t panic', "don't  PANIC"), true)
  // Desktop: by name, the most recent of two the same; a chat not on the board highlights nothing
  assert.equal(focusedFrom({ desktopName: 'fix login' }, rows, null), 'b')
  assert.equal(focusedFrom({ desktopName: 'Something else' }, rows, 'c'), null)
  assert.equal(focusedFrom({ desktopName: null }, rows, 'c'), undefined)
  // Terminal: by pid; of several, the one the window title names; else keep the current one
  assert.equal(focusedFrom({ pids: [12], title: 'zsh' }, rows, null), 'c')
  assert.equal(focusedFrom({ pids: [10, 12], title: '✳ Docs' }, rows, null), 'c')
  assert.equal(focusedFrom({ pids: [10, 12], title: 'zsh' }, rows, 'a'), 'a')
  assert.equal(focusedFrom({ pids: [], title: 'Safari' }, rows, 'a'), undefined)
  assert.equal(focusedFrom(null, rows, 'a'), undefined)
})

test('crash reports: the exception and the crashed thread, from an .ips or a panic', () => {
  const ips = '{"app_name":"session-board"}\n' + JSON.stringify({
    exception: { type: 'EXC_BREAKPOINT', signal: 'SIGTRAP' }, usedImages: [{ name: 'session-board' }],
    threads: [{ frames: [] }, { triggered: true, frames: [{ imageIndex: 0, symbol: 'main', sourceFile: 'main.rs', sourceLine: 9 }] }],
  })
  const c = parseCrash('ips', ips, { at: 0, version: '0.2.0', os: 'macos' })
  assert.equal(c.title, 'Window app crashed: EXC_BREAKPOINT')
  assert.match(c.details, /session-board main \(main\.rs:9\)/)
  assert.match(c.details, /- Session Board: 0\.2\.0/)
  const p = parseCrash('panic', "panicked at src/main.rs:5:1:\nboom\n\nSession Board 0.2.0", { at: 0 })
  assert.equal(p.title, 'Window app crashed: src/main.rs:5:1:')
  assert.equal(parseCrash('ips', 'not json'), null)
})

test('a session renamed since Claude Desktop named it is still found by the name Desktop shows', () => {
  const rows = [
    { id: 'old', name: 'OTC · Fix login', otherNames: otherNames('OTC · Fix login', 'OTC', ['Fix login']), since: 5 },
    { id: 'web', name: 'web · Ship the site', otherNames: otherNames('web · Ship the site', 'web', []), since: 9 },
    { id: 'same', name: 'Fix login', otherNames: [], since: 50 },
  ]
  // A session whose current name matches wins over another's former name
  assert.equal(focusedFrom({ desktopName: 'Fix login' }, rows, null), 'same')
  assert.equal(focusedFrom({ desktopName: 'Fix login' }, rows.slice(0, 2), null), 'old')
  // The name without the project in front
  assert.equal(focusedFrom({ desktopName: 'Ship the site' }, rows, null), 'web')
  assert.deepEqual(otherNames('web · Ship it', 'web', [null, 'web · Ship it', 'Draft']), ['Draft', 'Ship it'])
  assert.deepEqual(otherNames('Plain name', 'web', []), [])
})

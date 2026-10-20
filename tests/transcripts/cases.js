// Recorded conversations (anonymised by anonymise.mjs) and what the mod must make of each: the
// record the board reads, and what the summary is shown. Every change runs against all of them
// (tests/session-board.test.ts). Add the case of every bug fixed here.
import longTurnQuestion from './long-turn-question.js'
import finishedNothingPending from './finished-nothing-pending.js'
import turnEndedRunsGoing from './turn-ended-runs-going.js'
import permissionPrompt from './permission-prompt.js'
import idleOpenTasksQuestion from './idle-open-tasks-question.js'

// The other session's registry entry, as Claude Code writes it: "shell" while a command it left
// running goes on, "waiting" on a prompt, "idle" when nothing runs
const registry = (status, extra = {}) => ({ pid: 202, sessionId: 'sess-other', cwd: '/work/site', name: 'Site Fixes', status, updatedAt: 0,
  startedAt: Date.parse('2026-10-18T12:00:00.000Z'), ...extra })

// A background run that failed: its notice, as Claude Code writes it
const failed = JSON.stringify({ type: 'user', timestamp: '2026-10-18T14:10:30.000Z',
  message: { role: 'user', content: '<task-notification>\n<task-id>bub3u8jhk</task-id>\n<status>failed</status>\n</task-notification>' } })

export default [
  {
    // 2026-10-18: a long turn's test output filled the whole read, so the request was never
    // found and the card kept bullets from an hour before
    name: 'a finished turn that asks you something, after a long turn',
    lines: longTurnQuestion, registry: registry('idle'),
    record: { turnEnded: true, commandsRunning: 0, request: 'the screens look good, build the notices' },
    prompt: ['the screens look good, build the notices', 'Should I go ahead?'],
  },
  {
    name: 'a finished turn with nothing pending',
    lines: finishedNothingPending, registry: registry('idle'),
    record: { turnEnded: true, commandsRunning: 0, agentsRunning: 0, request: 'ship it' },
    prompt: ['Shipped. The tab shows on desktop and mobile.'],
    lacks: ['a background command'],
  },
  {
    // 2026-10-18: the board missed the session's own test runs and called it done
    name: 'a turn that ended with its background runs still going',
    lines: turnEndedRunsGoing, registry: registry('shell'),
    record: { turnEnded: true, commandsRunning: 1 },
    prompt: ["I'll commit when they finish", '--- Commands this session left running: a background command'],
  },
  {
    name: 'a background run that never reported back, with the session idle',
    lines: turnEndedRunsGoing, registry: registry('idle'),
    record: { turnEnded: true, commandsRunning: 0 },
  },
  {
    name: 'a background run that failed',
    lines: [...turnEndedRunsGoing, failed], registry: registry('shell'),
    record: { commandsRunning: 0 },
  },
  {
    name: 'a background run from before the session was reopened',
    lines: turnEndedRunsGoing, registry: registry('shell', { startedAt: Date.parse('2026-10-18T14:30:00.000Z') }),
    record: { commandsRunning: 0 },
  },
  {
    name: 'a permission prompt',
    lines: permissionPrompt, registry: registry('waiting'),
    record: { turnEnded: false, request: 'the screens look good, build the notices' },
    asks: true,
  },
  {
    // 2026-10-20: a session with an open task list ended its turn asking two things, and the
    // card kept the list and never showed them. Run as this session's own mod, which tracks the
    // task tools (own); `final` is the turn's last reply.
    name: 'a finished turn that asks you to decide, with its task list still open',
    lines: idleOpenTasksQuestion,
    own: { tasks: ['Add the export button', 'Ship the export button'],
      final: 'The export button is in and the tests pass. Before I ship it I need two calls from you: should it export all rows or only the selected ones, and is it OK to deploy to live tonight?' },
    record: { status: 'idle', tasks: [{ id: '7', subject: 'Add the export button', status: 'pending' }, { id: '7', subject: 'Ship the export button', status: 'pending' }] },
    prompt: ['add the export button and get it ready to ship', 'should it export all rows or only the selected ones'],
  },
]

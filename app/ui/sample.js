// Six made-up sessions in the shape the window side reads, like the macOS app's --sample: how the
// page is drawn outside Tauri, for screenshots. ?empty draws none.
export function sampleState(now, params = new URLSearchParams()) {
  const min = 60_000
  const sessions = [
    { id: 'tracker', name: 'Deposit Tracker', project: 'payments', status: 'waiting', ago: 1, chip: 'rc', rec: { status: 'needs-you', ask: 'Allow: deploy v2.4.1 to the sandbox', summary: { done: 'Console suite passed · 1,180 tests', active: [], pending: [] } } },
    { id: 'mobile', name: 'Mobile Build', project: 'payments', status: 'busy', ago: 6, chip: 'rc', rec: { status: 'working', summary: { done: 'Phone layout, Trades tab, money forms', active: ['View-only note on Review and Staff'], pending: ['Test on your iPhone', 'Release: sandbox, then live'] } } },
    { id: 'board', name: 'Session Board', project: 'session-board', status: 'busy', ago: 7, chip: 'rc', rec: { status: 'working', summary: { done: 'Dismiss flow drawn', side: 'Fixing the board/chat status mismatch', paused: 'Light theme and remaining states', active: [], pending: ['Settings panel', 'Sound behaviour, as an mp4'] } } },
    { id: 'seo', name: 'Landing SEO checks', project: 'site', status: 'idle', ago: 22, chip: 'desktop', rec: { status: 'idle', workflowsRunning: 1, summary: { done: 'Opened PR #159 for llms.txt', active: [], pending: ['Review the copy in PR #159 · waits on you', 'Merge PR #159 or hold it · waits on you', 'LinkedIn, Crunchbase and X profiles'] } } },
    { id: 'tests', name: 'Ops console tests', project: 'ops', status: 'busy', ago: 12, chip: 'rc', rec: { status: 'working', tasks: [{ subject: 'Write the Review screen tests', status: 'in_progress' }, { subject: 'Fix the fixture balances', status: 'pending' }, { subject: 'Run the browser suite', status: 'pending' }] } },
    { id: 'cleanup', name: 'Mac storage cleanup', project: 'home', status: 'idle', ago: 180, chip: 'desktop', rec: { status: 'idle', request: 'find what’s using 200 GB in Library' } },
  ]
  const list = params.has('empty') ? [] : sessions
  const registry = {}
  const store = { 'session-board_sample.json': {} }
  for (const s of list) {
    registry[`${s.id}.json`] = { sessionId: s.id, pid: 1, cwd: `/home/you/${s.project}`, name: s.name, status: s.status, statusUpdatedAt: now - s.ago * min, startedAt: now - 3 * 3600_000, ...(s.chip === 'rc' ? { bridgeSessionId: 'session_01' + s.id } : { entrypoint: 'claude-desktop' }) }
    store['session-board_sample.json'][`s:${s.id}`] = { id: s.id, updatedAt: now - 1000, statusSince: now - s.ago * min, cwd: `/home/you/${s.project}`, ...s.rec }
  }
  return { platform: 'browser', now, store, registry, settings: {}, removed: {}, showRequest: 0, projects: {}, jobs: params.has('empty') ? {} : { seo: [{ label: 'browser tests', minutes: 6 }] } }
}

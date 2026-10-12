import { expect, mock, test } from 'claude-code/testing'

const HOME = '/home/k'
const ME = 'sess-me'
const APP = HOME + '/Applications/Session Board.app'
const DATA = HOME + '/Library/Application Support/session-board'
// What shasum prints for board/main.swift and board/build.sh, and the mark build.sh leaves
const SHASUM = 'aaa  /plugin/board/main.swift\nbbb  /plugin/board/build.sh\n'
const BUILT = 'aaa:bbb'

// The registry Claude Code keeps for each live session, one file per process
const REGISTRY: Record<string, object> = {
  '101.json': { pid: 101, sessionId: ME, cwd: '/work/app', name: 'Board Mod', status: 'busy', updatedAt: 0 },
  '202.json': { pid: 202, sessionId: 'sess-other', cwd: '/work/site', name: 'Site Fixes', status: 'idle', updatedAt: 0 },
}

type Opts = {
  // The saved conversation the tail reads, when it should differ by how much is read
  tailFor?: (bytes: number) => string
  // What ps lists of Claude Code's command shells, for the running-jobs check
  ps?: string
  size?: number
  onModel?: () => void
  // A summary call that never answers, while this says so
  hang?: () => boolean
  // Haiku's answer for a prompt; by default one active and one pending item
  answer?: (prompt: string) => { done?: string; active: string[]; pending: string[] }
  registry?: Record<string, object>
  decision?: string
  env?: Record<string, string>
  // The window app: built from the current source, built from older source, or not there
  app?: 'current' | 'stale' | 'missing'
  build?: { exitCode: number; stderr?: string }
  // xcode-select -p's exit code: 0 when Apple's command-line tools are installed
  tools?: number
  runs?: string[][]
  tail?: string
  removed?: Record<string, string[]>
  settings?: object
  prompts?: string[]
  systems?: string[]
  models?: string[]
  writes?: string[][]
  toasts?: string[]
  // The name the model gives a new session
  title?: string
}

// Stub everything the mod asks Claude Code for; returns the shared store
function stubEngine(on: any, opts: Opts = {}) {
  const saved = new Map<string, unknown>()
  const clock = mock.clock(on, { now: 1_000_000 })
  let app = opts.app ?? 'current'
  mock.env(on, { HOME, ...opts.env })
  on('store.get', ($: any, e: any) => ({ value: saved.get(e.key) }))
  on('store.set', ($: any, e: any) => {
    saved.set(e.key, structuredClone(e.value))
    return { value: undefined }
  })
  on('store.delete', ($: any, e: any) => {
    saved.delete(e.key)
    return { value: undefined }
  })
  on('store.keys', () => ({ value: [...saved.keys()] }))
  on('command.register', () => ({ value: undefined }))
  on('session.id', () => ({ value: ME }))
  on('session.cwd', () => ({ value: '/work/app' }))
  on('session.start', () => ({ cwd: '/work/app' }))
  on('session.messages', () => ({
    value: [
      { role: 'user', text: 'build the session pane', toolUses: [] },
      { role: 'assistant', text: 'Built it. Publishing still waits on your go.', toolUses: [] },
    ],
  }))
  on('model.complete', ($: any, e: any) => {
    // Naming a new session
    if (String(e.system).startsWith('You name a Claude Code conversation')) {
      opts.prompts?.push(e.prompt)
      return { value: { isAnswered: true, text: opts.title ?? '"Fix the login page."', usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } }
    }
    opts.onModel?.()
    if (opts.hang?.()) return new Promise(() => {})
    opts.prompts?.push(e.prompt)
    opts.systems?.push(e.system)
    opts.models?.push(e.model + '/' + (e.effort ?? ''))
    const board = opts.answer?.(e.prompt) ?? { active: ['Building the session pane'], pending: ['Publish it · waits on you'] }
    return { value: {
      isAnswered: true,
      text: JSON.stringify(board),
      usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    } }
  })
  const registry = opts.registry ?? REGISTRY
  on('fs.list', () => ({
    value: Object.keys(registry).map((name) => ({ name, kind: 'file', size: 100, isLink: false })),
  }))
  on('fs.read', ($: any, e: any) => {
    const path = String(e.path)
    if (path === DATA + '/removed.json') return opts.removed ? { value: JSON.stringify(opts.removed) } : { deny: 'no such file' }
    if (path === DATA + '/settings.json') return opts.settings ? { value: JSON.stringify(opts.settings) } : { deny: 'no such file' }
    if (path === DATA + '/built.sha') return app === 'missing' ? { deny: 'no such file' } : { value: app === 'current' ? BUILT + '\n' : 'old:old\n' }
    return { value: JSON.stringify(registry[path.split('/').pop()!]) }
  })
  on('fs.exists', ($: any, e: any) => ({ value: e.path === APP && app !== 'missing' }))
  on('process.run', ($: any, e: any) => {
    opts.runs?.push(e.argv)
    const ok = (stdout = '') => ({ value: { exitCode: 0, stdout, stderr: '' } })
    // The running-jobs check, and a saved conversation's end (tail, without the image data)
    if (e.argv[0] === 'sh' && e.argv[1] === '-c' && String(e.argv[2]).startsWith('ps ')) return ok(opts.ps ?? '')
    if (e.argv[0] === 'sh' && e.argv[1] === '-c') return ok(opts.tailFor?.(Number(e.argv[4])) ?? opts.tail ?? '')
    switch (e.argv[0]) {
      case 'shasum': return ok(SHASUM)
      case 'xcode-select': return { value: { exitCode: opts.tools ?? 0, stdout: '', stderr: '' } }
      case 'sh': {
        const r = opts.build ?? { exitCode: 0 }
        if (r.exitCode === 0) app = 'current'
        return { value: { exitCode: r.exitCode, stdout: '', stderr: r.stderr ?? '' } }
      }
      default: return ok()
    }
  })
  on('fs.write', ($: any, e: any) => {
    opts.writes?.push([e.path, e.text])
    return { value: undefined }
  })
  on('fs.stat', () => ({ value: { kind: 'file', size: opts.size ?? (opts.tail ?? '').length, mtimeMs: 5, isLink: false } }))
  on('ui.toast', ($: any, e: any) => {
    opts.toasts?.push(String(e.text ?? e))
    return { value: undefined }
  })
  on('prompt.submit', ($: any, e: any) => ({ text: e.text }))
  on('turn.start', ($: any, e: any) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('tool.check', () => ({ decision: opts.decision ?? 'allow' }))
  on('tool.call', ($: any, e: any) =>
    e.tool === 'TaskCreate'
      ? { result: { task: { id: '7', subject: e.subject } }, text: `Task #7 created successfully: ${e.subject}` }
      : { result: 'ok', text: 'ok' },
  )
  return { saved, clock }
}

const waitFor = async (check: () => boolean) => {
  for (let i = 0; i < 100 && !check(); i++) await new Promise((r) => setTimeout(r, 5))
}

const settle = () => new Promise((r) => setTimeout(r, 30))

const start = ($: any) => $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work/app' })
const startDesktop = ($: any) => $.session.start({ surface: null, isInteractive: false, cwd: '/work/app' })
const DESKTOP = { CLAUDE_CODE_ENTRYPOINT: 'claude-desktop' }

const opens = (runs: string[][]) => runs.filter((r) => r[0] === 'open')
const builds = (runs: string[][]) => runs.filter((r) => r[0] === 'sh' && r[1] !== '-c')
const tailReads = (runs: string[][]) => runs.filter((r) => r[0] === 'sh' && r[1] === '-c' && String(r[2]).startsWith('tail '))

test('a session publishes its request, its step and its status', async ($, on) => {
  const { saved } = stubEngine(on)
  await start($)
  await $.prompt.submit({ text: 'build the session pane\nmore detail', origin: { kind: 'composer' }, wait: false })
  await $.turn.start({ text: 'build the session pane', turnId: 't1' })
  await $.tool.call({ tool: 'Bash', command: 'ls', description: 'List the mod files' })
  await waitFor(() => (saved.get('s:' + ME) as any)?.step === 'Bash: List the mod files')
  const rec: any = saved.get('s:' + ME)
  expect(rec.request).toBe('build the session pane')
  expect(rec.status).toBe('working')
  expect(rec.step).toBe('Bash: List the mod files')
})

test('the task tools give the exact list, with no model call', async ($, on) => {
  let modelCalls = 0
  const { saved } = stubEngine(on, { onModel: () => (modelCalls += 1) })
  await start($)
  await $.turn.start({ text: 'go', turnId: 't1' })
  await $.tool.call({ tool: 'TaskCreate', subject: 'Write the tests', description: 'tests', activeForm: 'Writing tests' })
  await $.tool.call({ tool: 'TaskUpdate', taskId: '7', status: 'in_progress' })
  await $.turn.complete({ turnId: 't1', answer: '', durationMs: 5, isAborted: false, usage: null, reason: 'answer' })
  await waitFor(() => (saved.get('s:' + ME) as any)?.status === 'idle')
  const rec: any = saved.get('s:' + ME)
  expect(rec.tasks).toEqual([{ id: '7', subject: 'Write the tests', status: 'in_progress' }])
  expect(modelCalls).toBe(0)
})

test('after a turn, a small model summarizes active and pending items', async ($, on) => {
  const { saved } = stubEngine(on)
  await start($)
  await $.turn.start({ text: 'go', turnId: 't1' })
  await $.turn.complete({ turnId: 't1', answer: '', durationMs: 5, isAborted: false, usage: null, reason: 'answer' })
  await waitFor(() => !!(saved.get('s:' + ME) as any)?.summary)
  const rec: any = saved.get('s:' + ME)
  expect(rec.summary.active).toEqual(['Building the session pane'])
  expect(rec.summary.pending).toEqual(['Publish it · waits on you'])
})

test('with summaries switched off in the window, no model call is made', async ($, on) => {
  let modelCalls = 0
  const line = (o: object) => JSON.stringify(o)
  const tail = ['cut', line({ type: 'user', message: { content: 'fix the site' } }),
    line({ type: 'assistant', message: { content: [{ type: 'text', text: 'Fixed.' }] } })].join('\n')
  const { saved, clock } = stubEngine(on, { onModel: () => (modelCalls += 1), settings: { summaries: false }, tail })
  await start($)
  await $.turn.start({ text: 'go', turnId: 't1' })
  await $.turn.complete({ turnId: 't1', answer: '', durationMs: 5, isAborted: false, usage: null, reason: 'answer' })
  // The catch-up pass for a session started before the mod stays off the model too
  await clock.advance(30_000)
  await waitFor(() => !!(saved.get('s:sess-other') as any)?.request)
  await settle()
  expect((saved.get('s:sess-other') as any).request).toBe('fix the site')
  expect(modelCalls).toBe(0)
  expect((saved.get('s:' + ME) as any).summary).toBe(null)
})

test('a permission prompt on screen marks the session as needing you; Auto mode checks do not', async ($, on) => {
  const { saved } = stubEngine(on, { decision: 'ask' })
  on('classic.PermissionRequest', () => ({}))
  await start($)
  await $.turn.start({ text: 'go', turnId: 't1' })
  // An "ask" the Auto mode classifier settles: no prompt, so still working
  await $.tool.check({ tool: 'Bash', command: 'du -sh ~' })
  await settle()
  expect((saved.get('s:' + ME) as any).status).toBe('working')
  // The prompt really shows
  await $.classic.PermissionRequest({ hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'rm -rf build' } } as any)
  await waitFor(() => (saved.get('s:' + ME) as any)?.status === 'needs-you')
  expect((saved.get('s:' + ME) as any).status).toBe('needs-you')
})

test('a new message clears "waits on you"', async ($, on) => {
  // Told of the go, Haiku no longer has it wait on the user
  const answer = (prompt: string) =>
    prompt.includes('no reply yet') ? { active: [], pending: ['Publish it'] } : { active: ['Building the session pane'], pending: ['Publish it · waits on you'] }
  const { saved } = stubEngine(on, { answer })
  await start($)
  await $.turn.start({ text: 'go', turnId: 't1' })
  await $.turn.complete({ turnId: 't1', answer: '', durationMs: 5, isAborted: false, usage: null, reason: 'answer' })
  await waitFor(() => !!(saved.get('s:' + ME) as any)?.summary)
  expect((saved.get('s:' + ME) as any).summary.pending).toEqual(['Publish it · waits on you'])
  await $.prompt.submit({ text: 'go ahead', origin: { kind: 'composer' }, wait: false })
  await waitFor(() => (saved.get('s:' + ME) as any)?.summary?.pending?.[0] === 'Publish it')
  expect((saved.get('s:' + ME) as any).summary.pending).toEqual(['Publish it'])
})

test('ending the session removes its record', async ($, on) => {
  const { saved } = stubEngine(on)
  on('session.end', () => ({ sessionId: ME }))
  await start($)
  expect(saved.has('s:' + ME)).toBe(true)
  await $.session.end({ reason: 'prompt_input_exit' })
  expect(saved.has('s:' + ME)).toBe(false)
})

test('a claude -p run keeps no record, makes no model call and opens nothing', async ($, on) => {
  let modelCalls = 0
  const runs: string[][] = []
  const { saved } = stubEngine(on, { onModel: () => (modelCalls += 1), runs })
  await $.session.start({ surface: null, isInteractive: false, cwd: '/work/app' })
  await $.turn.start({ text: 'go', turnId: 't1' })
  await $.tool.call({ tool: 'Bash', command: 'ls' })
  await $.turn.complete({ turnId: 't1', answer: '', durationMs: 5, isAborted: false, usage: null, reason: 'answer' })
  await settle()
  expect([...saved.keys()]).toEqual([])
  expect(modelCalls).toBe(0)
  expect(runs).toEqual([])
})

test('a new session opens the window once, not again on reload', async ($, on) => {
  const runs: string[][] = []
  const { saved } = stubEngine(on, { runs })
  await start($)
  await waitFor(() => opens(runs).length > 0)
  expect(opens(runs)).toEqual([['open', '-g', APP]])
  // Built from the current source already: no build
  expect(builds(runs)).toEqual([])
  await waitFor(() => (saved.get('s:' + ME) as any)?.boardOpened === true)
  // The mod reloads: session.start fires again in the same session
  await start($)
  await settle()
  expect(opens(runs).length).toBe(1)
})

test('a Claude Desktop session opens the window too', async ($, on) => {
  const runs: string[][] = []
  stubEngine(on, { runs, env: DESKTOP })
  await startDesktop($)
  await waitFor(() => opens(runs).length > 0)
  expect(opens(runs)).toEqual([['open', '-g', APP]])
})

test('the first time, the app is built on this Mac and then opened', async ($, on) => {
  const runs: string[][] = []
  const { saved } = stubEngine(on, { runs, app: 'missing' })
  await start($)
  await waitFor(() => opens(runs).length > 0)
  expect(builds(runs).length).toBe(1)
  expect(builds(runs)[0][1]).toMatch(/\/board\/build\.sh$/)
  expect(builds(runs)[0][2]).toBe(APP)
  expect(opens(runs)).toEqual([['open', '-g', APP]])
  // The build lease is given back
  expect(saved.has('lease:build')).toBe(false)
})

test('an update that changes the app source builds it again', async ($, on) => {
  const runs: string[][] = []
  stubEngine(on, { runs, app: 'stale' })
  await start($)
  await waitFor(() => opens(runs).length > 0)
  expect(builds(runs).length).toBe(1)
})

test('while another session builds the app, this one leaves it to that one', async ($, on) => {
  const runs: string[][] = []
  const toasts: string[] = []
  const { saved } = stubEngine(on, { runs, toasts, app: 'missing' })
  saved.set('lease:build', { id: 'sess-other', until: 1_000_000 + 60_000 })
  await start($)
  await settle()
  expect(builds(runs)).toEqual([])
  expect(opens(runs)).toEqual([])
  expect(toasts).toEqual([])
})

test('a failed build says why under the prompt, and keeps the error for a report', async ($, on) => {
  const runs: string[][] = []
  const toasts: string[] = []
  const writes: string[][] = []
  stubEngine(on, { runs, toasts, writes, app: 'missing', build: { exitCode: 1, stderr: 'main.swift:12: error: cannot find type\nmore' } })
  await start($)
  await waitFor(() => toasts.length > 0 && writes.some(([p]) => p.endsWith('/last-error.json')))
  expect(toasts).toEqual(['Session Board: main.swift:12: error: cannot find type · Tell Claude "report the Session Board error" to send it to us'])
  const [, text] = writes.find(([p]) => p === DATA + '/last-error.json')!
  expect(JSON.parse(text)).toMatchObject({ kind: 'build', message: expect.stringContaining('cannot find type') })
  expect(opens(runs)).toEqual([])
})

test('a session started before the mod gets its tasks from its saved conversation', async ($, on) => {
  const runs: string[][] = []
  const line = (o: object) => JSON.stringify(o)
  const tail = [
    'cut-off first line',
    line({ type: 'user', message: { role: 'user', content: 'deploy the site' } }),
    line({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Bash', input: { command: 'deploy.sh', description: 'Deploy the site' } }] } }),
    line({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: 'ok' }] } }),
    line({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Deployed. Going live still waits on your go.' }] } }),
  ].join('\n')
  const { saved, clock } = stubEngine(on, { runs, tail })
  await start($)
  await clock.advance(30_000)
  await waitFor(() => !!(saved.get('s:sess-other') as any)?.summary)
  const rec: any = saved.get('s:sess-other')
  expect(rec.shadow).toBe(true)
  expect(rec.request).toBe('deploy the site')
  expect(rec.summary.active).toEqual(['Building the session pane'])
  expect(tailReads(runs).some((r) => r[5].endsWith('/.claude/projects/-work-site/sess-other.jsonl'))).toBe(true)
})

test('/session-board brings up the window, wherever it was typed', async ($, on) => {
  const runs: string[][] = []
  const writes: string[][] = []
  stubEngine(on, { runs, writes, env: DESKTOP })
  await startDesktop($)
  await waitFor(() => opens(runs).length > 0)
  const result: any = await $.command.run({ command: 'session-board', args: '', origin: { kind: 'bridge' } } as any)
  // It asks the window to show even if you had hidden it
  expect(writes.length).toBe(1)
  expect(writes[0][0]).toBe(DATA + '/show-request')
  expect(Number(writes[0][1])).toBeGreaterThan(0)
  await waitFor(() => opens(runs).length > 1)
  expect(opens(runs)[1]).toEqual(['open', '-g', APP])
  expect(result?.text).toBeUndefined()
})

test("/session-board says how to get Apple's command-line tools when the build needs them", async ($, on) => {
  const runs: string[][] = []
  stubEngine(on, { runs, app: 'missing', tools: 2, env: DESKTOP })
  const result: any = await $.command.run({ command: 'session-board', args: '', origin: { kind: 'bridge' } } as any)
  expect(result.text).toContain('xcode-select --install')
  expect(builds(runs)).toEqual([])
})

test('the record of a session that ended is deleted after ten minutes', async ($, on) => {
  const { saved, clock } = stubEngine(on)
  // Not in the registry, last written long ago
  saved.set('s:sess-gone', { id: 'sess-gone', cwd: '/work/gone', status: 'idle', tasks: [], updatedAt: 1 })
  await start($)
  await clock.advance(30_000)
  await waitFor(() => !saved.has('s:sess-gone'))
  expect(saved.has('s:sess-gone')).toBe(false)
  expect(saved.has('s:' + ME)).toBe(true)
})

test('statusSince moves only when the status changes, not on every tool call', async ($, on) => {
  const { saved, clock } = stubEngine(on)
  await start($)
  await $.turn.start({ text: 'go', turnId: 't1' })
  await waitFor(() => (saved.get('s:' + ME) as any)?.status === 'working')
  const startedAt = (saved.get('s:' + ME) as any).statusSince
  await clock.advance(60_000)
  await $.tool.call({ tool: 'Bash', command: 'ls', description: 'List files' })
  await waitFor(() => (saved.get('s:' + ME) as any)?.step === 'Bash: List files')
  // A minute and a tool call later: still the moment it started working
  expect((saved.get('s:' + ME) as any).statusSince).toBe(startedAt)
  expect((saved.get('s:' + ME) as any).updatedAt).toBeGreaterThan(startedAt)
  await $.turn.complete({ turnId: 't1', answer: '', durationMs: 5, isAborted: false, usage: null, reason: 'answer' })
  await waitFor(() => (saved.get('s:' + ME) as any)?.status === 'idle')
  expect((saved.get('s:' + ME) as any).statusSince).toBeGreaterThan(startedAt)
})

test('a bullet you removed in the window is left out and never comes back', async ($, on) => {
  const prompts: string[] = []
  const { saved } = stubEngine(on, { prompts, removed: { [ME]: ['Publish it'] } })
  await start($)
  await $.turn.start({ text: 'go', turnId: 't1' })
  await $.turn.complete({ turnId: 't1', answer: '', durationMs: 5, isAborted: false, usage: null, reason: 'answer' })
  await waitFor(() => !!(saved.get('s:' + ME) as any)?.summary)
  // Haiku is told, and its answer (which still had it, with "· waits on you") is filtered
  expect(prompts[0]).toContain('Items the user removed from the board (never list these): ["Publish it"]')
  expect((saved.get('s:' + ME) as any).summary.pending).toEqual([])
  expect((saved.get('s:' + ME) as any).summary.active).toEqual(['Building the session pane'])
})

const line = (o: object) => JSON.stringify(o)
const ask = (text: string) => line({ type: 'user', message: { role: 'user', content: text } })
const said = (text: string) => line({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } })
const ran = (name: string, input: object) => line({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', name, input }] } })
const result = line({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: 'ok' }] } })

test('a request shows on the board as soon as it is sent, not when the turn ends', async ($, on) => {
  const prompts: string[] = []
  const answer = (prompt: string) => (prompt.includes('no reply yet') ? { active: ['Adding a window setting'], pending: [] } : { active: [], pending: [] })
  const { saved } = stubEngine(on, { prompts, answer })
  await start($)
  await $.prompt.submit({ text: 'add a window setting', origin: { kind: 'composer' }, wait: false })
  await waitFor(() => (saved.get('s:' + ME) as any)?.summary?.active?.[0] === 'Adding a window setting')
  expect(prompts[0]).toContain('User (latest request, no reply yet):\nadd a window setting')
  expect((saved.get('s:' + ME) as any).summary.active).toEqual(['Adding a window setting'])
})

test('the summary reads the last four exchanges, mid-turn messages included, and the final replies', async ($, on) => {
  const prompts: string[] = []
  const tail = [
    'cut-off first line',
    ask('zeroth: plan it'),
    said('Planned.'),
    ask('first: rename the app'),
    said('Renamed it.'),
    ask('second: add settings'),
    said('Looking at the settings code.'),
    ran('Edit', { file_path: '/x/main.swift' }),
    result,
    said('Added the settings panel. Still to do: publish, which waits on your go.'),
    ask('[Request interrupted by user]'),
    ask('<artifact-view-context artifact="abc">a page</artifact-view-context>\n\nthird: hold off'),
    said('Holding off.'),
    // A message sent while the session worked
    line({ type: 'attachment', attachment: { type: 'queued_command', commandMode: 'prompt', prompt: 'fourth: check the board' } }),
    line({ type: 'attachment', attachment: { type: 'queued_command', commandMode: 'task-notification', prompt: '<task-notification>done</task-notification>' } }),
    said('Checking the board.'),
  ].join('\n')
  const { saved } = stubEngine(on, { prompts, tail })
  await start($)
  await $.turn.start({ text: 'go', turnId: 't1' })
  await $.turn.complete({ turnId: 't1', answer: '', durationMs: 5, isAborted: false, usage: null, reason: 'answer' })
  await waitFor(() => !!(saved.get('s:' + ME) as any)?.summary)
  const prompt = prompts[0]
  // The oldest ones drop out; the interruption, the context and the notification aren't requests
  for (const asked of ['zeroth: plan it', 'first: rename the app', 'second: add settings', 'third: hold off', 'fourth: check the board']) {
    expect(prompt.includes(asked)).toBe(asked !== 'zeroth: plan it')
  }
  expect(prompt).not.toContain('Request interrupted')
  expect(prompt).not.toContain('artifact-view-context')
  expect(prompt).not.toContain('task-notification')
  // The reply after the last tool call, not the narration before it
  expect(prompt).toContain("Assistant's final reply:\nAdded the settings panel. Still to do: publish, which waits on your go.")
  expect(prompt).not.toContain('Looking at the settings code.')
  // The board before comes last, as wording only
  expect(prompt).toContain('--- The board before (for wording only; no evidence that an item is still open)')
})

test('an item that waits on you is never shown as work under way', async ($, on) => {
  const answer = () => ({ active: ['Pick the account · waits on you', 'Writing the docs'], pending: ['Publish it'] })
  const { saved } = stubEngine(on, { answer })
  await start($)
  await $.turn.start({ text: 'go', turnId: 't1' })
  await $.turn.complete({ turnId: 't1', answer: '', durationMs: 5, isAborted: false, usage: null, reason: 'answer' })
  await waitFor(() => !!(saved.get('s:' + ME) as any)?.summary)
  const summary = (saved.get('s:' + ME) as any).summary
  expect(summary.active).toEqual(['Writing the docs'])
  expect(summary.pending).toEqual(['Pick the account · waits on you', 'Publish it'])
})

test('a long turn is summarized again every 90 seconds, once there is something new', async ($, on) => {
  let modelCalls = 0
  const { clock } = stubEngine(on, { onModel: () => (modelCalls += 1) })
  await start($)
  await $.turn.start({ text: 'go', turnId: 't1' })
  await $.tool.call({ tool: 'Bash', command: 'ls' })
  await settle()
  expect(modelCalls).toBe(0)
  await clock.advance(90 * 1000 + 1)
  await $.tool.call({ tool: 'Bash', command: 'ls' })
  await waitFor(() => modelCalls > 0)
  expect(modelCalls).toBe(1)
  // Nothing new written since: no call
  await clock.advance(90 * 1000 + 1)
  await $.tool.call({ tool: 'Bash', command: 'ls' })
  await settle()
  expect(modelCalls).toBe(1)
})

test('a busy session started before the mod shows a new request at once', async ($, on) => {
  const prompts: string[] = []
  const registry = { ...REGISTRY, '202.json': { pid: 202, sessionId: 'sess-other', cwd: '/work/site', name: 'Site Fixes', status: 'busy', updatedAt: 0 } }
  const tail = ['cut', ask('fix the footer'), said('Fixed the footer.'), ask('now the header')].join('\n')
  const { saved, clock } = stubEngine(on, { prompts, registry, tail })
  // The board already had a summary of the previous request, a minute old
  saved.set('s:sess-other', { id: 'sess-other', shadow: true, tasks: [], summaryAsk: 'fix the footer', summary: { active: [], pending: [], at: 1_000_000 - 60_000 } })
  await start($)
  await clock.advance(30_000)
  await waitFor(() => (saved.get('s:sess-other') as any)?.summaryAsk === 'now the header')
  expect(prompts.some((p) => p.includes('User (latest request, no reply yet):\nnow the header'))).toBe(true)
})

test('the request shown is what you typed, without the context an app wraps around it', async ($, on) => {
  const { saved } = stubEngine(on)
  await start($)
  const text = '<artifact-view-context artifact="043a20b8">\nthe page\n</artifact-view-context>\n\n<ide_opened_file>main.swift</ide_opened_file>\nyou can continue now'
  await $.prompt.submit({ text, origin: { kind: 'bridge' }, wait: false })
  await waitFor(() => (saved.get('s:' + ME) as any)?.request === 'you can continue now')
  expect((saved.get('s:' + ME) as any).request).toBe('you can continue now')
})

test('"waits on you" is moved to the end, wherever Haiku put it', async ($, on) => {
  const answer = () => ({ active: [], pending: ['· waits on you: approve the crediting code', 'Merge it (waits on you)', 'Write the docs'] })
  const { saved } = stubEngine(on, { answer })
  await start($)
  await $.turn.start({ text: 'go', turnId: 't1' })
  await $.turn.complete({ turnId: 't1', answer: '', durationMs: 5, isAborted: false, usage: null, reason: 'answer' })
  await waitFor(() => !!(saved.get('s:' + ME) as any)?.summary)
  expect((saved.get('s:' + ME) as any).summary.pending).toEqual([
    'approve the crediting code · waits on you',
    'Merge it · waits on you',
    'Write the docs',
  ])
})

test('a long older reply keeps its start and its end, where done and next are said', async ($, on) => {
  const prompts: string[] = []
  const long = 'Terminals now count as Claude. ' + 'detail '.repeat(600) + 'Still to do: publishing.'
  const tail = ['cut', ask('make terminals count'), said(long), ask('now shorten the message'), said('Shortened it.')].join('\n')
  const { saved } = stubEngine(on, { prompts, tail })
  await start($)
  await $.turn.start({ text: 'go', turnId: 't1' })
  await $.turn.complete({ turnId: 't1', answer: '', durationMs: 5, isAborted: false, usage: null, reason: 'answer' })
  await waitFor(() => !!(saved.get('s:' + ME) as any)?.summary)
  expect(prompts[0]).toContain('Terminals now count as Claude.')
  expect(prompts[0]).toContain('Still to do: publishing.')
  expect(prompts[0]).toContain('[…]')
})

test('the summary reads further back when the last requests are not in the first megabyte', async ($, on) => {
  const prompts: string[] = []
  const runs: string[][] = []
  // The first megabyte holds only the latest request; four megabytes hold all of them
  const short = ['cut', ask('fourth'), said('Did the fourth.')].join('\n')
  const full = ['cut', ask('zeroth'), said('0'), ask('first'), said('1'), ask('second'), said('2'), ask('third'), said('3'), ask('fourth'), said('Did the fourth.')].join('\n')
  const { saved } = stubEngine(on, { prompts, runs, size: 50_000_000, tailFor: (bytes) => (bytes >= 4_000_000 ? full : short) })
  await start($)
  await $.turn.start({ text: 'go', turnId: 't1' })
  await $.turn.complete({ turnId: 't1', answer: '', durationMs: 5, isAborted: false, usage: null, reason: 'answer' })
  await waitFor(() => !!(saved.get('s:' + ME) as any)?.summary)
  expect(tailReads(runs).map((r) => Number(r[4]))).toEqual([1_000_000, 4_000_000])
  for (const asked of ['first', 'second', 'third', 'fourth']) expect(prompts[0]).toContain('User:\n' + asked)
  expect(prompts[0]).not.toContain('User:\nzeroth')
})

test('while the session still works, its latest text is marked as work under way', async ($, on) => {
  const prompts: string[] = []
  // Only this session, so the catch-up pass has no other session to summarize
  const registry = { '101.json': REGISTRY['101.json'] }
  const { clock } = stubEngine(on, { prompts, registry, tail: ['cut', ask('fix the mismatch'), said('Found the cause, fixing it.')].join('\n') })
  await start($)
  await $.turn.start({ text: 'go', turnId: 't1' })
  await clock.advance(90 * 1000 + 1)
  await $.tool.call({ tool: 'Bash', command: 'ls' })
  await waitFor(() => prompts.length > 0)
  expect(prompts[0]).toContain('Assistant, still working on it (its latest text so far):\nFound the cause, fixing it.')
})

test('answers given in the question box count as what the user said', async ($, on) => {
  const prompts: string[] = []
  const tail = [
    'cut',
    ask('fix the flags'),
    line({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_q', name: 'AskUserQuestion', input: { questions: [] } }] } }),
    line({
      type: 'user',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_q', content: 'The user answered: "Keep the screening flag?"="Turn it off". Read the answers carefully.' }] },
      toolUseResult: { questions: [], answers: { 'Keep the screening flag?': 'Turn it off' } },
    }),
    said('Turning it off.'),
  ].join('\n')
  const { saved } = stubEngine(on, { prompts, tail })
  await start($)
  await $.turn.start({ text: 'go', turnId: 't1' })
  await $.turn.complete({ turnId: 't1', answer: '', durationMs: 5, isAborted: false, usage: null, reason: 'answer' })
  await waitFor(() => !!(saved.get('s:' + ME) as any)?.summary)
  expect(prompts[0]).toContain("User:\nAnswered the assistant's questions:\n- Keep the screening flag? → Turn it off")
  expect(prompts[0]).toContain("Assistant's final reply:\nTurning it off.")
})

test('a message sent mid-turn with a screenshot is read by its text', async ($, on) => {
  const prompts: string[] = []
  const queued = line({ type: 'attachment', attachment: { type: 'queued_command', commandMode: 'prompt', prompt: [{ type: 'text', text: 'check this row' }, { type: 'image', source: { type: 'base64', data: '' } }] } })
  const { saved } = stubEngine(on, { prompts, tail: ['cut', ask('build it'), said('Built.'), queued, said('Checking the row.')].join('\n') })
  await start($)
  await $.turn.start({ text: 'go', turnId: 't1' })
  await $.turn.complete({ turnId: 't1', answer: '', durationMs: 5, isAborted: false, usage: null, reason: 'answer' })
  await waitFor(() => !!(saved.get('s:' + ME) as any)?.summary)
  expect(prompts[0]).toContain('User:\ncheck this row')
  expect(prompts[0]).not.toContain('[object Object]')
})

test('a session running a shell command counts as working, not idle', async ($, on) => {
  const prompts: string[] = []
  const registry = { ...REGISTRY, '202.json': { pid: 202, sessionId: 'sess-other', cwd: '/work/site', name: 'Site Fixes', status: 'shell', updatedAt: 0 } }
  const { clock } = stubEngine(on, { prompts, registry, tail: ['cut', ask('run the suite'), said('Running the suite now.')].join('\n') })
  await start($)
  await clock.advance(30_000)
  await waitFor(() => prompts.length > 0)
  expect(prompts[0]).toContain('Assistant, still working on it (its latest text so far):\nRunning the suite now.')
})

test('the catch-up lease is taken from a session running older code, not from a current one', async ($, on) => {
  const runs: string[][] = []
  const { saved, clock } = stubEngine(on, { runs, tail: ['cut', ask('fix it'), said('Fixed.')].join('\n') })
  // Held by older code (no version): taken over
  saved.set('lease:catchup', { id: 'sess-older', until: 1_000_000 + 600_000 })
  await start($)
  await clock.advance(30_000)
  await waitFor(() => (saved.get('lease:catchup') as any)?.id === ME)
  expect((saved.get('lease:catchup') as any).v).toBe(4)
})

test('a current lease held by another session is left alone', async ($, on) => {
  const runs: string[][] = []
  const { saved, clock } = stubEngine(on, { runs, tail: ['cut', ask('fix it'), said('Fixed.')].join('\n') })
  saved.set('lease:catchup', { id: 'sess-other', until: 1_000_000 + 600_000, v: 4 })
  await start($)
  await clock.advance(30_000)
  await settle()
  expect((saved.get('lease:catchup') as any).id).toBe('sess-other')
  expect(tailReads(runs).filter((r) => r[5].includes('sess-other'))).toEqual([])
})

test('the summary keeps what the session last finished, in one line', async ($, on) => {
  const answer = () => ({ done: 'Built the phone version\nand committed it', active: ['View-only note on other screens'], pending: [] } as any)
  const { saved } = stubEngine(on, { answer })
  await start($)
  await $.turn.start({ text: 'go', turnId: 't1' })
  await $.turn.complete({ turnId: 't1', answer: '', durationMs: 5, isAborted: false, usage: null, reason: 'answer' })
  await waitFor(() => !!(saved.get('s:' + ME) as any)?.summary)
  expect((saved.get('s:' + ME) as any).summary.done).toBe('Built the phone version')
})

test('the summary is told which commands the session still runs, and none once they end', async ($, on) => {
  const prompts: string[] = []
  // Site Fixes started at 1000; its shell snapshot was made at 2000; Board Mod's own shells don't count for it
  const registry = {
    '101.json': { pid: 101, sessionId: ME, cwd: '/work/app', name: 'Board Mod', status: 'busy', startedAt: 500, updatedAt: 0 },
    '202.json': { pid: 202, sessionId: 'sess-other', cwd: '/work/site', name: 'Site Fixes', status: 'idle', startedAt: 1000, updatedAt: 0 },
  }
  let ps = "/bin/zsh -c source /h/.claude/shell-snapshots/snapshot-zsh-0000000002000-ab.sh && eval 'npx playwright test -c pw.config.ts'"
  const { clock } = stubEngine(on, { prompts, registry, tail: ['cut', ask('run the suite'), said('The suite is running in the background.')].join('\n'), get ps() { return ps } } as any)
  await start($)
  await clock.advance(30_000)
  await waitFor(() => prompts.length > 0)
  expect(prompts[0]).toContain('--- Commands this session left running: browser tests')
  // The suite ends: with nothing new in the conversation, the board is summarized again
  ps = ''
  await clock.advance(30_000)
  await waitFor(() => prompts.length > 1)
  expect(prompts[1]).toContain('--- Commands this session left running: none')
})

const finished = (text: string) => line({ type: 'assistant', message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text }] } })

test('a turn that ended while its command still runs counts as done, not still working', async ($, on) => {
  const prompts: string[] = []
  // The registry says "shell" (a background command runs), but the turn's last message ended it
  const registry = { ...REGISTRY, '202.json': { pid: 202, sessionId: 'sess-other', cwd: '/work/site', name: 'Site Fixes', status: 'shell', updatedAt: 0 } }
  const tail = ['cut', ask('why is the gate slow?'), said('Looking.'), finished('It was stuck; fixed it. The suite is still running.')].join('\n')
  const { saved, clock } = stubEngine(on, { prompts, registry, tail })
  await start($)
  await clock.advance(30_000)
  await waitFor(() => prompts.length > 0)
  expect(prompts[0]).toContain("Assistant's final reply:")
  expect(prompts[0]).toContain('It was stuck; fixed it. The suite is still running.')
  expect(prompts[0]).not.toContain('still working on it')
  await waitFor(() => (saved.get('s:sess-other') as any)?.turnEnded === true)
  expect((saved.get('s:sess-other') as any).turnEnded).toBe(true)
})

test('a turn that ended counts as ended even while a background agent keeps the registry busy', async ($, on) => {
  const prompts: string[] = []
  const registry = { ...REGISTRY, '202.json': { pid: 202, sessionId: 'sess-other', cwd: '/work/site', name: 'Site Fixes', status: 'busy', updatedAt: 0 } }
  const started = line({ type: 'assistant', message: { role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'toolu_agent', name: 'Agent', input: { description: 'Critic', run_in_background: true } }] } })
  const tail = ['cut', ask('draw the settings'), started, result, finished('Settings, dismiss and sounds are all done.')].join('\n')
  const { saved, clock } = stubEngine(on, { prompts, registry, tail })
  await start($)
  await clock.advance(30_000)
  await waitFor(() => prompts.length > 0)
  expect(prompts[0]).toContain("Assistant's final reply:")
  expect(prompts[0]).toContain('--- Commands this session left running: a background agent')
  await waitFor(() => (saved.get('s:sess-other') as any)?.agentsRunning === 1)
  expect((saved.get('s:sess-other') as any).turnEnded).toBe(true)
})

test('a background agent that reported back no longer counts as running', async ($, on) => {
  const registry = { ...REGISTRY, '202.json': { pid: 202, sessionId: 'sess-other', cwd: '/work/site', name: 'Site Fixes', status: 'idle', updatedAt: 0 } }
  const started = line({ type: 'assistant', message: { role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'toolu_agent', name: 'Agent', input: { description: 'Critic', run_in_background: true } }] } })
  const back = line({ type: 'attachment', attachment: { type: 'queued_command', commandMode: 'task-notification', prompt: '<task-notification><tool-use-id>toolu_agent</tool-use-id><status>completed</status></task-notification>' } })
  const tail = ['cut', ask('review it'), started, result, finished('Started the critic.'), back, finished('The critic is done.')].join('\n')
  const { saved, clock } = stubEngine(on, { registry, tail })
  await start($)
  await clock.advance(30_000)
  await waitFor(() => (saved.get('s:sess-other') as any)?.agentsRunning !== undefined)
  expect((saved.get('s:sess-other') as any).agentsRunning).toBe(0)
})

test('a side task and the work it paused come through the summary', async ($, on) => {
  const answer = () => ({ done: 'Drew the dismiss boards', side: 'Fixing the board/chat status mismatch', paused: 'Light theme and remaining states', active: [], pending: ['Settings panel'] } as any)
  const { saved } = stubEngine(on, { answer })
  await start($)
  await $.turn.start({ text: 'go', turnId: 't1' })
  await $.turn.complete({ turnId: 't1', answer: '', durationMs: 5, isAborted: false, usage: null, reason: 'answer' })
  await waitFor(() => !!(saved.get('s:' + ME) as any)?.summary)
  const summary = (saved.get('s:' + ME) as any).summary
  expect(summary.side).toBe('Fixing the board/chat status mismatch')
  expect(summary.paused).toBe('Light theme and remaining states')
})

test('a permission prompt records what it asks, and answering clears it', async ($, on) => {
  const { saved } = stubEngine(on)
  on('classic.PermissionRequest', () => ({}))
  await start($)
  await $.turn.start({ text: 'go', turnId: 't1' })
  await $.classic.PermissionRequest({ hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: './deploy.sh', description: 'Deploy v1.20.104 to the sandbox' } } as any)
  await waitFor(() => !!(saved.get('s:' + ME) as any)?.ask)
  expect((saved.get('s:' + ME) as any).ask).toBe('Allow Bash: Deploy v1.20.104 to the sandbox')
  await $.prompt.submit({ text: 'yes', origin: { kind: 'composer' }, wait: false })
  await waitFor(() => (saved.get('s:' + ME) as any)?.ask === '')
  expect((saved.get('s:' + ME) as any).ask).toBe('')
})

test('a waiting session caught up from its conversation shows the question it asks', async ($, on) => {
  const registry = { ...REGISTRY, '202.json': { pid: 202, sessionId: 'sess-other', cwd: '/work/site', name: 'Site Fixes', status: 'waiting', updatedAt: 0 } }
  const q = line({ type: 'assistant', message: { role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'toolu_q', name: 'AskUserQuestion', input: { questions: [{ question: 'Which phone should I test on?' }] } }] } })
  const { saved, clock } = stubEngine(on, { registry, tail: ['cut', ask('test it'), q].join('\n') })
  await start($)
  await clock.advance(30_000)
  await waitFor(() => !!(saved.get('s:sess-other') as any)?.ask)
  expect((saved.get('s:sess-other') as any).ask).toBe('Which phone should I test on?')
})

test('a compacted conversation\'s summary and a lone marker tag are not requests', async ($, on) => {
  const prompts: string[] = []
  const tail = [
    'cut-off first line',
    ask('first: build the phone layout'),
    said('Built it.'),
    line({ type: 'user', isCompactSummary: true, message: { role: 'user', content: 'This session is being continued from a previous conversation that ran out of context.\n\nSummary: secret plan' } }),
    ask('<artifact-content-authored-by-others/>\nThe summarized conversation included Artifact content.\nThis session is being continued from a previous conversation that ran out of context.\nSummary: more'),
    ask('<artifact-content-authored-by-others/>\nsecond: ship it to the sandbox'),
    said('Shipping it.'),
  ].join('\n')
  const { saved } = stubEngine(on, { prompts, tail })
  await start($)
  await $.turn.start({ text: 'go', turnId: 't1' })
  await $.turn.complete({ turnId: 't1', answer: '', durationMs: 5, isAborted: false, usage: null, reason: 'answer' })
  await waitFor(() => !!(saved.get('s:' + ME) as any)?.summary)
  expect(prompts[0]).toContain('first: build the phone layout')
  expect(prompts[0]).toContain('second: ship it to the sandbox')
  expect(prompts[0]).not.toContain('This session is being continued')
  expect(prompts[0]).not.toContain('artifact-content-authored-by-others')
})

test('only what the session is stopped on right now waits on you', async ($, on) => {
  const systems: string[] = []
  const { saved } = stubEngine(on, { systems })
  await start($)
  await $.turn.start({ text: 'go', turnId: 't1' })
  await $.turn.complete({ turnId: 't1', answer: '', durationMs: 5, isAborted: false, usage: null, reason: 'answer' })
  await waitFor(() => !!(saved.get('s:' + ME) as any)?.summary)
  expect(systems[0]).toContain('only when the session is stopped on the user for it right now')
  expect(systems[0]).toContain('does not wait on them yet')
  expect(systems[0]).toContain('asks them to do something themselves now')
})

test('a status that moved since the record was read is read again, though the conversation looks the same', async ($, on) => {
  const runs: string[][] = []
  const other = { pid: 202, sessionId: 'sess-other', cwd: '/work/site', name: 'Site Fixes', status: 'idle', updatedAt: 0, statusUpdatedAt: 0 }
  const registry = { ...REGISTRY, '202.json': other }
  const tail = ['cut', ask('fix the footer'), finished('Fixed the footer.')].join('\n')
  const { saved, clock } = stubEngine(on, { runs, registry, tail })
  await start($)
  await clock.advance(30_000)
  await waitFor(() => (saved.get('s:sess-other') as any)?.turnEnded === true)
  const reads = () => tailReads(runs).filter((r) => r[5].includes('sess-other')).length
  const before = reads()
  // Nothing new: not read again
  await clock.advance(30_000)
  await settle()
  expect(reads()).toBe(before)
  // A new turn makes it busy: read again at the next pass
  other.status = 'busy'
  other.statusUpdatedAt = (saved.get('s:sess-other') as any).updatedAt + 1
  await clock.advance(30_000)
  await waitFor(() => reads() > before)
  expect((saved.get('s:sess-other') as any).updatedAt).toBeGreaterThanOrEqual(other.statusUpdatedAt)
})

test('agents and workflows launched in the background count until they report back, however many', async ($, on) => {
  const prompts: string[] = []
  const registry = { ...REGISTRY, '202.json': { pid: 202, sessionId: 'sess-other', cwd: '/work/site', name: 'Site Fixes', status: 'busy', updatedAt: 0 } }
  // Today's agents and workflows: no run_in_background on the call; the result says async_launched
  const launch = (id: string, name: string) =>
    line({ type: 'assistant', message: { role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use', id, name, input: { description: 'review' } }] } })
  const launched = (id: string, extra: object) =>
    line({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'Launched in the background.' }] }, toolUseResult: { status: 'async_launched', ...extra } })
  const reported = (inner: string) =>
    line({ type: 'attachment', attachment: { type: 'queued_command', commandMode: 'task-notification', prompt: `<task-notification>${inner}<status>completed</status></task-notification>` } })
  const twenty = Array.from({ length: 20 }, (_, i) => [launch('toolu_a' + i, 'Agent'), launched('toolu_a' + i, { agentId: 'ag' + i })]).flat()
  // A synchronous agent call returns its answer: never counted
  const inline = [launch('toolu_sync', 'Agent'), line({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_sync', content: 'done' }] }, toolUseResult: { status: 'completed' } })]
  const tail = ['cut', ask('review everything'), launch('toolu_wf', 'Workflow'), launched('toolu_wf', { taskId: 'wf1' }), ...twenty, ...inline,
    reported('<tool-use-id>toolu_a0</tool-use-id>'), reported('<task-id>ag1</task-id>'), finished('Started the review.')].join('\n')
  const { saved, clock } = stubEngine(on, { prompts, registry, tail })
  await start($)
  await clock.advance(30_000)
  await waitFor(() => (saved.get('s:sess-other') as any)?.agentsRunning !== undefined)
  expect((saved.get('s:sess-other') as any).agentsRunning).toBe(18)
  expect((saved.get('s:sess-other') as any).workflowsRunning).toBe(1)
  await waitFor(() => prompts.length > 0)
  // One label each, no count, so the summary isn't redone as each agent finishes
  expect(prompts[0]).toContain('--- Commands this session left running: a workflow, background agents')
})

test('summaries are written by Sonnet at low effort', async ($, on) => {
  const models: string[] = []
  const { saved } = stubEngine(on, { models } as any)
  await start($)
  await $.turn.start({ text: 'go', turnId: 't1' })
  await $.turn.complete({ turnId: 't1', answer: '', durationMs: 5, isAborted: false, usage: null, reason: 'answer' })
  await waitFor(() => !!(saved.get('s:' + ME) as any)?.summary)
  expect(models[0]).toBe('sonnet/low')
})

test('the title Claude gave a conversation is kept, for sessions the registry only knows by a placeholder', async ($, on) => {
  const registry = { ...REGISTRY, '202.json': { pid: 202, sessionId: 'sess-other', cwd: '/work/site', name: 'site-54', nameSource: 'derived', status: 'idle', updatedAt: 0 } }
  const titled = line({ type: 'ai-title', aiTitle: 'Sending money to the wallet', sessionId: 'sess-other' })
  const tail = ['cut', ask('send a dollar'), titled, finished('Sent.')].join('\n')
  const { saved, clock } = stubEngine(on, { registry, tail })
  await start($)
  await clock.advance(30_000)
  await waitFor(() => !!(saved.get('s:sess-other') as any)?.title)
  expect((saved.get('s:sess-other') as any).title).toBe('Sending money to the wallet')
})

test("a new session's name shows within seconds of the first request, not when the turn ends", async ($, on) => {
  let named = false
  const titled = line({ type: 'ai-title', aiTitle: 'Session board final video', sessionId: ME })
  const tailFor = () => (named ? titled : '')
  const { saved, clock } = stubEngine(on, { tailFor, settings: { summaries: false } })
  await start($)
  await $.prompt.submit({ text: 'send me the final video', origin: { kind: 'composer' }, wait: false })
  await clock.advance(3_000)
  await settle()
  expect((saved.get('s:' + ME) as any).title ?? '').toBe('')
  named = true
  await clock.advance(3_000)
  await waitFor(() => !!(saved.get('s:' + ME) as any)?.title)
  expect((saved.get('s:' + ME) as any).title).toBe('Session board final video')
})

test('a side task is not listed again as active, nor the work it paused as pending', async ($, on) => {
  const answer = () => ({
    side: 'Resize the default board to its current size for floating view',
    paused: 'Make board pick up renamed session right away',
    active: ['Resize default board to current size for floating view'],
    pending: ['Make board pick up renamed session right away.', 'Publish the plugin'],
  } as any)
  const { saved } = stubEngine(on, { answer })
  await start($)
  await $.turn.start({ text: 'go', turnId: 't1' })
  await $.turn.complete({ turnId: 't1', answer: '', durationMs: 5, isAborted: false, usage: null, reason: 'answer' })
  await waitFor(() => !!(saved.get('s:' + ME) as any)?.summary)
  const summary = (saved.get('s:' + ME) as any).summary
  expect(summary.side).toBe('Resize the default board to its current size for floating view')
  expect(summary.active).toEqual([])
  expect(summary.pending).toEqual(['Publish the plugin'])
})

const TITLE_FILE = DATA + '/title-' + ME + '.json'
const send = ($: any, text: string) => $.prompt.submit({ text, origin: { kind: 'composer' }, wait: false })
const titleWrites = (writes: string[][]) => writes.filter(([path]) => path === TITLE_FILE).map(([, text]) => JSON.parse(text).title)

test("a new session is named with its project first, from its first request, for the plugin's hook to set", async ($, on) => {
  const prompts: string[] = []
  const writes: string[][] = []
  const { saved } = stubEngine(on, { prompts, writes, settings: { renameSessions: true } })
  await start($)
  await send($, 'the login page is broken, fix it')
  expect(titleWrites(writes)).toEqual(['app · Fix the login page'])
  expect(prompts[0]).toBe('the login page is broken, fix it')
  expect((saved.get('s:' + ME) as any).title).toBe('app · Fix the login page')
  // Once per session: the next request leaves the name alone
  await send($, 'and the signup page')
  expect(titleWrites(writes)).toEqual(['app · Fix the login page'])
})

test("a session Claude already named gets its project put in front, with no model call for it", async ($, on) => {
  const prompts: string[] = []
  const writes: string[][] = []
  const { saved } = stubEngine(on, { prompts, writes, settings: { renameSessions: true, summaries: false } })
  saved.set('s:' + ME, { id: ME, title: 'Search results paging' })
  await start($)
  await send($, 'go on')
  expect(titleWrites(writes)).toEqual(['app · Search results paging'])
  expect(prompts).toEqual([])
})

for (const [when, settings] of [['by default', {}], ['with the advanced setting off', { renameSessions: false }], ['with Project first off', { projectNames: false, renameSessions: true }]] as const) {
  test(`the session itself is not renamed ${when}`, async ($, on) => {
    const writes: string[][] = []
    stubEngine(on, { writes, settings })
    await start($)
    await send($, 'fix the login')
    expect(titleWrites(writes)).toEqual([])
  })
}

test("a name that already starts with the project is left as it is", async ($, on) => {
  const writes: string[][] = []
  const { saved } = stubEngine(on, { writes, settings: { renameSessions: true } })
  saved.set('s:' + ME, { id: ME, title: 'App settings page' })
  await start($)
  await send($, 'go on')
  expect(titleWrites(writes)).toEqual([])
})

test('a summary that fails is tried again a little later, so the board does not stay on the old one', async ($, on) => {
  let calls = 0
  const answer = () => {
    calls += 1
    if (calls === 1) throw new Error('overloaded')
    return { active: [], pending: ['Give the box SSM access in AWS · waits on you'] }
  }
  const { saved, clock } = stubEngine(on, { answer })
  await start($)
  await $.turn.start({ text: 'go', turnId: 't1' })
  await $.turn.complete({ turnId: 't1', answer: '', durationMs: 5, isAborted: false, usage: null, reason: 'answer' })
  await waitFor(() => !!(saved.get('s:' + ME) as any)?.summaryError)
  expect((saved.get('s:' + ME) as any).summary).toBe(null)
  await clock.advance(15_000)
  await waitFor(() => !!(saved.get('s:' + ME) as any)?.summary)
  const rec: any = saved.get('s:' + ME)
  expect(rec.summary.pending).toEqual(['Give the box SSM access in AWS · waits on you'])
  expect(rec.summaryError).toBe(undefined)
})

test("after a turn, the summary reads the reply the turn ended with, even before it is saved", async ($, on) => {
  const prompts: string[] = []
  // The saved conversation has the request and the work so far, not yet the last reply
  const tail = ['cut', ask('tell me exact steps to fix it'), line({ type: 'assistant', message: { content: [{ type: 'text', text: 'Writing the steps now.' }] } })].join('\n')
  const { saved, clock } = stubEngine(on, { prompts, tail })
  await start($)
  await $.turn.start({ text: 'go', turnId: 't1' })
  await $.turn.complete({ turnId: 't1', answer: 'Here are the steps. Then tell me "done".', durationMs: 5, isAborted: false, usage: null, reason: 'answer' })
  for (let i = 0; i < 3; i++) {
    await settle()
    await clock.advance(1_000)
  }
  await waitFor(() => prompts.length > 0)
  expect(prompts[0]).toContain('Here are the steps. Then tell me "done".')
  expect(prompts[0]).not.toContain('Writing the steps now.')
})

test('a turn whose last summary was lost, as the mod reloaded when it ended, is summarized by the idle check', async ($, on) => {
  const prompts: string[] = []
  const tail = ['cut', ask('publish it'), finished('Committed. Run gh auth login yourself, then tell me.')].join('\n')
  const answer = () => ({ active: [], pending: ['Log in with gh auth login · waits on you'] })
  const { saved, clock } = stubEngine(on, { prompts, tail, answer, registry: {} })
  // The record as the old copy of the mod left it: a summary from the middle of the turn
  saved.set('s:' + ME, { id: ME, tasks: [], status: 'working', jobsKey: '', summaryReply: 'Checking the colours first.',
    summary: { done: '', side: 'Pick colours that look distinct', paused: 'Publishing', active: [], pending: [], at: 1 } })
  await start($)
  await clock.advance(30_000)
  await waitFor(() => (saved.get('s:' + ME) as any)?.summary?.side === '')
  const rec: any = saved.get('s:' + ME)
  expect(rec.summary.pending).toEqual(['Log in with gh auth login · waits on you'])
  expect(prompts.filter((p) => p.includes('Run gh auth login yourself'))).toHaveLength(1)
  // Once it has caught up, the check leaves the board alone
  await clock.advance(30_000)
  await settle()
  expect(prompts.filter((p) => p.includes('Run gh auth login yourself'))).toHaveLength(1)
})

test('a summary call that never answers is given up on, so later summaries still run', async ($, on) => {
  let hanging = true
  const answer = () => ({ active: [], pending: ['Try the new popup · waits on you'] })
  const { saved, clock } = stubEngine(on, { answer, hang: () => hanging })
  await start($)
  await $.turn.start({ text: 'go', turnId: 't1' })
  await $.turn.complete({ turnId: 't1', answer: '', durationMs: 5, isAborted: false, usage: null, reason: 'answer' })
  await settle()
  hanging = false
  await clock.advance(90_000)
  await waitFor(() => !!(saved.get('s:' + ME) as any)?.summaryError)
  expect((saved.get('s:' + ME) as any).summaryError).toContain('timed out')
  await clock.advance(15_000)
  await waitFor(() => !!(saved.get('s:' + ME) as any)?.summary)
  expect((saved.get('s:' + ME) as any).summary.pending).toEqual(['Try the new popup · waits on you'])
})

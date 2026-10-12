#!/usr/bin/env node
// Sends a Session Board bug report or idea to its GitHub issues, for the feedback skill.
//
//   node report.mjs --kind bug|idea [--dry-run] <<'EOF'
//   <title>
//
//   <what happened, in the user's words>
//   EOF
//
// It adds what the Session Board team needs to look into it: versions, the window's
// settings, error messages and crashes. Never the content of a chat: no session names,
// summaries, requests or project names. The home folder and user name are taken out of
// everything it sends.
//
// With the GitHub CLI signed in, it opens a public issue at once and prints its link. Otherwise
// it sends the report to Session Board's inbox (reports-worker/), which files it privately for
// the team; only if that fails does it open GitHub's new-issue page in the browser, filled in.
// --dry-run prints the report and sends nothing.

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync, mkdtempSync } from 'node:fs'
import { homedir, tmpdir, userInfo } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = process.env.SESSION_BOARD_REPO || 'KiranPothana/session-board'
const INBOX = process.env.SESSION_BOARD_INBOX || 'https://session-board-reports.kiran-987.workers.dev/report'
const HOME = homedir()
const DATA = join(HOME, 'Library/Application Support/session-board')
const APP = join(HOME, 'Applications/Session Board.app')
const BUNDLE = 'io.github.kiranpothana.session-board'
const WEEK = 7 * 24 * 3600 * 1000
// GitHub's new-issue page takes the report in its address, which browsers cap
const URL_BODY_CHARS = 6000

const args = process.argv.slice(2)
const kind = args.includes('--kind') ? args[args.indexOf('--kind') + 1] : 'bug'
const dryRun = args.includes('--dry-run')
if (kind !== 'bug' && kind !== 'idea') fail('--kind is bug or idea')

function fail(msg) {
  console.error('report: ' + msg)
  process.exit(2)
}

const run = (cmd, argv, timeout = 5000) => {
  try {
    return execFileSync(cmd, argv, { encoding: 'utf8', timeout, stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {
    return ''
  }
}

const readJson = (path) => {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}

// The home folder and user name out of anything sent
const user = userInfo().username
const clean = (s) => String(s ?? '').split(HOME).join('~').replace(new RegExp(`\\b${user}\\b`, 'g'), '<user>')

// ---- What the user wrote: the title, a blank line, then the description
const input = readFileSync(0, 'utf8').trim()
const [titleLine, ...rest] = input.split('\n')
const title = titleLine?.trim()
const description = rest.join('\n').trim()
if (!title) fail('give the title on the first line of stdin')

// ---- Versions
const here = dirname(fileURLToPath(import.meta.url))
const plugin = readJson(join(here, '../../.claude-plugin/plugin.json'))
const appVersion = existsSync(APP) ? run('defaults', ['read', join(APP, 'Contents/Info.plist'), 'CFBundleShortVersionString']) : ''
const swift = run('swift', ['--version'], 10000).split('\n').find((l) => l.includes('Swift version')) ?? ''

const versions = [
  ['Session Board', plugin?.version ?? '?'],
  ['Window app', existsSync(APP) ? `${appVersion || '?'}, ${run('pgrep', ['-x', 'SessionBoard']) ? 'running' : 'not running'}` : 'not built'],
  ['Claude Code', run('claude', ['--version']) || '?'],
  ['Run from', process.env.CLAUDE_CODE_ENTRYPOINT || '?'],
  ['macOS', `${run('sw_vers', ['-productVersion']) || '?'} (${run('uname', ['-m'])})`],
  ['Swift', swift.replace(/^.*Swift version\s*/, '').replace(/\s*\(.*$/, '') || 'not found'],
]

// ---- The window's settings: only these keys, and only their values
const settings = []
const shared = readJson(join(DATA, 'settings.json')) ?? {}
for (const k of ['summaries', 'projectNames', 'renameSessions']) if (typeof shared[k] === 'boolean') settings.push(`${k}=${shared[k]}`)
const defaults = run('defaults', ['read', BUNDLE])
for (const k of ['theme', 'regularWindow', 'hideWhenAway', 'terminalsCount', 'soundsOn', 'collapsed']) {
  const m = defaults.match(new RegExp(`^\\s*"?${k}"? = "?([A-Za-z0-9]+)"?;`, 'm'))
  if (m) settings.push(`${k}=${m[1]}`)
}
const status = readJson(join(DATA, 'status.json'))
if (status && typeof status.accessibility === 'boolean') settings.push(`accessibility=${status.accessibility}`)

// ---- Sessions on the board: counts and error messages, never what they're about
const sessions = { total: 0, working: 0, 'needs-you': 0, idle: 0 }
const errors = new Set()
try {
  const storeDir = join(HOME, '.claude/plugins/store')
  for (const f of readdirSync(storeDir).filter((f) => f.startsWith('session-board_'))) {
    const store = readJson(join(storeDir, f)) ?? {}
    for (const [key, rec] of Object.entries(store)) {
      if (!key.startsWith('s:') || !rec || typeof rec !== 'object') continue
      sessions.total++
      if (rec.status in sessions) sessions[rec.status]++
      if (typeof rec.summaryError === 'string') errors.add('summary: ' + clean(rec.summaryError).slice(0, 200))
    }
  }
} catch {
  // No store yet: the plugin hasn't run
}
const lastError = readJson(join(DATA, 'last-error.json'))
if (lastError?.message && Date.now() - (lastError.at ?? 0) < WEEK) {
  errors.add(`${lastError.kind ?? 'error'} (${new Date(lastError.at).toISOString().slice(0, 16)}Z): ${clean(lastError.message).slice(0, 600)}`)
}

// ---- Crashes of the window app this week: the exception and the top of the crashed thread
const crashes = []
try {
  const dir = join(HOME, 'Library/Logs/DiagnosticReports')
  const reports = readdirSync(dir)
    .filter((f) => f.startsWith('SessionBoard') && f.endsWith('.ips'))
    .map((f) => ({ f, at: statSync(join(dir, f)).mtimeMs }))
    .filter((r) => Date.now() - r.at < WEEK)
    .sort((a, b) => b.at - a.at)
  for (const r of reports.slice(0, 2)) {
    const text = readFileSync(join(dir, r.f), 'utf8')
    const body = JSON.parse(text.slice(text.indexOf('\n') + 1))
    const images = body.usedImages ?? []
    const thread = (body.threads ?? []).find((t) => t.triggered) ?? {}
    const frames = (thread.frames ?? [])
      .slice(0, 8)
      .map((fr) => `${images[fr.imageIndex]?.name ?? '?'} ${fr.symbol ?? '?'}${fr.sourceLine ? ` (${fr.sourceFile}:${fr.sourceLine})` : ''}`)
    crashes.push(`${new Date(r.at).toISOString().slice(0, 16)}Z ${body.exception?.type ?? ''} ${body.exception?.signal ?? ''}\n${frames.map((x) => '    ' + clean(x)).join('\n')}`)
  }
  if (reports.length > 2) crashes.push(`…and ${reports.length - 2} more this week`)
} catch {
  // No reports, or one in a shape this doesn't know
}

// ---- The report
const bullets = (rows) => rows.map(([k, v]) => `- ${k}: ${clean(v)}`).join('\n')
const body = [
  kind === 'bug' ? '### What happened' : '### The idea',
  clean(description) || '(no description)',
  '',
  '<details><summary>Details sent with the report</summary>',
  '',
  bullets(versions),
  `- Settings: ${settings.join(', ') || 'none found'}`,
  `- Sessions on the board: ${sessions.total} (${sessions.working} working, ${sessions['needs-you']} needs you, ${sessions.idle} idle)`,
  '',
  errors.size ? '**Errors**\n```\n' + [...errors].join('\n') + '\n```' : 'No recent errors.',
  crashes.length ? '\n**Crashes this week**\n```\n' + crashes.join('\n') + '\n```' : '',
  '</details>',
  '',
  '_Sent from Claude Code by the Session Board feedback skill. No chat content is included._',
].join('\n')
const fullTitle = (kind === 'bug' ? 'Bug: ' : 'Idea: ') + clean(title)

if (dryRun) {
  console.log(fullTitle + '\n\n' + body)
  process.exit(0)
}

// ---- Send: the GitHub CLI when it's signed in, otherwise the browser
if (signedIn()) {
  const file = join(mkdtempSync(join(tmpdir(), 'sb-report-')), 'body.md')
  writeFileSync(file, body)
  try {
    const url = execFileSync('gh', ['issue', 'create', '-R', REPO, '--title', fullTitle, '--body-file', file], {
      encoding: 'utf8',
      timeout: 30000,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim()
    console.log('Reported: ' + url.split('\n').pop())
    process.exit(0)
  } catch (err) {
    console.error('gh could not open the issue (' + oneLine(err.stderr || err.message) + '); opening the browser instead')
  }
}
// No GitHub CLI: the inbox, which needs no account
try {
  const res = await fetch(INBOX, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ kind, source: 'chat', title: clean(title).slice(0, 120), body: body.slice(0, 20000) }),
    signal: AbortSignal.timeout(15000),
  })
  const answer = await res.json().catch(() => ({}))
  if (res.ok && answer.ok) {
    console.log(`Reported privately to the Session Board team (report #${answer.ref}).`)
    process.exit(0)
  }
  console.error('the inbox said: ' + (answer.error ?? res.status) + '; opening the browser instead')
} catch (err) {
  console.error('the inbox could not be reached (' + err.message + '); opening the browser instead')
}
let shortBody = body
if (shortBody.length > URL_BODY_CHARS) shortBody = shortBody.slice(0, URL_BODY_CHARS) + '\n…(cut to fit)\n</details>'
const url = `https://github.com/${REPO}/issues/new?` + new URLSearchParams({ title: fullTitle, body: shortBody })
run('open', [url])
console.log('Opened GitHub in the browser with the report filled in: press "Create" there to send it (needs a GitHub account).\n' + url)

function oneLine(s) {
  return String(s ?? '').split('\n').map((x) => x.trim()).filter(Boolean).pop() ?? ''
}

// Whether the GitHub CLI is signed in: its status check exits 0 then. (The token is never read.)
function signedIn() {
  try {
    execFileSync('gh', ['auth', 'status', '--hostname', 'github.com'], { timeout: 10000, stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

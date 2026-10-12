// Session Board's report inbox: takes a bug report, idea or crash from someone who isn't signed
// in to GitHub (the feedback skill, or the window's crash prompt) and files it as an issue in
// the private KiranPothana/session-board-reports repo, where the team triages it.
//
//   POST /report  {"kind": "bug" | "idea" | "crash", "source": "chat" | "window" | "crash",
//                  "title": "...", "body": "..."}
//   → 201 {"ok": true, "ref": 12}
//
// Anyone can call it, so it trusts nothing it's sent: fixed kinds and sources, capped sizes,
// a few reports a minute per address (the LIMITER binding), and the text filed as given (GitHub
// renders it; it never runs). The GitHub token is a secret (`wrangler secret put GITHUB_TOKEN`):
// a fine-grained token that can only write issues in that one repo.

const KINDS = { bug: 'Bug', idea: 'Idea', crash: 'Crash' }
const SOURCES = ['chat', 'window', 'crash']
const TITLE_MAX = 120
const BODY_MAX = 20000

export default {
  async fetch(request, env) {
    const url = new URL(request.url)
    if (url.pathname === '/' && request.method === 'GET') {
      return new Response('Session Board report inbox. POST /report.\n', { headers: { 'content-type': 'text/plain' } })
    }
    if (url.pathname !== '/report') return reply(404, { ok: false, error: 'not found' })
    if (request.method !== 'POST') return reply(405, { ok: false, error: 'POST only' })

    const ip = request.headers.get('cf-connecting-ip') ?? 'unknown'
    const { success } = await env.LIMITER.limit({ key: ip })
    if (!success) return reply(429, { ok: false, error: 'too many reports, try again in a minute' })

    if (Number(request.headers.get('content-length') ?? 0) > BODY_MAX + 2000) return reply(413, { ok: false, error: 'too long' })
    let report
    try {
      report = JSON.parse(await request.text())
    } catch {
      return reply(400, { ok: false, error: 'send JSON' })
    }
    const { kind, source, title, body } = report ?? {}
    if (!(kind in KINDS)) return reply(400, { ok: false, error: 'kind is bug, idea or crash' })
    if (!SOURCES.includes(source)) return reply(400, { ok: false, error: 'source is chat, window or crash' })
    if (typeof title !== 'string' || !title.trim() || title.length > TITLE_MAX) return reply(400, { ok: false, error: `a title of 1 to ${TITLE_MAX} characters` })
    if (typeof body !== 'string' || body.length > BODY_MAX) return reply(400, { ok: false, error: `a body of at most ${BODY_MAX} characters` })

    const res = await fetch(`https://api.github.com/repos/${env.REPO}/issues`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${env.GITHUB_TOKEN}`,
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        'user-agent': 'session-board-reports',
      },
      body: JSON.stringify({
        title: `${KINDS[kind]}: ${title.trim().replace(/^(bug|idea|crash):\s*/i, '')}`,
        body: `${body}\n\n_Sent without a GitHub account, from ${source === 'chat' ? 'Claude Code' : source === 'window' ? 'the Session Board window' : 'the crash prompt'}._`,
        labels: [kind, 'from-' + source],
      }),
    })
    if (!res.ok) {
      console.log('github', res.status, (await res.text()).slice(0, 300))
      return reply(502, { ok: false, error: 'the inbox could not file it' })
    }
    const issue = await res.json()
    return reply(201, { ok: true, ref: issue.number })
  },
}

function reply(status, json) {
  return new Response(JSON.stringify(json), { status, headers: { 'content-type': 'application/json' } })
}

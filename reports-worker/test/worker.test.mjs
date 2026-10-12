// node test/worker.test.mjs: the inbox's checks, with GitHub stubbed
import assert from 'node:assert/strict'
import worker from '../src/index.js'

let filed = []
globalThis.fetch = async (url, init) => { filed.push({ url, ...init, json: JSON.parse(init.body) }); return new Response(JSON.stringify({ number: 7 }), { status: 201 }) }
let allow = true
const env = { REPO: 'o/r', GITHUB_TOKEN: 't', LIMITER: { limit: async () => ({ success: allow }) } }
const post = (obj, raw) => worker.fetch(new Request('https://x/report', { method: 'POST', body: raw ?? JSON.stringify(obj), headers: { 'cf-connecting-ip': '1.2.3.4' } }), env)
const ok = { kind: 'bug', source: 'chat', title: 'Bug: Popup stays', body: 'It stays.' }

let r = await post(ok); assert.equal(r.status, 201); assert.deepEqual(await r.json(), { ok: true, ref: 7 })
assert.equal(filed[0].url, 'https://api.github.com/repos/o/r/issues')
assert.equal(filed[0].json.title, 'Bug: Popup stays')
assert.deepEqual(filed[0].json.labels, ['bug', 'from-chat'])
assert.match(filed[0].json.body, /Sent without a GitHub account, from Claude Code/)
for (const bad of [{ ...ok, kind: 'x' }, { ...ok, source: 'x' }, { ...ok, title: '' }, { ...ok, title: 'a'.repeat(121) }, { ...ok, body: 3 }, { ...ok, body: 'a'.repeat(20001) }]) {
  assert.equal((await post(bad)).status === 400 || (await post(bad)).status === 413, true, JSON.stringify(bad).slice(0, 80))
}
assert.equal((await post(null, 'not json')).status, 400)
assert.equal((await worker.fetch(new Request('https://x/report'), env)).status, 405)
assert.equal((await worker.fetch(new Request('https://x/other', { method: 'POST' }), env)).status, 404)
allow = false; assert.equal((await post(ok)).status, 429); allow = true
globalThis.fetch = async () => new Response('bad creds', { status: 401 })
r = await post(ok); assert.equal(r.status, 502); assert.equal((await r.json()).error, 'the inbox could not file it')
console.log('worker: all checks pass')

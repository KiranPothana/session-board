// Checks the tests' copy of the mod's tail reads (readAsShell in tests/session-board.test.ts)
// against the shell commands themselves (READ_TAIL, READ_ASKS in hooks/register.js), on every
// recorded conversation and on any saved conversations given:
//   node tests/transcripts/check-pipeline.mjs [<transcript.jsonl>...]
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const here = new URL('.', import.meta.url).pathname
const mod = readFileSync(join(here, '../../hooks/register.js'), 'utf8')
const test = readFileSync(join(here, '../session-board.test.ts'), 'utf8')
const constant = (name) => {
  const raw = new RegExp(`const ${name} = (\`[^\`]*\`|\\d+)`).exec(mod)[1]
  return raw.startsWith('`') ? raw.slice(1, -1) : raw
}
const consts = { READ_OUT_BYTES: constant('READ_OUT_BYTES'), READ_ASK_LINES: constant('READ_ASK_LINES') }
const shell = (name) => constant(name).replace(/\$\{(\w+)\}/g, (_, k) => consts[k]).replace(/\\\\/g, '\\')
const copy = new Function('return ' + /function readAsShell\(file: string, bytes: number, asks: boolean\) (\{[\s\S]*?\n\})/.exec(test)[0]
  .replace(/: string|: number|: boolean/g, ''))()
const dir = mkdtempSync(join(tmpdir(), 'pipeline-'))
const files = process.argv.slice(2).map((p) => readFileSync(p, 'utf8'))
for (const name of ['long-turn-question', 'turn-ended-runs-going', 'permission-prompt', 'finished-nothing-pending']) {
  const lines = (await import(join(here, name + '.js'))).default
  files.push(lines.map((l) => l.replace(/<<pad:(\d+)>>/g, (_, n) => 'x'.repeat(Number(n)))).join('\n') + '\n')
}
let bad = 0
files.forEach((file, i) => {
  const path = join(dir, i + '.jsonl')
  writeFileSync(path, file)
  for (const bytes of [1000000, 4000000, 16000000]) for (const asks of [false, true]) {
    const real = execFileSync('sh', ['-c', shell(asks ? 'READ_ASKS' : 'READ_TAIL'), 'sh', String(bytes), path], { maxBuffer: 1e9 }).toString()
    // The copy counts characters where the shell counts bytes: the same on the fixtures (plain
    // ASCII), a few bytes apart on a real conversation with other characters
    const ours = copy(file, bytes, asks)
    // The shell ends a line list with a newline; the copy doesn't
    if (real.replace(/\n$/, '') !== ours.replace(/\n$/, '')) { bad++; console.log('differs:', i, bytes, asks ? 'asks' : 'tail', real.length, ours.length) }
  }
})
console.log(bad ? `${bad} reads differ` : `the copy matches the shell on ${files.length} conversations`)
process.exit(bad ? 1 : 0)

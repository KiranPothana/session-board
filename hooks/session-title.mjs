// The command hook half of "Also rename in Claude Code": the mod leaves the name it worked out
// in title-<session>.json when a request is sent; this hook runs on UserPromptSubmit, right
// after, and hands it to Claude Code as the session's title. Nothing to hand over: no output.
import { readFileSync, unlinkSync } from 'node:fs'
import { homedir } from 'node:os'

let input = ''
for await (const chunk of process.stdin) input += chunk
try {
  const { session_id: id } = JSON.parse(input)
  if (!/^[\w-]+$/.test(id ?? '')) process.exit(0)
  const file = homedir() + '/Library/Application Support/session-board/title-' + id + '.json'
  const { title } = JSON.parse(readFileSync(file, 'utf8'))
  unlinkSync(file)
  if (typeof title === 'string' && title.trim()) {
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', sessionTitle: title.trim() } }))
  }
} catch {
  // No name waiting (the usual case), or one that can't be read: Claude's own name stands
}

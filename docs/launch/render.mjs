// Renders video.html to an MP4: every frame drawn by window.apply(t) and screenshotted, the
// board's sounds mixed in at window.AUDIO's times.
//   node render.mjs                  the whole video → out/session-board-launch.mp4
//   node render.mjs --stills 2.6,6.3 single frames → out/still-<t>.png, to check a moment
// PLAYWRIGHT=<path to the playwright package> if it isn't the one below.
import { createRequire } from 'module'
import { execFileSync } from 'child_process'
import { mkdirSync, rmSync, existsSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
const require = createRequire(import.meta.url)
const { chromium } = require(process.env.PLAYWRIGHT || 'playwright')
const here = dirname(fileURLToPath(import.meta.url))
const out = join(here, 'out')
mkdirSync(out, { recursive: true })
const fps = Number(process.env.FPS || 60)
const stillsArg = process.argv.indexOf('--stills')

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 })
const errors = []
page.on('pageerror', (e) => errors.push(e.message))
await page.goto('file://' + join(here, 'video.html') + '?t=0')
await page.evaluate(() => document.fonts.ready)
if (errors.length) { console.error('page errors:', errors); process.exit(1) }

if (stillsArg > 0) {
  for (const t of process.argv[stillsArg + 1].split(',').map(Number)) {
    await page.evaluate((t) => window.apply(t), t)
    await page.screenshot({ path: join(out, `still-${t}.png`) })
    console.log('still', t)
  }
  await browser.close()
  process.exit(0)
}

const duration = await page.evaluate(() => window.DURATION)
const audio = await page.evaluate(() => window.AUDIO)
const frames = join(out, 'frames')
rmSync(frames, { recursive: true, force: true })
mkdirSync(frames, { recursive: true })
const total = Math.round(duration * fps)
for (let f = 0; f < total; f++) {
  await page.evaluate((t) => window.apply(t), f / fps)
  await page.screenshot({ path: join(frames, String(f).padStart(5, '0') + '.jpg'), type: 'jpeg', quality: 94 })
  if (f % 120 === 0) console.log('frame', f, '/', total)
}
await browser.close()
if (errors.length) { console.error('page errors:', errors); process.exit(1) }

// The soundtrack: each sound placed at its time over silence
const inputs = ['-f', 'lavfi', '-t', String(duration), '-i', 'anullsrc=r=44100:cl=stereo']
const parts = []
audio.forEach(([t, name, gain], i) => {
  const file = join(here, 'assets', name + '.wav')
  if (!existsSync(file)) throw new Error('missing sound ' + file)
  inputs.push('-i', file)
  const ms = Math.round(t * 1000)
  parts.push(`[${i + 1}:a]aformat=sample_rates=44100:channel_layouts=stereo,adelay=${ms}|${ms},volume=${gain}[a${i}]`)
})
const mixIn = ['[0:a]', ...audio.map((_, i) => `[a${i}]`)].join('')
const filter = parts.join(';') + `;${mixIn}amix=inputs=${audio.length + 1}:normalize=0:duration=first[mix]`
const wav = join(out, 'soundtrack.wav')
execFileSync('ffmpeg', ['-nostdin', '-v', 'error', '-y', ...inputs, '-filter_complex', filter, '-map', '[mix]', wav])
const mp4 = join(out, 'session-board-launch.mp4')
execFileSync('ffmpeg', ['-nostdin', '-v', 'error', '-y', '-framerate', String(fps), '-i', join(frames, '%05d.jpg'), '-i', wav,
  '-c:v', 'libx264', '-preset', 'slow', '-crf', '17', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k', '-shortest', '-movflags', '+faststart', mp4])
console.log('wrote', mp4)

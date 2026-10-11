#!/usr/bin/env python3
"""The Session Board landing page (direction A, approved 2026-10-11) as a standalone site:
the approved board's markup, with the Claude Motion film in the hero."""
import os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import gen

OUT = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(os.path.abspath(__file__)), 'site')
os.makedirs(OUT, exist_ok=True)

css, body = gen.page_a()

# The hero's right column: the film, playing by itself, in place of the static board
start = body.index('<div style="position: relative; display: flex; flex-direction: column; align-items: center; gap: 20px">')
end = body.index('\n</section>', start)
video = ('<div class="a-media" style="display: flex; justify-content: center">'
         '<video class="a-video" autoplay muted loop playsinline disablepictureinpicture disableremoteplayback preload="auto" poster="hero.jpg" width="1080" height="1350" '
         'aria-label="Session Board at work: four Claude Code sessions, each line rewriting as the work moves, a side task, '
         'a popup when one needs you, and the highlight following the chat you open">'
         '<source src="hero.mp4" type="video/mp4"></video></div>')
body = body[:start] + video + body[end:]

css += '''
.a-video{width:100%;max-width:540px;height:auto;display:block;background:#0B0B0C;-webkit-mask-image:linear-gradient(to right,transparent 0,#000 5%,#000 95%,transparent 100%),linear-gradient(to bottom,transparent 0,#000 4%,#000 96%,transparent 100%);-webkit-mask-composite:source-in;mask-image:linear-gradient(to right,transparent 0,#000 5%,#000 95%,transparent 100%),linear-gradient(to bottom,transparent 0,#000 4%,#000 96%,transparent 100%);mask-composite:intersect}
button[data-copied] .cp-t{display:inline}
@media (max-width: 900px){.a-video{max-width:460px}}
'''

script = '''
<script>
// Copy buttons: the command after "Copy: " in the button's label
for (const b of document.querySelectorAll('button[aria-label^="Copy: "]')) {
  b.addEventListener('click', async () => {
    const label = b.querySelector('.cp-t');
    try {
      await navigator.clipboard.writeText(b.getAttribute('aria-label').slice(6));
      b.setAttribute('data-copied', '');
      if (label) label.textContent = 'Copied';
      setTimeout(() => { b.removeAttribute('data-copied'); if (label) label.textContent = 'Copy'; }, 1600);
    } catch (e) {}
  });
}
// Motion off: the film holds its first frame
const v = document.querySelector('.a-video');
const still = window.matchMedia('(prefers-reduced-motion: reduce)');
v.muted = true;
function hold() { if (still.matches) { v.removeAttribute('autoplay'); v.pause(); v.currentTime = 0; } else { v.play().catch(() => {}); } }
v.addEventListener('canplay', hold, { once: true });
hold(); still.addEventListener('change', hold);
</script>'''

TITLE = 'Session Board · every Claude Code session at a glance'
DESC = 'A floating Mac window that gives each Claude Code session a live one-line stand-up: what it just did, what it is doing, what is next, and what is waiting on you. Free and open source.'
URL = 'https://sessionboard.dev/'
head = f'''<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{TITLE}</title>
<meta name="description" content="{DESC}">
<meta name="theme-color" content="#0B0B0C">
<meta name="color-scheme" content="dark">
<link rel="icon" href="icon.png">
<link rel="canonical" href="{URL}">
<meta property="og:type" content="website">
<meta property="og:title" content="Session Board">
<meta property="og:description" content="{DESC}">
<meta property="og:url" content="{URL}">
<meta property="og:image" content="{URL}hero.jpg">
<meta name="twitter:card" content="summary_large_image">
<style>{css}
html{{background:#0B0B0C}}</style>
</head>
<body>'''

open(os.path.join(OUT, 'index.html'), 'w').write(head + body + script + '\n</body>\n</html>\n')
print('wrote', os.path.join(OUT, 'index.html'))

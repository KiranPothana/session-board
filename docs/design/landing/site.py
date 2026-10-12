#!/usr/bin/env python3
"""The Session Board landing page (direction A, approved 2026-10-11) as a standalone site:
the approved board's markup, with a live hero where four chats feed the board, and a
"Copy for AI" button that copies docs/ai-overview.md (also published as llms.txt and kept in
the README between its ai-overview markers).

    python3 docs/design/landing/site.py        # rebuilds site/ and the README's copy"""
import os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import gen

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, '..', '..', '..'))
OUT = sys.argv[1] if len(sys.argv) > 1 else os.path.join(ROOT, 'site')
AI_TEXT = open(os.path.join(ROOT, 'docs', 'ai-overview.md')).read().strip()
os.makedirs(OUT, exist_ok=True)

css, body = gen.page_a()

# The hero: a centred headline over a full-width stage where four chats feed the board.
# The animation runs live in the page (hero.js: the Motion film's board code plus the chats),
# so its text stays sharp at any size.
from gen import SANS, MONO, CMD1, CMD2, GH, REQS, ICON, AMBER, GREEN, commands
h0 = body.index('<section class="a-hero"')
h1 = body.index('</section>', h0) + len('</section>')
hero = f"""<section class="hs" style="padding: 24px 0 88px">
<div class="hs-head">
<span style="font: 700 11px {MONO}; letter-spacing: 0.14em; color: {GREEN}">CLAUDE CODE · MAC · OPEN SOURCE</span>
<h1 class="hs-h1">Know what every session is doing.<br><span style="color: #7C7D83">Without opening one.</span></h1>
<p class="hs-sub">One floating window gives each Claude Code chat a live stand-up: what it just did, what it’s doing, what’s next, and what’s waiting on you.</p>
<div style="display: flex; gap: 12px; align-items: center; justify-content: center; flex-wrap: wrap">
<a href="{GH}" style="display: inline-flex; align-items: center; gap: 8px; height: 46px; padding: 0 20px; border-radius: 12px; background: #F2F2F3; color: #0B0B0C; font: 650 15px {SANS}; text-decoration: none">{ICON['github']}Get it on GitHub</a>
<button class="ai-copy" aria-label="Copy an overview for your AI" style="display: inline-flex; align-items: center; gap: 8px; height: 46px; padding: 0 18px; border-radius: 12px; border: 1px solid #34353A; background: transparent; color: #F2F2F3; font: 600 15px {SANS}">{ICON['copy']}<span class="ai-t">Copy for AI</span></button>
<a href="#install" style="display: inline-flex; align-items: center; gap: 8px; height: 46px; padding: 0 18px; border-radius: 12px; color: #B4B5B9; font: 600 15px {SANS}; text-decoration: none">Install in two commands ↓</a>
</div>
</div>
<div class="hs-stage" role="img" aria-label="Four Claude Code chats at work on the left, each feeding its card on the Session Board on the right: summary lines rewriting as the work moves, a side task, cards moving as their state changes, a popup when one needs you, and the highlight following the chat you open">
<div class="hs-chats"></div>
<svg class="hs-wires" aria-hidden="true"></svg>
<div class="hs-board"></div>
</div>
</section>"""
body = body[:h0] + hero + body[h1:]

# Install: let Claude do it. Footer: where bugs and ideas go.
i0 = body.index('<p style="margin: 0; font: 15px/1.55')
body = body[:i0] + f'''<div style="display: flex; align-items: center; gap: 12px; flex-wrap: wrap; font: 15px/1.5 {SANS}; color: #A6A7AC"><span>Or let Claude do it: paste this into any chat.</span><button class="ai-copy" aria-label="Copy an overview for your AI" style="display: inline-flex; align-items: center; gap: 7px; height: 34px; padding: 0 12px; border: 0; border-radius: 8px; background: #26272B; color: #F2F2F3; font: 600 13px {SANS}">{ICON['copy']}<span class="ai-t">Copy for AI</span></button></div>
''' + body[i0:]
body = body.replace('<span>Made for Claude Code. Not an Anthropic product.</span>',
    f'<span>Bug or idea? Tell Claude and say <b style="color: #DADADF; font-weight: 600">report</b>, or <a href="{GH}/issues" style="color: #B4B5B9">open an issue</a>.</span><span>Made for Claude Code. Not an Anthropic product.</span>', 1)
video = ''

css += '''
.hs-head{display:flex;flex-direction:column;align-items:center;text-align:center;gap:18px;max-width:900px;margin:0 auto 52px}
.hs-h1{margin:0;font-size:56px;line-height:1.04;letter-spacing:-.035em;font-weight:750;text-wrap:balance}
.hs-sub{margin:0;max-width:36em;font-size:19px;line-height:1.55;color:#B4B5B9}
.hs-cmds{width:100%;max-width:640px;text-align:left}
.hs-stage{position:relative;display:grid;grid-template-columns:440px minmax(0,1fr);align-items:center;max-width:1160px;margin:0 auto}
.hs-chats{display:flex;flex-direction:column;gap:18px;position:relative;z-index:2}
.hs-board{position:relative;margin-left:auto;z-index:1;overflow:clip;overflow-clip-margin:30px}
@media (max-width: 1180px){.hs-stage{grid-template-columns:340px minmax(0,1fr)}}
.hs-layer{position:absolute;left:0;top:0;width:100%}
.hs-layer .ground{display:none}
.hs-wires{position:absolute;inset:0;width:100%;height:100%;pointer-events:none;overflow:visible;z-index:0}
.hs-wires path{fill:none;stroke-width:1.5;stroke-dasharray:3 7;stroke-linecap:round}
.hs-chat{background:#111214;border:1px solid #2A2B2E;border-radius:12px;overflow:hidden;transform-origin:0 50%;box-shadow:0 18px 40px rgba(0,0,0,.35)}
.hs-bar{height:30px;display:flex;align-items:center;gap:9px;padding:0 12px;border-bottom:1px solid #1F2023}
.hs-dots{display:inline-flex;gap:5px}.hs-dots i{width:9px;height:9px;border-radius:5px;background:#2E2F34;display:block}
.hs-title{font:11.5px ui-monospace,SFMono-Regular,Menlo,monospace;color:#C4C5C9}
.hs-app{margin-left:auto;font-size:11px;color:#8E8F95}
.hs-pip{width:8px;height:8px;border-radius:4px}
.hs-body{height:160px;padding:10px 14px;overflow:hidden;position:relative;-webkit-mask-image:linear-gradient(to bottom,transparent 0,#000 16px);mask-image:linear-gradient(to bottom,transparent 0,#000 16px)}
.hs-lines{display:flex;flex-direction:column}
.hs-l{font:12px/19px ui-monospace,SFMono-Regular,Menlo,monospace;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:#B4B5B9;min-height:19px}
.hs-l.u{color:#F2F2F3}.hs-l.a{color:#DADADF}.hs-l.d{color:#8E8F95}.hs-l.ok{color:#4CC38A}
.is-chat .hs-l{font-family:-apple-system,BlinkMacSystemFont,system-ui,sans-serif;font-size:12.5px;line-height:1.4;white-space:normal}
.is-chat .hs-l.ub{align-self:flex-end;background:#26272B;color:#F2F2F3;border-radius:10px;padding:4px 10px;margin:0 0 8px 70px}
.is-chat .hs-l.ab{color:#DADADF;margin-bottom:6px}
.hs-ask{border:1px solid #F0BE62;border-radius:8px;padding:8px 10px;overflow:hidden;background:rgba(240,190,98,.06);display:flex;flex-direction:column;gap:5px}
.hs-ask-t{font:600 11.5px -apple-system,system-ui,sans-serif;color:#F0BE62}
.hs-ask code{font:11.5px ui-monospace,SFMono-Regular,Menlo,monospace;color:#F2F2F3}
.hs-ask-b{display:flex;gap:6px}.hs-ask-b span{padding:2px 10px;border-radius:6px;border:1px solid #45464B;font:600 11.5px -apple-system,system-ui,sans-serif;color:#DADADF}
.hs-ask-b .hs-allow.on{background:#F2F2F3;color:#0B0B0C;border-color:#F2F2F3}
.sb-wrap{position:absolute;transform-origin:0 0;width:400px;font-family:-apple-system,BlinkMacSystemFont,system-ui,sans-serif;color:#F2F2F3}
.sb{width:400px;background:#0B0B0C;border:1px solid #2A2B2E;border-radius:12px;overflow:hidden;display:flex;flex-direction:column;gap:1px;box-shadow:0 30px 80px rgba(0,0,0,.55)}
.sb-head{background:#131416;padding-bottom:12px}
.sb-chrome{height:30px;display:flex;align-items:center;gap:8px;padding:0 12px;position:relative}
.sb-dot{width:12px;height:12px;border-radius:6px}
.sb-title{position:absolute;left:0;right:0;text-align:center;font-size:12px;color:#8D8E91}
.sb-row{display:flex;align-items:center;gap:10px;padding:4px 14px 0;white-space:nowrap}
.sb-bar{display:flex;gap:2px;height:6px;margin:8px 14px 0}.sb-bar span{min-width:0}
.sb-counts{display:flex;gap:12px;padding:8px 14px 0;font-size:11.5px;color:#B4B5B9;white-space:nowrap}.sb-counts b{color:#F2F2F3}
.sb-pip{display:inline-block;width:6px;height:6px;border-radius:3px;margin-right:5px}
.sb-card{background:#131416;padding:12px 14px 13px}
.sb-top{display:flex;align-items:center;gap:6px}
.sb-num{font:700 10px ui-monospace,SFMono-Regular,Menlo,monospace;color:#0B0B0C;padding:2px 5px;border-radius:2px}
.sb-tag{font:600 9px ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.1em;color:#9A9AA0;border:1px solid #45464B;padding:1px 4px}
.sb-st{font:700 10px ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.12em;position:relative;display:inline-block}
.sb-name{font-size:17px;font-weight:650;letter-spacing:-.01em;white-space:nowrap}.sb-name i{font-style:normal;color:#8D8E91}
.sb-lines{display:flex;flex-direction:column;gap:3px}
.sb-line{font:11.5px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace;display:flex;white-space:nowrap}
.sb-g{flex:none;width:1.25em}.sb-fold{overflow:hidden}
.sb-rw{position:relative;display:block}.sb-rw>.sb-b{position:absolute;left:0;top:0;width:100%}
.sb-tile{position:absolute;width:40px;height:40px}
.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
@media (max-width: 900px){.hs-h1{font-size:38px}.hs-head{margin-bottom:40px}.hs-stage{grid-template-columns:1fr}.hs-chats,.hs-wires{display:none}.hs-board{width:100%;margin:0;overflow:hidden}}
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
// Copy for AI: the overview in #ai-text, for pasting into Claude or any AI
const aiText = document.getElementById('ai-text').textContent.trim();
for (const b of document.querySelectorAll('.ai-copy')) {
  b.addEventListener('click', async () => {
    const label = b.querySelector('.ai-t');
    try {
      await navigator.clipboard.writeText(aiText);
      if (label) label.textContent = 'Copied. Paste it into Claude';
      setTimeout(() => { if (label) label.textContent = 'Copy for AI'; }, 2400);
    } catch (e) {}
  });
}
</script>
<script src="hero.js"></script>''' 

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

# A script element's text is read raw (not decoded as HTML), so only a closing tag could break it
assert '</script' not in AI_TEXT.lower()
ai_block = f'<script type="text/plain" id="ai-text">{AI_TEXT}</script>'
open(os.path.join(OUT, 'index.html'), 'w').write(head + body + ai_block + script + '\n</body>\n</html>\n')
open(os.path.join(OUT, 'hero.js'), 'w').write(open(os.path.join(HERE, 'board-engine.js')).read() + '\n' + open(os.path.join(HERE, 'hero-page.js')).read())
open(os.path.join(OUT, 'llms.txt'), 'w').write(AI_TEXT + '\n')

# The README's copy, between its markers, as a code block (GitHub gives those a copy button)
readme_path = os.path.join(ROOT, 'README.md')
readme = open(readme_path).read()
a, b = '<!-- ai-overview -->', '<!-- /ai-overview -->'
if a in readme and b in readme:
    block = a + '\n\n````text\n' + AI_TEXT + '\n````\n\n' + b
    readme = readme[:readme.index(a)] + block + readme[readme.index(b) + len(b):]
    open(readme_path, 'w').write(readme)
print('wrote', os.path.join(OUT, 'index.html'))

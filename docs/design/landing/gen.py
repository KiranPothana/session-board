#!/usr/bin/env python3
"""Session Board landing page: three directions, each a fluid page written as a canvas file
(.dc.html) and a plain preview (.html) for rendering."""
import json, os, sys

OUT = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.join(OUT, 'canvas')
os.makedirs(os.path.join(ROOT, 'project'), exist_ok=True)
os.makedirs(os.path.join(OUT, 'preview'), exist_ok=True)

SANS = "-apple-system, BlinkMacSystemFont, 'SF Pro Display', 'SF Pro Text', system-ui, sans-serif"
MONO = "ui-monospace, SFMono-Regular, 'SF Mono', Menlo, monospace"
GH = 'https://github.com/KiranPothana/session-board'
CMD1 = 'claude plugin marketplace add KiranPothana/session-board'
CMD2 = 'claude plugin install session-board@session-board'

GREEN, AMBER, GREY = '#4CC38A', '#F0BE62', '#9A9AA0'

# The sample board: generic sessions, every line a kind the real board shows
SESSIONS = [
    dict(n='01', colour='#F472B6', project='api', name='Rate limits for exports', status='NEEDS YOU', time='1m', tag='DESKTOP',
         lines=[('ask', 'Allow: run the migration on staging'),
                ('done', 'Added per-key limits and the 429 reply')]),
    dict(n='02', colour='#4B92FF', project='web-app', name='Fix the login redirect', status='WORKING', time='4m', tag='RC', view=True,
         lines=[('doing', 'Writing tests for the session refresh', 'Tests pass: <span style="white-space: nowrap">14 new, 0 failing</span>'),
                ('done', 'Fixed the redirect loop after sign‑in'),
                ('next', 'Try it on your phone')]),
    dict(n='03', colour='#2EC4B6', project='mobile', name='Offline mode', status='WORKING', time='22m', tag='RC',
         lines=[('doing', 'Caching the feed for offline reads'),
                ('done', 'Drafts now survive a restart'),
                ('next', 'Release to TestFlight')]),
    dict(n='04', colour='#38BDF8', project='docs', name='Rewrite the quickstart', status='IDLE', time='12m', tag='RC',
         lines=[('done', 'Rewrote the quickstart, fixed 6 links'),
                ('wait', 'Review the new install section')]),
]
STATUS_COLOUR = {'WORKING': GREEN, 'NEEDS YOU': AMBER, 'IDLE': GREY}


WAITS_END = ' <span style="white-space: nowrap">· waits on you</span>'


def g(glyph, colour='inherit', small=False):
    inner = f'<span style="font-size: 0.7em; vertical-align: 0.12em">{glyph}</span>' if small else glyph
    return f'<span aria-hidden="true" style="flex: none; width: 1.25em; color: {colour}">{inner}</span>'


def line_html(kind, text, after=None, size=11.5):
    base = f"font: {size}px/1.45 {MONO}; display: flex; min-width: 0;"
    if kind == 'doing' and after:
        # The signature motion: the line rewrites itself from doing to done
        return (f'<span class="rw" style="font: {size}px/1.45 {MONO}; position: relative; display: block; min-height: 1.45em">'
                f'<span class="rw-a" style="display: flex; color: #DADADF">{g("▶", GREEN, True)}<span>{text}</span></span>'
                f'<span class="rw-b" style="display: flex; color: #F2F2F3; position: absolute; left: 0; top: 0">{g("✓", GREEN)}<span>{after}</span></span>'
                f'</span>')
    if kind == 'doing':
        return f'<span style="{base} color: #DADADF">{g("▶", GREEN, True)}<span>{text}</span></span>'
    if kind == 'done':
        return f'<span style="{base} color: {GREY}">{g("✓")}<span>{text}</span></span>'
    if kind == 'next':
        return f'<span style="{base} color: #B4B5B9">{g("·")}<span>{text}</span></span>'
    if kind == 'ask':
        return f'<span style="{base} color: {AMBER}; font-weight: 700">{g("?")}<span>{text}</span></span>'
    if kind == 'wait':
        return f'<span style="{base} color: {AMBER}">{g("!")}<span>{text}{WAITS_END}</span></span>'


def board(width='100%', title=True, scale_name=17):
    counts = {'NEEDS YOU': 0, 'WORKING': 0, 'IDLE': 0}
    for s in SESSIONS:
        counts[s['status']] += 1
    cards = []
    for s in SESSIONS:
        viewed = s.get('view')
        bg = f"background: #17202E; box-shadow: inset 0 0 0 2px {s['colour']};" if viewed else 'background: #131416;'
        lines = ''.join(line_html(*l) for l in s['lines'])
        cards.append(f'''<div style="{bg} padding: 12px 14px 13px; display: flex; flex-direction: column; gap: 6px">
<div style="display: flex; align-items: center; gap: 6px"><span style="font: 700 10px {MONO}; color: #0B0B0C; background: {s['colour']}; padding: 2px 5px; border-radius: 2px">{s['n']}</span><span style="font: 600 9px {MONO}; letter-spacing: 0.1em; color: {GREY}; border: 1px solid #45464B; padding: 1px 4px">{s['tag']}</span><span style="flex: 1"></span><span style="font: 700 10px {MONO}; letter-spacing: 0.12em; color: {STATUS_COLOUR[s['status']]}">{s['status']} <span style="letter-spacing: 0">· {s['time']}</span></span></div>
<div style="font: 650 {scale_name}px/1.25 {SANS}; letter-spacing: -0.01em; white-space: nowrap; overflow: hidden; text-overflow: ellipsis"><span style="color: #8D8E91">{s['project']} · </span>{s['name']}</div>
<div style="display: flex; flex-direction: column; gap: 3px">{lines}</div>
</div>''')
    total = len(SESSIONS)
    chrome = f'''<div style="height: 30px; display: flex; align-items: center; gap: 8px; padding: 0 12px; position: relative">
<span style="width: 12px; height: 12px; border-radius: 6px; background: #FF5F57"></span><span style="width: 12px; height: 12px; border-radius: 6px; background: #FEBC2E"></span><span style="width: 12px; height: 12px; border-radius: 6px; background: #28C840"></span>
<span style="position: absolute; left: 0; right: 0; text-align: center; font: 12px {SANS}; color: #8D8E91; pointer-events: none">Session Board</span></div>''' if title else ''
    return f'''<div role="img" aria-label="The Session Board window: four Claude Code sessions, each with what it just did, what it is doing and what is next" style="width: {width}; max-width: 100%; box-sizing: border-box; background: #0B0B0C; border: 1px solid #2A2B2E; border-radius: 12px; overflow: hidden; display: flex; flex-direction: column; gap: 1px; color: #F2F2F3; text-align: left; -webkit-font-smoothing: antialiased; box-shadow: 0 30px 80px rgba(0,0,0,0.55), 0 0 0 1px rgba(255,255,255,0.03)">
<div style="background: #131416; padding-bottom: 12px">{chrome}
<div style="display: flex; flex-direction: column; gap: 8px; padding: 4px 14px 0">
<div style="display: flex; align-items: center; gap: 10px; white-space: nowrap; font-family: {SANS}"><span style="font-size: 13px; font-weight: 700">Sessions</span><span style="font-size: 12px; color: {GREY}">{total} open</span><span style="flex: 1"></span><span style="display: flex; align-items: center; gap: 4px; color: {GREY}; font-size: 11px"><span style="font: 600 10px {MONO}; padding: 1px 4px; border: 1px solid #45464B; border-radius: 4px">Right ⌥</span>hide</span></div>
<div style="display: flex; gap: 2px; height: 6px"><span style="flex: {counts['NEEDS YOU']}; border-radius: 3px 0 0 3px; background: {AMBER}"></span><span style="flex: {counts['WORKING']}; background: {GREEN}"></span><span style="flex: {counts['IDLE']}; border-radius: 0 3px 3px 0; background: #8D8E91"></span></div>
<div style="display: flex; gap: 12px; font: 11.5px {SANS}; color: #B4B5B9; white-space: nowrap">
<span style="display: flex; align-items: center; gap: 5px"><span style="width: 6px; height: 6px; border-radius: 3px; background: {AMBER}"></span>Needs you <b style="color: #F2F2F3">{counts['NEEDS YOU']}</b></span>
<span style="display: flex; align-items: center; gap: 5px"><span style="width: 6px; height: 6px; border-radius: 3px; background: {GREEN}"></span>Working <b style="color: #F2F2F3">{counts['WORKING']}</b></span>
<span style="display: flex; align-items: center; gap: 5px"><span style="width: 6px; height: 6px; border-radius: 3px; background: #8D8E91"></span>Idle <b style="color: #F2F2F3">{counts['IDLE']}</b></span>
</div></div></div>
{''.join(cards)}
</div>'''


def popup_tile(n='01', colour='#F472B6', size=40):
    # The popup beside the board: number tile, countdown outline, amber dot
    return f'''<span aria-hidden="true" style="position: relative; display: inline-flex; width: {size}px; height: {size}px; flex: none">
<span style="position: absolute; inset: -3px; border: 1.5px solid #F2F2F3; border-radius: 11.5px; clip-path: polygon(0 0, 100% 0, 100% 62%, 0 62%)"></span>
<span style="width: {size}px; height: {size}px; border-radius: 9px; background: {colour}; color: #0B0B0C; display: flex; align-items: center; justify-content: center; font: 700 15px {MONO}">{n}</span>
<span style="position: absolute; top: -5px; right: -5px; width: 9px; height: 9px; border-radius: 5px; background: {AMBER}; box-shadow: 0 0 0 2px #0B0B0C"></span>
</span>'''


ICON = {
    'github': '<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" fill="currentColor"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"></path></svg>',
    'copy': '<svg width="15" height="15" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="12" height="12" rx="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>',
    'play': '<svg width="12" height="12" viewBox="0 0 24 24" aria-hidden="true" fill="currentColor"><path d="M7 4v16l13-8z"></path></svg>',
}

SUPPORT = [
    ('Tells you which one', 'A numbered tile pops up beside the board, with a chime, when a session needs you or finishes.'),
    ('Click to go there', 'Click a name or the tile and you land in that chat: Claude Desktop, Terminal or iTerm2.'),
    ('Project first', 'Names start with their repo in grey, so one project’s sessions read as a group.'),
    ('Out of the way', 'Tap the right ⌥ to show or hide it. Floating or a regular window, light or dark.'),
]

def commands(bg='#0B0B0C', border='#2A2B2E', prompt='#5D5E63', text='#E6E6E9', btn_bg='#26272B', btn_fg='#F2F2F3', size=14):
    rows = ''.join(f'''<div style="display: flex; align-items: flex-start; gap: 12px; padding: 12px 12px 12px 18px; border-top: {'0' if i == 0 else '1px solid ' + border}">
<span aria-hidden="true" style="flex: none; color: {prompt}; font: {size}px/1.6 {MONO}">$</span><code style="flex: 1; min-width: 0; word-break: normal; overflow-wrap: normal; font: {size}px/1.6 {MONO}; color: {text}">{c.replace('/', '/<wbr>').replace('@', '@<wbr>').replace('session-board', '<span style="white-space: nowrap">session-board</span>')}</code>
<button aria-label="Copy: {c}" style="flex: none; display: inline-flex; align-items: center; gap: 6px; height: 32px; padding: 0 10px; border: 0; border-radius: 8px; background: {btn_bg}; color: {btn_fg}; font: 600 12.5px {SANS}">{ICON['copy']}<span class="cp-t">Copy</span></button></div>''' for i, c in enumerate((CMD1, CMD2)))
    return f'<div style="background: {bg}; border: 1px solid {border}; border-radius: 12px; overflow: hidden">{rows}</div>'


REQS = 'Claude Code 2.1.287+ · macOS 15+, Windows 10/11 or Linux'

BASE_CSS = '''
body{margin:0}
*{box-sizing:border-box}
.a-hero>*,.c-hero>*,.b-board>*{min-width:0}
a{color:inherit}
button{font:inherit;color:inherit;cursor:pointer}
.rw-a{animation:rwA 7s ease-in-out infinite}
.rw-b{animation:rwB 7s ease-in-out infinite;opacity:0}
@keyframes rwA{0%,46%{opacity:1;transform:none}54%,92%{opacity:0;transform:translateY(-6px)}100%{opacity:1;transform:none}}
@keyframes rwB{0%,46%{opacity:0;transform:translateY(6px)}54%,92%{opacity:1;transform:none}100%{opacity:0;transform:translateY(6px)}}
@media (prefers-reduced-motion: reduce){.rw-a{animation:none;opacity:0}.rw-b{animation:none;opacity:1;transform:none}}
@media (max-width: 480px){.cp-t{display:none}}
'''


# ---------------------------------------------------------------- A · The stand-up window
def page_a():
    css = BASE_CSS + '''
.a-hero{display:grid;grid-template-columns:minmax(0,1.05fr) minmax(0,0.95fr);gap:64px;align-items:center}
.a-beats{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:1px;background:#222327;border:1px solid #222327;border-radius:14px;overflow:hidden}
.a-support{display:flex;flex-direction:column;border-bottom:1px solid #2A2B2E}
.a-h1{text-wrap:balance}
.a-h1{font-size:60px}
.a-boardwrap{margin-left:56px}
.a-film{margin-left:56px}
@media (max-width: 900px){.a-boardwrap{margin-left:0!important}.a-film{margin-left:0!important}.a-tile{display:none!important}.a-hero{grid-template-columns:1fr;gap:44px}.a-beats{grid-template-columns:1fr}.a-srow{grid-template-columns:1fr!important;gap:6px!important}.a-card{padding:22px!important}.a-h1{font-size:38px}.a-pad{padding-left:20px!important;padding-right:20px!important}}

'''
    beats = [
        ('✓', GREY, 'Just did', 'The last thing it finished, in plain words.', ['Fixed the redirect loop after sign‑in', 'Added per-key limits and the 429 reply']),
        ('▶', GREEN, 'Doing now', 'The work under way, rewritten as it moves.', ['Writing tests for the session refresh', 'Caching the feed for offline reads']),
        ('!', AMBER, 'Next, and what waits on you', 'What’s left, with your part marked in amber.', ['Review the new install section · waits on you', 'Release to TestFlight']),
    ]
    def beat_line(gl, x):
        wait = x.endswith(' · waits on you')
        colour = AMBER if wait else ('#DADADF' if gl == '▶' else '#B4B5B9')
        glyph = gl if (gl != '!' or wait) else '·'
        body = (x[:-15] + WAITS_END) if wait else x
        return f'<span style="display: flex; font: 12.5px/1.45 {MONO}; color: {colour}"><span aria-hidden="true" style="flex: none; width: 1.4em">{glyph}</span><span>{body}</span></span>'
    beat_html = ''.join(f'''<div style="background: #101113; padding: 28px 28px 30px; display: flex; flex-direction: column; gap: 14px">
<div style="display: flex; align-items: center; gap: 10px"><span style="font: 700 20px {MONO}; color: {c}; width: 22px">{gl}</span><span style="font: 650 19px {SANS}; color: #F2F2F3">{t}</span></div>
<p style="margin: 0; font: 15px/1.5 {SANS}; color: #A6A7AC">{d}</p>
<div style="display: flex; flex-direction: column; gap: 6px; padding-top: 4px">{''.join(beat_line(gl, x) for x in ex)}</div>
</div>''' for gl, c, t, d, ex in beats)
    support = ''.join(f'''<div class="a-srow" style="display: grid; grid-template-columns: 260px minmax(0, 1fr); gap: 24px; padding: 16px 0; border-top: 1px solid #2A2B2E">
<span style="font: 650 16px {SANS}; color: #F2F2F3">{t}</span><span style="font: 15px/1.5 {SANS}; color: #A6A7AC">{d}</span></div>''' for t, d in SUPPORT)
    return css, f'''<div style="min-height: 100vh; background: #0B0B0C; color: #F2F2F3; font-family: {SANS}; -webkit-font-smoothing: antialiased">
<div class="a-pad" style="max-width: 1240px; margin: 0 auto; padding: 0 48px">
<nav style="display: flex; align-items: center; gap: 12px; height: 76px">
<span aria-hidden="true" style="display: inline-flex; gap: 3px"><span style="width: 8px; height: 18px; border-radius: 2px; background: {AMBER}"></span><span style="width: 8px; height: 18px; border-radius: 2px; background: {GREEN}"></span><span style="width: 8px; height: 18px; border-radius: 2px; background: #8D8E91"></span></span>
<span style="font: 700 16px {SANS}; letter-spacing: -0.01em">Session Board</span>
<span style="flex: 1"></span>
<a href="{GH}" style="display: inline-flex; align-items: center; gap: 8px; height: 40px; padding: 0 16px; border: 1px solid #34353A; border-radius: 10px; font: 600 14px {SANS}; text-decoration: none; color: #F2F2F3">{ICON['github']}GitHub</a>
</nav>

<section class="a-hero" style="padding: 56px 0 96px">
<div style="display: flex; flex-direction: column; gap: 26px">
<span style="font: 700 11px {MONO}; letter-spacing: 0.14em; color: {GREEN}">CLAUDE CODE · MAC · OPEN SOURCE</span>
<h1 class="a-h1" style="margin: 0; line-height: 1.02; letter-spacing: -0.035em; font-weight: 750">Know what every<br>session is doing.<br><span style="color: #7C7D83">Without opening one.</span></h1>
<p style="margin: 0; max-width: 33em; font: 19px/1.55 {SANS}; color: #B4B5B9">One floating window gives each Claude Code chat a live stand-up: what it just did, what it’s doing, what’s next, and what’s waiting on you.</p>
<div style="display: flex; flex-direction: column; gap: 12px; max-width: 560px">
{commands(bg='#131416', size=13)}
<div style="display: flex; gap: 18px; align-items: center; font: 14px {SANS}; color: #8D8E91; flex-wrap: wrap"><a href="{GH}" style="display: inline-flex; align-items: center; gap: 7px; color: #F2F2F3; font-weight: 600; text-decoration: none">{ICON['github']}View on GitHub →</a><span>{REQS}</span></div>
</div>
</div>
<div style="position: relative; display: flex; flex-direction: column; align-items: center; gap: 20px">
<div class="a-boardwrap" style="width: 100%; max-width: 400px; position: relative">
<div class="a-tile" style="position: absolute; left: -58px; top: 108px; z-index: 2">{popup_tile()}</div>
{board()}</div>
</div>
</section>

<section style="padding: 24px 0 96px; display: flex; flex-direction: column; gap: 28px">
<h2 style="margin: 0; font: 750 40px/1.1 {SANS}; letter-spacing: -0.03em; max-width: 18em">Every chat gives its stand-up. You just glance.</h2>
<div class="a-beats">{beat_html}</div>
</section>

<section style="padding: 0 0 96px; display: flex; flex-direction: column; gap: 22px">
<span style="font: 700 11px {MONO}; letter-spacing: 0.14em; color: #8D8E91">AND AROUND THE SUMMARIES</span>
<div class="a-support">{support}</div>
</section>

<section id="install" style="padding: 0 0 72px">
<div class="a-card" style="background: #131416; border: 1px solid #2A2B2E; border-radius: 18px; padding: 40px; display: flex; flex-direction: column; gap: 20px">
<h2 style="margin: 0; font: 750 34px/1.1 {SANS}; letter-spacing: -0.03em">Two commands. Then open a session.</h2>
{commands()}
<p style="margin: 0; font: 15px/1.55 {SANS}; color: #A6A7AC">The first time, the plugin builds the window app on your Mac in under a minute and opens it. Sessions already running show up too, with no restart. {REQS}.</p>
<div style="display: flex; gap: 12px; flex-wrap: wrap"><a href="{GH}" style="display: inline-flex; align-items: center; gap: 8px; height: 46px; padding: 0 20px; border-radius: 12px; background: #F2F2F3; color: #0B0B0C; font: 650 15px {SANS}; text-decoration: none">{ICON['github']}Get it on GitHub</a></div>
</div>
</section>

<footer style="display: flex; gap: 16px; align-items: center; padding: 28px 0 40px; border-top: 1px solid #1F2023; font: 13px {SANS}; color: #7C7D83; flex-wrap: wrap"><span>Session Board · MIT licence</span><span style="flex: 1"></span><span>Made for Claude Code. Not an Anthropic product.</span></footer>
</div></div>'''


# ---------------------------------------------------------------- B · The stand-up, read out
def page_b():
    css = BASE_CSS + '''
.b-big{font-size:36px}
.b-legend{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:28px}
.b-srow{display:grid;grid-template-columns:260px minmax(0,1fr);gap:24px;padding:16px 0;border-top:1px solid #222327}
.b-row{display:grid;grid-template-columns:64px minmax(0,1fr);gap:22px;align-items:start}
.b-support{display:flex;flex-direction:column;border-bottom:1px solid #222327}
@media (max-width: 900px){.b-big{font-size:17px}.b-row{grid-template-columns:52px minmax(0,1fr);gap:12px}.b-legend{grid-template-columns:1fr 1fr;gap:18px}.b-srow{grid-template-columns:1fr;gap:6px}.b-pad{padding-left:20px!important;padding-right:20px!important}.b-h1{font-size:18px!important}}
@media (max-width: 480px){.b-tag{display:none!important}}
'''
    rows = [
        ('01', '#4B92FF', 'web-app', [('✓', GREY, 'Fixed the redirect loop after sign‑in'), ('▶', GREEN, 'Writing tests for the session refresh')]),
        ('02', '#F472B6', 'api', [('?', AMBER, 'Allow: run the migration on staging')]),
        ('03', '#2EC4B6', 'mobile', [('▶', GREEN, 'Caching the feed for offline reads')]),
        ('04', '#38BDF8', 'docs', [('!', AMBER, 'Review the new install section · waits on you')]),
    ]
    def row(n, c, p, items, first=False):
        lines = []
        for i, (g, col, t) in enumerate(items):
            if first and g == '▶':
                lines.append(f'''<span class="rw" style="position: relative; display: block; min-height: 1.25em"><span class="rw-a" style="display: flex; color: #F2F2F3"><span aria-hidden="true" style="flex: none; width: 1.15em; color: {col}"><span style="font-size: 0.7em; vertical-align: 0.12em">▶</span></span><span>{t}</span></span><span class="rw-b" style="display: flex; position: absolute; left: 0; top: 0; color: #F2F2F3"><span aria-hidden="true" style="flex: none; width: 1.15em; color: {GREEN}">✓</span><span>Tests pass: <span style="white-space: nowrap">14 new, 0 failing</span></span></span></span>''')
            else:
                tc = AMBER if col == AMBER else ('#7C7D83' if g == '✓' else '#F2F2F3')
                body = (t[:-15] + WAITS_END) if t.endswith(' · waits on you') else t
                gl = f'<span style="font-size: 0.7em; vertical-align: 0.12em">{g}</span>' if g == "▶" else g
                lines.append(f'<span style="display: flex; color: {tc}"><span aria-hidden="true" style="flex: none; width: 1.15em; color: {col}">{gl}</span><span>{body}</span></span>')
        return f'''<div class="b-row" style="padding: 26px 0; border-top: 1px solid #1F2023">
<div style="display: flex; flex-direction: column; gap: 8px; padding-top: 6px"><span style="align-self: flex-start; font: 700 13px {MONO}; color: #0B0B0C; background: {c}; padding: 4px 7px; border-radius: 3px">{n}</span><span style="font: 12px {MONO}; color: #7C7D83; white-space: nowrap">{p}</span></div>
<div class="b-big" style="font-family: {MONO}; line-height: 1.25; letter-spacing: -0.02em; display: flex; flex-direction: column; gap: 6px; min-width: 0">{''.join(lines)}</div></div>'''
    support = ''.join(f'''<div class="b-srow"><span style="font: 650 16px {SANS}; color: #F2F2F3">{t}</span><span style="font: 15px/1.5 {SANS}; color: #A6A7AC">{d}</span></div>''' for t, d in SUPPORT)
    legend_items = [('✓', '#B4B5B9', 'JUST DID', 'The last thing it finished, in plain words.'), ('▶', GREEN, 'DOING NOW', 'Rewritten as the work moves. No tool calls, no logs.'), ('·', '#B4B5B9', 'NEXT', 'What’s still to do, one line per piece of work.'), ('!', AMBER, 'WAITS ON YOU', 'Your part, in amber, the moment a session stops on you.')]
    legend = ''.join(f'''<div style="display: flex; flex-direction: column; gap: 6px; border-top: 2px solid {c}; padding-top: 12px"><span style="font: 700 12px {MONO}; letter-spacing: 0.12em; color: {c}">{gl} {t}</span><span style="font: 14.5px/1.5 {SANS}; color: #B4B5B9">{d}</span></div>''' for gl, c, t, d in legend_items)
    return css, f'''<div style="min-height: 100vh; background: #0B0B0C; color: #F2F2F3; font-family: {SANS}; -webkit-font-smoothing: antialiased">
<div class="b-pad" style="max-width: 1180px; margin: 0 auto; padding: 0 48px">
<nav style="display: flex; align-items: center; gap: 12px; height: 76px">
<span style="font: 700 16px {SANS}; white-space: nowrap">Session Board</span><span class="b-tag" style="font: 12px {MONO}; color: #7C7D83; white-space: nowrap">for Claude Code</span><span style="flex: 1"></span>
<a href="#install" style="font: 600 14px {SANS}; color: #B4B5B9; text-decoration: none; padding: 0 12px">Install</a>
<a href="{GH}" style="display: inline-flex; align-items: center; gap: 8px; height: 40px; padding: 0 16px; border-radius: 10px; background: #F2F2F3; color: #0B0B0C; font: 650 14px {SANS}; text-decoration: none">{ICON['github']}GitHub</a>
</nav>

<section style="padding: 64px 0 40px">
<h1 class="b-h1" style="margin: 0 0 14px; font: 750 22px/1.3 {SANS}; letter-spacing: -0.01em; color: #B4B5B9; max-width: 34em">This morning’s stand-up, from four Claude Code sessions. <span style="color: #F2F2F3">Nobody had to open a chat.</span></h1>
{row(*rows[0], first=True)}{row(*rows[1])}{row(*rows[2])}{row(*rows[3])}
<div style="border-top: 1px solid #1F2023; padding-top: 22px; display: flex; gap: 14px; align-items: center; flex-wrap: wrap">
<a href="{GH}" style="display: inline-flex; align-items: center; gap: 8px; height: 48px; padding: 0 22px; border-radius: 12px; background: #F2F2F3; color: #0B0B0C; font: 650 15px {SANS}; text-decoration: none">{ICON['github']}Get Session Board</a>
<a href="#film" style="display: inline-flex; align-items: center; gap: 8px; height: 48px; padding: 0 20px; border-radius: 12px; border: 1px solid #34353A; color: #F2F2F3; font: 600 15px {SANS}; text-decoration: none">{ICON['play']}Watch it work · 20 s</a>
<span style="font: 13px {SANS}; color: #7C7D83">Free and open source · {REQS}</span>
</div>
</section>

<section style="padding: 72px 0 88px">
<h2 style="margin: 0 0 22px; font: 750 34px/1.15 {SANS}; letter-spacing: -0.03em">The same stand-up, live on your Mac.</h2>
<div class="b-legend" style="margin-bottom: 40px">{legend}</div>
<div style="display: flex; justify-content: center">{board(width='420px')}</div>
<p style="margin: 28px auto 0; text-align: center; font: 15px/1.5 {SANS}; color: #8D8E91; max-width: 36em">One window on your Mac for every session: the terminal, Remote Control and Claude Desktop.</p>
</section>

<section style="padding: 0 0 88px; display: flex; flex-direction: column; gap: 18px"><span style="font: 700 11px {MONO}; letter-spacing: 0.14em; color: #8D8E91">AND AROUND THE SUMMARIES</span><div class="b-support">{support}</div></section>

<section id="install" style="padding: 0 0 72px; display: flex; flex-direction: column; gap: 18px; align-items: flex-start">
<h2 style="margin: 0; font: 750 40px/1.1 {SANS}; letter-spacing: -0.03em">Start your next stand-up.</h2>
<div style="width: 100%; max-width: 760px">{commands(bg='#131416')}</div>
<p style="margin: 0; font: 15px/1.55 {SANS}; color: #A6A7AC; max-width: 44em">Then open a Claude Code session. The plugin builds the window app on your Mac the first time, in under a minute. {REQS}.</p>
<a href="{GH}" style="display: inline-flex; align-items: center; gap: 8px; height: 48px; padding: 0 22px; border-radius: 12px; background: #F2F2F3; color: #0B0B0C; font: 650 15px {SANS}; text-decoration: none">{ICON['github']}Get it on GitHub</a>
</section>
<footer style="display: flex; gap: 16px; padding: 28px 0 40px; border-top: 1px solid #1F2023; font: 13px {SANS}; color: #7C7D83; flex-wrap: wrap"><a href="{GH}" style="text-decoration: none">github.com/KiranPothana/session-board</a><span style="flex: 1"></span><span>MIT licence · Not an Anthropic product</span></footer>
</div></div>'''


# ---------------------------------------------------------------- C · Vectorheart (CARI)
VH = dict(ground='#F4F7FA', sky='#CFE6F5', ink='#1E1F22', char='#3B3B3B', mid='#6B6B6B', yellow='#F5C518', orange='#B4470A')

def page_c():
    v = VH
    css = BASE_CSS + '''
.c-hero{display:grid;grid-template-columns:minmax(0,1fr) 420px;gap:56px;align-items:center}
.c-menu{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:20px}
.c-support{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:0}
.c-h1{font-size:96px}
.c-hl{animation:hl 7s steps(1) infinite}
@keyframes hl{0%{transform:translateY(0)}33%{transform:translateY(100%)}66%{transform:translateY(200%)}}
@media (prefers-reduced-motion: reduce){.c-hl{animation:none}}
@media (max-width: 900px){.c-plate{left:0!important;top:16px!important}.c-card{padding:22px!important}.c-watch{padding:0 4px!important}.c-hero{grid-template-columns:1fr;gap:40px}.c-menu{grid-template-columns:1fr}.c-support{grid-template-columns:1fr 1fr}.c-h1{font-size:54px}.c-pad{padding-left:20px!important;padding-right:20px!important}}
@media (max-width: 480px){.c-free,.c-rule{display:none}.c-support{grid-template-columns:1fr}.c-h1{font-size:46px}}
'''
    disp = "'Archivo Narrow', 'Arial Narrow', sans-serif"
    tech = "'Oxanium', " + SANS
    arrow = f'<svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="square"><path d="M4 12h14M12 5l7 7-7 7"></path></svg>'
    tag = lambda n, t: f'<div style="display: flex; align-items: center; gap: 10px; font: 700 12px {tech}; letter-spacing: 0.16em; color: {v["char"]}"><span style="background: {v["ink"]}; color: {v["ground"]}; padding: 3px 7px">{n}</span><span>{t}</span><span class="c-rule" style="flex: 1; height: 2px; background: {v["ink"]}; min-width: 24px"></span></div>'
    menu = [
        ('0001', '✓', 'JUST DID', 'The last thing it finished.', 'Fixed the redirect loop after sign‑in'),
        ('0002', '▶', 'DOING NOW', 'The work under way, rewritten as it moves.', 'Caching the feed for offline reads'),
        ('0003', '!', 'WAITS ON YOU', 'Your part, the moment it stops on you.', 'Review the new install section' + WAITS_END),
    ]
    menu_html = ''.join(f'''<div style="border: 3px solid {v['ink']}; border-radius: 14px; background: #FFFFFF; padding: 22px; display: flex; flex-direction: column; gap: 12px">
<div style="display: flex; justify-content: flex-end"><span style="font: 700 22px {MONO}; color: {v['ink']}">{g}</span></div>
<span style="font: 700 30px/1 {disp}; letter-spacing: 0.01em; color: {v['ink']}">{t}</span>
<span style="font: 15px/1.45 {SANS}; color: {v['char']}">{d}</span>
<span style="display: flex; font: 13px/1.45 {MONO}; color: {v['ink']}; background: {v['sky']}; padding: 8px 10px; border-radius: 6px"><span aria-hidden="true" style="flex: none; width: 1.4em">{g}</span><span>{ex}</span></span>
</div>''' for n, g, t, d, ex in menu)
    support = ''.join(f'''<div style="padding: 4px 22px 6px; border-left: 3px solid {v['ink']}; display: flex; flex-direction: column; gap: 8px"><span style="font: 700 22px/1.05 {disp}; color: {v['ink']}">{t.upper()}</span><span style="font: 14px/1.5 {SANS}; color: {v['char']}">{d}</span></div>''' for i, (t, d) in enumerate(SUPPORT))
    return css, f'''<div style="min-height: 100vh; background: {v['ground']}; color: {v['ink']}; font-family: {SANS}; -webkit-font-smoothing: antialiased">
<div style="background: {v['ink']}; color: {v['ground']}; font: 700 11px {tech}; letter-spacing: 0.18em; text-align: center; padding: 9px 12px">NEW · FOR CLAUDE CODE ON MAC<span class="c-free"> · FREE, OPEN SOURCE</span></div>
<div class="c-pad" style="max-width: 1240px; margin: 0 auto; padding: 0 48px">
<nav style="display: flex; align-items: center; gap: 14px; height: 76px">
<span style="font: 700 22px {disp}; letter-spacing: 0.02em">SESSION BOARD</span><span style="flex: 1"></span>
<a href="{GH}" style="display: inline-flex; align-items: center; gap: 8px; height: 42px; padding: 0 16px; border: 3px solid {v['ink']}; border-radius: 10px; font: 700 14px {tech}; letter-spacing: 0.06em; text-decoration: none">{ICON['github']}GITHUB</a>
</nav>

<section class="c-hero" style="padding: 40px 0 88px">
<div style="display: flex; flex-direction: column; gap: 26px">
{tag('01', 'THE STAND-UP, WITHOUT THE MEETING')}
<h1 class="c-h1" style="margin: 0; font-family: {disp}; font-weight: 700; line-height: 0.9; letter-spacing: -0.01em">EVERY CHAT’S<br>STAND-UP.<br>ONE GLANCE.</h1>
<p style="margin: 0; max-width: 32em; font: 19px/1.55 {SANS}; color: {v['char']}">Session Board writes a one-line stand-up for each Claude Code chat: what it did, what it’s doing, what’s next and what’s waiting on you. You read it in the time it takes to look over.</p>
<div style="display: flex; gap: 12px; flex-wrap: wrap; align-items: center">
<a href="#install" style="display: inline-flex; align-items: center; gap: 10px; height: 54px; padding: 0 22px; background: {v['yellow']}; border: 3px solid {v['ink']}; border-radius: 12px; font: 700 15px {tech}; letter-spacing: 0.08em; color: {v['ink']}; text-decoration: none">INSTALL IN 2 COMMANDS {arrow}</a>
<a href="#film" class="c-watch" style="display: inline-flex; align-items: center; gap: 8px; height: 54px; padding: 0 18px; border-radius: 12px; font: 700 15px {tech}; letter-spacing: 0.08em; color: {v['ink']}; text-decoration: none">{ICON['play']} WATCH · 0:20</a>
</div>
</div>
<div style="position: relative">
<div class="c-plate" aria-hidden="true" style="position: absolute; top: 28px; left: -28px; width: 100%; height: 100%; background: {v['sky']}; border: 3px solid {v['ink']}; border-radius: 18px"></div>
<div style="position: relative">{board()}</div>
</div>
</section>

<section style="padding: 0 0 88px; display: flex; flex-direction: column; gap: 28px">
{tag('02', 'WHAT EACH LINE TELLS YOU')}
<div class="c-menu">{menu_html}</div>
</section>

<section style="padding: 0 0 88px; display: flex; flex-direction: column; gap: 28px">
{tag('03', 'AROUND THE SUMMARIES')}
<div class="c-support" style="border-right: 3px solid {v['ink']}">{support}</div>
</section>

<section id="install" style="padding: 0 0 72px; display: flex; flex-direction: column; gap: 22px">
{tag('04', 'INSTALL')}
<div class="c-card" style="background: {v['ink']}; color: {v['ground']}; border-radius: 18px; padding: 36px; display: flex; flex-direction: column; gap: 18px">
<span style="font: 700 44px/1 {disp}; text-wrap: balance">TWO COMMANDS. THEN OPEN A SESSION.</span>
{commands(bg='#2A2B2F', border='#3A3B40', prompt=v['yellow'], text='#F2F2F3', btn_bg=v['yellow'], btn_fg=v['ink'])}
<div style="display: flex; gap: 14px; flex-wrap: wrap; align-items: center"><a href="{GH}" style="display: inline-flex; align-items: center; gap: 8px; height: 50px; padding: 0 20px; background: {v['yellow']}; color: {v['ink']}; border-radius: 12px; font: 700 15px {tech}; letter-spacing: 0.08em; text-decoration: none">{ICON['github']} GET IT ON GITHUB</a><span style="font: 14px {SANS}; color: #C9CBD0">{REQS}</span></div>
</div>
</section>
<footer style="display: flex; gap: 16px; padding: 24px 0 40px; border-top: 3px solid {v['ink']}; font: 700 11px {tech}; letter-spacing: 0.14em; color: {v['char']}; flex-wrap: wrap"><span>SESSION BOARD · MIT</span><span style="flex: 1"></span><span>NOT AN ANTHROPIC PRODUCT</span></footer>
</div></div>'''


FONTS_C = '<link rel="preconnect" href="https://fonts.googleapis.com"><link href="https://fonts.googleapis.com/css2?family=Archivo+Narrow:wght@700&amp;family=Oxanium:wght@700&amp;display=swap" rel="stylesheet">'


def write(stem, title, css, body, fonts, w, h):
    dc = f'''<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>{title}</title>
<script src="./support.js"></script>
</head>
<body>
<x-dc>
<helmet>
{fonts}
<style>{css}</style>
</helmet>
{body}
</x-dc>
<script type="text/x-dc" data-dc-script data-props='{{"$preview":{{"width":{w},"height":{h}}}}}'>
class Component extends DCLogic {{
renderVals() {{
return {{}};
}}
}}
</script>
</body>
</html>
'''
    open(os.path.join(ROOT, 'project', stem + '.dc.html'), 'w').write(dc)
    prev = f'<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>{title}</title>{fonts}<style>{css}</style></head><body>{body}</body></html>'
    open(os.path.join(OUT, 'preview', stem + '.html'), 'w').write(prev)


if __name__ == '__main__':
    heights = json.loads(sys.argv[1]) if len(sys.argv) > 1 else {}
    pages = {'A': ('A · The stand-up window', page_a, ''), 'B': ('B · The stand-up, read out', page_b, ''), 'C': ('C · Vectorheart', page_c, FONTS_C)}
    for k, (title, fn, fonts) in pages.items():
        css, body = fn()
        write(f'Landing{k}', title + ' · desktop', css, body, fonts, 1440, heights.get(f'Landing{k}', 3000))
        write(f'Landing{k}Phone', title + ' · phone', css, body, fonts, 390, heights.get(f'Landing{k}Phone', 5000))
    print('ok')

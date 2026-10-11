// The hero: four Claude Code chats at work, feeding one Session Board. The board is the
// Motion film's own code (above), run live in the page so it stays sharp at any size.
(() => {
  const SB = window.SB, E = SB.ease, LOOP = SB.LOOP;
  const stage = document.querySelector('.hs-stage');
  if (!stage) return;
  const boardBox = stage.querySelector('.hs-board');
  const chatBox = stage.querySelector('.hs-chats');
  const wires = stage.querySelector('.hs-wires');
  const still = window.matchMedia('(prefers-reduced-motion: reduce)');
  const clamp = (x) => Math.min(1, Math.max(0, x));
  const seg = (t, a, b) => clamp((t - a) / (b - a));

  // Who you're looking at, as the board's highlight shows it
  const VIEW = [[0, 'web'], [3.7, 'docs'], [9.1, 'web'], [10.15, 'api'], [12.6, 'web']];

  // ---- The board: the film's five scenes, each its own layer, one shown at a time
  const SCENES = [
    ['side', 0, 2.4, (S) => {
      S.web.chip = 'chip1';
      S.web.lines = [
        { kind:'side', text:'Fixing the flaky sign-out test', k:'s1', fold:'in' },
        { kind:'doing', text:'Writing tests for the session refresh', k:'d1', to:{ kind:'paused', text:'Writing tests for the session refresh' } },
        { kind:'done', text:'Fixed the redirect loop after sign‑in' },
        { kind:'next', text:'Try it on your phone' },
        { kind:'next', text:'Ship to staging behind a flag' },
      ];
      return { order:SB.ORDER0, view:[[-1, 'web']], counts:{ N:[1], W:[2], I:[1] }, bar:[1, 2, 1], ev:[
        { k:'chip1', do:'show', a:0.3, d:0.3 }, { k:'s1', do:'in', a:0.4, d:0.4 }, { k:'d1', do:'swap', a:0.75 }] };
    }],
    ['resume', 2.4, 4.8, (S) => {
      S.web.chip = 'chip1';
      S.web.lines = [
        { kind:'side', text:'Fixing the flaky sign-out test', k:'s1', fold:'out' },
        { kind:'paused', text:'Writing tests for the session refresh', k:'p1', to:{ kind:'doing', text:'Writing tests for the session refresh' } },
        { kind:'done', text:'Fixed the redirect loop after sign‑in', k:'dn1', to:{ kind:'done', text:'Fixed the flaky sign-out test' } },
        { kind:'next', text:'Try it on your phone' },
        { kind:'next', text:'Ship to staging behind a flag' },
      ];
      S.docs.lines = [
        { kind:'run', text:'Link checker still running · 2m', k:'r4', fold:'out' },
        { kind:'done', text:'Rewrote the quickstart, fixed 6 links', k:'dn4', to:{ kind:'done', text:'Link check passed: 0 broken' } },
        { kind:'wait', text:'Review the new install section' },
        { kind:'next', text:'Add screenshots for Windows' },
      ];
      return { order:SB.ORDER0, view:[[-1, 'web'], [1.3, 'docs']], counts:{ N:[1], W:[2], I:[1] }, bar:[1, 2, 1], ev:[
        { k:'dn1', do:'swap', a:0.25 }, { k:'s1', do:'out', a:0.45, d:0.4 }, { k:'chip1', do:'hide', a:0.45, d:0.3 },
        { k:'p1', do:'swap', a:0.7 }, { k:'dn4', do:'swap', a:1.6 }, { k:'r4', do:'out', a:1.8, d:0.4 }] };
    }],
    ['tests', 4.8, 7.4, (S) => {
      S.web.to = { s:'IDLE', time:'now' };
      S.web.lines = [
        { kind:'doing', text:'Writing tests for the session refresh', k:'l1', to:{ kind:'done', text:'Tests pass: <span style="white-space:nowrap">14 new, 0 failing</span>' } },
        { kind:'done', text:'Fixed the flaky sign-out test', k:'f1', fold:'out' },
        { kind:'next', text:'Try it on your phone', k:'l3', to:{ kind:'wait', text:'Try it on your phone' } },
        { kind:'next', text:'Ship to staging behind a flag' },
      ];
      S.docs.lines = [{ kind:'done', text:'Link check passed: 0 broken' }, { kind:'wait', text:'Review the new install section' }, { kind:'next', text:'Add screenshots for Windows' }];
      return { order:SB.ORDER0, reorder:{ to:['api', 'mobile', 'web', 'docs'], a:1.75, d:0.5 }, view:[[-1, 'docs']], counts:{ N:[1], W:[2, 1], I:[1, 2] }, bar:{ from:[1, 2, 1], to:[1, 1, 2], a:0.95 }, ev:[
        { k:'l1', do:'swap', a:0.3 }, { k:'f1', do:'out', a:0.6 }, { k:'webst', do:'swap', a:0.95 }, { k:'cW', do:'swap', a:0.95 }, { k:'cI', do:'swap', a:0.95 }, { k:'l3', do:'swap', a:1.3 }] };
    }],
    ['turn', 7.4, 10.0, (S) => {
      S.web.s = 'IDLE'; S.web.time = 'now';
      S.web.lines = [{ kind:'done', text:'Tests pass: <span style="white-space:nowrap">14 new, 0 failing</span>' }, { kind:'wait', text:'Try it on your phone' }, { kind:'next', text:'Ship to staging behind a flag' }];
      S.mobile.lines = [
        { kind:'doing', text:'Caching the feed for offline reads', k:'m1', to:{ kind:'doing', text:'Releasing to TestFlight' } },
        { kind:'done', text:'Drafts now survive a restart', k:'m2', to:{ kind:'done', text:'Feed works offline' } },
        { kind:'next', text:'Release to TestFlight', k:'m3', fold:'out' },
        { kind:'next', text:'Check sync after airplane mode' },
      ];
      S.docs.lines = [{ kind:'done', text:'Link check passed: 0 broken' }, { kind:'wait', text:'Review the new install section' }, { kind:'next', text:'Add screenshots for Windows' }];
      return { order:['api', 'mobile', 'web', 'docs'], view:[[-1, 'docs'], [1.7, 'web']], counts:{ N:[1], W:[1], I:[2] }, bar:[1, 1, 2],
        tile:{ id:'web', n:'03', a:0.15, ringEnd:2.6, click:1.6, leave:1.65 }, cursor:{ a:0.75, b:1.5, click:1.6 },
        ev:[{ k:'m2', do:'swap', a:0.5 }, { k:'m1', do:'swap', a:0.8 }, { k:'m3', do:'out', a:1.0 }] };
    }],
    ['approved', 10.0, 13.6, (S) => {
      S.web.s = 'IDLE'; S.web.time = 'now';
      S.web.lines = [{ kind:'done', text:'Tests pass: <span style="white-space:nowrap">14 new, 0 failing</span>' }, { kind:'wait', text:'Try it on your phone' }, { kind:'next', text:'Ship to staging behind a flag' }];
      S.api.to = { s:'WORKING', time:'now' };
      S.api.lines = [
        { kind:'ask', text:'Allow: run the migration on staging', k:'a1', to:{ kind:'doing', text:'Running the migration on staging' } },
        { kind:'done', text:'Added per-key limits and the 429 reply' },
        { kind:'next', text:'Document the new limits' },
      ];
      S.mobile.lines = [{ kind:'doing', text:'Releasing to TestFlight' }, { kind:'done', text:'Feed works offline' }, { kind:'next', text:'Check sync after airplane mode' }];
      S.docs.lines = [{ kind:'done', text:'Link check passed: 0 broken' }, { kind:'wait', text:'Review the new install section' }, { kind:'next', text:'Add screenshots for Windows' }];
      return { order:['api', 'mobile', 'web', 'docs'], view:[[-1, 'web'], [0.15, 'api']], counts:{ N:[1, 0], W:[1, 2], I:[2] }, bar:{ from:[1, 1, 2], to:[0, 2, 2], a:0.75 }, reset:{ a:2.6, d:0.9 }, ev:[
        { k:'a1', do:'swap', a:0.5 }, { k:'apist', do:'swap', a:0.75 }, { k:'cN', do:'swap', a:0.75 }, { k:'cW', do:'swap', a:0.75 }] };
    }],
  ];

  // ---- The chats: what each session shows while the board summarizes it
  const CHATS = [
    { id:'web', app:'Terminal', title:'web-app — claude', pre:[
      ['u', '> fix the login redirect loop'], ['a', '⏺ Fixed the redirect loop after sign‑in'],
      ['a', '⏺ Writing tests for the session refresh'], ['d', '  ⎿ Editing tests/session.test.ts']],
      lines:[[0, 'u', '> also the sign-out test is flaky, fix that first', 110], [1.3, 'a', '⏺ Fixing the flaky sign-out test'],
        [1.8, 'd', '  ⎿ Bash(npm test -- signout)'], [2.55, 'ok', '  ⎿ 3 passed'], [3.1, 'a', '⏺ Back to the session refresh tests'],
        [4.95, 'd', '  ⎿ Bash(npm test)'], [5.15, 'ok', '  ⎿ 14 passed, 0 failed'], [6.0, 'a', '⏺ Done. Try it on your phone when you can.']] },
    { id:'api', app:'Claude Desktop', title:'api', chat:true, pre:[
      ['ub', 'Add per-key rate limits to the export endpoint'],
      ['ab', 'Limits and the 429 reply are in. Last step: migrate staging.']],
      lines:[[10.75, 'ab', 'Running the migration on staging…']], ask:{ cmd:'npm run migrate -- --env staging', press:10.45, gone:10.55 } },
    { id:'mobile', app:'Terminal', title:'mobile — claude', pre:[
      ['u', '> make the feed work offline'], ['a', '⏺ Drafts now survive a restart'], ['a', '⏺ Caching the feed for offline reads'], ['d', '  ⎿ cached 120 posts']],
      lines:[[1.6, 'd', '  ⎿ cached 240 posts'], [3.2, 'd', '  ⎿ cached 480 posts · 3.1 MB'], [6.4, 'ok', '  ⎿ offline test: 12 passed'],
        [7.9, 'a', '⏺ Feed works offline'], [8.2, 'a', '⏺ Releasing to TestFlight'], [8.6, 'd', '  ⎿ Bash(xcodebuild archive)'], [11.5, 'ok', '  ⎿ Archive succeeded']] },
    { id:'docs', app:'Terminal', title:'docs — claude', pre:[
      ['u', '> rewrite the quickstart'], ['a', '⏺ Rewrote the quickstart, fixed 6 links'], ['a', '⏺ Checking every link'], ['d', '  ⎿ Bash(npx linkcheck docs/)'], ['d', '  ⎿ checking 214 links…']],
      lines:[[3.95, 'ok', '  ⎿ 0 broken links'], [4.25, 'a', '⏺ Review the new install section when you’re ready.']] },
  ];
  const ROWS = 7, LH = 19;
  const S0 = SB.S0();
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  for (const c of CHATS) {
    const colour = S0[c.id].colour;
    const lines = [...c.pre.map((p) => [-99, p[0], p[1]]), ...c.lines];
    let ask = '';
    if (c.ask) ask = '<div class="hs-ask"><div class="hs-ask-t">Allow Claude to run</div><code>' + esc(c.ask.cmd) + '</code><div class="hs-ask-b"><span class="hs-allow">Allow</span><span>Deny</span></div></div>';
    const el = document.createElement('div');
    el.className = 'hs-chat' + (c.chat ? ' is-chat' : '');
    el.innerHTML = '<div class="hs-bar"><span class="hs-dots"><i></i><i></i><i></i></span><span class="hs-title">' + esc(c.title) + '</span><span class="hs-app">' + c.app + '</span><span class="hs-pip" style="background:' + colour + '"></span></div>' +
      '<div class="hs-body"><div class="hs-lines">' + lines.map((l) => '<div class="hs-l ' + l[1] + '">' + esc(l[2]) + '</div>').join('') + '</div>' + ask + '</div>';
    el.style.setProperty('--c', colour);
    chatBox.append(el);
    c.el = el; c.all = lines; c.rows = [...el.querySelectorAll('.hs-l')]; c.box = el.querySelector('.hs-lines');
    c.askEl = el.querySelector('.hs-ask'); c.allow = el.querySelector('.hs-allow');
  }
  for (const c of CHATS) {
    const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    p.setAttribute('stroke', S0[c.id].colour);
    wires.append(p);
    c.wire = p;
  }

  // ---- Layout: the board's scale follows the stage's width
  let layers = [], built = false, scale = 1.2, phone = false;
  function build() {
    // The same rule as the page's CSS, so the layout and the board agree
    phone = window.matchMedia('(max-width: 900px)').matches;
    SB.X = phone ? 0 : 72; SB.Y = 0;
    // The board takes the room the chats leave it, up to 1.2x the app's own size
    const room = stage.clientWidth - chatBox.getBoundingClientRect().width - 110 - SB.X;
    scale = phone ? Math.min(1, (stage.clientWidth - 2) / 400) : Math.min(1.2, Math.max(0.8, room / 400));
    boardBox.style.width = phone ? '' : (SB.X + 400 * scale) + 'px';
    SB.zoom = (kit, t) => scale * (1 + (phone ? 0 : 0.006) * Math.sin(2 * Math.PI * (kit.start + t) / LOOP));
    boardBox.innerHTML = ''; layers = [];
    for (const [name, a, z, make] of SCENES) {
      const layer = document.createElement('div');
      layer.className = 'hs-layer';
      boardBox.append(layer);
      const kit = { stage: layer, start: a, h: (html) => { const d = document.createElement('div'); d.innerHTML = html.trim(); return d.firstElementChild; } };
      const S = SB.S0(); const def = make(S); def.sessions = S;
      if (phone) { delete def.tile; delete def.cursor; }
      if (def.cursor) def.cursor.from = [SB.X + 430 * scale, SB.Y + 640 * scale];
      const b = SB.scene(kit, def);
      for (const w of [b, b.start]) if (w) { w.wrap.style.left = SB.X + 'px'; w.wrap.style.top = SB.Y + 'px'; }
      layers.push({ name, a, z, kit, b });
    }
    built = true;
  }

  function wirePath(c, from, to) {
    const x1 = from.right, y1 = from.top + from.height / 2, x2 = to.left, y2 = to.top + Math.min(to.height / 2, 46);
    const mx = (x1 + x2) / 2;
    c.wire.setAttribute('d', 'M' + x1 + ' ' + y1 + ' C' + mx + ' ' + y1 + ' ' + mx + ' ' + y2 + ' ' + x2 + ' ' + y2);
  }

  function render(T) {
    if (!built) build();
    let cur = layers[0];
    for (const L of layers) if (T >= L.a && T < L.z) cur = L;
    for (const L of layers) L.kit.stage.style.visibility = L === cur ? 'visible' : 'hidden';
    SB.run(cur.kit, cur.b, T - cur.a);
    const h = cur.b.wrap.offsetHeight * SB.zoom(cur.kit, T - cur.a);
    boardBox.style.height = Math.ceil(h) + 'px';
    // Who's in front
    const focus = {}; for (const c of CHATS) focus[c.id] = 0;
    focus[VIEW[0][1]] = 1;
    for (let j = 1; j < VIEW.length; j++) { const p = E((T - VIEW[j][0]) / 0.3); for (const c of CHATS) focus[c.id] *= 1 - p; focus[VIEW[j][1]] += p; }
    const reset = E((T - 12.7) / 0.8);
    if (phone) return;
    const sr = stage.getBoundingClientRect();
    for (const c of CHATS) {
      const f = focus[c.id];
      c.el.style.opacity = String(0.72 + 0.28 * f);
      c.el.style.transform = 'scale(' + (0.985 + 0.015 * f) + ')';
      c.el.style.borderColor = f > 0.5 ? 'var(--c)' : '';
      // Lines arrive as the session writes them; the chat scrolls to keep the newest in view
      let shown = 0, scroll = 0;
      c.all.forEach((l, i) => {
        const row = c.rows[i];
        if (l[0] < -50) { row.style.opacity = '1'; shown++; return; }
        const p = E((T - l[0]) / 0.25) * (1 - reset);
        row.style.opacity = String(p);
        // A chat's reply that hasn't come yet takes no room, so the prompt above sits where it should
        if (c.askEl) row.style.display = p > 0 ? '' : 'none';
        if (l[3]) row.textContent = l[2].slice(0, Math.max(0, Math.floor((T - l[0]) * l[3])));
        shown += p;
      });
      scroll = Math.max(0, shown - ROWS - (c.askEl ? -1 : 0)) * LH;
      c.box.style.transform = 'translateY(' + (-scroll) + 'px)';
      if (c.askEl) {
        const gone = E((T - c.ask.gone) / 0.35) * (1 - reset);
        c.askEl.style.opacity = String(1 - gone);
        c.askEl.style.maxHeight = (96 * (1 - gone)) + 'px';
        c.allow.classList.toggle('on', T > c.ask.press - 0.12 && T < c.ask.gone + 0.2 && reset < 0.5);
      }
      const card = cur.b.cards[c.id];
      if (card) {
        const a = c.el.getBoundingClientRect(), b = card.getBoundingClientRect();
        wirePath(c, { right: a.right - sr.left, top: a.top - sr.top, height: a.height }, { left: b.left - sr.left, top: b.top - sr.top, height: b.height });
        c.wire.style.opacity = String(0.22 + 0.6 * f);
        c.wire.style.strokeDashoffset = String(-T * 36);
      }
    }
  }

  let t0 = null, raf = 0;
  function frame(now) {
    if (t0 === null) t0 = now;
    render(((now - t0) / 1000) % LOOP);
    raf = requestAnimationFrame(frame);
  }
  function start() {
    cancelAnimationFrame(raf); t0 = null;
    if (still.matches) render(1.3); else raf = requestAnimationFrame(frame);
  }
  let resizeTimer = 0;
  let builtWidth = stage.clientWidth;
  // Only a change of width rebuilds (a phone's address bar showing or hiding changes the height alone)
  window.addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => { if (stage.clientWidth === builtWidth) return; builtWidth = stage.clientWidth; built = false; start(); }, 150); });
  still.addEventListener('change', start);
  document.addEventListener('visibilitychange', () => { if (document.hidden) cancelAnimationFrame(raf); else start(); });
  // For checking a moment by hand: __heroAt(9.2) freezes the hero there
  window.__heroAt = (T) => { cancelAnimationFrame(raf); render(T); };
  start();
})();

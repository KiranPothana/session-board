window.SB = {
  LOOP: 13.6,
  X: 256, Y: 76,
  C: { green:'#4CC38A', amber:'#F0BE62', grey:'#9A9AA0', soft:'#B4B5B9', ink:'#DADADF', white:'#F2F2F3', dim:'#8D8E91', violet:'#C4B5FD', violetBorder:'#8B6CF0' },
  ease(x) { x = Math.min(1, Math.max(0, x)); return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2; },
  pad(n) { return (n < 10 ? '0' : '') + n; },
  line(l) {
    const C = window.SB.C;
    const look = { doing:['▶', C.ink, C.green, 1], done:['✓', C.grey, C.grey], next:['·', C.soft, C.soft], ask:['?', C.amber, C.amber], wait:['!', C.amber, C.amber], side:['↪', C.violet, C.violet], paused:['⏸', C.grey, C.grey], run:['◷', C.ink, C.ink] }[l.kind];
    const g = look[3] ? '<span style="font-size:.7em;vertical-align:.12em">' + look[0] + '</span>' : look[0];
    const tail = l.kind === 'wait' ? ' <span style="white-space:nowrap">· waits on you</span>' : '';
    const text = l.kind === 'paused' ? 'Paused: ' + l.text : l.text;
    return '<span class="sb-line" style="color:' + look[1] + (l.kind === 'ask' ? ';font-weight:700' : '') + '"><span class="sb-g" style="color:' + look[2] + '">' + g + '</span><span>' + text + tail + '</span></span>';
  },
  status(s) {
    const C = window.SB.C;
    const col = { WORKING:C.green, 'NEEDS YOU':C.amber, IDLE:C.grey }[s.s];
    return '<span style="color:' + col + '">' + s.s + ' <span style="letter-spacing:0">· ' + s.time + '</span></span>';
  },
  swapHtml(k, a, b, inline) { return '<span class="sb-rw" data-k="' + k + '"' + (inline ? ' style="display:inline-block"' : '') + '><span class="sb-a">' + a + '</span><span class="sb-b">' + b + '</span></span>'; },
  // The four sessions as the film opens, by id
  S0() {
    return {
      api: { colour:'#F472B6', project:'api', name:'Rate limits for exports', tag:'DESKTOP', s:'NEEDS YOU', time:'1m', lines:[{ kind:'ask', text:'Allow: run the migration on staging' }, { kind:'done', text:'Added per-key limits and the 429 reply' }, { kind:'next', text:'Document the new limits' }] },
      web: { colour:'#4B92FF', project:'web-app', name:'Fix the login redirect', tag:'RC', s:'WORKING', time:'4m', lines:[{ kind:'doing', text:'Writing tests for the session refresh' }, { kind:'done', text:'Fixed the redirect loop after sign‑in' }, { kind:'next', text:'Try it on your phone' }, { kind:'next', text:'Ship to staging behind a flag' }] },
      mobile: { colour:'#2EC4B6', project:'mobile', name:'Offline mode', tag:'RC', s:'WORKING', time:'22m', lines:[{ kind:'doing', text:'Caching the feed for offline reads' }, { kind:'done', text:'Drafts now survive a restart' }, { kind:'next', text:'Release to TestFlight' }, { kind:'next', text:'Check sync after airplane mode' }] },
      docs: { colour:'#38BDF8', project:'docs', name:'Rewrite the quickstart', tag:'RC', s:'IDLE', time:'12m', lines:[{ kind:'run', text:'Link checker still running · 2m' }, { kind:'done', text:'Rewrote the quickstart, fixed 6 links' }, { kind:'wait', text:'Review the new install section' }, { kind:'next', text:'Add screenshots for Windows' }] },
    };
  },
  ORDER0: ['api', 'web', 'mobile', 'docs'],
  DEF0() { return { sessions: window.SB.S0(), order: window.SB.ORDER0, view: [[-1, 'web']], counts: { N:[1], W:[2], I:[1] }, bar: [1, 2, 1] }; },
  build(kit, def) {
    const SB = window.SB, C = SB.C;
    const order = def.order, order2 = def.reorder ? def.reorder.to : order;
    const cnt = (k, label, col, v) => '<span><span class="sb-pip" style="background:' + col + '"></span>' + label + ' ' + (v.length > 1 ? SB.swapHtml(k, '<b>' + v[0] + '</b>', '<b>' + v[1] + '</b>', true) : '<b>' + v[0] + '</b>') + '</span>';
    let h = '<div class="sb-wrap"><div class="sb"><div class="sb-head"><div class="sb-chrome"><span class="sb-dot" style="background:#FF5F57"></span><span class="sb-dot" style="background:#FEBC2E"></span><span class="sb-dot" style="background:#28C840"></span><span class="sb-title">Session Board</span></div>' +
      '<div class="sb-row"><span style="font-size:13px;font-weight:700">Sessions</span><span style="font-size:12px;color:#9A9AA0">4 open</span><span style="flex:1"></span><span style="font-size:11px;color:#9A9AA0"><span class="mono" style="font-size:10px;font-weight:600;padding:1px 4px;border:1px solid #45464B;border-radius:4px;margin-right:4px">Right ⌥</span>hide</span></div>' +
      '<div class="sb-bar"><span data-k="barN" style="background:' + C.amber + ';border-radius:3px 0 0 3px"></span><span data-k="barW" style="background:' + C.green + '"></span><span data-k="barI" style="background:#8D8E91;border-radius:0 3px 3px 0"></span></div>' +
      '<div class="sb-counts">' + cnt('cN', 'Needs you', C.amber, def.counts.N) + cnt('cW', 'Working', C.green, def.counts.W) + cnt('cI', 'Idle', '#8D8E91', def.counts.I) + '</div></div><div class="sb-list" style="position:relative">';
    for (const id of order) {
      const s = def.sessions[id];
      const n1 = SB.pad(order.indexOf(id) + 1), n2 = SB.pad(order2.indexOf(id) + 1);
      const num = n1 === n2 ? n1 : SB.swapHtml(id + 'num', n1, n2, true);
      const st = s.to ? SB.swapHtml(id + 'st', SB.status(s), SB.status(s.to)) : SB.status(s);
      const chip = s.chip ? '<span class="sb-tag" data-k="' + s.chip + '" style="color:' + C.violet + ';border-color:' + C.violetBorder + '">SIDE TASK</span>' : '';
      const nameCol = s.s === 'IDLE' && !s.to ? 'color:#D5D6D9' : '';
      h += '<div class="sb-card" data-c="' + id + '" style="position:absolute;left:0;right:0;top:0">' +
        '<div class="sb-hl" data-h="' + id + '" style="position:absolute;inset:0;background:color-mix(in srgb, ' + s.colour + ' 12%, #131416);box-shadow:inset 0 0 0 2px ' + s.colour + ';opacity:0"></div>' +
        '<div style="position:relative;display:flex;flex-direction:column;gap:6px"><div class="sb-top"><span class="sb-num" style="background:' + s.colour + '">' + num + '</span><span class="sb-tag">' + s.tag + '</span>' + chip + '<span style="flex:1"></span><span class="sb-st">' + st + '</span></div>' +
        '<div class="sb-name" style="' + nameCol + '"><i>' + s.project + ' · </i>' + s.name + '</div><div class="sb-lines">';
      for (const l of s.lines) {
        let inner = l.to ? SB.swapHtml(l.k, SB.line(l), SB.line(l.to)) : SB.line(l);
        if (l.fold) inner = '<div class="sb-fold" data-k="' + l.k + '" data-f="' + l.fold + '" data-c="' + id + '">' + inner + '</div>';
        h += inner;
      }
      h += '</div></div></div>';
    }
    h += '</div></div></div>';
    const el = kit.h('<div>' + h + '</div>');
    kit.stage.append(el);
    const parts = {};
    for (const n of el.querySelectorAll('[data-k]')) parts[n.getAttribute('data-k')] = n;
    const b = { el, def, wrap: el.querySelector('.sb-wrap'), list: el.querySelector('.sb-list'), k: (x) => parts[x], cards: {}, hl: {}, H: {}, folds: [] };
    for (const n of el.querySelectorAll('.sb-card')) { b.cards[n.dataset.c] = n; b.H[n.dataset.c] = n.offsetHeight; }
    for (const n of el.querySelectorAll('.sb-hl')) b.hl[n.dataset.h] = n;
    for (const n of el.querySelectorAll('.sb-fold')) b.folds.push({ node: n, c: n.dataset.c, f: n.dataset.f, h: n.scrollHeight + 3 });
    b.listTop = b.list.offsetTop;
    if (def.tile) SB.buildTile(kit, b, def.tile);
    if (def.cursor) SB.buildCursor(kit, b);
    return b;
  },
  buildTile(kit, b, tile) {
    const colour = b.def.sessions[tile.id].colour;
    const n = kit.h('<div class="sb-tile" style="left:-58px;top:' + b.listTop + 'px;opacity:0">' +
      '<svg width="46" height="46" viewBox="0 0 46 46" style="position:absolute;left:-3px;top:-3px;overflow:visible"><rect class="sb-ring" x="0.75" y="0.75" width="44.5" height="44.5" rx="11.5" fill="none" stroke="#F2F2F3" stroke-width="1.5" pathLength="100" stroke-dasharray="100"/></svg>' +
      '<div style="position:absolute;inset:0;border-radius:9px;background:' + colour + ';color:#0B0B0C;display:flex;align-items:center;justify-content:center;font:700 15px var(--mono, ui-monospace, monospace)">' + tile.n + '</div>' +
      '<span style="position:absolute;top:-5px;right:-5px;width:9px;height:9px;border-radius:5px;background:#F0BE62;box-shadow:0 0 0 2px #0B0B0C"></span></div>');
    b.wrap.append(n);
    b.tile = n; b.ring = n.querySelector('.sb-ring');
  },
  buildCursor(kit, b) {
    const n = kit.h('<div style="position:absolute;left:0;top:0;width:34px;height:34px;opacity:0;z-index:5">' +
      '<span class="sb-click" style="position:absolute;left:-22px;top:-22px;width:44px;height:44px;border-radius:22px;border:3px solid #F2F2F3;opacity:0"></span>' +
      '<svg width="34" height="34" viewBox="0 0 24 24" style="position:absolute;left:0;top:0;filter:drop-shadow(0 2px 4px rgba(0,0,0,.5))"><path d="M4 2 L4 19 L8.6 14.8 L11.6 21.4 L14.6 20 L11.7 13.6 L18 13.4 Z" fill="#F2F2F3" stroke="#0B0B0C" stroke-width="1.3" stroke-linejoin="round"/></svg></div>');
    kit.stage.append(n);
    b.cursor = n; b.click = n.querySelector('.sb-click');
  },
  zoom(kit, t) { return 1.66 + 0.02 * Math.sin(2 * Math.PI * (kit.start + t) / window.SB.LOOP); },
  run(kit, b, t, tl) {
    const SB = window.SB, def = b.def, E = SB.ease;
    const local = tl === undefined ? t : tl;
    const z = SB.zoom(kit, t);
    b.wrap.style.transform = 'scale(' + z + ')';
    const open = {};
    for (const e of def.ev || []) {
      const p = E((local - e.a) / (e.d || 0.35));
      const node = b.k(e.k);
      if (e.do === 'swap') {
        const a = node.children[0].style, c = node.children[1].style;
        const out = Math.min(1, p * 2), inn = Math.max(0, p * 2 - 1);
        a.opacity = 1 - out; a.transform = 'translateY(' + (-5 * out) + 'px)';
        c.opacity = inn; c.transform = 'translateY(' + (5 * (1 - inn)) + 'px)';
      } else if (e.do === 'in') open[e.k] = p;
      else if (e.do === 'out') open[e.k] = 1 - p;
      else if (e.do === 'show') { node.style.opacity = p; node.style.transform = 'scale(' + (0.85 + 0.15 * p) + ')'; }
      else if (e.do === 'hide') node.style.opacity = 1 - p;
    }
    const hh = Object.assign({}, b.H);
    for (const f of b.folds) {
      const o = open[f.node.dataset.k] !== undefined ? open[f.node.dataset.k] : (f.f === 'in' ? 0 : 1);
      f.node.style.height = ((f.h - 3) * o) + 'px';
      f.node.style.opacity = o;
      hh[f.c] -= f.h * (1 - o);
    }
    const order = def.order, order2 = def.reorder ? def.reorder.to : order;
    const op = def.reorder ? E((local - def.reorder.a) / (def.reorder.d || 0.45)) : 0;
    const ys = (ord) => { const y = {}; let acc = 0; for (const id of ord) { y[id] = acc; acc += hh[id] + 1; } return [y, acc - 1]; };
    const [ya, total] = ys(order), [yb] = ys(order2);
    for (const id of order) {
      b.cards[id].style.transform = 'translateY(' + (ya[id] + (yb[id] - ya[id]) * op) + 'px)';
      b.cards[id].style.zIndex = yb[id] > ya[id] && op > 0 && op < 1 ? '2' : '1';
    }
    b.list.style.height = total + 'px';
    if (def.reorder) for (const id of order) { const k = b.k(id + 'num'); if (k) { k.children[0].style.opacity = 1 - op; k.children[1].style.opacity = op; } }
    const view = {}; for (const id of order) view[id] = 0;
    view[def.view[0][1]] = 1;
    for (let j = 1; j < def.view.length; j++) {
      const p = E((local - def.view[j][0]) / 0.3);
      for (const id of order) view[id] *= 1 - p;
      view[def.view[j][1]] += p;
    }
    for (const id of order) b.hl[id].style.opacity = view[id];
    if (def.bar) {
      const bar = def.bar.length ? { from: def.bar, to: def.bar, a: 0 } : def.bar;
      const p = E((local - bar.a) / (bar.d || 0.35));
      const v = (i) => String(bar.from[i] + (bar.to[i] - bar.from[i]) * p);
      b.k('barN').style.flex = v(0); b.k('barW').style.flex = v(1); b.k('barI').style.flex = v(2);
    }
    if (def.tile) {
      const T = def.tile;
      const enter = E((local - T.a) / 0.3), leave = E((local - T.leave) / 0.3);
      const press = T.click !== undefined ? Math.max(0, 1 - Math.abs(local - T.click) / 0.12) : 0;
      b.tile.style.opacity = enter * (1 - leave);
      b.tile.style.transform = 'translateX(' + (10 * (1 - enter)) + 'px) scale(' + ((1 - 0.04 * leave) * (1 - 0.06 * press)) + ')';
      b.ring.setAttribute('stroke-dashoffset', String(100 * Math.min(1, Math.max(0, (local - T.a - 0.3) / (T.ringEnd - T.a - 0.3)))));
    }
    if (b.cursor) {
      const K = def.cursor;
      const tx = SB.X + (-26) * z, ty = SB.Y + (b.listTop + 31) * z;
      const p = E((local - K.a) / (K.b - K.a));
      const x = K.from[0] + (tx - K.from[0]) * p, y = K.from[1] + (ty - K.from[1]) * p - Math.sin(Math.PI * p) * 60;
      b.cursor.style.transform = 'translate(' + x + 'px,' + y + 'px)';
      b.cursor.style.opacity = E((local - K.a + 0.2) / 0.2) * (1 - E((local - K.click - 0.5) / 0.3));
      const r = Math.min(1, Math.max(0, (local - K.click) / 0.3));
      b.click.style.opacity = local >= K.click ? 1 - r : 0;
      b.click.style.transform = 'scale(' + (0.5 + 0.7 * r) + ')';
    }
    if (def.reset) {
      if (!b.start) return;
      const p = E((local - def.reset.a) / (def.reset.d || 0.9));
      b.start.el.style.opacity = p;
      b.el.style.opacity = 1 - p;
      SB.run(kit, b.start, t, -10);
    }
  },
  scene(kit, def) {
    const SB = window.SB;
    kit.stage.append(kit.h('<div class="ground"></div>'));
    const b = SB.build(kit, def);
    if (def.reset) b.start = SB.build(kit, SB.DEF0());
    return b;
  },
};

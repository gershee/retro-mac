// Retro Mac: CLOCK module. Opt-in, additive: default is OFF and the v1 look is then byte-for-byte unchanged (only a tiny "CLK" tag).
// ONE variant is active at a time. Key C (or a click on the tiny CLK tag, top right) cycles
//     off -> flip -> cuckoo -> screensaver -> morph -> off
// and the choice is persisted by the server (settings.json "clock", POST /event {"clock": "flip"}) like theme / menubar / tone.
//   flip         chunky 1-bit split-flap clock in the free top-left corner; every minute the changed cards flip (flap folds down).
//   cuckoo       a little cuckoo-clock house in the same corner; the main face glances up at it now and then and ON THE HOUR one of
//                the crew (Alfred / Scout / Maker in turn) pops out of the roof door once per hour (max 12 pops) and says the time.
//                Silent hours 10 PM - 7 AM (it would only wake the face).
//   screensaver  After-Dark-ish: after 10 min of quiet (or automatically inside burnin.js night rest) the dashboard dissolves into
//                big drifting digits, a twinkling star field and a tiny sleeping crew face. Any key / mouse / speech / crew work wakes
//                it instantly. Switching to it plays an 8 s demo so you can see it.
//   morph        a classic-Mac "CLOCK" window with Chicago-ish chunky digits that dither-melt into the next digit each minute.
// Burn-in rules (works with web/burnin.js): the whole canvas still orbits at the DOM level; on top of that every overlay clock
// drifts a pixel at a time on a ~5-7 min Lissajous inside its corner, and inverts (ink <-> paper) every 10 min at a minute boundary
// (flip: the cards flip over to show it). Nothing blinks faster than 1 Hz; the screensaver moves 1 px per 600 ms.
// The AOL skin keeps its own taskbar clock: nothing of this module is drawn there (face.js calls RetroClock.hide()).
// Test / preview params: ?clock=<variant>  (local only, nothing persisted)   ?clocktime=H:MM[:SS]  fake wall clock (ticks on)
//   ?clockidle=<sec> quiet time before the screensaver takes over (default 600)   ?clockinv=<sec> invert period (default 600)
//   ?clockcuckoo=<sec> fire the hourly announcement N seconds after load (any hour, ignores quiet hours)
// window.RetroClock.state() inspects it; RetroClock.announce(agent) / .set(variant) / .cycle() drive it from tests.
(function () {
  const W = 512, H = 342;
  const params = new URLSearchParams(location.search);
  const VARIANTS = ['off', 'flip', 'cuckoo', 'screensaver', 'morph'];
  const LABEL = { off: 'OFF', flip: 'FLIP', cuckoo: 'CUCKOO', screensaver: 'SAVER', morph: 'MORPH' };
  const num = (k, d) => { const v = parseFloat(params.get(k)); return params.has(k) && isFinite(v) ? v : d; };
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const INK = '#000', PAPER = '#fff';
  const URL_VARIANT = VARIANTS.includes(params.get('clock')) ? params.get('clock') : null;
  const SS_IDLE = num('clockidle', 600) * 1000;          // screensaver takes over after this much quiet
  const INV_S = Math.max(5, num('clockinv', 600));       // invert period (s)
  const DEMO_MS = 8000;
  let variant = URL_VARIANT || 'off';

  // ------------------------------------------------------------------ wall clock (America/New_York, like the menu bar)
  const TZ = 'America/New_York';
  const tf = new Intl.DateTimeFormat('en-US', { timeZone: TZ, hourCycle: 'h23', month: 'short', day: 'numeric', weekday: 'short', hour: 'numeric', minute: 'numeric', second: 'numeric' });
  function parts(ms) {
    const o = {}; for (const p of tf.formatToParts(new Date(ms))) o[p.type] = p.value;
    return { h: (+o.hour) % 24, m: +o.minute, s: +o.second, dow: (o.weekday || '').toUpperCase(), mon: (o.month || '').toUpperCase(), day: +o.day };
  }
  let OFFSET = 0;
  {
    let target = null;
    const m = (params.get('clocktime') || '').match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
    if (m) target = (+m[1]) * 3600 + (+m[2]) * 60 + (+(m[3] || 0));
    else if (params.has('hour') && isFinite(parseFloat(params.get('hour')))) target = parseFloat(params.get('hour')) * 3600;   // same fake hour face.js uses
    if (target !== null) { const p = parts(Date.now()); OFFSET = (target - (p.h * 3600 + p.m * 60 + p.s)) * 1000; }
  }
  const nowMs = () => Date.now() + OFFSET;
  let clk = null, clkAt = 0;
  function readClock() {
    const t = performance.now();
    if (clk && t - clkAt < 200) return clk;
    clkAt = t;
    const ms = nowMs(), p = parts(ms), h12 = p.h % 12 === 0 ? 12 : p.h % 12;
    const hs = h12 >= 10 ? ['1', String(h12 % 10)] : ['', String(h12)], mm = (p.m < 10 ? '0' : '') + p.m;
    clk = { ms, h24: p.h, h12, m: p.m, s: p.s, ampm: p.h < 12 ? 'AM' : 'PM', dow: p.dow, mon: p.mon, day: p.day,
      digits: [hs[0], hs[1], mm[0], mm[1]], key: Math.floor(ms / 60000), hourKey: Math.floor(ms / 3600000) };
    return clk;
  }
  const isNight = (h24) => h24 >= 23.5 || h24 < 6;

  // ------------------------------------------------------------------ chunky digits (7 x 11, 2 px strokes, Chicago-ish)
  const GLYPH_SRC = {
    '0': ['.#####.', '##...##', '##...##', '##...##', '##...##', '##...##', '##...##', '##...##', '##...##', '##...##', '.#####.'],
    '1': ['...##..', '.####..', '##.##..', '...##..', '...##..', '...##..', '...##..', '...##..', '...##..', '...##..', '.######'],
    '2': ['.#####.', '##...##', '.....##', '.....##', '....##.', '...##..', '..##...', '.##....', '##.....', '##.....', '#######'],
    '3': ['.#####.', '##...##', '.....##', '.....##', '..####.', '.....##', '.....##', '.....##', '##...##', '##...##', '.#####.'],
    '4': ['....##.', '...###.', '..####.', '.##.##.', '##..##.', '##..##.', '#######', '....##.', '....##.', '....##.', '....##.'],
    '5': ['#######', '##.....', '##.....', '##.....', '######.', '.....##', '.....##', '.....##', '##...##', '##...##', '.#####.'],
    '6': ['..####.', '.##....', '##.....', '##.....', '######.', '##...##', '##...##', '##...##', '##...##', '##...##', '.#####.'],
    '7': ['#######', '.....##', '.....##', '....##.', '....##.', '...##..', '...##..', '..##...', '..##...', '.##....', '.##....'],
    '8': ['.#####.', '##...##', '##...##', '##...##', '.#####.', '##...##', '##...##', '##...##', '##...##', '##...##', '.#####.'],
    '9': ['.#####.', '##...##', '##...##', '##...##', '##...##', '.######', '.....##', '.....##', '.....##', '....##.', '.####..'],
    '': ['.......', '.......', '.......', '.......', '.......', '.......', '.......', '.......', '.......', '.......', '.......'],
  };
  const GW = 7, GH = 11;
  const GL = {};
  for (const k in GLYPH_SRC) GL[k] = GLYPH_SRC[k].map(r => Array.from(r, c => c === '#'));
  function glyph(ctx, d, x, y, sc, color) {            // solid glyph, horizontal runs merged
    const g = GL[d] || GL[''];
    ctx.fillStyle = color;
    for (let r = 0; r < GH; r++) {
      const row = g[r];
      for (let c = 0; c < GW; c++) {
        if (!row[c]) continue;
        let e = c; while (e + 1 < GW && row[e + 1]) e++;
        ctx.fillRect(x + c * sc, y + r * sc, (e - c + 1) * sc, sc);
        c = e;
      }
    }
  }
  const FONT = 'bold 9px Menlo, "Courier New", monospace';
  const FONT_S = 'bold 10px Menlo, "Courier New", monospace';   // date / AM-PM labels: 9px Menlo breaks up under the 1-bit threshold
  const text = (ctx, s, x, y, color, font) => { ctx.fillStyle = color || INK; ctx.font = font || FONT; ctx.textBaseline = 'middle'; ctx.fillText(s, x, y); };
  const box = (ctx, x, y, w, h, bw, color) => { ctx.fillStyle = color; ctx.fillRect(x, y, w, bw); ctx.fillRect(x, y + h - bw, w, bw); ctx.fillRect(x, y, bw, h); ctx.fillRect(x + w - bw, y, bw, h); };
  let checker = null;
  function checkerPat(ctx) {
    if (checker) return checker;
    const c = document.createElement('canvas'); c.width = 2; c.height = 2;
    const g = c.getContext('2d'); g.fillStyle = INK; g.fillRect(0, 0, 1, 1); g.fillRect(1, 1, 1, 1);
    return (checker = ctx.createPattern(c, 'repeat'));
  }
  // 8x8 Bayer matrix, 0..63: the dither used for every melt / dissolve
  const BAYER = (() => {
    const b4 = [[0, 8, 2, 10], [12, 4, 14, 6], [3, 11, 1, 9], [15, 7, 13, 5]], m = [];
    for (let y = 0; y < 8; y++) { m.push([]); for (let x = 0; x < 8; x++) m[y].push(4 * b4[y & 3][x & 3] + [[0, 2], [3, 1]][y >> 2][x >> 2]); }
    return m;
  })();

  // ------------------------------------------------------------------ drift + invert (burn-in)
  function drift(ms, ax, ay) {                          // integer-pixel Lissajous, ~7 min x / ~5 min y: a 1 px step every ~10 s at most
    return { dx: Math.round(ax * Math.sin(2 * Math.PI * ms / 421000)), dy: Math.round(ay * Math.sin(2 * Math.PI * ms / 317000 + 1)) };
  }
  const invAt = (ms) => Math.floor(ms / 1000 / INV_S) % 2 === 1;
  // where each overlay variant sits at wall-clock time `ms` (pure, so tests can walk hours of drift): top-left corner, free of the
  // weather panel (x >= 214), the face (y >= ~122) and the menu bar (y < 14)
  function place(v, ms) {
    const d = drift(ms, 6, 4);
    if (v === 'flip') return { x: 14 + d.dx, y: 24 + d.dy, w: 159, h: 70, dx: d.dx, dy: d.dy };
    if (v === 'cuckoo') return { x: 15 + d.dx, y: 22 + d.dy, w: 190, h: 92, dx: d.dx, dy: d.dy };      // w includes the speech bubble
    if (v === 'morph') return { x: 14 + d.dx, y: 24 + d.dy, w: 178, h: 72, dx: d.dx, dy: d.dy };
    if (v === 'screensaver') { const p = saverPos(ms); return { x: p.px, y: p.py, w: p.bw, h: p.bh, dx: 0, dy: 0 }; }
    return null;
  }

  // ------------------------------------------------------------------ activity / state
  let lastActive = performance.now(), demoUntil = 0, demoStart = 0, ssEnter = 0, ssOn = false, hiddenAt = -1e9, busyUntil = 0, drawn = null;
  let toast = null, toastUntil = 0, tagRect = null, lastEnv = null, lastDrawAt = -1e9;
  const typing = (el) => !!el && (el.isContentEditable || ['TEXTAREA', 'SELECT'].includes(el.tagName) ||
    (el.tagName === 'INPUT' && !['range', 'button', 'checkbox', 'radio'].includes((el.type || '').toLowerCase())));
  function active() {
    const t = performance.now();
    lastActive = t;
    if (demoUntil && t - demoStart > 700) demoUntil = 0;   // anything after the first instant ends the demo
  }
  addEventListener('pointerdown', active, true);
  let lastMove = 0;
  addEventListener('mousemove', () => { const t = performance.now(); if (t - lastMove > 400) { lastMove = t; active(); } });
  addEventListener('keydown', (e) => {
    active();
    if (e.metaKey || e.ctrlKey || e.altKey || e.repeat || typing(e.target)) return;
    if ((e.key === 'c' || e.key === 'C') && performance.now() - hiddenAt > 1500) cycle();
  }, true);

  function apply(v, quiet) {
    if (!VARIANTS.includes(v) || v === variant) return;
    variant = v;
    flipCards = []; morphSlots = []; ann = null; nextGlance = 0;
    if (!quiet) { toast = 'CLOCK: ' + LABEL[v]; toastUntil = performance.now() + 2600; }
    if (v === 'screensaver' && !quiet) { demoStart = performance.now(); demoUntil = demoStart + DEMO_MS; }
    else { demoUntil = 0; }
    busyUntil = performance.now() + 400;
  }
  function set(v) {
    if (!VARIANTS.includes(v)) return;
    apply(v);
    if (URL_VARIANT) return;                              // a ?clock= preview page stays local
    fetch('/event', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ clock: v }) }).catch(() => {});
  }
  const cycle = () => set(VARIANTS[(VARIANTS.indexOf(variant) + 1) % VARIANTS.length]);
  function setting(v) { if (!URL_VARIANT) apply(v); }      // the server's `settings` broadcast (also on connect)

  // ------------------------------------------------------------------ FLIP
  const FLIP_MS = 420, CW = 34, CH = 50;
  let flipCards = [];
  const CARD_X = [0, 37, 83, 120];
  function cardHalf(ctx, x, y, f, half) {               // one half of a card face: bg, border, digit, split line
    if (!f.d) return;                                   // blank hour-tens card (1-9 o'clock): an empty framed card read as '8'
    const ink = f.inv ? PAPER : INK, bg = f.inv ? INK : PAPER, h2 = CH / 2;
    ctx.save();
    ctx.beginPath(); ctx.rect(x, half === 'top' ? y : y + h2, CW, h2); ctx.clip();
    ctx.fillStyle = bg; ctx.fillRect(x, y, CW, CH);
    if (f.d) glyph(ctx, f.d, x + 3, y + 3, 4, ink);
    ctx.fillStyle = INK; ctx.fillRect(x, y, CW, 2); ctx.fillRect(x, y + CH - 2, CW, 2); ctx.fillRect(x, y, 2, CH); ctx.fillRect(x + CW - 2, y, 2, CH);
    ctx.fillStyle = ink; ctx.fillRect(x + 2, y + h2 - 1, CW - 4, 2);                    // the split / hinge
    ctx.fillStyle = INK; ctx.fillRect(x, y + h2 - 2, 3, 4); ctx.fillRect(x + CW - 3, y + h2 - 2, 3, 4);   // hinge pins
    ctx.restore();
  }
  function drawFlip(ctx, t, x0, y0, c, inv) {
    const target = c.digits.map(d => ({ d, inv }));
    let anim = false;
    for (let i = 0; i < 4; i++) {
      let k = flipCards[i];
      if (!k) k = flipCards[i] = { shown: target[i], anim: false, from: null, to: null, t0: 0 };
      if (!k.anim && (k.shown.d !== target[i].d || k.shown.inv !== target[i].inv)) { k.anim = true; k.from = k.shown; k.to = target[i]; k.t0 = t; }
      const x = x0 + CARD_X[i], y = y0, mid = y + CH / 2;
      if (!k.anim) {
        if (!k.shown.inv && k.shown.d) { ctx.fillStyle = INK; ctx.fillRect(x + 2, y + CH, CW, 2); ctx.fillRect(x + CW, y + 2, 2, CH); }   // 2 px drop shadow (paper look)
        cardHalf(ctx, x, y, k.shown, 'top'); cardHalf(ctx, x, y, k.shown, 'bottom');
        continue;
      }
      anim = true;
      const p = clamp((t - k.t0) / FLIP_MS, 0, 1);
      if (!k.to.inv && k.to.d) { ctx.fillStyle = INK; ctx.fillRect(x + 2, y + CH, CW, 2); ctx.fillRect(x + CW, y + 2, 2, CH); }
      cardHalf(ctx, x, y, k.to, 'top'); cardHalf(ctx, x, y, k.from, 'bottom');
      const up = p < 0.5, s = Math.max(0.04, Math.round((up ? 1 - p * 2 : (p - 0.5) * 2) * 6) / 6);   // stepped: a retro cut, not a smooth zoom
      ctx.save();
      ctx.translate(0, mid); ctx.scale(1, s); ctx.translate(0, -mid);
      cardHalf(ctx, x, y, up ? k.from : k.to, up ? 'top' : 'bottom');
      if (s < 0.85 && (up ? k.from : k.to).d) { ctx.fillStyle = checkerPat(ctx); ctx.fillRect(x + 2, up ? y + 2 : mid + 1, CW - 4, CH / 2 - 3); }   // shadowed flap in mid-air
      ctx.restore();
      if (p >= 1) { k.anim = false; k.shown = k.to; }
    }
    // colon: two square dots; AM/PM flag + date under the cards
    const cx = x0 + 76;
    ctx.fillStyle = INK; ctx.fillRect(cx, y0 + 15, 6, 6); ctx.fillRect(cx, y0 + 31, 6, 6);
    const dateS = `${c.dow} ${c.mon} ${c.day}`;
    text(ctx, dateS, x0 + 2 + (c.digits[0] === '' ? CARD_X[1] : 0), y0 + CH + 11, INK, FONT_S);   // under the first visible card
    ctx.font = FONT_S; const aw = Math.ceil(ctx.measureText(c.ampm).width) + 8;
    ctx.fillStyle = INK; ctx.fillRect(x0 + 157 - aw, y0 + CH + 5, aw, 12);
    text(ctx, c.ampm, x0 + 157 - aw + 4, y0 + CH + 11.5, PAPER, FONT_S);
    return anim;
  }

  // ------------------------------------------------------------------ MORPH (dither melt between glyphs) + shared digit morpher
  const MORPH_MS = 1700;
  let morphSlots = [];
  const offs = {};
  function digitBitmap(from, to, sc, p, invFrom, invTo, key) {   // dissolve `from` into `to`: Bayer threshold + a downward melt (0 = lit ink, 255 = paper)
    const w = GW * sc, h = GH * sc;
    let o = offs[key];
    if (!o) { const cv = document.createElement('canvas'); cv.width = w; cv.height = h; o = offs[key] = { cv, g: cv.getContext('2d'), img: null }; o.img = o.g.createImageData(w, h); }
    const gf = GL[from] || GL[''], gt = GL[to] || GL[''], d = o.img.data;
    for (let y = 0, i = 0; y < h; y++) {
      const ry = (y / sc) | 0;
      for (let x = 0; x < w; x++, i += 4) {
        const th = BAYER[y & 7][x & 7] / 64 * 0.62 + (y / h) * 0.38;      // 0..<1
        const nw = th < p, on = (nw ? gt : gf)[ry][(x / sc) | 0], inv = nw ? invTo : invFrom;
        d[i] = d[i + 1] = d[i + 2] = (on !== inv) ? 0 : 255; d[i + 3] = 255;
      }
    }
    o.g.putImageData(o.img, 0, 0);
    return o.cv;
  }
  function drawMorph(ctx, t, x0, y0, c, inv) {
    const SC = 4, DW = GW * SC, DH = GH * SC;             // 28 x 44
    const ww = 176, wh = 70;
    // classic Mac window: 1 px frame + 2 px shadow, striped title bar with a close box and the date
    ctx.fillStyle = INK; ctx.fillRect(x0 + 2, y0 + 2, ww, wh);
    ctx.fillStyle = PAPER; ctx.fillRect(x0, y0, ww, wh);
    box(ctx, x0, y0, ww, wh, 1, INK);
    for (let yy = 2; yy < 12; yy += 2) ctx.fillRect(x0 + 1, y0 + yy, ww - 2, 1);
    ctx.fillStyle = INK; ctx.fillRect(x0, y0 + 13, ww, 1);
    ctx.fillStyle = PAPER; ctx.fillRect(x0 + 6, y0 + 2, 9, 9); box(ctx, x0 + 6, y0 + 2, 9, 9, 1, INK);
    const title = `${c.dow} ${c.mon} ${c.day}`;
    ctx.font = FONT_S; const tw = Math.ceil(ctx.measureText(title).width) + 10, tx = Math.round(x0 + (ww - tw) / 2);
    ctx.fillStyle = PAPER; ctx.fillRect(tx, y0 + 1, tw, 12); text(ctx, title, tx + 5, y0 + 7.5, INK, FONT_S);
    // content
    const cy = y0 + 14, ch = wh - 15;
    ctx.fillStyle = inv ? INK : PAPER; ctx.fillRect(x0 + 1, cy, ww - 2, ch);
    // a blank hour-tens slot (1-9 o'clock) centres the other three like the screensaver does; only once slot 0 has settled
    // blank, so the 1:00 melt plays in place and the window never jumps mid-melt
    const s0 = morphSlots[0], blank0 = c.digits[0] === '' && (!s0 || (s0.shown === '' && (!s0.anim || !s0.to)));
    const dy0 = cy + ((ch - DH) >> 1), pairW = DW * 2 + 3, sx = x0 + 10 - (blank0 ? (DW + 3) >> 1 : 0);
    const DX = [sx, sx + DW + 3, sx + pairW + 14, sx + pairW + 14 + DW + 3];
    let anim = false;
    for (let i = 0; i < 4; i++) {
      let s = morphSlots[i];
      if (!s) s = morphSlots[i] = { shown: c.digits[i], inv, from: null, to: null, t0: 0, anim: false };
      if (!s.anim && (s.shown !== c.digits[i] || s.inv !== inv)) { s.anim = true; s.from = s.shown; s.to = c.digits[i]; s.t0 = t; s.invFrom = s.inv; s.invTo = inv; }
      if (s.anim) {
        anim = true;
        const p = clamp((t - s.t0) / MORPH_MS, 0, 1);
        if (s.from || s.to) ctx.drawImage(digitBitmap(s.from, s.to, SC, p, s.invFrom, s.invTo, 'm' + i), DX[i], dy0);   // blank slot = content bg
        if (p >= 1) { s.anim = false; s.shown = s.to; s.inv = s.invTo; }
      } else if (s.shown) ctx.drawImage(digitBitmap(s.shown, s.shown, SC, 1, s.inv, s.inv, 'm' + i), DX[i], dy0);
    }
    const colX = sx + pairW + 3, fg = inv ? PAPER : INK;
    ctx.fillStyle = fg; ctx.fillRect(colX + 4, dy0 + 12, 4, 4); ctx.fillRect(colX + 4, dy0 + 28, 4, 4);
    ctx.save(); ctx.font = FONT_S;
    text(ctx, c.ampm, x0 + ww - 23, dy0 + DH - 4, fg, FONT_S);
    ctx.restore();
    return anim;
  }

  // ------------------------------------------------------------------ CUCKOO
  const CREW = ['alfred', 'scout', 'maker'];
  let ann = null, nextGlance = 0, glanceUntil = 0, announcedHour = null, pendingHour = null, pendingSince = 0, testFired = false;
  const POP_MS = 760, ANN_TAIL_MS = 3800;
  const CUCKOO_QUIET = (h24) => h24 >= 22 || h24 < 7;
  function announce(agent, hour12) {
    const c = readClock(), n = clamp(hour12 || c.h12, 1, 12);
    ann = { t0: performance.now(), agent: agent || CREW[c.h24 % 3], n, label: `${n} O'CLOCK` };
    busyUntil = performance.now() + 400;
    pendingHour = null;
  }
  function birdSprite(ctx, agent, x, y) {                // 12 x 10 head + beak, popping out of the roof door; eyes follow each agent's own shape
    ctx.fillStyle = PAPER; ctx.fillRect(x - 2, y - 2, 18, 14);      // knockout so it reads on the lit roof
    ctx.fillStyle = INK; ctx.fillRect(x, y, 12, 10); ctx.fillRect(x + 12, y + 4, 3, 3); ctx.fillRect(x + 3, y - 2, 6, 2);   // head, beak, tuft
    ctx.fillStyle = PAPER;
    if (agent === 'alfred') { ctx.fillRect(x + 2, y + 2, 2, 5); ctx.fillRect(x + 7, y + 2, 2, 5); }
    else if (agent === 'scout') { ctx.fillRect(x + 1, y + 3, 4, 2); ctx.fillRect(x + 7, y + 3, 4, 2); ctx.fillRect(x + 3, y + 3, 1, 2); ctx.fillStyle = INK; ctx.fillRect(x + 3, y + 3, 1, 2); }
    else { box(ctx, x + 1, y + 2, 4, 4, 1, PAPER); box(ctx, x + 7, y + 2, 4, 4, 1, PAPER); ctx.fillRect(x + 2, y + 3, 2, 2); ctx.fillRect(x + 8, y + 3, 2, 2); }
    ctx.fillRect(x + 3, y + 8, 6, 1);                                 // little mouth
  }
  function bubble(ctx, x, y, lines) {
    ctx.font = FONT;
    const w = Math.max(...lines.map(s => ctx.measureText(s).width)) + 10, h = lines.length * 11 + 5;
    ctx.fillStyle = INK; ctx.fillRect(x + 2, y + 2, w, h);
    ctx.fillStyle = PAPER; ctx.fillRect(x, y, w, h); box(ctx, x, y, w, h, 1, INK);
    ctx.fillStyle = PAPER; ctx.fillRect(x - 3, y + 6, 4, 5); ctx.fillStyle = INK; ctx.fillRect(x - 3, y + 7, 4, 1); ctx.fillRect(x - 3, y + 8, 2, 1);   // pointer toward the bird
    lines.forEach((s, i) => text(ctx, s, x + 5, y + 8 + i * 11, INK));
  }
  const rowsDisc = (ctx, cx, cy, r) => { for (let yy = -r; yy <= r; yy++) { const hw = Math.round(Math.sqrt(r * r - yy * yy)); ctx.fillRect(cx - hw, cy + yy, hw * 2 + 1, 1); } };
  function drawCuckoo(ctx, t, x0, y0, c, inv) {
    let shake = 0, door = false, birdRise = 0, say = null;
    if (ann) {
      const el = t - ann.t0, popsEnd = 500 + ann.n * POP_MS;
      if (el > popsEnd + ANN_TAIL_MS) ann = null;
      else if (el >= 500 && el < popsEnd) {
        const u = ((el - 500) % POP_MS) / POP_MS;
        door = u > 0.04 && u < 0.92;
        birdRise = u < 0.04 ? 0 : u < 0.30 ? (u - 0.04) / 0.26 : u < 0.62 ? 1 : u < 0.9 ? 1 - (u - 0.62) / 0.28 : 0;
        birdRise = Math.round(birdRise * 5) / 5;
        if (u > 0.3 && u < 0.62) { say = ['CUCKOO!']; shake = (Math.floor(el / 90) & 1) ? 1 : 0; }
      } else if (el >= popsEnd) { door = true; birdRise = 1; say = [`${ann.agent.toUpperCase()} SAYS`, `${ann.label}!`]; }
      else { door = el > 300; birdRise = el > 300 ? 0.2 : 0; }
    }
    const bx = x0 + shake;
    // roof (stepped, lit) + door
    ctx.fillStyle = INK;
    for (let r = 0; r < 18; r++) { const hw = 4 + r * 3; ctx.fillRect(bx + 54 - hw, y0 + 2 + r, hw * 2, 1); }
    const dx = bx + 47, dy = y0 + 8;
    if (door) { ctx.fillStyle = PAPER; ctx.fillRect(dx, dy, 14, 10); }
    else { box(ctx, dx, dy, 14, 10, 1, PAPER); ctx.fillStyle = PAPER; ctx.fillRect(dx + 7, dy + 1, 1, 8); }
    if (birdRise > 0 && ann) {                          // the crew head rises out of the roof door (clipped at the door sill), with a neck
      const hy = Math.round(dy + 1 - 15 * birdRise);
      ctx.save(); ctx.beginPath(); ctx.rect(0, 0, W, dy + 10); ctx.clip();
      birdSprite(ctx, ann.agent, bx + 48, hy);
      ctx.fillStyle = INK; ctx.fillRect(bx + 51, hy + 10, 6, dy + 10 - hy - 10);
      ctx.restore();
    }
    // body with the digit window
    const by = y0 + 20, bw = 108, bh = 46, ink = inv ? PAPER : INK;
    ctx.fillStyle = inv ? INK : PAPER; ctx.fillRect(bx, by, bw, bh);
    box(ctx, bx, by, bw, bh, 2, INK);
    ctx.fillStyle = INK; ctx.fillRect(bx + 2, by + bh, bw, 2);                    // shelf shadow
    const SC = 3, dW = GW * SC, gx = bx + 6, gy = by + 6;
    const xs = [gx, gx + dW + 2, gx + dW * 2 + 2 + 10, gx + dW * 3 + 2 + 12];
    c.digits.forEach((d, i) => { if (d) glyph(ctx, d, xs[i], gy, SC, ink); });
    ctx.fillStyle = ink; ctx.fillRect(gx + dW * 2 + 5, gy + 9, 4, 4); ctx.fillRect(gx + dW * 2 + 5, gy + 21, 4, 4);   // colon
    // pendulum (a step per 250 ms) + two pine-cone weights that sink a pixel per minute
    const L = 16, swing = Math.round(Math.sin(t / 1000 * Math.PI) * 2) * 4, px = bx + 54, py = by + bh + 2;
    ctx.fillStyle = INK;
    for (let yy = 0; yy < L; yy++) ctx.fillRect(px + Math.round(swing * yy / L), py + yy, 1, 1);
    rowsDisc(ctx, px + swing, py + L + 3, 4);
    for (const wx of [bx + 18, bx + 90]) {
      const sink = c.m % 6;
      for (let yy = 0; yy < 8 + sink; yy += 2) ctx.fillRect(wx, by + bh + 2 + yy, 1, 1);
      const cy = by + bh + 2 + 8 + sink; [3, 5, 7, 7, 5, 3].forEach((w, i) => ctx.fillRect(wx - (w >> 1), cy + i, w, 1));
    }
    if (say) bubble(ctx, bx + 118, y0 + (say.length > 1 ? 2 : 10), say);
    return !!ann;
  }
  function maybeAnnounce(c, env) {
    if (variant !== 'cuckoo') return;
    const test = params.has('clockcuckoo');
    if (test && !testFired && !ann && performance.now() > num('clockcuckoo', 3) * 1000) { testFired = true; announce(); return; }
    if (announcedHour === null) announcedHour = c.hourKey;                  // loading mid-hour must not fire
    if (c.hourKey !== announcedHour) { announcedHour = c.hourKey; if (!CUCKOO_QUIET(c.h24)) { pendingHour = c.hourKey; pendingSince = performance.now(); } }
    if (pendingHour !== null) {
      if (performance.now() - pendingSince > 60000) pendingHour = null;     // something was in the way for a full minute: skip it
      else if (env.ok && !ann) announce();
    }
  }
  function gaze(t) {                                    // main face looks up-left at the clock; face.js applies it when the face is awake
    if (variant !== 'cuckoo' || !drawn || drawn.kind !== 'cuckoo') return null;
    if (ann) { const el = t - ann.t0; return el > 100 && el < 500 + ann.n * POP_MS + ANN_TAIL_MS - 600 ? { x: -8, y: -14 } : null; }
    if (!nextGlance) nextGlance = t + (params.has('clockglance') ? 1500 : 30000 + Math.random() * 50000);
    if (t > nextGlance) { glanceUntil = t + 1700; nextGlance = t + 40000 + Math.random() * 70000; }
    return t < glanceUntil ? { x: -8, y: -14 } : null;
  }

  // ------------------------------------------------------------------ SCREENSAVER
  const STARS = (() => { let s = 20261116; const r = () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296; return Array.from({ length: 34 }, () => ({ x: 4 + (r() * (W - 8)) | 0, y: 4 + (r() * (H - 8)) | 0, per: 5 + r() * 9, ph: r() * 20, big: r() < 0.3 })); })();
  const tri = (p, R) => { const m = ((p % (2 * R)) + 2 * R) % (2 * R); return R - Math.abs(m - R); };
  let ssSlots = [], ssBuf = null, dissolve = null;
  const SS_SC = 8, SS_DW = GW * SS_SC, SS_DH = GH * SS_SC;
  function sleepFace(ctx, agent, x, y, t) {            // tiny sleeping crew face with step-drifting z's
    ctx.fillStyle = INK;
    if (agent === 'alfred') { ctx.fillRect(x, y + 4, 7, 2); ctx.fillRect(x + 11, y + 4, 7, 2); }
    else if (agent === 'scout') { ctx.fillRect(x - 2, y + 4, 10, 2); ctx.fillRect(x + 11, y + 4, 10, 2); }
    else { ctx.fillRect(x, y + 4, 7, 2); ctx.fillRect(x + 11, y + 4, 7, 2); ctx.fillRect(x, y + 2, 1, 2); ctx.fillRect(x + 17, y + 2, 1, 2); }
    ctx.fillRect(x + 5, y + 12, 8, 1);
    const k = Math.floor(t / 1800) % 3;                // three z's, one more every 1.8 s, drifting right and up
    for (let i = 0; i <= k; i++) text(ctx, i === 2 ? 'Z' : 'z', x + 24 + i * 9, y + 2 - i * 3, INK, 'bold ' + (8 + i * 2) + 'px Menlo, monospace');
  }
  function saverPos(ms) {                              // bounces off the canvas edges, one pixel per 600 ms step (never faster)
    const n = Math.floor(ms / 600), bw = SS_DW * 4 + 12 + 14 + 16, bh = SS_DH + 26;
    return { px: tri(n, Math.floor((W - bw - 16) / 2)) + 8, py: tri(Math.floor(n * 0.73), Math.floor((H - bh - 16) / 2)) + 8, bw, bh };
  }
  function drawSaverScene(ctx, t, c, agent, demo) {
    ctx.fillStyle = PAPER; ctx.fillRect(0, 0, W, H);
    const ms = c.ms, { px, py, bw, bh } = saverPos(ms);
    for (const s of STARS) {                           // twinkle: visible 70% of its own 5-14 s cycle, so a star changes every few seconds
      if (s.x > px - 8 && s.x < px + bw + 8 && s.y > py - 16 && s.y < py + bh + 8) continue;
      const u = ((ms / 1000 + s.ph) % s.per) / s.per;
      if (u > 0.7) continue;
      ctx.fillStyle = INK; ctx.fillRect(s.x, s.y, 1, 1);
      if (s.big) { ctx.fillRect(s.x - 1, s.y, 1, 1); ctx.fillRect(s.x + 1, s.y, 1, 1); ctx.fillRect(s.x, s.y - 1, 1, 1); ctx.fillRect(s.x, s.y + 1, 1, 1); }
    }
    // digits: each dissolves into the next through the dither (shared morpher)
    const sx = px + (c.digits[0] === '' ? (SS_DW + 6) >> 1 : 0), sy = py + 8;   // a blank hour-tens slot (1-9 o'clock): centre the other three
    const DX = [sx, sx + SS_DW + 6, sx + SS_DW * 2 + 6 + 28, sx + SS_DW * 3 + 12 + 28];
    for (let i = 0; i < 4; i++) {
      let s = ssSlots[i];
      if (!s) s = ssSlots[i] = { shown: c.digits[i], from: null, to: null, t0: 0, anim: false };
      if (!s.anim && s.shown !== c.digits[i]) { s.anim = true; s.from = s.shown; s.to = c.digits[i]; s.t0 = t; }
      if (s.anim) {
        const p = clamp((t - s.t0) / 2200, 0, 1);
        ctx.drawImage(digitBitmap(s.from, s.to, SS_SC, p, false, false, 's' + i), DX[i], sy);
        if (p >= 1) { s.anim = false; s.shown = s.to; }
      } else ctx.drawImage(digitBitmap(s.shown, s.shown, SS_SC, 1, false, false, 's' + i), DX[i], sy);
    }
    // colon blinks at 1 Hz (1 s on, 1 s off)
    if (Math.floor(ms / 1000) % 2 === 0) { const cx = sx + SS_DW * 2 + 6 + 10; ctx.fillStyle = INK; ctx.fillRect(cx, sy + 24, 9, 9); ctx.fillRect(cx, sy + 55, 9, 9); }
    text(ctx, `${c.dow} ${c.mon} ${c.day}  ${c.ampm}`, px + 2, sy + SS_DH + 14, INK, 'bold 11px Menlo, monospace');
    sleepFace(ctx, agent || 'alfred', px + bw - 70, sy + SS_DH + 8, t);
    if (demo) text(ctx, 'SCREENSAVER DEMO - ANY KEY TO EXIT   C = NEXT CLOCK', 8, H - 8, INK, 'bold 9px Menlo, monospace');
    return { px, py, bw, bh };
  }

  // ------------------------------------------------------------------ tag + toast (tiny click target, top strip)
  function drawTag(ctx, env) {
    tagRect = null;
    if (!env.tag) return;
    ctx.font = FONT;
    const s = 'CLK', w = Math.ceil(ctx.measureText(s).width) + 8, h = 11;
    const x = env.menubar ? 300 : 440, y = env.menubar ? 1 : 4;        // left of the AOL tag; inside the menu bar when it is on
    const on = variant !== 'off';
    ctx.fillStyle = on ? INK : PAPER; ctx.fillRect(x, y, w, h);
    box(ctx, x, y, w, h, 1, INK);
    text(ctx, s, x + 4, y + h / 2 + 1, on ? PAPER : INK);
    tagRect = { x: x - 3, y: 0, w: w + 6, h: h + 8 };
    if (toast && performance.now() < toastUntil) {
      const m = toast; ctx.font = FONT; const tw = Math.ceil(ctx.measureText(m).width) + 10, tx = x - tw - 4;
      ctx.fillStyle = INK; ctx.fillRect(tx, y, tw, h); text(ctx, m, tx + 5, y + h / 2 + 1, PAPER);
      busyUntil = Math.max(busyUntil, performance.now() + 1100);
    } else toast = null;
  }

  // ------------------------------------------------------------------ main draw (called by face.js once per frame, before the banner + 1-bit pass)
  // env: { ok: plain dashboard (no speech / window / zoom / card / banner), tag: also draw the tag, busy: anything happening, agent, menubar }
  function wantSaver(env, c, t) {
    if (variant !== 'screensaver') return false;
    if (demoUntil && t < demoUntil) return true;
    if (env.busy) return false;
    const B = window.RetroBurn && RetroBurn.state ? RetroBurn.state() : null;
    return (B && B.mode === 'rest') || t - lastActive >= SS_IDLE;
  }
  function draw(ctx, t, env) {
    lastEnv = env; lastDrawAt = t; hiddenAt = -1e9;
    if (env.busy) active();
    if (ann && t - ann.t0 > 500 + ann.n * POP_MS + ANN_TAIL_MS) ann = null;
    const c = readClock();
    drawn = null;
    let animating = false, saver = false;
    if (variant === 'screensaver') {
      saver = wantSaver(env, c, t) && !env.skin;
      if (saver && !ssOn) { ssOn = true; ssEnter = t; }
      if (!saver) { if (ssOn) { ssOn = false; ssSlots = []; } }
    }
    if (saver) {
      if (!ssBuf) { ssBuf = document.createElement('canvas'); ssBuf.width = W; ssBuf.height = H; ssBuf.getContext('2d').imageSmoothingEnabled = false; }
      const g = ssBuf.getContext('2d');
      const rect = drawSaverScene(g, t, c, env.agent, demoUntil && t < demoUntil);
      const p = clamp((t - ssEnter) / 1400, 0, 1);
      if (p >= 1) ctx.drawImage(ssBuf, 0, 0);
      else {                                           // dither dissolve from the dashboard into the saver
        const base = ctx.getImageData(0, 0, W, H), sc = g.getImageData(0, 0, W, H), b = base.data, s = sc.data;
        for (let y = 0, i = 0; y < H; y++) for (let x = 0; x < W; x++, i += 4) {
          if (BAYER[y & 7][x & 7] / 64 * 0.7 + ((x * 7 + y * 3) % 17) / 17 * 0.3 < p * 1.02) { b[i] = s[i]; b[i + 1] = s[i + 1]; b[i + 2] = s[i + 2]; }
        }
        ctx.putImageData(base, 0, 0);
        animating = true;
      }
      drawn = { kind: 'screensaver', rect, dissolve: p < 1 };
      if (ssSlots.some(s => s.anim)) animating = true;
      if (animating) busyUntil = t + 120;
      drawn.anim = animating;
      return true;
    }
    if (variant !== 'off' && variant !== 'screensaver' && env.ok && !env.skin) {
      const ms = c.ms, inv = invAt(ms);
      const pl = place(variant, ms), x0 = pl.x, y0 = pl.y;
      if (variant === 'flip') animating = drawFlip(ctx, t, x0, y0, c, inv);
      else if (variant === 'cuckoo') { maybeAnnounce(c, env); animating = drawCuckoo(ctx, t, x0, y0, c, inv); }
      else if (variant === 'morph') animating = drawMorph(ctx, t, x0, y0, c, inv);
      drawn = { kind: variant, ...pl, inv, ann: variant === 'cuckoo' ? !!ann : undefined };
      if (animating) busyUntil = t + 120;
      if (drawn) drawn.anim = animating;
    }
    drawTag(ctx, env);
    return false;
  }

  window.RetroClock = {
    draw, busy: (t) => t < busyUntil, gaze, hide: () => { hiddenAt = performance.now(); tagRect = null; },
    click: (x, y) => { const r = tagRect; if (!r || x < r.x || x >= r.x + r.w || y < r.y || y >= r.y + r.h) return false; cycle(); return true; },
    setting, set, cycle, announce, variant: () => variant, VARIANTS, place, invAt,
    state: () => ({ variant, drawn, saver: ssOn, glance: performance.now() < glanceUntil || !!ann, demo: !!(demoUntil && performance.now() < demoUntil), ann: ann ? { agent: ann.agent, n: ann.n } : null,
      quietS: Math.round((performance.now() - lastActive) / 1000), tag: tagRect, toast, offsetMs: OFFSET, clock: clk && { h: clk.h24, m: clk.m, s: clk.s, digits: clk.digits } }),
  };
})();

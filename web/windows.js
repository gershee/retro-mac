// Retro Mac v1.1: click-in detail windows over the (unchanged) v1 dashboard.
// Classic-Mac window (striped title bar, close box, dither shadow, ~150 ms zoom-open) drawn black-on-white in v1's
// Menlo; face.js thresholds the frame to 1-bit and maps it to the active theme + tone, so windows are always native.
//   open:  click the WEATHER / TODAY / CREW panel, or keys 1 TODAY  2 CREW  3 WEATHER  4 HOUSE  5 ALERTS
//          (same key again closes, <- -> cycle while open)
//   close: Esc, the close box, a click outside the window, or 60 s without input
// Voice always wins: speech (face goes full screen) closes the window; the voice banner draws on top and the window
// dims underneath while HEARD / LISTENING / WORKING (its idle timer is paused meanwhile).
// Data: dash (ws: weather, agenda, day), crew (ws: status, since, last, hist) and GET /house (read-only, 60 s cache).
(function () {
  const W = 512, H = 342;
  const MONO = 'Menlo, "Courier New", monospace';
  const font = (px, bold) => `${bold ? 'bold ' : ''}${px}px ${MONO}`;
  const WIN = { x: 10, y: 6, w: 486, h: 316, titleH: 20 };
  const OPEN_MS = 150, CLOSE_MS = 120, IDLE_MS = 60e3;
  const ORDER = ['today', 'crew', 'weather', 'house', 'alerts'];
  const TAB = { today: 'TODAY', crew: 'CREW', weather: 'WEATHER', house: 'HOUSE', alerts: 'ALERTS' };
  const DIM_STATES = new Set(['heard', 'listening', 'transcribing', 'working', 'error', 'failed']);
  const Z = { key: null, from: null, at: 0, closing: false, touched: 0, closeKey: null };
  let house = null, houseTry = 0;
  const debug = { opens: 0, closes: 0, lastClose: '' };

  // ------------------------------------------------------------------ helpers
  let PAT = null;
  function pats(ctx) {                           // 1-bit fill patterns (black on transparent), built once
    if (PAT) return PAT;
    const mk = (cells) => { const c = document.createElement('canvas'); c.width = c.height = 2; const g = c.getContext('2d');
      g.fillStyle = '#000'; cells.forEach(([x, y]) => g.fillRect(x, y, 1, 1)); return ctx.createPattern(c, 'repeat'); };
    PAT = { checker: mk([[0, 0], [1, 1]]), light: mk([[0, 0]]) };
    return PAT;
  }
  const blk = (ctx) => { ctx.fillStyle = '#000'; };
  const wht = (ctx) => { ctx.fillStyle = '#fff'; };
  function fit(ctx, text, maxW) {
    text = String(text == null ? '' : text);
    if (ctx.measureText(text).width <= maxW) return text;
    while (text.length > 1 && ctx.measureText(text + '..').width > maxW) text = text.slice(0, -1);
    return text + '..';
  }
  function wrap(ctx, text, maxW, max) {
    const words = String(text || '').split(/\s+/).filter(Boolean), lines = []; let cur = '';
    for (const w of words) {
      const t = cur ? cur + ' ' + w : w;
      if (ctx.measureText(t).width > maxW && cur) { lines.push(cur); cur = w; } else cur = t;
    }
    if (cur) lines.push(cur);
    if (max && lines.length > max) { const rest = lines.slice(max - 1).join(' '); lines.length = max - 1; lines.push(fit(ctx, rest, maxW)); }
    return lines.map(l => fit(ctx, l, maxW));
  }
  function text(ctx, s, x, y, px, bold, align) {
    ctx.font = font(px, bold); ctx.textBaseline = 'top';
    const w = ctx.measureText(s).width;
    ctx.fillText(s, align === 'r' ? x - w : align === 'c' ? x - w / 2 : x, y);
    return w;
  }
  function box(ctx, x, y, w, h, th) { th = th || 2; ctx.fillRect(x, y, w, th); ctx.fillRect(x, y + h - th, w, th); ctx.fillRect(x, y, th, h); ctx.fillRect(x + w - th, y, th, h); }
  function dots(ctx, x, y, w) { for (let xx = x; xx < x + w; xx += 4) ctx.fillRect(xx, y, 2, 1); }
  function dashRect(ctx, r) {                    // zoom outline: 2 px dashes
    const { x, y, w, h } = r;
    for (let xx = x; xx < x + w; xx += 6) { ctx.fillRect(xx, y, 3, 2); ctx.fillRect(xx, y + h - 2, 3, 2); }
    for (let yy = y; yy < y + h; yy += 6) { ctx.fillRect(x, yy, 2, 3); ctx.fillRect(x + w - 2, yy, 2, 3); }
  }
  function check(ctx, x, y) {                    // 1-bit check mark, ~9x7
    for (let k = 0; k < 3; k++) ctx.fillRect(x + k * 2, y + 3 + k * 2, 2, 2);
    for (let k = 0; k < 4; k++) ctx.fillRect(x + 4 + k * 2, y + 5 - k * 2, 2, 2);
  }
  const RT = window.RetroTime;     // panels.js: wall clock in the server's time zone
  const clock = (ms) => RT.clock(ms);
  const hr = (ms) => RT.hr(ms);
  function dur(sec) {
    sec = Math.max(0, Math.round(sec));
    if (sec < 60) return `${sec}S`;
    const m = Math.floor(sec / 60); if (m < 60) return `${m}M`;
    const h = Math.floor(m / 60); if (h < 48) return `${h}H ${m % 60}M`;
    return `${Math.floor(h / 24)}D`;
  }
  const hmm = (sec) => { sec = Math.max(0, Math.floor(sec)); const m = Math.floor(sec / 60); return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`; };
  const inTime = (ms) => { const m = Math.max(1, Math.ceil(ms / 60e3)); return m < 60 ? `IN ${m} MIN` : `IN ${Math.floor(m / 60)}H ${m % 60}M`; };
  const mmss = (sec) => { sec = Math.max(0, Math.floor(sec)); return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`; };
  function icon(ctx, kind, x, y, s, t) {
    if (!window.RetroCards || !RetroCards.drawIcon) return;
    ctx.save(); ctx.translate(x, y); ctx.scale(s, s); RetroCards.drawIcon(ctx, kind || 'cloud', 0, 0, t); ctx.restore();
  }

  // ------------------------------------------------------------------ data
  function fetchHouse() {
    houseTry = Date.now();
    fetch('/house', { cache: 'no-store' }).then(r => (r.ok ? r.json() : null)).then(j => { if (j && j.ok) house = j; }).catch(() => {});
  }
  function houseTick() {                         // 60 s while HOUSE/ALERTS is open, else every 5 min (badge)
    const every = Z.key === 'house' || Z.key === 'alerts' ? 60e3 : 300e3;
    if (Date.now() - houseTry > every) fetchHouse();
  }
  const attnRows = (D) => (D.agenda || []).filter(r => r.k === 'attn');
  function alertItems(D) {
    const out = [];
    const att = house && Array.isArray(house.attention) && house.attention.length ? house.attention : attnRows(D).map(r => ({ t: r.title, since: null }));
    for (const a of att) out.push({ kind: 'you', t: String(a.t || '').toUpperCase(), d: a.since ? `ON YOUR LIST SINCE ${clock(a.since * 1000)}` : 'ON YOUR LIST' });
    for (const s of (house && house.alerts) || []) out.push({ kind: 'sys', t: String(s), d: `HOUSE CHECK ${clock(house.at * 1000)}` });
    return out;
  }
  function houseDown() { return house ? (house.services || []).filter(s => !s.up).length : 0; }

  // ------------------------------------------------------------------ chrome
  function chrome(ctx, r, title, t) {
    const { x, y, w, h, titleH: th } = r, P = pats(ctx);
    ctx.fillStyle = P.checker; ctx.fillRect(x + 5, y + h, w, 5); ctx.fillRect(x + w, y + 5, 5, h);   // dither shadow
    wht(ctx); ctx.fillRect(x, y, w, h);
    blk(ctx); box(ctx, x, y, w, h, 2);
    for (let yy = y + 4; yy < y + th - 1; yy += 3) ctx.fillRect(x + 4, yy, w - 8, 1);                 // title stripes
    ctx.fillRect(x, y + th, w, 2);
    ctx.font = font(13, true);
    const tt = fit(ctx, title, w - 90), tw = ctx.measureText(tt).width;
    wht(ctx); ctx.fillRect(x + (w - tw) / 2 - 8, y + 3, tw + 16, th - 5);
    blk(ctx); ctx.textBaseline = 'middle'; ctx.fillText(tt, x + (w - tw) / 2, y + th / 2 + 1);
    // close box (left, classic Mac): white plate, 2 px square
    wht(ctx); ctx.fillRect(x + 7, y + 3, 21, th - 5);
    blk(ctx); box(ctx, x + 10, y + 4, 14, 13, 2);
    return { x: x + 12, y: y + th + 9, w: w - 24, h: h - th - 9 - 26 };
  }
  const CLOSE_HIT = () => ({ x: WIN.x + 2, y: WIN.y, w: 32, h: WIN.titleH + 2 });
  function footer(ctx, key, D) {
    const y = WIN.y + WIN.h - 19, x0 = WIN.x + 12, x1 = WIN.x + WIN.w - 12;
    blk(ctx); dots(ctx, x0, y - 4, x1 - x0);
    const hint = D.ptt ? 'SPACE = ASK ME ABOUT THIS' : 'SAY "ALFRED" = ASK ME ABOUT THIS';
    ctx.font = font(10, true);
    let x = x1;
    for (let i = ORDER.length - 1; i >= 0; i--) {   // tab strip, right aligned: current one inverted
      const k = ORDER[i], s = `${i + 1} ${TAB[k]}`, w = ctx.measureText(s).width;
      x -= w + 8;
      if (k === key) { blk(ctx); ctx.fillRect(x - 3, y - 1, w + 6, 13); wht(ctx); } else blk(ctx);
      ctx.textBaseline = 'top'; ctx.fillText(s, x, y + 1);
      x -= 2;
    }
    blk(ctx); ctx.font = font(10, true);
    const room = x - x0 - 10;
    const hw = ctx.measureText(hint).width;
    if (hw <= room) {                                    // keycap plate around SPACE / the hint
      box(ctx, x0, y - 1, hw + 10, 13, 1); ctx.fillText(hint, x0 + 5, y + 1);
    } else ctx.fillText(fit(ctx, hint, room), x0, y + 1);
  }

  // ------------------------------------------------------------------ TODAY
  function eventsOf(D) {
    const day = D.day || {};
    return (day.events || []).map(e => ({ title: String(e.title || '').toUpperCase(), k: e.k, s: Date.parse(e.s), e: Date.parse(e.e) }))
      .filter(e => !isNaN(e.s));
  }
  function wxAt(D, ms) {
    const hs = (D.weather && D.weather.hours) || [];
    for (const h of hs) { const t0 = Date.parse(h.h); if (ms >= t0 && ms < t0 + 3600e3) return h; }
    return null;
  }
  const SCHOOL = /school|drop[- ]?off|pick[- ]?up|pickup|carpool|class|camp/i;
  function gear(h) {
    if (!h) return '';
    if (h.pop >= 40) return h.snow ? 'BOOTS + COAT' : 'UMBRELLA';
    if (h.temp <= 40) return 'WARM COAT + HAT';
    if (h.temp < 55) return 'JACKET';
    if (h.temp >= 85) return 'WATER';
    return '';
  }
  function wxShort(h) { return h ? `${h.temp}\u00b0 ${h.pop >= 30 ? h.pop + '% ' + (h.snow ? 'SNOW' : 'RAIN') : 'DRY'}` : ''; }
  function prepLines(D, evs, now) {
    const out = [];
    const runs = evs.filter(e => e.s > now - 10 * 60e3 && SCHOOL.test(e.title)).slice(0, 2);
    for (const e of runs) {
      const h = wxAt(D, e.s); if (!h) continue;
      const g = gear(h);
      out.push({ t: `${clock(e.s)} ${e.title}`, b: true }, { t: `${wxShort(h)}${g ? ' \u2192 ' + g : ''}`, hot: h.pop >= 40 });
    }
    if (!runs.length) {
      const nx = evs.find(e => e.s > now && e.k === 'event'), h = nx && wxAt(D, nx.s);
      if (h) out.push({ t: `AT ${clock(nx.s)}: ${wxShort(h)}`, b: true }, ...(gear(h) ? [{ t: '\u2192 ' + gear(h), hot: h.pop >= 40 }] : []));
      else out.push({ t: 'NO SCHOOL RUN LEFT TODAY', b: true });
    }
    for (const ln of ((D.weather && D.weather.lines) || [])) out.push({ t: ln.t, hot: !!ln.hot });
    return out;
  }
  function drawToday(ctx, c, D, t) {
    const now = Date.now(), evs = eventsOf(D), day = D.day || {};
    const live = evs.filter(e => e.k === 'event' && e.s <= now && e.e > now);
    const next = evs.find(e => e.s > now);
    let y = c.y;
    // NEXT bar
    blk(ctx); ctx.fillRect(c.x, y, c.w, 32); wht(ctx);
    let top = next ? `NEXT \u25b6 ${clock(next.s)}` : 'NEXT \u25b6';
    if (live.length) top += `   NOW: ${live[0].title} (TILL ${clock(live[0].e)})`;
    ctx.font = font(10, true); ctx.textBaseline = 'top'; ctx.fillText(fit(ctx, top, c.w - 130), c.x + 8, y + 4);
    ctx.font = font(14, true); ctx.fillText(fit(ctx, next ? next.title : evs.length ? 'NOTHING ELSE TODAY' : 'NOTHING ON THE CALENDAR', c.w - 130), c.x + 8, y + 16);
    if (next) {
      const s = hmm((next.s - now) / 1000);
      const w = text(ctx, s, c.x + c.w - 8, y + 5, 22, true, 'r');
      text(ctx, 'IN', c.x + c.w - 14 - w, y + 16, 11, true, 'r');
    } else text(ctx, clock(now), c.x + c.w - 8, y + 5, 22, true, 'r');
    y += 38;
    // timeline
    const d0 = RT.dayStart(now);
    let h0 = 7, h1 = 22;
    for (const e of evs) { h0 = Math.min(h0, RT.parts(e.s).h); h1 = Math.max(h1, Math.min(24, Math.ceil((e.e - d0) / 3600e3))); }
    const X = (ms) => c.x + 2 + Math.round(Math.max(0, Math.min(1, ((ms - d0) / 3600e3 - h0) / (h1 - h0))) * (c.w - 4));
    blk(ctx); ctx.fillRect(c.x, y + 15, c.w, 2);
    ctx.font = font(10, false); ctx.textBaseline = 'top';
    for (let hh = h0; hh <= h1; hh++) {
      const xx = X(d0 + hh * 3600e3);
      ctx.fillRect(xx, y + 17, 1, hh % 3 === 0 ? 4 : 2);
      if (hh % 3 === 0 && hh < h1) { const s = hh === 12 ? '12P' : hh === 0 || hh === 24 ? '12A' : hh > 12 ? `${hh - 12}P` : `${hh}A`; ctx.fillText(s, xx - ctx.measureText(s).width / 2, y + 22); }
    }
    const P = pats(ctx);
    for (const e of evs) {
      const a = X(e.s);
      if (e.k === 'remind') { blk(ctx); ctx.fillRect(a - 2, y + 5, 5, 5); ctx.fillRect(a - 1, y + 3, 3, 9); continue; }
      const b = Math.max(a + 3, X(e.e));
      if (e.e <= now) { ctx.fillStyle = P.checker; ctx.fillRect(a, y + 3, b - a, 11); blk(ctx); box(ctx, a, y + 3, b - a, 11, 1); }
      else if (e === next || e.s <= now) { blk(ctx); ctx.fillRect(a, y + 3, b - a, 11); }
      else { wht(ctx); ctx.fillRect(a, y + 3, b - a, 11); blk(ctx); box(ctx, a, y + 3, b - a, 11, 1); }
    }
    const nx = X(now); blk(ctx); ctx.fillRect(nx - 1, y - 1, 2, 18);
    if (Math.floor(t / 600) % 2) { ctx.fillRect(nx - 4, y - 3, 8, 2); ctx.fillRect(nx - 3, y - 1, 6, 1); }
    y += 38;
    // list (left) + prep (right)
    const bottom = c.y + c.h - 30, LW = 288, LH = 15;
    let list = evs.slice();
    const ni = next ? list.indexOf(next) : list.length;
    const cap = Math.floor((bottom - y - 4) / LH) - ((day.allday || []).length ? 1 : 0);
    let from = Math.max(0, Math.min(ni - 2, list.length - cap));
    list = list.slice(from, from + cap);
    let ly = y;
    if ((day.allday || []).length) { blk(ctx); text(ctx, fit(ctx, 'ALL DAY: ' + day.allday.join(' \u00b7 ').toUpperCase(), LW), c.x, ly, 11, true); ly += LH; }
    if (!evs.length) { blk(ctx); text(ctx, 'NO TIMED EVENTS TODAY', c.x, ly, 12, false); }
    for (const e of list) {
      const past = e.e <= now && e.k === 'event' || (e.k === 'remind' && e.s <= now), isLive = e.s <= now && e.e > now, isNext = e === next;
      blk(ctx);
      if (isNext) { ctx.fillRect(c.x - 3, ly - 2, LW + 4, LH); wht(ctx); }
      text(ctx, clock(e.s), c.x + 46, ly, 12, true, 'r');
      ctx.font = font(12, isNext); ctx.fillText(fit(ctx, (e.k === 'remind' ? '* ' : '') + e.title, LW - 56 - 58), c.x + 54, ly);
      if (past) check(ctx, c.x + LW - 14, ly + 1);
      else if (isLive) { ctx.fillRect(c.x + LW - 34, ly - 1, 32, 13); wht(ctx); text(ctx, 'NOW', c.x + LW - 18, ly + 1, 10, true, 'c'); }
      else if (isNext) text(ctx, inTime(e.s - now), c.x + LW - 3, ly, 11, true, 'r');
      ly += LH;
    }
    // prep box
    const px = c.x + LW + 12, pw = c.x + c.w - px, ph = bottom - y - 2;
    blk(ctx); box(ctx, px, y - 2, pw, ph, 2);
    ctx.fillRect(px, y - 2, pw, 15); wht(ctx); text(ctx, 'PREP', px + 7, y + 1, 11, true);
    let py = y + 17;
    ctx.font = font(11, false);
    for (const ln of prepLines(D, evs, now)) {
      ctx.font = font(11, !!(ln.b || ln.hot));
      for (const l of wrap(ctx, ln.t, pw - 16, 2)) {
        if (py + 12 > y - 2 + ph - 3) break;
        if (ln.hot) { blk(ctx); ctx.fillRect(px + 4, py - 1, pw - 8, 13); wht(ctx); } else blk(ctx);
        ctx.fillText(l, px + 8, py); py += 13;
      }
      py += 2;
    }
    // tomorrow morning
    const ty = c.y + c.h - 22;
    blk(ctx); dots(ctx, c.x, ty - 5, c.w);
    const tw = text(ctx, 'TOMORROW AM', c.x, ty + 1, 11, true);
    const tm = (day.tmr || []).map(e => `${clock(Date.parse(e.s))} ${String(e.title).toUpperCase()}`);
    const h8 = wxAt(D, RT.dayStart(RT.dayStart(now) + 36 * 3600e3) + 8 * 3600e3);   // tomorrow 8 AM, server time
    const wtxt = h8 ? `8A ${wxShort(h8)}${gear(h8) ? ' \u2192 ' + gear(h8) : ''}` : '';
    ctx.font = font(11, true); const ww = wtxt ? ctx.measureText(wtxt).width : 0;
    if (wtxt) { ctx.fillText(wtxt, c.x + c.w - ww, ty + 1); }
    ctx.font = font(11, false);
    ctx.fillText(fit(ctx, tm.length ? tm.join(' \u00b7 ') : 'NOTHING BEFORE 1 PM', c.w - tw - ww - 24), c.x + tw + 10, ty + 1);
  }

  // ------------------------------------------------------------------ CREW
  const NAMES = { alfred: 'ALFRED', scout: 'SCOUT', maker: 'MAKER' };
  const ROLE = { alfred: 'CHIEF OF STAFF', scout: 'RESEARCH', maker: 'BUILDER' };
  function drawCrewWin(ctx, c, D, t) {
    const gap = 8, cw = Math.floor((c.w - 2 * gap) / 3), now = Date.now() / 1000;
    ['alfred', 'scout', 'maker'].forEach((a, i) => {
      const m = (D.crew && D.crew[a]) || { status: 'idle', label: '' };
      const x = c.x + i * (cw + gap), y = c.y, h = c.h, active = m.status && m.status !== 'idle';
      blk(ctx); box(ctx, x, y, cw, h, 2);
      if (window.RetroCards && RetroCards.glyph) { ctx.save(); ctx.translate(x + 9, y + 7); ctx.scale(2, 2); RetroCards.glyph(ctx, m.status || 'idle', 0, 0, t, false); ctx.restore(); }
      blk(ctx); text(ctx, NAMES[a], x + 36, y + 6, 16, true);
      text(ctx, ROLE[a], x + 36, y + 25, 10, false);
      // status bar
      const sy = y + 42, since = m.since ? now - m.since : null;
      if (active) { ctx.fillRect(x + 6, sy, cw - 12, 18); wht(ctx); } else box(ctx, x + 6, sy, cw - 12, 18, 1);
      const st = (active ? (Math.floor(t / 500) % 2 ? '\u25cf ' : '\u25cb ') : '') + String(m.status || 'idle').toUpperCase();
      text(ctx, st, x + 12, sy + 4, 12, true);
      if (since != null) text(ctx, (active ? 'FOR ' : '') + (active ? mmss(since) : dur(since)), x + cw - 12, sy + 5, 10, true, 'r');
      blk(ctx);
      let yy = sy + 26;
      text(ctx, 'NOW', x + 8, yy, 10, true); yy += 13;
      ctx.font = font(12, active);
      const task = active ? (m.label || String(m.status).toUpperCase()) : 'NOTHING RIGHT NOW';
      for (const l of wrap(ctx, task, cw - 16, 2)) { ctx.fillText(l, x + 8, yy); yy += 14; }
      yy = sy + 84; dots(ctx, x + 8, yy, cw - 16); yy += 7;
      text(ctx, 'LAST DONE', x + 8, yy, 10, true); yy += 13;
      const last = m.last;
      if (last) {
        ctx.font = font(12, true);
        for (const l of wrap(ctx, last.label, cw - 16, 2)) { ctx.fillText(l, x + 8, yy); yy += 14; }
        text(ctx, `${clock(last.at * 1000)} \u00b7 ${dur(now - last.at)} AGO`, x + 8, yy, 10, false); yy += 12;
        if (last.took) { text(ctx, `TOOK ${dur(last.took)}`, x + 8, yy, 10, false); yy += 12; }
      } else { ctx.font = font(11, false); ctx.fillText('NOTHING LOGGED YET', x + 8, yy); yy += 14; }
      const hist = (m.hist || []).slice(1, 4);
      if (hist.length && yy + 30 < y + h) {
        yy += 4; dots(ctx, x + 8, yy, cw - 16); yy += 7;
        text(ctx, 'EARLIER', x + 8, yy, 10, true); yy += 13;
        for (const e of hist) {
          if (yy + 12 > y + h - 4) break;
          const tw = text(ctx, clock(e.at * 1000), x + 8, yy, 10, true);
          ctx.font = font(10, false); ctx.fillText(fit(ctx, e.label, cw - 24 - tw), x + 14 + tw, yy); yy += 12;
        }
      }
    });
  }

  // ------------------------------------------------------------------ WEATHER
  function drawWeatherWin(ctx, c, D, t) {
    const wx = D.weather; blk(ctx);
    if (!wx) { text(ctx, 'LOADING WEATHER..', c.x, c.y + 4, 14, true); return; }
    icon(ctx, wx.icon, c.x + 6, c.y + 8, 1.15, t);
    blk(ctx); ctx.font = font(44, true); ctx.textBaseline = 'alphabetic';
    const ts = `${wx.temp}\u00b0`; ctx.fillText(ts, c.x + 64, c.y + 46);
    const tx = c.x + 64 + ctx.measureText(ts).width + 10, lw = c.x + 242 - tx;
    ctx.font = font(13, true); ctx.textBaseline = 'top'; ctx.fillText(fit(ctx, wx.cond, lw), tx, c.y + 6);
    ctx.font = font(11, false);
    ctx.fillText(fit(ctx, `FEELS ${wx.feels}\u00b0`, lw), tx, c.y + 24);
    ctx.fillText(fit(ctx, `WIND ${wx.wind}${wx.gust && wx.gust > wx.wind + 4 ? '-' + wx.gust : ''} MPH`, lw), tx, c.y + 37);
    ctx.fillText(fit(ctx, `HI ${wx.hi}\u00b0 LO ${wx.lo}\u00b0`, lw), tx, c.y + 50);
    // prep box (right)
    const px = c.x + 248, pw = c.x + c.w - px, ph = 66;
    box(ctx, px, c.y, pw, ph, 2); ctx.fillRect(px, c.y, pw, 15);
    wht(ctx); text(ctx, 'WEAR / BRING', px + 7, c.y + 3, 11, true);
    let py = c.y + 19;
    for (const ln of (wx.lines || []).slice(0, 3)) {
      ctx.font = font(11, true);
      if (ln.hot) { blk(ctx); ctx.fillRect(px + 4, py - 1, pw - 8, 13); wht(ctx); } else blk(ctx);
      ctx.fillText(fit(ctx, ln.t, pw - 16), px + 8, py); py += 15;
    }
    // next 12 hours
    let y = c.y + 76;
    const hrs = Array.isArray(wx.hourly) ? wx.hourly.slice(0, 12) : [];
    blk(ctx); ctx.fillRect(c.x, y, c.w, 15); wht(ctx);
    text(ctx, 'NEXT 12 HOURS', c.x + 7, y + 3, 11, true);
    text(ctx, 'BAR = CHANCE OF RAIN   DOTS = SNOW', c.x + c.w - 7, y + 3, 10, true, 'r');
    y += 21; blk(ctx);
    const cw = c.w / Math.max(1, hrs.length), P = pats(ctx), barH = 44;
    hrs.forEach((h, i) => {
      const cx = Math.round(c.x + i * cw + cw / 2);
      if (i) { for (let yy = y; yy < y + 112; yy += 3) ctx.fillRect(Math.round(c.x + i * cw), yy, 1, 1); }
      blk(ctx);
      if (i === 0) { ctx.fillRect(cx - 15, y - 1, 30, 13); wht(ctx); text(ctx, 'NOW', cx, y + 1, 10, true, 'c'); blk(ctx); }
      else text(ctx, h.t, cx, y + 1, 10, true, 'c');
      icon(ctx, h.icon, cx - 9, y + 16, 0.4, t);
      blk(ctx); text(ctx, `${h.temp}\u00b0`, cx, y + 36, 12, true, 'c');
      const by = y + 52, pop = Math.max(0, Math.min(100, h.pop || 0)), bh = Math.round((barH - 4) * pop / 100);
      box(ctx, cx - 7, by, 14, barH, 1);
      if (bh > 0) {
        if (h.snow || h.icon === 'snow') { ctx.fillStyle = P.checker; ctx.fillRect(cx - 5, by + barH - 2 - bh, 10, bh); }
        else { blk(ctx); ctx.fillRect(cx - 5, by + barH - 2 - bh, 10, bh); }
      }
      blk(ctx); text(ctx, `${pop}%`, cx, by + barH + 3, 10, false, 'c');
    });
    // tomorrow
    const ty = c.y + c.h - 22;
    blk(ctx); dots(ctx, c.x, ty - 5, c.w);
    const nn = wx.noon;
    let x = c.x + text(ctx, 'TOMORROW NOON', c.x, ty + 1, 11, true) + 10;
    if (nn) { icon(ctx, nn.icon, x, ty - 2, 0.36, t); x += 22; blk(ctx); ctx.font = font(11, false); ctx.textBaseline = 'top'; const s = fit(ctx, `${nn.temp}\u00b0 ${nn.cond} \u00b7 ${nn.pop}% RAIN`, 210); ctx.fillText(s, x, ty + 1); }
    const days = (wx.daily || []).filter(d => d.d !== 'TODAY').slice(0, 2).map(d => `${d.d} ${d.hi}\u00b0/${d.lo}\u00b0`);
    if (days.length) { blk(ctx); text(ctx, days.join('  '), c.x + c.w, ty + 1, 11, true, 'r'); }
  }

  // ------------------------------------------------------------------ HOUSE
  function drawHouse(ctx, c, D, t) {
    blk(ctx);
    if (!house) { text(ctx, 'CHECKING THE HOUSE..', c.x, c.y + 4, 14, true); return; }
    const LW = 232;
    text(ctx, 'SERVICES', c.x, c.y, 11, true);
    let y = c.y + 15;
    for (const s of house.services || []) {
      blk(ctx);
      if (!s.up) { ctx.fillRect(c.x - 3, y - 2, LW + 6, 15); wht(ctx); }
      if (s.up) ctx.fillRect(c.x + 1, y + 2, 8, 8); else { box(ctx, c.x + 1, y + 2, 8, 8, 2); }
      text(ctx, s.name, c.x + 15, y, 12, !s.up);
      text(ctx, (s.up ? '' : '! ') + s.note, c.x + LW, y + 1, 10, !s.up, 'r');
      y += 16;
    }
    // right column: disk, mic, audit
    const x2 = c.x + LW + 18, w2 = c.x + c.w - x2;
    let ry = c.y; blk(ctx);
    text(ctx, 'DISK', x2, ry, 11, true);
    if (house.disk) {
      const dk = house.disk, used = 1 - dk.pct_free / 100;
      text(ctx, `${dk.pct_free}% FREE`, x2 + w2, ry, 11, true, 'r');
      box(ctx, x2, ry + 15, w2, 12, 2); ctx.fillRect(x2 + 3, ry + 18, Math.round((w2 - 6) * used), 6);
      text(ctx, `${dk.free_gb} GB FREE OF ${dk.total_gb} GB`, x2, ry + 31, 11, false);
    }
    ry += 50;
    text(ctx, 'MIC', x2, ry, 11, true);
    if (house.mic) {
      text(ctx, house.mic.ptt ? 'PUSH-TO-TALK ON' : 'WAKE WORD', x2 + w2, ry, 10, false, 'r');
      if (house.mic.open) { ctx.fillRect(x2, ry + 13, w2, 15); wht(ctx); }
      text(ctx, house.mic.note, x2 + 4, ry + 15, 12, true); blk(ctx);
    }
    ry += 36;
    text(ctx, 'LAST AUDIT', x2, ry, 11, true);
    const au = house.audit;
    if (au) {
      const at = au.at ? Date.parse(au.at) : null;
      text(ctx, `${at ? clock(at) : '--'} \u00b7 ${au.alert ? 'SEVERE' : au.sev || (au.ok ? 'OK' : 'FAILED')}`, x2 + w2, ry, 10, true, 'r');
      ctx.font = font(11, false); let yy = ry + 14;
      for (const l of wrap(ctx, au.line || (au.ok ? 'OK' : 'DID NOT FINISH'), w2, 3)) { ctx.fillText(l, x2, yy); yy += 13; }
    } else text(ctx, 'NO REPORT FOUND', x2, ry + 14, 11, false);
    // jobs
    y = Math.max(y, ry + 56) + 4;
    blk(ctx); dots(ctx, c.x, y - 4, c.w); y += 3;
    text(ctx, 'JOBS TODAY', c.x, y, 11, true);
    text(ctx, `CHECKED ${clock(house.at * 1000)}`, c.x + c.w, y, 10, false, 'r');
    y += 15;
    const jobs = house.jobs || [];
    const ni = Math.max(0, jobs.findIndex(j => j.st === 'NEXT'));
    const room = Math.max(1, Math.floor((c.y + c.h - 16 - y) / 14));
    const from = Math.max(0, Math.min(ni - 2, jobs.length - room));
    if (!jobs.length) { text(ctx, 'NO SCHEDULED JOBS TODAY', c.x, y, 11, false); y += 14; }
    for (const j of jobs.slice(from, from + room)) {
      blk(ctx); const nx = j.st === 'NEXT';
      if (nx) { ctx.fillRect(c.x - 3, y - 2, c.w + 6, 14); wht(ctx); }
      text(ctx, clock(j.ts * 1000), c.x + 46, y, 11, true, 'r');
      ctx.font = font(11, nx); ctx.fillText(fit(ctx, j.name, c.w - 160), c.x + 56, y);
      const st = j.st === 'NEXT' ? 'NEXT IN ' + dur(j.ts - Date.now() / 1000) : j.st === 'DONE' ? 'DONE' : j.st === 'FAIL' ? '! FAILED' : 'LATER';
      const sw = text(ctx, st, c.x + c.w, y, 11, nx || j.st === 'FAIL', 'r');
      if (j.st === 'DONE') check(ctx, c.x + c.w - sw - 14, y + 1);
      y += 14;
    }
    if (house.next_job) {
      blk(ctx); const nj = house.next_job;
      const sameDay = RT.sameDay(nj.ts * 1000, Date.now());
      const when = (sameDay ? '' : ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'][RT.parts(nj.ts * 1000).dow] + ' ') + clock(nj.ts * 1000);
      ctx.font = font(11, true); ctx.textBaseline = 'top';
      ctx.fillText(fit(ctx, `NEXT JOB: ${nj.name} \u00b7 ${when} (IN ${dur(nj.ts - Date.now() / 1000)})`, c.w), c.x, c.y + c.h - 12);
    }
  }

  // ------------------------------------------------------------------ ALERTS
  function drawAlerts(ctx, c, D, t) {
    const items = alertItems(D); blk(ctx);
    if (!items.length) {
      const cx = c.x + c.w / 2, cy = c.y + c.h / 2 - 30;
      for (let k = 0; k < 4; k++) ctx.fillRect(cx - 22 + k * 5, cy - 8 + k * 5, 6, 6);          // big 1-bit check
      for (let k = 0; k < 7; k++) ctx.fillRect(cx - 2 + k * 5, cy + 7 - k * 5, 6, 6);
      text(ctx, 'ALL QUIET', cx, cy + 26, 30, true, 'c');
      text(ctx, 'NOTHING NEEDS YOU RIGHT NOW', cx, cy + 64, 12, false, 'c');
      if (house) text(ctx, `HOUSE: ALL ${(house.services || []).length} SERVICES UP`, cx, cy + 80, 11, false, 'c');
      return;
    }
    const nYou = items.filter(i => i.kind === 'you').length, nSys = items.length - nYou;
    text(ctx, `${nYou} NEED${nYou === 1 ? 'S' : ''} YOU \u00b7 ${nSys} SYSTEM`, c.x, c.y, 11, true);
    if (house) text(ctx, `CHECKED ${clock(house.at * 1000)}`, c.x + c.w, c.y, 10, false, 'r');
    let y = c.y + 16; const RH = 34;
    for (const it of items) {
      if (y + RH > c.y + c.h + 2) { blk(ctx); text(ctx, `+ ${items.length - items.indexOf(it)} MORE`, c.x, y, 11, true); break; }
      blk(ctx);
      if (it.kind === 'you') { ctx.fillRect(c.x, y, c.w, RH - 4); wht(ctx); } else box(ctx, c.x, y, c.w, RH - 4, 2);
      box(ctx, c.x + 7, y + 6, 18, 18, 2); text(ctx, '!', c.x + 16, y + 9, 13, true, 'c');
      ctx.font = font(13, true); ctx.textBaseline = 'top'; ctx.fillText(fit(ctx, it.t, c.w - 44), c.x + 34, y + 4);
      ctx.font = font(10, false); ctx.fillText(fit(ctx, it.d, c.w - 44), c.x + 34, y + 18);
      y += RH;
    }
  }

  // ------------------------------------------------------------------ titles
  function titleOf(key, D) {
    if (key === 'today') return 'TODAY' + (D.day && D.day.date ? ' - ' + D.day.date : '');
    if (key === 'crew') { const n = ['alfred', 'scout', 'maker'].filter(a => D.crew && D.crew[a] && D.crew[a].status !== 'idle').length; return n ? `CREW - ${n} BUSY` : 'CREW - ALL IDLE'; }
    if (key === 'weather') { const a = D.weather ? RT.asOf(D.weather.at) : '';
      return 'WEATHER' + (D.weather && D.weather.place ? ' - ' + D.weather.place : '') + (a ? ' - ' + a : ''); }
    if (key === 'house') { if (!house) return 'HOUSE - CHECKING..'; const n = houseDown(); return n ? `HOUSE - ${n} DOWN` : 'HOUSE - ALL SYSTEMS UP'; }
    const n = alertItems(D).length; return n ? `ALERTS - ${n}` : 'ALERTS - ALL QUIET';
  }
  const BODY = { today: drawToday, crew: drawCrewWin, weather: drawWeatherWin, house: drawHouse, alerts: drawAlerts };

  // ------------------------------------------------------------------ state machine
  const lerp = (a, b, p) => a + (b - a) * p;
  const lerpR = (a, b, p) => ({ x: Math.round(lerp(a.x, b.x, p)), y: Math.round(lerp(a.y, b.y, p)), w: Math.round(lerp(a.w, b.w, p)), h: Math.round(lerp(a.h, b.h, p)) });
  const DEFAULT_FROM = { x: 236, y: 300, w: 40, h: 20 };
  function open(key, from, t) {
    if (!BODY[key]) return;
    if (Z.key && !Z.closing) { Z.key = key; Z.touched = t; debug.opens++; if (key === 'house' || key === 'alerts') fetchHouse(); return; }   // switch: instant
    Object.assign(Z, { key, from: from ? { x: from.x, y: from.y, w: from.w, h: from.h } : DEFAULT_FROM, at: t, closing: false, touched: t });
    debug.opens++;
    if (key === 'house' || key === 'alerts' || Date.now() - houseTry > 60e3) fetchHouse();
  }
  function close(t, why) { if (Z.key && !Z.closing) { Z.closing = true; Z.at = t; Z.closeKey = Z.key; debug.closes++; debug.lastClose = why || 'close'; } }
  function reset(why) { if (Z.key) { debug.closes++; debug.lastClose = why || 'reset'; } Z.key = null; Z.closing = false; }
  function toggle(key, from, t) { if (Z.key === key && !Z.closing) close(t, 'key'); else open(key, from, t); }
  function cycle(dir, t) { if (!isOpen()) return; const i = ORDER.indexOf(Z.key); open(ORDER[(i + dir + ORDER.length) % ORDER.length], null, t); }
  const isOpen = () => !!Z.key && !Z.closing;
  function hit(x, y) {
    if (!isOpen()) return null;
    const cb = CLOSE_HIT();
    if (x >= cb.x && x < cb.x + cb.w && y >= cb.y && y < cb.y + cb.h) return 'close';
    if (x >= WIN.x && x < WIN.x + WIN.w + 5 && y >= WIN.y && y < WIN.y + WIN.h + 5) return 'inside';
    return 'outside';
  }

  // D = { weather, agenda, day, crew, ptt }
  function draw(ctx, D, t) {
    houseTick();
    if (!Z.key) return;
    const vs = window.RetroBanner ? RetroBanner.state().state : 'idle', dim = DIM_STATES.has(vs);
    if (dim) Z.touched = t;                                  // voice turn in progress: never idle-close under it
    if (!Z.closing && t - Z.touched > IDLE_MS) close(t, 'idle');
    if (Z.closing) {
      const p = (t - Z.at) / CLOSE_MS;
      if (p >= 1) { Z.key = null; Z.closing = false; return; }
      blk(ctx); for (const k of [0, 0.25]) { const q = Math.min(1, p + k); dashRect(ctx, lerpR(WIN, Z.from, Math.round(q * 6) / 6)); }
      return;
    }
    const p = (t - Z.at) / OPEN_MS;
    if (p < 1) {                                             // stepped zoom outlines, classic Finder open
      blk(ctx); for (const k of [0, -0.25, -0.5]) { const q = p + k; if (q > 0) dashRect(ctx, lerpR(Z.from, WIN, Math.round(q * 6) / 6)); }
      return;
    }
    const c = chrome(ctx, WIN, titleOf(Z.key, D), t);
    ctx.save(); ctx.beginPath(); ctx.rect(WIN.x + 3, WIN.y + WIN.titleH + 2, WIN.w - 6, WIN.h - WIN.titleH - 5); ctx.clip();
    try { BODY[Z.key](ctx, c, D, t); } catch (e) { blk(ctx); text(ctx, 'COULD NOT DRAW: ' + String(e.message || e).slice(0, 40).toUpperCase(), c.x, c.y, 11, true); }
    footer(ctx, Z.key, D);
    ctx.restore();
    if (dim) { ctx.fillStyle = pats(ctx).light; ctx.fillRect(WIN.x, WIN.y, WIN.w + 5, WIN.h + 5); }
  }
  // Small live badges on the existing dashboard: attention count in the TODAY title bar, and a HOUSE plate in the
  // bottom strip (HOUSE N! now lives in the key legend). Only drawn when non-zero, never moves anything.
  function badges(ctx, rects, D) {
    const ag = rects.find(r => r.key === 'agenda'), n = attnRows(D).length;
    if (ag && n) {
      ctx.font = font(10, true); const s = `! ${n}`, w = ctx.measureText(s).width + 10, x = ag.x + ag.w - w - 12, y = ag.y + 3;
      wht(ctx); ctx.fillRect(x - 3, y, w + 6, ag.titleH - 5);
      blk(ctx); ctx.fillRect(x, y + 1, w, ag.titleH - 7); wht(ctx); ctx.textBaseline = 'middle'; ctx.fillText(s, x + 5, y + (ag.titleH - 5) / 2 + 1);
    }
  }

  // Key legend in the 18 px strip under the panels (y 327): "1 TODAY  2 CREW  3 WEATHER  4 HOUSE  5 ALERTS", clickable.
  // Carries the HOUSE N! marker (replaces the old plate) and the alert count. Abbreviates to fit left of the PTT tag.
  let LEG = [];
  function legend(ctx, o) {
    LEG = [];
    const down = houseDown(), na = alertItems(o.D || {}).length, y = H - 15, x0 = 16, lim = W - 60;
    const cur = o.key || null;
    ctx.font = font(10, true); ctx.textBaseline = 'middle';
    const num = (i) => `${i + 1}${ORDER[i] === 'house' && down ? '!' : ''}`;
    const label = (i, short) => {
      const k = ORDER[i], base = short ? ({ weather: 'WX', alerts: 'ALERT' }[k] || TAB[k]) : TAB[k];
      let s = `${i + 1} ${base}`;
      if (k === 'house' && down) s += short ? '!' : ` ${down}!`;   // short: "4 HOUSE!"
      if (k === 'alerts' && na) s += ` ${na}`;
      return s;
    };
    const spaceW = ctx.measureText('SPACE=TALK').width + 8;
    const total = (its, gap) => its.reduce((a, s) => a + ctx.measureText(s).width + 8, 0) + gap * (its.length - 1);
    let mode = 0, items = [];
    for (; mode < 3; mode++) {
      items = ORDER.map((k, i) => (mode === 2 ? num(i) : label(i, mode === 1)));
      if (mode === 2 || x0 + total(items, 10) + (o.ptt && !o.dim ? spaceW + 12 : 0) <= lim) break;
    }
    if (o.dim) { mode = 2; items = ORDER.map((k, i) => num(i)); }
    const gap = mode === 2 ? 8 : 10;
    let x = x0;
    items.forEach((s, i) => {
      const w = ctx.measureText(s).width + 8;
      if (ORDER[i] === cur) { blk(ctx); ctx.fillRect(x, y, w, 12); wht(ctx); } else blk(ctx);
      ctx.fillText(s, x + 4, y + 7);
      LEG.push({ key: ORDER[i], x: x - 2, y: H - 17, w: w + 4, h: 17 });
      x += w + gap;
    });
    blk(ctx);
    if (o.ptt && mode < 2 && !o.dim) {
      const xx = lim - spaceW - 4;
      if (xx > x) { box(ctx, xx, y, spaceW, 12, 1); ctx.fillText('SPACE=TALK', xx + 4, y + 7); }
    }
  }
  const legendHit = (x, y) => { const r = LEG.find(r => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h); return r ? r.key : null; };
  const legendClear = () => { LEG = []; };
  const busy = (t) => !!Z.key && (t - Z.at < Math.max(OPEN_MS, CLOSE_MS) + 80);
  const touch = (t) => { Z.touched = t; };
  fetchHouse();
  window.RetroWin = { open, close, reset, toggle, cycle, isOpen, key: () => (isOpen() ? Z.key : null), hit, draw, badges, legend, legendHit, legendClear, busy, touch,
    ORDER, WIN, house: () => house, debug: () => ({ ...debug, key: Z.key, closing: Z.closing, idleMs: performance.now() - Z.touched }) };
})();

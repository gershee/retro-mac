// Retro Mac: panel renderer (cards, weather, agenda, mini tile). Drawn black-on-white;
// face.js thresholds each frame to true 1-bit and maps it to the active theme colors.
(function () {
  const MONO = 'Menlo, "Courier New", monospace';
  const font = (px, bold) => `${bold ? 'bold ' : ''}${px}px ${MONO}`;

  // Wall-clock times on every panel and window follow the server's [location].timezone (sent as dash.tz), not the
  // browser's, so agenda clocks match the server's TODAY / TMR / weekday labels. Unknown zone -> browser time.
  const RetroTime = (() => {
    const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    let tz = '', fmt = null;
    function setTz(name) {
      if (!name || name === tz) return;
      try {
        fmt = new Intl.DateTimeFormat('en-US', { timeZone: name, hourCycle: 'h23', year: 'numeric', month: 'numeric',
          day: 'numeric', hour: 'numeric', minute: 'numeric', weekday: 'short' });
        tz = name;
      } catch (e) { /* unknown zone name: keep the current one */ }
    }
    function parts(ms) {
      const d = new Date(ms);
      if (!fmt) return { y: d.getFullYear(), mo: d.getMonth() + 1, d: d.getDate(), h: d.getHours(), m: d.getMinutes(), dow: d.getDay() };
      const p = {}; for (const x of fmt.formatToParts(d)) p[x.type] = x.value;
      return { y: +p.year, mo: +p.month, d: +p.day, h: (+p.hour) % 24, m: +p.minute, dow: DOW.indexOf(p.weekday) };
    }
    const clock = (ms) => { const p = parts(ms); return `${p.h % 12 || 12}:${String(p.m).padStart(2, '0')}${p.h < 12 ? 'A' : 'P'}`; };
    const hr = (ms) => { const p = parts(ms); return `${p.h % 12 || 12}${p.h < 12 ? 'A' : 'P'}`; };
    const dayStart = (ms) => { const p = parts(ms); return Math.floor(ms / 60e3) * 60e3 - (p.h * 60 + p.m) * 60e3; };
    const sameDay = (a, b) => { const p = parts(a), q = parts(b); return p.y === q.y && p.mo === q.mo && p.d === q.d; };
    // Weather reading age: "AS OF 9:15A" once it is over 45 min old (a failed refetch keeps the last reading).
    // Preview: /?test&wxage=60 pretends the reading is 60 min old.
    let wxAge = NaN;
    try { const q = new URLSearchParams(location.search); if (q.has('test')) wxAge = parseFloat(q.get('wxage')); } catch (e) { /* no page */ }
    const asOf = (at, nowMs) => {
      if (!at) return '';
      const sec = isNaN(wxAge) ? (nowMs || Date.now()) / 1000 - at : wxAge * 60;
      return sec > 45 * 60 ? `AS OF ${clock(isNaN(wxAge) ? at * 1000 : (nowMs || Date.now()) - wxAge * 60e3)}` : '';
    };
    return { setTz, parts, clock, hr, dayStart, sameDay, asOf, tz: () => tz };
  })();
  window.RetroTime = RetroTime;
  // Layout (512x342 logical screen). Right column sits beside the stepped-aside face.
  const COLX = 214, COLW = 282;
  const CARD = { x: COLX, y: 18, w: COLW, h: 306, titleH: 22 };
  function layout(hasTile) {
    const weather = { x: COLX, y: 18, w: COLW, h: 126, titleH: 18 };
    const tile = hasTile ? { x: COLX, y: 150, w: COLW, h: 46, titleH: 16 } : null;
    const ay = hasTile ? 202 : 150;   // weather is 126 tall so a third advice line clears its border
    const agenda = { x: COLX, y: ay, w: COLW, h: 324 - ay, titleH: 18 };
    return { weather, tile, agenda };
  }

  function wrap(ctx, text, maxW) {
    const words = String(text).split(/\s+/); const lines = []; let cur = '';
    for (const w of words) {
      const test = cur ? cur + ' ' + w : w;
      if (ctx.measureText(test).width > maxW && cur) { lines.push(cur); cur = w; } else cur = test;
    }
    if (cur) lines.push(cur);
    return lines;
  }
  function fit(ctx, text, maxW) {
    text = String(text);
    if (ctx.measureText(text).width <= maxW) return text;
    while (text.length > 1 && ctx.measureText(text + '..').width > maxW) text = text.slice(0, -1);
    return text + '..';
  }

  function frame(ctx, r, title) {
    const { x, y, w, h, titleH } = r;
    ctx.fillStyle = '#fff'; ctx.fillRect(x, y, w, h);
    ctx.fillStyle = '#000';
    ctx.fillRect(x, y, w, 2); ctx.fillRect(x, y + h - 2, w, 2);
    ctx.fillRect(x, y, 2, h); ctx.fillRect(x + w - 2, y, 2, h);
    ctx.fillRect(x + 4, y + h, w, 3); ctx.fillRect(x + w, y + 4, 3, h - 1);
    for (let yy = y + 4; yy < y + titleH - 1; yy += 3) ctx.fillRect(x + 4, yy, w - 8, 1);
    ctx.fillRect(x, y + titleH, w, 2);
    const px = titleH >= 22 ? 14 : 12;
    ctx.font = font(px, true);
    const t = String(title || '').slice(0, 26);
    const tw = ctx.measureText(t).width;
    ctx.fillStyle = '#fff'; ctx.fillRect(x + (w - tw) / 2 - 8, y + 3, tw + 16, titleH - 5);
    ctx.fillStyle = '#000'; ctx.textBaseline = 'middle';
    ctx.fillText(t, x + (w - tw) / 2, y + titleH / 2 + 1);
  }
  function staleTag(ctx, r, s) {               // small tag at the right end of a title bar, title-box style
    if (!s) return;
    const { x, y, w, titleH } = r;
    ctx.font = font(10, true);
    const tw = ctx.measureText(s).width;
    ctx.fillStyle = '#fff'; ctx.fillRect(x + w - tw - 18, y + 3, tw + 12, titleH - 5);
    ctx.fillStyle = '#000'; ctx.textBaseline = 'middle'; ctx.fillText(s, x + w - tw - 12, y + titleH / 2 + 1);
  }

  // ---------------------------------------------------------------- big card
  function drawCard(ctx, card, reveal, rect) {
    if (!card) return;
    const R = rect || CARD;
    frame(ctx, R, card.title || 'INFO');
    const pad = 12, bx = R.x + pad, by = R.y + R.titleH + 14, bw = R.w - pad * 2, bottom = R.y + R.h - 10;
    ctx.font = font(14); ctx.textBaseline = 'top'; ctx.fillStyle = '#000';
    const LH = 18; let cy = by; let budget = Math.floor(reveal * 600);
    const put = (s, x, y) => { const n = Math.max(0, Math.min(s.length, budget)); if (n > 0) ctx.fillText(s.slice(0, n), x, y); budget -= s.length; };

    if (card.type === 'list') {
      for (const item of card.items || []) {
        const lines = wrap(ctx, item, bw - 18);
        if (cy + lines.length * LH > bottom) break;
        if (budget > 0) ctx.fillRect(bx, cy + 5, 7, 7);
        for (const ln of lines) { put(ln, bx + 18, cy); cy += LH; }
        cy += 4;
      }
    } else if (card.type === 'rows') {
      for (const r of card.rows || []) {
        if (cy + LH > bottom) break;
        const k = String(r.k), v = String(r.v);
        ctx.font = font(14, true); const kw = ctx.measureText(k).width; put(k, bx, cy);
        ctx.font = font(14); const vw = ctx.measureText(v).width;
        if (budget > 0) for (let dx = bx + kw + 6; dx < bx + bw - vw - 6; dx += 5) ctx.fillRect(dx, cy + 13, 2, 1);
        put(v, bx + bw - vw, cy);
        cy += LH + 6;
      }
    } else if (card.type === 'number') {
      const val = String(card.value ?? ''), unit = card.unit ? String(card.unit) : '';
      let size = 76;
      do { ctx.font = font(size, true); size -= 4; } while (ctx.measureText(val).width > bw - 4 && size > 20);
      ctx.textBaseline = 'alphabetic';
      const vy = R.y + R.h / 2 + 10;
      if (budget > 0) ctx.fillText(val, bx, vy);
      if (unit && budget > 0) { ctx.font = font(14, true); ctx.fillText(unit, bx + 2, vy + 24); }
      if (card.sub && budget > 40) {
        ctx.font = font(14); ctx.textBaseline = 'top'; let sy = vy + 52;
        for (const ln of wrap(ctx, card.sub, bw)) { if (sy + LH > bottom) break; ctx.fillText(ln, bx, sy); sy += LH; }
      }
    } else {
      for (const para of String(card.body || '').split(/\n+/)) {
        for (const ln of wrap(ctx, para, bw)) { if (cy + LH > bottom) return; put(ln, bx, cy); cy += LH; }
        cy += 6;
      }
    }
  }

  // Short text for the mini tile that a finished card shrinks into.
  function cardBlurb(card) {
    if (!card) return '';
    if (card.type === 'list') { const it = card.items || []; return `${it.length} ITEMS: ${it[0] || ''}`; }
    if (card.type === 'rows') return (card.rows || []).slice(0, 2).map(r => `${r.k} ${r.v}`).join(' / ');
    if (card.type === 'number') return `${card.value ?? ''} ${card.unit || ''} ${card.sub || ''}`;
    return String(card.body || '');
  }
  function drawTile(ctx, card, R) {
    frame(ctx, R, card.title || 'INFO');
    ctx.font = font(12); ctx.textBaseline = 'middle'; ctx.fillStyle = '#000';
    ctx.fillText(fit(ctx, cardBlurb(card).replace(/\s+/g, ' ').trim(), R.w - 24), R.x + 12, R.y + R.titleH + (R.h - R.titleH) / 2 + 1);
  }
  const lerp = (a, b, p) => a + (b - a) * p;
  function lerpRect(a, b, p) {
    return { x: lerp(a.x, b.x, p) | 0, y: lerp(a.y, b.y, p) | 0, w: lerp(a.w, b.w, p) | 0, h: lerp(a.h, b.h, p) | 0, titleH: Math.round(lerp(a.titleH, b.titleH, p)) };
  }

  // -------------------------------------------------------------------- icons
  function cloud(ctx, x, y, u) {
    const rows = [[4, 9], [2, 11], [1, 12], [0, 13], [1, 12]];
    rows.forEach(([a, b], i) => ctx.fillRect(x + a * u, y + i * u, (b - a) * u, u));
  }
  function sun(ctx, x, y, u) {
    const rows = [[2, 6], [1, 7], [0, 8], [0, 8], [0, 8], [0, 8], [1, 7], [2, 6]];
    rows.forEach(([a, b], i) => ctx.fillRect(x + a * u, y + i * u, (b - a) * u, u));
  }
  function drawIcon(ctx, kind, x, y, t) {
    ctx.fillStyle = '#000';
    if (kind === 'clear') {
      sun(ctx, x + 6, y + 4, 4);
      ctx.fillRect(x + 20, y - 4, 4, 5); ctx.fillRect(x + 20, y + 38, 4, 5);
      ctx.fillRect(x - 2, y + 18, 5, 4); ctx.fillRect(x + 41, y + 18, 5, 4);
      for (const [dx, dy] of [[1, 1], [41, 1], [1, 37], [41, 37]]) ctx.fillRect(x + dx, y + dy, 4, 4);
    } else if (kind === 'partly') {
      sun(ctx, x + 18, y - 2, 3);
      ctx.fillStyle = '#fff'; ctx.fillRect(x - 2, y + 14, 48, 22); ctx.fillStyle = '#000';
      cloud(ctx, x, y + 16, 3);
    } else {
      cloud(ctx, x, y + 2, 3);
      const f = Math.floor(t / 400) % 2;
      if (kind === 'rain') for (let i = 0; i < 4; i++) ctx.fillRect(x + 6 + i * 10 + f * 2, y + 22 + ((i + f) % 2) * 4, 3, 7);
      if (kind === 'snow') for (let i = 0; i < 4; i++) ctx.fillRect(x + 6 + i * 10, y + 22 + ((i + f) % 2) * 6, 4, 4);
      if (kind === 'storm') { ctx.fillRect(x + 20, y + 20, 5, 6); ctx.fillRect(x + 16, y + 26, 9, 4); ctx.fillRect(x + 16, y + 30, 5, 7); }
    }
  }

  // ------------------------------------------------------------------ weather
  // panel title = config.toml [location].name (sent as weather.place); plain WEATHER until the first feed arrives
  const place = wx => String((wx && wx.place) || 'WEATHER').toUpperCase();
  function drawWeather(ctx, wx, R, t) {
    frame(ctx, R, place(wx));
    staleTag(ctx, R, wx && RetroTime.asOf(wx.at));
    if (!wx) { ctx.font = font(12); ctx.textBaseline = 'top'; ctx.fillStyle = '#000'; ctx.fillText('LOADING WEATHER..', R.x + 12, R.y + R.titleH + 14); return; }
    const x = R.x + 14, y = R.y + R.titleH + 12;
    drawIcon(ctx, wx.icon, x, y, t);
    ctx.fillStyle = '#000'; ctx.textBaseline = 'alphabetic';
    ctx.font = font(34, true); ctx.fillText(`${wx.temp}\u00b0`, x + 58, y + 30);
    ctx.font = font(12, true); ctx.textBaseline = 'top';
    ctx.fillText(wx.cond, x + 138, y + 2);
    ctx.font = font(12);
    ctx.fillText(`FEELS ${wx.feels}  WIND ${wx.wind}`, x + 138, y + 17);
    ctx.fillText(`HI ${wx.hi}  LO ${wx.lo}`, x + 138, y + 32);
    let ly = R.y + R.titleH + 58; const maxW = R.w - 24;
    ctx.font = font(12, true);
    for (const ln of (wx.lines || []).slice(0, 3)) {
      const text = fit(ctx, ln.t, maxW - 8);
      if (ln.hot) {
        ctx.fillStyle = '#000'; ctx.fillRect(R.x + 10, ly - 1, maxW + 4, 15);
        ctx.fillStyle = '#fff'; ctx.fillText(text, R.x + 14, ly);
      } else { ctx.fillStyle = '#000'; ctx.fillText(text, R.x + 14, ly); }
      ly += 16;
    }
  }

  // ------------------------------------------------------------------- agenda
  function drawAgenda(ctx, rows, R) {
    frame(ctx, R, 'TODAY');
    ctx.textBaseline = 'top';
    let y = R.y + R.titleH + 9; const LH = 16, x0 = R.x + 12, W = R.w - 24, TW = 66;
    const bottom = R.y + R.h - 8;
    for (const r of rows || []) {
      if (r.x) continue;              // extra rows only shown in the enlarged view
      if (y + LH > bottom) break;
      if (r.k === 'attn') {
        ctx.fillStyle = '#000'; ctx.fillRect(x0 - 2, y - 1, W + 4, LH - 1);
        ctx.font = font(12, true); ctx.fillStyle = '#fff';
        ctx.fillText('! ' + fit(ctx, r.title, W - 16), x0 + 2, y);
      } else if (r.k === 'none') {
        ctx.font = font(12); ctx.fillStyle = '#000'; ctx.fillText(r.title, x0, y);
      } else {
        ctx.font = font(12, true);
        if (r.now) { ctx.fillStyle = '#000'; ctx.fillRect(x0 - 2, y - 1, TW - 4, LH - 1); ctx.fillStyle = '#fff'; }
        else ctx.fillStyle = '#000';
        ctx.fillText(r.t, x0, y);
        ctx.fillStyle = '#000'; ctx.font = font(12);
        ctx.fillText(fit(ctx, (r.k === 'remind' ? '* ' : '') + r.title, W - TW), x0 + TW, y);
      }
      y += LH + 1;
    }
  }


  // --------------------------------------------------------------------- crew
  // Who is doing what right now: one row per agent. Active rows are inverted bars.
  const CREW = { x: 10, y: 232, w: 196, h: 92, titleH: 16 };
  const NAMES = { alfred: 'ALFRED', scout: 'SCOUT', maker: 'MAKER' };
  function glyph(ctx, kind, x, y, t, inv) {
    ctx.fillStyle = inv ? '#fff' : '#000';
    const f = Math.floor(t / 180);
    if (kind === 'idle') { ctx.fillRect(x, y + 4, 8, 2); ctx.fillRect(x, y + 10, 8, 2); ctx.fillRect(x, y + 4, 2, 8); ctx.fillRect(x + 6, y + 4, 2, 8); }
    else if (kind === 'listening') {           // concentric pulse = hearing you
      const r = f % 3; ctx.fillRect(x + 3, y + 7, 3, 3);
      if (r >= 1) { ctx.fillRect(x + 1, y + 4, 7, 1); ctx.fillRect(x + 1, y + 11, 7, 1); ctx.fillRect(x, y + 5, 1, 6); ctx.fillRect(x + 8, y + 5, 1, 6); }
      if (r >= 2) { ctx.fillRect(x - 2, y + 2, 13, 1); ctx.fillRect(x - 2, y + 13, 13, 1); }
    }
    else if (kind === 'thinking') { for (let i = 0; i < 3; i++) if (i <= f % 4) ctx.fillRect(x + i * 5, y + 7, 3, 3); }
    else if (kind === 'working') {            // rotating block = busy
      const pts = [[0, 0], [5, 0], [5, 5], [0, 5]];
      pts.forEach(([dx, dy], i) => { if (i !== f % 4) ctx.fillRect(x + 1 + dx, y + 4 + dy, 4, 4); });
    } else {                                   // speaking: three bouncing bars
      for (let i = 0; i < 3; i++) { const h = 3 + ((f + i * 2) % 4) * 2; ctx.fillRect(x + i * 5, y + 12 - h, 3, h); }
    }
  }
  function drawCrew(ctx, crew, speaker, t, R) {
    R = R || CREW;
    frame(ctx, R, 'CREW');
    ctx.textBaseline = 'top';
    let y = R.y + R.titleH + 8; const x0 = R.x + 10, W = R.w - 20, LH = 19;
    for (const a of ['alfred', 'scout', 'maker']) {
      const c = (crew && crew[a]) || { status: 'idle', label: '' };
      let status = c.status, label = c.label;
      if (speaker === a) { status = 'speaking'; label = 'SPEAKING'; }
      const active = status !== 'idle';
      if (active) { ctx.fillStyle = '#000'; ctx.fillRect(x0 - 4, y - 2, W + 8, LH - 1); }
      glyph(ctx, status, x0, y - 1, t, active);
      ctx.font = font(12, true); ctx.fillStyle = active ? '#fff' : '#000';
      ctx.fillText(NAMES[a], x0 + 20, y);
      ctx.font = font(11, false);
      ctx.fillText(fit(ctx, active ? label : 'IDLE', W - 20 - 52), x0 + 20 + 52, y + 1);
      y += LH;
    }
  }

  // ------------------------------------------------------------- crew history
  // The last few distinct things each agent did, kept in the page (cheap; resets on reload).
  const HIST = { alfred: [], scout: [], maker: [] }, lastSeen = {};
  const SKIP_HIST = new Set(['', 'THINKING', 'HEARD YOU', 'LISTENING']);
  function noteCrew(crew) {
    if (!crew) return;
    for (const a of Object.keys(HIST)) {
      const c = crew[a]; if (!c) continue;
      const key = c.status + '|' + c.label;
      if (lastSeen[a] === key) continue;
      lastSeen[a] = key;
      if (c.status === 'idle') continue;
      const label = c.label === 'PREPARING VOICE' ? 'REPLIED' : String(c.label || '');
      if (SKIP_HIST.has(label)) continue;
      const h = HIST[a], now = new Date();
      if (h.length && h[h.length - 1].label === label) { h[h.length - 1].at = now; continue; }
      h.push({ label, at: now });
      if (h.length > 6) h.shift();
    }
  }
  const clock = (d) => RetroTime.clock(+d);

  // --------------------------------------------------------------- zoom state
  // Click a panel -> it zooms (classic Mac zoom-rect) to BIG and shows its full view; click / Esc
  // zooms it back. One at a time. Auto-restores after a few idle minutes so the kiosk never sticks.
  const BIG = { x: 12, y: 10, w: 488, h: 318, titleH: 22 };
  const ZOOM_MS = 260, AUTO_CLOSE_MS = 3 * 60 * 1000;
  const Z = { key: null, from: null, at: 0, openedAt: 0, closing: false, title: '' };
  const zoom = {
    open(key, from, t) { Object.assign(Z, { key, from: { ...from }, at: t, openedAt: t, closing: false }); },
    close(t) { if (Z.key && !Z.closing) { Z.closing = true; Z.at = t; } },
    reset() { Z.key = null; Z.closing = false; },
    isOpen() { return !!Z.key && !Z.closing; },
    key() { return Z.key; },
    animating(t) { return !!Z.key && t - Z.at < ZOOM_MS + 60; },
    MS: ZOOM_MS,
  };
  const TITLES = { weather: 'WEATHER', agenda: 'TODAY', crew: 'CREW' };

  // small 1-bit icon (half-size weather glyph) for hourly / daily rows
  function miniIcon(ctx, kind, x, y, t, s) {
    ctx.save(); ctx.translate(x, y); ctx.scale(s, s); drawIcon(ctx, kind, 0, 0, t); ctx.restore();
  }

  function drawWeatherBig(ctx, wx, R, t) {
    frame(ctx, R, place(wx) + ' WEATHER');
    staleTag(ctx, R, wx && RetroTime.asOf(wx.at));
    ctx.fillStyle = '#000'; ctx.textBaseline = 'top';
    if (!wx) { ctx.font = font(14); ctx.fillText('LOADING WEATHER..', R.x + 16, R.y + R.titleH + 16); return; }
    const x0 = R.x + 18, y0 = R.y + R.titleH + 14;
    miniIcon(ctx, wx.icon, x0 + 4, y0 + 8, t, 1.75);
    ctx.fillStyle = '#000'; ctx.textBaseline = 'alphabetic';
    ctx.font = font(60, true); ctx.fillText(`${wx.temp}\u00b0`, x0 + 100, y0 + 62);
    const dx = x0 + 250;
    ctx.textBaseline = 'top';
    ctx.font = font(16, true); ctx.fillText(fit(ctx, wx.cond, R.x + R.w - 16 - dx), dx, y0 + 4);
    ctx.font = font(14);
    ctx.fillText(`FEELS LIKE ${wx.feels}\u00b0`, dx, y0 + 28);
    ctx.fillText(`WIND ${wx.wind} MPH`, dx, y0 + 46);
    ctx.fillText(`HI ${wx.hi}\u00b0  LO ${wx.lo}\u00b0`, dx, y0 + 64);
    // advice lines (left) + 3-day outlook (right, when the feed has it)
    const daily = Array.isArray(wx.daily) ? wx.daily.slice(0, 3) : [];
    const hourly = Array.isArray(wx.hourly) ? wx.hourly.slice(0, 12) : [];
    let ly = y0 + 96; const lw = daily.length ? 262 : R.w - 36;
    ctx.font = font(13, true);
    for (const ln of (wx.lines || []).slice(0, 4)) {
      const text = fit(ctx, ln.t, lw - 12);
      if (ln.hot) { ctx.fillStyle = '#000'; ctx.fillRect(x0 - 4, ly - 2, lw, 18); ctx.fillStyle = '#fff'; }
      else ctx.fillStyle = '#000';
      ctx.fillText(text, x0, ly); ly += 21;
    }
    if (daily.length) {
      const rx = x0 + lw + 12, rw = R.x + R.w - 14 - rx;
      ctx.fillStyle = '#000'; ctx.fillRect(rx - 7, y0 + 94, 2, 84);
      daily.forEach((d, i) => {
        const yy = y0 + 94 + i * 28;
        miniIcon(ctx, d.icon || 'cloud', rx + 2, yy + 4, t, 0.45);
        ctx.fillStyle = '#000'; ctx.font = font(13, true); ctx.fillText(String(d.d || ''), rx + 28, yy + 2);
        ctx.font = font(13); ctx.fillText(`${d.hi}\u00b0/${d.lo}\u00b0`, rx + 82, yy + 2);
        ctx.font = font(11); ctx.fillText(fit(ctx, (d.pop ? `${d.pop}% ` : '') + (d.cond || ''), rw - 28), rx + 28, yy + 16);
      });
    }
    if (hourly.length) {        // next 12 hours: time, temp, precipitation chance as a bar
      const top = R.y + R.h - 98, cw = (R.w - 28) / hourly.length, barTop = top + 34, barH = 34;
      ctx.fillStyle = '#000'; ctx.fillRect(R.x + 10, top - 6, R.w - 20, 2);
      for (let yy = barTop; yy <= barTop + barH; yy += 17) for (let xx = R.x + 14; xx < R.x + R.w - 14; xx += 4) ctx.fillRect(xx, yy, 1, 1);
      hourly.forEach((h, i) => {
        const cx = R.x + 14 + i * cw + cw / 2;
        ctx.fillStyle = '#000'; ctx.textBaseline = 'top';
        ctx.font = font(11, true); let s = String(h.t || ''); ctx.fillText(s, cx - ctx.measureText(s).width / 2, top);
        ctx.font = font(12); s = `${h.temp}\u00b0`; ctx.fillText(s, cx - ctx.measureText(s).width / 2, top + 15);
        const ph = Math.round(barH * Math.max(0, Math.min(100, h.pop || 0)) / 100);
        if (ph > 0) ctx.fillRect(cx - cw / 2 + 5, barTop + barH - ph, cw - 10, ph);
        ctx.font = font(10); s = `${h.pop || 0}%`; ctx.fillText(s, cx - ctx.measureText(s).width / 2, barTop + barH + 4);
      });
    }
  }

  function drawAgendaBig(ctx, rows, R) {
    frame(ctx, R, 'TODAY');
    const list = []; let lastDay = '';
    const DAYS = { TMR: 'TOMORROW', MON: 'MONDAY', TUE: 'TUESDAY', WED: 'WEDNESDAY', THU: 'THURSDAY', FRI: 'FRIDAY',
                   SAT: 'SATURDAY', SUN: 'SUNDAY' };
    const dayOf = (r) => { const m = /^([A-Z]{3}) /.exec(String(r.t || '')); return m ? DAYS[m[1]] || m[1] : ''; };
    for (const r of rows || []) {
      const d = r.tmr ? dayOf(r) || 'TOMORROW' : '';
      if (d && d !== lastDay) { lastDay = d; list.push({ k: 'div', title: d }); }
      list.push(r);
    }
    const LH = 20, TW = 76, top = R.y + R.titleH + 12, bottom = R.y + R.h - 8;
    const cap = Math.floor((bottom - top) / LH);
    ctx.font = font(14);
    // one wide column (long titles wrap) unless it would overflow; then two columns, titles clipped
    const label = (r) => (r.k === 'remind' ? '* ' : '') + r.title;
    const textLines = (r, w) => {        // up to 2 wrapped lines, the 2nd clipped with '..'
      const all = wrap(ctx, label(r), w - TW);
      return all.length <= 2 ? all : [all[0], fit(ctx, all.slice(1).join(' '), w - TW)];
    };
    const multi = (r) => r.k === 'event' || r.k === 'remind';
    const oneColW = R.w - 28;
    // 1) one wide column, long titles wrap to 2 lines; 2) one column, one line each; 3) two columns
    const wrapped = list.reduce((n, r) => n + (multi(r) ? textLines(r, oneColW).length : 1), 0) <= cap;
    const cols = wrapped || list.length <= cap ? 1 : 2;
    const colW = cols === 1 ? oneColW : (R.w - 28 - 16) / 2;
    let col = 0, y = top;
    ctx.textBaseline = 'top';
    for (const r of list) {
      ctx.font = font(14);
      const lines = wrapped && multi(r) ? textLines(r, colW) : null;
      const need = (lines ? lines.length : 1) * LH;
      if (y + need > bottom) { if (++col >= cols) break; y = top; }
      const x0 = R.x + 14 + col * (colW + 16);
      if (r.k === 'div') {
        ctx.fillStyle = '#000'; ctx.font = font(12, true);
        const tw = ctx.measureText(r.title).width;
        for (let xx = x0; xx < x0 + colW; xx += 4) ctx.fillRect(xx, y + 9, 2, 1);
        ctx.fillStyle = '#fff'; ctx.fillRect(x0 + 6, y + 1, tw + 12, 16);
        ctx.fillStyle = '#000'; ctx.fillText(r.title, x0 + 12, y + 3);
      } else if (r.k === 'attn') {
        ctx.fillStyle = '#000'; ctx.fillRect(x0 - 3, y - 1, colW + 6, LH - 2);
        ctx.font = font(14, true); ctx.fillStyle = '#fff';
        ctx.fillText('! ' + fit(ctx, r.title, colW - 18), x0 + 2, y + 1);
      } else if (r.k === 'none') {
        ctx.font = font(14); ctx.fillStyle = '#000'; ctx.fillText(r.title, x0, y + 1);
      } else {
        const tlabel = String(r.t || '').replace(/^[A-Z]{3} /, '');   // the day is on the divider above
        ctx.font = font(14, true);
        if (r.now) { ctx.fillStyle = '#000'; ctx.fillRect(x0 - 3, y - 1, TW - 6, LH - 2); ctx.fillStyle = '#fff'; }
        else ctx.fillStyle = '#000';
        ctx.fillText(tlabel, x0, y + 1);
        ctx.fillStyle = '#000'; ctx.font = font(14);
        if (lines) lines.forEach((ln, i) => ctx.fillText(ln, x0 + TW, y + 1 + i * LH));
        else ctx.fillText(fit(ctx, label(r), colW - TW), x0 + TW, y + 1);
      }
      y += need;
    }
  }

  function drawCrewBig(ctx, crew, speaker, t, R) {
    frame(ctx, R, 'CREW');
    const top = R.y + R.titleH + 10, secH = Math.floor((R.h - R.titleH - 16) / 3);
    const x0 = R.x + 14, W = R.w - 28;
    ['alfred', 'scout', 'maker'].forEach((a, i) => {
      const c = (crew && crew[a]) || { status: 'idle', label: '' };
      let status = c.status, label = c.label;
      if (speaker === a) { status = 'speaking'; label = 'SPEAKING'; }
      const active = status !== 'idle', y = top + i * secH;
      if (active) { ctx.fillStyle = '#000'; ctx.fillRect(x0 - 4, y, W + 8, 28); }
      ctx.save(); ctx.translate(x0 + 2, y + 1); ctx.scale(1.6, 1.6); glyph(ctx, status, 0, 0, t, active); ctx.restore();
      ctx.textBaseline = 'top'; ctx.fillStyle = active ? '#fff' : '#000';
      ctx.font = font(18, true); ctx.fillText(NAMES[a], x0 + 34, y + 5);
      ctx.font = font(14, true);
      ctx.fillText(fit(ctx, active ? label || status.toUpperCase() : 'IDLE', W - 34 - 96 - 8), x0 + 34 + 96, y + 7);
      ctx.fillStyle = '#000'; ctx.font = font(12);
      const h = HIST[a].slice(-3).reverse();
      if (!h.length) ctx.fillText('NO RECENT ACTIVITY', x0 + 34, y + 36);
      h.forEach((e, j) => { ctx.fillText(clock(e.at), x0 + 34, y + 36 + j * 15); ctx.fillText(fit(ctx, e.label, W - 34 - 64), x0 + 34 + 64, y + 36 + j * 15); });
      if (i < 2) for (let xx = x0; xx < x0 + W; xx += 4) ctx.fillRect(xx, y + secH - 4, 2, 1);
    });
  }

  // D = { weather, agenda, crew, speaker, card } ; draws the zoom rect or the full big view on top
  function drawZoom(ctx, D, t) {
    if (!Z.key) return;
    if (!Z.closing && t - Z.openedAt > AUTO_CLOSE_MS) zoom.close(t);
    const p = Math.min(1, (t - Z.at) / ZOOM_MS);
    if (Z.closing && p >= 1) { zoom.reset(); return; }
    const card = Z.key === 'tile' || Z.key === 'card' ? D.card : null;
    if ((Z.key === 'tile' || Z.key === 'card') && !card) { zoom.reset(); return; }
    const pp = Z.closing ? 1 - p : p;
    if (pp < 1) {                      // stepped zoom-rect, like the classic Finder open/close
      const s = Math.round(pp * 8) / 8;
      frame(ctx, lerpRect(Z.from, BIG, s), card ? card.title || 'INFO' : TITLES[Z.key]);
      return;
    }
    if (Z.key === 'weather') drawWeatherBig(ctx, D.weather, BIG, t);
    else if (Z.key === 'agenda') drawAgendaBig(ctx, D.agenda, BIG);
    else if (Z.key === 'crew') drawCrewBig(ctx, D.crew, D.speaker, t, BIG);
    else drawCard(ctx, card, 20, BIG);
  }

  window.RetroCards = { drawCrew, drawCard, drawTile, drawWeather, drawAgenda, lerpRect, layout, CARD, CREW, noteCrew, zoom, drawZoom,
    drawIcon, glyph };   // drawIcon + glyph: shared with windows.js (v1.1 click-in windows)
})();

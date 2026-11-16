// Retro Mac: anti burn-in layer (LCD image retention). Purely additive: the v1 dashboard is not redrawn or redesigned.
//   1. PIXEL ORBIT   the whole scaled canvas (#screen) is nudged by a few PHYSICAL pixels (+-3, whole device pixels so the
//                    1-bit art stays crisp) every ~2-3 min, so static edges never sit on the same LCD pixels. #screen is
//                    made 6 device px shorter (--bshrink) so a shift never crops the canvas.
//   2. NIGHT REST    11:30 PM - 6:00 AM, after 20 min with no activity: fades to near-black, the whole screen shrinks to a
//                    small sleeping dashboard (face + z's) that glides around. Any key / mouse / speech / crew activity
//                    wakes it at once. By day, after 30 min of no activity: a barely visible 12% dim, same instant wake.
//   3. CLEARING MODE opt-in, for retention that is already there: key W, or POST /event {"wipe": minutes} (0 = stop,
//                    default 20). A slow colour cycle plus a travelling inverted band exercises every pixel; nothing
//                    changes faster than ~1.5x/s. Esc / Space / speech / W again stops it, and it ends on its own.
// Test / preview params (all optional): ?noburn (layer off) ?orbit=<sec> orbit step interval ?restidle=<sec> ?dimidle=<sec>
//   ?wipe=<min> start clearing on load (local only) ?hour=<0-23.9> (face.js) fakes the clock. window.RetroBurn.state() inspects it.
(function () {
  const params = new URLSearchParams(location.search);
  if (params.has('noburn')) return;
  const TEST = params.has('test');
  const num = (k, d) => { const v = parseFloat(params.get(k)); return params.has(k) && isFinite(v) ? v : d; };
  const screen = document.getElementById('screen'), root = document.documentElement;
  if (!screen) return;
  const AMP = 3;                                         // orbit: +-3 device px per axis (a 6 px span)
  const ORBIT_S = num('orbit', 150);                     // mean seconds between steps (real: 120-180 s)
  const REST_IDLE = num('restidle', 20 * 60) * 1000;     // night: quiet this long before fading out
  const DIM_IDLE = num('dimidle', 30 * 60) * 1000;       // day: quiet this long before the faint dim
  const NIGHT_FROM = 23.5, NIGHT_TO = 6;
  const DIM_ALPHA = 0.12, REST_ALPHA = 0.94, REST_SCALE = 0.5;
  const dpr = () => window.devicePixelRatio || 1;

  // ------------------------------------------------------------------ dim / rest overlay
  const veil = document.createElement('div');
  veil.id = 'burn-veil';
  veil.style.cssText = 'position:fixed;inset:0;background:#000;opacity:0;pointer-events:none;z-index:20;';
  document.body.appendChild(veil);

  // ------------------------------------------------------------------ activity
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { if (TEST) return; try { localStorage.setItem(k, v); } catch (e) {} },
  };
  const now = () => performance.now();
  let lastActive = (() => { const s = +store.get('rm-burnact') || 0; return s && !TEST ? now() - Math.min(Math.max(Date.now() - s, 0), 864e5) : now(); })();
  let savedAt = 0;
  function active() {
    lastActive = now();
    if (Date.now() - savedAt > 5000) { savedAt = Date.now(); store.set('rm-burnact', String(savedAt)); }
  }
  function busyNow() {                                   // speech, crew work or a voice turn counts as activity
    const F = window.RetroFace;
    if (!F) return false;
    try {
      const i = F.info();
      if (i.playing) return true;
      if (i.crew) for (const a in i.crew) if (i.crew[a] && i.crew[a].status && i.crew[a].status !== 'idle') return true;
      if (window.RetroBanner && RetroBanner.state().state !== 'idle') return true;
    } catch (e) {}
    return false;
  }
  function hourNow() { try { return window.RetroFace.mood().hour; } catch (e) { const d = new Date(); return d.getHours() + d.getMinutes() / 60; } }
  const isNight = (h) => h >= NIGHT_FROM || h < NIGHT_TO;

  // ------------------------------------------------------------------ orbit + rest placement
  let mode = 'day', ox = 0, oy = 0, driftX = 0, driftY = 0, nextOrbit = now() + ORBIT_S * 1000 * (0.8 + Math.random() * 0.4), nextDrift = 0;
  function place() {
    const d = dpr();
    root.style.setProperty('--bshrink', (2 * AMP / d) + 'px');
    if (mode === 'rest') screen.style.transform = `translate(${driftX}px,${driftY}px) scale(${REST_SCALE})`;
    else screen.style.transform = (ox || oy) ? `translate(${ox / d}px,${oy / d}px)` : '';
  }
  function orbitStep() {
    let nx, ny, tries = 0;
    do { nx = Math.round((Math.random() * 2 - 1) * AMP); ny = Math.round((Math.random() * 2 - 1) * AMP); tries++; }
    while (Math.abs(nx - ox) + Math.abs(ny - oy) < 2 && tries < 20);   // always a real move
    ox = nx; oy = ny; place();
  }
  function drift() {
    driftX = (Math.random() * 2 - 1) * innerWidth * 0.2;
    driftY = (Math.random() * 2 - 1) * innerHeight * 0.2;
    place();
  }

  function setMode(m) {
    if (m === mode) return;
    const was = mode; mode = m;
    if (m === 'day') {                                   // wake: instant
      veil.style.transition = 'opacity .15s linear'; veil.style.opacity = '0';
      screen.style.transition = 'transform .15s ease-out';
    } else if (m === 'dim') {
      veil.style.transition = 'opacity 60s linear'; veil.style.opacity = String(DIM_ALPHA);
    } else if (m === 'rest') {
      veil.style.transition = 'opacity 45s linear'; veil.style.opacity = String(REST_ALPHA);
      screen.style.transition = 'transform 45s ease-in-out';
      nextDrift = now() + 45e3;
      drift();
      return;
    }
    if (was === 'rest') setTimeout(() => { if (mode !== 'rest') screen.style.transition = ''; }, 250);   // drop the quick wake transition
    else screen.style.transition = '';
    place();
  }

  // ------------------------------------------------------------------ clearing mode
  let wipeUntil = 0, cv = null, cctx = null, img = null, wipeStart = 0, wipeTimer = 0, uMap = null;
  const COLS = [[0, 0, 0], [255, 255, 255], [255, 0, 0], [0, 255, 0], [0, 0, 255], [255, 255, 255]];
  const STEP_S = 10, FADE_S = 4, BAND_S = 9;
  const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
  function wipeBuild() {
    const w = 160, h = Math.max(40, Math.round(160 * innerHeight / innerWidth));
    cv = document.createElement('canvas'); cv.width = w; cv.height = h;
    cv.style.cssText = 'position:fixed;left:0;top:0;width:100vw;height:100vh;border-radius:0;image-rendering:auto;z-index:30;opacity:0;transition:opacity 1.5s linear;pointer-events:none;';
    document.body.appendChild(cv);
    cctx = cv.getContext('2d'); img = cctx.createImageData(w, h);
    uMap = new Float32Array(w * h);
    const c = Math.cos(0.5), s = Math.sin(0.5);          // band runs along a ~30 degree diagonal
    for (let y = 0, i = 0; y < h; y++) for (let x = 0; x < w; x++, i++) uMap[i] = (x / w * c + y / h * s) / (c + s);
  }
  function wipeDraw() {
    const t = (now() - wipeStart) / 1000, d = img.data, w = cv.width, h = cv.height;
    const idx = Math.floor(t / STEP_S), f = t % STEP_S, k = f > STEP_S - FADE_S ? smooth(0, 1, (f - (STEP_S - FADE_S)) / FADE_S) : 0;
    const c0 = COLS[idx % COLS.length], c1 = COLS[(idx + 1) % COLS.length];
    const br = c0[0] + (c1[0] - c0[0]) * k, bg = c0[1] + (c1[1] - c0[1]) * k, bb = c0[2] + (c1[2] - c0[2]) * k;
    const pos = -0.25 + 1.5 * ((t / BAND_S) % 1);
    for (let i = 0, p = 0; i < w * h; i++, p += 4) {
      const m = 1 - smooth(0.09, 0.22, Math.abs(uMap[i] - pos));
      d[p] = br + (255 - 2 * br) * m; d[p + 1] = bg + (255 - 2 * bg) * m; d[p + 2] = bb + (255 - 2 * bb) * m; d[p + 3] = 255;
    }
    cctx.putImageData(img, 0, 0);
    if (now() >= wipeUntil) wipeStop(false);
  }
  function wipeStart_(sec) {
    wipeUntil = now() + sec * 1000;
    if (wipeTimer) return;                               // already running: only the end time moved
    if (!cv) wipeBuild();
    wipeStart = now();
    wipeDraw();
    requestAnimationFrame(() => { if (cv) cv.style.opacity = '1'; });
    wipeTimer = setInterval(wipeDraw, 100);              // 10 fps is plenty for a slow sweep
    setMode('day'); active();
  }
  function wipeStop(post) {
    wipeUntil = 0;
    if (wipeTimer) { clearInterval(wipeTimer); wipeTimer = 0; }
    if (cv) { const c = cv; cv = null; c.style.opacity = '0'; setTimeout(() => c.remove(), 1700); }
    active();                                            // the idle clock restarts after a clearing run
    if (post) fetch('/event', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ wipe: 0 }) }).catch(() => {});
  }
  function wipeOn(minutes) {                             // key W / API: ask the server (all displays follow), run locally either way
    const m = minutes > 0 ? minutes : 20;
    wipeStart_(m * 60);
    if (TEST) return;
    fetch('/event', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ wipe: m }) }).catch(() => {});
  }
  window.addEventListener('rm-wipe', (e) => {            // server broadcast: {left, total} seconds
    const m = e.detail || {};
    if (m.left > 0) wipeStart_(m.left); else if (wipeTimer) wipeStop(false);
  });
  const isTyping = (el) => !!el && (el.isContentEditable || ['TEXTAREA', 'SELECT'].includes(el.tagName) ||
    (el.tagName === 'INPUT' && !['range', 'button', 'checkbox', 'radio'].includes((el.type || '').toLowerCase())));
  addEventListener('keydown', (e) => {
    active(); tick();
    if (e.metaKey || e.ctrlKey || e.altKey || e.repeat || isTyping(e.target)) return;
    if (e.key === 'w' || e.key === 'W') { if (wipeTimer) wipeStop(!TEST); else wipeOn(20); }
    else if ((e.key === 'Escape' || e.key === ' ') && wipeTimer) wipeStop(!TEST);   // Space = push-to-talk, Esc = stop: both end the sweep
  }, true);
  addEventListener('pointerdown', () => { active(); tick(); });
  let lastMove = 0;
  addEventListener('mousemove', () => { const t = now(); if (t - lastMove > 400) { lastMove = t; active(); tick(); } });
  addEventListener('resize', place);

  // ------------------------------------------------------------------ main tick
  function tick() {
    const t = now();
    if (busyNow()) active();
    if (wipeTimer) {                                     // clearing: the veil stays off; speech ends it so the face can talk
      try { if (window.RetroFace.info().playing) wipeStop(!TEST); } catch (e) {}
      if (wipeTimer) { if (t >= nextOrbit) { orbitStep(); nextOrbit = t + ORBIT_S * 1000 * (0.8 + Math.random() * 0.4); } return; }
    }
    const idle = t - lastActive, night = isNight(hourNow());
    let want = 'day';
    if (night) { if (idle >= REST_IDLE) want = 'rest'; }
    else if (idle >= DIM_IDLE) want = 'dim';
    if (want === 'day' && mode !== 'day') setMode('day');
    else if (want !== mode) setMode(want);
    if (mode === 'rest') { if (t >= nextDrift) { nextDrift = t + (45 + Math.random() * 30) * 1000; drift(); } }
    else if (t >= nextOrbit) { orbitStep(); nextOrbit = t + ORBIT_S * 1000 * (0.8 + Math.random() * 0.4); }
  }
  setInterval(tick, 250);
  place();
  if (params.has('wipe')) wipeStart_(Math.max(0.05, num('wipe', 20)) * 60);

  window.RetroBurn = {
    state: () => ({ mode, ox, oy, driftX, driftY, idleS: Math.round((now() - lastActive) / 1000), wiping: !!wipeTimer,
      wipeLeftS: wipeTimer ? Math.round((wipeUntil - now()) / 1000) : 0, veil: +veil.style.opacity || 0, dpr: dpr(), night: isNight(hourNow()) }),
    wipe: (m) => wipeOn(m), stop: () => wipeStop(false), orbit: orbitStep,
  };
})();

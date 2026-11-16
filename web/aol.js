// Retro Mac: the "aol" skin. Same kiosk, same state, dressed as logging on to AOL in 1999 on a Windows 98 box.
// Opt-in: theme "aol" (last in the T-key cycle) or ?theme=aol / ?skin=aol. face.js hands every frame to RetroAOL.frame()
// while that theme is active and never touches this file otherwise, so the v1 look is unchanged with the skin off.
//
//   boot      Sign On window -> "Connecting" (3 steps, a running triangle pal, synthesized dial-up) -> desktop. Any key/click skips.
//   desktop   Welcome window (mailbox, channel buttons for the click-in windows, Keyword: marquee, under construction, hit counter),
//             Buddy List (the crew as buddies, driven by the real crew feed), buddy-icon window (the pixel face lives on),
//             Away Message note (Comic Sans), Win98 taskbar with Start menu, tray and clock.
//   buddies   idle = online, thinking = typing, working = away (+ away message), speaking = sound waves, listening = ear.
//             An agent starting work = door opens; finishing = door closes; a finished job = You've Got Mail! (flag up, splash, chime).
//   IM        a spoken reply is an Instant Message window: red screen name for them, blue for you (your screen name, config.toml [aol] screen_name), sentence by sentence as it is
//             spoken; the face lip-syncs as the buddy icon beside the input box. Voice turns (HEARD/LISTENING/WORKING) show in the
//             same window (mic meter in the input box, "is typing...").
//   windows   the v1.1 click-in windows (keys 1-6 / channel buttons) are drawn by windows.js into an offscreen canvas and re-chromed.
//   sound     all synthesized here (WebAudio, no samples): mail chime, door open/close, IM ding, dial-up. Only while the kiosk
//             speaker is unmuted = the server is armed (same rule as banner.js earcons); ?sfx forces it on a test page.
// All art is drawn by hand below (no Microsoft / AOL bitmaps, logos or fonts; Tahoma-ish system stack with fallbacks).
(function () {
  const W = 512, H = 342, TB = 24;                 // taskbar height
  const UI = 'Tahoma, Verdana, "Microsoft Sans Serif", Geneva, "DejaVu Sans", sans-serif';
  const IMF = 'Arial, Helvetica, "Liberation Sans", sans-serif';
  const COMIC = '"Comic Sans MS", "Chalkboard SE", "Comic Neue", "Marker Felt", cursive';
  const SERIF = '"Times New Roman", Times, serif';
  const MONO = 'Menlo, "Courier New", monospace';
  const uf = (px, b) => `${b ? 'bold ' : ''}${px}px ${UI}`;
  const C = { desk: '#008080', face: '#c0c0c0', lt: '#ffffff', ltg: '#dfdfdf', sh: '#808080', dk: '#000000', t1: '#000080', t2: '#1084d0',
    tin1: '#808080', tin2: '#b5b5b5', red: '#c00000', blue: '#0000c0', note: '#ffffc0', sel: '#000080', link: '#0000a0' };
  const SN = { alfred: 'AlfredTheButler99', scout: 'xXScoutXx', maker: 'MakerBuilds2000' };
  const AG = ['alfred', 'scout', 'maker'];
  // Your screen name: config.toml [aol] screen_name / env RETRO_MAC_SCREEN_NAME, pushed by the server in the websocket
  // `settings` message (settings.screen_name). ?sn=Name previews one on a test page. Neutral until the server says.
  const cleanSN = (v) => { const s = String(v || '').replace(/[^A-Za-z0-9 ]/g, '').replace(/\s+/g, ' ').trim().slice(0, 16); return s.length >= 3 ? s : 'guest'; };
  let ME = cleanSN(new URLSearchParams(location.search).get('sn') || 'guest');
  const SN_URL = new URLSearchParams(location.search).has('sn');
  let _place = '';                                  // weather panel title (config.toml [location].name), learned from the dash feed
  const placeName = () => _place.replace(/\b([A-Z])([A-Z]+)/g, (m, a, b) => a + b.toLowerCase());
  const CHANNELS = [['today', 'Today'], ['weather', 'Weather'], ['crew', 'Crew'], ['house', 'House'], ['alerts', 'Alerts'], ['limits', 'Limits']];
  const CH_TITLE = { today: 'Today Channel', weather: 'Weather Channel', crew: 'AI Crew Channel', house: 'House Channel', alerts: 'Alerts Channel', limits: 'Limits Channel' };
  const AWAY = {
    alfred: ['Polishing the silver. Back in 5 :-)', 'Tea time. Leave a message after the beep', 'Out walking the calendar', 'brb, ironing the schedule'],
    scout: ['~*~ out scouting for leads ~*~', 'gone fishin\' (for data)', 'brb, reading the whole internet', 'AFK: lurking in forums'],
    maker: ['compiling... go outside', 'brb shipping', 'in the workshop, do not disturb', 'rm -rf bugs; be right back'],
  };
  const params = new URLSearchParams(location.search);
  const FORCE_SFX = params.has('sfx');
  const rnd = (a, b) => a + Math.random() * (b - a);
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

  // ------------------------------------------------------------------ pixel art (own drawings)
  const PAL = { k: '#000000', w: '#ffffff', g: '#808080', s: '#c0c0c0', d: '#404040', y: '#ffe040', Y: '#c89000', r: '#e00000', R: '#900000',
    b: '#0000c0', B: '#000080', c: '#40e0e0', G: '#00a000', o: '#ff8800', t: '#008080', n: '#f0d0a0', l: '#1084d0', e: '#e8e8e8', q: '#ffff00' };
  const ART = {
    pal: ['....kkkk....', '...kyyyyk...', '...kykyyk...', '...kyyyyk...', '....kkkk....', '....kyyk....', '...kyyyyk...', '..kyyyyyyk..', '.kyyyyyyyyk.',
      '.kyyyyyyyyk.', 'kyyyyyyyyyyk', 'kkkkkkkkkkkk', '...kk..kk...', '...kk..kk...'],
    note: ['kkkkkk', 'kwwwwk', 'kwkkwk', 'kwwwwk', 'kwkkwk', 'kwwwwk', 'kkkkkk'],
    bubble: ['.kkkkkkkk.', 'kwwwwwwwwk', 'kwkwkwkwwk', 'kwwwwwwwwk', '.kkkkkkkk.', '...kwk....', '...kk.....'],
    waves: ['.....k', '..k..k', '.k.k.k', 'kk.k.k', 'kk.k.k', '.k.k.k', '..k..k', '.....k'],
    ear: ['..kkk.', '.kwwwk', 'kwkkwk', 'kwkwkk', 'kwkkwk', '.kwwk.', '..kk..'],
    runA: ['.......kk.......', '......kyyk......', '......kyyk......', '.....kyyyyk.....', '.....kyykyk.....', '....kyyyyyyk....', '....kyyyyyyk....', '...kyyyyyyyyk...',
      '...kyyyyyyyyk...', '..kyyyyyyyyyyk..', '..kyyyyyyyyyyk..', '.kkkkkkkkkkkkkk.', '....kk....kk....', '...kk......kk...', '..kk........kk..', '.kk..........kk.'],
    runB: ['.......kk.......', '......kyyk......', '......kyyk......', '.....kyyyyk.....', '.....kyykyk.....', '....kyyyyyyk....', '....kyyyyyyk....', '...kyyyyyyyyk...',
      '...kyyyyyyyyk...', '..kyyyyyyyyyyk..', '..kyyyyyyyyyyk..', '.kkkkkkkkkkkkkk.', '.....kk..kk.....', '.....kk..kk.....', '....kk....kk....', '....kk....kk....'],
    mailbox: ['......kkkkkkkkkkkk......', '.....kbbbbbbbbbbbbk.....', '....kbbbbbbbbbbbbbbk....', '...kbbbbbbbbbbbbbbbbk...', '...kbbbbbbbbbbbbbbbbk...',
      '...kbbkkkkkkbbbbbbbbk...', '...kbbkwwwwkbbbbbbbbk...', '...kbbkwwwwkbbbbbbbbk...', '...kbbkkkkkkbbbbbbbbk...', '...kbbbbbbbbbbbbbbbbk...', '...kkkkkkkkkkkkkkkkkk...',
      '.........kYYk...........', '.........kYYk...........', '.........kYYk...........', '.........kYYk...........', '.........kYYk...........', '.........kYYk...........',
      '.......kkkYYkkk.........', '.......kYYYYYYk.........', '.......kkkkkkkk.........'],
    flag: ['kkkkk', 'krrrk', 'krrrk', 'krrrk', 'kkkkk', 'k....', 'k....', 'k....', 'k....', 'k....'],
    env: ['kkkkkkkkkkkkkkkk', 'kwwwwwwwwwwwwwwk', 'kkwwwwwwwwwwwwkk', 'kwkwwwwwwwwwwkwk', 'kwwkwwwwwwwwkwwk', 'kwwwkwwwwwwkwwwk', 'kwwwwkwwwwkwwwwk', 'kwwwwwkkkkwwwwwk',
      'kwwwwwwwwwwwwwwk', 'kwwwwwwwwwwwwwwk', 'kkkkkkkkkkkkkkkk'],
    pc: ['kkkkkkkkkkkkkk..', 'kssssssssssssk..', 'kskkkkkkkkkksk..', 'kskllllllllksk..', 'kskllwlllllksk..', 'kskllllllllksk..', 'kskllllllllksk..', 'kskkkkkkkkkksk..',
      'kssssssssssssk..', 'kkkkkkkkkkkkkk..', '.....kssk.......', '..kkkkkkkkkkk...', '..kssssssssskk..', '..kkkkkkkkkkkk..'],
    modem: ['................', '................', '................', 'kkkkkkkkkkkkkkkk', 'kssssssssssssssk', 'ksGkGkrkssssssk.', 'kskkkkkkkssssssk', 'kssssssssssssssk',
      'kkkkkkkkkkkkkkkk', '.k............k.', '.k............k.', 'kkk..........kkk', '................', '................'],
    globe: ['.....kkkkkk.....', '...kkccccccGk...', '..kccGGcccccck..', '.kccGGGccccGGck.', '.kcGGGcccccGGck.', 'kccGGcccccccGcck', 'kcccccccccGGcccck', 'kcccccGGccGGcccck',
      'kccccGGGGcccccck', 'kcccccGGccccGcck', '.kccccccccGGGck.', '.kcGGccccccGGck.', '..kcGGGcccccck..', '...kkccccccck...', '.....kkkkkk.....', '................'],
    spk: ['...kk.....', '..kkk.....', '.kkkk..k..', 'kkkkk.k.k.', 'kkkkk.k.k.', 'kkkkk.k.k.', '.kkkk..k..', '..kkk.....', '...kk.....'],
    mute: ['k...k', '.k.k.', '..k..', '.k.k.', 'k...k'],
    cal: ['kkkkkkkkkkkk', 'krrrrrrrrrrk', 'krrrrrrrrrrk', 'kkkkkkkkkkkk', 'kwwkwwkwwkwk', 'kwwkwwkwwkwk', 'kkkkkkkkkkkk', 'kwwkwwkwwkwk', 'kwwkwwkwwkwk', 'kkkkkkkkkkkk'],
    sun: ['.....k......', '..k..k..k...', '...kkkkk....', '..kyyyyyk...', 'kkkyyyyykkk.', '..kyyyyyk...', '..kyyyyyk...', '...kkkkk....', '..k..k..k...', '.....k......'],
    house: ['.....kk.....', '....kyyk....', '...kyyyyk...', '..kyyyyyyk..', '.kyyyyyyyyk.', 'kkkkkkkkkkkk', '.krrrrrrrrk.', '.krrkkkrrrk.', '.krrkwkrrrk.', '.kkkkkkkkkk.'],
    bell: ['.....kk.....', '....kyyk....', '...kyyyyk...', '...kyyyyk...', '..kyyyyyyk..', '..kyyyyyyk..', '.kyyyyyyyyk.', 'kkkkkkkkkkkk', '.....kk.....', '....kkkk....'],
    gauge: ['...kkkkkk...', '..kwwwwwwk..', '.kwwwkwwwwk.', 'kwwwwkwwwwwk', 'kwwwwkwwwwwk', 'kwwwwkkkwwwk', 'kwwwwwwwwwwk', 'kkkkkkkkkkkk', '............', '............'],
    crew: ['..kk....kk..', '.kyyk..kyyk.', '.kyyk..kyyk.', '..kk....kk..', '.kyyk..kyyk.', 'kyyyykkyyyyk', 'kkkkkkkkkkkk', '............', '............', '............'],
    cone: ['.....kk.....', '....koo.....', '....kook....', '...kwwwwk...', '...koooo k..', '..kooooook..', '..kwwwwwwk..', '.koooooooo k', 'kkkkkkkkkkkk', '............'],
  };
  const sprCache = new Map();
  function spr(name, scale, map) {                    // sprite -> cached canvas (drawn once, blitted per frame)
    const key = name + '@' + scale + (map ? JSON.stringify(map) : '');
    let cv = sprCache.get(key);
    if (cv) return cv;
    const rows = ART[name], h = rows.length, w = rows[0].length;
    cv = document.createElement('canvas'); cv.width = w * scale; cv.height = h * scale;
    const g = cv.getContext('2d');
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      let ch = rows[y][x]; if (ch === '.' || ch === ' ') continue;
      if (map && map[ch]) ch = map[ch];
      g.fillStyle = PAL[ch] || '#f0f'; g.fillRect(x * scale, y * scale, scale, scale);
    }
    sprCache.set(key, cv);
    return cv;
  }
  const blit = (ctx, name, x, y, scale, map) => { const c = spr(name, scale || 1, map); ctx.drawImage(c, Math.round(x), Math.round(y)); return c; };

  // ------------------------------------------------------------------ Win98 kit
  const px = (ctx, c, x, y, w, h) => { ctx.fillStyle = c; ctx.fillRect(x, y, w, h); };
  function raised(ctx, x, y, w, h, thin) {            // button / window border: light top-left, dark bottom-right
    px(ctx, C.face, x, y, w, h);
    px(ctx, C.lt, x, y, w - 1, 1); px(ctx, C.lt, x, y, 1, h - 1);
    px(ctx, C.dk, x, y + h - 1, w, 1); px(ctx, C.dk, x + w - 1, y, 1, h);
    if (thin) return;
    px(ctx, C.ltg, x + 1, y + 1, w - 3, 1); px(ctx, C.ltg, x + 1, y + 1, 1, h - 3);
    px(ctx, C.sh, x + 1, y + h - 2, w - 2, 1); px(ctx, C.sh, x + w - 2, y + 1, 1, h - 2);
  }
  function sunken(ctx, x, y, w, h, fill) {            // text fields, list boxes
    px(ctx, fill || C.lt, x, y, w, h);
    px(ctx, C.sh, x, y, w, 1); px(ctx, C.sh, x, y, 1, h);
    px(ctx, C.dk, x + 1, y + 1, w - 2, 1); px(ctx, C.dk, x + 1, y + 1, 1, h - 2);
    px(ctx, C.lt, x, y + h - 1, w, 1); px(ctx, C.lt, x + w - 1, y, 1, h);
    px(ctx, C.ltg, x + 1, y + h - 2, w - 2, 1); px(ctx, C.ltg, x + w - 2, y + 1, 1, h - 2);
  }
  function groove(ctx, x, y, w) { px(ctx, C.sh, x, y, w, 1); px(ctx, C.lt, x, y + 1, w, 1); }
  function text(ctx, s, x, y, font, color, base, align) {
    ctx.font = font; ctx.fillStyle = color || C.dk; ctx.textBaseline = base || 'top'; ctx.textAlign = align || 'left';
    ctx.fillText(s, x, y); ctx.textAlign = 'left';
  }
  function fit(ctx, s, maxW, font) {
    s = String(s == null ? '' : s); if (font) ctx.font = font;
    if (ctx.measureText(s).width <= maxW) return s;
    while (s.length > 1 && ctx.measureText(s + '...').width > maxW) s = s.slice(0, -1);
    return s + '...';
  }
  function wrap(ctx, s, maxW, font, firstW) {        // firstW: a narrower first line (the screen name sits in front of it)
    ctx.font = font; const out = []; let cur = '', lim = firstW || maxW;
    for (const w of String(s).split(/\s+/)) { const t = cur ? cur + ' ' + w : w; if (ctx.measureText(t).width > lim && cur) { out.push(cur); cur = w; lim = maxW; } else cur = t; }
    if (cur) out.push(cur); return out;
  }
  // title bar: stepped navy -> blue bands (what a 256-colour box did with that gradient), icon, caption, _ [] X
  function titlebar(ctx, x, y, w, h, title, active, opts) {
    const a = active !== false, c1 = a ? [0, 0, 128] : [128, 128, 128], c2 = a ? [16, 132, 208] : [181, 181, 181];
    const bands = 12, bw = Math.ceil(w / bands);
    for (let i = 0; i < bands; i++) {
      const p = i / (bands - 1);
      px(ctx, `rgb(${Math.round(c1[0] + (c2[0] - c1[0]) * p)},${Math.round(c1[1] + (c2[1] - c1[1]) * p)},${Math.round(c1[2] + (c2[2] - c1[2]) * p)})`, x + i * bw, y, Math.min(bw, w - i * bw), h);
    }
    let tx = x + 4;
    if (opts && opts.icon) { blit(ctx, opts.icon, x + 3, y + 2, 1, opts.iconMap); tx = x + 3 + spr(opts.icon, 1).width + 4; }
    const nb = opts && opts.noButtons ? 0 : (opts && opts.closeOnly ? 1 : 3);
    text(ctx, fit(ctx, title, w - (tx - x) - nb * 17 - 6, uf(11, true)), tx, y + h / 2 + 1, uf(11, true), C.lt, 'middle');
    const bs = 16, by = y + 2, hits = {};
    let bx = x + w - bs - 2;
    const btn = (kind) => {
      raised(ctx, bx, by, bs, h - 4);
      const cx = bx + bs / 2, cy = by + (h - 4) / 2;
      if (kind === 'x') { for (let i = 0; i < 7; i++) { px(ctx, C.dk, cx - 4 + i, cy - 4 + i, 2, 1); px(ctx, C.dk, cx + 2 - i, cy - 4 + i, 2, 1); } }
      else if (kind === 'max') { px(ctx, C.dk, cx - 4, cy - 4, 9, 9); px(ctx, C.face, cx - 3, cy - 2, 7, 6); }
      else px(ctx, C.dk, cx - 3, cy + 2, 6, 2);
      hits[kind] = { x: bx, y: by, w: bs, h: h - 4 };
      bx -= bs;
    };
    if (nb) { btn('x'); if (nb === 3) { bx -= 2; btn('max'); btn('min'); } }
    return hits;
  }
  // a whole window; returns the client rect + the close-box rect
  function win(ctx, r, title, opts) {
    const { x, y, w, h } = r, th = 18;
    raised(ctx, x, y, w, h);
    const hits = titlebar(ctx, x + 3, y + 3, w - 6, th, title, !(opts && opts.inactive), opts);
    const c = { x: x + 3, y: y + 3 + th + 1, w: w - 6, h: h - th - 7 };
    if (opts && opts.client) px(ctx, opts.client, c.x, c.y, c.w, c.h);
    return { c, close: hits.x, rect: r };
  }
  function button(ctx, x, y, w, h, label, opts) {
    const down = opts && opts.down, dflt = opts && opts.dflt;
    ctx.font = uf(11, !!(opts && opts.bold));
    if (dflt) { px(ctx, C.dk, x, y, w, h); x += 1; y += 1; w -= 2; h -= 2; }
    if (down) { px(ctx, C.face, x, y, w, h); px(ctx, C.dk, x, y, w, 1); px(ctx, C.dk, x, y, 1, h); px(ctx, C.sh, x + 1, y + 1, w - 2, 1); px(ctx, C.sh, x + 1, y + 1, 1, h - 2); px(ctx, C.lt, x, y + h - 1, w, 1); px(ctx, C.lt, x + w - 1, y, 1, h); }
    else raised(ctx, x, y, w, h);
    let tx = x + w / 2;
    if (opts && opts.icon) { const c = spr(opts.icon, 1); const iw = c.width; const tw = label ? ctx.measureText(label).width : 0; const sx = x + (w - iw - (label ? tw + 4 : 0)) / 2; ctx.drawImage(c, Math.round(sx) + (down ? 1 : 0), Math.round(y + (h - c.height) / 2) + (down ? 1 : 0)); tx = sx + iw + 4 + tw / 2; }
    if (label) text(ctx, label, Math.round(tx) + (down ? 1 : 0), y + h / 2 + 1 + (down ? 1 : 0), uf(11, !!(opts && opts.bold)), opts && opts.disabled ? C.sh : C.dk, 'middle', 'center');
    return { x, y, w, h };
  }
  const signCache = new Map();
  function stripes(ctx, x, y, w, h) {                  // under-construction tape: yellow / black diagonals (drawn once, then blitted)
    const key = w + 'x' + h; let cv = signCache.get(key);
    if (!cv) {
      cv = document.createElement('canvas'); cv.width = w; cv.height = h; const g = cv.getContext('2d');
      px(g, '#ffd000', 0, 0, w, h); g.fillStyle = C.dk;
      for (let i = -h; i < w + h; i += 12) for (let r = 0; r < h; r++) g.fillRect(i + r, r, 6, 1);
      px(g, C.dk, 0, 0, w, 1); px(g, C.dk, 0, h - 1, w, 1); px(g, C.dk, 0, 0, 1, h); px(g, C.dk, w - 1, 0, 1, h);
      signCache.set(key, cv);
    }
    ctx.drawImage(cv, x, y);
  }

  // ------------------------------------------------------------------ sound (synthesized, nothing sampled)
  let dial = null;
  const sfxLog = [];
  function ac() { return window.RetroFace ? RetroFace.audio() : null; }
  function canSfx() {
    const c = ac(); if (!c || c.state !== 'running') return false;
    if (FORCE_SFX) return true;
    const V = window.RetroBanner ? RetroBanner.state() : null;       // "speaker unmuted" = the server armed replies: he just talked to us
    return !!(V && V.armed);
  }
  const noiseBufs = new WeakMap();
  function noise(c) {
    let b = noiseBufs.get(c); if (b) return b;
    b = c.createBuffer(1, c.sampleRate, c.sampleRate);
    const d = b.getChannelData(0); for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    noiseBufs.set(c, b); return b;
  }
  function osc(c, type, f, t0, t1, g, out, f1) {
    const o = c.createOscillator(), gn = c.createGain();
    o.type = type; o.frequency.setValueAtTime(f, t0); if (f1) o.frequency.linearRampToValueAtTime(f1, t1);
    gn.gain.setValueAtTime(0, t0); gn.gain.linearRampToValueAtTime(g, t0 + 0.008); gn.gain.setValueAtTime(g, Math.max(t0 + 0.008, t1 - 0.02)); gn.gain.linearRampToValueAtTime(0, t1);
    o.connect(gn); gn.connect(out); o.start(t0); o.stop(t1 + 0.02); return o;
  }
  function bell(c, f, t0, dur, g, out) {               // sine + soft octave, exponential decay: a cheerful mail chime note
    for (const [m, gg] of [[1, g], [2, g * 0.25], [3, g * 0.08]]) {
      const o = c.createOscillator(), gn = c.createGain();
      o.type = 'sine'; o.frequency.value = f * m;
      gn.gain.setValueAtTime(gg, t0); gn.gain.exponentialRampToValueAtTime(0.0005, t0 + dur);
      o.connect(gn); gn.connect(out); o.start(t0); o.stop(t0 + dur + 0.02);
    }
  }
  function hiss(c, t0, t1, g, out, lo, hi, q) {
    const s = c.createBufferSource(), gn = c.createGain(), bp = c.createBiquadFilter();
    s.buffer = noise(c); s.loop = true; bp.type = 'bandpass'; bp.frequency.setValueAtTime(lo, t0); bp.frequency.linearRampToValueAtTime(hi, t1); bp.Q.value = q || 0.7;
    gn.gain.setValueAtTime(0, t0); gn.gain.linearRampToValueAtTime(g, t0 + 0.02); gn.gain.setValueAtTime(g, t1 - 0.03); gn.gain.linearRampToValueAtTime(0, t1);
    s.connect(bp); bp.connect(gn); gn.connect(out); s.start(t0); s.stop(t1 + 0.02); return s;
  }
  const SFX = {
    mail(c, t, out) { let f = 0; for (const n of [784, 988, 1175, 1568]) { bell(c, n, t + f, 0.9, 0.07, out); f += 0.11; } bell(c, 2349, t + 0.5, 1.2, 0.05, out); },
    im(c, t, out) { osc(c, 'sine', 1046, t, t + 0.07, 0.05, out); osc(c, 'sine', 1318, t + 0.09, t + 0.17, 0.05, out); },
    door(c, t, out) { osc(c, 'sawtooth', 95, t, t + 0.32, 0.03, out, 210); hiss(c, t, t + 0.3, 0.02, out, 900, 2400, 2); },
    close(c, t, out) { hiss(c, t, t + 0.08, 0.08, out, 200, 120, 0.5); osc(c, 'sine', 90, t, t + 0.2, 0.09, out, 45); },
    dial(c, t, out) {                                  // 0.5 s dial tone, 7 DTMF digits, answer tone, FSK warble, training hiss, "connected" chord
      osc(c, 'sine', 350, t, t + 0.5, 0.03, out); osc(c, 'sine', 440, t, t + 0.5, 0.03, out);
      const dt = [[697, 1209], [852, 1477], [852, 1477], [852, 1477], [770, 1336], [941, 1336], [697, 1336]];   // "1-9-9-9-5-0-2"
      let tt = t + 0.6;
      for (const [lo, hi] of dt) { osc(c, 'sine', lo, tt, tt + 0.08, 0.035, out); osc(c, 'sine', hi, tt, tt + 0.08, 0.035, out); tt += 0.13; }
      tt += 0.35;
      osc(c, 'sine', 2100, tt, tt + 0.45, 0.03, out); tt += 0.5;
      for (let i = 0; i < 10; i++) { osc(c, 'square', i & 1 ? 1200 : 2250, tt, tt + 0.06, 0.012, out); tt += 0.07; }
      hiss(c, tt, tt + 0.9, 0.05, out, 600, 3200, 0.5); osc(c, 'sine', 1800, tt + 0.2, tt + 0.9, 0.012, out, 2600); tt += 0.95;
      bell(c, 523, tt, 0.5, 0.05, out); bell(c, 659, tt + 0.08, 0.5, 0.05, out); bell(c, 784, tt + 0.16, 0.7, 0.05, out);
      return tt + 0.8 - t;
    },
  };
  function sfx(kind) {
    const c = ac(), ok = canSfx();
    sfxLog.push({ kind, at: Date.now(), played: ok }); if (sfxLog.length > 40) sfxLog.shift();
    if (!ok) return 0;
    const out = c.createGain(); out.gain.value = 1; out.connect(c.destination);
    const len = SFX[kind](c, c.currentTime + 0.02, out) || 1.5;
    if (kind === 'dial') { if (dial) dial.stop(); dial = { stop() { try { out.gain.setTargetAtTime(0, c.currentTime, 0.03); setTimeout(() => out.disconnect(), 200); } catch (e) {} dial = null; } }; setTimeout(() => { if (dial) dial.stop(); }, len * 1000 + 300); }
    return len;
  }

  // ------------------------------------------------------------------ state
  const A = { on: false, phase: 'off', phaseAt: 0, lastFrame: 0, busyUntil: 0, step: 0,
    buddies: {}, doors: [], im: null, imN: 0, mail: { items: [], unread: 0, splash: null, box: false, seenLast: {} },
    hits: 1337, menu: false, info: null, away: { agent: 'alfred', text: '', at: 0 }, click: [], toast: null, hour: 12,
    welcomeFlash: 0, lastCrewKey: '' };
  for (const a of AG) A.buddies[a] = { status: 'idle', label: '', since: 0, flashAt: 0, busy: false, seenAt: 0 };
  const faceCv = document.createElement('canvas'); faceCv.width = W; faceCv.height = H;
  const fctx = faceCv.getContext('2d');
  const winCv = document.createElement('canvas'); winCv.width = W; winCv.height = H;
  const wctx = winCv.getContext('2d');
  const FACE_SRC = { x: 96, y: 56, w: 320, h: 240 };                 // the face without its name label, 4:3
  let deactivateTimer = 0;

  function activate(t, api) {
    A.on = true; A.phase = 'signon'; A.phaseAt = t; A.step = 0; A.menu = false; A.info = null; A.toast = null; A.api = api || A.api;
    const tb = document.getElementById('tonebox'); if (tb) tb.style.display = 'none';
    clearInterval(deactivateTimer);
    deactivateTimer = setInterval(() => { if (A.on && A.api && A.api.theme() !== 'aol') deactivate(); }, 700);   // theme moved on (T key / settings)
  }
  function deactivate() {                                            // theme moved on: stop sounds, show the slider again, forget the boot
    A.on = false; A.phase = 'off'; if (dial) dial.stop();
    const tb = document.getElementById('tonebox'); if (tb) tb.style.display = '';
    clearInterval(deactivateTimer);
  }
  function enterDesktop(t) { A.phase = 'desktop'; A.phaseAt = t; A.busyUntil = t + 600; if (dial) dial.stop(); A.toast = { text: 'Welcome!', at: t, until: t + 2600 }; }
  function skipBoot(t) { if (A.phase === 'signon' || A.phase === 'connect') enterDesktop(t); }

  // crew feed -> buddy states, doors, mail
  function crewTick(t, api) {
    const crew = api.S.crew; if (!crew) return;
    for (const a of AG) {
      const c = crew[a] || { status: 'idle', label: '' }, b = A.buddies[a];
      const busy = c.status === 'working' || c.status === 'thinking';
      if (busy && !b.busy) { A.doors.push({ kind: 'open', agent: a, at: t }); b.flashAt = t; b.since = t; sfx('door'); A.busyUntil = t + 700; }
      else if (!busy && b.busy) { A.doors.push({ kind: 'close', agent: a, at: t }); b.flashAt = t; sfx('close'); A.busyUntil = t + 700; }
      b.busy = busy; b.status = c.status || 'idle'; b.label = c.label || '';
      if (b.status !== 'idle') b.seenAt = t;
      const last = c.last;                                           // server-side "last completed activity": the real job-finished signal
      if (last && last.at && A.mail.seenLast[a] !== last.at) {
        const first = !(a in A.mail.seenLast);
        A.mail.seenLast[a] = last.at;
        // a plain spoken reply ("REPLIED") is the IM itself, not mail; the first value seen is history from before this page loaded
        if (last.label && last.label !== 'REPLIED' && (!first || (A.phase === 'desktop' && t - A.phaseAt > 3000))) gotMail(t, a, last);
      }
    }
    if (A.doors.length > 8) A.doors.splice(0, A.doors.length - 8);
    if (A.mail.pending && !api.speechActive()) { A.mail.splash = { ...A.mail.pending, at: t, until: t + 9000 }; A.mail.pending = null; A.busyUntil = t + 800; setTimeout(() => sfx('mail'), 350); }
  }
  function gotMail(t, agent, last) {
    const subj = `Re: ${String(last.label || 'JOB').trim()}` + (last.took ? ` (took ${fmtTook(last.took)})` : '');
    A.mail.items.unshift({ from: SN[agent], agent, subject: subj, at: new Date(), read: false });
    if (A.mail.items.length > 12) A.mail.items.pop();
    A.mail.unread++; A.hits++;
    if (A.api && A.api.speechActive()) { A.mail.pending = { agent, subject: subj }; return; }   // never over an IM mid-sentence: right after it
    A.mail.splash = { at: t, until: t + 9000, agent, subject: subj };
    A.busyUntil = t + 800;
    setTimeout(() => sfx('mail'), 350);
  }
  const fmtTook = (s) => (s >= 90 ? `${Math.round(s / 60)} min` : `${s}s`);

  // speech + voice turn -> the IM window
  function openIM(t, agent) {
    if (A.im && A.im.agent === agent) { A.im.closeAt = 0; return A.im; }
    A.im = { agent, lines: [], at: t, closeAt: 0, seen: new Set(), cardSeen: null, replyId: 0 };
    A.imN++; A.hits++; A.busyUntil = t + 500;
    return A.im;
  }
  function imLine(who, s, kind) { const im = A.im; if (!im) return; im.lines.push({ who, text: String(s), kind: kind || '' }); if (im.lines.length > 40) im.lines.shift(); }
  // Seen speech entries: a WeakSet, so a finished sentence (its base64 WAV + decoded AudioBuffer) is freed the moment
  // face.js drops it. A plain Set pinned up to 200 entries (~70 KB base64 + ~90 KB PCM each) between resets: +8 MB per
  // 120 sentences on the kiosk's weak Mac, measured with tools/memtest.py.
  A.imSeen = new WeakSet();
  function speechTick(t, api) {
    const S = api.S, e = api.cur();
    if (e && e.msg && !A.imSeen.has(e)) {
      const m = e.msg, agent = AG.includes(m.agent) ? m.agent : S.agent;
      const id = m.stream ? +m.stream.id || 0 : 0, firstOfReply = !m.stream || !m.stream.seq;
      if (!A.im || A.im.agent !== agent || (firstOfReply && A.im.replyId !== id)) { openIM(t, agent); if (!A.im.lines.length || firstOfReply) sfx('im'); }
      A.im.replyId = id;
      if (m.text && !m.progress) imLine('them', m.text);
      else if (m.text && m.progress) imLine('them', m.text, 'progress');
      A.imSeen.add(e);
    }
    if (S.card && A.im && A.im.cardSeen !== S.card) {               // the reply's card (list / rows / number / text) as IM lines
      A.im.cardSeen = S.card; const c = S.card;
      if (c.type === 'list') (c.items || []).forEach(s => imLine('them', '- ' + s, 'card'));
      else if (c.type === 'rows') (c.rows || []).forEach(r => imLine('them', `${r.k}: ${r.v}`, 'card'));
      else if (c.type === 'number') imLine('them', `${c.title || ''}: ${c.value ?? ''} ${c.unit || ''} ${c.sub || ''}`.trim(), 'card');
      else if (c.body) imLine('them', String(c.body), 'card');
    }
    const V = window.RetroBanner ? RetroBanner.state() : { state: 'idle' };
    const vs = V.state, tr = V.turn;
    if (['heard', 'listening', 'transcribing', 'working'].includes(vs)) {
      if (!A.im) openIM(t, 'alfred');
      if (tr && tr.text && A.im && A.im.meText !== tr.text) { A.im.meText = tr.text; imLine('me', tr.text); }
    }
    if (vs !== A.lastVs) {
      if (vs === 'error' && A.im) imLine('sys', (V.note || 'Didn\'t catch that. Tap Space and try again.').toLowerCase());
      else if (vs === 'failed' && A.im) imLine('sys', (V.note || 'something went wrong, try again in a minute').toLowerCase());
      else if (vs === 'stopped' && A.im) imLine('sys', 'stopped');
      A.lastVs = vs; A.busyUntil = t + 400;
    }
    const active = api.speechActive() || ['heard', 'listening', 'transcribing', 'working'].includes(vs);
    if (A.im) { if (active) A.im.closeAt = 0; else if (!A.im.closeAt) A.im.closeAt = t + 15000; else if (t > A.im.closeAt) A.im = null; }
  }
  function awayTick(t, api) {
    const busyAgent = AG.find(a => A.buddies[a].busy);
    if (busyAgent) { const b = A.buddies[busyAgent]; A.away = { agent: busyAgent, text: `brb -- ${(b.label || b.status).toLowerCase()}`, at: t, busy: true }; return; }
    if (!A.away.text || A.away.busy || t - A.away.at > 60000) {
      const agent = api.S.agent in AWAY ? api.S.agent : 'alfred', list = AWAY[agent];
      A.away = { agent, text: list[Math.floor(Math.random() * list.length)], at: t, busy: false };
    }
  }

  // ------------------------------------------------------------------ frame
  function frame(ctx, t, api) {
    if (!A.on) activate(t, api);
    A.lastFrame = t; A.click = [];
    const hr = api.hour(t); A.hour = hr;
    { const wx = api.dash().weather; _place = String((wx && wx.place) || ''); }
    if (A.phase === 'signon' && t - A.phaseAt > 1700) { A.phase = 'connect'; A.phaseAt = t; A.step = 0; sfx('dial'); }
    if (A.phase === 'connect') { A.step = Math.min(3, Math.floor((t - A.phaseAt) / 1150)); if (t - A.phaseAt > 4300) enterDesktop(t); }
    crewTick(t, api); speechTick(t, api); awayTick(t, api);
    if (api.speechActive() || api.S.playing) skipBoot(t);           // a reply never waits for the modem
    if (A.phase !== 'desktop') { px(ctx, C.desk, 0, 0, W, H); drawBoot(ctx, t); taskbar(ctx, t, api); return; }
    // 1) the pixel face, full size, into the offscreen canvas (face.js draws on the main canvas; copy it off before the desktop goes on top)
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, W, H);
    api.drawFace(t, 0);
    fctx.clearRect(0, 0, W, H); fctx.drawImage(api.canvas, 0, 0);
    // 2) desktop
    px(ctx, C.desk, 0, 0, W, H);
    drawWelcome(ctx, t, api);
    drawBuddyList(ctx, t, api);
    drawFaceWin(ctx, t, api);
    drawAwayNote(ctx, t);
    if (A.info) drawInfo(ctx, t, api);
    if (A.im) drawIM(ctx, t, api);
    drawRetroWin(ctx, t, api);
    if (A.mail.box) drawMailbox(ctx, t);
    if (A.mail.splash) drawMailSplash(ctx, t);
    if (A.toast && t < A.toast.until) drawToast(ctx, t); else A.toast = null;
    taskbar(ctx, t, api);
    if (A.menu) drawStartMenu(ctx, t, api);
  }
  const hit = (r, fn, name) => { if (r) A.click.push({ ...r, fn, name }); };

  function clockText() {
    const h = Math.floor(A.hour) % 24, m = Math.round((A.hour - Math.floor(A.hour)) * 60) % 60;
    return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
  }
  function taskbar(ctx, t, api) {
    const y = H - TB;
    px(ctx, C.face, 0, y, W, TB); px(ctx, C.lt, 0, y + 1, W, 1); px(ctx, C.ltg, 0, y, W, 1);
    // Start
    const sb = button(ctx, 2, y + 4, 54, 18, 'Start', { down: A.menu, bold: true, icon: 'pal' });
    hit(sb, (tt) => { A.menu = !A.menu; A.busyUntil = tt + 300; }, 'start');
    px(ctx, C.sh, 60, y + 4, 1, 18); px(ctx, C.lt, 61, y + 4, 1, 18);
    // task buttons
    const tasks = A.phase === 'desktop' ? [[`Welcome, ${ME}!`, 'env', !A.im], ['Buddy List', 'pal', false]] : [['Sign On', 'pal', true]];
    if (A.im) tasks.push([`${SN[A.im.agent]} - Instant Message`, 'bubble', true, api.speechActive() && Math.floor(t / 500) % 2 === 0]);
    const rwKey = window.RetroWin && RetroWin.key(); if (rwKey) tasks.push([CH_TITLE[rwKey] || rwKey, 'globe', true]);
    if (A.mail.box || A.mail.splash) tasks.push(['Mailbox', 'env', !!A.mail.box]);
    // theme switcher: a "Mac" button beside the tray (every phase, boot included) = back to the v1 look that was on before
    const tw = 92, tx = W - tw - 4, MACW = 50, macX = tx - MACW - 6;
    const mb = button(ctx, macX, y + 4, MACW, 18, 'Mac', { icon: 'pc' });
    hit(mb, (tt) => { A.busyUntil = tt + 300; if (api.switchSkin) api.switchSkin(false); }, 'mac');
    px(ctx, C.sh, macX - 4, y + 4, 1, 18); px(ctx, C.lt, macX - 3, y + 4, 1, 18);
    const avail = macX - 8 - 66, bw = Math.min(150, Math.floor(avail / tasks.length) - 3);
    let x = 66;
    for (const [label, icon, active, flash] of tasks) {
      ctx.font = uf(11, false); const l = fit(ctx, label, bw - 24);
      button(ctx, x, y + 4, bw, 18, l, { down: active, bold: active, icon });
      if (flash) { px(ctx, C.t1, x + 2, y + 6, bw - 4, 14); text(ctx, l, x + 20, y + 14, uf(11, true), C.lt, 'middle'); }
      x += bw + 3;
    }
    // tray: speaker (muted = red x), modem lights, clock
    sunken(ctx, tx, y + 4, tw, 18, C.face);
    blit(ctx, 'spk', tx + 5, y + 8);
    if (!canSfx()) blit(ctx, 'mute', tx + 12, y + 10, 1, { k: 'r' });
    const lit = api.speechActive() || (window.RetroBanner && RetroBanner.active());
    px(ctx, C.dk, tx + 24, y + 8, 10, 10); px(ctx, lit && Math.floor(t / 90) % 3 === 0 ? '#00ff00' : '#004000', tx + 26, y + 10, 2, 2); px(ctx, lit && Math.floor(t / 130) % 2 === 0 ? '#00ff00' : '#004000', tx + 30, y + 10, 2, 2);
    px(ctx, A.phase === 'desktop' ? '#00ff00' : '#004000', tx + 26, y + 14, 6, 2);
    text(ctx, clockText(), tx + tw - 6, y + 14, uf(11), C.dk, 'middle', 'right');
  }
  function drawToast(ctx, t) {
    const p = clamp((t - A.toast.at) / 250, 0, 1), w = 150, h = 54, x = (W - w) / 2, y = 120;
    if (p < 1 && Math.floor(t / 60) % 2) return;                     // a quick flicker as it pops, 1999 style
    raised(ctx, x, y, w, h);
    blit(ctx, 'runA', x + 10, y + 12, 2);
    text(ctx, A.toast.text, x + 52, y + 22, `bold 20px ${SERIF}`, C.t1, 'middle');
    text(ctx, 'to Retro Online', x + 52, y + 40, uf(10), C.dk, 'middle');
  }

  // ------------------------------------------------------------------ boot
  function drawBoot(ctx, t) {
    const f = Math.floor(t / 140) % 2;
    if (A.phase === 'signon') {
      const r = { x: 116, y: 56, w: 280, h: 196 }, { c } = win(ctx, r, 'Sign On', { icon: 'pal', client: C.face });
      text(ctx, 'Retro Online', c.x + 60, c.y + 8, `bold 22px ${SERIF}`, C.t1);
      text(ctx, 'v4.0' + (placeName() ? '  -  ' + placeName() : ''), c.x + 60, c.y + 32, uf(10), C.sh);
      blit(ctx, f ? 'runA' : 'runB', c.x + 14, c.y + 8, 2);
      const lx = c.x + 14, fx = c.x + 118, fw = c.w - 132;
      text(ctx, 'Select Screen Name:', lx, c.y + 56, uf(11)); sunken(ctx, fx, c.y + 52, fw, 18); text(ctx, ME, fx + 5, c.y + 61, uf(11), C.dk, 'middle'); combo(ctx, fx + fw - 17, c.y + 53);
      text(ctx, 'Enter Password:', lx, c.y + 80, uf(11)); sunken(ctx, fx, c.y + 76, fw, 18); text(ctx, '********', fx + 5, c.y + 85, uf(11), C.dk, 'middle');
      text(ctx, 'Select Location:', lx, c.y + 104, uf(11)); sunken(ctx, fx, c.y + 100, fw, 18); text(ctx, 'Home - 56K modem', fx + 5, c.y + 109, uf(11), C.dk, 'middle'); combo(ctx, fx + fw - 17, c.y + 101);
      button(ctx, c.x + 10, c.y + 136, 52, 22, 'Setup'); button(ctx, c.x + 66, c.y + 136, 52, 22, 'Help');
      button(ctx, c.x + c.w - 92, c.y + 134, 82, 26, 'SIGN ON', { dflt: true, bold: true, down: t - A.phaseAt > 1300 });
      return;
    }
    const r = { x: 96, y: 48, w: 320, h: 218 }, { c } = win(ctx, r, 'Connecting to Retro Online', { icon: 'globe', client: C.face });
    const steps = ['Step 1: Initializing modem...', 'Step 2: Dialing 1-999-502-RETRO', 'Step 3: Connecting to the crew...', 'Checking password... Welcome!'];
    const icons = ['pc', 'modem', 'globe'], ix = [c.x + 40, c.x + c.w / 2 - 8, c.x + c.w - 56];
    icons.forEach((n, i) => { blit(ctx, n, ix[i], c.y + 14, 2); if (A.step > i || (A.step === i && Math.floor(t / 250) % 2)) px(ctx, '#00c000', ix[i] + 10, c.y + 48, 12, 3); });
    px(ctx, C.sh, c.x + 20, c.y + 56, c.w - 40, 1); px(ctx, C.lt, c.x + 20, c.y + 57, c.w - 40, 1);
    const p = clamp((t - A.phaseAt) / 4300, 0, 1);
    blit(ctx, f ? 'runA' : 'runB', c.x + 20 + p * (c.w - 72), c.y + 40, 1);
    for (let i = 0; i < 4; i++) {
      const done = i < A.step, cur = i === A.step;
      text(ctx, (done ? '\u2713 ' : cur ? '> ' : '   ') + steps[i], c.x + 22, c.y + 70 + i * 16, uf(11, cur), done ? C.sh : C.dk);
    }
    sunken(ctx, c.x + 22, c.y + 142, c.w - 44, 16);
    const segs = Math.floor(p * 22); for (let i = 0; i < segs; i++) px(ctx, C.t1, c.x + 25 + i * 12, c.y + 145, 10, 10);
    button(ctx, c.x + c.w / 2 - 36, c.y + 166, 72, 22, 'Cancel');
    text(ctx, 'press any key to skip', c.x + c.w - 8, c.y + 177, uf(9), C.sh, 'middle', 'right');
  }
  function combo(ctx, x, y) { raised(ctx, x, y, 16, 16); for (let i = 0; i < 4; i++) px(ctx, C.dk, x + 4 + i, y + 6 + i, 8 - 2 * i, 1); }

  // ------------------------------------------------------------------ welcome window
  let marqueeX = 0, marqueeAt = 0;
  function marqueeText(api) {
    const d = api.dash(), wx = d.weather, parts = [];
    if (wx) parts.push(`${placeName() || 'Weather'}: ${wx.temp}\u00b0 ${wx.cond}, feels ${wx.feels}, wind ${wx.wind} mph, hi ${wx.hi} lo ${wx.lo}`);
    const ag = (d.agenda || []).filter(r => !r.x && r.k !== 'none').slice(0, 5).map(r => (r.t ? r.t + ' ' : '') + r.title);
    if (ag.length) parts.push('Today: ' + ag.join(' / '));
    const on = AG.filter(a => A.buddies[a].busy).map(a => `${SN[a]} is ${A.buddies[a].label.toLowerCase() || A.buddies[a].status}`);
    if (on.length) parts.push(on.join(', '));
    return parts.length ? parts.join('   ***   ') : 'Welcome to Retro Online. You are visitor number ' + String(A.hits).padStart(6, '0') + '.';
  }
  function drawWelcome(ctx, t, api) {
    const r = { x: 4, y: 4, w: 300, h: 198 }, { c, close } = win(ctx, r, `Welcome, ${ME}!`, { icon: 'env', client: C.face, inactive: !!A.im });
    hit(close, () => {}, 'welcome-x');
    // toolbar
    let bx = c.x + 4;
    for (const [l, ic, fn] of [['Read', 'env', () => { A.mail.box = true; }], ['Write', 'bubble', () => { A.info = { kind: 'write' }; }], ['Channels', 'globe', () => { if (window.RetroWin) RetroWin.open('today', null, performance.now()); }], ['People', 'crew', () => { A.info = { kind: 'buddy', agent: api.S.agent }; }]]) {
      ctx.font = uf(10); const w = ctx.measureText(l).width + 26;
      hit(button(ctx, bx, c.y + 3, w, 20, l, { icon: ic }), fn, l); bx += w + 2;
    }
    groove(ctx, c.x + 2, c.y + 26, c.w - 4);
    // mailbox
    const mx = c.x + 14, my = c.y + 36, up = A.mail.unread > 0;
    const flagged = up && Math.floor(t / 400) % 2 === 0;
    blit(ctx, 'mailbox', mx, my, 2); if (up) blit(ctx, 'flag', mx + 36, my - 6, 2);
    text(ctx, up ? 'You Have Mail!' : 'No New Mail', mx + 26, my + 48, `bold 13px ${SERIF}`, up ? C.red : C.t1, 'top', 'center');
    if (up) text(ctx, `${A.mail.unread} new`, mx + 26, my + 63, uf(10), flagged ? C.red : C.dk, 'top', 'center');
    hit({ x: mx - 6, y: my - 8, w: 68, h: 84 }, () => { A.mail.box = true; A.mail.splash = null; }, 'mailbox');
    // channels
    const gx = c.x + 96, gy = c.y + 34, cw = 62, chh = 26;
    text(ctx, 'Channels', gx, gy - 3, `bold 12px ${SERIF}`, C.t1);
    CHANNELS.forEach(([key, label], i) => {
      const x = gx + (i % 3) * (cw + 4), y = gy + 12 + Math.floor(i / 3) * (chh + 4);
      const icon = { today: 'cal', weather: 'sun', crew: 'crew', house: 'house', alerts: 'bell', limits: 'gauge' }[key];
      const open = window.RetroWin && RetroWin.key() === key;
      hit(button(ctx, x, y, cw, chh, label, { icon, down: open }), (tt) => { if (window.RetroWin) RetroWin.toggle(key, null, tt); A.busyUntil = tt + 300; }, 'ch-' + key);
    });
    // keyword bar with a marquee
    const ky = c.y + 106;
    text(ctx, 'Keyword:', c.x + 6, ky + 9, uf(11, true), C.dk, 'middle');
    const kx = c.x + 58, kw = c.w - 58 - 40;
    sunken(ctx, kx, ky, kw, 18);
    const s = marqueeText(api); ctx.font = uf(11); const sw = ctx.measureText(s).width + 60;
    if (t - marqueeAt > 40) { marqueeX = (marqueeX + Math.round((t - marqueeAt) / 40)) % Math.max(1, Math.round(sw)); marqueeAt = t; }
    ctx.save(); ctx.beginPath(); ctx.rect(kx + 2, ky + 2, kw - 4, 14); ctx.clip();
    text(ctx, s, kx + kw - marqueeX, ky + 10, uf(11), C.link, 'middle'); text(ctx, s, kx + kw - marqueeX + sw, ky + 10, uf(11), C.link, 'middle');
    ctx.restore();
    hit(button(ctx, kx + kw + 4, ky - 1, 32, 20, 'Go'), () => { A.toast = { text: 'Keyword:', at: performance.now(), until: performance.now() + 1500 }; }, 'go');
    // under construction + hit counter + "new" badge
    const uy = c.y + 132;
    stripes(ctx, c.x + 6, uy, 118, 12);
    text(ctx, 'UNDER CONSTRUCTION', c.x + 65, uy + 6, `bold 8px ${UI}`, C.dk, 'middle', 'center');
    blit(ctx, 'cone', c.x + 126, uy - 1);
    text(ctx, 'You are visitor number:', c.x + 150, uy + 6, uf(9), C.dk, 'middle');
    const digits = String(A.hits).padStart(6, '0'), dx = c.x + 150, dy = uy + 14;
    px(ctx, C.dk, dx, dy, 6 * 13 + 2, 16);
    for (let i = 0; i < 6; i++) { px(ctx, '#202020', dx + 2 + i * 13, dy + 2, 11, 12); text(ctx, digits[i], dx + 7 + i * 13, dy + 9, `bold 12px ${MONO}`, '#f8f8f8', 'middle', 'center'); }
    text(ctx, 'Best viewed in 800x600', c.x + 6, uy + 20, uf(9), C.sh);
    if (Math.floor(t / 450) % 2 === 0) text(ctx, 'NEW!', c.x + 112, uy + 24, `bold 11px ${COMIC}`, C.red, 'middle');
    text(ctx, `\u00a9 1999 ${ME}. All rights reserved.`, c.x + c.w - 6, uy + 44, uf(8), C.sh, 'middle', 'right');
  }

  // ------------------------------------------------------------------ buddy list
  function buddyIcon(ctx, a, x, y, t) {
    const b = A.buddies[a], f = Math.floor(t / 300);
    const map = b.status === 'idle' && t - b.seenAt > 20 * 60e3 && b.seenAt ? { y: 's', Y: 'g' } : null;    // 20 min quiet = "idle" grey
    blit(ctx, 'pal', x, y, 1, map);
    if (b.status === 'working') blit(ctx, 'note', x + 9, y - 2);
    else if (b.status === 'thinking') { if (f % 3 !== 2) blit(ctx, 'bubble', x + 8, y - 5); }
    else if (b.status === 'speaking') blit(ctx, 'waves', x + 12, y + 2);
    else if (b.status === 'listening') blit(ctx, 'ear', x + 11, y);
  }
  function buddySuffix(a, t) {
    const b = A.buddies[a];
    if (b.status === 'working') return '(Away)';
    if (b.status === 'thinking') return '(typing...)';
    if (b.status === 'speaking') return '(IM)';
    if (b.status === 'listening') return '(listening)';
    const idleMin = b.seenAt ? Math.floor((t - b.seenAt) / 60000) : 0;
    return idleMin >= 20 ? `(${idleMin}m idle)` : '';
  }
  function drawBuddyList(ctx, t, api) {
    const r = { x: 312, y: 4, w: 196, h: 314 - 4 }, { c, close } = win(ctx, r, `${ME}'s Buddy List`, { icon: 'pal', client: C.face, inactive: !!A.im, closeOnly: true });   // closeOnly: the long screen name needs the room
    hit(close, () => {}, 'buddy-x');
    // tabs
    const ty = c.y + 2;
    raised(ctx, c.x + 2, ty, 54, 16); text(ctx, 'Online', c.x + 29, ty + 9, uf(10, true), C.dk, 'middle', 'center');
    raised(ctx, c.x + 56, ty + 2, 64, 14); text(ctx, 'List Setup', c.x + 88, ty + 10, uf(10), C.dk, 'middle', 'center');
    const lx = c.x + 2, ly = ty + 17, lw = c.w - 4, lh = c.h - 19 - 30;
    sunken(ctx, lx, ly, lw, lh);
    let y = ly + 6;
    const nOn = AG.length, nBusy = AG.filter(a => A.buddies[a].busy).length;
    tri(ctx, lx + 6, y + 3, true); text(ctx, `AI Crew (${nOn}/${nOn})`, lx + 16, y, uf(11, true), C.dk);
    y += 16;
    const speaking = api.S.playing ? api.S.agent : null;
    for (const a of AG) {
      const b = A.buddies[a], flash = t - b.flashAt < 900 && Math.floor(t / 150) % 2 === 0;
      if (speaking === a) b.status = 'speaking';
      const row = { x: lx + 4, y: y - 2, w: lw - 8, h: 17 }, sel = A.info && A.info.kind === 'buddy' && A.info.agent === a;
      if (flash || sel) { px(ctx, C.sel, row.x, row.y, row.w, row.h); }
      buddyIcon(ctx, a, lx + 10, y, t);
      const col = flash || sel ? C.lt : b.busy ? C.red : C.dk;
      ctx.font = uf(11, b.busy); const name = SN[a]; text(ctx, name, lx + 30, y + 1, uf(11, b.busy), col);
      const suf = buddySuffix(a, t); if (suf) text(ctx, suf, lx + 30 + ctx.measureText(name).width + 5, y + 2, uf(9), flash || sel ? C.lt : C.sh);
      hit(row, () => { A.info = { kind: 'buddy', agent: a }; A.busyUntil = performance.now() + 300; }, 'buddy-' + a);
      y += 17;
    }
    y += 4; tri(ctx, lx + 6, y + 3, false); text(ctx, 'Offline (0/0)', lx + 16, y, uf(11, true), C.sh); y += 16;
    tri(ctx, lx + 6, y + 3, false); text(ctx, 'Family (0/0)', lx + 16, y, uf(11, true), C.sh); y += 16;
    tri(ctx, lx + 6, y + 3, false); text(ctx, 'Co-Workers (0/0)', lx + 16, y, uf(11, true), C.sh); y += 20;
    // doors log: the last few comings and goings
    groove(ctx, lx + 6, y, lw - 12); y += 5;
    const recent = A.doors.slice(-4).reverse();
    if (!recent.length) text(ctx, nBusy ? '' : 'Everyone is online :-)', lx + 8, y, uf(9), C.sh);
    for (const d of recent) {
      const age = Math.round((t - d.at) / 1000), ago = age < 60 ? `${age}s ago` : `${Math.round(age / 60)}m ago`;
      text(ctx, fit(ctx, `${d.kind === 'open' ? '\u25ba' : '\u25c4'} ${SN[d.agent]} ${d.kind === 'open' ? 'went to work' : 'is back'}  ${ago}`, lw - 20, uf(9)), lx + 8, y, uf(9), d.kind === 'open' ? C.t1 : C.sh);
      y += 12; if (y > ly + lh - 14) break;
    }
    // buttons
    const by = ly + lh + 5, bw = Math.floor((lw - 8) / 3);
    hit(button(ctx, lx + 2, by, bw, 22, 'IM', { icon: 'bubble' }), (tt) => { openIM(tt, api.S.agent); imLine('sys', `(say something: tap Space)`); }, 'im');
    hit(button(ctx, lx + 4 + bw, by, bw, 22, 'Info'), () => { A.info = { kind: 'buddy', agent: api.S.agent }; }, 'info');
    hit(button(ctx, lx + 6 + bw * 2, by, bw, 22, 'Setup'), () => { A.toast = { text: 'Setup', at: performance.now(), until: performance.now() + 1500 }; }, 'setup');
  }
  function tri(ctx, x, y, open) { if (open) for (let i = 0; i < 4; i++) px(ctx, C.dk, x + i, y + i, 7 - 2 * i, 1); else for (let i = 0; i < 4; i++) px(ctx, C.dk, x + i, y + i, 1, 7 - 2 * i); }

  // ------------------------------------------------------------------ face window, away note, info
  function faceInto(ctx, x, y, w, h) {                               // the live pixel face, pixel-scaled (no smoothing), on a white plate, 4:3 kept
    sunken(ctx, x, y, w, h, C.lt);
    const sm = ctx.imageSmoothingEnabled; ctx.imageSmoothingEnabled = false;
    const k = Math.min((w - 4) / FACE_SRC.w, (h - 4) / FACE_SRC.h), dw = Math.round(FACE_SRC.w * k), dh = Math.round(FACE_SRC.h * k);
    ctx.drawImage(faceCv, FACE_SRC.x, FACE_SRC.y, FACE_SRC.w, FACE_SRC.h, x + Math.round((w - dw) / 2), y + Math.round((h - dh) / 2), dw, dh);
    ctx.imageSmoothingEnabled = sm;
  }
  function drawFaceWin(ctx, t, api) {
    if (A.im) return;                                                // while an IM is open the face lives there instead
    const a = api.S.agent, r = { x: 4, y: 204, w: 162, h: 114 }, mood = api.M.label || 'online';
    const { c, close } = win(ctx, r, SN[a], { icon: 'pal', client: C.face, closeOnly: true, inactive: true });
    hit(close, () => {}, 'face-x');
    faceInto(ctx, c.x + 2, c.y + 2, c.w - 4, c.h - 4);
    text(ctx, mood, c.x + c.w - 6, c.y + c.h - 8, uf(8), C.sh, 'middle', 'right');
    hit({ x: r.x, y: r.y, w: r.w, h: r.h }, () => { A.info = { kind: 'buddy', agent: a }; }, 'face');
  }
  function drawAwayNote(ctx, t) {
    if (A.im) return;                                                // the IM window sits over it; never let the note peek out underneath
    const r = { x: 170, y: 204, w: 134, h: 114 }, { c } = win(ctx, r, 'Away Message', { icon: 'note', client: C.face, noButtons: true, inactive: true });
    px(ctx, C.note, c.x + 2, c.y + 2, c.w - 4, c.h - 4); px(ctx, C.sh, c.x + 2, c.y + 2, c.w - 4, 1); px(ctx, C.sh, c.x + 2, c.y + 2, 1, c.h - 4);
    const aw = A.away;
    text(ctx, fit(ctx, SN[aw.agent] + ':', c.w - 12, uf(10, true)), c.x + 6, c.y + 6, uf(10, true), aw.busy ? C.red : C.t1);
    const lines = wrap(ctx, '"' + aw.text + '"', c.w - 14, `12px ${COMIC}`);
    lines.slice(0, 4).forEach((l, i) => text(ctx, l, c.x + 7, c.y + 22 + i * 15, `12px ${COMIC}`, C.dk));
    if (aw.busy) text(ctx, `since ${agoText(t - A.buddies[aw.agent].since)}`, c.x + c.w - 6, c.y + c.h - 8, uf(9), C.sh, 'middle', 'right');
    else text(ctx, ':-)  ;-)  :-P', c.x + c.w - 6, c.y + c.h - 8, uf(9), C.sh, 'middle', 'right');
  }
  const agoText = (ms) => { const s = Math.max(0, Math.round(ms / 1000)); return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`; };
  function drawInfo(ctx, t, api) {
    const inf = A.info;
    if (inf.kind === 'write') {
      const r = { x: 110, y: 70, w: 290, h: 150 }, { c, close } = win(ctx, r, 'Write Mail', { icon: 'env', client: C.face });
      hit(close, () => { A.info = null; }, 'info-x');
      text(ctx, 'Send To:', c.x + 8, c.y + 12, uf(11)); sunken(ctx, c.x + 70, c.y + 8, c.w - 80, 18); text(ctx, SN[api.S.agent], c.x + 75, c.y + 17, uf(11), C.dk, 'middle');
      text(ctx, 'Subject:', c.x + 8, c.y + 36, uf(11)); sunken(ctx, c.x + 70, c.y + 32, c.w - 80, 18); text(ctx, 'hey', c.x + 75, c.y + 41, uf(11), C.dk, 'middle');
      sunken(ctx, c.x + 8, c.y + 56, c.w - 18, 40); text(ctx, 'Mail is for 1999. Tap Space and just talk to me.', c.x + 13, c.y + 64, `12px ${IMF}`, C.dk);
      hit(button(ctx, c.x + c.w - 70, c.y + c.h - 28, 60, 22, 'Send Now', { dflt: true }), () => { A.info = null; }, 'send');
      hit({ ...r, outside: true }, () => { A.info = null; }, 'info-out');
      return;
    }
    const a = inf.agent, b = A.buddies[a], crew = (api.S.crew && api.S.crew[a]) || {};
    const r = { x: 120, y: 60, w: 272, h: 176 }, { c, close } = win(ctx, r, `${SN[a]} - Buddy Info`, { icon: 'pal', client: C.face });
    hit(close, () => { A.info = null; }, 'info-x');
    faceInto(ctx, c.x + 6, c.y + 6, 92, 69);
    text(ctx, SN[a], c.x + 106, c.y + 8, `bold 14px ${IMF}`, C.t1);
    const rows = [['Real name', a[0].toUpperCase() + a.slice(1)], ['Status', b.busy ? 'Away - ' + (b.label || b.status) : b.status === 'idle' ? 'Online' : b.status],
      ['Member since', '1999'], ['Last did', crew.last ? `${crew.last.label} (${fmtTook(crew.last.took || 0)})` : 'nothing yet']];
    rows.forEach(([k, v], i) => { text(ctx, k + ':', c.x + 106, c.y + 30 + i * 15, uf(10, true), C.dk); text(ctx, fit(ctx, v, c.w - 180, uf(10)), c.x + 176, c.y + 30 + i * 15, uf(10), C.dk); });
    groove(ctx, c.x + 6, c.y + 86, c.w - 12);
    text(ctx, 'Recent:', c.x + 8, c.y + 92, uf(10, true));
    const h = (crew.hist || []).slice(0, 3);
    if (!h.length) text(ctx, 'no recent activity', c.x + 60, c.y + 92, uf(10), C.sh);
    h.forEach((e, i) => text(ctx, fit(ctx, `${clockOf(e.at)}  ${e.label}`, c.w - 70, uf(10)), c.x + 60, c.y + 92 + i * 13, uf(10), C.dk));
    hit(button(ctx, c.x + c.w - 60, c.y + c.h - 28, 52, 22, 'OK', { dflt: true }), () => { A.info = null; }, 'ok');
    hit({ ...r, outside: true }, () => { A.info = null; }, 'info-out');
  }
  const clockOf = (unix) => { const d = new Date(unix * 1000), h = d.getHours(); return `${h % 12 || 12}:${String(d.getMinutes()).padStart(2, '0')}${h < 12 ? 'a' : 'p'}`; };

  // ------------------------------------------------------------------ IM window
  function drawIM(ctx, t, api) {
    const im = A.im, r = { x: 36, y: 22, w: 364, h: 240 };
    const { c, close } = win(ctx, r, `${SN[im.agent]} - Instant Message`, { icon: 'bubble', client: C.face });
    hit(close, (tt) => { if (api.speechActive()) api.stop(); A.im = null; A.busyUntil = tt + 300; }, 'im-x');
    // menu strip
    let mx = c.x + 4;
    for (const m of ['File', 'Edit', 'Insert', 'People']) { text(ctx, m, mx, c.y + 3, uf(10)); mx += ctx.measureText(m).width + 12; }
    // conversation
    const ax = c.x + 3, ay = c.y + 17, aw = c.w - 6, ah = 102;
    sunken(ctx, ax, ay, aw, ah, C.lt);
    const F = `12px ${IMF}`, FB = `bold 12px ${IMF}`, LH = 15, innerW = aw - 14;
    const rows = [];
    for (const l of im.lines) {
      const who = l.who === 'me' ? ME : l.who === 'them' ? SN[im.agent] : null;
      if (!who) { rows.push({ x: 0, s: '<' + l.text + '>', f: `italic 11px ${IMF}`, col: C.sh }); continue; }
      ctx.font = FB; const nw = ctx.measureText(who + ': ').width;
      const ls = wrap(ctx, l.text, innerW - (l.kind === 'card' ? 14 : 0), F, innerW - nw);
      ls.forEach((s, i) => rows.push({ x: i === 0 ? nw : (l.kind === 'card' ? 14 : 0), s, f: l.kind === 'card' ? `12px ${MONO}` : F, col: l.kind === 'progress' ? C.sh : C.dk,
        name: i === 0 ? who : null, ncol: l.who === 'me' ? C.blue : C.red }));
    }
    const maxRows = Math.floor((ah - 6) / LH), vis = rows.slice(-maxRows);
    ctx.save(); ctx.beginPath(); ctx.rect(ax + 2, ay + 2, aw - 4, ah - 4); ctx.clip();
    vis.forEach((rw, i) => {
      const y = ay + 4 + i * LH;
      if (rw.name) text(ctx, rw.name + ':', ax + 5, y, FB, rw.ncol);
      text(ctx, rw.s, ax + 5 + rw.x, y, rw.f, rw.col);
    });
    if (!rows.length) text(ctx, `Say hi to ${SN[im.agent]}...`, ax + 6, ay + 4, `italic 12px ${IMF}`, C.sh);
    ctx.restore();
    // scrollbar
    px(ctx, C.ltg, ax + aw - 14, ay + 2, 12, ah - 4); raised(ctx, ax + aw - 14, ay + 2, 12, 12); raised(ctx, ax + aw - 14, ay + ah - 14, 12, 12);
    raised(ctx, ax + aw - 14, ay + 14 + Math.round(Math.max(0, rows.length - maxRows) / Math.max(1, rows.length) * (ah - 40)), 12, Math.max(12, Math.round(Math.min(1, maxRows / Math.max(1, rows.length)) * (ah - 28))));
    // buddy icon (the face, lip-syncing) + input box
    const fy = ay + ah + 4, fw = 112, fh = 84;
    faceInto(ctx, ax, fy, fw, fh);
    const V = window.RetroBanner ? RetroBanner.state() : { state: 'idle' }, vs = V.state;
    const ix = ax + fw + 4, iw = aw - fw - 4;
    sunken(ctx, ix, fy, iw, 56, C.lt);
    const speaking = api.speechActive();
    if (vs === 'heard' || vs === 'listening') {
      text(ctx, vs === 'heard' ? 'Heard you! Go ahead...' : 'Listening... (tap Space when done)', ix + 6, fy + 6, `12px ${IMF}`, C.blue);
      const L = window.RetroBanner && RetroBanner.debug ? RetroBanner.debug().L : { l: 0 };
      const n = Math.round(clamp(L.l || 0, 0, 1) * 16);
      for (let i = 0; i < 16; i++) px(ctx, i < n ? (i > 12 ? C.red : '#00a000') : C.ltg, ix + 6 + i * 10, fy + 30, 8, 12);
    } else if (vs === 'transcribing') text(ctx, 'Sending...', ix + 6, fy + 6, `12px ${IMF}`, C.sh);
    else if (vs === 'working') {
      const tr = V.turn, steps = tr && Array.isArray(tr.steps) ? tr.steps : [], last = steps[steps.length - 1];
      text(ctx, `${SN[im.agent]} is typing${'.'.repeat(1 + Math.floor(t / 400) % 3)}`, ix + 6, fy + 6, `italic 12px ${IMF}`, C.sh);
      if (last) text(ctx, fit(ctx, (last.done ? '\u2713 ' : '> ') + last.text, iw - 12, uf(10)), ix + 6, fy + 24, uf(10), C.dk);
      else if (V.say && V.say.text) text(ctx, fit(ctx, '"' + V.say.text + '"', iw - 12, uf(10)), ix + 6, fy + 24, uf(10), C.dk);
      if (tr && tr.stuck) text(ctx, 'still trying... tap to cancel', ix + 6, fy + 40, uf(10), C.red);
    } else if (speaking) text(ctx, `${SN[im.agent]} is sending you an IM`, ix + 6, fy + 6, `italic 12px ${IMF}`, C.sh);
    else { text(ctx, api.ptt() ? 'tap Space to reply' : 'say "Alfred" to reply', ix + 6, fy + 6, `12px ${IMF}`, C.sh); if (Math.floor(t / 500) % 2 === 0) px(ctx, C.dk, ix + 6, fy + 22, 1, 13); }
    // buttons
    const by = fy + 60, bw = 52;
    ['Warn', 'Block', 'Get Info'].forEach((l, i) => hit(button(ctx, ix + i * (bw + 2), by, bw, 22, l, { disabled: i < 2 }), i === 2 ? () => { A.info = { kind: 'buddy', agent: im.agent }; } : () => {}, 'im-' + l));
    hit(button(ctx, ix + iw - 48, by, 48, 22, speaking ? 'Stop' : 'Send', { dflt: true, bold: true }), (tt) => { if (speaking) api.stop(); else if (api.ptt()) fetch('/ptt', { method: 'POST' }).catch(() => {}); A.busyUntil = tt + 300; }, 'im-send');
    hit({ ...r, outside: false }, () => {}, 'im-inside');
  }

  // ------------------------------------------------------------------ the v1.1 click-in windows, re-chromed
  function drawRetroWin(ctx, t, api) {
    const RW = window.RetroWin; if (!RW) return;
    const D = { weather: api.dash().weather, agenda: api.dash().agenda, day: api.dash().day, crew: api.S.crew, ptt: api.ptt() };
    wctx.fillStyle = '#fff'; wctx.fillRect(0, 0, W, H);
    RW.draw(wctx, D, t);                                             // state machine (idle close, speech reset) keeps running
    const key = RW.key(); if (!key || RW.busy(t)) return;
    const R = RW.WIN, r = { x: R.x, y: R.y, w: R.w, h: H - TB - R.y - 2 };
    const { c, close } = win(ctx, r, `Retro Online - ${CH_TITLE[key] || key}`, { icon: 'globe', client: C.lt });
    const sx = R.x + 3, sy = R.y + R.titleH + 2, sw = R.w - 6, sh = R.h - R.titleH - 5;
    ctx.drawImage(winCv, sx, sy, sw, Math.min(sh, c.h), c.x, c.y, sw, Math.min(sh, c.h));
    hit({ ...r, outside: true }, () => api.winClose('outside'), 'rw-outside');
    hit({ x: r.x, y: r.y, w: r.w, h: r.h }, () => RW.touch(performance.now()), 'rw-inside');
    hit(close, () => api.winClose('closebox'), 'rw-x');
  }

  // ------------------------------------------------------------------ mail
  function drawMailSplash(ctx, t) {
    const sp = A.mail.splash; if (t > sp.until) { A.mail.splash = null; return; }
    const p = clamp((t - sp.at) / 200, 0, 1), w = 250, h = 118, x = Math.round((W - w) / 2), y = 40;
    if (p < 1) { px(ctx, C.dk, x + 4, y + 4, w, h); raised(ctx, x, y, w, h); return; }
    px(ctx, C.dk, x + 4, y + 4, w, h);
    const { c, close } = win(ctx, { x, y, w, h }, "You've Got Mail!", { icon: 'env', client: C.face, closeOnly: true });
    hit(close, () => { A.mail.splash = null; }, 'mail-x');
    blit(ctx, 'mailbox', c.x + 10, c.y + 14, 2); blit(ctx, 'flag', c.x + 46, c.y + 8, 2);
    const bounce = Math.floor(t / 250) % 2 ? 0 : -1;
    text(ctx, "You've Got Mail!", c.x + 70, c.y + 14 + bounce, `bold 18px ${SERIF}`, C.t1);
    text(ctx, `From: ${sp.agent ? SN[sp.agent] : 'Retro Online'}`, c.x + 70, c.y + 38, uf(10, true));
    text(ctx, fit(ctx, sp.subject, c.w - 80, uf(10)), c.x + 70, c.y + 51, uf(10));
    hit(button(ctx, c.x + c.w - 150, c.y + c.h - 28, 70, 22, 'Read Now', { dflt: true }), () => { A.mail.box = true; A.mail.splash = null; }, 'read');
    hit(button(ctx, c.x + c.w - 74, c.y + c.h - 28, 64, 22, 'Later'), () => { A.mail.splash = null; }, 'later');
  }
  function drawMailbox(ctx, t) {
    const r = { x: 60, y: 44, w: 392, h: 196 }, { c, close } = win(ctx, r, `${ME}'s Online Mailbox`, { icon: 'env', client: C.face });
    const closeBox = () => { A.mail.box = false; A.mail.unread = 0; A.mail.items.forEach(m => { m.read = true; }); };
    hit(close, closeBox, 'mailbox-x');
    raised(ctx, c.x + 2, c.y + 2, 70, 16); text(ctx, 'New Mail', c.x + 37, c.y + 11, uf(10, true), C.dk, 'middle', 'center');
    raised(ctx, c.x + 72, c.y + 4, 60, 14); text(ctx, 'Old Mail', c.x + 102, c.y + 12, uf(10), C.sh, 'middle', 'center');
    raised(ctx, c.x + 132, c.y + 4, 60, 14); text(ctx, 'Sent Mail', c.x + 162, c.y + 12, uf(10), C.sh, 'middle', 'center');
    const lx = c.x + 2, ly = c.y + 20, lw = c.w - 4, lh = c.h - 52;
    sunken(ctx, lx, ly, lw, lh, C.lt);
    const cols = [['Date', 60], ['Email Address', 130], ['Subject', lw - 200]];
    let cx = lx + 2;
    for (const [n, w] of cols) { raised(ctx, cx, ly + 2, w, 16); text(ctx, n, cx + 4, ly + 11, uf(10), C.dk, 'middle'); cx += w; }
    let y = ly + 22;
    if (!A.mail.items.length) text(ctx, 'No mail. Ask the crew to do something!', lx + 8, y + 2, `12px ${IMF}`, C.sh);
    for (const m of A.mail.items.slice(0, Math.floor((lh - 26) / 14))) {
      const d = m.at, ds = `${d.getMonth() + 1}/${d.getDate()}`;
      if (!m.read) blit(ctx, 'env', lx + 4, y + 1, 1, { w: 'q' });
      text(ctx, ds, lx + 24, y + 1, uf(10, !m.read)); text(ctx, m.from, lx + 66, y + 1, uf(10, !m.read), C.t1);
      text(ctx, fit(ctx, m.subject, lw - 206, uf(10, !m.read)), lx + 196, y + 1, uf(10, !m.read));
      y += 14;
    }
    const by = ly + lh + 5;
    ['Read', 'Status', 'Keep As New', 'Delete'].forEach((l, i) => hit(button(ctx, lx + 2 + i * 70, by, 66, 22, l), i === 3 ? () => { A.mail.items = []; A.mail.unread = 0; } : () => {}, 'mb-' + l));
    hit(button(ctx, lx + lw - 60, by, 58, 22, 'Close', { dflt: true }), closeBox, 'mb-close');
    hit({ ...r, outside: true }, closeBox, 'mb-out');
  }

  // ------------------------------------------------------------------ start menu
  function drawStartMenu(ctx, t, api) {
    const items = [['Buddy List', 'pal', () => {}], ['Mailbox', 'env', () => { A.mail.box = true; }], ['Instant Message', 'bubble', (tt) => { openIM(tt, api.S.agent); }], null,
      ...CHANNELS.map(([k, l]) => [l + ' Channel', { today: 'cal', weather: 'sun', crew: 'crew', house: 'house', alerts: 'bell', limits: 'gauge' }[k], (tt) => { if (window.RetroWin) RetroWin.open(k, null, tt); }]), null,
      ['Next Theme (T)', 'globe', () => dispatchKey('t')], ['Full Screen (F)', 'pc', () => dispatchKey('f')], null,
      ['Switch to Mac (v1 look)', 'pc', () => { if (api.switchSkin) api.switchSkin(false); else fetch('/event', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ theme: 'green' }) }).catch(() => {}); }]];
    const ih = 18, w = 184, h = items.reduce((a, it) => a + (it ? ih : 5), 0) + 6, x = 2, y = H - TB - h;
    hit({ x: 0, y: 0, w: W, h: H, any: true }, () => { A.menu = false; }, 'menu-out');   // registered first: any click not on an item closes the menu
    raised(ctx, x, y, w, h);
    // the vertical banner band
    for (let i = 0; i < 12; i++) px(ctx, `rgb(${Math.round(i * 10)},${Math.round(i * 10)},${128 - i * 4})`, x + 3, y + 3 + i * Math.ceil((h - 6) / 12), 22, Math.ceil((h - 6) / 12));
    ctx.save(); ctx.translate(x + 18, y + h - 8); ctx.rotate(-Math.PI / 2); text(ctx, 'Retro Online 98', 0, 0, `bold 13px ${SERIF}`, C.lt, 'middle'); ctx.restore();
    let yy = y + 4;
    for (const it of items) {
      if (!it) { groove(ctx, x + 28, yy + 2, w - 32); yy += 5; continue; }
      const [label, icon, fn] = it, row = { x: x + 26, y: yy, w: w - 29, h: ih };
      blit(ctx, icon, row.x + 4, yy + 2);
      text(ctx, label, row.x + 24, yy + ih / 2 + 1, uf(11), C.dk, 'middle');
      hit(row, (tt) => { A.menu = false; fn(tt); }, 'menu-' + label);
      yy += ih;
    }
  }
  function dispatchKey(k) { try { window.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true })); } catch (e) {} }

  // ------------------------------------------------------------------ input
  function click(x, y, t) {
    if (!A.on) return false;
    const inside = (r) => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h;
    if (A.phase !== 'desktop') {                                     // booting: the taskbar "Mac" button still works, anything else skips the boot
      const mac = A.click.find(r => r.name === 'mac');
      if (mac && inside(mac)) { mac.fn(t); return true; }
      skipBoot(t); return true;
    }
    // top-most first: the hit list is built in draw order, so walk it backwards. Plain entries fire on a click inside their rect,
    // `outside` entries when the click is NOT inside (click-away closes a window), `any` entries on every click (the Start menu).
    const list = A.click;
    for (let i = list.length - 1; i >= 0; i--) {
      const r = list[i], inR = inside(r);
      if (r.any || (r.outside ? !inR : inR)) { r.fn(t); A.busyUntil = Math.max(A.busyUntil, t + 200); return true; }
    }
    return false;
  }
  addEventListener('keydown', (e) => {
    if (!A.on) return;
    const t = performance.now();
    if (A.phase !== 'desktop') { skipBoot(t); return; }
    if (e.key === 'Escape') {
      if (A.menu) { A.menu = false; return; }
      if (A.mail.splash) { A.mail.splash = null; return; }
      if (A.mail.box) { A.mail.box = false; A.mail.unread = 0; return; }
      if (A.info) { A.info = null; return; }
      const RW = window.RetroWin; if (RW && RW.isOpen()) return;    // face.js closes it
      if (A.im && !(window.RetroFace && RetroFace.info().playing)) { A.im = null; return; }
    }
  }, true);

  window.RetroAOL = {
    // screen name from the server's settings message; a ?sn= preview wins on test pages
    setScreenName(v) { if (!SN_URL) ME = cleanSN(v); },
    screenName: () => ME,
    frame, click, busy: (t) => A.phase !== 'desktop' || t < A.busyUntil || !!A.mail.splash || !!A.toast,
    debug: () => ({ on: A.on, phase: A.phase, im: A.im ? { agent: A.im.agent, lines: A.im.lines.length } : null, mail: { unread: A.mail.unread, items: A.mail.items.length, splash: !!A.mail.splash },
      buddies: A.buddies, doors: A.doors.length, hits: A.hits, sfx: sfxLog.slice(-8), canSfx: canSfx() }),
    // local previews for screenshots (nothing is sent anywhere): RetroAOL.demo('mail'|'door'|'boot'|'im')
    demo(what, agent) {
      const t = performance.now(); agent = agent || 'maker';
      if (what === 'mail') gotMail(t, agent, { label: 'CODING face.js', at: Date.now() / 1000, took: 42 });
      else if (what === 'door') { A.doors.push({ kind: 'open', agent, at: t }); A.buddies[agent].flashAt = t; sfx('door'); }
      else if (what === 'boot') activate(t);
      else if (what === 'desktop') enterDesktop(t);
      else if (what === 'im') { openIM(t, agent); imLine('me', 'hey, what are you working on?'); imLine('them', 'The AOL skin for your kiosk. Buddy list, IMs, the works.'); }
      else if (what === 'menu') A.menu = true;
      else if (what === 'info') A.info = { kind: 'buddy', agent };
      else if (what === 'mailbox') A.mail.box = true;
    },
    // render one sound effect offline to a 16-bit mono WAV (base64) so it can be listened to / muxed into a preview without a kiosk
    renderSfx(kind, secs) {
      const sr = 44100, c = new OfflineAudioContext(1, Math.ceil(sr * (secs || 2.5)), sr), out = c.createGain(); out.connect(c.destination);
      SFX[kind](c, 0.05, out);
      return c.startRendering().then((buf) => {
        const d = buf.getChannelData(0), n = d.length, b = new ArrayBuffer(44 + n * 2), v = new DataView(b);
        const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
        str(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); str(8, 'WAVE'); str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
        v.setUint32(24, sr, true); v.setUint32(28, sr * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); str(36, 'data'); v.setUint32(40, n * 2, true);
        for (let i = 0; i < n; i++) v.setInt16(44 + i * 2, Math.max(-1, Math.min(1, d[i])) * 32767, true);
        let s = ''; const u = new Uint8Array(b); for (let i = 0; i < u.length; i += 8192) s += String.fromCharCode.apply(null, u.subarray(i, i + 8192));
        return btoa(s);
      });
    },
  };
})();

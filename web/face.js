// Retro Mac: face display client. A "dumb" screen: it draws what it is told.
// Events arrive on ws://<host>/ws as {agent, state: idle|thinking|speaking, audio?, text?, card?}.
//
// MOODS (each agent keeps its own eyes/mouth; a mood only bends that agent's own shapes)
//   Ambient, while nobody is talking or working (clock = the kiosk's local time zone):
//     neutral   9am-8pm: today's face + natural blinks, glances, a rare raised brow / small smile / squint
//     fresh     6-9am: eyes a touch bigger, brighter smile, livelier glances; first activity of the day = stretch
//     drowsy    8-11pm, and 11pm-6am for the first 90s of quiet: half-lidded, slow blinks, the odd yawn
//     rest      any time after 10 min of quiet (night excepted): eyes closed, dozing, peeks out now and then
//     sleep     11pm-6am after 90s of quiet: eyes closed, slow breathing, floating "z"s, ~9 fps
//   Activity (crew status from /activity, or the voice state from banner.js):
//     thinking  crew thinking, voice GOT IT / WORKING: eyes up-left, one brow raised, "..." mouth
//     working   crew working: brows knit, eyes narrowed, heads-down mouth
//     listening crew listening, voice HEARD / LISTENING: curious, brows up, eyes a bit wider
//     speaking  lip sync, unchanged (speech always wins and the face goes full screen); a tone tag on the chunk
//               being spoken ([happy] [thinking] [surprised] [curious] [concerned] [sleepy]) bends its eyes/brows
//   Speech is streamed per sentence and scheduled gaplessly (see "audio" below); RetroFace.speech() for debugging.
//   Short emotes laid over the above:
//     surprised voice HEARD (also how a sleeping face wakes to its name): wide eyes, brows up, "o" mouth
//     happy     voice DONE, or an agent finishing work: ^ ^ eyes, grin, a little bounce
//     concerned voice DIDN'T CATCH THAT / STOPPED / error note: worried brows, frown, eyes down
//     yawn      now and then while drowsy
//     wake      leaving sleep/rest on any activity (or first activity of a morning): blink, stretch, alert
//   Any activity, speech, wake word, voice state, tap or mouse move wakes the face at once.
// PREVIEW (no need to wait for the clock): /?test&mood=<name>&agent=alfred|scout|maker&hour=0-23&idle=<sec>
//   mood = any name above (aliases: curious, resting, asleep, stretch, sorry). hour fakes the clock, idle fakes
//   how long it has been quiet (e.g. ?test&hour=3&idle=120 falls asleep on its own). Test page has a MOOD button.
(function () {
  const W = 512, H = 342;
  const THEMES = {
    green: { fg: [0x39, 0xff, 0x6a], bg: [0x03, 0x12, 0x08], edge: '#000', glow: '#39ff6a', scan: true },
    amber: { fg: [0xff, 0xb0, 0x00], bg: [0x16, 0x0d, 0x00], edge: '#000', glow: '#ffb000', scan: true },
    paper: { fg: [0x14, 0x14, 0x12], bg: [0xe9, 0xe8, 0xdc], edge: '#050505', glow: null, scan: false },
    mono:  { fg: [0xf2, 0xf2, 0xf2], bg: [0x00, 0x00, 0x00], edge: '#000', glow: null, scan: false },
    cyan:  { fg: [0x7d, 0xf9, 0xff], bg: [0x00, 0x0f, 0x1c], edge: '#000', glow: '#7df9ff', scan: true },
    // aol: not a palette but a skin (web/aol.js draws the whole frame in colour); fg/bg only matter if aol.js is missing
    aol:   { fg: [0x00, 0x00, 0x00], bg: [0xff, 0xff, 0xff], edge: '#008080', glow: null, scan: false, skin: 'aol' },
  };
  const THEME_ORDER = ['green', 'amber', 'cyan', 'mono', 'paper', 'aol'];
  const canvas = document.getElementById('c');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingEnabled = false;

  const params = new URLSearchParams(location.search);
  const rnd = (a, b) => a + Math.random() * (b - a);
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const q = (v, step) => Math.round(v / step) * step;
  let themeName = 'green', T = THEMES.green, tone = 1;   // tone 0 = light paper, 1 = full dark theme
  let FGc = THEMES.green.fg, BGc = THEMES.green.bg, SCAN = 0.26;
  const mixc = (a, b, p) => [a[0] + (b[0] - a[0]) * p, a[1] + (b[1] - a[1]) * p, a[2] + (b[2] - a[2]) * p];
  const urlTone = params.has('tone') ? clamp(parseFloat(params.get('tone')) || 0, 0, 1) : null;
  const urlTheme = params.get('theme') && THEMES[params.get('theme')] ? params.get('theme') : (params.get('skin') === 'aol' ? 'aol' : null);
  function applyTheme(name) {
    if (!THEMES[name]) return;
    themeName = name; T = THEMES[name]; recolor();
    if (!T.skin) store.set('rm-v1theme', name);   // what "Switch to Mac" returns to (applyTheme only runs after `store` exists)
  }
  function setTone(v) { tone = clamp(+v, 0, 1); recolor(); const sl = document.getElementById('tone'); if (sl && +sl.value !== Math.round(tone * 100)) sl.value = Math.round(tone * 100); }
  function recolor() {
    const P = THEMES.paper;
    FGc = mixc(P.fg, T.fg, tone); BGc = mixc(P.bg, T.bg, tone);
    SCAN = T.scan ? 0.26 * tone : 0;
    const e = mixc([5, 5, 5], [0, 0, 0], tone).map(Math.round);
    document.body.style.background = T.skin ? T.edge : `rgb(${e})`;   // a skin owns the desktop colour
    canvas.style.filter = 'none';  // CSS glow removed: too GPU-heavy for fanless-class hardware
  }
  function cycleTheme() {
    const next = THEME_ORDER[(THEME_ORDER.indexOf(themeName) + 1) % THEME_ORDER.length];
    setTheme(next);
  }
  function setTheme(name) {                      // persist through the server (settings.json); a ?theme= test page stays local
    if (!THEMES[name]) return;
    if (urlTheme) { applyTheme(name); return; }
    fetch('/event', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ theme: name }) }).catch(() => applyTheme(name));
  }
  // skin switcher (mouse/touch): v1 -> the skin, or the skin -> the v1 theme that was on before it (remembered per browser)
  function switchSkin(on) { setTheme(on ? 'aol' : (THEMES[store.get('rm-v1theme')] && !THEMES[store.get('rm-v1theme')].skin ? store.get('rm-v1theme') : 'green')); }
  function toggleFullscreen() {
    if (document.fullscreenElement) document.exitFullscreen();
    else document.documentElement.requestFullscreen().catch(() => {});
  }
  addEventListener('keydown', (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === 'f' || e.key === 'F') toggleFullscreen();
    if (e.key === 't' || e.key === 'T') cycleTheme();
    if ((e.key === 'm' || e.key === 'M') && !typingTarget(e.target)) setMenubar(!menubarOn);   // Fable: classic menu bar on/off
  });
  // Fable: opt-in classic Mac menu bar (14 px strip above the untouched dashboard). Shared setting like theme/tone/ptt;
  // `?menubar` forces it on for a local preview page without touching settings.json.
  const MENUBAR_URL = params.has('menubar');
  let menubarOn = MENUBAR_URL;
  function setMenubar(on) {
    if (MENUBAR_URL || urlTheme) { menubarOn = !!on; lastDraw = 0; return; }
    fetch('/event', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ menubar: !!on }) }).catch(() => { menubarOn = !!on; });
  }
  addEventListener('dblclick', (e) => { if (performance.now() - lastPanelClick < 700) return; toggleFullscreen(); });
  // light <-> dark slider (auto-hides; [ and ] nudge it from the keyboard)
  const sliderBox = document.getElementById('tonebox'), slider = document.getElementById('tone');
  let sliderTimer = 0, tonePost = 0;
  function showSlider() { sliderBox.style.opacity = '1'; clearTimeout(sliderTimer); sliderTimer = setTimeout(() => { sliderBox.style.opacity = '0'; }, 3000); }
  function commitTone(v) {
    setTone(v / 100);
    clearTimeout(tonePost);
    tonePost = setTimeout(() => { if (!urlTone && urlTone !== 0) fetch('/event', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tone: tone }) }).catch(() => {}); }, 150);
    showSlider();
  }
  slider.addEventListener('input', () => commitTone(+slider.value));
  addEventListener('mousemove', showSlider);
  addEventListener('keydown', (e) => {
    if (e.key === '[') commitTone(clamp(Math.round(tone * 100) - 10, 0, 100));
    if (e.key === ']') commitTone(clamp(Math.round(tone * 100) + 10, 0, 100));
  });
  sliderBox.style.opacity = '0';
  let cursorTimer = 0;
  addEventListener('mousemove', () => { document.body.style.cursor = ''; clearTimeout(cursorTimer); cursorTimer = setTimeout(() => { document.body.style.cursor = 'none'; }, 2000); });
  const HOME = params.get('home') === 'face' ? 'face' : 'dash';
  let dash = { weather: null, agenda: [] };

  // ------------------------------------------------------------------ state
  const S = {
    agent: 'alfred',
    mode: 'idle',            // idle | thinking | speaking
    card: null, cardAt: 0, cardClearAt: 0,
    mix: 0,                  // 0 = full face, 1 = face stepped aside for a card
    level: 0,                // smoothed mouth openness 0..1
    nextBlink: performance.now() + 2500, blinkUntil: 0, doubleBlink: false,
    queue: [], playing: false,
    audioCtx: null, analyser: null, buf: null,
    simUntil: 0, simSeed: 0,
    tile: null, tileUntil: 0, shrinkAt: 0, faceHold: 0,
    crew: null,
  };

  // ------------------------------------------------------------------ looks
  // Each agent gets its own eyes, mouth and name tag so you can tell who is talking.
  const LOOKS = {
    alfred: { name: 'ALFRED', eyeGap: 82, eyeY: 128, mouthY: 250, mouthW: 150, smile: 1.0 },
    scout:  { name: 'SCOUT',  eyeGap: 88, eyeY: 134, mouthY: 252, mouthW: 112, smile: 0.0 },
    maker:  { name: 'MAKER',  eyeGap: 84, eyeY: 126, mouthY: 250, mouthW: 128, smile: 0.35 },
  };

  // ------------------------------------------------------------------ moods (see the list at the top)
  const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';   // the kiosk's local time zone
  const TEST = params.has('test');
  const MOODS = ['auto', 'neutral', 'fresh', 'drowsy', 'rest', 'sleep', 'thinking', 'working', 'listening', 'speaking',
    'surprised', 'happy', 'concerned', 'yawn', 'wake'];
  const ALIAS = { curious: 'listening', resting: 'rest', doze: 'rest', asleep: 'sleep', stretch: 'wake', sorry: 'concerned', sad: 'concerned', pleased: 'happy', morning: 'fresh', sleepy: 'drowsy' };
  const AMBIENT = new Set(['neutral', 'fresh', 'drowsy', 'rest', 'sleep']);
  const MODEMOODS = new Set(['thinking', 'working', 'listening', 'speaking']);
  const EMOTES = { surprised: 900, happy: 2600, concerned: 2800, yawn: 1900, wake: 1700 };
  const SLEEP_AFTER = 90e3, REST_AFTER = 10 * 60e3;
  let previewMood = (() => { const m = ALIAS[params.get('mood')] || params.get('mood'); return m && m !== 'auto' && MOODS.includes(m) ? m : null; })();
  let lockAgent = LOOKS[params.get('agent')] ? params.get('agent') : null;
  const fakeHour = params.has('hour') ? clamp(parseFloat(params.get('hour')) || 0, 0, 23.99) : null;
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { if (TEST) return; try { localStorage.setItem(k, v); } catch (e) {} },   // test pages never touch the kiosk's memory
  };
  const M = { lastAct: 0, amb: 'neutral', shown: '', emote: null, emoteAt: 0, emoteUntil: 0, voice: 'idle', note: '',
    nextPeek: 0, peekUntil: 0, nextYawn: 0, nextGlance: 0, glanceUntil: 0, gx: 0, gy: 0,
    micro: null, microUntil: 0, nextMicro: 0, hour: 12, hourAt: -1e9, savedAt: 0, wakeDay: TEST ? null : store.get('rm-wakeday'), label: '' };
  {
    const now = performance.now(), idleQ = parseFloat(params.get('idle')), saved = +store.get('rm-lastact') || 0;
    // quiet time survives the auto-reload on web edits, so a 3am reload doesn't wake the face
    M.lastAct = !isNaN(idleQ) ? now - idleQ * 1000 : saved && !TEST ? now - clamp(Date.now() - saved, 0, 864e5) : now;
  }
  const hourFmt = new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: 'numeric', minute: 'numeric', hourCycle: 'h23' });
  const dayFmt = new Intl.DateTimeFormat('en-CA', { timeZone: TZ });
  function hourNow(t) {
    if (fakeHour !== null) return fakeHour;
    if (t - M.hourAt > 2000) {                 // 2 s: the AOL taskbar clock reads this; 15 s lagged it past the minute
      M.hourAt = t;
      const p = hourFmt.formatToParts(new Date()), get = (k) => +(p.find(x => x.type === k) || { value: 0 }).value;
      M.hour = (get('hour') % 24) + get('minute') / 60;
    }
    return M.hour;
  }
  function emote(name, t, ms) { M.emote = name; M.emoteAt = t; M.emoteUntil = t + (ms || EMOTES[name]); }
  // Something happened. urgent = voice/speech (wake straight into the reaction), else stretch awake.
  function poke(t, urgent) {
    const was = M.amb, h = hourNow(t);
    M.lastAct = t;
    if (Date.now() - M.savedAt > 5000) { M.savedAt = Date.now(); store.set('rm-lastact', String(Date.now())); }
    const morning = h >= 5 && h < 11;
    if (was === 'sleep' || was === 'rest') { M.amb = 'neutral'; if (!urgent) emote('wake', t); }
    else if (!morning || urgent || M.emote || M.wakeDay === dayFmt.format(new Date())) return;
    else emote('wake', t);                        // first activity of the morning: stretch
    if (morning) { M.wakeDay = dayFmt.format(new Date()); store.set('rm-wakeday', M.wakeDay); }
  }
  function ambient(t) {
    const h = hourNow(t), idle = t - M.lastAct;
    if (h >= 23 || h < 6) return idle > SLEEP_AFTER ? 'sleep' : 'drowsy';
    if (idle > REST_AFTER) return 'rest';
    return h >= 20 ? 'drowsy' : h < 9 ? 'fresh' : 'neutral';
  }
  function onVoice(st, prev, t) {
    if (st === 'idle') return;
    poke(t, true);
    if (st === 'heard') emote('surprised', t);
    else if (st === 'error') emote('concerned', t, 3200);
    else if (st === 'failed') emote('concerned', t, 7000);      // LIMIT HIT / SOMETHING WENT WRONG: worried for the whole banner
    else if (st === 'stopped') emote('concerned', t, 1500);
    else if (st === 'done') emote('happy', t, 3000);
  }
  function voiceCheck(t) {
    const V = window.RetroBanner ? RetroBanner.state() : null;
    if (!V) return;
    if (V.state !== M.voice) { const prev = M.voice; M.voice = V.state; onVoice(V.state, prev, t); }
    const note = V.note || '';
    if (note !== M.note) { M.note = note; if (/CATCH/.test(note) && V.state !== 'error') emote('concerned', t, 2400); }
  }
  function crewMood(prev, crew) {
    if (!crew) return;
    const t = performance.now();
    let on = false, finished = null;
    for (const a of ['alfred', 'scout', 'maker']) {
      const was = prev && prev[a] && prev[a].status, now = crew[a] && crew[a].status;
      if (now && now !== 'idle') on = true;
      if ((was === 'working' || was === 'thinking') && now === 'idle') finished = a;
    }
    if (on) poke(t, false);
    else if (finished && !S.playing && !S.queue.length && M.voice === 'idle') { if (!lockAgent) S.agent = finished; emote('happy', t, 2000); }
  }
  function moodTick(t) {
    voiceCheck(t);
    const V = window.RetroBanner ? RetroBanner.state() : null;
    if (S.playing || S.queue.length || M.voice !== 'idle' || (V && V.pending && V.pending.length)) poke(t, true);
    else if (S.mode !== 'idle') poke(t, false);
    M.amb = ambient(t);
    if (M.emote && t > M.emoteUntil) M.emote = null;
    if (previewMood && MODEMOODS.has(previewMood) && !S.playing) {
      S.mode = previewMood;
      if (previewMood === 'speaking' && !S.simUntil) S.simUntil = Infinity;
    }
  }
  const breath = (t, amp) => q(Math.sin(t * 2 * Math.PI / 4600) * amp, 1);
  function glance(X, t, k) {                 // saccade to somewhere, hold, come back
    if (t > M.nextGlance) { M.gx = q(rnd(-20, 20), 2); M.gy = q(rnd(-8, 6), 2); M.glanceUntil = t + rnd(600, 1600); M.nextGlance = t + rnd(5e3, 14e3) / k; }
    if (t < M.glanceUntil) { X.gx = M.gx; X.gy = M.gy; }
  }
  function micro(X, t) {                     // rare small variation: one brow, a little smile, a squint
    if (t > M.nextMicro) {
      if (M.nextMicro) { M.micro = ['brow', 'smile', 'squint'][Math.floor(Math.random() * 3)]; M.microUntil = t + rnd(900, 1700); }
      M.nextMicro = t + rnd(25e3, 60e3);
    }
    if (t >= M.microUntil) return;
    if (M.micro === 'brow') X.brow = { y: [-10, null], tilt: [0, 0] };
    else if (M.micro === 'smile') X.smile = Math.max(X.smile, 0.6);
    else X.lid = [0.22, 0.22];
  }
  const AMB_X = {
    neutral(X, t) { glance(X, t, 1); micro(X, t); },
    fresh(X, t) { X.open = 1.06; X.smile = 0.45; glance(X, t, 1.6); micro(X, t); },
    drowsy(X, t) {
      const sway = Math.sin(t * 0.0011) * 0.5 + 0.5;
      X.lid = [q(0.42 + sway * 0.14, 0.04), q(0.46 + sway * 0.14, 0.04)];
      X.gy = 6; X.gx = q(Math.sin(t * 0.00021) * 6, 2);
      X.blinkMs = 520; X.slowBlink = true; X.smile = -0.4;
      if (t > M.nextYawn) { if (M.nextYawn) emote('yawn', t); M.nextYawn = t + rnd(35e3, 90e3); }
    },
    rest(X, t) {
      if (t > M.nextPeek) { if (M.nextPeek) M.peekUntil = t + rnd(900, 1600); M.nextPeek = t + rnd(20e3, 45e3); }
      if (t < M.peekUntil) { X.lid = [0.5, 0.5]; X.gy = 4; X.noBlink = true; return; }   // peeks out, then dozes off again
      X.closed = true; X.bob = breath(t, 2); X.mouth = 'sleep'; X.ticks = 0.6;
    },
    sleep(X, t) { X.closed = true; X.zs = true; X.bob = breath(t, 3); X.mouth = 'sleep'; X.ticks = 0.4; },
  };
  const MODE_X = {
    thinking(X) { X.brow = { y: [-9, 0], tilt: [0.4, -0.3] }; },                  // one brow up: pondering
    working(X) { X.brow = { y: [3, 3], tilt: [-1, -1] }; X.lid = [0.18, 0.18]; }, // brows knit, eyes narrowed
    listening(X) { X.brow = { y: [-12, -7], tilt: [0.2, 0.2] }; X.open = 1.08; },  // curious, all ears
  };
  const EMOTE_X = {
    surprised(X) { X.open = 1.18; X.brow = { y: [-16, -16], tilt: [0, 0] }; X.mouth = 'o'; X.noBlink = true; X.gx = 0; X.gy = -4; X.bob = X.p < 0.15 ? -4 : 0; },
    happy(X, t) {
      X.arc = true; X.mouth = 'smile'; X.gx = 0; X.gy = 0;
      X.bob = X.p < 0.35 ? -q(Math.abs(Math.sin((t - M.emoteAt) * 0.014)) * 6, 2) : 0;
    },
    concerned(X, t) {
      X.brow = { y: [-4, -4], tilt: [1, 1] }; X.mouth = 'frown'; X.open = 0.9; X.lid = [0.12, 0.12];
      X.gy = 8; X.gx = q(Math.sin((t - M.emoteAt) * 0.003) * 6, 2);
    },
    yawn(X) {
      const e = Math.sin(Math.PI * X.p);
      X.lid = [0.45 + 0.5 * e, 0.45 + 0.5 * e]; X.mouth = 'yawn'; X.yawn = e; X.noBlink = true;
      X.brow = { y: [-q(8 * e, 2), -q(8 * e, 2)], tilt: [0.6 * e, 0.6 * e] }; X.bob = -q(e * 4, 2);
    },
    wake(X, t) {                                // eyes pop open, blink, big stretch, settle bright
      const ms = t - M.emoteAt;
      if (ms < 260) { X.open = 1.15; X.brow = { y: [-14, -14], tilt: [0, 0] }; X.mouth = 'o'; X.noBlink = true; }
      else if (ms < 400) X.blinkNow = true;
      else if (ms < 1050) {
        const e = Math.sin(Math.PI * (ms - 400) / 650);
        X.arc = true; X.mouth = 'yawn'; X.yawn = e; X.bob = -q(6 * e, 2); X.brow = { y: [-q(10 * e, 2), -q(10 * e, 2)], tilt: [0, 0] };
      } else if (ms < 1180) X.blinkNow = true;
      else { X.open = 1.06; X.smile = 0.4; }
    },
  };
  // Tone tags while talking ([happy] etc. from the agent, one per speech chunk): eyes and brows only, the mouth stays
  // on lip sync. Same 1-bit shapes as the emotes above; the emotion switches with the chunk under the play head.
  const SPEAK_X = {
    happy(X) { X.arc = true; X.smile = 0.5; },
    surprised(X) { X.open = 1.16; X.brow = { y: [-16, -16], tilt: [0, 0] }; X.noBlink = true; },
    concerned(X) { X.brow = { y: [-4, -4], tilt: [1, 1] }; X.open = 0.92; X.lid = [0.12, 0.12]; X.smile = -0.6; },
    thinking(X, t) { X.brow = { y: [-9, 0], tilt: [0.4, -0.3] }; X.gx = -12 + q(Math.sin(t * 0.002) * 2, 2); X.gy = -8; },
    curious(X) { X.brow = { y: [-12, -7], tilt: [0.2, 0.2] }; X.open = 1.08; },
    sleepy(X) { X.lid = [0.45, 0.45]; X.blinkMs = 520; X.slowBlink = true; X.smile = -0.3; },
  };
  const urlEmotion = params.get('emotion');          // preview: ?test&mood=speaking&emotion=happy
  // What the face does this frame. A neutral X draws exactly today's face.
  function expression(t) {
    let mode = S.mode, amb = M.amb, em = M.emote;
    if (mode === 'idle' && !S.playing) {
      if (M.voice === 'heard' || M.voice === 'listening') mode = 'listening';
      else if (M.voice === 'transcribing' || M.voice === 'working') mode = 'thinking';
    }
    const pm = previewMood;
    if (pm && !S.playing) {
      if (AMBIENT.has(pm)) { amb = pm; mode = 'idle'; if (em !== 'yawn' || pm !== 'drowsy') em = null; }
      else if (EMOTES[pm]) { if (M.emote !== pm) emote(pm, t); em = pm; mode = 'idle'; }
      else { mode = pm; em = null; }
    }
    const X = { mode, em, p: 0, open: 1, lid: null, closed: false, arc: false, brow: null, mouth: null, smile: 0, yawn: 0,
      bob: 0, gx: null, gy: null, zs: false, blinkMs: 130, slowBlink: false, noBlink: false, blinkNow: false, ticks: 1 };
    M.shown = '';
    if (mode === 'speaking') {                    // talking face wins, as today; a tone tag bends its eyes/brows
      const emo = S.playing ? S.emotion : (pm === 'speaking' && SPEAK_X[urlEmotion] ? urlEmotion : null);
      if (emo && SPEAK_X[emo]) SPEAK_X[emo](X, t);
      M.label = emo ? 'speaking:' + emo : 'speaking';
      return X;
    }
    if (em) { X.p = clamp((t - M.emoteAt) / Math.max(1, M.emoteUntil - M.emoteAt), 0, 1); EMOTE_X[em](X, t); M.label = em; return X; }
    if (mode !== 'idle') { if (MODE_X[mode]) MODE_X[mode](X, t); M.label = mode; return X; }
    if (amb !== M.ambSeen) {                    // entering a mood: schedule its first yawn / peek
      M.ambSeen = amb;
      if (amb === 'drowsy') M.nextYawn = t + rnd(15e3, 45e3);
      if (amb === 'rest') { M.nextPeek = t + rnd(15e3, 30e3); M.peekUntil = 0; }
    }
    AMB_X[amb](X, t);
    M.shown = amb; M.label = amb;
    return X;
  }

  // ---- 1-bit drawing bits shared by the moods (all stepped blocks, no curves or gradients)
  function arcLine(cx, cy, w, depth, th, up) {     // up = ^ (middle high), else a closed-eye U
    const step = 6, half = w / 2;
    for (let x = -half; x < half; x += step) {
      const u = (x + step / 2) / half, d = q(depth * (1 - u * u), 2);
      ctx.fillRect(cx + x, (up ? cy + depth / 2 - d : cy - depth / 2 + d) - th / 2, Math.min(step, half - x), th);
    }
  }
  function hollow(cx, cy, w, h, th) {
    ctx.fillRect(cx - w / 2, cy - h / 2, w, h);
    if (w > 2 * th && h > 2 * th) { ctx.fillStyle = '#fff'; ctx.fillRect(cx - w / 2 + th, cy - h / 2 + th, w - 2 * th, h - 2 * th); ctx.fillStyle = '#000'; }
  }
  function chamfer(cx, cy, w, h, c) {              // a 1-bit "oval": rectangle with corners clipped in two steps
    c = q(Math.min(c, w / 3, h / 3), 2);
    const x0 = cx - w / 2, y0 = cy - h / 2, c2 = q(c / 2, 2);
    ctx.fillRect(x0 + c, y0, w - 2 * c, h); ctx.fillRect(x0 + c2, y0 + c2, w - 2 * c2, h - 2 * c2); ctx.fillRect(x0, y0 + c, w, h - 2 * c);
  }
  function lidOver(x, y, w, h, f) {                // heavy upper lid: hide the top of the eye, draw the lid edge
    const cut = q(h * f, 2);
    ctx.fillStyle = '#fff'; ctx.fillRect(x - 2, y - 2, w + 4, cut + 2);
    ctx.fillStyle = '#000';
    if (cut >= 12) ctx.fillRect(x - 4, y + cut - 10, w + 8, 6);
    return cut;
  }
  function closedEye(cx, cy) {
    if (S.agent === 'alfred') arcLine(cx, cy + 4, 58, 14, 10, false);       // deep U
    else if (S.agent === 'scout') arcLine(cx, cy + 2, 92, 6, 6, false);     // long, shallow slit
    else { ctx.fillRect(cx - 31, cy + 4, 62, 8); ctx.fillRect(cx - 31, cy - 8, 8, 14); ctx.fillRect(cx + 23, cy - 8, 8, 14); } // bottom of the square
  }
  function arcEye(cx, cy) {                        // happy / squeezed ^ ^
    if (S.agent === 'alfred') arcLine(cx, cy - 2, 58, 18, 10, true);
    else if (S.agent === 'scout') arcLine(cx, cy, 92, 9, 7, true);
    else { ctx.fillRect(cx - 31, cy - 12, 62, 8); ctx.fillRect(cx - 31, cy - 12, 8, 18); ctx.fillRect(cx + 23, cy - 12, 8, 18); } // top of the square
  }
  function brow(cx, top, side, X, i) {             // alfred: thick 3-step bar; scout: long thin 4-step bar
    const by = X.brow.y[i], tilt = (X.brow.tilt && X.brow.tilt[i]) || 0;
    const sp = S.agent === 'alfred' ? { w: 54, th: 8, gap: 20, n: 3, k: 8 } : { w: 84, th: 5, gap: 18, n: 4, k: 5 };
    const sw = sp.w / sp.n;
    for (let s = 0; s < sp.n; s++) {
      const u = (s + 0.5) / sp.n, inner = side < 0 ? u : 1 - u;          // 0 = outer end, 1 = end nearest the nose
      const dy = q(-tilt * sp.k * (inner - 0.5) * 2, 2);                   // positive tilt lifts the inner end (worried)
      ctx.fillRect(cx - sp.w / 2 + s * sw, top - sp.gap - sp.th + by + dy, sw, sp.th);
    }
  }
  function makerTicks(cx, cy, side, X, i) {        // maker's focus ticks double as brows
    const by = X.brow && X.brow.y[i] != null ? X.brow.y[i] : 0, tilt = (X.brow && X.brow.tilt && X.brow.tilt[i]) || 0;
    const top = cy - q(62 * X.open, 2) / 2 - 18 + by + q((1 - X.ticks) * 22, 2);
    for (let j = -1; j <= 1; j++) {
      const dy = q(-tilt * 5 * (j * -side), 2);
      ctx.fillRect(cx + j * 16 - 2, top + dy, 4, Math.max(4, q((j === 0 ? 12 : 8) * X.ticks, 2)));
    }
  }
  function drawZs(look, t) {                       // three "z"s drift up and to the right, then pop
    const k = 1 + 1.1 * S.mix;                      // bigger in face units when the face is the small one on the dashboard
    for (let n = 0; n < 3; n++) {
      const p = (t / 3600 + n / 3) % 1;
      if (p > 0.9) continue;
      const s = q((12 + p * 14) * k, 2), th = q(Math.max(4, s / 5), 1);
      const x = 256 + look.eyeGap + 44 + q((p * 40 + Math.sin(p * 6.28) * 6) * k, 2), y = look.eyeY - 30 - s - q(p * 70 * k, 2);
      ctx.fillRect(x, y, s, th); ctx.fillRect(x, y + s - th, s, th);
      const m = Math.max(2, Math.round((s - 2 * th) / (th * 0.7)));
      for (let j = 0; j < m; j++) ctx.fillRect(Math.round(x + (s - th) * (1 - (j + 1) / (m + 1))), Math.round(y + th + (s - 2 * th) * j / m), th, Math.ceil((s - 2 * th) / m) + 1);
    }
  }
  function moodMouth(look, cx, y, t, X) {
    const A = S.agent, m = X.mouth;
    if (m === 'o') {
      if (A === 'alfred') chamfer(cx, y + 4, 30, 38, 10);
      else if (A === 'scout') hollow(cx, y + 2, 56, 18, 5);
      else hollow(cx, y + 2, 30, 30, 7);
    } else if (m === 'yawn') {
      const e = X.yawn || 0, hh = q(10 + e * 50, 2);
      if (A === 'alfred') chamfer(cx, y + 6, q(34 + e * 10, 2), hh, 8);
      else if (A === 'scout') hollow(cx, y + 6, q(44 + e * 12, 2), hh, 5);
      else hollow(cx, y + 6, q(26 + e * 8, 2), hh, 7);
    } else if (m === 'smile') {
      if (A === 'alfred') {                        // open grin: flat top, round bottom
        const half = 66, step = 6;
        for (let x = -half; x < half; x += step) { const u = (x + step / 2) / half; ctx.fillRect(cx + x, y - 10, Math.min(step, half - x), 6 + q(30 * Math.sqrt(Math.max(0, 1 - u * u)), 2)); }
      } else if (A === 'scout') {                  // the smirk grows into a lopsided grin
        const half = 60, step = 8;
        for (let x = -half; x < half; x += step) { const u = (x + step / 2) / half; ctx.fillRect(cx + x, y - q(u * u * 14 + (u + 1) * 5, 2), step, 7); }
      } else {                                     // maker: flat mouth, corners up in two hard steps
        ctx.fillRect(cx - 40, y, 80, 8); ctx.fillRect(cx - 56, y - 8, 16, 8); ctx.fillRect(cx + 40, y - 8, 16, 8);
        ctx.fillRect(cx - 64, y - 16, 8, 8); ctx.fillRect(cx + 56, y - 16, 8, 8);
      }
    } else if (m === 'frown') {
      if (A === 'alfred') {
        const half = 54, step = 8;
        for (let x = -half; x < half; x += step) { const u = Math.abs(x + step / 2) / half; ctx.fillRect(cx + x, y - 6 + q(u * u * 16, 4), step, 7); }
      } else if (A === 'scout') {                  // wobbly, unsure line
        for (let x = -40; x < 40; x += 8) ctx.fillRect(cx + x, y + ((x / 8) & 1 ? 4 : -2), 8, 6);
      } else {                                     // maker: flat line knocked off level
        for (let x = -48; x < 48; x += 8) ctx.fillRect(cx + x, y - 4 + q((x + 48) / 96 * 10, 2), 8, 7);
      }
    } else if (m === 'sleep') {
      if (A === 'alfred') { for (let x = -24; x < 24; x += 8) { const u = Math.abs(x + 4) / 24; ctx.fillRect(cx + x, y - q(u * u * 8, 2), 8, 7); } }
      else if (A === 'scout') ctx.fillRect(cx - 10, y, 36, 6);    // short, off-centre: the smirk, relaxed
      else { const s = q(8 + (Math.sin(t * 2 * Math.PI / 4600) * 0.5 + 0.5) * 8, 2); ctx.fillRect(cx - s / 2, y - s / 2 + 2, s, s); } // a little snore
    }
  }

  function drawEyes(look, ex, ey, blink, t, X) {
    ctx.fillStyle = '#000';
    for (const side of [-1, 1]) {
      const i = side < 0 ? 0 : 1;
      const cx = 256 + side * look.eyeGap + ex, cy = look.eyeY + ey;
      let box = null, top = cy - 36 * X.open;   // eye bounds this frame (for lids), and where brows sit
      if (X.closed) closedEye(cx, cy);
      else if (X.arc) arcEye(cx, cy);
      else if (S.agent === 'alfred') {            // tall solid rectangles with a catch-light
        const w = 58, h = Math.max(5, q(72 * X.open, 2) * (1 - blink));
        ctx.fillRect(cx - w / 2, cy - h / 2, w, h);
        const lid = X.lid ? X.lid[i] : 0, cut = lid > 0.02 ? lidOver(cx - w / 2, cy - h / 2, w, h, lid) : 0;
        if (blink < 0.5 && lid < 0.3) { ctx.fillStyle = '#fff'; ctx.fillRect(cx + 8, cy - h / 2 + cut + 8, 11, 11); ctx.fillStyle = '#000'; }  // catch-light sits under any lid
      } else if (S.agent === 'scout') {      // wide narrow slits with a sweeping scan gap
        const w = 92, h = Math.max(5, q(28 * X.open, 2) * (1 - blink));
        ctx.fillRect(cx - w / 2, cy - h / 2, w, h);
        if (blink < 0.5) {
          const sweep = q(Math.sin(t * 0.0021 + (side > 0 ? 0.6 : 0)) * (w / 2 - 14), 4);
          ctx.fillStyle = '#fff'; ctx.fillRect(cx + sweep - 6, cy - h / 2, 12, h); ctx.fillStyle = '#000';
        }
        box = [cx - w / 2, cy - h / 2, w, h]; top = cy - 14 * X.open;
      } else {                                // maker: hollow squares, solid core, focus ticks
        const s = q(62 * X.open, 2), h = Math.max(7, s * (1 - blink));
        if (blink > 0.55) { ctx.fillRect(cx - s / 2, cy - 4, s, 8); }
        else {
          ctx.fillRect(cx - s / 2, cy - h / 2, s, h);
          ctx.fillStyle = '#fff'; ctx.fillRect(cx - s / 2 + 9, cy - h / 2 + 9, s - 18, Math.max(0, h - 18));
          ctx.fillStyle = '#000'; ctx.fillRect(cx - 12 + ex * 0.4, cy - 12, 24, Math.min(24, h - 6));
          box = [cx - s / 2, cy - h / 2, s, h];
        }
      }
      if (box && X.lid && X.lid[i] > 0.02) lidOver(box[0], box[1], box[2], box[3], X.lid[i]);
      if (S.agent === 'maker') makerTicks(cx, cy, side, X, i);
      else if (X.brow && X.brow.y[i] != null) brow(cx, top, side, X, i);
    }
  }

  function drawMouth(look, level, t, X) {
    ctx.fillStyle = '#000';
    const cx = 256, y = look.mouthY + X.bob;
    if (X.mouth) { moodMouth(look, cx, y, t, X); return; }
    if (X.mode === 'thinking') {              // animated "..." while the agent works
      const n = 1 + (Math.floor(t / 320) % 3);
      for (let i = 0; i < 3; i++) if (i < n) ctx.fillRect(cx - 30 + i * 24, y - 6, 12, 12);
      return;
    }
    if (X.mode === 'listening') {              // small mouth that breathes in time, like it is taking in sound
      const p = (Math.sin(t * 0.009) * 0.5 + 0.5), p2 = (Math.sin(t * 0.0057 + 1) * 0.5 + 0.5);
      const w = q(14 + p * 22, 2), h = q(10 + p2 * 16, 2);
      ctx.fillRect(cx - w / 2, y - h / 2 + 4, w, h);
      return;
    }
    if (X.mode === 'working') {                // heads-down mouth, one per agent
      const fr = Math.floor(t / 140);
      if (S.agent === 'maker') {               // code lines flickering: blocks of varying length
        for (let i = 0; i < 4; i++) { const w = 10 + ((fr * 7 + i * 13) % 5) * 10; ctx.fillRect(cx - 52, y - 14 + i * 9, w, 5); }
      } else if (S.agent === 'scout') {        // scanner: a bar sweeping along a thin line
        ctx.fillRect(cx - 48, y, 96, 3);
        const sx = q((Math.sin(t * 0.004) * 0.5 + 0.5) * 72, 4); ctx.fillRect(cx - 48 + sx, y - 6, 24, 15);
      } else {                                  // alfred: marching dashes, composed
        for (let i = 0; i < 6; i++) if ((i + fr) % 2 === 0) ctx.fillRect(cx - 54 + i * 18, y - 2, 12, 6);
      }
      return;
    }
    const open = level > 0.06;
    if (open) {
      // Fable: the lip-sync shape channel (fricatives = wide and flat, vowels = round) widens/flattens the same block
      const sh = X.mode === 'speaking' ? q(S.shape || 0, 0.25) : 0;
      const w = look.mouthW * (1 - 0.28 * level + 0.22 * sh);
      const h = Math.max(6, q((8 + level * 66) * (1 - 0.5 * sh), 2));
      ctx.fillRect(cx - w / 2, y - h / 2 + 6, w, h);
      if (S.agent === 'scout') { ctx.fillStyle = '#fff'; ctx.fillRect(cx - w / 2 + 8, y - h / 2 + 6, w - 16, 3); }
      return;
    }
    // closed: a single stepped line with a resting smile (agent-specific curve); moods nudge the smile
    const step = 8, half = look.mouthW / 2;
    for (let x = -half; x < half; x += step) {
      const u = Math.abs(x + step / 2) / half;
      let lift = q((look.smile + X.smile) * u * u * 16, 4);
      if (S.agent === 'scout') lift = q(((x + half) / look.mouthW) * 8 * (1 + Math.min(0, X.smile)) + Math.max(0, X.smile) * u * u * 12, 4); // asymmetric smirk
      ctx.fillRect(cx + x, y - lift, step, 7);
    }
  }

  function drawFace(t) {
    if (lockAgent && !S.playing) S.agent = lockAgent;
    const look = LOOKS[S.agent] || LOOKS.alfred;
    const X = expression(t);
    // idle life: slow drift (pixel quantized), random blinks
    let ex = q(Math.sin(t * 0.00037) * 10 + Math.sin(t * 0.0009) * 4, 2);
    let ey = q(Math.sin(t * 0.00029 + 1) * 5, 2);
    if (X.mode === 'thinking') { ex = -16 + q(Math.sin(t * 0.002) * 3, 2); ey = -12; }
    if (X.mode === 'working') { ex = q(Math.sin(t * 0.0016) * 8, 2); ey = 10; }   // heads down, busy
    if (X.mode === 'listening') { ex = 0; ey = -6; S.nextBlink = Math.max(S.nextBlink, t + 1200); }  // eyes up and steady: all ears
    if (X.mode === 'speaking') ey += q(-S.level * 3, 1);
    if (X.gx !== null) ex = X.gx;
    if (X.gy !== null) ey = X.gy;
    if (X.mode === 'idle' && !X.closed && !X.arc && X.gx === null && window.RetroClock) {   // clock module (cuckoo): glance up at the clock now and then
      const gz = RetroClock.gaze(t); if (gz) { ex = gz.x; ey = gz.y; }
    }
    ey += X.bob;
    let blink = 0;
    if (X.closed || X.arc || X.noBlink) S.nextBlink = Math.max(S.nextBlink, t + 700);
    else {
      if (t > S.nextBlink) {
        S.blinkMs = X.blinkMs; S.blinkUntil = t + X.blinkMs;
        S.nextBlink = t + (S.doubleBlink ? 220 : X.slowBlink ? rnd(4000, 9000) : rnd(2200, 6200));
        S.doubleBlink = !S.doubleBlink && !X.slowBlink && Math.random() < 0.15;
      }
      if (t < S.blinkUntil) {
        if (S.blinkMs > 200) { const u = 1 - (S.blinkUntil - t) / S.blinkMs; blink = q(1 - Math.abs(2 * u - 1), 0.25); }  // slow, heavy blink
        else blink = 1;
      }
    }
    if (X.blinkNow) blink = 1;

    const m = S.mix, scale = 1 - 0.6 * m;
    const cx = 256 + (96 - 256) * m, cy = 171 + (158 - 171) * m;
    ctx.save();
    ctx.translate(cx, cy); ctx.scale(scale, scale); ctx.translate(-256, -171);
    drawEyes(look, ex, ey, blink, t, X);
    drawMouth(look, q(S.level, 0.125), t, X);
    if (X.zs) drawZs(look, t);
    ctx.fillStyle = '#000';
    ctx.font = 'bold 15px Menlo, "Courier New", monospace';
    ctx.textBaseline = 'alphabetic';
    const label = look.name.split('').join(' ');
    ctx.fillText(label, 256 - ctx.measureText(label).width / 2, 322);
    ctx.restore();
  }

  // ---------------------------------------------------------------- 1-bit pass
  // Fable perf: one 32-bit write per pixel instead of four byte writes + float multiplies (the old loop was the single
  // biggest CPU cost per frame on the 2017 i5). Output is identical: red < 128 -> FG else BG, odd rows dimmed by SCAN.
  const LE = new Uint8Array(new Uint32Array([0x0a0b0c0d]).buffer)[0] === 0x0d;
  const pack = (c, k) => (((255 << 24) | (Math.round(c[2] * k) << 16) | (Math.round(c[1] * k) << 8) | Math.round(c[0] * k)) >>> 0);
  function threshold() {
    const img = ctx.getImageData(0, 0, W, H), d = img.data;
    const FG = FGc, BG = BGc, scan = SCAN > 0.01, k0 = 1 - SCAN;
    if (LE) {
      const u = new Uint32Array(d.buffer), fg = pack(FG, 1), bg = pack(BG, 1), fgS = pack(FG, scan ? k0 : 1), bgS = pack(BG, scan ? k0 : 1);
      for (let row = 0, i = 0; row < H; row++) {
        const F = row & 1 ? fgS : fg, B = row & 1 ? bgS : bg;
        for (const end = i + W; i < end; i++) u[i] = (u[i] & 255) < 128 ? F : B;
      }
      ctx.putImageData(img, 0, 0);
      return;
    }
    let col = 0, row = 0;
    for (let i = 0; i < d.length; i += 4) {
      const c = d[i] < 128 ? FG : BG;
      const k = scan && (row & 1) ? k0 : 1;
      d[i] = c[0] * k; d[i + 1] = c[1] * k; d[i + 2] = c[2] * k; d[i + 3] = 255;
      if (++col === W) { col = 0; row++; }
    }
    ctx.putImageData(img, 0, 0);
  }

  // ------------------------------------------------------------------- audio
  function ensureAudio() {
    if (S.audioCtx) return S.audioCtx;
    const AC = window.AudioContext || window.webkitAudioContext;
    S.audioCtx = new AC();
    S.analyser = S.audioCtx.createAnalyser();
    S.analyser.fftSize = 1024;
    S.analyser.smoothingTimeConstant = 0;
    S.buf = new Float32Array(S.analyser.fftSize);
    S.analyser.connect(S.audioCtx.destination);
    return S.audioCtx;
  }
  function unlock() { try { ensureAudio().resume(); } catch (e) {} }
  addEventListener('pointerdown', unlock); addEventListener('keydown', unlock);

  function measureRms() {
    if (!S.analyser) return 0;
    S.analyser.getFloatTimeDomainData(S.buf);
    let sum = 0;
    for (let i = 0; i < S.buf.length; i++) sum += S.buf[i] * S.buf[i];
    return Math.sqrt(sum / S.buf.length);
  }

  function b64ToArrayBuffer(dataUrl) {
    const bin = atob(dataUrl.slice(dataUrl.indexOf(',') + 1));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes.buffer;
  }

  // Speech arrives one sentence at a time ({stream:{id, seq, total, final}}; an old server's whole-reply WAV is just a
  // one-chunk reply). Chunks are decoded in arrival order and scheduled back to back on the AudioContext clock, so
  // there is no gap between sentences. The chunk under the play head decides the agent, the emotion, the card and
  // (through the shared analyser) the mouth. Stop cuts every scheduled source and ignores late chunks of that reply.
  const P = { chain: Promise.resolve(), entries: [], nextAt: 0, stopUpto: 0, maxId: 0, cur: null, pending: 0,
    expectUntil: 0, gen: 0, live: false, gapMax: 0, chunks: 0 };
  const LIPS = window.RetroLips ? RetroLips.create() : { level: 0, shape: 0, peak: 0 };   // Fable lip-sync envelope state
  const SPEECH_EMOTIONS = new Set(['happy', 'thinking', 'surprised', 'curious', 'concerned', 'sleepy']);
  const clock = () => (P.live && S.audioCtx ? S.audioCtx.currentTime : performance.now() / 1000);
  function enqueueAudio(msg) {
    const id = msg.stream ? +msg.stream.id || 0 : 0;
    if (id && id <= P.stopUpto) return;                 // late chunk of a reply that was stopped
    if (id) P.maxId = Math.max(P.maxId, id);
    const gen = P.gen, ac = ensureAudio();
    P.pending++; S.queue.push(msg);
    P.chain = P.chain.then(async () => {
      let decoded = null;
      try { decoded = await ac.decodeAudioData(b64ToArrayBuffer(msg.audio)); } catch (e) { console.warn('decode failed', e); }
      P.pending--;
      if (gen !== P.gen || (id && id <= P.stopUpto) || !decoded) { const i = S.queue.indexOf(msg); if (i >= 0) S.queue.splice(i, 1); return; }
      schedule(msg, decoded);
    });
  }
  function schedule(msg, decoded) {
    const ac = S.audioCtx;
    if (!P.entries.length && !P.cur) { P.live = ac.state === 'running'; P.nextAt = 0; }
    const now = clock(), start = Math.max(now + 0.03, P.nextAt);
    if (P.nextAt && start - P.nextAt > P.gapMax) P.gapMax = start - P.nextAt;   // > 0 only if a chunk arrived late
    const e = { msg, start, end: start + decoded.duration, src: null };
    if (P.live) {
      const src = ac.createBufferSource();
      src.buffer = decoded; src.connect(S.analyser); src.start(start);
      e.src = src;
    }
    P.nextAt = e.end; P.entries.push(e); P.chunks++;
    S.playing = true; lastDraw = 0;
  }
  function activate(e, t) {                             // this chunk just reached the play head
    P.cur = e;
    const m = e.msg, i = S.queue.indexOf(m);
    if (i >= 0) S.queue.splice(i, 1);
    if (m.agent && LOOKS[m.agent]) S.agent = m.agent;
    S.mode = 'speaking'; S.progress = !!m.progress;
    S.emotion = SPEECH_EMOTIONS.has(m.emotion) ? m.emotion : null;
    if (!m.stream || !m.stream.seq) {                   // first sentence of a reply: card + zoom, as before
      LIPS.peak = 0;                                    // Fable lip-sync: new speaker, re-learn how loud this voice is
      if (window.RetroCards) RetroCards.zoom.reset();   // speech wins: face goes full screen, panels come back normal
      if (window.RetroWin) RetroWin.reset('speech');    // v1.1 windows always yield to speech
      if (m.card) setCard(m.card);
      else if (S.card && !m.progress) S.cardClearAt = performance.now() - 1;  // old card shrinks away as the new reply starts
    }
    if (!P.live) { S.simUntil = performance.now() + (e.end - clock()) * 1000; S.simSeed = Math.random() * 1000; }
    // more sentences of this reply are still being synthesized: hold the speaking face until they come (max 4s)
    P.expectUntil = m.stream && !m.stream.final ? t + Math.max(0, e.end - clock()) * 1000 + 4000 : 0;
    lastDraw = 0;
  }
  function audioTick(t) {
    const now = clock();
    while (P.entries.length && P.entries[0].end <= now) { const e = P.entries.shift(); if (e === P.cur) P.cur = null; }
    const e = P.entries[0];
    if (e && e.start <= now + 0.005 && P.cur !== e) activate(e, t);
    const more = P.pending > 0 || P.entries.length > 0 || t < P.expectUntil;
    if (more) { if (!S.playing) S.playing = true; }
    else if (S.playing) finishSpeech(t);
  }
  function finishSpeech(t) {
    const em = S.emotion;
    S.playing = false; S.mode = 'idle'; S.progress = false; S.emotion = null; P.cur = null; P.nextAt = 0; P.expectUntil = 0;
    S.queue.length = 0;
    if (em && EMOTES[em] && !M.emote) emote(em, t, 1500);   // the last tone lingers a moment after the words
    if (S.card) S.cardClearAt = performance.now() + 10000;
  }

  // Tap-to-stop: Space / Esc / click while the face is talking cuts the speech and the queue.
  // Panels: a click on a panel zooms it (never stops speech); Esc / click closes an open zoom first.
  function stopSpeech(fromServer, upto) {
    P.stopUpto = Math.max(P.stopUpto, +upto || 0, P.maxId);
    if (!S.playing && !S.queue.length && !P.entries.length && !P.pending) return;
    P.gen++;
    for (const e of P.entries) if (e.src) { try { e.src.onended = null; e.src.stop(); } catch (x) {} }
    P.entries = []; P.cur = null; P.nextAt = 0; P.expectUntil = 0;
    S.queue.length = 0;
    S.simUntil = 0;
    S.playing = false; S.mode = 'idle'; S.level = 0; S.progress = false; S.emotion = null;
    if (S.card) S.cardClearAt = performance.now() + 10000;
    if (!fromServer) fetch('/stop', { method: 'POST' }).catch(() => {});
  }
  // Push-to-talk (temporary mode, server setting `ptt`; `~/retro-mac/ptt on|off`): with it on the wake word is ignored and
  // Space is the talk key. Space = STOP while the face is speaking (as always); idle -> POST /ptt starts a listening turn;
  // while recording -> POST /ptt again ends it now and sends it. The server decides (busy -> 409, nothing happens).
  // Kiosk page only (a ?test page needs ?ptt); ignores key repeat and taps <400 ms apart, an unfocused page and text inputs.
  const PTT_URL = params.has('ptt'), PTT_OK = !params.has('test') || PTT_URL;
  let pttOn = PTT_URL, lastSpace = 0, pttDiag = { sent: 0, last: null };
  function speechActive() {
    const vs = window.RetroBanner ? RetroBanner.state().state : 'idle';
    return S.playing || S.queue.length > 0 || P.entries.length > 0 || P.pending > 0 || vs === 'speaking';
  }
  function typingTarget(el) {
    if (!el || !el.tagName) return false;
    const tag = el.tagName;
    return tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable ||
      (tag === 'INPUT' && !['range', 'button', 'checkbox', 'radio'].includes((el.type || '').toLowerCase()));
  }
  function pttSpace(e) {
    if (e.repeat) return;                                           // holding Space: only the first keydown counts (no /ptt, /stop or flicker spam)
    if (speechActive()) {                                           // first tap stops, exactly as today (no debounce on STOP)
      const local = S.playing || S.queue.length > 0 || P.entries.length > 0 || P.pending > 0;
      lastSpace = performance.now();
      stopSpeech(false);
      if (!local) fetch('/stop', { method: 'POST' }).catch(() => {});
      return;
    }
    if (e.repeat || !document.hasFocus()) return;
    const now = performance.now();
    if (now - lastSpace < 400) return;
    lastSpace = now;
    const vs = window.RetroBanner ? RetroBanner.state().state : 'idle';
    if (vs === 'working' || vs === 'transcribing') return;          // a reply is on its way: nothing to start or stop here
    pttDiag.sent++;
    fetch('/ptt', { method: 'POST' }).then(r => r.json().catch(() => ({}))).then(j => { pttDiag.last = j; }).catch(() => { pttDiag.last = { error: 'fetch' }; });
  }
  // Ask for keyboard focus whenever we can (load, becoming visible, any pointer movement): a kiosk window that is not
  // the key window never receives keydown. window.focus() is best effort; Chrome ignores it for unfocused app windows.
  function grabFocus() { try { window.focus(); if (document.body) { if (document.body.tabIndex < 0) document.body.tabIndex = -1; document.body.focus({ preventScroll: true }); } } catch (x) {} }
  grabFocus(); addEventListener('load', grabFocus); addEventListener('pointermove', grabFocus, { passive: true });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) grabFocus(); });
  addEventListener('keydown', (e) => {
    const RW = window.RetroWin;
    if (RW) RW.touch(performance.now());
    // Fable easter egg: ? (or Cmd+?) opens the About box, dashboard only, never while the face is talking
    if (e.key === '?' && RW && HOME === 'dash' && !typingTarget(e.target) && !speechActive() && S.mix >= 0.99) {
      const now = performance.now(); RW.toggle('about', null, now); busyUntil = now + 400; lastDraw = 0; e.preventDefault(); return;
    }
    if (e.key === 'Escape' && RW && RW.isOpen() && !speechActive()) { winClose('esc'); e.preventDefault(); return; }   // speech: Esc still stops it
    if (e.key === 'Escape' && window.RetroCards && RetroCards.zoom.isOpen()) { zoomClose(); e.preventDefault(); return; }
    if (e.key === ' ' && pttOn && PTT_OK && !typingTarget(e.target)) { pttSpace(e); e.preventDefault(); return; }
    if (e.key === ' ' || e.key === 'Escape') { stopSpeech(false); e.preventDefault(); }
    // v1.1 click-in windows: 1 TODAY 2 CREW 3 WEATHER 4 HOUSE 5 ALERTS 6 LIMITS 7 LOG (same key closes), <- -> cycle while open
    if (RW && !e.metaKey && !e.ctrlKey && !e.altKey && !e.repeat && !typingTarget(e.target) && HOME === 'dash') {
      const now = performance.now();
      if (/^[1-7]$/.test(e.key)) {
        if (S.playing || S.queue.length || S.mix < 0.99) return;          // the face owns the screen while it talks
        const key = RW.ORDER[+e.key - 1], src = { today: 'agenda', crew: 'crew', weather: 'weather' }[key];
        RW.toggle(key, hitRects.find(h => h.key === src) || null, now); busyUntil = now + 400; lastDraw = 0;
      } else if ((e.key === 'ArrowRight' || e.key === 'ArrowLeft') && RW.isOpen()) { RW.cycle(e.key === 'ArrowRight' ? 1 : -1, now); lastDraw = 0; }
    }
  });
  // 'PTT' tag, bottom-right corner of the screen while push-to-talk mode is on (1-bit: black plate, white letters).
  function drawPttTag() {
    const w = 30, h = 12, x = W - 54, y = H - 15;          // the strip under the panels (they end at y=324), clear of the rounded corner
    ctx.fillStyle = '#000'; ctx.fillRect(x, y, w, h);
    ctx.fillStyle = '#fff'; ctx.fillRect(x + 1, y + 1, w - 2, 1); ctx.fillRect(x + 1, y + h - 2, w - 2, 1);
    ctx.fillRect(x + 1, y + 1, 1, h - 2); ctx.fillRect(x + w - 2, y + 1, 1, h - 2);
    ctx.fillStyle = '#fff'; ctx.font = 'bold 10px Menlo, monospace'; ctx.textBaseline = 'middle'; ctx.fillText('PTT', x + 4, y + h / 2 + 1);
  }
  // Skin switcher tag (v1 look): a tiny boxed "AOL" in the empty strip above the weather panel, top-right. Drawn only on the plain
  // dashboard (same rule as the key legend) and only when a skin is installed; a click/tap signs on to the AOL skin. Additive: nothing
  // else in the v1 layout moves. The skin draws its own way back (taskbar "Mac" button / Start menu).
  let skinTag = null;
  function drawSkinTag() {
    skinTag = null;
    if (!window.RetroAOL || !THEMES.aol) return;
    ctx.font = 'bold 9px Menlo, monospace'; ctx.textBaseline = 'middle';
    const s = 'AOL', w = Math.ceil(ctx.measureText(s).width) + 8, h = 11, x = W - 18 - w, y = 4;
    ctx.fillStyle = '#fff'; ctx.fillRect(x, y, w, h);
    ctx.fillStyle = '#000'; ctx.fillRect(x, y, w, 1); ctx.fillRect(x, y + h - 1, w, 1); ctx.fillRect(x, y, 1, h); ctx.fillRect(x + w - 1, y, 1, h);
    ctx.fillText(s, x + 4, y + h / 2 + 1);
    skinTag = { x: x - 4, y: 0, w: w + 8, h: h + 8 };     // a little slack for fingers
  }
  function skinTagClick(x, y) {
    const r = skinTag; if (!r || x < r.x || x >= r.x + r.w || y < r.y || y >= r.y + r.h) return false;
    switchSkin(true); return true;
  }
  function bannerClick(e) {
    if (!window.RetroBanner || (e.target !== canvas && e.target !== document.body && e.target !== canvas.parentNode)) return false;
    const r = canvas.getBoundingClientRect();
    return RetroBanner.hit((e.clientX - r.left) * W / r.width, (e.clientY - r.top) * H / r.height);
  }
  addEventListener('click', (e) => { if (T.skin && window.RetroAOL && skinClick(e)) return;   // the AOL skin routes its own windows/buttons
    if (bannerClick(e)) {
      stopSpeech(false);
      const bs = window.RetroBanner && RetroBanner.state();   // 'STILL TRYING... TAP TO CANCEL': the tap cancels the stuck turn
      if (bs && bs.state === 'working' && bs.turn && bs.turn.stuck) fetch('/stop', { method: 'POST' }).catch(() => {});
      return;
    } if (!panelClick(e)) stopSpeech(false); });

  // ---------------------------------------------------------- panel zoom
  let hitRects = [], lastPanelClick = 0;   // panel rects drawn last frame (canvas coords)
  // ---- skin hook (theme "aol"): aol.js draws the whole frame from the same state; nothing here runs for other themes
  function skinClick(e) {
    if (e.target !== canvas && e.target !== document.body && e.target !== canvas.parentNode) return false;
    const r = canvas.getBoundingClientRect();
    return !!RetroAOL.click((e.clientX - r.left) * W / r.width, (e.clientY - r.top) * H / r.height, performance.now());
  }
  const skinAPI = {
    S, M, W, H, params, canvas, dash: () => dash, cur: () => P.cur, hour: hourNow, ptt: () => pttOn && PTT_OK, theme: () => themeName,
    speechActive, stop: () => stopSpeech(false), winClose, emote, switchSkin,
    drawFace: (t, mix) => { const keep = S.mix; S.mix = mix; drawFace(t); S.mix = keep; },
  };
  function zoomClose() { RetroCards.zoom.close(performance.now()); busyUntil = performance.now() + RetroCards.zoom.MS + 120; }
  function winClose(why) { RetroWin.close(performance.now(), why); busyUntil = performance.now() + 400; lastDraw = 0; }
  const WIN_OF = { weather: 'weather', agenda: 'today', crew: 'crew' };     // dashboard panel -> v1.1 click-in window
  function panelClick(e) {
    const RC = window.RetroCards, RW = window.RetroWin;
    if (!RC || !RC.zoom) return false;
    if (e.target !== canvas && e.target !== document.body && e.target !== canvas.parentNode) return false; // buttons, slider
    const now = performance.now();
    if (speechActive()) return false;        // while speech plays a tap anywhere stops it, exactly as in v1
    const r = canvas.getBoundingClientRect();
    const x = (e.clientX - r.left) * W / r.width, y = (e.clientY - r.top) * H / r.height;
    if (skinTagClick(x, y)) { lastPanelClick = now; return true; }   // tiny AOL tag (only present on the plain dashboard)
    if (window.RetroClock && RetroClock.click(x, y)) { lastPanelClick = now; lastDraw = 0; return true; }   // tiny CLK tag: cycles the clock variants
    const mb = RW && menubarOn && HOME === 'dash' ? RW.menubarHit(x, y) : null;   // Fable menu bar: apple = About, titles = windows
    if (mb) {
      if (mb === 'aol') switchSkin(true);
      else { RW.toggle(mb, hitRects.find(h => h.key === ({ today: 'agenda', crew: 'crew', weather: 'weather' })[mb]) || null, now); busyUntil = now + 400; }
      lastPanelClick = now; lastDraw = 0; return true;
    }
    if (RW && RW.isOpen()) {                 // close box / outside closes; a click inside just keeps it open
      const h = RW.hit(x, y);
      if (h === 'inside') RW.touch(now); else winClose(h === 'close' ? 'closebox' : 'outside');
      lastPanelClick = now; return true;
    }
    if (RC.zoom.isOpen()) { zoomClose(); lastPanelClick = now; return true; }
    const lk = RW && HOME === 'dash' ? RW.legendHit(x, y) : null;
    if (lk) { RW.open(lk, hitRects.find(h => h.key === ({ today: 'agenda', crew: 'crew', weather: 'weather' })[lk]) || null, now); busyUntil = now + 400; lastPanelClick = now; lastDraw = 0; return true; }
    const hit = hitRects.find(h => x >= h.x && x < h.x + h.w + 3 && y >= h.y && y < h.y + h.h + 3);
    if (!hit) return false;
    if (RW && WIN_OF[hit.key] && HOME === 'dash') RW.open(WIN_OF[hit.key], hit, now);
    else RC.zoom.open(hit.key, hit, now);
    busyUntil = now + RC.zoom.MS + 120; lastPanelClick = now; lastDraw = 0;
    return true;
  }

  function setCard(card) {
    if (card && window.RetroCards) RetroCards.zoom.reset();   // a fresh card is never hidden behind a zoom
    if (card && window.RetroWin) RetroWin.reset('card');
    S.card = card || null;
    S.cardAt = performance.now();
    S.cardClearAt = 0;
  }

  // ----------------------------------------------------------------- socket
  let retry = 500, build = null;
  function connect() {
    const ws = new WebSocket(`ws://${location.host}/ws`);
    ws.onopen = () => { retry = 500; };
    ws.onclose = () => { setTimeout(connect, retry); retry = Math.min(retry * 2, 8000); };
    ws.onerror = () => ws.close();
    ws.onmessage = (ev) => {
      let m; try { m = JSON.parse(ev.data); } catch (e) { return; }
      if (m.type === 'settings') { if (!PTT_URL) pttOn = !!m.ptt; if (!MENUBAR_URL) menubarOn = !!m.menubar; if (window.RetroClock && m.clock !== undefined) RetroClock.setting(m.clock); if (window.RetroAOL && m.screen_name) RetroAOL.setScreenName(m.screen_name); if (!urlTheme) applyTheme(m.theme); if (typeof m.tone === 'number' && urlTone === null) setTone(m.tone); return; }
      if (m.type === 'wipe') { window.dispatchEvent(new CustomEvent('rm-wipe', { detail: m })); return; }   // burnin.js: clearing mode
      if (m.type === 'dash') { dash = m; if (window.RetroTime) RetroTime.setTz(m.tz); return; }
      if (m.type === 'crew') { const prev = S.crew; S.crew = m.crew; if (window.RetroCards) RetroCards.noteCrew(m.crew); crewMood(prev, m.crew); return; }
      if (m.type === 'stop') { stopSpeech(true, m.upto); return; }
      if (m.type === 'voice' || m.type === 'level') {
        if (window.RetroBanner) RetroBanner.onMsg(m);
        if (m.type === 'voice') { voiceCheck(performance.now()); lastDraw = 0; }   // react (and wake) on the very next frame
        return;
      }
      if (m.type === 'hello') {                 // server/web files changed since this page loaded -> reload once
        if (build && m.build && m.build !== build) { setTimeout(() => location.reload(), 300); return; }
        build = build || m.build;
        try { ws.send(JSON.stringify({ type: 'hello', build, caps: ['stream'] })); } catch (e) {}   // stream = per-sentence audio
        return;
      }
      if (m.agent && LOOKS[m.agent] && !S.playing) S.agent = m.agent;
      if (m.state === 'speaking' || m.state === 'thinking') { poke(performance.now(), m.state === 'speaking'); lastDraw = 0; }
      if (m.state === 'speaking' && m.audio) { enqueueAudio(m); return; }
      if (m.state === 'thinking' && !S.playing) S.mode = 'thinking';
      else if (m.state === 'idle' && !S.playing) S.mode = 'idle';
      if (m.card !== undefined && m.state !== 'speaking') { if (m.card === null) S.tile = null; setCard(m.card); }
    };
  }

  // ------------------------------------------------------------------- loop
  let last = performance.now(), lastDraw = 0, busyUntil = 0;
  function frame(t) {
    // Power saver: full 30fps only while something is happening; ~12fps when the screen is just idling, ~9fps asleep.
    const fast = S.playing || (S.queue && S.queue.length) || t < busyUntil || (S.card && t - S.cardAt < 1000) || (window.RetroWin && RetroWin.busy(t))
      || (T.skin && window.RetroAOL && RetroAOL.busy(t)) || (window.RetroClock && RetroClock.busy(t));
    const active = fast || S.mode !== 'idle' || S.card || (window.RetroBanner && RetroBanner.active());
    const idleMs = M.shown === 'sleep' ? 110 : M.shown === 'rest' ? 95 : 80;
    if (t - lastDraw < (fast ? 30 : active ? 66 : idleMs)) { requestAnimationFrame(frame); return; }
    lastDraw = t;
    if (S.mix > 0.01 && S.mix < 0.99) busyUntil = t + 300;
    if (S.shrinkAt && t - S.shrinkAt < 600) busyUntil = Math.max(busyUntil, t + 100);
    const dt = t - last; last = t;
    audioTick(t);                                  // which speech chunk is under the play head (agent, emotion, card)
    if ((S.playing || S.queue.length) && window.RetroWin && RetroWin.key()) RetroWin.reset('speech');   // speech always wins
    // who is working right now (crew panel data) drives the face when nobody is speaking
    if (!S.playing && !S.queue.length && S.crew) {
      let best = null;
      for (const a of ['alfred', 'scout', 'maker']) {
        const c = S.crew[a];
        if (c && c.status !== 'idle' && (!best || c.ts > best.ts)) best = { agent: a, status: c.status, ts: c.ts };
      }
      if (best) { S.agent = best.agent; S.mode = best.status; }
      else if (S.mode === 'working' || S.mode === 'thinking' || S.mode === 'listening') S.mode = 'idle';
    }
    moodTick(t);
    // lip sync: fast attack, slow release, from the audio's RMS (or a soft fake while muted)
    // Fable: RetroLips (web/lipsync.js) = frame-rate independent envelope + per-voice auto gain + noise gate + a
    // shape channel from the zero-crossing rate. The muted fake and the legacy rule stay as fallbacks.
    let raw = 0;
    if (S.mode === 'speaking' && t >= S.simUntil && window.RetroLips && S.analyser) {
      S.analyser.getFloatTimeDomainData(S.buf);
      const mm = RetroLips.measure(S.buf);
      RetroLips.step(LIPS, mm.rms, mm.zcr, dt);
      S.level = LIPS.level; S.shape = LIPS.shape;
    } else {
      if (S.mode === 'speaking') {
        raw = t < S.simUntil
          ? 0.5 + 0.5 * Math.sin(t * 0.021 + S.simSeed) * Math.sin(t * 0.0067 + S.simSeed * 2)
          : clamp(measureRms() * 4.2, 0, 1);
        raw = Math.pow(clamp(raw, 0, 1), 0.8);
      }
      S.level += (raw - S.level) * (raw > S.level ? 0.55 : 0.16);
      S.shape = 0; LIPS.level = S.level; LIPS.shape = 0;
    }
    if (S.mode !== 'speaking' && S.level < 0.02) S.level = 0;

    if (S.cardClearAt && t > S.cardClearAt) {      // a finished card shrinks into a mini tile
      S.tile = S.card; S.tileUntil = t + 15 * 60 * 1000; S.shrinkAt = t;
      S.card = null; S.cardClearAt = 0;
    }
    if (S.tile && t > S.tileUntil) S.tile = null;
    // face fills the screen while talking/thinking; otherwise it steps aside for the dashboard
    const aside = S.card || (HOME === 'dash' && S.mode !== 'speaking' && !S.playing && !S.queue.length);
    const target = aside ? 1 : 0;
    S.mix = clamp(S.mix + Math.sign(target - S.mix) * dt / 320, 0, 1);

    if (T.skin && window.RetroAOL) {               // AOL skin: same state, different screen (colour, no 1-bit pass)
      RetroAOL.frame(ctx, t, skinAPI); hitRects = [];
      if (window.RetroWin) RetroWin.menubarClear();    // Fable: no stale menu-bar hit rects under the skin
      if (window.RetroClock) RetroClock.hide();        // clock module: the AOL taskbar keeps its own clock
      if (dbg) dbg.textContent = `${S.agent} ${S.mode} mood=${M.label} skin=aol ${RetroAOL.debug().phase}`;
      requestAnimationFrame(frame); return;
    }
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, W, H);
    ctx.save();
    // step the shrink so it reads as a retro cut, not a smooth zoom
    const keep = S.mix; S.mix = q(S.mix, 1 / 6);
    drawFace(t);
    S.mix = keep;
    ctx.restore();
    if (S.mix >= 0.99) {
      const RC = window.RetroCards;
      RC.drawCrew(ctx, S.crew, S.playing ? S.agent : null, t);
      hitRects = [{ key: 'crew', ...RC.CREW }];
      if (S.card) { RC.drawCard(ctx, S.card, clamp((t - S.cardAt) / 900, 0, 1)); hitRects.push({ key: 'card', ...RC.CARD }); }
      else if (HOME === 'dash') {
        const L = RC.layout(!!S.tile);
        RC.drawWeather(ctx, dash.weather, L.weather, t);
        RC.drawAgenda(ctx, dash.agenda, L.agenda);
        hitRects.push({ key: 'weather', ...L.weather }, { key: 'agenda', ...L.agenda });
        if (S.tile) {
          const p = clamp((t - S.shrinkAt) / 450, 0, 1);
          RC.drawTile(ctx, S.tile, p < 1 ? RC.lerpRect(RC.CARD, L.tile, q(p, 1 / 6)) : L.tile);
          hitRects.push({ key: 'tile', ...L.tile });
        }
      }
      if (window.RetroWin) RetroWin.badges(ctx, hitRects, { agenda: dash.agenda });
      if (window.RetroWin && menubarOn && HOME === 'dash') RetroWin.menubar(ctx, { key: RetroWin.key(), skin: !!(window.RetroAOL && THEMES.aol) });   // Fable: under windows, like the panels
      else if (window.RetroWin) RetroWin.menubarClear();
      RC.drawZoom(ctx, { weather: dash.weather, agenda: dash.agenda, crew: S.crew,
        speaker: S.playing ? S.agent : null, card: RC.zoom.key() === 'tile' ? S.tile : S.card }, t);
      if (window.RetroWin) RetroWin.draw(ctx, { weather: dash.weather, agenda: dash.agenda, day: dash.day, crew: S.crew, ptt: pttOn && PTT_OK }, t);
    } else hitRects = [];

    if (S.audioCtx && S.audioCtx.state !== 'running' && (S.playing || S.queue.length || params.has('test'))) {
      ctx.fillStyle = '#000'; ctx.font = '11px Menlo, monospace'; ctx.textBaseline = 'top';
      ctx.fillText('CLICK ONCE FOR SOUND', 6, 6);
    }
    if (window.RetroWin) {                         // v1.1 key legend: plain dashboard only (yields to windows, zooms, banners, speech)
      const RW = window.RetroWin, RC2 = window.RetroCards;
      if (S.mix >= 0.99 && HOME === 'dash' && !RW.key() && !(RC2 && RC2.zoom.isOpen()) && !(window.RetroBanner && RetroBanner.active()) && !S.playing && !S.queue.length)
        { RW.legend(ctx, { D: { agenda: dash.agenda }, ptt: pttOn && PTT_OK, dim: M.shown === 'sleep' }); if (!menubarOn) drawSkinTag(); else skinTag = null; }
      else { RW.legendClear(); skinTag = null; }
    }
    if (pttOn && PTT_OK) drawPttTag();
    if (window.RetroClock) {                       // opt-in clock module (key C / CLK tag): off by default; may take the whole screen as a screensaver
      const RWk = window.RetroWin, RCk = window.RetroCards, bn = window.RetroBanner && RetroBanner.active();
      const own = S.playing || S.queue.length || S.card || bn || (RWk && RWk.key()) || (RCk && RCk.zoom.isOpen());
      const ok = S.mix >= 0.99 && HOME === 'dash' && !own;
      RetroClock.draw(ctx, t, { ok, tag: ok, busy: !!own || S.mode !== 'idle', agent: S.agent, menubar: menubarOn, skin: false });
    }
    if (window.RetroBanner) RetroBanner.draw(ctx, t);
    threshold();
    if (dbg) dbg.textContent = `${S.agent} ${S.mode} mood=${M.label} h=${hourNow(t).toFixed(1)} quiet=${Math.round((t - M.lastAct) / 1000)}s lvl=${S.level.toFixed(2)} ctx=${S.audioCtx ? S.audioCtx.state : 'none'}`;
    requestAnimationFrame(frame);
  }

  // --------------------------------------------------------- test panel (?test)
  const dbg = params.has('debug') || params.has('test') ? document.getElementById('dbg') : null;
  if (dbg) dbg.style.display = 'block';
  if (params.has('test')) {
    const box = document.getElementById('test'); box.style.display = 'flex';
    const post = (body) => fetch('/speak', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...body, force: true }) });
    const btn = (label, fn) => { const b = document.createElement('button'); b.textContent = label; b.onclick = () => { unlock(); fn(); }; box.appendChild(b); return b; };
    btn('Alfred', () => post({ agent: 'alfred', text: 'Good morning. Everything is running smoothly, and I have nothing urgent for you.' }));
    btn('Scout', () => post({ agent: 'scout', text: 'Scout here. I found three new leads overnight, and one of them looks promising.' }));
    btn('Maker', () => post({ agent: 'maker', text: 'Maker reporting. The build finished, all tests passed, and the update is ready to ship.' }));
    btn('Card: list', () => post({ agent: 'alfred', text: 'Today you have these things on the calendar:\n- 9:00 Standup with the team\n- 11:30 Call with Sam\n- 3:15 School pickup\n- 6:30 Climbing gym' }));
    btn('Card: number', () => post({ agent: 'scout', text: 'It is currently sixty eight degrees outside.', card: { type: 'number', title: 'WEATHER', value: '68', unit: 'DEGREES F', sub: 'Partly cloudy, light wind from the west.' } }));
    const act = (agent, status, label) => fetch('/activity', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ agent, status, label }) });
    btn('Maker codes', () => act('maker', 'working', 'CODING face.js'));
    btn('Scout searches', () => act('scout', 'working', 'SEARCHING'));
    btn('Alfred thinks', () => act('alfred', 'thinking', 'THINKING'));
    btn('All idle', () => ['alfred', 'scout', 'maker'].forEach(a => act(a, 'idle', '')));
    btn('Theme (T)', cycleTheme);
    btn('Fullscreen (F)', toggleFullscreen);
    btn('Clear card', () => fetch('/event', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ agent: S.agent, state: 'idle', card: null }) }));
    // local-only previews (nothing is sent to the server, the kiosk is unaffected)
    const moodBtn = btn(`Mood: ${previewMood || 'auto'}`, () => {
      previewMood = MOODS[(MOODS.indexOf(previewMood || 'auto') + 1) % MOODS.length];
      if (previewMood === 'auto') previewMood = null;
      if (!S.playing) { S.mode = 'idle'; S.simUntil = 0; }
      M.emote = null; M.ambSeen = null;
      moodBtn.textContent = `Mood: ${previewMood || 'auto'}`;
    });
    const agentBtn = btn(`Agent: ${lockAgent || 'auto'}`, () => {
      const order = [null, 'alfred', 'scout', 'maker'];
      lockAgent = order[(order.indexOf(lockAgent) + 1) % order.length];
      agentBtn.textContent = `Agent: ${lockAgent || 'auto'}`;
    });
  }
  addEventListener('pointerdown', () => poke(performance.now(), false));
  let lastMove = 0;
  addEventListener('mousemove', () => { const t = performance.now(); if (t - lastMove > 1000) { lastMove = t; poke(t, false); } });

  window.RetroFace = {
    info: () => ({ playing: S.playing || S.queue.length > 0, agent: S.agent, crew: S.crew, emotion: S.emotion,
      progress: S.playing && P.cur ? !!S.progress : !!(S.queue[0] && S.queue[0].progress) }),
    speech: () => ({ playing: S.playing, chunks: P.chunks, scheduled: P.entries.length, decoding: P.pending, gapMaxMs: Math.round(P.gapMax * 1000),
      live: P.live, emotion: S.emotion, progress: !!S.progress, stopUpto: P.stopUpto, text: P.cur ? P.cur.msg.text : null }),
    mood: () => ({ mood: M.label, ambient: M.amb, emote: M.emote, voice: M.voice, hour: hourNow(performance.now()), quietS: (performance.now() - M.lastAct) / 1000 }),
    ptt: () => ({ on: pttOn, url: PTT_URL, ok: PTT_OK, ...pttDiag }),
    lips: () => ({ level: S.level, shape: S.shape || 0, peak: LIPS.peak, menubar: menubarOn }),
    audio: () => { try { return ensureAudio(); } catch (e) { return null; } },
  };
  applyTheme(urlTheme || 'green');
  if (urlTone !== null) setTone(urlTone);
  connect();
  requestAnimationFrame(frame);
})();

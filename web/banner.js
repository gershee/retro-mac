// Retro Mac: voice status banner. Big, high-contrast, 1-bit strip across the top of the screen that tells the user,
// from across the room, where a spoken request is: HEARD -> LISTENING (mic meter + countdown) -> GOT IT ->
// WORKING mm:ss (step, crew, progress) -> SPEAKING (tap to stop) -> DONE, or DIDN'T CATCH THAT / STOPPED, or
// LIMIT HIT / SOMETHING WENT WRONG (state 'failed': the turn died on a provider error; 'STILL TRYING... TAP TO CANCEL'
// replaces the WORKING sub-line when the watchdog sees 3 minutes without activity).
// Voice turns also get a step checklist under WORKING (spinner = running, check = done, last 4, from the hook's
// tool captions) and the line he is hearing while the agent narrates mid-turn ("Checking your calendar.").
// The server owns the state (/voice_state, broadcast as {type:'voice'} and {type:'level'} on /ws); this file only
// renders it. Drawn black-on-white like everything else; face.js thresholds the frame to the theme colours.
// Earcons: tiny WebAudio square-wave blips (no files) on wake / follow-up / done, only while the server is armed.
(function () {
  const W = 512;
  const MONO = 'Menlo, "Courier New", monospace';
  const font = (px, bold) => `${bold ? 'bold ' : ''}${px}px ${MONO}`;
  const FULL = new Set(['heard', 'listening', 'transcribing', 'working', 'error', 'done', 'stopped', 'failed']);
  const BAR_H = 40, BOX_H = 34, SLIM_H = 16, BOX1_H = 20;
  const STEPS_MAX = 4, STEP_H = 15, STEP_PAD = 3;          // step checklist rows (voice turns)

  let V = { state: 'idle', since: 0, note: '', followup: false, window: 0, armed: false, turn: null, pending: [] };
  let skew = 0;                       // server clock - local clock (seconds)
  let L = { l: 0, s: 0, sp: false, at: 0 }, shown = 0;   // mic level + smoothed meter
  let flashUntil = 0, doneTimer = 0, enteredAt = 0;
  let lastRect = null;                // what we covered last frame (canvas coords) for click routing

  const srvNow = () => Date.now() / 1000 + skew;
  const mmss = (s) => { s = Math.max(0, Math.floor(s)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };

  // ------------------------------------------------------------------ earcons
  function tone(ac, f, t0, dur, g) {
    const o = ac.createOscillator(), gn = ac.createGain();
    o.type = 'square'; o.frequency.value = f;
    gn.gain.setValueAtTime(0, t0);
    gn.gain.linearRampToValueAtTime(g, t0 + 0.006);
    gn.gain.setValueAtTime(g, t0 + dur - 0.02);
    gn.gain.linearRampToValueAtTime(0, t0 + dur);
    o.connect(gn); gn.connect(ac.destination);
    o.start(t0); o.stop(t0 + dur + 0.03);
  }
  const EARCONS = { wake: [[660, 0.07], [990, 0.09]], followup: [[880, 0.07]], done: [[990, 0.07], [660, 0.1]] };
  let earconsPlayed = 0, flashes = 0;
  function earcon(kind) {
    if (!V.armed) return;                         // he is not here / did not talk to us: stay silent
    const ac = window.RetroFace && RetroFace.audio();
    if (!ac || ac.state !== 'running') return;
    let t = ac.currentTime + 0.01;
    for (const [f, d] of EARCONS[kind]) { tone(ac, f, t, d, 0.035); t += d + 0.015; }
    earconsPlayed++;
  }

  // ------------------------------------------------------------------ messages
  function onMsg(m) {
    if (m.type === 'level') { L = { l: +m.l || 0, s: +m.s || 0, sp: !!m.sp, at: performance.now() }; return; }
    if (typeof m.now === 'number') skew = m.now - Date.now() / 1000;
    const prev = V.state;
    V = Object.assign({}, V, m);
    if (m.state !== prev) enter(m.state, prev);
  }
  function enter(st, prev) {
    const now = performance.now();
    enteredAt = now;
    if (st === 'heard') { flashUntil = now + 180; earcon('wake'); L = { l: 0, s: 0, sp: false, at: 0 }; }
    else if (st === 'listening' && prev !== 'heard') {
      flashUntil = now + 140; L = { l: 0, s: 0, sp: false, at: 0 };
      if (V.followup) earcon('followup');
    } else if (st === 'error' || st === 'failed') flashUntil = now + 160;
    if (st === 'done') {
      clearTimeout(doneTimer);
      doneTimer = setTimeout(() => { if (V.state === 'done' || V.state === 'idle') earcon('done'); }, 900);
    } else if (st === 'listening' || st === 'heard') clearTimeout(doneTimer);
  }

  // ------------------------------------------------------------------ glyphs (16x16, white on the black bar)
  function glyph(ctx, st, x, y, f) {
    ctx.fillStyle = '#fff';
    if (st === 'listening' || st === 'heard') {             // microphone + pulsing arcs
      ctx.fillRect(x + 5, y, 6, 10); ctx.fillRect(x + 2, y + 7, 2, 4); ctx.fillRect(x + 12, y + 7, 2, 4);
      ctx.fillRect(x + 4, y + 11, 8, 2); ctx.fillRect(x + 7, y + 13, 2, 3); ctx.fillRect(x + 4, y + 15, 8, 1);
      if (f % 4 >= 1) { ctx.fillRect(x - 3, y + 2, 2, 8); ctx.fillRect(x + 17, y + 2, 2, 8); }
      if (f % 4 >= 2) { ctx.fillRect(x - 7, y + 4, 2, 4); ctx.fillRect(x + 21, y + 4, 2, 4); }
    } else if (st === 'transcribing') {                       // three dots wave
      for (let i = 0; i < 3; i++) ctx.fillRect(x + i * 6, y + 7 - ((f + i) % 3 === 0 ? 4 : 0), 4, 4);
    } else if (st === 'working') {                            // rotating 2x2 blocks
      const pts = [[0, 0], [8, 0], [8, 8], [0, 8]];
      pts.forEach(([dx, dy], i) => { if (i !== f % 4) ctx.fillRect(x + dx, y + dy, 7, 7); });
    } else if (st === 'error' || st === 'failed') {          // X
      for (let i = 0; i < 8; i++) { ctx.fillRect(x + i * 2, y + i * 2, 3, 3); ctx.fillRect(x + 14 - i * 2, y + i * 2, 3, 3); }
    } else if (st === 'done') {                               // check mark
      for (let i = 0; i < 4; i++) ctx.fillRect(x + i * 2, y + 8 + i * 2, 3, 3);
      for (let i = 0; i < 7; i++) ctx.fillRect(x + 6 + i * 2, y + 12 - i * 2, 3, 3);
    } else if (st === 'stopped') ctx.fillRect(x + 2, y + 2, 12, 12);
  }

  function fit(ctx, text, maxW) {
    text = String(text || '');
    if (ctx.measureText(text).width <= maxW) return text;
    while (text.length > 1 && ctx.measureText(text + '..').width > maxW) text = text.slice(0, -1);
    return text + '..';
  }
  function wrap2(ctx, text, maxW) {
    const words = String(text).split(/\s+/); const lines = []; let cur = '';
    for (const w of words) {
      const t = cur ? cur + ' ' + w : w;
      if (ctx.measureText(t).width > maxW && cur) { lines.push(cur); cur = w; if (lines.length === 2) break; } else cur = t;
    }
    if (lines.length < 2 && cur) lines.push(cur);
    else if (lines.length === 2) {           // overflow: clip the 2nd line with ..
      const rest = words.slice(lines.join(' ').split(/\s+/).length).join(' ');
      if (rest) lines[1] = fit(ctx, lines[1] + ' ' + rest, maxW);
    }
    return lines.slice(0, 2);
  }

  // ------------------------------------------------------------------ meter
  function meter(ctx, x, y, level) {          // 12 stepped bars, bottom-aligned at y + 26
    shown += (level - shown) * (level > shown ? 0.6 : 0.25);
    const n = Math.round(shown * 12);
    for (let i = 0; i < 12; i++) {
      const h = 6 + i * 2, bx = x + i * 9, by = y + 26 - h;
      ctx.fillStyle = '#fff';
      if (i < n) ctx.fillRect(bx, by, 6, h);
      else { ctx.fillRect(bx, y + 25, 6, 1); }
    }
  }

  // ------------------------------------------------------------------ draw
  function crewLine(crew) {
    if (!crew) return '';
    const on = ['alfred', 'scout', 'maker'].filter(a => crew[a] && crew[a].status && crew[a].status !== 'idle');
    return on.length ? 'CREW: ' + on.map(a => a.toUpperCase()).join(' + ') : '';
  }

  function slim(ctx, text) {
    ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, SLIM_H);
    ctx.fillStyle = '#fff'; ctx.font = font(12, true); ctx.textBaseline = 'middle';
    ctx.fillText(fit(ctx, text, W - 16), 8, SLIM_H / 2 + 1);
    lastRect = { x: 0, y: 0, w: W, h: SLIM_H };
  }

  function draw(ctx, t) {
    lastRect = null;
    const face = window.RetroFace ? RetroFace.info() : { playing: false, agent: 'alfred', crew: null };
    const st = V.state, f = Math.floor(t / 83);          // all banner animation steps at 12 fps
    const now = srvNow(), age = now - (V.since || now);
    const pend = V.pending || [];
    // narration mid-turn ("Checking your calendar.") keeps the WORKING banner + checklist up while it plays
    const narrating = face.playing && face.progress && st === 'working';
    if ((face.playing || st === 'speaking') && !narrating && st !== 'failed') {
      slim(ctx, `\u25b6 ${String(face.agent || 'alfred').toUpperCase()} SPEAKING  \u00b7  TAP TO STOP`);
    } else if (FULL.has(st)) {
      full(ctx, st, t, f, now, age, face);
    } else if (pend.length) {
      const j = pend[0];
      slim(ctx, `\u25a0 BACKGROUND: ${j.label}  ${mmss(now - j.since)}${pend.length > 1 ? `  (+${pend.length - 1} MORE)` : ''}  \u00b7  I'LL SAY WHEN IT'S DONE`);
    }
    if (performance.now() < flashUntil) {
      flashes++;                // whole-screen inversion = "I heard you"
      ctx.save(); ctx.globalCompositeOperation = 'difference'; ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, W, 342); ctx.restore();
    }
  }

  function full(ctx, st, t, f, now, age, face) {
    const tr = V.turn;
    let big = '', small = '', right = '';
    if (st === 'heard') { big = 'HEARD YOU'; small = V.ptt ? 'TAP SPACE WHEN DONE' : 'GO AHEAD, I\'M LISTENING'; }
    else if (st === 'listening') {
      big = 'LISTENING';
      const fresh = performance.now() - L.at < 1500;
      if (!(fresh && L.sp)) {
        const left = V.window ? Math.max(0, Math.ceil(V.window - age)) : 0;
        small = V.followup ? `SAY MORE, OR STAY QUIET${left ? '  ' + left + 's' : ''}` : V.ptt ? `TAP SPACE WHEN DONE${left ? '  \u00b7  CLOSES IN ' + left + 's' : ''}` : `SPEAK NOW${left ? '  \u00b7  CLOSES IN ' + left + 's' : ''}`;
      } else small = L.s > 0.35 ? (V.ptt ? 'PAUSE OR TAP SPACE = SEND' : 'PAUSE = SEND') : (V.ptt ? 'TAP SPACE WHEN DONE' : 'I\'M LISTENING... PAUSE WHEN DONE');
      if (tr) small = fit2(small + '  \u00b7  STILL ON: ' + tr.text, 60);
    }
    else if (st === 'transcribing') { big = 'GOT IT...'; small = 'TURNING YOUR WORDS INTO TEXT'; right = mmss(age); }
    else if (st === 'working') {
      big = 'WORKING'; right = tr ? mmss(now - tr.started) : '';
      small = [tr && tr.label ? tr.label : 'THINKING', crewLine(face.crew)].filter(Boolean).join('  \u00b7  ');
      if (V.say && V.say.text) small = `\u201c${V.say.text}\u201d`;     // what he is hearing right now
    }
    else if (st === 'failed') {          // the turn died on a provider error (rate limit etc.): server sends fail + note
      const fl = V.fail || {};
      big = fl.kind === 'limit' ? 'LIMIT HIT' : 'SOMETHING WENT WRONG'; small = V.note || 'TRY AGAIN IN A MINUTE';
    }
    else if (st === 'error') { big = 'DIDN\'T CATCH THAT'; small = V.note || (V.ptt ? 'TAP SPACE AND TRY AGAIN' : 'SAY "ALFRED" AND TRY AGAIN'); }
    else if (st === 'done') { big = 'DONE'; small = V.note || ''; }
    else if (st === 'stopped') { big = 'STOPPED'; small = V.note || ''; }
    if (V.note && (st === 'working') && age < 6) small = V.note;
    if (st === 'working' && tr && tr.stuck) small = 'STILL TRYING... TAP TO CANCEL';   // watchdog: 3 min, no activity   // e.g. NEW ASK. THE LAST ONE WAS STOPPED

    const showBox = tr && tr.text && (st === 'working' || st === 'transcribing') && tr.kind !== 'result';
    const steps = st === 'working' && tr && tr.kind === 'voice' && Array.isArray(tr.steps) ? tr.steps : [];
    const boxH = showBox ? (steps.length ? BOX1_H : BOX_H) : 0;
    const stepsH = steps.length ? STEP_PAD * 2 + Math.min(STEPS_MAX, steps.length) * STEP_H : 0;
    const H = BAR_H + boxH + stepsH;
    // bar
    ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, BAR_H);
    glyph(ctx, st, 20, 5, f);           // inset: the screen has rounded corners
    ctx.fillStyle = '#fff'; ctx.textBaseline = 'alphabetic';
    ctx.font = font(20, true); ctx.fillText(big, 50, 20);
    if (st === 'listening') meter(ctx, 400, 2, performance.now() - L.at < 1500 ? L.l : 0);
    else if (right) { ctx.font = font(20, true); const rw = ctx.measureText(right).width; ctx.fillText(right, W - 12 - rw, 20); }
    ctx.font = font(11, true); ctx.textBaseline = 'alphabetic';
    ctx.fillText(fit(ctx, small, W - 62), 50, 32);
    // progress: working = indeterminate marquee; listening = countdown / pause-to-send bar
    if (st === 'working' || st === 'transcribing') {
      const span = W - 8, pos = (f * 8) % (span + 48) - 48;
      ctx.fillRect(0, BAR_H - 5, W, 1);                    // track
      for (let i = 0; i < 3; i++) { const x = pos + i * 16; if (x > -12 && x < W) ctx.fillRect(Math.max(0, x), BAR_H - 4, 12, 3); }
    } else if (st === 'listening') {
      let p = 0;
      if (performance.now() - L.at < 1500 && L.sp) p = Math.min(1, L.s / 1.2);           // quiet so far vs Hermes' 1.2s
      else if (V.window) p = Math.min(1, age / V.window);
      const w = Math.round((W - 16) * (1 - p) / 8) * 8;
      for (let x = 16; x < 16 + w - 16; x += 8) ctx.fillRect(x, BAR_H - 4, 6, 2);
    }
    // transcript box: what he said, kept on screen while the agent works (one line once steps are listed)
    if (showBox) {
      ctx.fillStyle = '#fff'; ctx.fillRect(0, BAR_H, W, boxH);
      ctx.fillStyle = '#000'; ctx.fillRect(0, BAR_H + boxH - 2, W, 2); ctx.fillRect(0, BAR_H, 2, boxH); ctx.fillRect(W - 2, BAR_H, 2, boxH);
      ctx.font = font(13, true); ctx.textBaseline = 'top';
      ctx.fillText('YOU:', 10, BAR_H + 3);
      ctx.font = font(13, false);
      if (steps.length) ctx.fillText(fit(ctx, tr.text, W - 62 - 10), 52, BAR_H + 3);
      else wrap2(ctx, tr.text, W - 62 - 10).forEach((ln, i) => ctx.fillText(ln, 52, BAR_H + 3 + i * 15));
    }
    if (steps.length) drawSteps(ctx, steps, BAR_H + boxH, stepsH, f);
    lastRect = { x: 0, y: 0, w: W, h: H };
  }

  // Step checklist: what the agent is doing right now (spinner) and what it already did (check mark), newest at
  // the bottom, at most STEPS_MAX rows; a new step slides the list up one row (stepped, 12 fps).
  let stepsSeen = 0, slideAt = 0;
  function drawSteps(ctx, steps, y0, h, f) {
    const now = performance.now();
    if (steps.length !== stepsSeen) { if (steps.length > stepsSeen && stepsSeen) slideAt = now; stepsSeen = steps.length; }
    const p = Math.min(1, (now - slideAt) / 250), slide = steps.length > STEPS_MAX && p < 1 ? Math.round((1 - p) * STEP_H / 2) * 2 : 0;
    ctx.fillStyle = '#000'; ctx.fillRect(0, y0, W, h);
    ctx.save(); ctx.beginPath(); ctx.rect(0, y0 + 1, W, h - 2); ctx.clip();
    const vis = steps.slice(-STEPS_MAX - (slide ? 1 : 0));
    const base = y0 + STEP_PAD + slide - (slide ? STEP_H : 0);
    ctx.font = font(12, true); ctx.textBaseline = 'middle';
    vis.forEach((s, i) => {
      const y = base + i * STEP_H, cy = y + STEP_H / 2;
      ctx.fillStyle = '#fff';
      if (s.done) {                                         // 1-bit check mark
        for (let k = 0; k < 3; k++) ctx.fillRect(22 + k * 2, cy - 1 + k * 2, 2, 2);
        for (let k = 0; k < 5; k++) ctx.fillRect(28 + k * 2, cy + 3 - k * 2, 2, 2);
      } else {                                              // spinner: 2x2 blocks chasing (same as the WORKING glyph)
        [[0, 0], [5, 0], [5, 5], [0, 5]].forEach(([dx, dy], j) => { if (j !== f % 4) ctx.fillRect(23 + dx, cy - 5 + dy, 4, 4); });
      }
      ctx.fillText(fit(ctx, s.text, W - 60 - 16), 46, cy + 1);
    });
    ctx.restore();
  }
  function fit2(s, n) { return s.length > n ? s.slice(0, n - 2) + '..' : s; }

  // ------------------------------------------------------------------ api for face.js
  // true while the banner animates (face.js then draws at ~15 fps instead of the ~12 fps idle rate)
  function active() { return FULL.has(V.state) || V.state === 'speaking' || performance.now() < flashUntil; }
  function hit(x, y) { return !!lastRect && x >= lastRect.x && x < lastRect.x + lastRect.w && y >= lastRect.y && y < lastRect.y + lastRect.h; }
  window.RetroBanner = { onMsg, draw, active, hit, state: () => V, debug: () => ({ V, L, earconsPlayed, flashes, skew }) };
})();

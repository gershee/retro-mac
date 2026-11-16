// Retro Mac (Fable): lip-sync envelope. Pure math, no DOM, so node can test it (tools/kiosk2/test_lips.js).
// Replaces face.js's fixed-gain "rms * 4.2, attack .55 / release .16 per frame" with:
//   - frame-rate independent attack/release (time constants in ms, so 12 fps and 30 fps feel the same)
//   - per-reply automatic gain: the envelope tracks the loudest recent RMS, so a quiet voice (Alan) opens the mouth
//     as far as a loud one (Joe) and the last word of a sentence still moves the lips
//   - a noise gate (no mouth flutter on breath/room tone between words)
//   - a shape channel from the zero-crossing rate: fricatives (s, sh, f) pull the mouth wide and flat, vowels round it
// The mouth drawing in face.js still quantizes the result to 1/8 steps, so the look stays 1-bit and chunky.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.RetroLips = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const DEF = {
    attackMs: 38, releaseMs: 120, silenceMs: 70,   // envelope time constants (silence = gated input: the mouth shuts crisply)
    shapeMs: 55,                        // how fast the mouth changes shape (round <-> wide)
    peakFloor: 0.07, peakHalfLifeMs: 2500,   // AGC: never amplify below this RMS; the tracked peak forgets slowly
    gate: 0.10, curve: 0.8,             // normalized level below `gate` = closed; perceptual curve
    minRms: 0.004,                      // absolute floor: dither / lead-in hiss never opens the mouth before the AGC has a peak
    zcrLo: 0.09, zcrHi: 0.24,           // zero-crossing rate (fraction of samples) mapped to shape 0..1
  };
  function create(opts) {
    return { level: 0, shape: 0, peak: 0, cfg: Object.assign({}, DEF, opts || {}) };
  }
  // Measure a time-domain buffer (Float32Array, -1..1): RMS and zero-crossing rate.
  function measure(buf) {
    let sum = 0, zc = 0, prev = buf[0] >= 0;
    for (let i = 0; i < buf.length; i++) {
      const v = buf[i]; sum += v * v;
      const s = v >= 0; if (s !== prev) { zc++; prev = s; }
    }
    return { rms: Math.sqrt(sum / buf.length), zcr: zc / buf.length };
  }
  // Advance the envelope by dt ms with a new measurement. Returns the state (level 0..1, shape 0..1).
  function step(st, rms, zcr, dt) {
    const c = st.cfg; dt = clamp(dt || 33, 1, 250);
    const decay = Math.pow(0.5, dt / c.peakHalfLifeMs);
    st.peak = Math.max(st.peak * decay, rms);
    const norm = rms / Math.max(c.peakFloor, st.peak);
    let target = norm < c.gate || rms < c.minRms ? 0 : Math.pow(clamp(norm, 0, 1), c.curve);
    const k = 1 - Math.exp(-dt / (target > st.level ? c.attackMs : target === 0 ? c.silenceMs : c.releaseMs));
    st.level += (target - st.level) * k;
    if (st.level < 0.02 && target === 0) st.level = 0;
    const shapeT = target > 0 ? clamp((zcr - c.zcrLo) / (c.zcrHi - c.zcrLo), 0, 1) : st.shape;
    st.shape += (shapeT - st.shape) * (1 - Math.exp(-dt / c.shapeMs));
    return st;
  }
  // Start of a new reply: forget the previous speaker's loudness (keeps the smoothing state).
  function reset(st) { st.peak = 0; st.level = 0; st.shape = 0; return st; }
  // The legacy face.js rule, kept for A/B tests (fixed gain, per-frame coefficients).
  function legacyStep(level, rms) {
    const raw = Math.pow(clamp(rms * 4.2, 0, 1), 0.8);
    return level + (raw - level) * (raw > level ? 0.55 : 0.16);
  }
  return { create, measure, step, reset, legacyStep, DEF };
});

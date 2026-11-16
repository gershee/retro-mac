#!/usr/bin/env node
// Fable: lip-sync envelope (web/lipsync.js) + the 32-bit 1-bit pass. Pure node, no browser.
//   node tools/kiosk2/test_lips.js
'use strict';
const path = require('path');
const L = require(path.join(__dirname, '..', 'web', 'lipsync.js'));
let fails = 0;
const check = (name, ok, extra) => { fails += ok ? 0 : 1; console.log((ok ? 'ok   ' : 'FAIL ') + name + (ok || extra === undefined ? '' : '  ' + JSON.stringify(extra))); };
const q = (v, s) => Math.round(v / s) * s;

// --- measure: RMS and zero-crossing rate of synthetic buffers
const N = 1024, sr = 48000;
const tone = (f, amp) => Float32Array.from({ length: N }, (_, i) => amp * Math.sin(2 * Math.PI * f * i / sr));
let m = L.measure(tone(200, 0.5));
check('rms of a 0.5 sine ~ 0.354', Math.abs(m.rms - 0.3536) < 0.01, m);
check('200 Hz vowel-ish tone: low zcr', m.zcr < L.DEF.zcrLo, m.zcr);
m = L.measure(tone(6000, 0.5));
check('6 kHz hiss-ish tone: high zcr', m.zcr > L.DEF.zcrHi, m.zcr);

// --- a synthetic reply at 30 fps: 600 ms vowel with 12 % multiplicative jitter, 300 ms silence, 400 ms quiet vowel
function run(seqRms, dt, zcr) {
  const st = L.create(); const out = [];
  for (const r of seqRms) { L.step(st, r, zcr === undefined ? 0.04 : zcr, dt); out.push(st.level); }
  return out;
}
function legacy(seqRms) { let lv = 0; return seqRms.map(r => (lv = L.legacyStep(lv, r))); }
let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
const hold = Array.from({ length: 18 }, () => 0.20 * (1 + 0.24 * (rnd() - 0.5)));   // loud voice, jittery
const seq = [...hold, ...Array(9).fill(0.002), ...Array(12).fill(0.05 * (1))];
const jitter = (arr, a, b) => { let j = 0; for (let i = a + 1; i < b; i++) j += Math.abs(q(arr[i], 0.125) - q(arr[i - 1], 0.125)); return j; };
const nw = run(seq, 33.3), old = legacy(seq);
check('attack: open within 3 frames (100 ms)', nw[2] > 0.5, nw.slice(0, 4));
check('jitter during a held vowel is not worse than legacy', jitter(nw, 3, 18) <= jitter(old, 3, 18), { nw: jitter(nw, 3, 18), old: jitter(old, 3, 18) });
check('release: closed (< 0.06 -> mouth line) within 250 ms of silence', nw[18 + 7] < 0.06, nw.slice(18, 27));
check('legacy lingered longer (the mushy tail being fixed)', old[18 + 7] > nw[18 + 7], [old[25], nw[25]]);
// AGC: a quiet voice (peak rms 0.05) must still open the mouth wide; legacy barely moves it
const quiet = Array(15).fill(0.05);
const nq = run(quiet, 33.3), oq = legacy(quiet);
check('quiet voice: new envelope opens >= 0.75', Math.max(...nq) >= 0.75, Math.max(...nq));
check('quiet voice: legacy stayed under 0.4 (the bug being fixed)', Math.max(...oq) < 0.4, Math.max(...oq));
// noise gate: room tone / breath between words does not flutter the mouth
const st = L.create(); for (const r of hold) L.step(st, r, 0.04, 33);
for (let i = 0; i < 10; i++) L.step(st, 0.012, 0.3, 33);
check('breath (rms .012 after a .2 voice) is gated to 0', st.level === 0, st.level);
// absolute floor: lead-in dither (rms .002) on a fresh envelope (no peak yet) keeps the mouth shut
const fr = L.create(); for (let i = 0; i < 6; i++) L.step(fr, 0.002, 0.3, 33);
check('lead-in dither on a fresh envelope stays closed', fr.level === 0, fr.level);
// frame-rate independence: 12 fps and 30 fps land at the same level after the same wall time
const a30 = run(Array(30).fill(0.2), 33.3), a12 = run(Array(12).fill(0.2), 83.3);
check('30 fps and 12 fps agree after 1 s', Math.abs(a30[29] - a12[11]) < 0.03, [a30[29], a12[11]]);
// shape: fricative -> wide (1), vowel -> round (0), and it ignores zcr while silent
const sh = L.create(); for (let i = 0; i < 10; i++) L.step(sh, 0.2, 0.3, 33);
check('fricative shape -> ~1', sh.shape > 0.9, sh.shape);
for (let i = 0; i < 10; i++) L.step(sh, 0.2, 0.04, 33);
check('vowel shape -> ~0', sh.shape < 0.1, sh.shape);
for (let i = 0; i < 10; i++) L.step(sh, 0.0, 0.5, 33);
check('silence keeps the last shape (no snap)', sh.shape < 0.1, sh.shape);
check('reset clears peak/level/shape', JSON.stringify(L.reset(sh)).includes('"peak":0'));

// --- 1-bit pass: 32-bit loop == byte loop (same math as face.js), and faster
const W = 512, H = 342;
const FG = [0x39, 0xff, 0x6a], BG = [0x03, 0x12, 0x08], SCAN = 0.26;
const src = new Uint8ClampedArray(W * H * 4); for (let i = 0; i < src.length; i += 4) { const v = ((i / 4) % 7 < 3) ? 255 : 0; src[i] = src[i + 1] = src[i + 2] = v; src[i + 3] = 255; }
function oldPass(d) { const k0 = 1 - SCAN; let col = 0, row = 0; for (let i = 0; i < d.length; i += 4) { const c = d[i] < 128 ? FG : BG; const k = (row & 1) ? k0 : 1; d[i] = c[0] * k; d[i + 1] = c[1] * k; d[i + 2] = c[2] * k; d[i + 3] = 255; if (++col === W) { col = 0; row++; } } }
const pack = (c, k) => (((255 << 24) | (Math.round(c[2] * k) << 16) | (Math.round(c[1] * k) << 8) | Math.round(c[0] * k)) >>> 0);
function newPass(d) { const u = new Uint32Array(d.buffer), k0 = 1 - SCAN, fg = pack(FG, 1), bg = pack(BG, 1), fgS = pack(FG, k0), bgS = pack(BG, k0);
  for (let row = 0, i = 0; row < H; row++) { const F = row & 1 ? fgS : fg, B = row & 1 ? bgS : bg; for (const end = i + W; i < end; i++) u[i] = (u[i] & 255) < 128 ? F : B; } }
const LE = new Uint8Array(new Uint32Array([0x0a0b0c0d]).buffer)[0] === 0x0d;
check('little-endian host (32-bit path is used)', LE);
const a = src.slice(), b = src.slice(); oldPass(a); newPass(b);
let diff = 0; for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) diff++;
check('32-bit pass is pixel-identical to the byte pass', diff === 0, diff);
const bench = (fn) => { const d = src.slice(); fn(d); const t0 = process.hrtime.bigint(); for (let k = 0; k < 40; k++) { d.set(src); fn(d); } return Number(process.hrtime.bigint() - t0) / 40e6; };
const tOld = bench(oldPass), tNew = bench(newPass);
console.log(`     1-bit pass per frame: old ${tOld.toFixed(2)} ms, new ${tNew.toFixed(2)} ms (x${(tOld / tNew).toFixed(1)})`);
check('32-bit pass is faster', tNew < tOld);

console.log('\nFAILS:', fails);
process.exit(fails ? 1 : 0);

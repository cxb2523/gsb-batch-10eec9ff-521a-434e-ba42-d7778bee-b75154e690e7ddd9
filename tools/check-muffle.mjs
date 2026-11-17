// Acceptance checks for the shot-locked underwater muffle.
//   node tools/check-muffle.mjs
//
// 1. curve alignment: at every shot boundary where the set changes, the muffle cutoff must
//    hold the old value right up to the boundary (never early), glide smoothly across a
//    MUFFLE_RAMP-long cosine ramp (no jumps), and sit exactly on the new value afterwards
//    (never late, no residue) — checked on the real SHOTS and on a synthetic shot list
//    whose boundary lands exactly on a cue point.
// 2. full render: deterministic (two runs bit-identical), peak and duration unchanged,
//    and the rendered audio is continuous across every boundary (level and HF spectrum).
import { renderScore, muffleCurve, MUFFLE_RAMP, MUFFLE_MUSIC_HZ, MUFFLE_SFX_HZ, MUFFLE_AIR_HZ, PEAK_DB } from '../src/audio.js';
import { SHOTS, CUES, DURATION } from '../src/shots.js';
import { setSR, Biquad } from '../src/audio-dsp.js';

const SR = 48000;
let failures = 0;
const check = (ok, label) => { console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${label}`); if (!ok) failures++; };

// ---- 1. curve alignment -----------------------------------------------------
function checkShots(shots, label) {
  console.log(`\n[curve] ${label}`);
  for (const [hz, name] of [[MUFFLE_MUSIC_HZ, 'music'], [MUFFLE_SFX_HZ, 'sfx']]) {
    const fn = muffleCurve(hz, { shots });
    const target = (s) => (s.set === 'under' ? hz : MUFFLE_AIR_HZ);
    for (let i = 1; i < shots.length; i++) {
      const b = shots[i].t0, from = target(shots[i - 1]), to = target(shots[i]);
      if (from === to) continue;
      const tag = `${name} @${b.toFixed(2)}s (${shots[i - 1].set}->${shots[i].set})`;
      // never early: exact old value everywhere in the last 500 ms before the boundary
      let early = 0;
      for (let t = b - 0.5; t < b - 1e-4; t += 0.0023) if (fn(t) !== from) early++;
      check(early === 0 && fn(b - 1e-4) === from, `${tag}: no lead before boundary`);
      // never late, no residue: exact new value from b + ramp onwards
      const end = i + 1 < shots.length ? shots[i + 1].t0 : DURATION;
      let late = 0;
      for (let t = b + MUFFLE_RAMP + 1e-4; t < Math.min(end, b + 0.6); t += 0.0023) if (fn(t) !== to) late++;
      check(late === 0 && fn(b + MUFFLE_RAMP + 1e-4) === to, `${tag}: settled ${MUFFLE_RAMP * 1000} ms after boundary, no residue`);
      // smooth: continuous, monotonic glide across the ramp (max relative step per 0.1 ms)
      let prev = fn(b - 1e-4), maxStep = 0, mono = true;
      for (let t = b; t <= b + MUFFLE_RAMP + 1e-9; t += 1e-4) {
        const v = fn(t);
        maxStep = Math.max(maxStep, Math.abs(v - prev) / prev);
        if (to > from ? v < prev - 1e-9 : v > prev + 1e-9) mono = false;
        prev = v;
      }
      check(maxStep < 0.02 && mono, `${tag}: smooth monotonic ramp (max step ${(maxStep * 100).toFixed(2)}%/0.1ms)`);
      // exact value at the boundary itself: start of the ramp, not the new value yet
      check(fn(b) === from, `${tag}: continuous at boundary (f(b) == old value)`);
    }
  }
}
checkShots(SHOTS, 'real SHOTS');

// synthetic shot list: boundary lands exactly on a cue point (CUES.below)
const tb = CUES.below;
const synth = [
  { id: 'a', name: 'pre', t0: 0, t1: tb, set: 'sea' },
  { id: 'b', name: 'cue', t0: tb, t1: tb + 2.5, set: 'under' },
  { id: 'c', name: 'post', t0: tb + 2.5, t1: tb + 5, set: 'sea' },
];
checkShots(synth, `synthetic shots, boundary exactly on cue below=${tb}s`);

// ---- 2. full render ----------------------------------------------------------
console.log('\n[render] full 39 s score, rendered twice');
const r1 = renderScore(SR, { report: true });
const r2 = renderScore(SR, { report: true });
let same = r1.L.length === r2.L.length;
for (let i = 0; same && i < r1.L.length; i++) if (r1.L[i] !== r2.L[i] || r1.R[i] !== r2.R[i]) same = false;
check(same, 'deterministic: two renders bit-identical');
check(r1.L.length === Math.ceil(DURATION * SR), `duration unchanged: ${r1.L.length} samples = ${(r1.L.length / SR).toFixed(3)} s`);
check(r1.report.peakDb === PEAK_DB, `peak unchanged: ${r1.report.peakDb} dBFS`);
check(r1.report.muffleOk === true, 'report: every shot\'s muffle matches its underwater state');

// continuity of the rendered mix across each set-change boundary:
// windowed RMS and HF-band (>3 kHz) energy in 10 ms windows around the boundary
setSR(SR);
console.log('\n[render] boundary continuity (10 ms windows)');
const W = Math.round(0.01 * SR);
const band = (a, hpL, hpR) => { // [rms, hf] of one window starting at sample a
  let e = 0, h = 0;
  for (let j = a; j < a + W; j++) {
    const l = r1.L[j], r = r1.R[j];
    e += l * l + r * r;
    h += Math.pow(hpL.run(l), 2) + Math.pow(hpR.run(r), 2);
  }
  return [Math.sqrt(e / (2 * W)), Math.sqrt(h / (2 * W))];
};
for (let i = 1; i < SHOTS.length; i++) {
  if ((SHOTS[i - 1].set === 'under') === (SHOTS[i].set === 'under')) continue;
  const b = SHOTS[i].t0, ib = Math.round(b * SR), span = Math.round(0.3 * SR);
  // level continuity: no window jumps to/from silence or spikes vs its neighbour
  let maxRatio = 0, prev = null;
  for (let a = ib - span; a + W <= ib + span + Math.round(MUFFLE_RAMP * SR); a += W) {
    const [r] = band(a, Biquad.hp(3000, 0.707), Biquad.hp(3000, 0.707));
    if (prev !== null && Math.min(prev, r) > 1e-5) maxRatio = Math.max(maxRatio, Math.max(prev, r) / Math.min(prev, r));
    prev = r;
  }
  // spectral direction: HF share of the window right before the boundary vs right after
  // the ramp — must drop going under and recover coming back up
  const [rB, hfB] = band(ib - W, Biquad.hp(3000, 0.707), Biquad.hp(3000, 0.707));
  const [rA, hfA] = band(ib + Math.round(MUFFLE_RAMP * SR), Biquad.hp(3000, 0.707), Biquad.hp(3000, 0.707));
  const shareB = hfB / Math.max(1e-9, rB), shareA = hfA / Math.max(1e-9, rA);
  const intoUnder = SHOTS[i].set === 'under';
  const dirOk = intoUnder ? shareA < shareB : shareA > shareB;
  check(maxRatio < 4 && dirOk,
    `@${b.toFixed(1)}s (${SHOTS[i - 1].set}->${SHOTS[i].set}): level continuous (max window step x${maxRatio.toFixed(2)}), HF share ${shareB.toFixed(3)} -> ${shareA.toFixed(3)} ${intoUnder ? 'down' : 'up'} as expected`);
}

console.log(failures ? `\n${failures} check(s) FAILED` : '\nall checks passed');
process.exit(failures ? 1 : 0);

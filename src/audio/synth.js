/**
 * Modal synthesis.
 *
 * A struck membrane's displacement is a sum over its modes:
 *
 *     u(x, t) = sum_k  a_k * phi_k(x) * sin(2 pi f_k t) * exp(-t / tau_k)
 *
 * The parts that come from the shape, and are therefore not negotiable:
 *   - f_k, the frequencies, from sqrt(lambda_k)
 *   - phi_k, the mode shapes, which decide how hard each mode is driven by a
 *     strike in a given place
 *
 * The parts that are honest modelling choices, because they depend on the
 * material and the mallet rather than the outline:
 *   - tau_k, the decay times
 *   - the wave speed c = sqrt(T / rho), which the pitch slider sets
 *
 * Note what is NOT in that second list: the pitch you actually hear. Given c,
 * f_1 = c sqrt(lambda_1) / (2 pi) is fixed by the domain, and since outlines are
 * normalised to unit area first, that is shape information rather than size. The
 * slider chooses the reference, the shape chooses where the fundamental lands
 * relative to it. See `frequencies`.
 *
 * The UI says as much. Nothing here is allowed to alter an overtone *ratio*.
 */
import { besselJZero } from '../math/bessel.js';

/** Lumped node areas: each triangle gives a third of its area to each vertex. */
export function nodeWeights(mesh) {
  const { nodes, nodeCount, triangles, triangleCount } = mesh;
  const w = new Float64Array(nodeCount);
  for (let t = 0; t < triangleCount; t++) {
    const a = triangles[t * 3];
    const b = triangles[t * 3 + 1];
    const c = triangles[t * 3 + 2];
    const ax = nodes[a * 2];
    const ay = nodes[a * 2 + 1];
    const area =
      Math.abs(
        (nodes[b * 2] - ax) * (nodes[c * 2 + 1] - ay) -
          (nodes[c * 2] - ax) * (nodes[b * 2 + 1] - ay),
      ) / 2;
    const share = area / 3;
    w[a] += share;
    w[b] += share;
    w[c] += share;
  }
  return w;
}

/**
 * lambda_1 of the unit-area disk, the reference drum the pitch slider names.
 *
 * For a disk of radius r, lambda_1 = (j_{0,1} / r)^2. Unit area means pi r^2 = 1,
 * so r^2 = 1/pi and lambda_1 = j_{0,1}^2 * pi = 18.1684...
 *
 * The disk is the right reference for two reasons. By Faber-Krahn it *minimises*
 * lambda_1 over all domains of a given area, so every other unit-area shape comes
 * out at or above the slider pitch and never below it. And it is the one shape
 * whose spectrum this repo knows in closed form, so the reference is exact rather
 * than meshed.
 */
export const REFERENCE_LAMBDA1 = besselJZero(0, 1) ** 2 * Math.PI;

/**
 * Frequencies in Hz.
 *
 * f_k = baseHz * sqrt(lambda_k / lambda_ref).
 *
 * The physics is f_k = c sqrt(lambda_k) / (2 pi), with c = sqrt(T / rho) set by
 * the tension and the areal density. So one constant, c, is chosen by the pitch
 * slider, and everything after that - including which note the fundamental lands
 * on - comes from the domain.
 *
 * This deliberately does NOT pin f_1 to `baseHz`. Pinning it silently re-chose a
 * different c for every outline, which cancelled exactly the part of the spectrum
 * that says most about the shape: since shapes are normalised to unit area first,
 * lambda_1 is pure shape information, and it varies by a factor of ~2 across the
 * built-in presets (18.2 for the disk to 35.7 for a Kac drum, i.e. 5.9
 * semitones). All of that was being discarded before it reached the ear, and
 * because 84-94% of the audible energy sits in mode 1, discarding it made every
 * drum open on the same note and left the shapes nearly indistinguishable.
 *
 * Ratios within one drum are untouched: f_k / f_1 is still exactly
 * sqrt(lambda_k / lambda_1). The isospectral pair still matches to the last
 * digit, because it has the same lambda_1 as well as the same ratios.
 */
export function frequencies(eigenvalues, baseHz = 130) {
  const out = new Float64Array(eigenvalues.length);
  if (!eigenvalues.length) return out;
  const root = Math.sqrt(REFERENCE_LAMBDA1);
  for (let k = 0; k < eigenvalues.length; k++) {
    out[k] = (baseHz * Math.sqrt(eigenvalues[k])) / root;
  }
  return out;
}

/**
 * How strongly a strike at (px, py) drives each mode.
 *
 * This is the projection of the mallet's force distribution onto each mode:
 * a_k = integral(phi_k * g), with g a normalised Gaussian of the given radius.
 * Two consequences fall out for free, both audible:
 *   - striking a mode's nodal line cannot excite that mode at all
 *   - a wide mallet cannot excite fine modes, so it sounds duller
 */
export function strikeAmplitudes(mesh, modes, px, py, radius, weights = null) {
  const { nodes, nodeCount } = mesh;
  const w = weights || nodeWeights(mesh);
  const g = new Float64Array(nodeCount);
  const r2 = Math.max(1e-9, radius * radius);
  let sum = 0;

  for (let i = 0; i < nodeCount; i++) {
    const dx = nodes[i * 2] - px;
    const dy = nodes[i * 2 + 1] - py;
    const v = Math.exp(-(dx * dx + dy * dy) / r2) * w[i];
    g[i] = v;
    sum += v;
  }

  if (sum <= 0) {
    // Degenerate mallet: fall back to the single nearest node.
    let best = 0;
    let bestD = Infinity;
    for (let i = 0; i < nodeCount; i++) {
      const dx = nodes[i * 2] - px;
      const dy = nodes[i * 2 + 1] - py;
      const d = dx * dx + dy * dy;
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    g.fill(0);
    g[best] = 1;
    sum = 1;
  }

  for (let i = 0; i < nodeCount; i++) g[i] /= sum;

  const amps = new Float64Array(modes.length);
  for (let k = 0; k < modes.length; k++) {
    const phi = modes[k];
    let acc = 0;
    for (let i = 0; i < nodeCount; i++) acc += g[i] * phi[i];
    amps[k] = acc;
  }
  return amps;
}

/**
 * Squared mass norm of each stored mode, integral(phi_k^2).
 *
 * `solveDrum` normalises every mode to a *peak* of 1 so the colour map has a
 * predictable range. That is the wrong normalisation for a modal expansion: the
 * coefficient of phi_k in u = sum c_k phi_k is only integral(phi_k g) when the
 * modes are orthonormal in the mass inner product. Dividing the projection by
 * this restores that, and it matters - the norm varies by a factor of ~2 across
 * the first sixteen modes of a disk, so without it high modes come out several
 * times too loud for no physical reason.
 */
export function modeNorms(mesh, modes, weights = null) {
  const w = weights || nodeWeights(mesh);
  const out = new Float64Array(modes.length);
  for (let k = 0; k < modes.length; k++) {
    const phi = modes[k];
    let acc = 0;
    for (let i = 0; i < phi.length; i++) acc += w[i] * phi[i] * phi[i];
    out[k] = acc;
  }
  return out;
}

/**
 * Turns a geometric strike projection into the modal amplitudes you actually
 * hear. Three factors, none of which touches a frequency:
 *
 *  1. 1 / integral(phi_k^2) - the mass normalisation described above.
 *  2. 1 / omega_k. A mallet delivers an impulse of *force*, which sets the
 *     membrane's initial velocity rather than its displacement. Solving
 *     u_k(0) = 0, u_k'(0) = a_k gives u_k(t) = (a_k / omega_k) sin(omega_k t),
 *     so displacement carries a 6 dB/octave rolloff. Leaving it out is why the
 *     old code produced sixteen inharmonic partials at *equal* level, which is
 *     the recipe for a gong, not a drum.
 *  3. The mallet's contact time. No beater is an impulse: a force pulse lasting
 *     T cannot pump a mode whose period is much shorter than T. Modelled as a
 *     one-pole rolloff with its corner at `contactRatio` times `refHz`.
 *
 * `refHz` is the reference pitch (the slider), NOT this drum's own fundamental.
 * One mallet has one contact time, so the corner must not move when the outline
 * changes; keying it to f_1 would have handed every shape a different beater as
 * soon as f_1 stopped being pinned. Keying it to the slider keeps the original
 * intent - the timbre does not drift as you move the pitch - while leaving the
 * mallet identical across shapes. Defaults to freqs[0] so a caller that has no
 * reference behaves as before.
 *
 * Factor 3 is a modelling choice about the mallet and is declared as such. The
 * first two are not choices; they were missing.
 *
 * Zeros are preserved exactly, so "striking a nodal line cannot excite this
 * mode" survives untouched.
 */
export function audibleAmps(amps, norms, freqs, contactRatio = 3, refHz = 0) {
  const out = new Float64Array(amps.length);
  if (!amps.length || !(freqs[0] > 0)) return out;
  const ref = refHz > 0 ? refHz : freqs[0];
  const cut = Math.max(0.5, contactRatio) * ref;
  for (let k = 0; k < amps.length; k++) {
    const n2 = norms[k] > 1e-12 ? norms[k] : 1;
    // 1 / omega_k, up to the global constant 2 pi ref that the gain absorbs.
    const ratio = freqs[k] / ref;
    const lowpass = 1 / (1 + (freqs[k] / cut) * (freqs[k] / cut));
    out[k] = (amps[k] / n2 / Math.max(1e-9, ratio)) * lowpass;
  }
  return out;
}

/**
 * A single loudness reference for one drum: the total drive of the hardest
 * strike anywhere on the head.
 *
 * The renderer scales by this instead of per-strike normalising, so a strike near
 * the rim stays quieter than one in the middle - that difference is information
 * the physics is trying to convey - while nothing ever reaches the limiter.
 *
 * This used to look only at the node where the *fundamental* peaks and evaluate
 * one strike there. That is the loudest place for mode 1 alone, but it is not in
 * general the loudest strike on the drum: an off-centre hit drives the higher
 * modes as well, and their combined l1 drive can be substantially larger. On a
 * disk the true maximum sits off centre and the single-node estimate understated
 * it by roughly 40%; on other built-in shapes by 25-60%. A headroom that is too
 * small is an over-large gain, so edge and eccentric strikes were being scaled
 * straight into the limiter. The sweep below evaluates every mesh node under the
 * same audibleAmps parameters the renderer uses, so the reference covers the
 * strongest strike the whole head can produce. It is O(nodes^2 * modes) but runs
 * once per (drum, mallet); the app caches it in headroom().
 */
export function strikeHeadroom(
  mesh,
  modes,
  norms,
  freqs,
  weights,
  radius,
  contactRatio = 3,
  refHz = 0,
) {
  let best = 0;
  for (let i = 0; i < mesh.nodeCount; i++) {
    const amps = strikeAmplitudes(
      mesh,
      modes,
      mesh.nodes[i * 2],
      mesh.nodes[i * 2 + 1],
      radius,
      weights,
    );
    const heard = audibleAmps(amps, norms, freqs, contactRatio, refHz);
    let l1 = 0;
    for (let k = 0; k < heard.length; k++) l1 += Math.abs(heard[k]);
    if (l1 > best) best = l1;
  }
  return best > 1e-12 ? best : 1;
}

/**
 * Decay time per mode, from Rayleigh damping: C = alpha M + beta K, the standard
 * proportional-damping model for exactly this kind of finite element system. In
 * modal coordinates that is
 *
 *     1 / tau_k = alpha + beta omega_k^2
 *
 * so loss grows with the *square* of frequency. That is the important part. The
 * old law used a tunable power of the frequency ratio, whose exponent sat below 1
 * at the default setting, leaving the high inharmonic cluster ringing for half a
 * second. A real membrane loses those partials in tens of milliseconds, and that
 * fast darkening is most of what makes a drum read as a pitched thud.
 *
 * `brightness` in [0, 1] moves weight from the stiffness term to the mass term.
 *
 * `refHz` plays the same role as in `audibleAmps`: alpha and beta are properties
 * of the material and the air, so the absolute frequency is what decides how fast
 * a mode dies. Measuring omega against this drum's own fundamental would instead
 * give every outline its own alpha and beta, so a taut little shape would ring
 * exactly as long as a slack big one. Keyed to the slider, a shape that sits
 * higher because of its geometry also decays faster, which is the audible half of
 * why shapes differ. Defaults to freqs[0], which reproduces the old behaviour.
 */
export function decayTimes(freqs, baseSeconds = 1.7, brightness = 0.5, refHz = 0) {
  const out = new Float64Array(freqs.length);
  if (!freqs.length) return out;
  const ref = refHz > 0 ? refHz : freqs[0];
  const stiff = 0.96 - 0.9 * brightness; // 0.96 (dull) .. 0.06 (bright)
  const mass = 1 - stiff;
  const rate = 1 / Math.max(0.02, baseSeconds);
  for (let k = 0; k < freqs.length; k++) {
    const ratio = ref > 0 ? freqs[k] / ref : 1;
    out[k] = Math.max(0.006, 1 / (rate * (mass + stiff * ratio * ratio)));
  }
  return out;
}

/**
 * Renders one strike's raw modal sum into a mono Float32Array, with NO limiter
 * and NO fade. Shared by `renderStrike` (single voice, its own safety limiter)
 * and `renderBus` (many voices summed before one shared limiter), so the two
 * paths cannot drift in how a strike is synthesised.
 *
 * Sums the decaying sinusoids directly. A struck membrane starts flat and
 * moving, so each mode starts at zero displacement - hence sine rather than
 * cosine, and no click at onset.
 *
 * `gain` is the caller's job to set so the sum lands near full scale.
 */
function renderRawStrike({
  freqs,
  amps,
  taus,
  sampleRate = 48000,
  duration = null,
  gain = 1,
}) {
  const longest = taus.length ? Math.max(...taus) : 0.3;
  const seconds = Math.min(4.5, Math.max(0.25, duration ?? longest * 2.9));
  const length = Math.max(1, Math.floor(seconds * sampleRate));
  const out = new Float32Array(length);

  const nyquist = sampleRate / 2;
  for (let k = 0; k < freqs.length; k++) {
    const f = freqs[k];
    if (!(f > 0) || f >= nyquist) continue; // never alias
    const a = amps[k] * gain;
    if (Math.abs(a) < 1e-6) continue;
    const tau = taus[k];

    // Evaluate by recurrence rather than calling sin and exp per sample. Two
    // Math calls per sample across sixteen modes and a quarter of a million
    // samples is on the order of four million transcendental evaluations, which
    // is enough main-thread work to visibly stall the animation when strikes come
    // quickly. Rotating a unit vector and scaling an envelope is a handful of
    // multiplies instead, and the drift over a few hundred thousand steps is
    // around 1e-10 relative - far below the 16-bit floor we render to.
    const w = (2 * Math.PI * f) / sampleRate;
    const cosw = Math.cos(w);
    const sinw = Math.sin(w);
    const decay = Math.exp(-1 / (tau * sampleRate));

    // Stop once this mode is inaudible instead of grinding out silence.
    const audibleSamples = Math.ceil(6.9 * tau * sampleRate); // exp(-6.9) ~ 1e-3
    const nEnd = Math.min(length, audibleSamples);

    let sin = 0;
    let cos = 1;
    let env = 1;
    for (let n = 0; n < nEnd; n++) {
      out[n] += a * sin * env;
      const nextSin = sin * cosw + cos * sinw;
      cos = cos * cosw - sin * sinw;
      sin = nextSin;
      env *= decay;
    }
  }
  return out;
}

/** The soft limiter shared by the single-voice and bus paths: one tanh per sample. */
function applySoftLimiter(samples) {
  for (let n = 0; n < samples.length; n++) samples[n] = Math.tanh(samples[n]);
  return samples;
}

/** Linear fade over the final 12 ms so truncating the decay cannot click. */
function applyTailFade(samples, sampleRate) {
  const length = samples.length;
  const fade = Math.min(length, Math.floor(0.012 * sampleRate));
  for (let i = 0; i < fade; i++) {
    samples[length - fade + i] *= 1 - i / fade;
  }
  return samples;
}

/**
 * Renders a strike into a mono Float32Array.
 *
 * A struck membrane starts flat and moving, so each mode starts at zero
 * displacement - hence sine rather than cosine, and no click at onset. The first
 * sample is therefore exactly zero and the tail is faded out.
 *
 * `gain` is the caller's job to set so the sum lands near full scale. The tanh
 * below is a safety net and nothing more: it used to be doing real work, because
 * a fixed gain of 3.2 drove sixteen modes to a pre-limiter peak of about 11, and
 * two thirds of the first 300 ms of every strike came out of the limiter hard
 * clipped. See `strikeHeadroom`.
 *
 * For overlapping strikes the limiter belongs on the shared bus, not per voice:
 * see `renderBus`. This function keeps its own limiter so a single rendered
 * strike is bounded exactly as it always was.
 */
export function renderStrike(opts) {
  const out = renderRawStrike(opts);
  // Soft limiter rather than peak normalisation: a strike near the rim really is
  // quieter than one in the middle, and flattening that would throw away
  // information the physics is trying to tell you.
  applySoftLimiter(out);
  applyTailFade(out, opts.sampleRate ?? 48000);
  return out;
}

/**
 * Raw, unlimited samples for one strike (no tanh, no fade). The bus-level
 * counterpart of `renderStrike`: feed the result, with an offset, into
 * `renderBus` so the shared limiter sees every voice together.
 */
export function renderStrikeVoice(opts) {
  return renderRawStrike(opts);
}

/**
 * Mixes several already-rendered strike voices onto one shared bus and limits
 * the SUM once, instead of tanh-limiting each voice on its own and then adding.
 *
 * Per-voice tanh is the failure mode this replaces. Each voice is scaled to its
 * own peak and limited against its own peak, so each one looks fine alone; but
 * fast taps overlap while they are still ringing, and the limited voices simply
 * add at the destination. Six taps 30 ms apart reach a summed peak above full
 * scale, where the output stage hard-clamps - the flat ceiling that made rapid
 * drumming sound muffled and distorted. Limiting the raw (unlimited) voices
 * together means the knee sees the actual combined waveform exactly once, and no
 * individual voice's timbre or relative loudness is touched before the mix: the
 * pre-limiter sum is linear, so a lone voice keeps the same tone and level it
 * has in any other mixture.
 *
 * Each entry is either a raw mono sample array (the output of
 * `renderStrikeVoice`) with an optional sample `offset`, or a strike spec in the
 * `renderStrike` argument shape plus an optional `offset`. Every voice is added
 * with the SAME `gain` (the bus-level loudness scale), and one tanh is applied
 * to the whole mix. A voice truncated by the buffer's end is faded first, so
 * truncation cannot click even when it stops in the middle of the bus.
 *
 * An empty voice list renders to an empty Float32Array, never NaN.
 */
export function renderBus(voices, { sampleRate = 48000, gain = 1 } = {}) {
  if (!voices || voices.length === 0) return new Float32Array(0);

  const normalized = voices.map((voice) => {
    const offset = Math.max(0, Math.floor(voice.offset ?? 0));
    const raw = voice.samples
      ? Float32Array.from(voice.samples)
      : renderRawStrike(voice);
    return { raw, offset };
  });

  // One voice, starting at the bus origin: the shared path and the single-voice
  // path are then the same computation, so renderBus([v]) is sample-for-sample
  // what renderStrike produces (including tanh-before-fade), only re-gained.
  if (normalized.length === 1 && normalized[0].offset === 0) {
    const only = normalized[0].raw;
    if (gain !== 1) for (let n = 0; n < only.length; n++) only[n] *= gain;
    applySoftLimiter(only);
    applyTailFade(only, sampleRate);
    return only;
  }

  let length = 0;
  for (const { raw, offset } of normalized) {
    length = Math.max(length, offset + raw.length);
  }
  const mix = new Float32Array(length);
  for (const { raw, offset } of normalized) {
    // Fade before the sum: this is the per-voice truncation guard, applied to the
    // raw waveform so it scales linearly instead of being baked into a limited
    // one. It does not touch any sample that continues past the buffer's end.
    applyTailFade(raw, sampleRate);
    for (let n = 0; n < raw.length; n++) mix[offset + n] += raw[n] * gain;
  }

  // One shared soft limiter over the complete mix.
  applySoftLimiter(mix);
  // Safety fade at the bus's own end in case the last voice fills it exactly.
  applyTailFade(mix, sampleRate);
  return mix;
}

/** Displacement field at time t, for animating the drumhead as it rings. */
export function fieldAtTime(modes, amps, freqs, taus, t, out) {
  const n = out.length;
  out.fill(0);
  for (let k = 0; k < modes.length; k++) {
    const env = Math.exp(-t / taus[k]);
    if (env < 1e-4) continue;
    const c = amps[k] * Math.sin(2 * Math.PI * freqs[k] * t) * env;
    if (Math.abs(c) < 1e-9) continue;
    const phi = modes[k];
    for (let i = 0; i < n; i++) out[i] += c * phi[i];
  }
  return out;
}

/** Minimal 16-bit PCM WAV container. */
export function encodeWav(samples, sampleRate = 48000) {
  const bytesPerSample = 2;
  const buffer = new ArrayBuffer(44 + samples.length * bytesPerSample);
  const view = new DataView(buffer);
  const writeStr = (offset, s) => {
    for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i));
  };

  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + samples.length * bytesPerSample, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * bytesPerSample, true);
  view.setUint16(32, bytesPerSample, true);
  view.setUint16(34, 8 * bytesPerSample, true);
  writeStr(36, 'data');
  view.setUint32(40, samples.length * bytesPerSample, true);

  let o = 44;
  for (let i = 0; i < samples.length; i++) {
    const v = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(o, v < 0 ? v * 0x8000 : v * 0x7fff, true);
    o += 2;
  }
  return new Blob([buffer], { type: 'audio/wav' });
}

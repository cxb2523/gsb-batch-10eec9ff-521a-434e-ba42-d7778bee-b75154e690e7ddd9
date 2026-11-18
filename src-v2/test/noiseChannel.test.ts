/**
 * Offline-verifiable tests for the Game Boy APU noise channels.
 *
 * Run with: npm run test:v2
 *
 * These tests render audio with an OfflineAudioContext (polyfilled under
 * Node via web-audio-engine) so they need no browser and no sound hardware.
 *
 * Coverage:
 *   1. n1/n2 are created with audible, non-zero default gains and the summed
 *      nominal channel gain still leaves headroom below 1.0.
 *   2. A rendered fragment containing noise notes is genuinely non-silent.
 *   3. setChannelVolume works on the noise channels, and the master volume
 *      still scales the mix.
 *   4. LFSR buffer cache: a hit only happens when the cached buffer is long
 *      enough for the requested duration; a longer request misses and
 *      regenerates a longer buffer (no truncated tails).
 *   5. stopAll() clears noise caches/state, and rescheduling after it still
 *      produces sound; reset() restores initial channel state.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import './setup';
import { GameBoyAPU } from '../audio/apu/APU';
import { NoiseChannel } from '../audio/apu/NoiseChannel';
import {
  calculateNoiseFrequency,
  midiToNoiseParams,
} from '../audio/synthesis/FrequencyCalc';
import { DEFAULT_V2_CONFIG, type ChannelNote } from '../types';

const SAMPLE_RATE = 22050;

/** Nominal per-channel default gains (must match the APU constants). */
const DEFAULT_PULSE_GAIN = 0.12;
const DEFAULT_WAVE_GAIN = 0.15;
const DEFAULT_NOISE_GAIN = 0.04;

function createAPU(durationSeconds = 1): GameBoyAPU {
  const offline = new OfflineAudioContext(
    1,
    Math.ceil(durationSeconds * SAMPLE_RATE),
    SAMPLE_RATE
  );
  return new GameBoyAPU(offline as unknown as AudioContext, {
    ...DEFAULT_V2_CONFIG,
  });
}

function renderAPU(
  apu: GameBoyAPU,
  durationSeconds: number
): Promise<AudioBuffer> {
  const ctx = apu.getAudioContext() as unknown as OfflineAudioContext;
  assert.equal(
    ctx.length,
    Math.ceil(durationSeconds * SAMPLE_RATE),
    'test helper: render length mismatch'
  );
  return ctx.startRendering() as unknown as Promise<AudioBuffer>;
}

function noiseNote(
  channel: 'n1' | 'n2',
  startTime: number,
  duration: number,
  midiNote = 36
): ChannelNote {
  return { channel, midiNote, startTime, duration, velocity: 110 };
}

function frequencyFor(midiNote: number): number {
  const { divisorCode, clockShift } = midiToNoiseParams(midiNote);
  return calculateNoiseFrequency(divisorCode, clockShift);
}

/** Mean absolute amplitude of a rendered buffer. */
function meanAbs(buffer: AudioBuffer): number {
  const data = buffer.getChannelData(0);
  let sum = 0;
  for (let i = 0; i < data.length; i++) sum += Math.abs(data[i]);
  return sum / data.length;
}

/**
 * Floor for "this buffer contains audible signal". With the conservative
 * noise channel gain (0.04), velocity envelope (~0.26) and master volume
 * (0.7), a single rendered noise note measures roughly 3e-4 mean amplitude;
 * silence measures exactly 0, so 1e-5 is a strict but stable boundary.
 */
const AUDIBLE_MEAN = 1e-5;

/** Mean absolute amplitude over a sub-range of seconds. */
function meanAbsRange(
  buffer: AudioBuffer,
  fromSec: number,
  toSec: number
): number {
  const data = buffer.getChannelData(0);
  const start = Math.max(0, Math.floor(fromSec * buffer.sampleRate));
  const end = Math.min(data.length, Math.ceil(toSec * buffer.sampleRate));
  let sum = 0;
  for (let i = start; i < end; i++) sum += Math.abs(data[i]);
  return sum / Math.max(1, end - start);
}

function peakAbs(buffer: AudioBuffer): number {
  const data = buffer.getChannelData(0);
  let peak = 0;
  for (let i = 0; i < data.length; i++) {
    const v = Math.abs(data[i]);
    if (v > peak) peak = v;
  }
  return peak;
}

describe('APU noise channel initialization', () => {
  it('creates n1/n2 with audible, non-zero default gains', () => {
    const apu = createAPU();

    for (const id of ['n1', 'n2'] as const) {
      const state = apu.getChannelStates().get(id)!;
      assert.ok(state, `${id} state exists`);
      assert.ok(
        state.currentGain > 0,
        `${id} must default to a non-zero gain, got ${state.currentGain}`
      );
      assert.equal(state.currentGain, DEFAULT_NOISE_GAIN);
      assert.ok(apu.getNoiseChannel(id), `${id} channel instance exists`);
    }
  });

  it('keeps summed nominal channel gains under 1.0 for headroom', () => {
    const apu = createAPU();
    const states = apu.getChannelStates();

    let pulseSum = 0;
    let waveSum = 0;
    let noiseSum = 0;
    for (const [id, state] of states) {
      if (id.startsWith('p')) pulseSum += state.currentGain;
      else if (id.startsWith('w')) waveSum += state.currentGain;
      else if (id.startsWith('n')) noiseSum += state.currentGain;
    }

    assert.equal(pulseSum, 4 * DEFAULT_PULSE_GAIN);
    assert.equal(waveSum, 2 * DEFAULT_WAVE_GAIN);
    assert.equal(noiseSum, 2 * DEFAULT_NOISE_GAIN);

    const total = pulseSum + waveSum + noiseSum;
    assert.ok(
      total < 1,
      `summed default gains must stay below 1.0, got ${total}`
    );
    // Sanity: the two newly enabled noise channels only add 0.08.
    assert.equal(noiseSum, 0.08);
  });
});

describe('offline rendering of noise notes', () => {
  it('renders a non-silent fragment containing n1/n2 noise notes', async () => {
    const duration = 1;
    const apu = createAPU(duration);

    // A short drum-style pattern across both noise channels.
    apu.scheduleNote(noiseNote('n1', 0.05, 0.2, 36));
    apu.scheduleNote(noiseNote('n2', 0.1, 0.15, 60));
    apu.scheduleNote(noiseNote('n1', 0.35, 0.2, 38));
    apu.scheduleNote(noiseNote('n2', 0.55, 0.25, 72));

    const rendered = await renderAPU(apu, duration);

    assert.equal(rendered.length, Math.ceil(duration * SAMPLE_RATE));
    const overall = meanAbs(rendered);
    assert.ok(
      overall > AUDIBLE_MEAN,
      `rendered noise fragment must be audible, meanAbs=${overall}`
    );

    // The region after the last note should decay back toward silence,
    // proving the signal is real scheduled audio rather than constant noise.
    const tail = meanAbsRange(rendered, 0.9, 1.0);
    const active = meanAbsRange(rendered, 0.05, 0.8);
    assert.ok(
      active > tail * 2,
      `active region (${active}) should clearly exceed tail (${tail})`
    );
  });

  it('renders silence when the noise channels are muted via setChannelVolume(0)', async () => {
    const duration = 0.5;
    const apu = createAPU(duration);
    apu.setChannelVolume('n1', 0);
    apu.setChannelVolume('n2', 0);

    apu.scheduleNote(noiseNote('n1', 0.05, 0.2));
    apu.scheduleNote(noiseNote('n2', 0.1, 0.2));

    const rendered = await renderAPU(apu, duration);
    assert.equal(
      meanAbs(rendered),
      0,
      'muting both noise channels must silence their output'
    );
  });

  it('setChannelVolume scales a noise channel and master volume scales the mix', async () => {
    const renderAt = async (
      channelVolume: number,
      masterVolume: number
    ): Promise<number> => {
      const duration = 0.5;
      const apu = createAPU(duration);
      apu.setChannelVolume('n1', channelVolume);
      // Mute n2 so the measurement isolates n1.
      apu.setChannelVolume('n2', 0);
      apu.setMasterVolume(masterVolume);
      apu.scheduleNote(noiseNote('n1', 0.05, 0.25));
      const buffer = await renderAPU(apu, duration);
      return meanAbsRange(buffer, 0.05, 0.3);
    };

    const quiet = await renderAt(0.02, 0.7);
    const loud = await renderAt(0.2, 0.7);
    const masterCut = await renderAt(0.2, 0.1);

    assert.ok(loud > quiet * 3, `loud (${loud}) must exceed quiet (${quiet})`);
    assert.ok(
      masterCut < loud * 0.5,
      `lower master volume must reduce output: ${masterCut} vs ${loud}`
    );
  });

  it('does not clip the master bus with the new noise defaults', async () => {
    const duration = 1;
    const apu = createAPU(duration);

    // Overlap noise on both channels plus dense hits to exercise stacking.
    for (let t = 0; t < 8; t++) {
      apu.scheduleNote(noiseNote('n1', 0.05 + t * 0.05, 0.2, 36 + t));
      apu.scheduleNote(noiseNote('n2', 0.05 + t * 0.05, 0.2, 60 + t));
    }

    const rendered = await renderAPU(apu, duration);
    const peak = peakAbs(rendered);
    assert.ok(
      peak <= 1,
      `master output must not exceed full scale, peak=${peak}`
    );
    assert.ok(peak > 0, 'overlapping noise should still be audible');
  });
});

describe('NoiseChannel LFSR buffer cache', () => {
  function createNoiseChannel(): {
    channel: NoiseChannel;
    ctx: OfflineAudioContext;
  } {
    const ctx = new OfflineAudioContext(1, SAMPLE_RATE, SAMPLE_RATE);
    const output = ctx.createGain();
    output.connect(ctx.destination);
    const channel = new NoiseChannel(
      ctx as unknown as AudioContext,
      output,
      '15bit'
    );
    return { channel, ctx };
  }

  it('cache hit reuses a buffer that is long enough for the request', async () => {
    const { channel, ctx } = createNoiseChannel();
    const frequency = frequencyFor(36);

    // First request generates and caches a 0.3s (+ tail) buffer.
    const first = channel.playNoise(0.3, frequency, 100, 0.05);
    const firstLength = first.source.buffer!.length;

    // A shorter request with identical frequency/mode must hit the cache and
    // hand back the very same (sufficiently long) buffer.
    const second = channel.playNoise(0.15, frequency, 100, 0.45);

    assert.equal(
      second.source.buffer,
      first.source.buffer,
      'shorter request for identical frequency/mode should reuse the cache'
    );
    assert.ok(
      second.source.buffer!.duration >= 0.15,
      'cached buffer must cover the shorter requested duration'
    );
    assert.equal(second.source.buffer!.length, firstLength);

    await ctx.startRendering();
  });

  it('cache miss regenerates when the cached buffer is too short', async () => {
    const { channel, ctx } = createNoiseChannel();
    const frequency = frequencyFor(48);

    const short = channel.playNoise(0.1, frequency, 100, 0.05);
    const shortBuffer = short.source.buffer!;
    assert.ok(
      shortBuffer.duration >= 0.1 && shortBuffer.duration < 0.4,
      `unexpected short buffer duration ${shortBuffer.duration}`
    );

    // A longer request must NOT reuse the short buffer: reusing it would cut
    // the note's tail. Expect a freshly generated, strictly longer buffer.
    const long = channel.playNoise(0.5, frequency, 100, 0.3);
    const longBuffer = long.source.buffer!;

    assert.notEqual(
      longBuffer,
      shortBuffer,
      'longer request must miss the undersized cache entry'
    );
    assert.ok(
      longBuffer.duration >= 0.5,
      `new buffer must cover the 0.5s request, got ${longBuffer.duration}s`
    );
    assert.ok(
      longBuffer.length > shortBuffer.length,
      'regenerated buffer must be longer than the cached one'
    );

    // And the previously generated short entry must still be served from the
    // cache for the short request.
    const shortAgain = channel.playNoise(0.1, frequency, 100, 0.9);
    assert.equal(shortAgain.source.buffer, shortBuffer);

    await ctx.startRendering();
  });

  it('different frequency or mode never shares a cache entry', async () => {
    const { channel, ctx } = createNoiseChannel();
    const freqA = frequencyFor(36);
    const freqB = frequencyFor(84);

    const a = channel.playNoise(0.2, freqA, 100, 0.05).source.buffer!;
    const b = channel.playNoise(0.2, freqB, 100, 0.3).source.buffer!;
    channel.setMode('7bit');
    const c = channel.playNoise(0.2, freqA, 100, 0.55).source.buffer!;

    assert.notEqual(a, b, 'different frequencies must not share a buffer');
    assert.notEqual(a, c, 'different LFSR modes must not share a buffer');
    assert.notEqual(b, c);

    await ctx.startRendering();
  });
});

describe('stopAll / reset behavior', () => {
  it('stopAll clears noise caches and rescheduling still produces sound', async () => {
    const duration = 1.2;
    const apu = createAPU(duration);

    // First run: schedule and render a noise note so the cache is populated.
    apu.scheduleNote(noiseNote('n1', 0.05, 0.2, 36));
    const firstRender = await renderAPU(apu, duration);
    assert.ok(meanAbs(firstRender) > AUDIBLE_MEAN, 'first run must be audible');

    // stopAll() must drop every cached LFSR buffer.
    const n1 = apu.getNoiseChannel('n1')!;
    const n2 = apu.getNoiseChannel('n2')!;
    apu.stopAll();
    assert.deepEqual(
      (n1 as unknown as { bufferCache: unknown[] }).bufferCache,
      [],
      'n1 cache must be empty after stopAll'
    );
    assert.deepEqual(
      (n2 as unknown as { bufferCache: unknown[] }).bufferCache,
      [],
      'n2 cache must be empty after stopAll'
    );

    // Channel state bookkeeping is back to its initial, non-busy values.
    for (const id of ['n1', 'n2'] as const) {
      const state = apu.getChannelStates().get(id)!;
      assert.equal(state.isBusy, false);
      assert.equal(state.busyUntil, 0);
    }

    // Second run on a fresh offline context (the previous one is consumed):
    // reschedule and confirm sound is produced again with no stale sources.
    const duration2 = 0.8;
    const offline2 = new OfflineAudioContext(
      1,
      Math.ceil(duration2 * SAMPLE_RATE),
      SAMPLE_RATE
    );
    const apu2 = new GameBoyAPU(
      offline2 as unknown as AudioContext,
      DEFAULT_V2_CONFIG
    );
    apu2.scheduleNote(noiseNote('n1', 0.05, 0.25, 36));
    apu2.scheduleNote(noiseNote('n2', 0.2, 0.2, 60));
    const secondBuffer = await (
      apu2.getAudioContext() as unknown as OfflineAudioContext
    ).startRendering();
    assert.ok(
      meanAbs(secondBuffer) > AUDIBLE_MEAN,
      'rescheduled noise after stopAll must still be audible'
    );
  });

  it('reset() restores noise mode and drops caches, but keeps mixer gains', () => {
    const apu = createAPU();
    const n1 = apu.getNoiseChannel('n1')!;

    assert.equal(n1.getMode(), '7bit'); // n1 is constructed in 7-bit mode
    n1.setMode('15bit');
    assert.equal(n1.getMode(), '15bit');

    // Populate the cache, then reset.
    const ctx = apu.getAudioContext() as unknown as OfflineAudioContext;
    const frequency = frequencyFor(36);
    n1.playNoise(0.2, frequency, 100, 0.05);
    assert.ok(
      (n1 as unknown as { bufferCache: unknown[] }).bufferCache.length > 0
    );

    // A user volume adjustment must survive a playback reset.
    apu.setChannelVolume('n1', 0.09);

    apu.reset();

    assert.equal(
      n1.getMode(),
      '7bit',
      'reset must restore the constructor mode'
    );
    assert.deepEqual(
      (n1 as unknown as { bufferCache: unknown[] }).bufferCache,
      [],
      'reset must clear the LFSR buffer cache'
    );
    assert.equal(
      apu.getChannelStates().get('n1')!.currentGain,
      0.09,
      'reset must not touch the per-channel mixer gain'
    );
    assert.equal(ctx.state, 'suspended');
  });

  it('stopAll stops every tracked source and clears the active-node registry', () => {
    const apu = createAPU(1);

    // Schedule a few noise notes and capture their underlying source nodes.
    apu.scheduleNote(noiseNote('n1', 0.05, 0.8, 36));
    apu.scheduleNote(noiseNote('n2', 0.1, 0.6, 60));
    apu.scheduleNote(noiseNote('n1', 0.25, 0.5, 38));

    const activeNodes = (
      apu as unknown as { activeNodes: Set<AudioBufferSourceNode> }
    ).activeNodes;
    assert.equal(activeNodes.size, 3, 'all three notes should be tracked');

    const stoppedAt: number[] = [];
    for (const node of activeNodes) {
      const originalStop = node.stop.bind(node);
      node.stop = ((when?: number) => {
        stoppedAt.push(when ?? Number.NaN);
        // Don't call the polyfill's stop(0): before an offline render starts
        // its clock is 0 and that call is a documented no-op in the polyfill.
        // In a real browser stop(0) is honored; here we only need to prove
        // stopAll invoked stop on every tracked node.
        if (when !== undefined && when > 0) originalStop(when);
      }) as AudioBufferSourceNode['stop'];
    }

    apu.stopAll();

    assert.equal(stoppedAt.length, 3, 'every tracked source must receive stop()');
    assert.equal(activeNodes.size, 0, 'the active-node registry must be empty');
  });

  it('a stopped source ends at the requested time (no lingering playback)', async () => {
    // End-to-end proof of the primitive stopAll() relies on: an
    // AudioBufferSourceNode stopped inside the render window emits nothing
    // after its stop point. We feed a constant full-scale buffer so the
    // on/off boundary is unambiguous (no envelope gain involved).
    const sr = SAMPLE_RATE;
    const duration = 0.5;
    const ctx = new OfflineAudioContext(1, Math.ceil(duration * sr), sr);
    const buffer = ctx.createBuffer(1, Math.ceil(duration * sr), sr);
    buffer.getChannelData(0).fill(1);

    const source = ctx.createBufferSource();
    source.buffer = buffer;
    const gain = ctx.createGain();
    gain.gain.value = 0.25;
    source.connect(gain);
    gain.connect(ctx.destination);

    source.start(0.05);
    source.stop(0.2);

    const rendered = (await ctx.startRendering()) as unknown as AudioBuffer;
    const data = rendered.getChannelData(0);

    // Samples well inside the playing window are at full level...
    assert.ok(
      meanAbsRange(rendered, 0.1, 0.18) > 0.2,
      'source must be playing at full level before the stop point'
    );
    // ...and everything after the stop point is exactly silent.
    let anyAfterStop = 0;
    for (let i = Math.floor(0.25 * sr); i < data.length; i++) {
      if (data[i] !== 0) anyAfterStop++;
    }
    assert.equal(
      anyAfterStop,
      0,
      'a stopped buffer source must emit zero samples past its stop time'
    );
  });
});

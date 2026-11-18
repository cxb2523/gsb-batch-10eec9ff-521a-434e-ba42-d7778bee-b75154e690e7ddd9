// Boss audio cue tests: the warn/spawn note sequences must be driven by the
// effects layer's simulation-time schedule queue so they freeze on pause /
// tab-hide, resume in order (no catch-up burst), and can be cancelled when
// a boss is spawned or defeated before its cue finishes.
//
// We use the real AudioEngine with `tone` stubbed out to record calls, so
// no audio device is needed.

import test from 'node:test';
import assert from 'node:assert/strict';
import { AudioEngine } from '../src/audio.js';
import { EffectLayer, BossCueTracker } from '../src/effects.js';

function makeRig() {
    const calls = [];
    const audio = new AudioEngine({});
    audio.tone = (p) => calls.push(p); // record instead of touching WebAudio
    const fx = new EffectLayer();
    const cues = new BossCueTracker();
    const schedule = (t, fn) => fx.schedule(t, fn);
    return { calls, audio, fx, cues, schedule };
}

test('boss warn cue: notes fire in order as simulation time advances', () => {
    const { calls, audio, fx, cues, schedule } = makeRig();
    cues.track('reaper', audio.bossWarn(schedule));

    assert.equal(calls.length, 0, 'nothing fires before the first sim tick');

    fx.update(0.1); // t=0.1 → first note (delay 0)
    assert.deepEqual(
        calls.map((c) => c.freq),
        [480]
    );

    fx.update(0.1); // t=0.2 → second note (delay 0.14)
    fx.update(0.1); // t=0.3 → third note (delay 0.28)
    assert.deepEqual(
        calls.map((c) => c.freq),
        [480, 360, 240]
    );

    fx.update(1.0);
    assert.equal(calls.length, 3, 'no note re-fires after the sequence ends');
});

test('boss warn cue: pausing freezes the sequence, resume continues in order', () => {
    const { calls, audio, fx, cues, schedule } = makeRig();
    cues.track('reaper', audio.bossWarn(schedule));

    fx.update(0.1); // first note plays
    assert.equal(calls.length, 1);

    // "Paused": no update() calls happen — wall clock may pass but the
    // queue must not advance. (There is nothing to assert against time
    // here; the point is the remaining notes only fire via update().)
    assert.equal(calls.length, 1, 'no progress while the sim is frozen');

    // Resume: remaining notes play in the original order, spaced by their
    // remaining sim-time delays — not all at once.
    fx.update(0.1);
    assert.deepEqual(
        calls.map((c) => c.freq),
        [480, 360],
        'second note fires on schedule after resume'
    );
    fx.update(0.1);
    assert.deepEqual(calls.map((c) => c.freq), [480, 360, 240]);
});

test('boss cue tracker: cancelling mid-sequence suppresses remaining notes', () => {
    const { calls, audio, fx, cues, schedule } = makeRig();
    cues.track('reaper', audio.bossWarn(schedule));

    fx.update(0.1); // first note plays
    assert.equal(calls.length, 1);

    // Boss defeated before the warning finished → cancel the stale cue.
    cues.cancel('reaper');

    fx.update(0.5);
    fx.update(0.5);
    assert.equal(calls.length, 1, 'leftover warn notes must not play after cancel');
});

test('boss cue tracker: track() replaces a previous cue for the same boss', () => {
    const { calls, audio, fx, cues, schedule } = makeRig();
    cues.track('reaper', audio.bossWarn(schedule));
    fx.update(0.1); // first warn note
    assert.equal(calls.length, 1);

    // Re-tracking (e.g. warn → spawn handoff) cancels the old sequence.
    cues.track('reaper', audio.bossSpawn(schedule));
    fx.update(1.0); // drain everything

    const freqs = calls.map((c) => c.freq);
    assert.equal(calls.length, 3, 'old warn tail must not leak into the spawn cue');
    assert.deepEqual(freqs.slice(1), [undefined, 80], 'spawn cue = noise burst + low sawtooth');
});

test('boss spawn cue: noise burst first, low sawtooth after 0.1s of sim time', () => {
    const { calls, audio, fx, cues, schedule } = makeRig();
    cues.track('reaper', audio.bossSpawn(schedule));

    fx.update(0.05);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].noise, true);

    fx.update(0.05); // crosses the 0.1s mark
    assert.equal(calls.length, 2);
    assert.equal(calls[1].freq, 80);
});

test('boss cue tracker: cancelAll clears every in-flight cue (run reset)', () => {
    const { calls, audio, fx, cues, schedule } = makeRig();
    cues.track('reaper', audio.bossWarn(schedule));
    cues.track('void_lord', audio.bossWarn(schedule));
    cues.cancelAll();

    fx.update(1.0);
    assert.equal(calls.length, 0, 'no cue survives a run reset');
});

test('boss warn without a scheduler keeps the legacy immediate first note', () => {
    const { calls, audio } = makeRig();
    const tokens = audio.bossWarn();
    assert.equal(tokens.length, 0, 'no tokens without a scheduler');
    assert.equal(calls.length, 1, 'first note plays immediately');
    assert.equal(calls[0].freq, 480);
    // Remaining notes use wall-clock setTimeout in legacy mode; the game
    // itself always passes a scheduler, so we don't wait for them here.
});

test('screen flash decay is sim-time driven: frozen until update() runs', () => {
    const fx = new EffectLayer();
    fx.bossSpawn(); // red flash, alpha 0.55, decay 1.6
    assert.equal(fx.flash.alpha, 0.55);

    // "Paused": without update() the alpha must hold exactly.
    assert.equal(fx.flash.alpha, 0.55, 'flash does not decay on its own');

    fx.update(0.1);
    assert.ok(Math.abs(fx.flash.alpha - (0.55 - 0.16)) < 1e-9, 'decays only with sim dt');
});

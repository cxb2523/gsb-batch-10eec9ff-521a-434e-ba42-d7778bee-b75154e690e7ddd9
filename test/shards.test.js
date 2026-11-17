// Shard reconciliation: the parts of a parallel render must agree on muxer and colour range before ffmpeg joins
// them, and a diverging first attempt is retried as one whole render — never per shard. Pure logic, no Chrome.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { encodeWithFallback, reconcileShards } from '../src/render.js';

const quiet = () => {};

test('shards: uniform mux and colour range reconcile to the agreed values', () => {
  assert.deepEqual(reconcileShards([{ mux: 'mediabunny', fullRange: false }, { mux: 'mediabunny', fullRange: false }]), { mux: 'mediabunny', fullRange: false });
  assert.deepEqual(reconcileShards([{ mux: 'raw', fullRange: true }]), { mux: 'raw', fullRange: true });
  assert.deepEqual(reconcileShards([{ mux: 'raw', fullRange: false }, { mux: 'raw', fullRange: false }, { mux: 'raw', fullRange: false }]), { mux: 'raw', fullRange: false });
});

test('shards: a colour-range disagreement aborts with a clear, coded error', () => {
  let err;
  try { reconcileShards([{ mux: 'raw', fullRange: false }, { mux: 'raw', fullRange: true }]); } catch (e) { err = e; }
  assert.match(err.message, /different colour ranges/);
  assert.equal(err.code, 'range-diverged');
  assert.match(err.message, /worker 1: limited/);   // says which worker encoded what
  assert.match(err.message, /worker 2: full/);
  assert.match(err.message, /--workers 1/);   // and what to do about it
});

test('shards: colour-range divergence is not retried as a mux fallback', async () => {
  const tried = [];
  const attempt = async mux => { tried.push(mux); return reconcileShards([{ mux, fullRange: false }, { mux, fullRange: true }]); };
  await assert.rejects(encodeWithFallback(attempt, { want: 'auto', log: quiet }), /different colour ranges/);
  assert.deepEqual(tried, ['mediabunny']);   // no wasteful re-encode: the divergence is in the workers, not the muxer
});

test('shards: mixed muxers make the whole render retry once as raw, and the result says what was used', async () => {
  const tried = [], logs = [];
  const attempt = async mux => {
    tried.push(mux);
    // one shard fell back to the raw bitstream while the other muxed with Mediabunny
    if (mux === 'mediabunny') reconcileShards([{ mux: 'mediabunny', fullRange: false }, { mux: 'raw', fullRange: false }]);
    return { mux, fullRange: false };
  };
  const res = await encodeWithFallback(attempt, { want: 'auto', log: m => logs.push(m) });
  assert.deepEqual(tried, ['mediabunny', 'raw']);   // the whole render is re-encoded as raw, not just the diverging shard
  assert.equal(res.mux, 'raw');   // the summary reflects the mux actually used
  assert.match(logs.join('\n'), /packaged their parts differently/);
  assert.match(logs.join('\n'), /Retrying the whole render/);
});

test('shards: divergence on the raw path aborts with a clear error instead of looping', async () => {
  const tried = [];
  const attempt = async mux => { tried.push(mux); return reconcileShards([{ mux, fullRange: false }, { mux: mux === 'raw' ? 'mediabunny' : 'raw', fullRange: false }]); };
  const err = await encodeWithFallback(attempt, { want: 'auto', log: quiet }).then(() => null, e => e);
  assert.equal(err?.code, 'mux-diverged');
  assert.deepEqual(tried, ['mediabunny', 'raw']);   // exactly one retry, then the error surfaces
});

test('shards: an explicit mux choice is not silently retried', async () => {
  for (const want of ['raw', 'mediabunny']) {
    const tried = [];
    const attempt = async mux => { tried.push(mux); throw new Error('boom'); };
    await assert.rejects(encodeWithFallback(attempt, { want, log: quiet }), /boom/);
    assert.deepEqual(tried, [want]);
  }
});

test('shards: a Mediabunny failure with mux auto still falls back to raw (existing behaviour)', async () => {
  const tried = [], logs = [];
  const attempt = async mux => { tried.push(mux); if (mux === 'mediabunny') throw new Error('failed to fetch mediabunny.mjs'); return { mux, fullRange: true }; };
  const res = await encodeWithFallback(attempt, { want: 'auto', log: m => logs.push(m) });
  assert.deepEqual(tried, ['mediabunny', 'raw']);
  assert.equal(res.mux, 'raw');
  assert.match(logs.join('\n'), /Mediabunny path failed/);   // the reason is named (the exact wording depends on whether mediabunny is installed)
  assert.match(logs.join('\n'), /Retrying the whole render with raw bitstream/);
});

test('shards: an aborted render is not retried', async () => {
  const tried = [];
  const attempt = async mux => { tried.push(mux); throw new Error('closed'); };
  const signal = AbortSignal.abort();
  await assert.rejects(encodeWithFallback(attempt, { want: 'auto', signal, log: quiet }), /closed/);
  assert.deepEqual(tried, ['mediabunny']);
});

import assert from 'assert';
import axios, { CanceledError } from 'axios';
import Player from '../src/Player';
import { CHUNK_SIZE } from '../src/ClipState';
import { PRELOAD_BATCH_SIZE } from '../src/FetchCursor';
import { getSilenceURL, getRawSilenceBuffer } from '../src/utils/silence';

// ---------------------------------------------------------------------------
// Browser environment shims (mocha runs in Node, the player expects a browser)
// ---------------------------------------------------------------------------
global.__DEV__ = false;

class FakeAudioContext {
  constructor() {
    this.destination = {};
    this._startTime = Date.now();
    this.startedSources = [];
  }

  get currentTime() {
    return (Date.now() - this._startTime) / 1000;
  }

  resume() {
    return Promise.resolve();
  }

  createGain() {
    return {
      gain: { value: 1, setValueAtTime: () => {} },
      connect: () => {},
      disconnect: () => {},
    };
  }

  createBufferSource() {
    const source = {
      buffer: null,
      loop: false,
      connect: () => {},
      stop: () => {},
      start: () => {
        this.startedSources.push(source);
      },
    };
    return source;
  }

  createBuffer(numberOfChannels, length, sampleRate) {
    return {
      numberOfChannels,
      length,
      sampleRate,
      getChannelData: () => new Float32Array(length),
    };
  }

  decodeAudioData(buffer, success) {
    const decoded = {
      sampleRate: 44100,
      numberOfChannels: 2,
      length: 1152 * 10,
      getChannelData: () => new Float32Array(1152 * 10),
    };
    setTimeout(() => success(decoded), 0);
  }
}

global.window = {
  AudioContext: FakeAudioContext,
  webkitAudioContext: FakeAudioContext,
};
global.requestAnimationFrame = (cb) => setTimeout(cb, 16);

// ---------------------------------------------------------------------------
// Locally generated MP3: the repo's own silence sample repeated until it
// spans several 64KB chunks, so chunk durations parse exactly like a real
// MP3 streamed over the network.
// ---------------------------------------------------------------------------
const CHUNK_COUNT = 6;
const FILE_SIZE = CHUNK_COUNT * CHUNK_SIZE;

const URL_A = 'https://example.test/track-a.mp3';
const URL_B = 'https://example.test/track-b.mp3';
const URL_C = 'https://example.test/track-c.mp3';

const buildMp3 = () => {
  const silence = new Uint8Array(getRawSilenceBuffer());
  const file = new Uint8Array(FILE_SIZE);
  for (let offset = 0; offset < FILE_SIZE; offset += silence.length) {
    file.set(
      silence.subarray(0, Math.min(silence.length, FILE_SIZE - offset)),
      offset
    );
  }
  return file;
};

// ---------------------------------------------------------------------------
// Controllable fetch stub: intercepts axios (used by FetchJob), serves byte
// ranges of the generated MP3 with a configurable delay, supports aborts and
// forced failures, and records every request so tests can detect duplicate
// chunk fetches.
// ---------------------------------------------------------------------------
const createFetchStub = () => {
  const stub = {
    requests: [],
    routes: new Map(),

    addRoute(url, data, { delay = 20 } = {}) {
      stub.routes.set(url, { data, delay, fail: false });
    },

    setDelay(url, delay) {
      stub.routes.get(url).delay = delay;
    },

    setFail(url, fail) {
      stub.routes.get(url).fail = fail;
    },

    requestsFor(url) {
      return stub.requests.filter((r) => r.url === url);
    },

    adapter(config) {
      const url = config.url;
      const range = config.headers && config.headers.range;
      stub.requests.push({ url, range });
      return new Promise((resolve, reject) => {
        const route = stub.routes.get(url);
        const timer = setTimeout(
          () => {
            if (!route) {
              reject(new Error(`No stub route registered for ${url}`));
              return;
            }
            if (route.fail) {
              const err = new Error('Request failed with status code 500');
              err.response = { status: 500 };
              reject(err);
              return;
            }
            let data = route.data;
            if (range) {
              const [start, end] = range.split('-').map(Number);
              data = data.slice(start, end);
            }
            const body = data.buffer.slice(
              data.byteOffset,
              data.byteOffset + data.byteLength
            );
            resolve({
              data: body,
              status: 200,
              statusText: 'OK',
              headers: {},
              config,
            });
          },
          route ? route.delay : 0
        );
        if (config.signal) {
          config.signal.addEventListener('abort', () => {
            clearTimeout(timer);
            reject(new CanceledError('Fetch stub: request aborted'));
          });
        }
      });
    },
  };
  return stub;
};

const waitFor = (fn, timeout = 5000) =>
  new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      let ok = false;
      try {
        ok = fn();
      } catch (err) {
        ok = false;
      }
      if (ok) return resolve();
      if (Date.now() - start > timeout) {
        return reject(new Error('waitFor timed out'));
      }
      setTimeout(check, 10);
    };
    check();
  });

describe('preload/playback lifecycle isolation', function () {
  let stub;
  let originalAdapter;
  let players;

  const createPlayer = () => {
    const errors = [];
    return new Promise((resolve) => {
      const player = new Player({
        onError: (err) => errors.push(err),
        onNextTrack: () => {},
        onPlaybackEnded: () => {},
        onPlaybackProgress: () => {},
        onPreviousTrack: () => {},
        onTrackChanged: () => {},
        onReady: () => resolve(player),
        onVolumeChanged: () => {},
        volume: 1,
      });
    });
  };

  before(function () {
    originalAdapter = axios.defaults.adapter;
    stub = createFetchStub();
    const mp3 = buildMp3();
    stub.addRoute(getSilenceURL(), new Uint8Array(getRawSilenceBuffer()), {
      delay: 1,
    });
    stub.addRoute(URL_A, mp3, { delay: 30 });
    stub.addRoute(URL_B, mp3, { delay: 30 });
    stub.addRoute(URL_C, mp3, { delay: 30 });
    axios.defaults.adapter = (config) => stub.adapter(config);
  });

  after(function () {
    axios.defaults.adapter = originalAdapter;
  });

  beforeEach(function () {
    players = [];
    stub.requests.length = 0;
    [URL_A, URL_B, URL_C].forEach((url) => {
      stub.setDelay(url, 30);
      stub.setFail(url, false);
    });
  });

  afterEach(function () {
    while (players.length) {
      const player = players.pop();
      player.stopAll();
      player.disposeAll();
    }
  });

  const track = (url) => ({ url, fileSize: FILE_SIZE });

  const assertAllChunksBuffered = (clip) => {
    for (let i = 0; i < CHUNK_COUNT; i += 1) {
      assert.ok(
        clip._clipState.isChunkReady(i),
        `expected chunk ${i} to be buffered`
      );
    }
  };

  it('keeps an in-flight preload alive when the current track stops', async function () {
    this.timeout(15000);
    stub.setDelay(URL_B, 100); // slow chunks: the preload is still in flight below
    const player = await createPlayer();
    players.push(player);

    await player.playTrack(track(URL_A));
    await waitFor(() => stub.requestsFor(URL_A).length > 0);

    // Queue the next track; its preload starts fetching.
    player.playNext(track(URL_B));
    const clipB = player.clips[URL_B];
    assert.ok(clipB, 'expected a clip to be created for the next track');
    await waitFor(() => stub.requestsFor(URL_B).length >= 1);
    assert.ok(clipB._preBuffering, 'preload should be in flight');

    // The current track stops (user skips) while the preload is still
    // fetching, then we switch to the next track.
    player.stopAll();
    await player.playTrack(track(URL_B));

    assert.strictEqual(player.currentlyPlaying.url, URL_B);
    assert.strictEqual(
      player.clips[URL_B],
      clipB,
      'expected the preloading clip instance to be reused'
    );

    // Playback starts and reaches real (non-silence) audio.
    await waitFor(() => clipB._lastPlayedChunk === 0);

    // The whole file finishes loading, with no gaps.
    await waitFor(() => clipB._buffered, 10000);
    assertAllChunksBuffered(clipB);

    // The preload was never cancelled by the current track's stop: every
    // chunk was requested exactly once — no aborted-then-refetched chunks.
    const ranges = stub.requestsFor(URL_B).map((r) => r.range);
    assert.strictEqual(
      ranges.length,
      CHUNK_COUNT,
      `expected ${CHUNK_COUNT} requests for track B, got: ${ranges.join(', ')}`
    );
    assert.strictEqual(new Set(ranges).size, CHUNK_COUNT);
  });

  it('reuses fully preloaded chunks on playTrack instead of re-fetching them', async function () {
    this.timeout(15000);
    const player = await createPlayer();
    players.push(player);

    await player.playTrack(track(URL_A));
    await waitFor(() => stub.requestsFor(URL_A).length > 0);

    // Queue the next track and wait until its preload batch is buffered.
    player.playNext(track(URL_B));
    const clipB = player.clips[URL_B];
    assert.ok(clipB, 'expected a clip to be created for the next track');
    await waitFor(() => clipB._preBuffered);
    assert.strictEqual(
      stub.requestsFor(URL_B).length,
      PRELOAD_BATCH_SIZE,
      'preload should have fetched exactly one batch'
    );

    // The current track stops (user skips) and we switch to the next track.
    player.stopAll();
    await player.playTrack(track(URL_B));

    assert.strictEqual(player.currentlyPlaying.url, URL_B);
    assert.strictEqual(
      player.clips[URL_B],
      clipB,
      'expected the preloaded clip instance to be reused'
    );

    // The beginning plays right away from the preloaded data.
    await waitFor(() => clipB._lastPlayedChunk === 0);

    // The rest of the file finishes loading in the background.
    await waitFor(() => clipB._buffered, 10000);
    assertAllChunksBuffered(clipB);

    // Every chunk was requested exactly once: preloaded chunks were reused
    // instead of being re-fetched, and no competing fetch loop was started.
    const ranges = stub.requestsFor(URL_B).map((r) => r.range);
    assert.strictEqual(
      ranges.length,
      CHUNK_COUNT,
      `expected ${CHUNK_COUNT} requests for track B, got: ${ranges.join(', ')}`
    );
    assert.strictEqual(new Set(ranges).size, CHUNK_COUNT);
  });

  it('reloads and plays a track whose preload was cancelled mid-flight', async function () {
    this.timeout(15000);
    stub.setDelay(URL_B, 100);
    const player = await createPlayer();
    players.push(player);

    player.playNext(track(URL_B));
    const cancelledClip = player.clips[URL_B];
    await waitFor(() => stub.requestsFor(URL_B).length >= 1);
    assert.ok(cancelledClip._preBuffering, 'preload should be in flight');

    // The preload is cancelled mid-flight while its fetches are still
    // pending (e.g. the playlist is cleared).
    player.disposeAll();
    assert.ok(!player.clips[URL_B], 'expected the cancelled clip to be disposed');

    // Now the track is actually played: loading must restart from scratch
    // and playback must begin.
    const requestsBeforeReplay = stub.requestsFor(URL_B).length;
    await player.playTrack(track(URL_B));
    const clipB = player.clips[URL_B];
    assert.ok(clipB && clipB !== cancelledClip);

    await waitFor(() => clipB._lastPlayedChunk === 0);
    await waitFor(() => clipB._buffered, 10000);
    assertAllChunksBuffered(clipB);

    const ranges = stub
      .requestsFor(URL_B)
      .slice(requestsBeforeReplay)
      .map((r) => r.range);
    assert.strictEqual(
      ranges.length,
      CHUNK_COUNT,
      `expected ${CHUNK_COUNT} requests after replay, got: ${ranges.join(', ')}`
    );
    assert.strictEqual(new Set(ranges).size, CHUNK_COUNT);
  });

  it('reloads and plays a track whose preload failed', async function () {
    this.timeout(15000);
    const player = await createPlayer();
    players.push(player);

    stub.setFail(URL_B, true);
    player.playNext(track(URL_B));
    const clipB = player.clips[URL_B];

    // The preload fails and settles.
    await waitFor(() => !clipB._preBuffering);
    assert.ok(!clipB._preBuffered);

    // The network recovers: playing the track must start a fresh load.
    stub.setFail(URL_B, false);
    await player.playTrack(track(URL_B));
    assert.strictEqual(
      player.clips[URL_B],
      clipB,
      'expected the same clip instance to be reused after a failed preload'
    );

    await waitFor(() => clipB._lastPlayedChunk === 0);
    await waitFor(() => clipB._buffered, 10000);
    assertAllChunksBuffered(clipB);

    const ranges = stub.requestsFor(URL_B).map((r) => r.range);
    const successfulRanges = ranges.slice(PRELOAD_BATCH_SIZE);
    assert.strictEqual(successfulRanges.length, CHUNK_COUNT);
    assert.strictEqual(new Set(successfulRanges).size, CHUNK_COUNT);
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDefaultPreferences } from '../src/entities/preferences.entity';
import type { ClipData, ClipRange } from '../src/entities/clip.entity';
import type { MessageCatalog } from '../src/shared/services/i18n.service';
import { PlyrAdapter } from '../src/features/video-player/adapters/plyr.adapter';

vi.mock('../src/shared/services/i18n.service', async (importOriginal) => ({
  ...await importOriginal<object>(), getMessage: (key: string) => key,
}));

const catalog = {
  triggerMarkerLabel: 'Event',
  errReviewVideoMetadataLoadFailed: 'metadata-failed',
  errReviewVideoMetadataTimeout: 'metadata-timeout',
  errReviewVideoSeekFailed: 'seek-failed',
  errVideoOperationTimeout: 'operation-timeout',
  errVideoJsEarlyConfig: 'early-config',
} as MessageCatalog;

const createClip = (range: ClipRange, overrides: Partial<ClipData> = {}): ClipData => ({
  taskId: 'local-task',
  sourceWebmUrl: 'https://example.invalid/local.webm',
  videoId: 'local',
  reviewType: 'legacy',
  eventTime: -1,
  range,
  app: 'cs2',
  clipCount: null,
  matchTimestamp: null,
  webmDuration: 120,
  ...overrides,
});

interface LocalVideo {
  adapter: PlyrAdapter;
  video: HTMLVideoElement;
  element: HTMLDivElement;
  writes: number[];
  plays: () => number;
  setTime: (value: number) => void;
}

let cleanup: (() => void)[] = [];

/** The accumulated step target expires 150 ms after the last key press. */
const settleStepTarget = (): Promise<void> => new Promise((resolve) => { setTimeout(resolve, 170); });

const createLocalVideo = (duration = 120): LocalVideo => {
  const element = document.createElement('div');
  const video = document.createElement('video');
  element.append(video);
  document.body.append(element);

  let time = 0;
  const writes: number[] = [];
  // A self-made media element stand-in: no portal fixture, no real network.
  Object.defineProperty(video, 'duration', { configurable: true, value: duration });
  Object.defineProperty(video, 'readyState', { configurable: true, value: HTMLMediaElement.HAVE_CURRENT_DATA });
  Object.defineProperty(video, 'paused', { configurable: true, value: true });
  Object.defineProperty(video, 'currentTime', {
    configurable: true,
    get: () => time,
    set: (value: number) => { time = value; writes.push(value); },
  });

  let playCount = 0;
  const play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(async function (this: HTMLMediaElement) {
    if (this === video) playCount += 1;
  });
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, 'canPlayType').mockReturnValue('probably');
  vi.spyOn(console, 'warn').mockImplementation(() => {});

  const adapter = new PlyrAdapter({
    playerHost: { mount: () => ({ element, video }), dispose: () => {} },
    catalog: () => catalog,
    onPreferences: vi.fn(),
    onPlayerOverlay: vi.fn(),
  });
  cleanup.push(() => {
    adapter.dispose();
    element.remove();
    play.mockRestore();
  });

  return {
    adapter,
    video,
    element,
    writes,
    plays: () => playCount,
    setTime: (value: number) => { time = value; },
  };
};

beforeEach(() => {
  sessionStorage.clear();
  cleanup = [];
});

afterEach(() => {
  for (const dispose of cleanup.splice(0)) dispose();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('Plyr adapter frame stepping inside the review range', () => {
  it('stays inside a normal clip on both edges', async () => {
    const { adapter, video } = createLocalVideo(120);
    adapter.configure(createDefaultPreferences(), createClip({ start: 10, end: 100 }));

    adapter.handle({ type: 'step', direction: -1 });
    expect(video.currentTime).toBe(10);
    adapter.handle({ type: 'step', direction: -1 });
    expect(video.currentTime).toBe(10);

    await settleStepTarget();
    video.currentTime = 100;
    adapter.handle({ type: 'step', direction: 1 });
    expect(video.currentTime).toBe(100);
    adapter.handle({ type: 'step', direction: 1 });
    expect(video.currentTime).toBe(100);
  });

  it('advances by one frame and keeps the lower bound even near the start', async () => {
    const { adapter, video, setTime, writes } = createLocalVideo(120);
    adapter.configure(createDefaultPreferences(), createClip({ start: 10, end: 100 }));
    setTime(10);

    adapter.handle({ type: 'step', direction: 1 });
    expect(writes.at(-1)).toBeGreaterThan(10);
    expect(writes.at(-1)).toBeLessThan(11);
    expect(video.currentTime).toBeGreaterThan(10);

    adapter.handle({ type: 'step', direction: -1 });
    expect(writes.at(-1)).toBe(10);
  });

  it('accumulates the target when the browser has not applied the previous seek yet', () => {
    const { adapter, video, writes } = createLocalVideo(120);
    adapter.configure(createDefaultPreferences(), createClip({ start: 10, end: 100 }));
    const frame = 1 / 60;
    // The element keeps reporting an unchanged position, as with a lazy seek.
    Object.defineProperty(video, 'currentTime', {
      configurable: true,
      get: () => 20,
      set: (value: number) => { writes.push(value); },
    });

    adapter.handle({ type: 'step', direction: 1 });
    adapter.handle({ type: 'step', direction: 1 });

    expect(writes).toHaveLength(2);
    expect(writes[0]).toBeCloseTo(20 + frame, 10);
    expect(writes[1]).toBeCloseTo(20 + 2 * frame, 10);
  });

  it('starts from the nearest edge when the position is a stale frame of the previous clip', async () => {
    const { adapter, video, setTime } = createLocalVideo(200);
    adapter.configure(createDefaultPreferences(), createClip({ start: 30, end: 120 }));
    // The element still points into the previous clip's territory.
    setTime(5);

    adapter.handle({ type: 'step', direction: 1 });
    expect(video.currentTime).toBeCloseTo(30 + 1 / 60, 10);

    await settleStepTarget();
    setTime(150);
    adapter.handle({ type: 'step', direction: -1 });
    expect(video.currentTime).toBeCloseTo(120 - 1 / 60, 10);
  });

  it('treats a short clip as open-ended up to the media duration', async () => {
    const { adapter, video, setTime } = createLocalVideo(45);
    adapter.configure(createDefaultPreferences(), createClip({ start: 10, end: 40 }));
    setTime(45);

    adapter.handle({ type: 'step', direction: 1 });
    expect(video.currentTime).toBe(45);
    adapter.handle({ type: 'step', direction: -1 });
    expect(video.currentTime).toBeCloseTo(45 - 1 / 60, 10);
  });
});

describe('Plyr adapter event jump', () => {
  it('seeks two seconds before the event inside the range', () => {
    const { adapter, video } = createLocalVideo(120);
    adapter.configure(createDefaultPreferences(), createClip({ start: 10, end: 100 }, { eventTime: 50 }));

    adapter.handle({ type: 'jump-to-event' });
    expect(video.currentTime).toBe(48);
  });

  it('clamps an event time that lies outside the range', () => {
    const { adapter, video } = createLocalVideo(120);
    adapter.configure(createDefaultPreferences(), createClip({ start: 10, end: 100 }, { eventTime: 150 }));
    adapter.handle({ type: 'jump-to-event' });
    expect(video.currentTime).toBe(100);

    adapter.configure(createDefaultPreferences(), createClip({ start: 10, end: 100 }, { eventTime: 5 }));
    adapter.handle({ type: 'jump-to-event' });
    expect(video.currentTime).toBe(10);
  });

  it('ignores a clip without a marked event', () => {
    const { adapter, video, writes } = createLocalVideo(120);
    adapter.configure(createDefaultPreferences(), createClip({ start: 10, end: 100 }, { eventTime: -1 }));
    adapter.handle({ type: 'jump-to-event' });
    expect(writes).toHaveLength(0);
    expect(video.currentTime).toBe(0);
  });
});

describe('Plyr adapter invalid review range', () => {
  it('falls back to the whole video for stepping', async () => {
    const { adapter, video } = createLocalVideo(90);
    // end <= start: the portal reported an unusable interval.
    adapter.configure(createDefaultPreferences(), createClip({ start: 20, end: 10 }));

    video.currentTime = 2;
    adapter.handle({ type: 'step', direction: 1 });
    expect(video.currentTime).toBeCloseTo(2 + 1 / 60, 10);

    await settleStepTarget();
    video.currentTime = 90;
    adapter.handle({ type: 'step', direction: 1 });
    expect(video.currentTime).toBe(90);

    await settleStepTarget();
    video.currentTime = 0;
    adapter.handle({ type: 'step', direction: -1 });
    expect(video.currentTime).toBe(0);
  });

  it('falls back to the whole video for an event jump', () => {
    const { adapter, video } = createLocalVideo(90);
    adapter.configure(createDefaultPreferences(), createClip({ start: 20, end: 10 }, { eventTime: 150 }));

    adapter.handle({ type: 'jump-to-event' });
    expect(video.currentTime).toBe(90);
  });
});

describe('Plyr adapter load races', () => {
  it('does not seek, play or clear loading state when a newer load interrupts metadata', async () => {
    const { adapter, video, element, writes, plays } = createLocalVideo(120);
    const firstClip = createClip({ start: 10, end: 100 }, { taskId: 'first' });
    const secondClip = createClip({ start: 30, end: 90 }, { taskId: 'second' });

    adapter.configure(createDefaultPreferences(), firstClip);
    const first = adapter.load(firstClip.sourceWebmUrl, firstClip, new AbortController().signal);
    const firstRejection = expect(first).rejects.toThrow();

    // The second load starts before the first clip reported its metadata.
    const second = adapter.load(secondClip.sourceWebmUrl, secondClip, new AbortController().signal);
    await firstRejection;
    await Promise.resolve();

    expect(writes).toEqual([]);
    expect(plays()).toBe(0);
    expect(element.classList.contains('vacnet-video-loading')).toBe(true);

    video.dispatchEvent(new Event('loadedmetadata'));
    await second;

    expect(writes).toEqual([30]);
    expect(video.currentTime).toBe(30);
    expect(plays()).toBe(1);
    expect(element.classList.contains('vacnet-video-loading')).toBe(false);
  });

  it('does not play or re-seek when a newer load interrupts the target-data wait', async () => {
    const { adapter, video, element, writes, plays } = createLocalVideo(120);
    Object.defineProperty(video, 'readyState', { configurable: true, value: HTMLMediaElement.HAVE_METADATA });
    const firstClip = createClip({ start: 10, end: 100 }, { taskId: 'first' });
    const secondClip = createClip({ start: 70, end: 110 }, { taskId: 'second' });

    adapter.configure(createDefaultPreferences(), firstClip);
    const first = adapter.load(firstClip.sourceWebmUrl, firstClip, new AbortController().signal);
    video.dispatchEvent(new Event('loadedmetadata'));
    await Promise.resolve();
    expect(writes).toEqual([10]);

    const firstRejection = expect(first).rejects.toThrow();
    const second = adapter.load(secondClip.sourceWebmUrl, secondClip, new AbortController().signal);
    await firstRejection;

    // The stale load must not continue to the target-data wait or playback.
    video.dispatchEvent(new Event('canplay'));
    await Promise.resolve();
    expect(plays()).toBe(0);
    expect(element.classList.contains('vacnet-video-loading')).toBe(true);

    Object.defineProperty(video, 'readyState', { configurable: true, value: HTMLMediaElement.HAVE_CURRENT_DATA });
    video.dispatchEvent(new Event('loadedmetadata'));
    video.dispatchEvent(new Event('canplay'));
    await second;

    expect(writes.at(-1)).toBe(70);
    expect(video.currentTime).toBe(70);
    expect(plays()).toBe(1);
    expect(element.classList.contains('vacnet-video-loading')).toBe(false);
  });

  it('leaves the site-owned position untouched for a cheating clip', async () => {
    const { adapter, video, writes, plays } = createLocalVideo(120);
    const cheating = createClip({ start: 10, end: 100 }, { reviewType: 'cheating', eventTime: -1 });
    adapter.configure(createDefaultPreferences(), cheating);
    video.currentTime = 6.25;
    writes.length = 0;

    await adapter.load(cheating.sourceWebmUrl, cheating, new AbortController().signal);

    expect(writes).toEqual([]);
    expect(video.currentTime).toBe(6.25);
    expect(plays()).toBe(0);
  });

  it('seeks to the range start and plays for a legacy clip', async () => {
    const { adapter, video, writes, plays } = createLocalVideo(120);
    const legacy = createClip({ start: 12, end: 100 });
    adapter.configure(createDefaultPreferences(), legacy);

    const loading = adapter.load(legacy.sourceWebmUrl, legacy, new AbortController().signal);
    expect(writes).toEqual([]);
    video.dispatchEvent(new Event('loadedmetadata'));
    await loading;

    expect(writes).toEqual([12]);
    expect(video.currentTime).toBe(12);
    expect(plays()).toBe(1);
  });
});

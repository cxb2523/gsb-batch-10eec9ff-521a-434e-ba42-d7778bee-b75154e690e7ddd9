import { afterEach, beforeEach, vi } from 'vitest';

/**
 * jsdom lacks several browser APIs SimplePlayer relies on. Stub them here so
 * the component runs deterministically under fake timers.
 */

export class MockIntersectionObserver {
  static instances: MockIntersectionObserver[] = [];

  readonly callback: IntersectionObserverCallback;
  disconnected = false;

  constructor(callback: IntersectionObserverCallback) {
    this.callback = callback;
    MockIntersectionObserver.instances.push(this);
  }

  observe() {}
  unobserve() {}
  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }
  disconnect() {
    this.disconnected = true;
  }

  trigger() {
    if (this.disconnected) return;
    this.callback(
      [{ isIntersecting: true } as IntersectionObserverEntry],
      this as unknown as IntersectionObserver,
    );
  }
}

(window as unknown as { IntersectionObserver: unknown }).IntersectionObserver = MockIntersectionObserver;

// jsdom does not implement requestAnimationFrame without pretendToBeVisual.
// Route it through setTimeout so vitest fake timers control it.
window.requestAnimationFrame = ((callback: FrameRequestCallback) =>
  window.setTimeout(() => callback(performance.now()), 16)) as typeof window.requestAnimationFrame;
window.cancelAnimationFrame = ((handle: number) => window.clearTimeout(handle)) as typeof window.cancelAnimationFrame;

window.matchMedia = ((query: string) => ({
  matches: false,
  media: query,
  onchange: null,
  addListener() {},
  removeListener() {},
  addEventListener() {},
  removeEventListener() {},
  dispatchEvent: () => false,
})) as typeof window.matchMedia;

/**
 * Emulate the parts of HTMLMediaElement.load() that matter to the player:
 * the browser resets playback position and drops all decoded metadata.
 */
function resetMediaState(video: HTMLMediaElement) {
  try {
    video.currentTime = 0;
  } catch {
    // Ignore read-only currentTime in exotic environments.
  }
  for (const property of ['readyState', 'videoWidth', 'videoHeight', 'duration', 'audioTracks', 'mozHasAudio']) {
    if (Object.prototype.hasOwnProperty.call(video, property)) {
      delete (video as unknown as Record<string, unknown>)[property];
    }
  }
}

beforeEach(() => {
  MockIntersectionObserver.instances = [];
  vi.useFakeTimers();
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(function (this: HTMLMediaElement) {
    resetMediaState(this);
  });
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(() => Promise.resolve());
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
});

afterEach(() => {
  document.body.innerHTML = '';
  vi.restoreAllMocks();
  vi.useRealTimers();
});

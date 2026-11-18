import { describe, expect, it, vi } from 'vitest';
import '../src/simple-player';
import type { SimplePlayer } from '../src/player/simple-player-element';
import { MockIntersectionObserver } from './setup';

const SRC_A = 'https://example.com/video-a.mp4';
const SRC_B = 'https://example.com/video-b.mp4';

function createPlayer(attributes: Record<string, string> = {}): SimplePlayer {
  const element = document.createElement('simple-player');
  for (const [name, value] of Object.entries(attributes)) {
    element.setAttribute(name, value);
  }
  document.body.appendChild(element);
  return element;
}

function getVideo(element: SimplePlayer): HTMLVideoElement {
  return element.shadowRoot!.querySelector('video')!;
}

function getPlayer(element: SimplePlayer): HTMLElement {
  return element.shadowRoot!.querySelector('[data-sp-player]')!;
}

function getProgressTrack(element: SimplePlayer): HTMLElement {
  return element.shadowRoot!.querySelector('[data-sp-progress-track]')!;
}

function getVolumeControl(element: SimplePlayer): HTMLButtonElement {
  return element.shadowRoot!.querySelector('[data-sp-volume-control]')!;
}

function latestObserver(): MockIntersectionObserver {
  const observer = MockIntersectionObserver.instances.at(-1);
  if (!observer) throw new Error('Expected an IntersectionObserver instance');
  return observer;
}

function simulateMetadata(video: HTMLVideoElement, duration = 100) {
  Object.defineProperty(video, 'readyState', { value: 4, configurable: true });
  Object.defineProperty(video, 'videoWidth', { value: 640, configurable: true });
  Object.defineProperty(video, 'videoHeight', { value: 360, configurable: true });
  Object.defineProperty(video, 'duration', { value: duration, configurable: true });
  video.dispatchEvent(new Event('loadedmetadata'));
}

async function simulateFirstFrame(video: HTMLVideoElement) {
  video.dispatchEvent(new Event('loadeddata'));
  await vi.advanceTimersByTimeAsync(20); // first-frame confirmation rAF
  await vi.advanceTimersByTimeAsync(40); // double-rAF presentation
}

async function settleInitialProgress() {
  await vi.advanceTimersByTimeAsync(400); // initial progress settle delay
}

describe('simple-player source switching', () => {
  it('resets to the initial state and lazy-loads the new source on src change', async () => {
    const element = createPlayer({ src: SRC_A, controls: '' });
    const video = getVideo(element);
    const player = getPlayer(element);
    const volumeControl = getVolumeControl(element);

    // Source A lazy-loads only once intersecting.
    expect(video.getAttribute('src')).toBeNull();
    latestObserver().trigger();
    expect(video.getAttribute('src')).toBe(SRC_A);

    // Source A has an audio track.
    Object.defineProperty(video, 'audioTracks', { value: { length: 1 }, configurable: true });
    simulateMetadata(video);
    await simulateFirstFrame(video);
    await settleInitialProgress();

    expect(player.classList.contains('has-loaded-once')).toBe(true);
    expect(player.classList.contains('has-visible-frame')).toBe(true);
    expect(volumeControl.hidden).toBe(false);

    // Put source A somewhere in the middle so stale progress is observable.
    video.currentTime = 50;
    video.dispatchEvent(new Event('timeupdate'));
    expect(player.style.getPropertyValue('--sp-progress-inset')).toBe('50%');

    // Switch to source B.
    element.setAttribute('src', SRC_B);

    // Immediately back to the initial state for the new source.
    expect(player.classList.contains('has-loaded-once')).toBe(false);
    expect(player.classList.contains('has-visible-frame')).toBe(false);
    expect(player.classList.contains('is-progress-settling')).toBe(false);
    expect(player.style.getPropertyValue('--sp-progress-inset')).toBe('100%');
    expect(getProgressTrack(element).getAttribute('aria-valuenow')).toBe('0');
    expect(video.getAttribute('src')).toBeNull();
    expect(video.preload).toBe('none');
    // Audio availability is re-evaluated: the volume control is visible again
    // until the new source's tracks are known.
    expect(volumeControl.hidden).toBe(false);

    // The new source goes through lazy loading again.
    latestObserver().trigger();
    expect(video.getAttribute('src')).toBe(SRC_B);

    // The new source has no audio track (jsdom reports audioTracks.length === 0):
    // the volume control hides itself.
    simulateMetadata(video);
    expect(volumeControl.hidden).toBe(true);

    // The new source completes its own first-frame flow.
    await simulateFirstFrame(video);
    await settleInitialProgress();
    expect(player.classList.contains('has-loaded-once')).toBe(true);
    expect(player.classList.contains('has-visible-frame')).toBe(true);
  });

  it('stops playback and unloads without requesting anything when src is emptied', async () => {
    const element = createPlayer({ src: SRC_A, controls: '' });
    const video = getVideo(element);
    const player = getPlayer(element);

    latestObserver().trigger();
    simulateMetadata(video);
    await simulateFirstFrame(video);
    expect(player.classList.contains('has-loaded-once')).toBe(true);

    const loadSpy = vi.mocked(HTMLMediaElement.prototype.load);
    const pauseSpy = vi.mocked(HTMLMediaElement.prototype.pause);
    const playSpy = vi.mocked(HTMLMediaElement.prototype.play);
    const loadsBefore = loadSpy.mock.calls.length;
    const playsBefore = playSpy.mock.calls.length;
    const observersBefore = MockIntersectionObserver.instances.length;

    element.src = '';

    expect(element.hasAttribute('src')).toBe(false);
    expect(pauseSpy).toHaveBeenCalled();
    expect(video.getAttribute('src')).toBeNull();
    expect(video.dataset.src).toBe('');
    expect(video.preload).toBe('none');
    expect(player.classList.contains('has-loaded-once')).toBe(false);
    expect(player.classList.contains('has-visible-frame')).toBe(false);
    expect(player.style.getPropertyValue('--sp-progress-inset')).toBe('100%');
    // No lazy-loading observer is created for an empty source.
    expect(MockIntersectionObserver.instances.length).toBe(observersBefore);

    // A stale error from the previous source must not schedule a retry either.
    video.dispatchEvent(new Event('error'));
    await vi.advanceTimersByTimeAsync(10_000);

    // Only the resetting load() ran; nothing was requested for the empty source.
    expect(loadSpy.mock.calls.length).toBe(loadsBefore + 1);
    expect(playSpy.mock.calls.length).toBe(playsBefore);
    expect(video.getAttribute('src')).toBeNull();
  });

  it('never lets a pending retry timer from the old source reload the new one', async () => {
    const element = createPlayer({ src: SRC_A });
    const video = getVideo(element);
    const player = getPlayer(element);

    latestObserver().trigger();
    simulateMetadata(video);
    await simulateFirstFrame(video);
    expect(player.classList.contains('has-loaded-once')).toBe(true);
    expect(player.classList.contains('is-loading')).toBe(false);

    // Source A fails after loading: a retry is scheduled.
    video.dispatchEvent(new Event('error'));
    expect(player.classList.contains('is-loading')).toBe(true);
    await vi.advanceTimersByTimeAsync(1_000); // retry pending (2s delay)

    // Switch before the retry fires.
    element.setAttribute('src', SRC_B);
    latestObserver().trigger();
    expect(video.getAttribute('src')).toBe(SRC_B);

    const loadSpy = vi.mocked(HTMLMediaElement.prototype.load);
    const loadsAfterSwitch = loadSpy.mock.calls.length;
    await vi.advanceTimersByTimeAsync(10_000);

    // The old retry timer was cancelled: no extra load of source B.
    expect(loadSpy.mock.calls.length).toBe(loadsAfterSwitch);
    expect(video.getAttribute('src')).toBe(SRC_B);
  });

  it('ignores a stale error event arriving after the switch', async () => {
    const element = createPlayer({ src: SRC_A });
    const video = getVideo(element);

    latestObserver().trigger();
    expect(video.getAttribute('src')).toBe(SRC_A);

    element.setAttribute('src', SRC_B);

    // The old source's error event arrives late, after the switch. It must not
    // schedule a retry that reloads (or marks) the new source.
    video.dispatchEvent(new Event('error'));

    const loadSpy = vi.mocked(HTMLMediaElement.prototype.load);
    const loadsAfterSwitch = loadSpy.mock.calls.length;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(loadSpy.mock.calls.length).toBe(loadsAfterSwitch);
    // No retry re-hydrated source B behind the lazy loader's back.
    expect(video.getAttribute('src')).toBeNull();
  });

  it('ignores stale first-frame confirmation and progress settle callbacks', async () => {
    const element = createPlayer({ src: SRC_A, controls: '' });
    const video = getVideo(element);
    const player = getPlayer(element);

    latestObserver().trigger();
    simulateMetadata(video);
    // Start (but do not finish) the first-frame confirmation for source A.
    video.dispatchEvent(new Event('loadeddata'));

    // Switch while the old first-frame callback is still pending.
    element.setAttribute('src', SRC_B);
    await vi.advanceTimersByTimeAsync(1_000);

    // The stale callback must not mark the new source as ready...
    expect(player.classList.contains('has-loaded-once')).toBe(false);
    expect(player.classList.contains('has-visible-frame')).toBe(false);
    expect(player.classList.contains('is-progress-settling')).toBe(false);
    // ...nor write the old progress back.
    expect(player.style.getPropertyValue('--sp-progress-inset')).toBe('100%');
    expect(getProgressTrack(element).getAttribute('aria-valuenow')).toBe('0');

    // The new source still runs its own lazy-load and first-frame flow.
    latestObserver().trigger();
    expect(video.getAttribute('src')).toBe(SRC_B);
    simulateMetadata(video);
    await simulateFirstFrame(video);
    expect(player.classList.contains('has-loaded-once')).toBe(true);
    expect(player.classList.contains('has-visible-frame')).toBe(true);
  });

  it('cancels a pending initial-progress settle from the old source', async () => {
    const element = createPlayer({ src: SRC_A });
    const video = getVideo(element);
    const player = getPlayer(element);

    latestObserver().trigger();
    simulateMetadata(video);
    await simulateFirstFrame(video);
    // First frame committed: the 380ms settle timer is now pending.
    expect(player.classList.contains('is-progress-settling')).toBe(true);

    element.setAttribute('src', SRC_B);
    expect(player.classList.contains('is-progress-settling')).toBe(false);

    await vi.advanceTimersByTimeAsync(1_000);
    // The stale settle callback must not run: progress stays at zero.
    expect(player.classList.contains('is-progress-settling')).toBe(false);
    expect(player.style.getPropertyValue('--sp-progress-inset')).toBe('100%');
    expect(getProgressTrack(element).getAttribute('aria-valuenow')).toBe('0');
  });
});

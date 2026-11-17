import type { ClipRange } from '../../../entities/clip.entity';

const SHORT_CLIP_THRESHOLD_SECONDS = 60;
const OPEN_ENDED_RANGE = 999_999;

export interface ReviewBounds {
  start: number;
  end: number;
}

export const isReviewRangeValid = (range: ClipRange): boolean =>
  Number.isFinite(range.start) && Number.isFinite(range.end) && range.end > range.start;

/**
 * Canonical review interval. A short clip is treated as open-ended because the
 * portal reports an end that trailers well past the actual event. An invalid
 * interval (`end <= start`) is represented as `{ start: 0, end: 0 }` so that
 * callers can fall back to the whole video.
 */
export const normalizeReviewRange = ({ start, end }: ClipRange): ClipRange => {
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return { start: 0, end: 0 };
  const normalizedStart = start < 1 ? 0 : start;
  return {
    start: normalizedStart,
    end: end - start <= SHORT_CLIP_THRESHOLD_SECONDS ? OPEN_ENDED_RANGE : end,
  };
};

/**
 * Load-time seek target. Unlike {@link resolveReviewBounds} this must not
 * depend on `duration`, which is still the previous clip's value while the new
 * metadata is pending.
 */
export const resolveReviewStart = (range: ClipRange): number =>
  isReviewRangeValid(range) ? range.start : 0;

/**
 * Effective seek bounds for the current media element. The open-ended marker
 * and the whole-video fallback are both resolved against the real duration.
 * When duration is not known yet, the bound stays unbounded instead of
 * collapsing to 0 (which used to send stepping to the beginning of the video).
 */
export const resolveReviewBounds = (range: ClipRange, duration: number): ReviewBounds => {
  const limit = Number.isFinite(duration) && duration > 0 ? duration : Number.POSITIVE_INFINITY;
  if (!isReviewRangeValid(range) || range.start >= limit) return { start: 0, end: limit };
  return {
    start: range.start,
    end: range.end === OPEN_ENDED_RANGE ? limit : Math.min(range.end, limit),
  };
};

export const clampReviewTime = (time: number, bounds: ReviewBounds): number => {
  if (Number.isNaN(time)) return bounds.start;
  return Math.min(bounds.end, Math.max(bounds.start, time));
};

export const calculateStepTargetTime = (
  baseTime: number,
  direction: number,
  frameDuration: number,
  range: ClipRange,
  duration: number,
): number => {
  const bounds = resolveReviewBounds(range, duration);
  // A stale or out-of-range position (e.g. an older clip's frame) first
  // collapses onto the nearest edge of the current interval, then advances.
  const base = clampReviewTime(baseTime, bounds);
  return clampReviewTime(base + direction * frameDuration, bounds);
};

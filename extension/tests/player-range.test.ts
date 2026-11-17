import { describe, expect, it } from 'vitest';
import {
  calculateStepTargetTime,
  clampReviewTime,
  isReviewRangeValid,
  normalizeReviewRange,
  resolveReviewBounds,
  resolveReviewStart,
} from '../src/features/video-player/player/player-range.utils';
import { calculateEventTargetTime } from '../src/features/video-player/player/player-commands.utils';

const OPEN_ENDED = 999_999;

describe('normalizeReviewRange', () => {
  it('keeps the real end of a long clip and normalizes a tiny start', () => {
    expect(normalizeReviewRange({ start: 0.4, end: 120 })).toEqual({ start: 0, end: 120 });
    expect(normalizeReviewRange({ start: 12, end: 132 })).toEqual({ start: 12, end: 132 });
  });

  it('treats a short clip as open-ended', () => {
    expect(normalizeReviewRange({ start: 10, end: 40 })).toEqual({ start: 10, end: OPEN_ENDED });
    expect(normalizeReviewRange({ start: 0, end: 60 })).toEqual({ start: 0, end: OPEN_ENDED });
  });

  it('collapses an invalid interval so callers fall back to the whole video', () => {
    expect(normalizeReviewRange({ start: 20, end: 20 })).toEqual({ start: 0, end: 0 });
    expect(normalizeReviewRange({ start: 20, end: 10 })).toEqual({ start: 0, end: 0 });
    expect(isReviewRangeValid({ start: 20, end: 20 })).toBe(false);
    expect(isReviewRangeValid({ start: 20, end: 21 })).toBe(true);
  });
});

describe('resolveReviewBounds', () => {
  it('resolves an open-ended range against the real duration', () => {
    expect(resolveReviewBounds(normalizeReviewRange({ start: 10, end: 40 }), 90)).toEqual({ start: 10, end: 90 });
    expect(resolveReviewBounds({ start: 10, end: OPEN_ENDED }, 45)).toEqual({ start: 10, end: 45 });
  });

  it('falls back to the whole video for an invalid interval', () => {
    expect(resolveReviewBounds(normalizeReviewRange({ start: 20, end: 10 }), 90)).toEqual({ start: 0, end: 90 });
    expect(resolveReviewBounds({ start: 0, end: 0 }, 90)).toEqual({ start: 0, end: 90 });
  });

  it('treats an unknown duration as an open upper bound instead of collapsing to zero', () => {
    const bounds = resolveReviewBounds({ start: 10, end: 100 }, Number.NaN);
    expect(bounds).toEqual({ start: 10, end: 100 });
    expect(resolveReviewBounds({ start: 10, end: OPEN_ENDED }, Number.NaN)).toEqual({ start: 10, end: Number.POSITIVE_INFINITY });
  });

  it('falls back to the whole video when the start lies beyond the media duration', () => {
    expect(resolveReviewBounds({ start: 100, end: 200 }, 90)).toEqual({ start: 0, end: 90 });
  });
});

describe('clampReviewTime and stepping', () => {
  const frame = 1 / 60;

  it('clamps a step to the review interval', () => {
    const range = { start: 10, end: 100 };
    expect(calculateStepTargetTime(10, -1, frame, range, 120)).toBe(10);
    expect(calculateStepTargetTime(100, 1, frame, range, 120)).toBe(100);
    expect(calculateStepTargetTime(50, 1, frame, range, 120)).toBeCloseTo(50 + frame, 10);
  });

  it('uses the whole video when the review interval is invalid', () => {
    const range = normalizeReviewRange({ start: 20, end: 10 });
    expect(calculateStepTargetTime(0, -1, frame, range, 90)).toBe(0);
    expect(calculateStepTargetTime(90, 1, frame, range, 90)).toBe(90);
    expect(calculateStepTargetTime(2, 1, frame, range, 90)).toBeCloseTo(2 + frame, 10);
  });

  it('pulls a stale position from a previous clip into the current interval first', () => {
    // A leftover frame from an older clip must not make the first step leave the range.
    expect(calculateStepTargetTime(80, -1, frame, { start: 10, end: 100 }, 120)).toBeCloseTo(80 - frame, 10);
    expect(calculateStepTargetTime(5, 1, frame, { start: 10, end: 100 }, 120)).toBeCloseTo(10 + frame, 10);
    expect(calculateStepTargetTime(500, -1, frame, { start: 10, end: 100 }, 120)).toBeCloseTo(100 - frame, 10);
    expect(calculateStepTargetTime(500, 1, frame, { start: 10, end: 100 }, 120)).toBe(100);
  });

  it('never returns a non-finite time', () => {
    expect(clampReviewTime(Number.NaN, { start: 10, end: 100 })).toBe(10);
    expect(clampReviewTime(Infinity, { start: 10, end: 100 })).toBe(100);
  });
});

describe('calculateEventTargetTime', () => {
  it('leads the event by two seconds inside the interval', () => {
    expect(calculateEventTargetTime(50, { start: 10, end: 100 })).toBe(48);
  });

  it('clamps an event that lies outside the interval', () => {
    expect(calculateEventTargetTime(150, { start: 10, end: 100 })).toBe(100);
    expect(calculateEventTargetTime(5, { start: 10, end: 100 })).toBe(10);
  });

  it('falls back to the whole video for an invalid interval', () => {
    expect(calculateEventTargetTime(150, resolveReviewBounds(normalizeReviewRange({ start: 20, end: 10 }), 90))).toBe(90);
  });
});

describe('resolveReviewStart', () => {
  it('does not depend on the stale duration of the previous source', () => {
    expect(resolveReviewStart(normalizeReviewRange({ start: 30, end: 200 }))).toBe(30);
    expect(resolveReviewStart(normalizeReviewRange({ start: 20, end: 10 }))).toBe(0);
    expect(resolveReviewStart(normalizeReviewRange({ start: 0.2, end: 200 }))).toBe(0);
  });
});

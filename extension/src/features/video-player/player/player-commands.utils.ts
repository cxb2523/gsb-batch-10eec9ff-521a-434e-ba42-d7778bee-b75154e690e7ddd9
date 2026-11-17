import type { ReviewBounds } from './player-range.utils';

export const PLAYBACK_RATES = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4] as const;

const EVENT_LEAD_SECONDS = 2;

export const calculateEventTargetTime = (eventTime: number, bounds: ReviewBounds): number => {
  const target = eventTime - EVENT_LEAD_SECONDS;
  if (!Number.isFinite(target)) return bounds.start;
  return Math.min(bounds.end, Math.max(bounds.start, target));
};

export const calculatePlaybackRate = (currentRate: number, direction: -1 | 1): number => {
  if (direction === 1) return PLAYBACK_RATES.find((rate) => rate > currentRate) ?? 4;
  return [...PLAYBACK_RATES].reverse().find((rate) => rate < currentRate) ?? 0.25;
};

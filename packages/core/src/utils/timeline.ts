import type { Chapter } from '../types/chapter'
import type { ThumbnailCue } from '../types/thumbnail'

/**
 * Find the thumbnail cue whose `[start, end)` range contains `time`.
 *
 * Cues must be sorted by `start` (the VTT parser guarantees this). Returns
 * `null` when `time` falls before the first cue or after the last cue — the
 * timeline then simply omits the preview image while keeping the time and
 * chapter label visible.
 */
export function findThumbnailCue(
  cues: readonly ThumbnailCue[] | null | undefined,
  time: number,
): ThumbnailCue | null {
  if (!cues?.length || !Number.isFinite(time)) {
    return null
  }

  // Binary search for the last cue that starts at or before `time`.
  let low = 0
  let high = cues.length - 1
  let candidate = -1

  while (low <= high) {
    const mid = (low + high) >> 1
    if (cues[mid].start <= time) {
      candidate = mid
      low = mid + 1
    } else {
      high = mid - 1
    }
  }

  if (candidate === -1) {
    return null
  }

  const cue = cues[candidate]
  return time < cue.end ? cue : null
}

/**
 * Find the chapter that is active at `time` — the last chapter whose start
 * time is at or before `time`. Returns `null` before the first chapter.
 */
export function findChapterAt(
  chapters: readonly Chapter[] | null | undefined,
  time: number,
): Chapter | null {
  if (!chapters?.length || !Number.isFinite(time)) {
    return null
  }

  let active: Chapter | null = null
  for (const chapter of chapters) {
    if (chapter.time <= time && (!active || chapter.time >= active.time)) {
      active = chapter
    }
  }
  return active
}

export interface TimelinePreview {
  /** Media time (seconds) the tooltip describes. */
  time: number
  /** Chapter active at `time`, or `null` before the first chapter. */
  chapter: Chapter | null
  /** Thumbnail cue covering `time`, or `null` when outside the manifest's range. */
  cue: ThumbnailCue | null
}

/**
 * Resolve everything the timeline tooltip shows from one media-time value, so
 * the preview frame and the chapter label can never disagree.
 *
 * `time` is a position in the video's own timeline (not a ratio), which is the
 * same basis the VTT cues use.
 */
export function resolveTimelinePreview(
  chapters: readonly Chapter[] | null | undefined,
  cues: readonly ThumbnailCue[] | null | undefined,
  time: number,
): TimelinePreview {
  const safeTime = Number.isFinite(time) ? Math.max(0, time) : 0
  return {
    time: safeTime,
    chapter: findChapterAt(chapters, safeTime),
    cue: findThumbnailCue(cues, safeTime),
  }
}

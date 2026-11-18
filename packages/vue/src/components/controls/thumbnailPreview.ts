import type { ThumbnailCue } from '@vue-player/core'

/** Width of the timeline thumbnail preview box, in CSS pixels. */
export const PREVIEW_WIDTH = 160
/** Height of the timeline thumbnail preview box, in CSS pixels. */
export const PREVIEW_HEIGHT = 90

/**
 * Convert a 0–1 position along the timeline track into a media time, using the
 * video's real duration as the only basis. Returns 0 while the duration is
 * unknown so hovering before metadata loads never produces NaN/Infinity.
 */
export function timeFromRatio(ratio: number | null, duration: number): number {
  if (ratio === null || !Number.isFinite(ratio) || !Number.isFinite(duration) || duration <= 0) {
    return 0
  }
  return Math.min(Math.max(ratio, 0), 1) * duration
}

/**
 * Build the inline style for a sprite-sheet tile described by an `xywh`
 * fragment: the sheet is offset by `-x/-y` so the requested tile sits at the
 * preview's top-left corner, and the tile's own `w`/`h` size the element.
 *
 * Tiles larger or smaller than the 160×90 preview are scaled down/up uniformly
 * so the preview box always shows exactly one frame without cropping it.
 * Returns `null` for cues without sprite metadata (plain image thumbnails).
 */
export function spriteStyleForCue(
  cue: ThumbnailCue | null | undefined,
): Record<string, string> | null {
  if (!cue || cue.x === undefined || !cue.w || !cue.h) {
    return null
  }

  const style: Record<string, string> = {
    backgroundImage: `url("${cue.url}")`,
    backgroundPosition: `-${cue.x}px -${cue.y ?? 0}px`,
    width: `${cue.w}px`,
    height: `${cue.h}px`,
  }

  if (cue.w !== PREVIEW_WIDTH || cue.h !== PREVIEW_HEIGHT) {
    const scale = Math.min(PREVIEW_WIDTH / cue.w, PREVIEW_HEIGHT / cue.h)
    if (scale !== 1) {
      style.transform = `scale(${scale})`
    }
  }

  return style
}

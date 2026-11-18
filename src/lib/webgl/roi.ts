/**
 * ROI (Region of Interest) geometry helpers
 *
 * Coordinate contract (see WEBGL-004):
 * - ROI normalized coordinates use the TOP-LEFT corner of the displayed frame
 *   as the origin, matching screen/CSS/2D-canvas orientation (y grows downward).
 * - `width` and `height` are always positive.
 * - During mouse drag, raw points are recorded in screen orientation and
 *   normalized here so the resulting rectangle is independent of drag direction.
 *
 * Keeping this logic pure (no DOM access) makes the coordinate direction and
 * sampling rules unit-testable without a browser.
 */

import type { ROIRect } from '../../types'

/** Minimum ROI edge length as a fraction of the frame (1%). */
export const MIN_ROI_DIMENSION = 0.01

/**
 * Normalize two arbitrary normalized corner points into a canonical ROI rect
 * whose origin is the top-left corner and whose width/height are positive.
 * Works regardless of the direction the user dragged.
 */
export function normalizeROI(
  x1: number,
  y1: number,
  x2: number,
  y2: number
): ROIRect {
  const x = Math.min(x1, x2)
  const y = Math.min(y1, y2)
  return {
    x,
    y,
    width: Math.abs(x2 - x1),
    height: Math.abs(y2 - y1)
  }
}

/**
 * A ROI only takes effect when it is present and covers at least 1% of the
 * frame in BOTH dimensions. Tiny/click-sized selections must not alter metrics.
 * Coordinates are expected in screen orientation (top-left origin).
 */
export function isValidROI(roi: ROIRect | null | undefined): roi is ROIRect {
  if (!roi) return false
  if (!Number.isFinite(roi.x) || !Number.isFinite(roi.y) ||
      !Number.isFinite(roi.width) || !Number.isFinite(roi.height)) {
    return false
  }
  return roi.width >= MIN_ROI_DIMENSION && roi.height >= MIN_ROI_DIMENSION
}

/**
 * Clamp a ROI so it stays inside the unit frame [0,1]. Negative width/height
 * (e.g. produced by a bottom-up coordinate convention) are normalized away by
 * recomputing the top-left origin. The returned rect always has positive size.
 */
export function clampROI(roi: ROIRect): ROIRect {
  // Tolerate inverted rectangles by re-deriving the corners.
  const x0 = Math.min(roi.x, roi.x + roi.width)
  const y0 = Math.min(roi.y, roi.y + roi.height)
  const x1 = Math.max(roi.x, roi.x + roi.width)
  const y1 = Math.max(roi.y, roi.y + roi.height)

  const cx0 = Math.min(1, Math.max(0, x0))
  const cy0 = Math.min(1, Math.max(0, y0))
  const cx1 = Math.min(1, Math.max(0, x1))
  const cy1 = Math.min(1, Math.max(0, y1))

  return {
    x: cx0,
    y: cy0,
    width: Math.max(0, cx1 - cx0),
    height: Math.max(0, cy1 - cy0)
  }
}

/** Inclusive-exclusive integer pixel bounds covered by a ROI. */
export interface PixelBounds {
  startX: number
  startY: number
  endX: number
  endY: number
}

/**
 * Convert a normalized ROI (top-left origin) to integer pixel bounds inside an
 * image of the given size. Bounds are clamped to the image dimensions.
 * Returns null when the ROI is invalid/too small, meaning "use full frame".
 */
export function getROIPixelBounds(
  roi: ROIRect | null | undefined,
  width: number,
  height: number
): PixelBounds | null {
  if (!isValidROI(roi)) return null

  const clamped = clampROI(roi)
  const startX = Math.max(0, Math.floor(clamped.x * width))
  const startY = Math.max(0, Math.floor(clamped.y * height))
  const endX = Math.min(width, Math.ceil((clamped.x + clamped.width) * width))
  const endY = Math.min(height, Math.ceil((clamped.y + clamped.height) * height))

  if (endX <= startX || endY <= startY) return null
  return { startX, startY, endX, endY }
}

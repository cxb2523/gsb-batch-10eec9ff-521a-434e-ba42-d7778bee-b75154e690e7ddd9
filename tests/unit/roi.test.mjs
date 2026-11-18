/**
 * Unit tests for ROI geometry / coordinate-direction rules (WEBGL-004).
 *
 * Runs with the built-in Node test runner + native TypeScript type stripping
 * (no external dependencies): `node --test tests/unit`.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  MIN_ROI_DIMENSION,
  normalizeROI,
  isValidROI,
  clampROI,
  getROIPixelBounds
} from '../../src/lib/webgl/roi.ts'

const EPS = 1e-12

function approxEqual(actual, expected) {
  for (const key of Object.keys(expected)) {
    assert.ok(
      Math.abs(actual[key] - expected[key]) <= EPS,
      `${key}: ${actual[key]} !~= ${expected[key]}`
    )
  }
}

test('normalizeROI returns a top-left-origin rect with positive size for any drag direction', () => {
  // Drag from top-left to bottom-right
  approxEqual(normalizeROI(0.2, 0.3, 0.7, 0.8), { x: 0.2, y: 0.3, width: 0.5, height: 0.5 })
  // Drag from bottom-right to top-left (up-left gesture)
  approxEqual(normalizeROI(0.7, 0.8, 0.2, 0.3), { x: 0.2, y: 0.3, width: 0.5, height: 0.5 })
  // Drag right-to-left on x, bottom-to-top on y
  approxEqual(normalizeROI(0.9, 0.9, 0.1, 0.2), { x: 0.1, y: 0.2, width: 0.8, height: 0.7 })
  // Pure click (no movement) yields a zero-size rect at the click point.
  approxEqual(normalizeROI(0.5, 0.5, 0.5, 0.5), { x: 0.5, y: 0.5, width: 0, height: 0 })
})

test('isValidROI rejects null/undefined and rectangles below 1% in either dimension', () => {
  assert.equal(isValidROI(null), false)
  assert.equal(isValidROI(undefined), false)
  assert.equal(isValidROI({ x: 0, y: 0, width: 0.009, height: 0.5 }), false)
  assert.equal(isValidROI({ x: 0, y: 0, width: 0.5, height: 0.009 }), false)
  assert.equal(isValidROI({ x: 0, y: 0, width: 0, height: 0 }), false)
  assert.equal(isValidROI({ x: 0, y: 0, width: NaN, height: 0.5 }), false)
  assert.equal(isValidROI({ x: 0, y: 0, width: Infinity, height: 0.5 }), false)

  // Exactly 1% is the boundary and is accepted.
  assert.equal(isValidROI({ x: 0, y: 0, width: MIN_ROI_DIMENSION, height: MIN_ROI_DIMENSION }), true)
  assert.equal(isValidROI({ x: 0.2, y: 0.3, width: 0.4, height: 0.5 }), true)
})

test('clampROI keeps the rect inside [0,1] and preserves top-left origin', () => {
  approxEqual(
    clampROI({ x: -0.2, y: -0.1, width: 0.8, height: 0.7 }),
    { x: 0, y: 0, width: 0.6, height: 0.6 }
  )
  approxEqual(
    clampROI({ x: 0.8, y: 0.8, width: 0.5, height: 0.5 }),
    { x: 0.8, y: 0.8, width: 0.2, height: 0.2 }
  )
  // An inverted (negative-size / bottom-up) rect is canonicalized to positive size.
  approxEqual(
    clampROI({ x: 0.7, y: 0.7, width: -0.5, height: -0.4 }),
    { x: 0.2, y: 0.3, width: 0.5, height: 0.4 }
  )
})

test('getROIPixelBounds maps top-left-origin normalized coords to screen-oriented pixel rows', () => {
  // Top 10% strip of a 100x100 image -> rows 0..9 (top rows, NOT bottom rows).
  assert.deepEqual(getROIPixelBounds({ x: 0, y: 0, width: 1, height: 0.1 }, 100, 100), {
    startX: 0,
    startY: 0,
    endX: 100,
    endY: 10
  })

  // Bottom 10% strip -> rows 90..99. This proves y is downward/screen oriented.
  assert.deepEqual(getROIPixelBounds({ x: 0, y: 0.9, width: 1, height: 0.1 }, 100, 100), {
    startX: 0,
    startY: 90,
    endX: 100,
    endY: 100
  })

  // Non-aligned edges: floor on the start, ceil on the end to fully cover ROI.
  assert.deepEqual(getROIPixelBounds({ x: 0.123, y: 0.246, width: 0.333, height: 0.5 }, 100, 100), {
    startX: 12,
    startY: 24,
    endX: 46, // ceil(0.456 * 100)
    endY: 75 // ceil(0.746 * 100)
  })

  // Bounds never exceed image dimensions.
  const clipped = getROIPixelBounds({ x: 0.95, y: 0.95, width: 0.5, height: 0.5 }, 100, 100)
  assert.ok(clipped && clipped.endX <= 100 && clipped.endY <= 100)
})

test('getROIPixelBounds returns null for missing or sub-1% ROI (full-frame fallback signal)', () => {
  assert.equal(getROIPixelBounds(null, 100, 100), null)
  assert.equal(getROIPixelBounds({ x: 0, y: 0, width: 0.005, height: 0.5 }, 100, 100), null)
  assert.equal(getROIPixelBounds({ x: 0, y: 0, width: 0.5, height: 0.005 }, 100, 100), null)
})

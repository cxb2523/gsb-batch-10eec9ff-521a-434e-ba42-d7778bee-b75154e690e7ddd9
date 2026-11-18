/**
 * Unit tests for ROI-constrained WebGL metrics (WEBGL-001/WEBGL-004).
 *
 * These tests run entirely in Node (built-in test runner, native TypeScript
 * type stripping) and use plain ImageData-like buffers so no browser is needed.
 *
 * Coverage:
 * - metrics only sample pixels inside the ROI and fall back to the full frame
 * - SSIM, Delta E, diff %, peak/mean difference and pass/fail counts all use
 *   the SAME sample set
 * - screen-oriented ROI coordinates (top-left origin, y downward) align with
 *   the pixels actually sampled
 * - sub-1% ROI is ignored and clearing the ROI restores full-frame stats
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { computeMetricsFromImageData } from '../../src/lib/webgl/metricsComputation.ts'

function makeImageData(width, height, fill) {
  const data = new Uint8ClampedArray(width * height * 4)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4
      const c = typeof fill === 'function' ? fill(x, y) : fill
      data[i] = c.r
      data[i + 1] = c.g
      data[i + 2] = c.b
      data[i + 3] = 255
    }
  }
  // Structurally matches ImageData (the compute layer only reads these fields).
  return { width, height, data }
}

const BLACK = { r: 0, g: 0, b: 0 }
const WHITE = { r: 255, g: 255, b: 255 }
const W = 100
const H = 100
// Full-frame sample count at the internal stride of 4: 25 x 25 = 625.
const FULL_SAMPLE_COUNT = 625

// A black frame; B is black except a white 20x20 square at [20,40) x [20,40).
function differingSquareFrames() {
  const a = makeImageData(W, H, BLACK)
  const b = makeImageData(W, H, (x, y) =>
    x >= 20 && x < 40 && y >= 20 && y < 40 ? WHITE : BLACK
  )
  return { a, b }
}

test('identical images produce perfect similarity and zero differences over the full frame', () => {
  const a = makeImageData(W, H, { r: 37, g: 128, b: 200 })
  const b = makeImageData(W, H, { r: 37, g: 128, b: 200 })

  const m = computeMetricsFromImageData(a, b, 10, null)

  assert.equal(m.ssim, 1)
  assert.equal(m.deltaE, 0)
  assert.equal(m.diffPixelPercent, 0)
  assert.equal(m.peakDifference, 0)
  assert.equal(m.meanDifference, 0)
  assert.equal(m.failPixelCount, 0)
  assert.equal(m.passPixelCount, FULL_SAMPLE_COUNT)
  assert.equal(m.totalPixelCount, FULL_SAMPLE_COUNT)
})

test('ROI restricts every metric to the sampled region', () => {
  const { a, b } = differingSquareFrames()

  // ROI exactly covers the white square in B: normalized [0.2,0.4] x [0.2,0.4].
  const roi = { x: 0.2, y: 0.2, width: 0.2, height: 0.2 }
  const roiMetrics = computeMetricsFromImageData(a, b, 10, roi)
  const fullMetrics = computeMetricsFromImageData(a, b, 10, null)

  // The ROI region is 20x20 px sampled at stride 4 -> 5x5 = 25 samples.
  assert.equal(roiMetrics.totalPixelCount, 25)
  assert.equal(fullMetrics.totalPixelCount, FULL_SAMPLE_COUNT)

  // Inside the ROI every sampled pixel is black-vs-white.
  assert.equal(roiMetrics.failPixelCount, 25)
  assert.equal(roiMetrics.passPixelCount, 0)
  assert.equal(roiMetrics.diffPixelPercent, 100)
  assert.equal(roiMetrics.peakDifference, 255)
  assert.equal(roiMetrics.meanDifference, 255)
  assert.ok(roiMetrics.deltaE > 5)
  assert.ok(roiMetrics.ssim < 0.5)

  // The same 25 differing pixels are diluted across the full frame, proving
  // the ROI genuinely changes the sampling set rather than just rescaling.
  assert.equal(fullMetrics.failPixelCount, 25)
  assert.equal(fullMetrics.diffPixelPercent, (25 / FULL_SAMPLE_COUNT) * 100)
  assert.ok(fullMetrics.diffPixelPercent < roiMetrics.diffPixelPercent)
})

test('all metrics share one sample set: pass + fail always equals total', () => {
  const { a, b } = differingSquareFrames()
  const rois = [
    null,
    { x: 0.2, y: 0.2, width: 0.2, height: 0.2 },
    { x: 0.5, y: 0.5, width: 0.4, height: 0.4 },
    { x: 0, y: 0, width: 0.5, height: 0.5 }
  ]

  for (const roi of rois) {
    const m = computeMetricsFromImageData(a, b, 10, roi)
    assert.equal(
      m.passPixelCount + m.failPixelCount,
      m.totalPixelCount,
      `pass+fail mismatch for ROI ${JSON.stringify(roi)}`
    )
  }
})

test('ROI over an unchanged region reports a perfect match', () => {
  const { a, b } = differingSquareFrames()
  // Bottom-right quadrant is black in both A and B.
  const m = computeMetricsFromImageData(a, b, 10, { x: 0.5, y: 0.5, width: 0.2, height: 0.2 })

  assert.equal(m.ssim, 1)
  assert.equal(m.diffPixelPercent, 0)
  assert.equal(m.peakDifference, 0)
  assert.equal(m.failPixelCount, 0)
  assert.ok(m.totalPixelCount > 0)
})

test('ROI y axis is screen-oriented: a top strip differs while the matching bottom strip does not', () => {
  // B is white in the TOP half, black in the bottom half; A is fully black.
  const a = makeImageData(W, H, BLACK)
  const b = makeImageData(W, H, (_x, y) => (y < 50 ? WHITE : BLACK))

  // Top 10% strip -> must hit the white half.
  const top = computeMetricsFromImageData(a, b, 10, { x: 0, y: 0, width: 1, height: 0.1 })
  // Bottom 10% strip -> must hit the black half.
  const bottom = computeMetricsFromImageData(a, b, 10, { x: 0, y: 0.9, width: 1, height: 0.1 })

  assert.equal(top.diffPixelPercent, 100)
  assert.equal(top.peakDifference, 255)
  assert.equal(bottom.diffPixelPercent, 0)
  assert.equal(bottom.peakDifference, 0)

  // Both strips cover the same number of sampled pixels; only the location differs.
  assert.equal(top.totalPixelCount, bottom.totalPixelCount)
})

test('a difference in the BOTTOM of the frame is only captured by a bottom-origin ROI', () => {
  // Mirrored version of the previous test: white band at the bottom of B.
  const a = makeImageData(W, H, BLACK)
  const b = makeImageData(W, H, (_x, y) => (y >= 90 ? WHITE : BLACK))

  const top = computeMetricsFromImageData(a, b, 10, { x: 0, y: 0, width: 1, height: 0.1 })
  const bottom = computeMetricsFromImageData(a, b, 10, { x: 0, y: 0.9, width: 1, height: 0.1 })

  assert.equal(top.diffPixelPercent, 0)
  assert.equal(bottom.diffPixelPercent, 100)
})

test('sub-1% ROI does not take effect: metrics stay equal to full-frame', () => {
  const { a, b } = differingSquareFrames()
  const full = computeMetricsFromImageData(a, b, 10, null)

  const tooThin = computeMetricsFromImageData(a, b, 10, { x: 0.2, y: 0.2, width: 0.005, height: 0.2 })
  const tooShort = computeMetricsFromImageData(a, b, 10, { x: 0.2, y: 0.2, width: 0.2, height: 0.005 })

  for (const m of [tooThin, tooShort]) {
    assert.equal(m.totalPixelCount, full.totalPixelCount)
    assert.equal(m.failPixelCount, full.failPixelCount)
    assert.equal(m.diffPixelPercent, full.diffPixelPercent)
    assert.equal(m.ssim, full.ssim)
    assert.equal(m.peakDifference, full.peakDifference)
    assert.equal(m.meanDifference, full.meanDifference)
  }
})

test('clearing the ROI (null) restores full-frame statistics immediately', () => {
  const { a, b } = differingSquareFrames()
  const roi = { x: 0.2, y: 0.2, width: 0.2, height: 0.2 }

  const localized = computeMetricsFromImageData(a, b, 10, roi)
  const cleared = computeMetricsFromImageData(a, b, 10, null)
  const neverSet = computeMetricsFromImageData(a, b, 10)

  assert.notEqual(localized.totalPixelCount, cleared.totalPixelCount)
  assert.equal(cleared.totalPixelCount, FULL_SAMPLE_COUNT)
  assert.deepEqual(cleared, neverSet)
})

test('a valid ~1% ROI still yields samples instead of an empty zeroed result', () => {
  const a = makeImageData(W, H, BLACK)
  const b = makeImageData(W, H, WHITE)
  // 1.2% in each dimension passes the 1% gate but is narrower than the stride.
  const m = computeMetricsFromImageData(a, b, 10, { x: 0, y: 0, width: 0.012, height: 0.012 })

  assert.ok(m.totalPixelCount > 0)
  assert.equal(m.failPixelCount, m.totalPixelCount)
  assert.equal(m.diffPixelPercent, 100)
})

test('threshold gates pass/fail counts on the ROI sample set', () => {
  const a = makeImageData(W, H, BLACK)
  const b = makeImageData(W, H, { r: 20, g: 20, b: 20 })
  const roi = { x: 0.25, y: 0.25, width: 0.5, height: 0.5 }

  const strict = computeMetricsFromImageData(a, b, 30, roi) // 20 <= 30 -> all pass
  const loose = computeMetricsFromImageData(a, b, 10, roi)  // 20 > 10  -> all fail

  assert.equal(strict.failPixelCount, 0)
  assert.equal(strict.passPixelCount, strict.totalPixelCount)
  assert.equal(loose.failPixelCount, loose.totalPixelCount)
  assert.equal(loose.passPixelCount, 0)
})

test('swapping A and B keeps symmetric metrics on the same ROI (flip A/B parity)', () => {
  const { a, b } = differingSquareFrames()
  const roi = { x: 0.1, y: 0.1, width: 0.5, height: 0.5 }

  const ab = computeMetricsFromImageData(a, b, 10, roi)
  const ba = computeMetricsFromImageData(b, a, 10, roi)

  // Same region is sampled on both sides...
  assert.equal(ab.totalPixelCount, ba.totalPixelCount)
  // ...and every symmetric statistic is invariant under the A/B swap, so the
  // ROI keeps describing the same area after an A/B flip.
  assert.equal(ab.ssim, ba.ssim)
  assert.equal(ab.deltaE, ba.deltaE)
  assert.equal(ab.diffPixelPercent, ba.diffPixelPercent)
  assert.equal(ab.peakDifference, ba.peakDifference)
  assert.equal(ab.meanDifference, ba.meanDifference)
  assert.equal(ab.passPixelCount, ba.passPixelCount)
  assert.equal(ab.failPixelCount, ba.failPixelCount)
})

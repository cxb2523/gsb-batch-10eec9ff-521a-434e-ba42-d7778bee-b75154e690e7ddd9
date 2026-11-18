import { describe, expect, it } from 'vitest'
import {
  PREVIEW_HEIGHT,
  PREVIEW_WIDTH,
  spriteStyleForCue,
  timeFromRatio,
} from '../src/components/controls/thumbnailPreview'

describe('timeFromRatio', () => {
  it('maps a 0–1 position onto the real duration', () => {
    expect(timeFromRatio(0, 100)).toBe(0)
    expect(timeFromRatio(0.25, 100)).toBe(25)
    expect(timeFromRatio(1, 100)).toBe(100)
    expect(timeFromRatio(0.5, 63.5)).toBe(31.75)
  })

  it('clamps out-of-range ratios', () => {
    expect(timeFromRatio(-0.5, 100)).toBe(0)
    expect(timeFromRatio(1.5, 100)).toBe(100)
  })

  it('returns 0 while the duration is unknown or the ratio is absent', () => {
    expect(timeFromRatio(0.5, 0)).toBe(0)
    expect(timeFromRatio(0.5, Number.NaN)).toBe(0)
    expect(timeFromRatio(0.5, Number.POSITIVE_INFINITY)).toBe(0)
    expect(timeFromRatio(null, 100)).toBe(0)
    expect(timeFromRatio(Number.NaN, 100)).toBe(0)
  })
})

describe('spriteStyleForCue', () => {
  it('positions a 160×90 tile from xywh without scaling', () => {
    const style = spriteStyleForCue({
      start: 5,
      end: 10,
      url: 'https://cdn.example.com/sprite.jpg',
      x: 320,
      y: 90,
      w: 160,
      h: 90,
    })

    expect(style).toEqual({
      backgroundImage: 'url("https://cdn.example.com/sprite.jpg")',
      backgroundPosition: '-320px -90px',
      width: '160px',
      height: '90px',
    })
    expect(style?.transform).toBeUndefined()
  })

  it('scales tiles that do not match the preview size', () => {
    const style = spriteStyleForCue({
      start: 0,
      end: 5,
      url: 'sprite.jpg',
      x: 0,
      y: 0,
      w: 320,
      h: 180,
    })

    // min(160/320, 90/180) = 0.5 — a 2× tile is shown at half size.
    expect(style?.transform).toBe('scale(0.5)')
    expect(style?.width).toBe('320px')
  })

  it('keeps the aspect ratio when only one dimension differs', () => {
    const style = spriteStyleForCue({ start: 0, end: 5, url: 's.jpg', x: 0, y: 0, w: 160, h: 45 })
    // min(1, 2) = 1 → no upscaling of the width-driven axis.
    expect(style?.transform).toBeUndefined()
  })

  it('returns null for plain image cues and missing cues', () => {
    expect(spriteStyleForCue({ start: 0, end: 5, url: 'a.jpg' })).toBeNull()
    expect(spriteStyleForCue({ start: 0, end: 5, url: 'a.jpg', x: 10 })).toBeNull()
    expect(spriteStyleForCue(null)).toBeNull()
    expect(spriteStyleForCue(undefined)).toBeNull()
  })

  it('defaults a missing y offset to zero', () => {
    const style = spriteStyleForCue({ start: 0, end: 5, url: 's.jpg', x: 160, w: 160, h: 90 })
    expect(style?.backgroundPosition).toBe('-160px -0px')
  })

  it('exposes the preview box dimensions', () => {
    expect([PREVIEW_WIDTH, PREVIEW_HEIGHT]).toEqual([160, 90])
  })
})

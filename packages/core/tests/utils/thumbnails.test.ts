import type { ThumbnailCue } from '../../src/types/thumbnail'
import { describe, expect, it } from 'vitest'
import { parseThumbnailVtt, parseVttText } from '../../src/utils/parseThumbnailVtt'
import { findChapterAt, findThumbnailCue, resolveTimelinePreview } from '../../src/utils/timeline'

const SPRITE_VTT = `WEBVTT

00:00:00.000 --> 00:00:05.000
/sprite.jpg#xywh=0,0,160,90

00:00:05.000 --> 00:00:10.000
/sprite.jpg#xywh=160,0,160,90

00:00:10.000 --> 00:00:15.000
/sprite.jpg#xywh=320,0,160,90
`

describe('parseVttText', () => {
  it('parses sprite cues with xywh fragments', () => {
    const cues = parseVttText(SPRITE_VTT, 'https://cdn.example.com/videos/thumbs.vtt')
    expect(cues).toHaveLength(3)
    expect(cues[0]).toMatchObject({ start: 0, end: 5, x: 0, y: 0, w: 160, h: 90 })
    expect(cues[1]).toMatchObject({ start: 5, end: 10, x: 160, y: 0, w: 160, h: 90 })
    expect(cues[2].x).toBe(320)
  })

  it('resolves relative image URLs against the VTT URL', () => {
    const cues = parseVttText(
      'WEBVTT\n\n00:00:00.000 --> 00:00:05.000\nframes/frame_000.jpg\n',
      'https://cdn.example.com/videos/thumbs.vtt',
    )
    expect(cues[0].url).toBe('https://cdn.example.com/videos/frames/frame_000.jpg')
  })

  it('handles CRLF, BOM and cue settings after the end timestamp', () => {
    const text =
      '﻿WEBVTT\r\n\r\n00:00:01.000 --> 00:00:02.500 line:0\r\nsprite.jpg#xywh=10,20,30,40\r\n'
    const cues = parseVttText(text, 'https://example.com/t.vtt')
    expect(cues).toHaveLength(1)
    expect(cues[0]).toMatchObject({ start: 1, end: 2.5, x: 10, y: 20, w: 30, h: 40 })
  })

  it('accepts mm:ss timecodes', () => {
    const cues = parseVttText('WEBVTT\n\n01:00 --> 01:30\na.jpg\n')
    expect(cues[0]).toMatchObject({ start: 60, end: 90 })
  })

  it('sorts cues by start time', () => {
    const cues = parseVttText(
      'WEBVTT\n\n00:00:10.000 --> 00:00:15.000\nb.jpg\n\n00:00:00.000 --> 00:00:05.000\na.jpg\n',
    )
    expect(cues.map((c) => c.start)).toEqual([0, 10])
  })

  it('returns an empty list for a WEBVTT header without cues', () => {
    expect(parseVttText('WEBVTT\n\nNOTE nothing here\n')).toEqual([])
    expect(parseVttText('')).toEqual([])
  })

  it('skips malformed cues instead of producing bogus entries', () => {
    const cues = parseVttText(
      'WEBVTT\n\nnot a timestamp --> nope\nweird.jpg\n\n00:00:03.000 --> 00:00:01.000\nreversed.jpg\n\n00:00:04.000 --> 00:00:06.000\nok.jpg\n',
    )
    expect(cues).toHaveLength(1)
    expect(cues[0]).toMatchObject({ start: 4, end: 6, url: 'ok.jpg' })
  })

  it('treats a non-xywh fragment as a plain image', () => {
    const cues = parseVttText('WEBVTT\n\n00:00:00.000 --> 00:00:05.000\nframe.jpg#t=0.5\n')
    expect(cues[0].x).toBeUndefined()
    expect(cues[0].url).toBe('frame.jpg')
  })

  it('does not let a cue with a missing image swallow the next cue', () => {
    const cues = parseVttText(
      'WEBVTT\n\n00:00:00.000 --> 00:00:05.000\n\n00:00:05.000 --> 00:00:10.000\nsecond.jpg\n',
    )
    expect(cues).toHaveLength(1)
    expect(cues[0]).toMatchObject({ start: 5, end: 10, url: 'second.jpg' })
  })

  it('parses back-to-back cues without blank separators', () => {
    const cues = parseVttText(
      'WEBVTT\n\n00:00:00.000 --> 00:00:05.000\na.jpg\n00:00:05.000 --> 00:00:10.000\nb.jpg\n',
    )
    expect(cues.map((c) => c.url)).toEqual(['a.jpg', 'b.jpg'])
  })
})

describe('parseThumbnailVtt', () => {
  const okResponse = (body: string) =>
    ({ ok: true, status: 200, text: async () => body }) as unknown as Response

  it('parses a fetched manifest', async () => {
    const cues = await parseThumbnailVtt('https://example.com/thumbs.vtt', {
      fetchImpl: (async () => okResponse(SPRITE_VTT)) as unknown as typeof fetch,
    })
    expect(cues).toHaveLength(3)
    expect(cues[0].url).toBe('https://example.com/sprite.jpg')
  })

  it('returns an empty list on a failed request instead of throwing', async () => {
    const cues = await parseThumbnailVtt('https://example.com/missing.vtt', {
      fetchImpl: (async () => ({ ok: false, status: 404 }) as Response) as unknown as typeof fetch,
    })
    expect(cues).toEqual([])
  })

  it('returns an empty list on a network error', async () => {
    const cues = await parseThumbnailVtt('https://example.com/thumbs.vtt', {
      fetchImpl: (async () => {
        throw new Error('network down')
      }) as unknown as typeof fetch,
    })
    expect(cues).toEqual([])
  })

  it('returns an empty list when fetch is unavailable', async () => {
    const original = globalThis.fetch
    // @ts-expect-error — simulate an environment without fetch
    globalThis.fetch = undefined
    try {
      expect(await parseThumbnailVtt('https://example.com/thumbs.vtt')).toEqual([])
    } finally {
      globalThis.fetch = original
    }
  })
})

describe('findThumbnailCue', () => {
  const cues: ThumbnailCue[] = [
    { start: 0, end: 5, url: 'a.jpg' },
    { start: 5, end: 10, url: 'b.jpg' },
    { start: 10, end: 15, url: 'c.jpg' },
  ]

  it('selects the cue covering the time', () => {
    expect(findThumbnailCue(cues, 0)).toBe(cues[0])
    expect(findThumbnailCue(cues, 4.999)).toBe(cues[0])
    expect(findThumbnailCue(cues, 5)).toBe(cues[1])
    expect(findThumbnailCue(cues, 12)).toBe(cues[2])
  })

  it('returns null outside the manifest range', () => {
    expect(findThumbnailCue(cues, 15)).toBeNull()
    expect(findThumbnailCue(cues, 100)).toBeNull()
  })

  it('handles an empty or missing manifest', () => {
    expect(findThumbnailCue([], 3)).toBeNull()
    expect(findThumbnailCue(null, 3)).toBeNull()
    expect(findThumbnailCue(undefined, 3)).toBeNull()
  })

  it('returns null for non-finite input', () => {
    expect(findThumbnailCue(cues, Number.NaN)).toBeNull()
    expect(findThumbnailCue(cues, Number.POSITIVE_INFINITY)).toBeNull()
  })

  it('handles gaps between cues', () => {
    const gapped: ThumbnailCue[] = [
      { start: 0, end: 2, url: 'a.jpg' },
      { start: 8, end: 10, url: 'b.jpg' },
    ]
    expect(findThumbnailCue(gapped, 5)).toBeNull()
    expect(findThumbnailCue(gapped, 9)).toBe(gapped[1])
  })
})

describe('findChapterAt', () => {
  const chapters = [
    { time: 0, label: 'Intro' },
    { time: 60, label: 'Main' },
    { time: 120, label: 'End' },
  ]

  it('returns the chapter active at the time', () => {
    expect(findChapterAt(chapters, 0)?.label).toBe('Intro')
    expect(findChapterAt(chapters, 59.9)?.label).toBe('Intro')
    expect(findChapterAt(chapters, 60)?.label).toBe('Main')
    expect(findChapterAt(chapters, 999)?.label).toBe('End')
  })

  it('returns null when no chapter covers the time', () => {
    expect(findChapterAt([{ time: 10, label: 'Later' }], 5)).toBeNull()
    expect(findChapterAt([], 5)).toBeNull()
    expect(findChapterAt(undefined, 5)).toBeNull()
  })

  it('works with unsorted chapters', () => {
    const unsorted = [
      { time: 120, label: 'End' },
      { time: 0, label: 'Intro' },
      { time: 60, label: 'Main' },
    ]
    expect(findChapterAt(unsorted, 90)?.label).toBe('Main')
  })
})

describe('resolveTimelinePreview', () => {
  const chapters = [
    { time: 0, label: 'Intro' },
    { time: 30, label: 'Main' },
  ]
  const cues: ThumbnailCue[] = [
    { start: 0, end: 10, url: 'a.jpg', x: 0, y: 0, w: 160, h: 90 },
    { start: 10, end: 20, url: 'b.jpg', x: 160, y: 0, w: 160, h: 90 },
  ]

  it('resolves cue and chapter from the same media time', () => {
    expect(resolveTimelinePreview(chapters, cues, 12)).toEqual({
      time: 12,
      chapter: chapters[0],
      cue: cues[1],
    })
  })

  it('keeps the chapter when the time is outside the cue range', () => {
    const preview = resolveTimelinePreview(chapters, cues, 45)
    expect(preview.cue).toBeNull()
    expect(preview.chapter?.label).toBe('Main')
    expect(preview.time).toBe(45)
  })

  it('clamps negative time to zero', () => {
    expect(resolveTimelinePreview(chapters, cues, -3).time).toBe(0)
  })

  it('handles missing chapters and cues', () => {
    expect(resolveTimelinePreview(undefined, undefined, 5)).toEqual({
      time: 5,
      chapter: null,
      cue: null,
    })
  })
})

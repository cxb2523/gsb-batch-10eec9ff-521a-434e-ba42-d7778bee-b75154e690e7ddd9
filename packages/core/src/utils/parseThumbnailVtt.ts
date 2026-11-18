import { parseTimecode } from './time'
import type { ThumbnailCue } from '../types/thumbnail'

export interface ParseThumbnailOptions {
  /** Abort an in-flight request when the video source changes. */
  signal?: AbortSignal
  /** Override the fetch implementation (useful for tests and SSR). */
  fetchImpl?: typeof fetch
}

function resolveUrl(base: string, url: string): string {
  try {
    return new URL(url, base).href
  } catch {
    // `base` may itself be relative (e.g. the `thumbnails` prop is "/thumbs.vtt").
    // Fall back to the document base so relative image paths still resolve.
    const docBase =
      typeof document !== 'undefined' && document.baseURI ? document.baseURI : undefined
    if (docBase) {
      try {
        return new URL(url, new URL(base, docBase)).href
      } catch {
        /* fall through */
      }
    }
    return url
  }
}

function isTimeToken(token: string): boolean {
  return /^\d+(?::\d{1,2}){0,2}(?:[.,]\d{1,3})?$/.test(token)
}

/**
 * Fetch and parse a WebVTT thumbnail file.
 *
 * Never rejects: a failed request (network error, non-2xx status, aborted
 * request, malformed body) resolves to an empty cue list so playback and
 * timeline interactions are never blocked by thumbnail metadata.
 */
export async function parseThumbnailVtt(
  url: string,
  options: ParseThumbnailOptions = {},
): Promise<ThumbnailCue[]> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch
  if (typeof fetchImpl !== 'function') return []

  try {
    const res = await fetchImpl(url, { signal: options.signal })
    if (!res.ok) return []
    const text = await res.text()
    return parseVttText(text, url)
  } catch {
    return []
  }
}

export function parseVttText(text: string, baseUrl = ''): ThumbnailCue[] {
  const cues: ThumbnailCue[] = []
  const lines = text
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
  let i = 0

  // Skip WEBVTT header and any metadata blocks
  while (i < lines.length && !lines[i].includes('-->')) i++

  while (i < lines.length) {
    const line = lines[i].trim()

    if (!line.includes('-->')) {
      i++
      continue
    }

    // Parse "HH:MM:SS.mmm --> HH:MM:SS.mmm" — ignore position settings after the second timestamp
    const arrowIdx = line.indexOf('-->')
    const startToken = line.slice(0, arrowIdx).trim()
    const endSide = line.slice(arrowIdx + 3).trim()
    const endToken = endSide.split(/\s/)[0] ?? ''

    if (!isTimeToken(startToken) || !isTimeToken(endToken)) {
      i++
      continue
    }

    const start = parseTimecode(startToken)
    const end = parseTimecode(endToken)

    // Consume the timestamp line up front. If the following line is not a
    // usable image we leave `i` on it, so a cue that is missing its image
    // payload cannot swallow the next cue's timestamp line.
    i++
    const imgLine = lines[i]?.trim()

    if (!imgLine) {
      continue
    }

    const hashIdx = imgLine.lastIndexOf('#')
    const rawUrl = hashIdx !== -1 ? imgLine.slice(0, hashIdx) : imgLine
    const fragment = hashIdx !== -1 ? imgLine.slice(hashIdx + 1) : ''

    // A valid cue must reference an image, not a stray text line or the next
    // timestamp line.
    if (!rawUrl || rawUrl.includes('-->')) {
      continue
    }

    const resolvedUrl = resolveUrl(baseUrl, rawUrl)
    const cue: ThumbnailCue = { start, end, url: resolvedUrl }

    if (fragment.startsWith('xywh=')) {
      const nums = fragment
        .slice(5)
        .split(',')
        .map((part) => Number(part.trim()))
      if (nums.length === 4 && nums.every((n) => Number.isFinite(n))) {
        ;[cue.x, cue.y, cue.w, cue.h] = nums
      }
    }

    if (cue.end > cue.start) {
      cues.push(cue)
    }
    i++
  }

  // Sorted so cue lookup and rendering follow media time even if the VTT is out of order.
  cues.sort((a, b) => a.start - b.start || a.end - b.end)
  return cues
}

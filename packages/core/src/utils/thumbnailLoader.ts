import type { ThumbnailCue } from '../types/thumbnail'
import type { ParseThumbnailOptions } from './parseThumbnailVtt'
import { parseThumbnailVtt } from './parseThumbnailVtt'

export interface ThumbnailLoaderState {
  /** Cues for the currently loaded source. Always empty while a new request is in flight. */
  readonly cues: readonly ThumbnailCue[]
  /** `true` while a manifest request is in flight. */
  readonly loading: boolean
}

export interface ThumbnailLoaderOptions extends ParseThumbnailOptions {
  /** Called whenever `cues` or `loading` changes. */
  onChange?: (state: ThumbnailLoaderState) => void
}

export interface ThumbnailLoader {
  /**
   * Replace the cue list with the manifest at `url`.
   *
   * The previous cues are dropped immediately, and any in-flight request is
   * aborted. When a newer `load`/`reset` supersedes this call its result is
   * discarded. Never rejects — a failed request yields an empty list.
   */
  load: (url: string | null | undefined) => Promise<readonly ThumbnailCue[]>
  /** Drop the current cues and cancel any in-flight request. */
  reset: () => void
  /** `reset()` plus permanently prevent pending responses from being applied. */
  dispose: () => void
  /** Current snapshot. */
  getState: () => ThumbnailLoaderState
}

const EMPTY: readonly ThumbnailCue[] = []

/**
 * Framework-agnostic thumbnail manifest loader with request-generation
 * tracking, so a response for a previous video source can never overwrite the
 * cue list of the current one.
 */
export function createThumbnailLoader(options: ThumbnailLoaderOptions = {}): ThumbnailLoader {
  let cues: readonly ThumbnailCue[] = EMPTY
  let loading = false
  let abort: AbortController | null = null
  let requestId = 0
  // Local copy so `dispose` can stop notifications without mutating the
  // caller's options object.
  let onChange = options.onChange

  function getState(): ThumbnailLoaderState {
    return { cues, loading }
  }

  function commit(nextCues: readonly ThumbnailCue[], nextLoading: boolean) {
    cues = nextCues
    loading = nextLoading
    onChange?.(getState())
  }

  function cancel() {
    requestId++
    abort?.abort()
    abort = null
  }

  function reset() {
    cancel()
    commit(EMPTY, false)
  }

  async function load(url: string | null | undefined): Promise<readonly ThumbnailCue[]> {
    cancel()

    const id = requestId
    const target = typeof url === 'string' && url.length > 0 ? url : null

    if (!target) {
      commit(EMPTY, false)
      return EMPTY
    }

    const controller = new AbortController()
    abort = controller
    // Clear stale cues before the request so the timeline never shows frames
    // from a previous source while the new manifest is loading.
    commit(EMPTY, true)

    const parsed = await parseThumbnailVtt(target, {
      ...options,
      signal: controller.signal,
    })

    // Superseded by a newer load/reset — drop this result.
    if (id !== requestId) {
      return EMPTY
    }

    abort = null
    commit(parsed, false)
    return parsed
  }

  function dispose() {
    reset()
    onChange = undefined
  }

  return { load, reset, dispose, getState }
}

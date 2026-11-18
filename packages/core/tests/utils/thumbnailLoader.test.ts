import type { ThumbnailLoaderState } from '../../src/utils/thumbnailLoader'
import { describe, expect, it } from 'vitest'
import { createThumbnailLoader } from '../../src/utils/thumbnailLoader'

interface Deferred {
  resolve: (body: string) => void
  reject: (error: unknown) => void
  signal?: AbortSignal
}

/**
 * A fetch stub whose responses resolve only when the test says so — this lets
 * us assert what is visible *while* a manifest is in flight and that a slow
 * response for an old source can never land on a newer one.
 */
function createFetchStub() {
  const requests: Deferred[] = []
  const fetchImpl = ((_url: string, init?: RequestInit) => {
    return new Promise<Response>((resolve, reject) => {
      const entry: Deferred = {
        signal: init?.signal ?? undefined,
        resolve: (body: string) =>
          resolve({ ok: true, status: 200, text: async () => body } as Response),
        reject,
      }
      entry.signal?.addEventListener('abort', () => reject(new Error('aborted')))
      requests.push(entry)
    })
  }) as unknown as typeof fetch

  return { fetchImpl, requests }
}

function vtt(...entries: Array<[number, number, string]>): string {
  const cues = entries
    .map(([start, end, image]) => `${formatTs(start)} --> ${formatTs(end)}\n${image}`)
    .join('\n\n')
  return `WEBVTT\n\n${cues}\n`
}

function formatTs(seconds: number): string {
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = seconds % 60
  const ss = s.toFixed(3).padStart(6, '0')
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${ss}`
}

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

describe('createThumbnailLoader', () => {
  it('loads cues and reports loading state', async () => {
    const { fetchImpl, requests } = createFetchStub()
    const states: ThumbnailLoaderState[] = []
    const loader = createThumbnailLoader({ fetchImpl, onChange: (s) => states.push(s) })

    const pending = loader.load('https://example.com/thumbs.vtt')

    // While in flight: no cues, loading = true.
    expect(loader.getState()).toEqual({ cues: [], loading: true })
    expect(states.at(-1)).toEqual({ cues: [], loading: true })

    requests[0].resolve(vtt([0, 5, 'a.jpg'], [5, 10, 'b.jpg']))
    const cues = await pending

    expect(cues.map((c) => c.url)).toEqual([
      'https://example.com/a.jpg',
      'https://example.com/b.jpg',
    ])
    expect(loader.getState()).toEqual({ cues, loading: false })
  })

  it('drops old cues immediately when a new source loads', async () => {
    const { fetchImpl, requests } = createFetchStub()
    const loader = createThumbnailLoader({ fetchImpl })

    const first = loader.load('https://example.com/one.vtt')
    requests[0].resolve(vtt([0, 5, 'old.jpg']))
    await first
    expect(loader.getState().cues).toHaveLength(1)

    const second = loader.load('https://example.com/two.vtt')
    // The previous source's thumbnails must be gone right away…
    expect(loader.getState().cues).toEqual([])
    expect(loader.getState().loading).toBe(true)

    requests[1].resolve(vtt([0, 5, 'new.jpg']))
    await second
    expect(loader.getState().cues.map((c) => c.url)).toEqual(['https://example.com/new.jpg'])
  })

  it('ignores a stale response that resolves after a newer load', async () => {
    const { fetchImpl, requests } = createFetchStub()
    const loader = createThumbnailLoader({ fetchImpl })

    const first = loader.load('https://example.com/one.vtt')
    const second = loader.load('https://example.com/two.vtt')

    // The second (newest) request lands first…
    requests[1].resolve(vtt([0, 5, 'new.jpg']))
    await second

    // …then the old one completes late and must be discarded.
    requests[0].resolve(vtt([0, 5, 'old.jpg']))
    await first

    expect(loader.getState().cues.map((c) => c.url)).toEqual(['https://example.com/new.jpg'])
  })

  it('aborts the previous request when the source changes', async () => {
    const { fetchImpl, requests } = createFetchStub()
    const loader = createThumbnailLoader({ fetchImpl })

    void loader.load('https://example.com/one.vtt')
    const signal = requests[0].signal
    expect(signal?.aborted).toBe(false)

    void loader.load('https://example.com/two.vtt')
    expect(signal?.aborted).toBe(true)
  })

  it('resolves to an empty list and keeps loading=false on request failure', async () => {
    const failingFetch = (async () => ({ ok: false, status: 500 }) as Response) as typeof fetch
    const loader = createThumbnailLoader({ fetchImpl: failingFetch })

    const cues = await loader.load('https://example.com/thumbs.vtt')

    expect(cues).toEqual([])
    expect(loader.getState()).toEqual({ cues: [], loading: false })
  })

  it('resolves to an empty list on a network error', async () => {
    const throwingFetch = (async () => {
      throw new TypeError('failed to fetch')
    }) as unknown as typeof fetch
    const loader = createThumbnailLoader({ fetchImpl: throwingFetch })

    await expect(loader.load('https://example.com/thumbs.vtt')).resolves.toEqual([])
    expect(loader.getState().loading).toBe(false)
  })

  it('clears cues for a null or empty URL without fetching', async () => {
    const { fetchImpl, requests } = createFetchStub()
    const loader = createThumbnailLoader({ fetchImpl })

    expect(await loader.load(null)).toEqual([])
    expect(await loader.load('')).toEqual([])
    expect(requests).toHaveLength(0)
    expect(loader.getState()).toEqual({ cues: [], loading: false })
  })

  it('reset() clears cues and prevents an in-flight response from applying', async () => {
    const { fetchImpl, requests } = createFetchStub()
    const loader = createThumbnailLoader({ fetchImpl })

    const pending = loader.load('https://example.com/one.vtt')
    loader.reset()

    expect(loader.getState()).toEqual({ cues: [], loading: false })

    requests[0].resolve(vtt([0, 5, 'late.jpg']))
    await pending

    expect(loader.getState()).toEqual({ cues: [], loading: false })
  })

  it('stop notifying after dispose()', async () => {
    const { fetchImpl, requests } = createFetchStub()
    const states: ThumbnailLoaderState[] = []
    const loader = createThumbnailLoader({ fetchImpl, onChange: (s) => states.push(s) })

    const pending = loader.load('https://example.com/one.vtt')
    loader.dispose()
    const countAfterDispose = states.length

    requests[0].resolve(vtt([0, 5, 'late.jpg']))
    await pending

    expect(states).toHaveLength(countAfterDispose)
  })

  it('keeps sprite metadata from the manifest', async () => {
    const body = vtt([0, 5, 'sprite.jpg#xywh=0,0,160,90'], [5, 10, 'sprite.jpg#xywh=160,0,160,90'])
    const loader = createThumbnailLoader({
      fetchImpl: (async () =>
        ({ ok: true, status: 200, text: async () => body }) as Response) as unknown as typeof fetch,
    })

    const cues = await loader.load('https://example.com/thumbs.vtt')

    expect(cues).toHaveLength(2)
    expect(cues[1]).toMatchObject({ start: 5, end: 10, x: 160, y: 0, w: 160, h: 90 })
    expect(cues[1].url).toBe('https://example.com/sprite.jpg')
  })

  it('loads sequentially when a second load starts after the first settles', async () => {
    const { fetchImpl, requests } = createFetchStub()
    const loader = createThumbnailLoader({ fetchImpl })

    const first = loader.load('https://example.com/one.vtt')
    requests[0].resolve(vtt([0, 5, 'one.jpg']))
    await first

    const second = loader.load('https://example.com/two.vtt')
    await flush()
    requests[1].resolve(vtt([0, 5, 'two.jpg']))
    await second

    expect(loader.getState().cues.map((c) => c.url)).toEqual(['https://example.com/two.jpg'])
    expect(loader.getState().loading).toBe(false)
  })
})

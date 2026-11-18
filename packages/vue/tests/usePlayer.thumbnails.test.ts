import { describe, expect, it, vi } from 'vitest'
import { effectScope, nextTick, ref } from 'vue'
import { usePlayer } from '../src/composables/usePlayer'

interface DeferredRequest {
  url: string
  resolve: (body: string) => void
  reject: (error: unknown) => void
  signal?: AbortSignal
}

function createFetchStub() {
  const requests: DeferredRequest[] = []
  const fetchImpl = ((url: string, init?: RequestInit) => {
    return new Promise<Response>((resolve, reject) => {
      const request: DeferredRequest = {
        url: String(url),
        signal: init?.signal ?? undefined,
        resolve: (body: string) =>
          resolve({ ok: true, status: 200, text: async () => body } as Response),
        reject,
      }
      request.signal?.addEventListener('abort', () => reject(new Error('aborted')))
      requests.push(request)
    })
  }) as unknown as typeof fetch

  return { fetchImpl, requests }
}

/** Minimal stand-in for <video> — usePlayer only calls these members. */
function createVideoStub() {
  return {
    src: '',
    duration: Number.NaN,
    currentTime: 0,
    volume: 1,
    muted: false,
    paused: true,
    ended: false,
    playbackRate: 1,
    buffered: { length: 0, end: () => 0 },
    pause: vi.fn(),
    load: vi.fn(),
    removeAttribute: vi.fn(),
    addEventListener: vi.fn(),
  } as unknown as HTMLVideoElement
}

function vtt(...entries: Array<[number, number, string]>): string {
  const cues = entries
    .map(([start, end, image]) => `${ts(start)} --> ${ts(end)}\n${image}`)
    .join('\n\n')
  return `WEBVTT\n\n${cues}\n`
}

function ts(seconds: number): string {
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = (seconds % 60).toFixed(3).padStart(6, '0')
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${s}`
}

function setupPlayer(thumbnails?: () => string | undefined) {
  const video = createVideoStub()
  const videoRef = ref<HTMLVideoElement | null>(video)
  const scope = effectScope()
  // onMounted/onUnmounted have no component instance here; their hooks simply
  // don't run, which is fine because we drive loadSource manually.
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const player = scope.run(() => usePlayer(videoRef, { thumbnails }))!
  warn.mockRestore()
  return { player, scope, video }
}

describe('usePlayer thumbnail lifecycle', () => {
  it('loads the manifest when a source is loaded', async () => {
    const { fetchImpl, requests } = createFetchStub()
    vi.stubGlobal('fetch', fetchImpl)

    const { player, scope } = setupPlayer(() => '/thumbs.vtt')
    await player.loadSource('https://cdn.example.com/video.mp4')

    expect(requests).toHaveLength(1)
    expect(requests[0].url).toBe('/thumbs.vtt')
    expect(player.thumbnailsLoading.value).toBe(true)
    expect(player.thumbnails.value).toEqual([])

    requests[0].resolve(vtt([0, 5, 'a.jpg'], [5, 10, 'b.jpg']))
    await vi.waitFor(() => expect(player.thumbnails.value).toHaveLength(2))

    expect(player.thumbnailsLoading.value).toBe(false)
    expect(player.thumbnails.value.map((c) => c.start)).toEqual([0, 5])

    scope.stop()
    vi.unstubAllGlobals()
  })

  it('clears old thumbnails immediately when the source changes', async () => {
    const { fetchImpl, requests } = createFetchStub()
    vi.stubGlobal('fetch', fetchImpl)

    const { player, scope } = setupPlayer(() => '/thumbs.vtt')
    await player.loadSource('https://cdn.example.com/one.mp4')
    requests[0].resolve(vtt([0, 5, 'old.jpg']))
    await vi.waitFor(() => expect(player.thumbnails.value).toHaveLength(1))

    // Switch source: the previous source's cues must disappear synchronously.
    await player.loadSource('https://cdn.example.com/two.mp4')
    expect(player.thumbnails.value).toEqual([])

    expect(requests).toHaveLength(2)
    requests[1].resolve(vtt([0, 5, 'new.jpg']))
    await vi.waitFor(() => expect(player.thumbnails.value).toHaveLength(1))
    expect(player.thumbnails.value[0].url).toContain('new.jpg')

    scope.stop()
    vi.unstubAllGlobals()
  })

  it('discards a stale manifest that resolves after a source switch', async () => {
    const { fetchImpl, requests } = createFetchStub()
    vi.stubGlobal('fetch', fetchImpl)

    const { player, scope } = setupPlayer(() => '/thumbs.vtt')
    await player.loadSource('https://cdn.example.com/one.mp4')
    await player.loadSource('https://cdn.example.com/two.mp4')

    // Newest request answers first…
    requests[1].resolve(vtt([0, 5, 'new.jpg']))
    await vi.waitFor(() => expect(player.thumbnails.value).toHaveLength(1))

    // …then the old, aborted request settles late and must not overwrite it.
    requests[0].resolve(vtt([0, 5, 'old.jpg']))
    await nextTick()

    expect(player.thumbnails.value.map((c) => c.url)).toEqual(['new.jpg'])

    scope.stop()
    vi.unstubAllGlobals()
  })

  it('keeps an empty list and does not reject when the manifest request fails', async () => {
    const failingFetch = (async () => ({ ok: false, status: 404 }) as Response) as typeof fetch
    vi.stubGlobal('fetch', failingFetch)

    const { player, scope } = setupPlayer(() => '/missing.vtt')

    await expect(player.loadSource('https://cdn.example.com/video.mp4')).resolves.toBeUndefined()
    await vi.waitFor(() => expect(player.thumbnailsLoading.value).toBe(false))

    expect(player.thumbnails.value).toEqual([])
    expect(player.state.isLoading).toBe(true) // playback is not blocked by thumbnails

    scope.stop()
    vi.unstubAllGlobals()
  })

  it('still loads the video source when thumbnail loading throws', async () => {
    const throwingFetch = (async () => {
      throw new TypeError('failed to fetch')
    }) as unknown as typeof fetch
    vi.stubGlobal('fetch', throwingFetch)

    const { player, scope, video } = setupPlayer(() => '/thumbs.vtt')
    await player.loadSource('https://cdn.example.com/video.mp4')

    expect(video.src).toBe('https://cdn.example.com/video.mp4')
    expect(player.thumbnails.value).toEqual([])

    scope.stop()
    vi.unstubAllGlobals()
  })

  it('reloads when the thumbnail URL changes without a source change', async () => {
    const { fetchImpl, requests } = createFetchStub()
    vi.stubGlobal('fetch', fetchImpl)

    const url = ref<string | undefined>('/one.vtt')
    const { player, scope } = setupPlayer(() => url.value)

    await player.loadSource('https://cdn.example.com/video.mp4')
    requests[0].resolve(vtt([0, 5, 'one.jpg']))
    await vi.waitFor(() => expect(player.thumbnails.value).toHaveLength(1))

    url.value = '/two.vtt'
    await nextTick()
    await nextTick()

    expect(requests).toHaveLength(2)
    expect(requests[1].url).toBe('/two.vtt')
    // Old cues are gone while the replacement loads.
    expect(player.thumbnails.value).toEqual([])

    requests[1].resolve(vtt([0, 5, 'two.jpg']))
    await vi.waitFor(() => expect(player.thumbnails.value).toHaveLength(1))
    expect(player.thumbnails.value[0].url).toBe('two.jpg')

    scope.stop()
    vi.unstubAllGlobals()
  })

  it('clears the list when the thumbnail URL is removed', async () => {
    const { fetchImpl, requests } = createFetchStub()
    vi.stubGlobal('fetch', fetchImpl)

    const url = ref<string | undefined>('/one.vtt')
    const { player, scope } = setupPlayer(() => url.value)

    await player.loadSource('https://cdn.example.com/video.mp4')
    requests[0].resolve(vtt([0, 5, 'one.jpg']))
    await vi.waitFor(() => expect(player.thumbnails.value).toHaveLength(1))

    url.value = undefined
    await nextTick()
    await nextTick()

    expect(player.thumbnails.value).toEqual([])

    scope.stop()
    vi.unstubAllGlobals()
  })

  it('does not fetch thumbnails when no URL is configured', async () => {
    const { fetchImpl, requests } = createFetchStub()
    vi.stubGlobal('fetch', fetchImpl)

    const { player, scope } = setupPlayer()
    await player.loadSource('https://cdn.example.com/video.mp4')

    expect(requests).toHaveLength(0)
    expect(player.thumbnails.value).toEqual([])
    expect(player.thumbnailsLoading.value).toBe(false)

    scope.stop()
    vi.unstubAllGlobals()
  })

  it('exposes thumbnails as a readonly ref', async () => {
    const { fetchImpl, requests } = createFetchStub()
    vi.stubGlobal('fetch', fetchImpl)

    const { player, scope } = setupPlayer(() => '/thumbs.vtt')
    await player.loadSource('https://cdn.example.com/video.mp4')
    requests[0].resolve(vtt([0, 5, 'a.jpg']))
    await vi.waitFor(() => expect(player.thumbnails.value).toHaveLength(1))

    // readonly() warns and refuses writes in dev.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    ;(player.thumbnails as { value: unknown }).value = []
    warn.mockRestore()
    expect(player.thumbnails.value).toHaveLength(1)

    scope.stop()
    vi.unstubAllGlobals()
  })

  it('reloadThumbnails() refetches the current manifest', async () => {
    const { fetchImpl, requests } = createFetchStub()
    vi.stubGlobal('fetch', fetchImpl)

    const { player, scope } = setupPlayer(() => '/thumbs.vtt')
    await player.loadSource('https://cdn.example.com/video.mp4')
    requests[0].resolve(vtt([0, 5, 'a.jpg']))
    await vi.waitFor(() => expect(player.thumbnails.value).toHaveLength(1))

    const reload = player.reloadThumbnails()
    expect(requests).toHaveLength(2)
    requests[1].resolve(vtt([0, 5, 'a.jpg'], [5, 10, 'b.jpg']))
    await reload

    expect(player.thumbnails.value).toHaveLength(2)

    scope.stop()
    vi.unstubAllGlobals()
  })
})

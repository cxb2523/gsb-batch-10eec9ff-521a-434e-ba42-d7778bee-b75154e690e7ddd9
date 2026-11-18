// @vitest-environment happy-dom
import { mount } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'
import VideoPlayer from '../src/components/VideoPlayer/VideoPlayer.vue'

const TRACK_WIDTH = 400

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

/** Force the timeline to report a usable size, then hover at `fraction`. */
async function hoverTimeline(wrapper: ReturnType<typeof mount>, fraction: number) {
  const root = wrapper.find<HTMLElement>('.vp-timeline')
  root.element.getBoundingClientRect = () =>
    ({
      left: 0,
      top: 0,
      width: TRACK_WIDTH,
      height: 20,
      right: TRACK_WIDTH,
      bottom: 20,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    }) as DOMRect

  const track = wrapper.find('.vp-timeline-track')
  await track.trigger('mousemove', { clientX: fraction * TRACK_WIDTH })
  await nextTick()
}

function setDuration(wrapper: ReturnType<typeof mount>, duration: number) {
  // The player reads duration from the <video> element; stub it and let the
  // existing durationchange listener sync player state.
  const video = wrapper.find('video').element as HTMLVideoElement
  Object.defineProperty(video, 'duration', { value: duration, configurable: true })
  video.dispatchEvent(new Event('durationchange'))
  return nextTick()
}

describe('videoPlayer thumbnail integration', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('drops old thumbnails on a source switch and uses the new manifest', async () => {
    const { fetchImpl, requests } = createFetchStub()
    vi.stubGlobal('fetch', fetchImpl)

    const wrapper = mount(VideoPlayer, {
      props: { src: '/video-a.mp4', thumbnails: '/thumbs-a.vtt' },
      attachTo: document.body,
    })

    expect(requests.map((r) => r.url)).toEqual(['/thumbs-a.vtt'])
    requests[0].resolve(vtt([0, 5, 'sprite-a.png#xywh=0,0,160,90']))
    await vi.waitFor(() => expect(requests).toHaveLength(1))
    await nextTick()

    await setDuration(wrapper, 10)
    await hoverTimeline(wrapper, 0.25) // 2.5s → cue from manifest A
    expect(wrapper.find('.vp-thumbnail-sprite').attributes('style')).toContain('sprite-a.png')

    // Switch source together with its manifest.
    await wrapper.setProps({ src: '/video-b.mp4', thumbnails: '/thumbs-b.vtt' })
    await nextTick()

    // The old preview must be gone immediately…
    await hoverTimeline(wrapper, 0.25)
    expect(wrapper.find('.vp-thumbnail-preview').exists()).toBe(false)

    // …and only one request should have been made for the new manifest.
    await vi.waitFor(() => expect(requests).toHaveLength(2))
    expect(requests[1].url).toBe('/thumbs-b.vtt')

    requests[1].resolve(vtt([0, 100, 'sprite-b.png#xywh=160,0,160,90']))
    await vi.waitFor(() => expect(wrapper.find('.vp-thumbnail-sprite').exists()).toBe(true))

    await hoverTimeline(wrapper, 0.25)
    const style = wrapper.find('.vp-thumbnail-sprite').attributes('style')
    expect(style).toContain('sprite-b.png')
    expect(style).toContain('-160px 0px')

    wrapper.unmount()
  })

  it('keeps the timeline usable when the manifest request fails', async () => {
    const failingFetch = (async () => ({ ok: false, status: 404 }) as Response) as typeof fetch
    vi.stubGlobal('fetch', failingFetch)

    const wrapper = mount(VideoPlayer, {
      props: {
        src: '/video.mp4',
        thumbnails: '/missing.vtt',
        chapters: [
          { time: 0, label: 'Intro' },
          { time: 20, label: 'Main' },
        ],
      },
      attachTo: document.body,
    })

    await vi.waitFor(() => expect(wrapper.find('.vp-thumbnail-preview').exists()).toBe(false))

    await setDuration(wrapper, 40)
    await hoverTimeline(wrapper, 0.75) // 30s → "Main", no manifest

    expect(wrapper.find('.vp-thumbnail-preview').exists()).toBe(false)
    expect(wrapper.find('.vp-tooltip-chapter').text()).toBe('Main')
    expect(wrapper.find('.vp-timeline-tooltip').text()).toContain('0:30')

    wrapper.unmount()
  })
})

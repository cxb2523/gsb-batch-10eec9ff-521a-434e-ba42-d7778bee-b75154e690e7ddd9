// @vitest-environment happy-dom
import type { Chapter } from '@vue-player/core'
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import { nextTick } from 'vue'
import VpTimeline from '../src/components/controls/VpTimeline.vue'

const CHAPTERS: Chapter[] = [
  { time: 0, label: 'Intro' },
  { time: 20, label: 'Middle' },
  { time: 45, label: 'Outro' },
]

// A four-cue sprite manifest: 0–10, 10–20, 20–40, 40–60 seconds.
const CUES = [
  { start: 0, end: 10, url: 'sprite.png', x: 0, y: 0, w: 160, h: 90 },
  { start: 10, end: 20, url: 'sprite.png', x: 160, y: 0, w: 160, h: 90 },
  { start: 20, end: 40, url: 'sprite.png', x: 320, y: 0, w: 160, h: 90 },
  { start: 40, end: 60, url: 'sprite.png', x: 480, y: 0, w: 160, h: 90 },
]

const TRACK_WIDTH = 400

function mountTimeline(
  options: {
    duration?: number
    cues?: typeof CUES
    chapters?: Chapter[]
  } = {},
) {
  const wrapper = mount(VpTimeline, {
    props: {
      currentTime: 0,
      duration: options.duration ?? 60,
      buffered: 0,
      chapters: options.chapters ?? CHAPTERS,
      thumbnailCues: options.cues ?? CUES,
    },
    attachTo: document.body,
  })

  // happy-dom reports a zero-size rect — pin it so ratio math is deterministic.
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

  // `mousemove` is handled on the inner track; the ratio is measured on the root.
  const track = wrapper.find<HTMLElement>('.vp-timeline-track')

  return { wrapper, track, root }
}

/** Hover at a fraction of the track width (0–1). */
async function hover(track: ReturnType<typeof mountTimeline>['track'], fraction: number) {
  await track.trigger('mousemove', { clientX: fraction * TRACK_WIDTH })
  await nextTick()
}

describe('vpTimeline thumbnail previews', () => {
  it('picks the sprite slice that covers the hovered time', async () => {
    const { wrapper, track } = mountTimeline()

    await hover(track, 0.05) // 3s → first cue
    expect(wrapper.find('.vp-thumbnail-sprite').attributes('style')).toContain(
      'background-position: 0px 0px',
    )

    await hover(track, 0.25) // 15s → second cue
    expect(wrapper.find('.vp-thumbnail-sprite').attributes('style')).toContain(
      'background-position: -160px 0px',
    )

    await hover(track, 0.5) // 30s → third cue
    expect(wrapper.find('.vp-thumbnail-sprite').attributes('style')).toContain(
      'background-position: -320px 0px',
    )

    wrapper.unmount()
  })

  it('shows the chapter that belongs to the same moment as the thumbnail', async () => {
    const { wrapper, track } = mountTimeline()

    await hover(track, 0.4) // 24s → cue 3, chapter "Middle"
    expect(wrapper.find('.vp-tooltip-chapter').text()).toBe('Middle')
    expect(wrapper.find('.vp-thumbnail-sprite').attributes('style')).toContain(
      'background-position: -320px 0px',
    )

    await hover(track, 0.9) // 54s → cue 4, chapter "Outro"
    expect(wrapper.find('.vp-tooltip-chapter').text()).toBe('Outro')
    expect(wrapper.find('.vp-thumbnail-sprite').attributes('style')).toContain(
      'background-position: -480px 0px',
    )

    wrapper.unmount()
  })

  it('drops the preview but keeps time and chapter outside the manifest range', async () => {
    const { wrapper, track } = mountTimeline({ duration: 120 })

    // 90s of a 120s video — past the last cue (60s) but inside "Outro".
    await hover(track, 0.75)

    expect(wrapper.find('.vp-thumbnail-preview').exists()).toBe(false)
    expect(wrapper.find('.vp-tooltip-chapter').text()).toBe('Outro')
    expect(wrapper.find('.vp-timeline-tooltip').text()).toContain('1:30')
  })

  it('shows no preview at all when the manifest is empty', async () => {
    const { wrapper, track } = mountTimeline({ cues: [] })

    await hover(track, 0.5)

    expect(wrapper.find('.vp-thumbnail-preview').exists()).toBe(false)
    expect(wrapper.find('.vp-tooltip-chapter').text()).toBe('Middle')

    wrapper.unmount()
  })

  it('keeps the timeline interactive while no thumbnail data exists', async () => {
    const { wrapper, root } = mountTimeline({ cues: [] })

    await root.trigger('pointerdown', { clientX: 0.5 * TRACK_WIDTH })
    await nextTick()
    window.dispatchEvent(new PointerEvent('pointerup', { clientX: 0.5 * TRACK_WIDTH }))
    await nextTick()

    const seeks = wrapper.emitted('seek')
    expect(seeks).toBeTruthy()
    expect(seeks![0][0]).toBeCloseTo(30, 5)

    wrapper.unmount()
  })

  it('uses plain <img> for cues without xywh metadata', async () => {
    const { wrapper, track } = mountTimeline({
      cues: [{ start: 0, end: 60, url: '/frame.jpg' }],
    })

    await hover(track, 0.5)

    const img = wrapper.find('.vp-thumbnail-img')
    expect(img.exists()).toBe(true)
    expect(img.attributes('src')).toBe('/frame.jpg')
    expect(wrapper.find('.vp-thumbnail-sprite').exists()).toBe(false)

    wrapper.unmount()
  })

  it('matches cues against real duration, not a fixed scale', async () => {
    // Same cue list, but the video's real duration is 30s, so the first half of
    // the track covers 0–15s (cue 2) and the last third covers 20–30s (cue 3).
    const { wrapper, track } = mountTimeline({ duration: 30 })

    await hover(track, 0.5) // 15s → cue 2
    expect(wrapper.find('.vp-thumbnail-sprite').attributes('style')).toContain(
      'background-position: -160px 0px',
    )

    await hover(track, 0.8) // 24s → cue 3
    expect(wrapper.find('.vp-thumbnail-sprite').attributes('style')).toContain(
      'background-position: -320px 0px',
    )

    wrapper.unmount()
  })

  it('ignores stale cues when the prop swaps to a new manifest', async () => {
    const { wrapper, track } = mountTimeline()

    await hover(track, 0.5)
    expect(wrapper.find('.vp-thumbnail-sprite').attributes('style')).toContain(
      'background-position',
    )

    // Simulate a source switch: the parent replaces the manifest.
    await wrapper.setProps({ thumbnailCues: [] })
    await nextTick()

    expect(wrapper.find('.vp-thumbnail-preview').exists()).toBe(false)

    await wrapper.setProps({
      thumbnailCues: [{ start: 0, end: 60, url: 'new.png', x: 640, y: 0, w: 160, h: 90 }],
    })
    await hover(track, 0.5)

    expect(wrapper.find('.vp-thumbnail-sprite').attributes('style')).toContain(
      'background-position: -640px 0px',
    )

    wrapper.unmount()
  })
})

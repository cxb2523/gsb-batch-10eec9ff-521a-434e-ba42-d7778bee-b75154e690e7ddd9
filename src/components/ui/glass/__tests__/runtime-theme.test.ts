import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { GlassViewHandle, GlassViewSpec } from '../runtime'
import type { LensState } from '../physics'

// three/webgpu and three/tsl need a real GPU and shader compiler; the stubs keep the
// runtime's own state machine (the code under test) fully exercised.
vi.mock('three/webgpu', () => import('./three-webgpu-stub'))
vi.mock('three/tsl', () => import('./three-tsl-stub'))

import { flushFrames, observerFor, setMedia } from './setup'
import { __resetGlassRuntimeForTests, getGlassRuntime } from '../runtime'

const LENS: LensState = {
  x: 50,
  y: 50,
  hx: 40,
  hy: 30,
  radius: 20,
  bevel: 6,
  refract: 10,
  mag: 0.1,
  disp: 0.2,
  blurCenter: 0.3,
  blurEdge: 2,
  frost: 0,
  rim: 0.5,
  caustic: 0.08,
  inner: 0.1,
  topRefl: 0.3,
  shadowOpacity: 0.1,
  shadowSoftness: 34,
  shadowOffset: 22,
  stretchX: 1,
  stretchY: 1,
  shiftX: 0,
}

const LOW_POWER = '(pointer: coarse), (max-width: 767px)'

/** Lets queued MutationObserver records be delivered (jsdom dispatches them as tasks). */
const flushMutations = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

/** Total layer texture upload requests recorded for one view handle. */
function uploads(handle: GlassViewHandle) {
  const s = handle.stats()
  return (s.bgUploads ?? 0) + (s.fgUploads ?? 0)
}

async function makeHarness() {
  const host = document.createElement('div')
  host.setAttribute('data-theme', 'light')
  const canvas = document.createElement('canvas')
  host.appendChild(canvas)
  document.body.appendChild(host)

  const draws: string[] = []
  const surfaces: string[] = []
  const spec: GlassViewSpec = {
    width: 100,
    height: 80,
    unit: 1,
    // No real GPU in jsdom: the blank-pixel retry has nothing to verify.
    skipFirstFrameVerify: true,
    draw: (_bg, _fg, _tokens, theme) => {
      draws.push(theme)
      return LENS
    },
  }

  const runtime = await getGlassRuntime()
  const getSurface = vi.spyOn(window, 'getComputedStyle')
  const originalGetComputedStyle = getSurface.getMockImplementation()!
  getSurface.mockImplementation((el: Element) => {
    const style = originalGetComputedStyle(el)
    const value = style.getPropertyValue('--glass-surface')
    if (value) surfaces.push(value)
    return style
  })

  return { host, canvas, spec, draws, surfaces, runtime }
}

async function createView(harness: Awaited<ReturnType<typeof makeHarness>>) {
  const handle = await harness.runtime.createView(harness.canvas, () => harness.spec)
  await flushFrames(2)
  return handle
}

function setTheme(host: HTMLElement, theme: 'light' | 'dark') {
  host.setAttribute('data-theme', theme)
}

beforeEach(() => {
  document.body.innerHTML = ''
  // Default: capable device, no motion preference.
  setMedia(LOW_POWER, false)
  setMedia('(prefers-reduced-motion: reduce)', false)
})

afterEach(() => {
  // Drop the singleton (its views, observers and rAF loop) so cases never share state.
  __resetGlassRuntimeForTests()
  vi.restoreAllMocks()
})

describe('shared glass renderer: theme propagation', () => {
  it('path 1 — normal switch repaints an on-screen view once at the new theme and refreshes --glass-surface', async () => {
    const h = await makeHarness()
    const handle = await createView(h)
    expect(h.draws).toEqual(['light'])
    const uploadsAfterFirstPaint = uploads(handle) // two layers, one upload each

    setTheme(h.host, 'dark')
    await flushMutations()
    await flushFrames(2)

    expect(h.draws.at(-1)).toBe('dark')
    expect(h.surfaces.at(-1)).toBe('#17181c')
    // Exactly one additional full repaint: one extra upload per layer, nothing more.
    expect(uploads(handle)).toBe(uploadsAfterFirstPaint + 2)
    expect(handle.stats().renders).toBe(2)
  })

  it('path 2 — rapid consecutive switches within a frame coalesce to one render of the final theme', async () => {
    const h = await makeHarness()
    const handle = await createView(h)
    const rendersAfterFirstPaint = h.draws.length

    setTheme(h.host, 'dark')
    setTheme(h.host, 'light')
    setTheme(h.host, 'dark')
    await flushMutations()
    await flushFrames(2)

    // Only one extra repaint happened, and it carries the last theme — no intermediate
    // light/dark frames, so no duplicated layer redraws or texture uploads.
    expect(h.draws.length).toBe(rendersAfterFirstPaint + 1)
    expect(h.draws.at(-1)).toBe('dark')
    expect(handle.stats().renders).toBe(2)
    expect(uploads(handle)).toBe(4)
  })

  it('path 3 — off-screen views only get marked dirty, then repaint at the current theme when they scroll back', async () => {
    const h = await makeHarness()
    const handle = await createView(h)
    const io = observerFor(h.canvas)

    // Scroll the control out of the viewport.
    io.setVisible(h.canvas, false)
    await flushFrames(1)
    const drawsWhileVisible = h.draws.length

    setTheme(h.host, 'dark')
    await flushMutations()
    await flushFrames(2)

    // No GPU work while off-screen: the old light layers stay untouched.
    expect(h.draws.length).toBe(drawsWhileVisible)
    expect(h.draws.at(-1)).toBe('light')
    expect(handle.stats().renders).toBe(1)
    expect(uploads(handle)).toBe(2)

    // Scroll back: a single repaint at the theme that is current now, surface re-read.
    io.setVisible(h.canvas, true)
    await flushFrames(2)
    expect(h.draws.length).toBe(drawsWhileVisible + 1)
    expect(h.draws.at(-1)).toBe('dark')
    expect(h.surfaces.at(-1)).toBe('#17181c')
    expect(handle.stats().renders).toBe(2)
  })

  it('path 4 — low-power devices skip off-screen theme queuing and still catch up on re-entry', async () => {
    setMedia(LOW_POWER, true)
    const h = await makeHarness()
    const handle = await createView(h)
    const io = observerFor(h.canvas)

    io.setVisible(h.canvas, false)
    await flushFrames(1)
    const drawsWhileVisible = h.draws.length

    setTheme(h.host, 'dark')
    await flushMutations()
    await flushFrames(2)
    expect(h.draws.length).toBe(drawsWhileVisible)
    expect(handle.stats().renders).toBe(1)

    // Re-entry works without any queued theme mark: render() re-reads the live DOM theme.
    io.setVisible(h.canvas, true)
    await flushFrames(2)
    expect(h.draws.at(-1)).toBe('dark')
    expect(h.surfaces.at(-1)).toBe('#17181c')
    expect(handle.stats().renders).toBe(2)
  })

  it('layer rebuilds from a DPR change re-read the current theme and --glass-surface instead of cached colors', async () => {
    const h = await makeHarness()
    const handle = await createView(h)

    setTheme(h.host, 'dark')
    await flushMutations()
    await flushFrames(2)
    expect(h.draws.at(-1)).toBe('dark')
    const rendersAtDark = handle.stats().renders

    // Zooming changes devicePixelRatio: layers are disposed and rebuilt. The rebuilt
    // textures must be painted dark, not re-uploaded with the cached light surface.
    const dprSpy = vi.spyOn(window, 'devicePixelRatio', 'get').mockReturnValue(1.5)
    window.dispatchEvent(new Event('resize'))
    await flushFrames(2)


    expect(h.draws.at(-1)).toBe('dark')
    expect(h.surfaces.at(-1)).toBe('#17181c')
    expect(handle.stats().renders).toBe(rendersAtDark + 1)
    dprSpy.mockRestore()
    handle.dispose()
  })

  it('prefers-reduced-motion keeps the same theme behavior', async () => {
    setMedia('(prefers-reduced-motion: reduce)', true)
    const h = await makeHarness()
    const handle = await createView(h)

    setTheme(h.host, 'dark')
    await flushMutations()
    await flushFrames(2)
    expect(h.draws.at(-1)).toBe('dark')
    expect(h.surfaces.at(-1)).toBe('#17181c')
    expect(handle.stats().renders).toBe(2)
  })

  it('an off-screen view performs no GPU render pass or texture upload after a theme switch', async () => {
    const h = await makeHarness()
    const handle = await createView(h)
    const io = observerFor(h.canvas)

    io.setVisible(h.canvas, false)
    await flushFrames(1)
    const drawsOffscreen = h.draws.length
    const uploadsOffscreen = uploads(handle)

    setTheme(h.host, 'dark')
    await flushMutations()
    await flushFrames(3)
    // Flat counters mean neither a layer redraw, a texture upload nor a render happened.
    expect(h.draws.length).toBe(drawsOffscreen)
    expect(uploads(handle)).toBe(uploadsOffscreen)
    expect(handle.stats().renders).toBe(1)

    io.setVisible(h.canvas, true)
    await flushFrames(2)
    expect(h.draws.length).toBe(drawsOffscreen + 1)
    expect(uploads(handle)).toBeGreaterThan(uploadsOffscreen)
    expect(handle.stats().renders).toBe(2)
  })
})

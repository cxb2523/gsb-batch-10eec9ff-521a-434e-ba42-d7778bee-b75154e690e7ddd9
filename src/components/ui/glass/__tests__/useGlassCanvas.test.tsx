import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { useGlassCanvas } from '../useGlassCanvas'

// vi.hoisted runs before imports so the vi.mock factory below can reference these fns
// (a plain top-level const would be in the temporal dead zone when the factory executes).
const mocks = vi.hoisted(() => ({
  createView: vi.fn(),
  themeChanged: vi.fn(),
  invalidate: vi.fn(),
  dispose: vi.fn(),
}))
const { createView, themeChanged, invalidate, dispose } = mocks

// The hook only owns registration bookkeeping; the WebGL runtime is mocked so the test
// stays on plain DOM and can observe which handle method each React render selects.
vi.mock('../runtime', () => ({
  getGlassRuntime: () => ({
    createView: (...args: unknown[]) => mocks.createView(...args),
  }),
}))

function Probe({ theme }: { theme: 'light' | 'dark' }) {
  const { canvasRef } = useGlassCanvas({
    width: 10,
    height: 10,
    unit: 1,
    draw: () => ({
      x: 1,
      y: 1,
      hx: 1,
      hy: 1,
      radius: 1,
      bevel: 1,
      refract: 0,
      mag: 0,
      disp: 0,
      blurCenter: 0,
      blurEdge: 1,
      frost: 0,
      rim: 0,
      caustic: 0,
      inner: 0,
      topRefl: 0,
      shadowOpacity: 0,
      shadowSoftness: 0,
      shadowOffset: 0,
      stretchX: 1,
      stretchY: 1,
      shiftX: 0,
    }),
  })
  return <canvas ref={canvasRef} data-theme={theme} />
}

beforeEach(() => {
  createView.mockReset()
  themeChanged.mockReset()
  invalidate.mockReset()
  dispose.mockReset()
  createView.mockResolvedValue({ themeChanged, invalidate, dispose, stats: () => ({ renders: 0, ms: 0 }) })
  document.body.innerHTML = ''
})

/** Flush the dynamic import() + promise chain the hook uses to register the view. */
const flushRegistration = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve()
  await act(async () => {})
}

describe('useGlassCanvas registration', () => {
  it('routes a theme-prop change through themeChanged instead of a blanket invalidate', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)

    await act(async () => root.render(<Probe theme="light" />))
    await flushRegistration()
    expect(createView).toHaveBeenCalledTimes(1)
    // At mount the registration effect's createView promise resolves after the generic
    // repaint effect runs, so the first invalidate lands on a null handle — harmless, since
    // a freshly created view starts dirty:true. Re-renders are what the routing below tests.

    invalidate.mockClear()
    themeChanged.mockClear()
    await act(async () => root.render(<Probe theme="dark" />))

    expect(themeChanged).toHaveBeenCalledTimes(1)
    expect(invalidate).not.toHaveBeenCalled()

    // Unrelated re-renders keep the ordinary repaint path.
    themeChanged.mockClear()
    invalidate.mockClear()
    await act(async () => root.render(<Probe theme="dark" />))
    expect(invalidate).toHaveBeenCalled()
    expect(themeChanged).not.toHaveBeenCalled()

    act(() => root.unmount())
    expect(dispose).toHaveBeenCalledTimes(1)
  })
})

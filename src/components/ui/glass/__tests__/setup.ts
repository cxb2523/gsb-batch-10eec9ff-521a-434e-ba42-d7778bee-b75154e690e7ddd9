import { vi } from 'vitest'

// React 19 only flushes effects inside act() when this global flag is set.
;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true

/**
 * Deterministic, manually-driven browser environment for the glass runtime tests.
 * rAF callbacks queue instead of self-scheduling, media queries and the
 * IntersectionObserver are driven by the test, and getComputedStyle reports the
 * --glass-surface of the current data-theme.
 */

type Raf = (time: number) => void
const frameQueue: Raf[] = []
let frameTime = 0

window.requestAnimationFrame = vi.fn((cb: FrameRequestCallback) => {
  frameQueue.push((time) => cb(time))
  return frameQueue.length
}) as typeof window.requestAnimationFrame
window.cancelAnimationFrame = vi.fn((handle: number) => {
  delete frameQueue[handle - 1]
}) as typeof window.cancelAnimationFrame

/** Runs every rAF callback queued so far (one "frame"); new callbacks wait for the next. */
export async function flushFrames(count = 1) {
  for (let i = 0; i < count; i++) {
    frameTime += 16.7
    const due = frameQueue.splice(0, frameQueue.length)
    for (const cb of due) cb(frameTime)
    await Promise.resolve()
  }
}

type MediaListener = (event: { matches: boolean }) => void
const mediaStates = new Map<string, boolean>()
const mediaListeners: Record<string, Set<MediaListener>> = {}

export function setMedia(query: string, matches: boolean) {
  mediaStates.set(query, matches)
  for (const listener of mediaListeners[query] ?? []) listener({ matches })
}

window.matchMedia = vi.fn((query: string) => {
  if (!mediaStates.has(query)) mediaStates.set(query, false)
  const mql = {
    media: query,
    onchange: null,
    addEventListener: (_: string, listener: MediaListener) => {
      ;(mediaListeners[query] ??= new Set()).add(listener)
    },
    removeEventListener: (_: string, listener: MediaListener) => {
      mediaListeners[query]?.delete(listener)
    },
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  }
  Object.defineProperty(mql, 'matches', {
    get: () => mediaStates.get(query) ?? false,
  })
  return mql as unknown as MediaQueryList
}) as typeof window.matchMedia

type IoCallback = (entries: IntersectionObserverEntry[], observer: IntersectionObserver) => void
const ioObservers: FakeIntersectionObserver[] = []

export class FakeIntersectionObserver {
  private elements = new Map<Element, { target: Element; visible: boolean }>()
  constructor(private callback: IoCallback) {
    ioObservers.push(this)
  }
  observe(target: Element) {
    this.elements.set(target, { target, visible: true })
  }
  unobserve(target: Element) {
    this.elements.delete(target)
  }
  disconnect() {
    this.elements.clear()
  }
  has(target: Element) {
    return this.elements.has(target)
  }
  /** Test helper: flip one observed element and deliver the entry. */
  setVisible(target: Element, visible: boolean) {
    const state = this.elements.get(target)
    if (!state || state.visible === visible) return
    state.visible = visible
    this.callback(
      [{ target, isIntersecting: visible } as IntersectionObserverEntry],
      this as unknown as IntersectionObserver,
    )
  }
}
window.IntersectionObserver = FakeIntersectionObserver as unknown as typeof IntersectionObserver

export function observerFor(target: Element): FakeIntersectionObserver {
  const found = ioObservers.find((o) => o.has(target))
  if (!found) throw new Error('no IntersectionObserver registered for target')
  return found
}

/** --glass-surface follows the nearest data-theme ancestor, like styles.css. */
const surfaceByTheme: Record<string, string> = {
  light: '#dedfe2',
  dark: '#17181c',
}
window.getComputedStyle = vi.fn((el: Element) => {
  const themed = el.closest?.('[data-theme]')
  const theme = themed?.getAttribute('data-theme') === 'dark' ? 'dark' : 'light'
  return {
    getPropertyValue: (name: string) => (name === '--glass-surface' ? surfaceByTheme[theme] : ''),
  } as CSSStyleDeclaration
}) as typeof window.getComputedStyle

// jsdom without the native `canvas` package exposes no 2D context at all. The runtime
// only needs a context object whose methods exist and can be spied on, so install a
// minimal class and make every canvas hand out per-instance instances of it.
class FakeCanvasRenderingContext2D {
  setTransform() {}
  clearRect() {}
  drawImage() {}
  save() {}
  restore() {}
  translate() {}
  beginPath() {}
  moveTo() {}
  lineTo() {}
  arc() {}
  fill() {}
  fillRect() {}
  fillText() {}
  stroke() {}
  roundRect() {}
  getImageData() {
    return { data: [0, 0, 0, 255] }
  }
}
;(globalThis as Record<string, unknown>).CanvasRenderingContext2D = FakeCanvasRenderingContext2D
HTMLCanvasElement.prototype.getContext = vi.fn(function (this: HTMLCanvasElement) {
  return new FakeCanvasRenderingContext2D()
}) as unknown as typeof HTMLCanvasElement.prototype.getContext

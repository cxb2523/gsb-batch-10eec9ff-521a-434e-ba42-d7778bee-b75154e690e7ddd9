import { useCallback, useEffect, useRef } from 'react'

import type { GlassViewHandle, GlassViewSpec, GlassViewStats } from './runtime'

/** Reads the theme the shared renderer would resolve for this canvas. */
function themeAt(canvas: HTMLCanvasElement) {
  return canvas.closest('[data-theme]')?.getAttribute('data-theme') === 'dark' ? 'dark' : 'light'
}

/**
 * Registers a canvas with the shared glass renderer. The spec is read fresh every
 * frame, so callers keep animation state in refs and simply return a new spec.
 */
export function useGlassCanvas(spec: GlassViewSpec) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const specRef = useRef(spec)
  specRef.current = spec
  const handle = useRef<GlassViewHandle | null>(null)
  // Last data-theme we saw on an ancestor. Theme changes must not go through plain
  // invalidate(): off-screen views should only be queued (and skipped entirely on
  // low-power devices) rather than being marked for an immediate repaint they cannot do.
  const lastTheme = useRef<string | null>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    let disposed = false
    // three.js loads lazily so the page still prerenders on the server.
    import('./runtime')
      .then(({ getGlassRuntime }) => getGlassRuntime())
      .then((runtime) => runtime.createView(canvas, () => specRef.current))
      .then((view) => {
        if (disposed) view.dispose()
        else {
          handle.current = view
          lastTheme.current = themeAt(canvas)
        }
      })
      .catch((error) => console.warn('Liquid glass renderer unavailable', error))
    return () => {
      disposed = true
      handle.current?.dispose()
      handle.current = null
      lastTheme.current = null
    }
  }, [])

  // Any React render (new props, size, …) repaints once — unless the only thing that
  // changed is the nearest data-theme ancestor, which takes the deferred theme path.
  useEffect(() => {
    const canvas = canvasRef.current
    const view = handle.current
    if (!canvas || !view) return
    const theme = themeAt(canvas)
    if (lastTheme.current !== null && theme !== lastTheme.current) {
      // On-screen: repaint now at the new theme. Off-screen: just remember it (nothing is
      // queued on low-power devices); the IntersectionObserver catches the view up on return.
      lastTheme.current = theme
      view.themeChanged()
    } else {
      lastTheme.current = theme
      view.invalidate()
    }
  })

  const invalidate = useCallback(() => handle.current?.invalidate(), [])
  /** Running totals of GPU passes for this canvas (zero until the renderer is up). */
  const stats = useCallback((): GlassViewStats => handle.current?.stats() ?? { renders: 0, ms: 0 }, [])
  return { canvasRef, invalidate, stats }
}

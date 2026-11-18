// Minimal CanvasRenderingContext2D stub: GameWorld only draws, it never reads
// back pixels, so no-op methods plus a gradient object are enough for headless tests.
export function createStubCtx(): CanvasRenderingContext2D {
  const gradient = { addColorStop: () => undefined };
  const ctx = {
    canvas: { width: 640, height: 360 },
    imageSmoothingEnabled: false,
    clearRect: () => undefined,
    fillRect: () => undefined,
    strokeRect: () => undefined,
    save: () => undefined,
    restore: () => undefined,
    translate: () => undefined,
    scale: () => undefined,
    fill: () => undefined,
    beginPath: () => undefined,
    closePath: () => undefined,
    moveTo: () => undefined,
    lineTo: () => undefined,
    createLinearGradient: () => gradient,
  };
  return ctx as unknown as CanvasRenderingContext2D;
}

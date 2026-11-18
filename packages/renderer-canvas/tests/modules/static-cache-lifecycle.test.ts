import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CoordinateTransformer, type ICamera, type Rect } from "@canvas-tile-engine/core";
import { canvas2dClipAdapter, CanvasDraw } from "@canvas-tile-engine/renderer-shared/canvas2d";
import { DrawContext, Layer } from "@canvas-tile-engine/renderer-shared/scene";
import {
    createBrowserCanvasDraw,
    type BrowserContext2D,
    type BrowserOffscreenCanvas,
} from "../../src/modules/createCanvasDraw";

// Static caches must stay consistent with three pieces of state that can
// change after registration: the renderer's pixel ratio, the cache key's
// ownership, and the registration's clip. These drive the shared Canvas2D
// pipeline through the browser factory with a recording offscreen, so every
// recording and blit is observable — including the ones a real browser would
// silently composite away.

type Call = { name: string; args: unknown[] };

/** A 2D context that records method calls and keeps assigned properties. */
function recordingContext() {
    const calls: Call[] = [];
    const props = new Map<PropertyKey, unknown>();
    const ctx = new Proxy({} as Record<PropertyKey, unknown>, {
        get(_target, key) {
            if (key === "calls") {
                return calls;
            }
            if (props.has(key)) {
                return props.get(key);
            }
            // Leave optional members (roundRect, measureText, canvas) absent.
            if (key === "roundRect" || key === "measureText" || key === "canvas" || key === "then") {
                return undefined;
            }
            return (...args: unknown[]) => {
                calls.push({ name: String(key), args });
            };
        },
        set(_target, key, value) {
            props.set(key, value);
            return true;
        },
    });
    return ctx as unknown as BrowserContext2D & { calls: Call[] };
}

/**
 * Stands in for OffscreenCanvas. `failContexts` makes `getContext` return
 * null, which is how the browser factory reports "no offscreen surface" — the
 * same path a platform without 2D context support takes. `created` holds only
 * the canvases that actually got a context, so it is exactly the set of usable
 * bitmaps the pipeline allocated.
 */
class FakeOffscreenCanvas {
    static created: FakeOffscreenCanvas[] = [];
    static attempts = 0;
    static failContexts = false;
    readonly ctx = recordingContext();
    constructor(
        public width: number,
        public height: number,
    ) {}
    getContext() {
        FakeOffscreenCanvas.attempts++;
        if (FakeOffscreenCanvas.failContexts) {
            return null;
        }
        FakeOffscreenCanvas.created.push(this);
        return this.ctx;
    }
}

const rect: Rect = { x: 0, y: 0, size: 10, style: { fillStyle: "#ff0000" } };

/** Blit rects are float math; compare them up to rounding noise. */
function expectNear(actual: unknown[], expected: number[]) {
    expect(actual).toHaveLength(expected.length);
    expected.forEach((value, i) => expect(actual[i] as number).toBeCloseTo(value, 9));
}

type MutableCamera = { x: number; y: number; scale: number };

function setup(options: { ratio?: () => number; noOffscreen?: boolean } = {}) {
    const camera: MutableCamera = { x: -4.5, y: -4.5, scale: 10 };
    const transformer = new CoordinateTransformer(camera as unknown as ICamera);
    const layers = new Layer<DrawContext<BrowserContext2D>>(canvas2dClipAdapter<BrowserContext2D>());
    const pixelRatio = options.ratio ?? (() => 1);
    const draw = options.noOffscreen
        ? new CanvasDraw<BrowserContext2D, HTMLImageElement, BrowserOffscreenCanvas>(
              layers,
              transformer,
              camera as unknown as ICamera,
              null,
              pixelRatio,
          )
        : createBrowserCanvasDraw(layers, transformer, camera as unknown as ICamera, pixelRatio);

    /**
     * Draw one frame. `topLeft` is where the renderer's camera sits, and the
     * camera is moved to match, exactly as `RendererCanvas.render` does.
     */
    const render = (topLeft: { x: number; y: number } = camera) => {
        camera.x = topLeft.x;
        camera.y = topLeft.y;
        const ctx = recordingContext();
        layers.drawAll({
            ctx,
            camera: camera as unknown as ICamera,
            transformer,
            config: { size: { width: 100, height: 100 }, scale: camera.scale } as never,
            topLeft,
        });
        return ctx;
    };
    const blits = (ctx: { calls: Call[] }) => ctx.calls.filter((call) => call.name === "drawImage");
    return { draw, render, blits, camera, transformer };
}

/** The screen rect a world rectangle covers, the same math the clip adapter uses. */
function clipRect(
    transformer: CoordinateTransformer,
    clip: { minX: number; maxX: number; minY: number; maxY: number },
) {
    const topLeft = transformer.worldToScreen(clip.minX, clip.minY);
    const bottomRight = transformer.worldToScreen(clip.maxX, clip.maxY);
    return [topLeft.x, topLeft.y, bottomRight.x - topLeft.x, bottomRight.y - topLeft.y];
}

function findRectCall(ctx: { calls: Call[] }, expected: number[]) {
    return ctx.calls.find(
        (call) =>
            call.name === "rect" &&
            call.args.length === expected.length &&
            expected.every((value, i) => Math.abs((call.args[i] as number) - value) < 1e-9),
    );
}

beforeEach(() => {
    FakeOffscreenCanvas.created = [];
    FakeOffscreenCanvas.attempts = 0;
    FakeOffscreenCanvas.failContexts = false;
    vi.stubGlobal("OffscreenCanvas", FakeOffscreenCanvas);
    vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

describe("static cache registration lifetime", () => {
    it("replaces the bitmap when a cacheKey is registered again without removing the old handle", () => {
        const { draw, render, blits } = setup();
        draw.drawStaticRect([{ ...rect, style: { fillStyle: "#ff0000" } }], "k");
        draw.drawStaticRect([{ ...rect, style: { fillStyle: "#0000ff" } }], "k");

        const frame = render();
        const blitsThisFrame = blits(frame);

        // Exactly one layer draws, and it is the bitmap recorded last.
        expect(blitsThisFrame).toHaveLength(1);
        expect(FakeOffscreenCanvas.created).toHaveLength(2);
        expect(blitsThisFrame[0].args[0]).toBe(FakeOffscreenCanvas.created[1]);
        expect(FakeOffscreenCanvas.created[1].ctx.fillStyle).toBe("#0000ff");
    });

    it("stops the replaced layer from painting its old bitmap anywhere", () => {
        const { draw, render, blits } = setup();
        // The first registration is in view; the replacement is far outside it.
        draw.drawStaticRect([{ ...rect, size: 4 }], "k");
        expect(blits(render())).toHaveLength(1);

        draw.drawStaticRect([{ ...rect, x: 100, size: 4 }], "k");
        const frame = render();

        expect(blits(frame)).toHaveLength(0);
    });

    it("keeps the replacement's clip when the same key is registered again", () => {
        const { draw, render, blits, transformer } = setup();
        const clip = { minX: -2, maxX: 2, minY: -2, maxY: 2 };
        draw.drawStaticRect([rect], "k", 1, { clip });
        draw.drawStaticRect([{ ...rect, size: 20 }], "k", 1, { clip });

        const frame = render();

        // The clip is applied from the current world->screen transform. A
        // superseded layer emits its clip path before its callback bails out,
        // so look for the expected rectangle among the calls.
        expect(findRectCall(frame, clipRect(transformer, clip))).toBeDefined();
        expect(blits(frame)).toHaveLength(1);
    });

    it("lets a fallback registration take over a key from a cached one", () => {
        const { draw, render, blits } = setup();
        draw.drawStaticRect([rect], "k");
        expect(blits(render())).toHaveLength(1);

        // The new registration cannot be cached: it must replace the old
        // bitmap with a dynamic layer, not sit underneath it.
        FakeOffscreenCanvas.failContexts = true;
        draw.drawStaticRect([{ ...rect, size: 1 }], "k");
        const frame = render();

        expect(blits(frame)).toHaveLength(0);
        // The dynamic replacement paints a 1-world-unit box, 10 CSS px, at the
        // origin cell's screen position for this pan.
        expect(findRectCall(frame, [45, 45, 10, 10])).toBeDefined();
    });

    it("keeps blitting the captured bitmap after clearStaticCache", () => {
        const { draw, render, blits } = setup();
        draw.drawStaticRect([rect], "k");
        expect(blits(render())).toHaveLength(1);

        // Drop only the stored reference: the registered layer still owns its
        // bitmap, which is the documented `clearStaticCache` contract.
        draw.clearStaticCache("k");
        expect(blits(render())).toHaveLength(1);
        expect(FakeOffscreenCanvas.created).toHaveLength(1);
    });

    it("supersedes the old layer even when clearStaticCache ran first", () => {
        const { draw, render, blits } = setup();
        draw.drawStaticRect([{ ...rect, style: { fillStyle: "#ff0000" } }], "k");
        render();

        // Clearing only drops the stored reference, so ownership must not live
        // in that map: registering again has to disown the first layer anyway.
        draw.clearStaticCache("k");
        draw.drawStaticRect([{ ...rect, style: { fillStyle: "#0000ff" } }], "k");
        const frame = render();

        expect(blits(frame)).toHaveLength(1);
        expect(blits(frame)[0].args[0]).toBe(FakeOffscreenCanvas.created[1]);
        expect(FakeOffscreenCanvas.created[1].ctx.fillStyle).toBe("#0000ff");
    });
});

describe("static cache pixel ratio changes", () => {
    it("re-records once at the new ratio and blits the fresh bitmap", () => {
        let ratio = 1;
        const { draw, render, blits } = setup({ ratio: () => ratio });
        draw.drawStaticRect([{ ...rect, style: { fillStyle: "#00ff00" } }], "k");
        expectNear(blits(render())[0].args.slice(1, 5), [1, 1, 100, 100]);

        ratio = 2;
        const frame = render();

        expect(FakeOffscreenCanvas.created.map((canvas) => canvas.width)).toEqual([102, 202]);
        const blitsThisFrame = blits(frame);
        expect(blitsThisFrame).toHaveLength(1);
        expect(blitsThisFrame[0].args[0]).toBe(FakeOffscreenCanvas.created[1]);
        expectNear(blitsThisFrame[0].args.slice(1, 5), [1, 1, 200, 200]);
        // A fresh context, so the per-pass fill memo cannot skip the color.
        expect(FakeOffscreenCanvas.created[1].ctx.fillStyle).toBe("#00ff00");

        // And only once: the next frame replays the same bitmap.
        render();
        expect(FakeOffscreenCanvas.created).toHaveLength(2);
        expect(FakeOffscreenCanvas.attempts).toBe(2);
    });

    it("re-records at the camera scale active when the ratio changed", () => {
        let ratio = 1;
        const { draw, render, camera } = setup({ ratio: () => ratio });
        draw.drawStaticRect([rect], "k");
        render();

        // Zoom to 20 and switch to 2x in the same frame: the re-record uses
        // the current scale, not the 10x bitmap stretched over a 20x canvas.
        camera.scale = 20;
        ratio = 2;
        render();

        // The 10-world-unit extent plus the one-raster-pixel guard each side,
        // at 20 * 2 = 40 cache pixels per world unit.
        expect(FakeOffscreenCanvas.created[1].width).toBe(10 * 20 * 2 + 2);
    });

    it("keeps the old bitmap when a re-record fails and does not retry at that ratio", () => {
        let ratio = 1;
        const { draw, render, blits } = setup({ ratio: () => ratio });
        draw.drawStaticRect([rect], "k");
        expect(blits(render())).toHaveLength(1);

        ratio = 2;
        FakeOffscreenCanvas.failContexts = true;
        const first = render();
        const attemptsAfterFirst = FakeOffscreenCanvas.attempts;

        expect(blits(first)).toHaveLength(1);
        expect(blits(first)[0].args[0]).toBe(FakeOffscreenCanvas.created[0]);

        // Four more frames at the same failing ratio: no further attempts, and
        // the retained bitmap keeps drawing.
        for (let frame = 0; frame < 4; frame++) {
            const next = render();
            expect(blits(next)).toHaveLength(1);
            expect(blits(next)[0].args[0]).toBe(FakeOffscreenCanvas.created[0]);
        }
        expect(FakeOffscreenCanvas.attempts).toBe(attemptsAfterFirst);
    });

    it("retries once the ratio changes again after a failure", () => {
        let ratio = 1;
        const { draw, render, blits } = setup({ ratio: () => ratio });
        draw.drawStaticRect([rect], "k");
        render();
        const attemptsAtOne = FakeOffscreenCanvas.attempts;

        ratio = 2;
        FakeOffscreenCanvas.failContexts = true;
        render();
        expect(FakeOffscreenCanvas.attempts).toBe(attemptsAtOne + 1);

        // A different ratio is a different question: try once more.
        ratio = 3;
        FakeOffscreenCanvas.failContexts = false;
        const frame = render();
        expect(FakeOffscreenCanvas.attempts).toBe(attemptsAtOne + 2);
        expect(FakeOffscreenCanvas.created).toHaveLength(2);
        expect(blits(frame)[0].args[0]).toBe(FakeOffscreenCanvas.created[1]);
        expect(FakeOffscreenCanvas.created[1].width).toBe(10 * 10 * 3 + 2);
    });

    it("keeps the recorded ratio's blit when the ratio returns to it after a failure", () => {
        let ratio = 1;
        const { draw, render, blits } = setup({ ratio: () => ratio });
        draw.drawStaticRect([rect], "k");
        render();

        ratio = 2;
        FakeOffscreenCanvas.failContexts = true;
        render();

        // Back at the recorded ratio: the retained bitmap already matches the
        // canvas, so it is blitted 1:1 and nothing is re-recorded.
        ratio = 1;
        const frame = render();
        expect(FakeOffscreenCanvas.created).toHaveLength(1);
        expectNear(blits(frame)[0].args.slice(1, 5), [1, 1, 100, 100]);
    });
});

describe("static cache clip after re-recording", () => {
    it("re-applies the same world clip with the current transform", () => {
        let ratio = 1;
        const { draw, render, blits, transformer } = setup({ ratio: () => ratio });
        const clip = { minX: -2, maxX: 2, minY: -2, maxY: 2 };
        draw.drawStaticRect([{ ...rect, size: 20 }], "k", 1, { clip });

        const before = render();
        expect(findRectCall(before, clipRect(transformer, clip))).toBeDefined();

        // Switching the ratio re-records the bitmap, but the clip is world
        // space: it must still cut the same region through the transform
        // active at paint time.
        ratio = 2;
        const after = render();
        expect(findRectCall(after, clipRect(transformer, clip))).toBeDefined();
        expect(blits(after)).toHaveLength(1);

        // And it follows a pan rather than staying pinned to the first frame.
        const panned = render({ x: -3.5, y: -4.5 });
        expect(findRectCall(panned, clipRect(transformer, clip))).toBeDefined();
    });

    it("clips a re-recorded cache even when the ratio drops back", () => {
        let ratio = 2;
        const { draw, render, transformer } = setup({ ratio: () => ratio });
        const clip = { minX: -1, maxX: 1, minY: -1, maxY: 1 };
        draw.drawStaticRect([{ ...rect, size: 20 }], "k", 1, { clip });
        render();

        ratio = 1;
        const frame = render();
        expect(findRectCall(frame, clipRect(transformer, clip))).toBeDefined();
    });
});

describe("static cache disabled fallback", () => {
    it("draws dynamically with world sizes and allocates no offscreen when the platform has none", () => {
        const { draw, render } = setup({ noOffscreen: true, ratio: () => 2 });

        // `sizePx` is a dynamic-path opt-in; the static contract is world
        // sizes, and the fallback must keep that even at a non-1 ratio.
        const item = { x: 0, y: 0, size: 1, sizePx: 60, style: { fillStyle: "#ff0000" } } as Rect;
        draw.drawStaticRect([item], "k");
        const frame = render();

        // A 1-world-unit box at scale 10 is 10 CSS px, ignoring sizePx. The
        // viewport is panned to -4.5, so the cell at the origin sits at 45.
        expect(findRectCall(frame, [45, 45, 10, 10])).toBeDefined();
        expect(frame.calls.some((call) => call.name === "drawImage")).toBe(false);
        expect(FakeOffscreenCanvas.created).toHaveLength(0);
        expect(item.sizePx).toBe(60);
    });

    it("falls back to world sizing when the bitmap is too large at every ratio", () => {
        const { draw, render } = setup({ ratio: () => 2 });

        // 3000 world units at scale 10 is 30000 CSS px: over the 16384 px side
        // cap even at ratio 1, so it cannot be cached at any ratio.
        const item = { x: 0, y: 0, size: 3000, sizePx: 60, style: { fillStyle: "#ff0000" } } as Rect;
        draw.drawStaticRect([item], "k");

        expect(FakeOffscreenCanvas.created).toHaveLength(0);
        const frame = render();
        // World size semantics: a 3000 * 10 px box centered on the origin cell
        // (screen 50 at this pan), not the 60 px `sizePx`.
        expect(findRectCall(frame, [50 - 15000, 50 - 15000, 30000, 30000])).toBeDefined();
        expect(item.sizePx).toBe(60);
    });

    it("draws nothing from a key whose only registration fell back and left the viewport", () => {
        const { draw, render, blits } = setup();
        draw.drawStaticRect([rect], "k");
        expect(blits(render())).toHaveLength(1);

        FakeOffscreenCanvas.failContexts = true;
        // An empty item list cannot be cached either, and it must supersede
        // the previous bitmap rather than leave it on screen.
        draw.drawStaticRect([], "k");

        expect(blits(render())).toHaveLength(0);
    });
});

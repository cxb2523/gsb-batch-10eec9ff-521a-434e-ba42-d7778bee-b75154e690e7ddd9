import { afterEach, describe, expect, it, vi } from "vitest";
import { CoordinateTransformer, type ICamera, type Rect } from "@canvas-tile-engine/core";
import { createCanvas, type Canvas, type SKRSContext2D } from "@napi-rs/canvas";
import { canvas2dClipAdapter, CanvasDraw } from "@canvas-tile-engine/renderer-shared/canvas2d";
import { Layer, type DrawContext } from "@canvas-tile-engine/renderer-shared/scene";

// Exact-pixel checks for the static cache lifecycle on the real @napi-rs raster
// pipeline — the same shared Canvas2D code the browser renderer runs. The
// recording-fake suite in renderer-canvas proves which bitmap is blitted; this
// one proves the composited pixels match a fresh registration at the same
// camera and pixel ratio, including the clip.

vi.setConfig({ testTimeout: 20_000 });

const WIDTH = 160;
const HEIGHT = 160;

/** A camera plus a renderer, so one scenario can drive several frames. */
function setup(pixelRatio: number) {
    const ratio = { value: pixelRatio };
    // A plain mutable camera: ICamera's members are read-only, and these
    // scenarios move the camera between frames the way a user pan/zoom does.
    const camera = { x: -5, y: -5, scale: 10 };
    const transformer = new CoordinateTransformer(camera as unknown as ICamera);
    const layers = new Layer<DrawContext<SKRSContext2D>>(canvas2dClipAdapter<SKRSContext2D>());
    const draw = new CanvasDraw<SKRSContext2D, Canvas, Canvas>(
        layers,
        transformer,
        camera as unknown as ICamera,
        (width, height) => {
            const canvas = createCanvas(width, height);
            return { canvas, ctx: canvas.getContext("2d") };
        },
        () => ratio.value,
    );
    const render = () => {
        const physical = Math.round(WIDTH * ratio.value);
        const canvas = createCanvas(physical, physical);
        const ctx = canvas.getContext("2d");
        ctx.setTransform(ratio.value, 0, 0, ratio.value, 0, 0);
        layers.drawAll({
            ctx,
            camera: camera as unknown as ICamera,
            transformer,
            config: { size: { width: WIDTH, height: HEIGHT }, scale: camera.scale } as never,
            topLeft: { x: camera.x, y: camera.y },
        });
        return ctx.getImageData(0, 0, physical, physical).data;
    };
    return { draw, render, camera, ratio };
}

/** Register the same items on a throwaway renderer at the given camera/ratio. */
function reference(
    items: Rect[],
    camera: { x: number; y: number; scale: number },
    pixelRatio: number,
    clip?: { minX: number; maxX: number; minY: number; maxY: number },
) {
    const scratch = setup(pixelRatio);
    scratch.camera.x = camera.x;
    scratch.camera.y = camera.y;
    scratch.camera.scale = camera.scale;
    scratch.draw.drawStaticRect(items, "reference", 1, clip ? { clip } : undefined);
    return scratch.render();
}

function compare(actual: Uint8ClampedArray, expected: Uint8ClampedArray) {
    let changed = 0;
    let painted = 0;
    for (let i = 0; i < expected.length; i += 4) {
        if (expected[i + 3] !== 0) {
            painted++;
        }
        if (
            actual[i] !== expected[i] ||
            actual[i + 1] !== expected[i + 1] ||
            actual[i + 2] !== expected[i + 2] ||
            actual[i + 3] !== expected[i + 3]
        ) {
            changed++;
        }
    }
    expect(painted).toBeGreaterThan(100);
    expect(changed).toBe(0);
}

const items: Rect[] = [
    { x: -1, y: -1, size: 2, style: { fillStyle: "#ff0000" } },
    { x: 2, y: 1, width: 3, height: 1, style: { fillStyle: "#0000ff", strokeStyle: "#008000", lineWidth: 0.2 } },
];

afterEach(() => vi.restoreAllMocks());

describe("static cache repaints at the current pixel ratio", () => {
    it.each([
        [1, 2],
        [2, 1],
        [1, 1.5],
        [1.5, 3],
    ])("matches a fresh registration after switching %s -> %s", (before, after) => {
        const { draw, render, ratio } = setup(before);
        draw.drawStaticRect(items, "k");
        render();

        ratio.value = after;
        const repainted = render();
        expect(repainted.some((channel, i) => i % 4 !== 3 && channel !== 0)).toBe(true);

        compare(repainted, reference(items, { x: -5, y: -5, scale: 10 }, after));
    });

    it("re-records at the scale active when the ratio changed", () => {
        const { draw, render, camera, ratio } = setup(1);
        draw.drawStaticRect(items, "k");
        render();

        // Zoom and switch ratio in the same frame, as a monitor move while
        // the user is zooming would.
        camera.scale = 18;
        ratio.value = 2;
        const repainted = render();

        compare(repainted, reference(items, { x: -5, y: -5, scale: 18 }, 2));
    });
});

describe("static cache re-registration", () => {
    it("paints only the replacement when the same key is registered again", () => {
        const { draw, render } = setup(1);
        const first: Rect[] = [{ x: -1, y: -1, size: 3, style: { fillStyle: "#ff0000" } }];
        const second: Rect[] = [{ x: 1, y: -1, size: 2, style: { fillStyle: "#0000ff" } }];

        draw.drawStaticRect(first, "k");
        render();
        // Register again without removing the first handle: the old layer must
        // not keep blitting the replaced bitmap underneath the new one.
        draw.drawStaticRect(second, "k");
        const frame = render();

        compare(frame, reference(second, { x: -5, y: -5, scale: 10 }, 1));
    });

    it("replaces the bitmap when the new registration sits outside the old one", () => {
        const { draw, render } = setup(1);
        draw.drawStaticRect([{ x: -1, y: -1, size: 2, style: { fillStyle: "#ff0000" } }], "k");
        render();

        // The replacement's bounds do not overlap the old bitmap's, so a stale
        // layer would be plainly visible.
        const moved: Rect[] = [{ x: 3, y: 3, size: 2, style: { fillStyle: "#0000ff" } }];
        draw.drawStaticRect(moved, "k");
        const frame = render();

        compare(frame, reference(moved, { x: -5, y: -5, scale: 10 }, 1));
    });
});

describe("static cache clip across re-recordings", () => {
    const clip = { minX: -1, maxX: 2, minY: -1, maxY: 1 };
    const wide: Rect[] = [{ x: 0, y: 0, size: 8, style: { fillStyle: "#ff0000" } }];

    it("keeps clipping to the same world rectangle after the ratio changes", () => {
        const { draw, render, ratio } = setup(1);
        draw.drawStaticRect(wide, "k", 1, { clip });
        render();

        ratio.value = 2;
        const repainted = render();

        compare(repainted, reference(wide, { x: -5, y: -5, scale: 10 }, 2, clip));
    });

    it("keeps clipping while the camera pans after a re-record", () => {
        const { draw, render, camera, ratio } = setup(1);
        draw.drawStaticRect(wide, "k", 1, { clip });
        render();
        ratio.value = 2;
        render();

        // Pan with the ratio held: the clip rides the transform, so the same
        // world rectangle must still cut the same pixels.
        camera.x = -6;
        camera.y = -4;
        const panned = render();

        compare(panned, reference(wide, { x: -6, y: -4, scale: 10 }, 2, clip));
    });

    it("keeps the replacement's clip when the same key is registered again", () => {
        const { draw, render } = setup(1);
        draw.drawStaticRect(wide, "k", 1, { clip: { minX: -3, maxX: 0, minY: -3, maxY: 0 } });
        render();

        draw.drawStaticRect(wide, "k", 1, { clip });
        const frame = render();

        compare(frame, reference(wide, { x: -5, y: -5, scale: 10 }, 1, clip));
    });
});

import { describe, beforeEach, it, expect } from "vitest";
import * as pureimage from "../src/index";

const RED = 0xff0000ff;
const GREEN = 0x00ff00ff;
const BLUE = 0x0000ffff;
const GREEN_CONST = 0x00ff00ff;

function rgb(pixel: number) {
  return {
    r: (pixel >>> 24) & 0xff,
    g: (pixel >>> 16) & 0xff,
    b: (pixel >>> 8) & 0xff,
    a: pixel & 0xff,
  };
}

function makeTwoColorSource() {
  // 2x1 source: red on the left, blue on the right
  const src = pureimage.make(2, 1);
  src.setPixelRGBA(0, 0, RED);
  src.setPixelRGBA(1, 0, BLUE);
  return src;
}

describe("drawImage smoothing", () => {
  let image;
  let context;

  beforeEach(() => {
    image = pureimage.make(16, 16);
    context = image.getContext("2d");
  });

  it("interpolates between source pixels when upscaling 4x", () => {
    const src = makeTwoColorSource();
    context.drawImage(src, 0, 0, 2, 1, 0, 0, 8, 1);

    // the first destination pixel lands exactly on the source pixel
    expect(image.getPixelRGBA(0, 0)).to.eq(RED);

    const p1 = rgb(image.getPixelRGBA(1, 0));
    const p2 = rgb(image.getPixelRGBA(2, 0));
    const p3 = rgb(image.getPixelRGBA(3, 0));

    // all three are true blends, not the hard red/blue switch of nearest
    // neighbour
    for (const p of [p1, p2, p3]) {
      expect(p.a).to.eq(255);
      expect(p.r).toBeGreaterThan(0);
      expect(p.r).toBeLessThan(255);
      expect(p.b).toBeGreaterThan(0);
      expect(p.b).toBeLessThan(255);
      expect(p.g).to.eq(0);
    }

    // red fades out and blue fades in progressively across the ramp
    expect(p1.r).toBeGreaterThan(p2.r);
    expect(p2.r).toBeGreaterThan(p3.r);
    expect(p1.b).toBeLessThan(p2.b);
    expect(p2.b).toBeLessThan(p3.b);

    // adjacent destination pixels are visibly different (no hard switch)
    expect(image.getPixelRGBA(1, 0)).not.to.eq(image.getPixelRGBA(0, 0));
    expect(image.getPixelRGBA(2, 0)).not.to.eq(image.getPixelRGBA(1, 0));

    // the pixel that lands exactly on the second source pixel is solid blue
    expect(image.getPixelRGBA(4, 0)).to.eq(BLUE);
  });

  it("keeps nearest-neighbour results when smoothing is disabled", () => {
    const src = makeTwoColorSource();
    context.imageSmoothingEnabled = false;
    context.drawImage(src, 0, 0, 2, 1, 0, 0, 8, 1);

    // mapping is dest x -> src x / 4, then floored to a source pixel
    for (let x = 0; x < 4; x++) {
      expect(image.getPixelRGBA(x, 0)).to.eq(RED);
    }
    for (let x = 4; x < 8; x++) {
      expect(image.getPixelRGBA(x, 0)).to.eq(BLUE);
    }
  });

  it("keeps nearest-neighbour results for an unscaled draw", () => {
    const src = pureimage.make(4, 4);
    for (let y = 0; y < 4; y++) {
      for (let x = 0; x < 4; x++) {
        src.setPixelRGBA(x, y, x < 2 ? RED : BLUE);
      }
    }
    context.drawImage(src, 0, 0, 4, 4, 0, 0, 4, 4);
    for (let y = 0; y < 4; y++) {
      for (let x = 0; x < 4; x++) {
        expect(image.getPixelRGBA(x, y)).to.eq(x < 2 ? RED : BLUE);
      }
    }

    // ... and the same with smoothing switched off
    const image2 = pureimage.make(4, 4);
    const ctx2 = image2.getContext("2d");
    ctx2.imageSmoothingEnabled = false;
    ctx2.drawImage(src, 0, 0, 4, 4, 0, 0, 4, 4);
    for (let y = 0; y < 4; y++) {
      for (let x = 0; x < 4; x++) {
        expect(image2.getPixelRGBA(x, y)).to.eq(x < 2 ? RED : BLUE);
      }
    }
  });

  it("does not collapse destination pixels to one source pixel when shrinking", () => {
    // 4 source pixels -> 3 destination pixels: dest x maps to src x * 4 / 3,
    // so the middle pixel is a genuine blend instead of the rounded src pixel 1
    const src = pureimage.make(4, 1);
    src.setPixelRGBA(0, 0, RED);
    src.setPixelRGBA(1, 0, RED);
    src.setPixelRGBA(2, 0, BLUE);
    src.setPixelRGBA(3, 0, BLUE);

    context.drawImage(src, 0, 0, 4, 1, 0, 0, 3, 1);

    expect(image.getPixelRGBA(0, 0)).to.eq(RED);
    expect(image.getPixelRGBA(2, 0)).to.eq(BLUE);

    const middle = rgb(image.getPixelRGBA(1, 0));
    expect(middle.a).to.eq(255);
    expect(middle.r).toBeGreaterThan(0);
    expect(middle.r).toBeLessThan(255);
    expect(middle.b).toBeGreaterThan(0);
    expect(middle.b).toBeLessThan(255);
    expect(middle.g).to.eq(0);
  });

  it("treats an out-of-bounds source rectangle as transparent without throwing", () => {
    context.fillStyle = "lime";
    context.fillRect(0, 0, 16, 16);

    const src = pureimage.make(4, 4);
    for (let y = 0; y < 4; y++) {
      for (let x = 0; x < 4; x++) {
        src.setPixelRGBA(x, y, RED);
      }
    }

    // sx/sy is outside the source image; dest x maps to src x - 2, so dest
    // pixels 0..1 and 6..9 fall outside the source bitmap
    expect(() => {
      context.drawImage(src, -2, -2, 10, 10, 0, 0, 10, 10);
    }).not.toThrow();

    expect(image.getPixelRGBA(0, 0)).to.eq(GREEN);
    expect(image.getPixelRGBA(1, 0)).to.eq(GREEN);
    expect(image.getPixelRGBA(6, 6)).to.eq(GREEN);
    expect(image.getPixelRGBA(7, 7)).to.eq(GREEN);
    expect(image.getPixelRGBA(9, 9)).to.eq(GREEN);

    // the overlapping part is drawn
    expect(image.getPixelRGBA(2, 2)).to.eq(RED);
    expect(image.getPixelRGBA(5, 5)).to.eq(RED);
  });

  it("keeps the background where a destination rectangle leaves the canvas", () => {
    context.fillStyle = "lime";
    context.fillRect(0, 0, 16, 16);

    const src = pureimage.make(4, 4);
    for (let y = 0; y < 4; y++) {
      for (let x = 0; x < 4; x++) {
        src.setPixelRGBA(x, y, RED);
      }
    }

    // destination extends past the right and bottom edges of the 16x16 canvas
    expect(() => {
      context.drawImage(src, 0, 0, 4, 4, 12, 12, 12, 12);
    }).not.toThrow();

    // visible part is drawn
    expect(image.getPixelRGBA(12, 12)).to.eq(RED);
    expect(image.getPixelRGBA(15, 15)).to.eq(RED);
    // area outside the destination rectangle keeps the background
    expect(image.getPixelRGBA(0, 0)).to.eq(GREEN_CONST);
  });

  it("still honours globalAlpha and the clip region while smoothing", () => {
    const src = pureimage.make(2, 2);
    for (let y = 0; y < 2; y++) {
      for (let x = 0; x < 2; x++) {
        src.setPixelRGBA(x, y, RED);
      }
    }

    context.fillStyle = "white";
    context.fillRect(0, 0, 16, 16);
    context.beginPath();
    context.rect(0, 0, 8, 16);
    context.clip();

    context.globalAlpha = 0.5;
    context.drawImage(src, 0, 0, 2, 2, 0, 0, 16, 16);

    // inside the clip: 50% red over white
    expect(rgb(image.getPixelRGBA(1, 1))).toEqual({
      r: 255,
      g: 127,
      b: 127,
      a: 255,
    });
    // outside the clip: untouched white
    expect(image.getPixelRGBA(12, 12)).to.eq(0xffffffff);
  });
});

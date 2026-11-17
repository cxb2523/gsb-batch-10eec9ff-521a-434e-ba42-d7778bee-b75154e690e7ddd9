import {
  NAMED_COLORS,
  OPAQUE_BLACK,
  TRANSPARENT_BLACK,
} from "./named_colors.js";
import { Context } from "./context.js";
import { fromBytesBigEndian, getBytesBigEndian } from "./uint32.js";

function clampByte(value: number): number {
  if (!(value > 0)) return 0;
  if (value >= 255) return 255;
  return Math.round(value);
}

/**
 * The Bitmap class is used for direct pixel manipulation(for example setting a pixel colour,
 * transparency etc). It also provides a factory method for creating new instances of
 * {@link Context}
 */
export class Bitmap {
  private _width: number;
  private _height: number;
  public data: Uint8Array;
  private _context: Context;

  /**
   * Creates an instance of Bitmap.
   * @param {number} w      Width
   * @param {number} h      Height
   * @memberof Bitmap
   */
  constructor(w: number, h: number) {
    this._width = Math.floor(w);
    this._height = Math.floor(h);
    this.data = new Uint8Array(this._width * this._height * 4);

    // new bitmaps start opaque black (kept for backwards compatibility); reset() and
    // resizing clear to transparent black like a canvas does
    const fillval = OPAQUE_BLACK;
    for (let j = 0; j < this._height; j++) {
      for (let i = 0; i < this._width; i++) {
        this.setPixelRGBA(i, j, fillval);
      }
    }
    this._context = new Context(this);
  }

  get width(): number {
    return this._width;
  }

  /** Setting the width (even to the same value) clears the bitmap and resets the context, like a canvas */
  set width(w: number) {
    this._resize(w, this._height);
  }

  get height(): number {
    return this._height;
  }

  /** Setting the height (even to the same value) clears the bitmap and resets the context, like a canvas */
  set height(h: number) {
    this._resize(this._width, h);
  }

  private _resize(w: number, h: number) {
    w = Number(w);
    h = Number(h);
    if (!Number.isFinite(w) || !Number.isFinite(h) || w < 0 || h < 0) {
      throw new TypeError(`invalid canvas size ${w} x ${h}`);
    }
    this._width = Math.floor(w);
    this._height = Math.floor(h);
    this.data = new Uint8Array(this._width * this._height * 4);
    this._context.reset();
  }

  /** Calculate Index */
  calculateIndex(
    /** X position */
    x: number,
    /** Y position */
    y: number,
  ) {
    x = Math.floor(x);
    y = Math.floor(y);
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return 0;
    return (this.width * y + x) * 4;
  }

  /** Set the RGBA(Red, Green, Blue, Alpha) values on an individual pixel level */
  setPixelRGBA(
    /** X axis position */
    x: number,
    /** Y axis position */
    y: number,
    /** A hex representation of the RGBA value of the pixel. See {@link NAMED_COLORS} for examples */
    rgba: number,
  ) {
    this.validate_coords(x, y);
    const i = this.calculateIndex(x, y);
    const bytes = getBytesBigEndian(rgba);
    this.data[i + 0] = bytes[0];
    this.data[i + 1] = bytes[1];
    this.data[i + 2] = bytes[2];
    this.data[i + 3] = bytes[3];
  }

  /** Set the individual red, green, blue and alpha levels of an individual pixel */
  setPixelRGBA_i(
    /** X axis position */
    x: number,
    /** Y axis position */
    y: number,
    /** Red level */
    r: number,
    /** Green level */
    g: number,
    /** Blue level */
    b: number,
    /** Alpha level */
    a: number,
  ) {
    const i = this.calculateIndex(x, y);
    this.data[i + 0] = r;
    this.data[i + 1] = g;
    this.data[i + 2] = b;
    this.data[i + 3] = a;
  }

  /** Get the RGBA value of an individual pixel as a hexadecimal number(See {@link NAMED_COLORS} for examples) */
  getPixelRGBA(
    /** X axis position */
    x: number,
    /** Y axis position */
    y: number,
  ) {
    this.validate_coords(x, y);
    const i = this.calculateIndex(x, y);
    return fromBytesBigEndian(
      this.data[i + 0],
      this.data[i + 1],
      this.data[i + 2],
      this.data[i + 3],
    );
  }

  getDebugPixelRGBA(
    /** X axis position */
    x: number,
    /** Y axis position */
    y: number,
  ) {
    const i = this.calculateIndex(x, y);
    const width = this.width;
    const height = this.height;
    const data = this.data;
    console.dir({ i, width, height, data });
    return fromBytesBigEndian(
      this.data[i + 0],
      this.data[i + 1],
      this.data[i + 2],
      this.data[i + 3],
    );
  }

  /**
   * Get Pixel RGBA Separate
   *
   * @ignore
   */
  getPixelRGBA_separate(
    /** X axis position */
    x: number,
    /** Y axis position */
    y: number,
  ) {
    const i = this.calculateIndex(x, y);
    return this.data.slice(i, i + 4);
  }

  /**
   * {@link Context} factory. Creates a new {@link Context} instance object for the current bitmap object
   */
  getContext(type: string) {
    // like a canvas, calling with no argument at all is a TypeError, while an
    // unsupported type name simply yields null
    if (arguments.length === 0) {
      throw new TypeError("getContext requires a context type");
    }
    if (type === "2d") {
      return this._context;
    }
    return null;
  }

  _copySubBitmap(x: number, y: number, w: number, h: number) {
    const dst = new Bitmap(w, h);
    for (let i = 0; i < w; i++) {
      for (let j = 0; j < h; j++) {
        const indexA = this.calculateIndex(x + i, y + j);
        const indexB = dst.calculateIndex(i, j);
        for (let k = 0; k < 4; k++) {
          dst.data[indexB + k] = this.data[indexA + k];
        }
      }
    }
    return dst;
  }

  _pasteSubBitmap(src: Bitmap, x: number, y: number) {
    for (let i = 0; i < src.width; i++) {
      for (let j = 0; j < src.height; j++) {
        const indexA = this.calculateIndex(x + i, y + j);
        const indexB = src.calculateIndex(i, j);
        for (let k = 0; k < 4; k++) {
          this.data[indexA + k] = src.data[indexB + k];
        }
      }
    }
  }

  /**
   * Sample a source pixel with bilinear interpolation, optionally supersampling
   * a box-shaped footprint.
   *
   * `x`/`y` are continuous coordinates in source pixel space. `footprintW`/
   * `footprintH` is the size of one destination pixel measured in source
   * pixels (1x1 means point sampling). `grid` is the number of samples per axis
   * inside that footprint (1 = plain bilinear, 2/4 = supersampled box filter,
   * used for minification at higher `imageSmoothingQuality`).
   *
   * Coordinates outside the source sub-rectangle or outside the bitmap produce
   * a transparent result, so the destination pixel is left untouched. Inside
   * the rectangle interpolation only reads pixels that are contained by both
   * the rectangle and the bitmap; every out-of-range neighbour is treated as
   * transparent black (it adds neither colour nor alpha), so nothing outside
   * the sub-rectangle or the bitmap can ever be sampled.
   *
   * When `x`/`y` land exactly on a pixel, the interpolation weight collapses
   * onto that single pixel, so the result is exactly the value the
   * nearest-neighbour path reads. This keeps unscaled draws pixel-exact.
   */
  _sampleSmoothRGBA(
    x: number,
    y: number,
    footprintW: number,
    footprintH: number,
    grid: number,
    rectX: number,
    rectY: number,
    rectW: number,
    rectH: number,
  ): number {
    if (
      !Number.isFinite(x) ||
      !Number.isFinite(y) ||
      !Number.isFinite(rectX) ||
      !Number.isFinite(rectY) ||
      !Number.isFinite(rectW) ||
      !Number.isFinite(rectH) ||
      rectW <= 0 ||
      rectH <= 0
    ) {
      return TRANSPARENT_BLACK;
    }

    const rectX2 = rectX + rectW;
    const rectY2 = rectY + rectH;
    const width = this._width;
    const height = this._height;

    // the sample point itself must be inside the source rectangle and bitmap;
    // otherwise the destination pixel stays transparent (background remains)
    if (x < rectX || x >= rectX2 || y < rectY || y >= rectY2) {
      return TRANSPARENT_BLACK;
    }
    if (x < 0 || y < 0 || x >= width || y >= height) {
      return TRANSPARENT_BLACK;
    }

    // premultiplied accumulation: rgb * (a/255) * weight, plus alpha * weight
    let sumAlpha = 0;
    let sumRed = 0;
    let sumGreen = 0;
    let sumBlue = 0;

    const accumulatePixel = (px: number, py: number, weight: number) => {
      if (weight <= 0) return;
      // pixel centers must be inside both the source rectangle and the bitmap;
      // everything else contributes as transparent black
      const cx = px + 0.5;
      const cy = py + 0.5;
      if (cx < rectX || cx >= rectX2 || cy < rectY || cy >= rectY2) return;
      if (px < 0 || py < 0 || px >= width || py >= height) return;
      const index = (width * py + px) * 4;
      const alpha = this.data[index + 3];
      if (alpha === 0) return;
      const alphaWeight = (alpha / 255) * weight;
      sumRed += this.data[index] * alphaWeight;
      sumGreen += this.data[index + 1] * alphaWeight;
      sumBlue += this.data[index + 2] * alphaWeight;
      sumAlpha += alphaWeight;
    };

    const sampleBilinear = (px: number, py: number, weight: number) => {
      if (!Number.isFinite(px) || !Number.isFinite(py)) return;
      const x0 = Math.floor(px);
      const y0 = Math.floor(py);
      const fx = px - x0;
      const fy = py - y0;
      accumulatePixel(x0, y0, (1 - fx) * (1 - fy) * weight);
      accumulatePixel(x0 + 1, y0, fx * (1 - fy) * weight);
      accumulatePixel(x0, y0 + 1, (1 - fx) * fy * weight);
      accumulatePixel(x0 + 1, y0 + 1, fx * fy * weight);
    };

    const n = grid >= 1 ? Math.floor(grid) : 1;
    if (n === 1) {
      sampleBilinear(x, y, 1);
    } else {
      const stepX = footprintW / n;
      const stepY = footprintH / n;
      const startX = x - footprintW / 2 + stepX / 2;
      const startY = y - footprintH / 2 + stepY / 2;
      for (let sy = 0; sy < n; sy++) {
        for (let sx = 0; sx < n; sx++) {
          sampleBilinear(
            startX + sx * stepX,
            startY + sy * stepY,
            1 / (n * n),
          );
        }
      }
    }

    if (sumAlpha <= 0) return TRANSPARENT_BLACK;
    const inv = 1 / sumAlpha;
    return fromBytesBigEndian(
      clampByte(sumRed * inv),
      clampByte(sumGreen * inv),
      clampByte(sumBlue * inv),
      clampByte(sumAlpha * 255),
    );
  }

  _isValidCoords(x, y) {
    if (x < 0) return false;
    if (y < 0) return false;
    if (x >= this.width) return false;
    if (y >= this.height) return false;
    return true;
  }

  validate_coords(x, y) {
    if (x < 0) throw new Error(`Invalid Index: x ${x} <0`);
    if (y < 0) throw new Error(`Invalid Index: y ${y} <0`);
    if (x >= this.width)
      throw new Error(`Invalid Index: x ${x} >= width ${this.width}`);
    if (y >= this.height)
      throw new Error(`Invalid Index: y ${y} >= height ${this.height}`);
  }
}

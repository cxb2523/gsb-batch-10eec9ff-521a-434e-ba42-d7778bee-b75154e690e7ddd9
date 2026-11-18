/**
 * Minimal animated GIF89a encoder.
 *
 * Palette policy: fully opaque pixels keep their exact color, and partially transparent pixels
 * are composited over white so they stay visible instead of collapsing into the transparent
 * index (GIF has no alpha channel). Animations with at most 255 distinct colors store them
 * exactly. Larger animations get a median-cut palette built from the colors actually used
 * instead of a fixed color cube. One global color→index map serves every frame, so the same
 * color always lands on the same entry. Index 0 remains the transparent entry.
 */

type Frame = { data: Uint8ClampedArray; delay: number; };

class ByteWriter {
  bytes: number[] = [];
  byte(v: number) { this.bytes.push(v & 255); }
  word(v: number) { this.byte(v); this.byte(v >> 8); }
  str(s: string) { for (const c of s) this.byte(c.charCodeAt(0)); }
  all(arr: ArrayLike<number>) { for (let i = 0; i < arr.length; i++) this.bytes.push(arr[i]); }
}

/** Backdrop used to flatten partial transparency */
const MATTE = 255;

/** Marker returned for fully transparent pixels (they never enter the palette) */
const TRANSPARENT = -1;

/** Packed 0xRRGGBB as it appears in the GIF, or TRANSPARENT for fully transparent pixels */
function flattenPixel(data: Uint8ClampedArray, i: number) {
  const a = data[i + 3];
  if (a === 0) return TRANSPARENT;
  const r = data[i], g = data[i + 1], b = data[i + 2];
  if (a === 255) return (r << 16) | (g << 8) | b;
  const k = a / 255;
  const mix = (c: number) => Math.round(c * k + MATTE * (1 - k));
  return (mix(r) << 16) | (mix(g) << 8) | mix(b);
}

type ColorCount = { r: number; g: number; b: number; n: number; };

/** Channel bounds of a color box: [loR, hiR, loG, hiG, loB, hiB] */
function boxBounds(box: ColorCount[]) {
  const bounds = [255, 0, 255, 0, 255, 0];
  for (const c of box) {
    if (c.r < bounds[0]) bounds[0] = c.r;
    if (c.r > bounds[1]) bounds[1] = c.r;
    if (c.g < bounds[2]) bounds[2] = c.g;
    if (c.g > bounds[3]) bounds[3] = c.g;
    if (c.b < bounds[4]) bounds[4] = c.b;
    if (c.b > bounds[5]) bounds[5] = c.b;
  }
  return bounds;
}

/** Channel with the widest spread, used as the median-cut axis */
function longestAxis(box: ColorCount[]) {
  const [loR, hiR, loG, hiG, loB, hiB] = boxBounds(box);
  const r = hiR - loR, g = hiG - loG, b = hiB - loB;
  return r >= g && r >= b ? 'r' : g >= b ? 'g' : 'b';
}

function boxWeight(box: ColorCount[]) {
  let n = 0;
  for (const c of box) n += c.n;
  return n;
}

function boxRange(box: ColorCount[]) {
  const [loR, hiR, loG, hiG, loB, hiB] = boxBounds(box);
  return Math.max(hiR - loR, hiG - loG, hiB - loB);
}

function meanColor(box: ColorCount[]) {
  let n = 0, r = 0, g = 0, b = 0;
  for (const c of box) {
    n += c.n;
    r += c.r * c.n;
    g += c.g * c.n;
    b += c.b * c.n;
  }
  return { r: Math.round(r / n), g: Math.round(g / n), b: Math.round(b / n), n };
}

/** Population-weighted median cut over the colors actually used in the animation */
function medianCut(colors: ColorCount[], maxColors: number) {
  const boxes: ColorCount[][] = [colors];
  while (boxes.length < maxColors) {
    let best = -1, bestScore = 0;
    for (let i = 0; i < boxes.length; i++) {
      const box = boxes[i];
      if (box.length < 2) continue;
      const score = boxWeight(box) * (boxRange(box) + 1);
      if (score > bestScore) { bestScore = score; best = i; }
    }
    if (best < 0) break;
    const box = boxes[best];
    const axis = longestAxis(box);
    box.sort((x, y) => x[axis] - y[axis]);
    let acc = 0, cut = 1;
    const total = boxWeight(box);
    for (let i = 0; i < box.length - 1; i++) {
      acc += box[i].n;
      cut = i + 1;
      if (acc * 2 >= total) break;
    }
    boxes.splice(best, 1, box.slice(0, cut), box.slice(cut));
  }
  return boxes.map(meanColor);
}

/** Nearest palette entry by squared RGB distance */
function nearestEntry(colors: number[], r: number, g: number, b: number) {
  let best = 0, bestD = Infinity;
  for (let i = 0; i < colors.length; i++) {
    const c = colors[i];
    const dr = r - ((c >> 16) & 255), dg = g - ((c >> 8) & 255), db = b - (c & 255);
    const d = dr * dr + dg * dg + db * db;
    if (d < bestD) { bestD = d; best = i; }
  }
  return best;
}

/**
 * Builds the 256-entry palette (index 0 stays transparent) and the color→index mapping.
 * The same mapping is reused for every frame, so a color never changes its entry.
 */
function buildPalette(frames: Frame[]) {
  // Exact colors are kept only while they can still fit the palette. Once a 256th color shows up
  // the counts move into a reduced-precision histogram, so large photos don't accumulate one map
  // entry per pixel while the dominant colors are still measured by population.
  let counts: Map<number, number> | null = new Map();
  let buckets: Map<number, ColorCount> | null = null;

  const bucketKey = (key: number) =>
    (((key >> 16) & 255) >> 3) << 10 | (((key >> 8) & 255) >> 3) << 5 | ((key & 255) >> 3);

  const addToBuckets = (key: number, n: number) => {
    const r = (key >> 16) & 255, g = (key >> 8) & 255, b = key & 255;
    const bucket = bucketKey(key);
    let e = buckets!.get(bucket);
    if (!e) buckets!.set(bucket, e = { r: 0, g: 0, b: 0, n: 0 });
    e.r += r * n; e.g += g * n; e.b += b * n; e.n += n;
  };

  for (const { data } of frames) {
    const end = data.length - 3;
    for (let i = 0; i < end; i += 4) {
      const key = flattenPixel(data, i);
      if (key === TRANSPARENT) continue;
      if (buckets) { addToBuckets(key, 1); continue; }
      counts!.set(key, (counts!.get(key) ?? 0) + 1);
      if (counts!.size > 255) {
        buckets = new Map();
        for (const [k, n] of counts!) addToBuckets(k, n);
        counts = null;
      }
    }
  }

  let colors: number[];
  let indexOf: (key: number) => number;

  if (counts && counts.size <= 255) {
    // Exact colors in first-appearance order (stable across frames and re-encodes)
    colors = [...counts.keys()];
    const map = new Map<number, number>();
    colors.forEach((key, i) => map.set(key, i + 1));
    indexOf = key => map.get(key)!;
  } else {
    const entries: ColorCount[] = [...buckets!.values()].map(e => ({
      r: Math.round(e.r / e.n), g: Math.round(e.g / e.n), b: Math.round(e.b / e.n), n: e.n,
    }));

    colors = [];
    const seen = new Set<number>();
    for (const c of medianCut(entries, 255)) {
      const key = (c.r << 16) | (c.g << 8) | c.b;
      if (seen.has(key)) continue;
      seen.add(key);
      colors.push(key);
    }

    // 5-bit-per-channel lookup table: nearest palette entry for every color bucket.
    const lut = new Int16Array(32768).fill(-1);
    indexOf = key => {
      const bucket = bucketKey(key);
      let entry = lut[bucket];
      if (entry < 0) {
        const r = (key >> 16) & 255, g = (key >> 8) & 255, b = key & 255;
        entry = nearestEntry(colors, (r & ~7) | 4, (g & ~7) | 4, (b & ~7) | 4);
        lut[bucket] = entry;
      }
      return entry + 1;
    };
  }

  const table = new Uint8Array(256 * 3);
  colors.forEach((key, i) => {
    const o = (i + 1) * 3;
    table[o] = (key >> 16) & 255;
    table[o + 1] = (key >> 8) & 255;
    table[o + 2] = key & 255;
  });

  return { table, indexOf };
}

/** Variable-width LZW as required by the GIF spec */
function lzw(indices: Uint8Array, minCodeSize: number) {
  const out: number[] = [];
  const clear = 1 << minCodeSize, end = clear + 1;
  let codeSize = minCodeSize + 1;
  let dict = new Map<string, number>();
  let next = end + 1;
  let bits = 0, acc = 0;

  const emit = (code: number) => {
    acc |= code << bits;
    bits += codeSize;
    while (bits >= 8) { out.push(acc & 255); acc >>>= 8; bits -= 8; }
  };

  emit(clear);
  let prefix = String(indices[0]);
  for (let i = 1; i < indices.length; i++) {
    const k = indices[i];
    const key = prefix + ',' + k;
    if (dict.has(key)) { prefix = key; continue; }
    emit(prefix.includes(',') ? dict.get(prefix)! : Number(prefix));
    if (next < 4096) {
      dict.set(key, next++);
      if (next > (1 << codeSize) && codeSize < 12) codeSize++;
    } else {
      emit(clear);
      dict = new Map();
      next = end + 1;
      codeSize = minCodeSize + 1;
    }
    prefix = String(k);
  }
  emit(prefix.includes(',') ? dict.get(prefix)! : Number(prefix));
  emit(end);
  if (bits > 0) out.push(acc & 255);
  return out;
}

export function encodeGif(width: number, height: number, frames: Frame[], loop = true) {
  const { table, indexOf } = buildPalette(frames);

  const w = new ByteWriter();
  w.str('GIF89a');
  w.word(width);
  w.word(height);
  w.byte(0xf7); // global color table, 8 bits per channel, 256 entries
  w.byte(0);
  w.byte(0);
  w.all(table);

  if (loop) {
    w.byte(0x21); w.byte(0xff); w.byte(11);
    w.str('NETSCAPE2.0');
    w.byte(3); w.byte(1); w.word(0); w.byte(0);
  }

  for (const { data, delay } of frames) {
    // Graphic control: restore to background, transparent index 0
    w.byte(0x21); w.byte(0xf9); w.byte(4);
    w.byte(0b00001001);
    w.word(Math.max(2, Math.round(delay / 10)));
    w.byte(0);
    w.byte(0);

    w.byte(0x2c);
    w.word(0); w.word(0);
    w.word(width); w.word(height);
    w.byte(0);

    const indices = new Uint8Array(width * height);
    const pixels = Math.min(indices.length, Math.floor(data.length / 4));
    for (let p = 0; p < pixels; p++) {
      const key = flattenPixel(data, p * 4);
      if (key !== TRANSPARENT) indices[p] = indexOf(key);
    }

    w.byte(8);
    const packed = lzw(indices, 8);
    for (let i = 0; i < packed.length; i += 255) {
      const chunk = packed.slice(i, i + 255);
      w.byte(chunk.length);
      w.all(chunk);
    }
    w.byte(0);
  }

  w.byte(0x3b);
  return new Uint8Array(w.bytes);
}

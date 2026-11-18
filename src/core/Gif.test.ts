import { describe, expect, test } from 'bun:test';
import { encodeGif } from '~/core/Gif';
import { decodeGif } from '~/core/formats/GifDecode';
import { packRgba, unpackRgba } from '~/core/Image';

const RED = packRgba(255, 0, 0, 255);
const GREEN = packRgba(0, 255, 0, 255);
const BLUE = packRgba(0, 0, 255, 255);
const CLEAR = 0;

const frame = (pixels: number[], delay = 100) => ({
  data: new Uint8ClampedArray(new Uint32Array(pixels).buffer),
  delay,
});

const hasNetscape = (bytes: Uint8Array) =>
  new TextDecoder('latin1').decode(bytes).includes('NETSCAPE2.0');

/** Global color table size from the packed screen descriptor */
const globalTableEntries = (bytes: Uint8Array) => 1 << ((bytes[10] & 7) + 1);

/** Transparent index declared in the first graphic control extension */
function firstTransparentIndex(bytes: Uint8Array) {
  let pos = 13 + 3 * globalTableEntries(bytes);
  while (pos < bytes.length) {
    if (bytes[pos] !== 0x21) break;
    if (bytes[pos + 1] === 0xf9) return bytes[pos + 6];
    pos += 2;
    while (bytes[pos]) pos += bytes[pos] + 1;
    pos++;
  }
  throw new Error('No graphic control extension');
}

describe('encodeGif', () => {
  test('small exact-color animations round-trip every frame without palette loss', () => {
    const frames = [
      frame([RED, GREEN, BLUE, CLEAR], 80),
      frame([CLEAR, RED, GREEN, BLUE], 120),
    ];
    const decoded = decodeGif(encodeGif(2, 2, frames));

    expect(decoded.frames.map(f => f.delay)).toEqual([80, 120]);
    expect(decoded.frames.map(f => [...f.data])).toEqual([
      [RED, GREEN, BLUE, CLEAR],
      [CLEAR, RED, GREEN, BLUE],
    ]);
  });

  test('partially transparent pixels are flattened and stay visible', () => {
    const halfRed = packRgba(255, 0, 0, 128);
    const quarterBlue = packRgba(0, 0, 255, 64);
    const barelyVisible = packRgba(20, 30, 240, 1);
    const decoded = decodeGif(encodeGif(4, 1, [frame([halfRed, quarterBlue, barelyVisible, CLEAR])]));
    const gif = encodeGif(4, 1, [frame([halfRed, quarterBlue, barelyVisible, CLEAR])]);

    // Transparent pixels keep index 0
    expect(firstTransparentIndex(gif)).toBe(0);

    const [hr, hg, hb, ha] = unpackRgba(decoded.frames[0].data[0]);
    // Half-transparent red keeps its hue over the white matte instead of vanishing
    expect(ha).toBe(255);
    expect(hr).toBe(255);
    expect(hg).toBeGreaterThan(100);
    expect(hg).toBeLessThan(150);
    expect(hb).toBe(hg);
    expect(decoded.frames[0].data[0]).not.toBe(CLEAR);

    const [qr, , qb, qa] = unpackRgba(decoded.frames[0].data[1]);
    expect(qa).toBe(255);
    expect(qb).toBeGreaterThan(qr);
    expect(decoded.frames[0].data[1]).not.toBe(CLEAR);

    // Even 1/255 alpha remains a (near-matte) color instead of disappearing
    expect(decoded.frames[0].data[2]).not.toBe(CLEAR);

    // Fully transparent pixels still use index 0
    expect(decoded.frames[0].data[3]).toBe(CLEAR);
  });

  test('animations over 255 colors use a quantized palette of at most 256 entries', () => {
    const pixels: number[] = [];
    // 512 distinct gradient colors plus a dominant solid block
    for (let i = 0; i < 512; i++) pixels.push(packRgba(i % 256, (i * 37) % 256, (i * 73) % 256, 255));
    for (let i = 0; i < 512; i++) pixels.push(RED);

    const width = 32, height = 32;
    const bytes = encodeGif(width, height, [frame(pixels)]);
    const decoded = decodeGif(bytes);

    expect(globalTableEntries(bytes)).toBe(256);
    // Index 0 is the transparent entry and the opaque black source pixel gets its own entry
    expect(firstTransparentIndex(bytes)).toBe(0);
    expect(decoded.frames[0].data[0]).not.toBe(0);

    const used = new Set<number>();
    for (const color of decoded.frames[0].data) if (color !== CLEAR) used.add(color);
    expect(used.size).toBeLessThanOrEqual(255);

    // The dominant solid block stays recognizable rather than becoming a coarse cube color
    for (let i = 512; i < 1024; i++) {
      const [r, g, b, a] = unpackRgba(decoded.frames[0].data[i]);
      expect(a).toBe(255);
      expect(Math.abs(r - 255)).toBeLessThanOrEqual(24);
      expect(g).toBeLessThanOrEqual(24);
      expect(b).toBeLessThanOrEqual(24);
    }
  });

  test('a color maps to the same palette entry across all frames', () => {
    const pixels: number[] = [];
    for (let i = 0; i < 300; i++) pixels.push(packRgba(i, (i * 11) % 256, (i * 29) % 256, 255));
    const shared = packRgba(12, 200, 40, 255);
    pixels.push(shared);
    const reversed = [...pixels].reverse();

    const bytes = encodeGif(301, 1, [frame(pixels), frame(reversed)]);
    const decoded = decodeGif(bytes);
    const first = decoded.frames[0].data[300];
    const second = decoded.frames[1].data[0];

    expect(first).toBe(second);
    // The shared color stays close to its source
    const [r, g, b] = unpackRgba(first);
    expect(Math.abs(r - 12)).toBeLessThanOrEqual(24);
    expect(Math.abs(g - 200)).toBeLessThanOrEqual(24);
    expect(Math.abs(b - 40)).toBeLessThanOrEqual(24);
  });

  test('the quantized palette is built from the colors actually used', () => {
    // 400 distinct colors inside a narrow dark-blue range plus transparency.
    // A fixed color cube would snap all of them to a couple of coarse entries.
    const pixels: number[] = [];
    for (let i = 0; i < 400; i++) pixels.push(packRgba(10 + (i % 20), 20 + ((i * 7) % 20), 180 + ((i * 3) % 40), 255));
    pixels.push(CLEAR);

    const bytes = encodeGif(401, 1, [frame(pixels)]);
    const decoded = decodeGif(bytes);

    expect(firstTransparentIndex(bytes)).toBe(0);
    expect(decoded.frames[0].data[400]).toBe(CLEAR);

    for (let i = 0; i < 400; i++) {
      const [r, g, b, a] = unpackRgba(decoded.frames[0].data[i]);
      expect(a).toBe(255);
      // Source range: r 10..29, g 20..39, b 180..219
      expect(r).toBeGreaterThanOrEqual(5);
      expect(r).toBeLessThanOrEqual(35);
      expect(g).toBeGreaterThanOrEqual(15);
      expect(g).toBeLessThanOrEqual(45);
      expect(b).toBeGreaterThanOrEqual(175);
      expect(b).toBeLessThanOrEqual(225);
    }
  });

  test('quantized animations keep frame delays, transparency and the loop flag', () => {
    const pixels: number[] = [];
    for (let i = 0; i < 400; i++) pixels.push(packRgba(i % 256, (i * 41) % 256, (i * 67) % 256, 255));
    const frames = [
      { data: new Uint8ClampedArray(new Uint32Array([...pixels, CLEAR]).buffer), delay: 70 },
      { data: new Uint8ClampedArray(new Uint32Array([CLEAR, ...pixels]).buffer), delay: 130 },
    ];

    const bytes = encodeGif(401, 1, frames, false);
    const decoded = decodeGif(bytes);

    expect(hasNetscape(bytes)).toBe(false);
    expect(decoded.frames.map(f => f.delay)).toEqual([70, 130]);
    expect(decoded.frames[0].data[400]).toBe(CLEAR);
    expect(decoded.frames[1].data[0]).toBe(CLEAR);
    // A shared source color lands on the same entry in both frames
    expect(decoded.frames[0].data[0]).toBe(decoded.frames[1].data[1]);
  });

  test('the NETSCAPE loop block follows the loop flag only', () => {
    const frames = [frame([RED])];
    expect(hasNetscape(encodeGif(1, 1, frames, true))).toBe(true);
    expect(hasNetscape(encodeGif(1, 1, frames, false))).toBe(false);
  });
});

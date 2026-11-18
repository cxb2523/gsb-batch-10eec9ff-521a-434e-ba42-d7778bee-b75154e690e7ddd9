// Shared rules for the ASCII character atlas and the shader that samples it.
//
// The atlas is a fixed 16x16 grid (1024px canvas, 64px cells) drawn on an
// offscreen canvas at a given font size, while the shader decides which cell
// to sample from the luminance of the (DPR-aware) render target. Both sides
// must agree on how many grey levels / glyph cells actually exist, otherwise
// the shader can address cells that were never drawn.

export const DEFAULT_CHARACTERS = ' *,    ./O#DE'

// The offscreen atlas canvas is ATLAS_GRID_SIZE x ATLAS_GRID_SIZE cells.
export const ATLAS_GRID_SIZE = 16
export const ATLAS_CELL_SIZE = 64
export const ATLAS_CAPACITY = ATLAS_GRID_SIZE * ATLAS_GRID_SIZE // 256

/**
 * Remove repeated characters while preserving the order of first occurrence.
 * A duplicated glyph would otherwise occupy several grey-level bins and make
 * the luminance mapping skip levels (grey banding /断层).
 *
 * @param {unknown} value
 * @returns {string}
 */
export function dedupeCharacters(value) {
  const seen = new Set()
  let result = ''

  for (const char of String(value ?? '')) {
    if (!seen.has(char)) {
      seen.add(char)
      result += char
    }
  }

  return result
}

/**
 * Normalize a raw character set:
 *  - an empty set, or a set that only contains whitespace, falls back to the
 *    default character set so the renderer can never end up fully blank;
 *  - duplicate characters are removed.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function normalizeCharacters(value) {
  const raw = String(value ?? '')

  if (raw.trim().length === 0) {
    return dedupeCharacters(DEFAULT_CHARACTERS)
  }

  return dedupeCharacters(raw)
}

/**
 * Resolve the characters that actually participate in the mapping and how
 * many grey-level bins exist: the smaller of the (deduped) character set
 * length and the configured limit. The returned string always has exactly
 * `count` entries, which is also the number of glyph cells drawn in the atlas
 * and the number of bins the shader is allowed to index.
 *
 * @param {unknown} value raw character set
 * @param {unknown} limit configured character limit
 * @returns {{ characters: string, count: number }}
 */
export function getEffectiveCharacters(value, limit) {
  const normalized = normalizeCharacters(value)

  const parsedLimit = Number.parseInt(limit, 10)
  const max = Number.isFinite(parsedLimit)
    ? Math.min(ATLAS_CAPACITY, Math.max(1, parsedLimit))
    : 1

  const characters = normalized.slice(0, max)

  return { characters, count: characters.length }
}

/**
 * Parse a positive integer coming from an untrusted source (URL parameter).
 * Returns the fallback when the value is missing or not a valid integer and
 * clamps the result to the supported range.
 *
 * @param {unknown} value
 * @param {number} fallback
 * @param {{ min?: number, max?: number }} [options]
 * @returns {number}
 */
export function parsePositiveInt(
  value,
  fallback,
  { min = 1, max = ATLAS_CAPACITY } = {}
) {
  const parsed = Number.parseInt(value, 10)

  if (!Number.isFinite(parsed)) return fallback

  return Math.min(max, Math.max(min, parsed))
}

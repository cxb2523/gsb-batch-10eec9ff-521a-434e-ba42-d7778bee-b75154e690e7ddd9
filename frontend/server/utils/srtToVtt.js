import { LRUCache } from 'lru-cache';

// Memoize conversions keyed by source-file path + mtime + size so a re-edited
// .srt invalidates automatically. Bounded by TOTAL bytes, not entry count: a
// handful of very large subtitles must not be able to pin gigabytes in memory.
export const MAX_SRT_BYTES = 2 * 1024 * 1024;      // reject subtitles larger than 2 MiB
export const SRT_TOO_LARGE_CODE = 'ESRTTOOLARGE';
const MAX_SRT_CACHE_BYTES = 8 * 1024 * 1024; // total conversion-cache budget
const cache = new LRUCache({
  maxSize: MAX_SRT_CACHE_BYTES,
  sizeCalculation: (buf) => buf.length || 1,
});

// Single-flight table for conversions currently in progress, keyed the same
// way as `cache`. Without it, N concurrent requests for the same not-yet-cached
// subtitle would each read and convert the whole file, briefly pinning N
// copies of the source in memory (a problem precisely for large subtitles).
// Entries are dropped as soon as the conversion settles, whether it resolves
// or rejects.
const inflight = new Map();

const TIMESTAMP_RE = /^(\d\d:\d\d:\d\d),(\d{3}) --> (\d\d:\d\d:\d\d),(\d{3})$/;

// Convert an SRT body (string) to a VTT body (string).
// - Strips a leading UTF-8 BOM if present
// - Normalizes CRLF to LF
// - Replaces the comma decimal separator with a period in timestamp lines only
// - Prepends the WEBVTT header
//
// Pure function. No I/O, no caching at this layer (cache lives in `convertSrtFileToVtt`).
export function srtToVtt(srtBody) {
  if (!srtBody) return 'WEBVTT\n\n';
  let body = srtBody.replace(/^﻿/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const lines = body.split('\n').map((line) => {
    const m = line.match(TIMESTAMP_RE);
    if (!m) return line;
    return `${m[1]}.${m[2]} --> ${m[3]}.${m[4]}`;
  });
  return 'WEBVTT\n\n' + lines.join('\n');
}

// Convert from a file path with a per-(path,mtime,size) memo. Returns a Buffer
// (UTF-8) ready to be written to the response. Throws on read failure so
// the caller can map it to a 404 / 413 / 500.
export async function convertSrtFileToVtt(srtFilePath, fs) {
  const stat = await fs.promises.stat(srtFilePath);
  if (stat.size > MAX_SRT_BYTES) {
    const err = new Error(`SRT file exceeds ${MAX_SRT_BYTES}-byte cap: ${stat.size} bytes`);
    err.code = SRT_TOO_LARGE_CODE;
    err.maxBytes = MAX_SRT_BYTES;
    err.size = stat.size;
    throw err;
  }
  // Size is part of the identity as well: on filesystems with coarse mtime
  // granularity a rewrite can land on the same timestamp, and returning the
  // previous conversion would serve stale cues. A changed size can never be
  // the same content.
  const key = `${srtFilePath}:${stat.mtimeMs}:${stat.size}`;
  const cached = cache.get(key);
  if (cached) return cached;

  // Another request is already converting this exact (path, mtime, size)
  // version: join it instead of reading and converting the file a second time.
  const pending = inflight.get(key);
  if (pending) return pending;

  const conversion = (async () => {
    const raw = await fs.promises.readFile(srtFilePath, 'utf8');
    const vtt = srtToVtt(raw);
    const buf = Buffer.from(vtt, 'utf8');
    cache.set(key, buf);
    return buf;
  })();

  inflight.set(key, conversion);
  try {
    return await conversion;
  } finally {
    // Only clear our own entry: a newer conversion for the same path (after an
    // mtime change) may already have replaced it.
    if (inflight.get(key) === conversion) inflight.delete(key);
  }
}

// Test-only hook so unit tests can clear the cache between runs.
export function _resetSrtCache() {
  cache.clear();
  inflight.clear();
}

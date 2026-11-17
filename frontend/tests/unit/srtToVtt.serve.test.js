import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  convertSrtFileToVtt,
  _resetSrtCache,
  MAX_SRT_BYTES,
  SRT_TOO_LARGE_CODE,
} from '../../server/utils/srtToVtt.js';

let tmpDir;
beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sg-srt-'));
  _resetSrtCache();
});
afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('convertSrtFileToVtt', () => {
  it('reads, converts, and returns a Buffer', async () => {
    const srt = '1\n00:00:01,000 --> 00:00:02,000\nA\n';
    const file = path.join(tmpDir, 'a.srt');
    fs.writeFileSync(file, srt, 'utf8');
    const buf = await convertSrtFileToVtt(file, fs);
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(buf.toString('utf8')).toContain('00:00:01.000 --> 00:00:02.000');
  });

  it('serves cached buffer on the second call when mtime is unchanged', async () => {
    const file = path.join(tmpDir, 'a.srt');
    fs.writeFileSync(file, '1\n00:00:01,000 --> 00:00:02,000\nA\n', 'utf8');
    const a = await convertSrtFileToVtt(file, fs);
    const b = await convertSrtFileToVtt(file, fs);
    expect(b).toBe(a); // identical reference
  });

  it('rejects a subtitle over the size cap with a distinguishable error code', async () => {
    const file = path.join(tmpDir, 'huge.srt');
    fs.writeFileSync(file, Buffer.alloc(MAX_SRT_BYTES + 1, 0x41));

    const readFile = vi.fn(fs.promises.readFile.bind(fs.promises));
    const fakeFs = { promises: { stat: fs.promises.stat.bind(fs.promises), readFile } };

    const err = await convertSrtFileToVtt(file, fakeFs).then(
      () => null,
      (e) => e,
    );
    expect(err).toBeTruthy();
    expect(err.code).toBe(SRT_TOO_LARGE_CODE);
    expect(err.size).toBe(MAX_SRT_BYTES + 1);
    expect(err.maxBytes).toBe(MAX_SRT_BYTES);
    // Rejected from the stat alone: the oversized body never enters memory.
    expect(readFile).not.toHaveBeenCalled();
  });

  it('accepts a subtitle exactly at the size cap', async () => {
    const file = path.join(tmpDir, 'edge.srt');
    fs.writeFileSync(file, Buffer.alloc(MAX_SRT_BYTES, 0x41));
    const buf = await convertSrtFileToVtt(file, fs);
    expect(buf.subarray(0, 6).toString('utf8')).toBe('WEBVTT');
  });

  it('re-converts after the file is rewritten with a newer mtime', async () => {
    const file = path.join(tmpDir, 'a.srt');
    fs.writeFileSync(file, '1\n00:00:01,000 --> 00:00:02,000\nFIRST\n', 'utf8');
    const before = await convertSrtFileToVtt(file, fs);
    const firstStat = fs.statSync(file);

    fs.writeFileSync(file, '1\n00:00:01,000 --> 00:00:02,000\nSECOND\n', 'utf8');
    // Force a distinct mtime even on filesystems with coarse timestamps.
    const bumped = new Date(firstStat.mtimeMs + 2000);
    fs.utimesSync(file, bumped, bumped);

    const after = await convertSrtFileToVtt(file, fs);
    expect(after).not.toBe(before);
    expect(after.toString('utf8')).toContain('SECOND');
    expect(after.toString('utf8')).not.toContain('FIRST');
  });

  it('does not reuse a cached conversion when only the size changed', async () => {
    // Coarse mtime granularity can leave the timestamp untouched after a
    // rewrite; the size is part of the cache identity so stale cues can't win.
    const file = path.join(tmpDir, 'a.srt');
    fs.writeFileSync(file, '1\n00:00:01,000 --> 00:00:02,000\nFIRST\n', 'utf8');
    const first = await convertSrtFileToVtt(file, fs);
    const stat = fs.statSync(file);

    fs.writeFileSync(file, '1\n00:00:01,000 --> 00:00:02,000\nSECOND (longer)\n', 'utf8');
    fs.utimesSync(file, stat.atime, stat.mtime); // restore the original mtime

    const second = await convertSrtFileToVtt(file, fs);
    expect(second).not.toBe(first);
    expect(second.toString('utf8')).toContain('SECOND');
  });

  it('converts once for concurrent requests of the same (path, mtime)', async () => {
    const file = path.join(tmpDir, 'a.srt');
    const srt = '1\n00:00:01,000 --> 00:00:02,000\nA\n';
    fs.writeFileSync(file, srt, 'utf8');

    const readFile = vi.fn(fs.promises.readFile.bind(fs.promises));
    const fakeFs = { promises: { stat: fs.promises.stat.bind(fs.promises), readFile } };

    const results = await Promise.all(
      Array.from({ length: 8 }, () => convertSrtFileToVtt(file, fakeFs)),
    );

    expect(readFile).toHaveBeenCalledTimes(1);
    expect(new Set(results).size).toBe(1); // every caller got the same buffer
  });
});

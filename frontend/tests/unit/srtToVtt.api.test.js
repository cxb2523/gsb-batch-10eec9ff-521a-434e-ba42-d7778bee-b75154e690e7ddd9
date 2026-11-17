import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import { createApp, toNodeListener } from 'h3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getDb } from '../../server/utils/db.js';
import { _resetSrtCache, MAX_SRT_BYTES } from '../../server/utils/srtToVtt.js';
import handler from '../../server/api/content/[...path].js';

const COURSE_ID = 'srt-api-course';
const COURSE_FOLDER = 'Srt Api Course';

let server;
let baseUrl;
let contentDir;
let courseDir;
const previousContentDir = process.env.CONTENT_DIR;

beforeEach(async () => {
  _resetSrtCache();
  contentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sg-srt-api-'));
  courseDir = path.join(contentDir, COURSE_FOLDER);
  fs.mkdirSync(courseDir, { recursive: true });
  process.env.CONTENT_DIR = contentDir;

  getDb()
    .prepare(
      `INSERT INTO courses (id, title, folder_name, data)
       VALUES (?, 'SRT API', ?, '{}')`,
    )
    .run(COURSE_ID, COURSE_FOLDER);

  const app = createApp();
  app.use((event) => {
    event.context.user = { id: 'srt-test-user', isAdmin: 0, is_active: 1 };
  });
  app.use(handler);
  server = createServer(toNodeListener(app));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterEach(async () => {
  getDb().prepare('DELETE FROM courses WHERE id = ?').run(COURSE_ID);
  if (server) {
    await new Promise((resolve) => server.close(resolve));
    server = null;
  }
  fs.rmSync(contentDir, { recursive: true, force: true });
  if (previousContentDir === undefined) delete process.env.CONTENT_DIR;
  else process.env.CONTENT_DIR = previousContentDir;
});

afterAll(() => {
  vi.restoreAllMocks();
});

const subtitleUrl = (name) =>
  `${baseUrl}/api/content/${COURSE_ID}/Lesson%201/${name}`;

const lessonDir = () => path.join(courseDir, 'Lesson 1');
const writeSrt = (name, contents) => {
  fs.mkdirSync(lessonDir(), { recursive: true });
  fs.writeFileSync(path.join(lessonDir(), name), contents);
  return path.join(lessonDir(), name);
};

describe('GET /api/content .vtt backed by a sibling .srt', () => {
  it('converts the .srt and serves text/vtt with a cacheable response', async () => {
    writeSrt('lesson.srt', '1\n00:00:01,000 --> 00:00:02,000\nHello\n');

    const res = await fetch(subtitleUrl('lesson.vtt'));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/vtt');
    expect(res.headers.get('cache-control')).toBe('private, max-age=600');
    const body = await res.text();
    expect(body.startsWith('WEBVTT')).toBe(true);
    expect(body).toContain('00:00:01.000 --> 00:00:02.000');
    expect(body).toContain('Hello');
  });

  it('maps an oversized .srt to 413 with a subtitle-specific message', async () => {
    writeSrt('huge.srt', Buffer.alloc(MAX_SRT_BYTES + 1, 0x41));

    const res = await fetch(subtitleUrl('huge.vtt'));
    expect(res.status).toBe(413);
    const payload = await res.json();
    expect(payload.statusCode).toBe(413);
    expect(payload.statusMessage).toMatch(/subtitle/i);
    expect(payload.statusMessage).toMatch(/too large/i);
    expect(payload.data?.code).toBe('ESRTTOOLARGE');
    expect(payload.data?.size).toBe(MAX_SRT_BYTES + 1);
  });

  it('still returns 404 when neither the .vtt nor a sibling .srt exists', async () => {
    const res = await fetch(subtitleUrl('missing.vtt'));
    expect(res.status).toBe(404);
  });

  it('keeps a genuine conversion failure a generic 500', async () => {
    // An .srt path that exists but cannot be read as a file (a directory)
    // exercises the non-ENOENT, non-size error branch.
    fs.mkdirSync(path.join(lessonDir(), 'broken.srt'), { recursive: true });

    const res = await fetch(subtitleUrl('broken.vtt'));
    expect(res.status).toBe(500);
  });

  it('re-converts after the .srt is rewritten with a newer mtime', async () => {
    const file = writeSrt('lesson.srt', '1\n00:00:01,000 --> 00:00:02,000\nFIRST\n');

    const first = await fetch(subtitleUrl('lesson.vtt'));
    expect(await first.text()).toContain('FIRST');

    const firstStat = fs.statSync(file);
    fs.writeFileSync(file, '1\n00:00:01,000 --> 00:00:02,000\nSECOND\n', 'utf8');
    const bumped = new Date(firstStat.mtimeMs + 2000);
    fs.utimesSync(file, bumped, bumped);

    const second = await fetch(subtitleUrl('lesson.vtt'));
    const body = await second.text();
    expect(body).toContain('SECOND');
    expect(body).not.toContain('FIRST');
  });

  it('reads the .srt once for concurrent requests of the same version', async () => {
    writeSrt('lesson.srt', '1\n00:00:01,000 --> 00:00:02,000\nA\n');

    const realReadFile = fs.promises.readFile.bind(fs.promises);
    let reads = 0;
    const spy = vi.spyOn(fs.promises, 'readFile').mockImplementation(async (...args) => {
      reads += 1;
      // Widen the window so a missing in-flight dedupe would be observed.
      await new Promise((resolve) => setTimeout(resolve, 25));
      return realReadFile(...args);
    });

    try {
      const responses = await Promise.all(
        Array.from({ length: 6 }, () => fetch(subtitleUrl('lesson.vtt'))),
      );
      const bodies = await Promise.all(responses.map((r) => r.text()));
      expect(responses.every((r) => r.status === 200)).toBe(true);
      expect(bodies.every((b) => b === bodies[0])).toBe(true);
      expect(reads).toBe(1);
    } finally {
      spy.mockRestore();
    }
  });
});

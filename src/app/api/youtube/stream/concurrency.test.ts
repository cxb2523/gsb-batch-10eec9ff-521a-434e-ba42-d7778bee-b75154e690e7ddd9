import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * End-to-end concurrency test for `/api/youtube/stream`: five simultaneous
 * Range requests (a seek-bar drag) all find the cached direct URL revoked.
 * They must share a single re-extraction and all recover, instead of one parse
 * per request or a partial set of 502s.
 *
 * Only the players (youtubei.js / yt-dlp) and rate limiting are faked; the real
 * cache, invalidation and in-flight de-duplication in `@/lib/youtube-stream` are
 * exercised.
 */

const players = vi.hoisted(() => ({
  attempts: 0,
  fail: false,
  gate: null as null | { promise: Promise<void>; resolve: () => void },
}));

vi.mock("youtubei.js", () => ({
  ClientType: { ANDROID_VR: "ANDROID_VR", MWEB: "MWEB", WEB: "WEB" },
  Innertube: {
    create: vi.fn(async () => ({
      getBasicInfo: async (videoId: string) => {
        players.attempts += 1;
        if (players.gate) await players.gate.promise;
        if (players.fail) throw new Error("bot check");
        const url = `https://fake.example/${videoId}-${players.attempts}`;
        return {
          chooseFormat: () => ({ url, mime_type: "audio/mp4", decipher: async () => url }),
        };
      },
      session: { player: {} },
    })),
  },
  Platform: { shim: {} },
}));

vi.mock("node:child_process", () => ({
  spawn: vi.fn(() => {
    throw new Error("yt-dlp not installed in tests");
  }),
}));

vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: vi.fn(async () => true),
  ipKey: vi.fn(() => "test-ip"),
}));

const VIDEO = "dQw4w9WgXcQ";
const STALE = `https://fake.example/${VIDEO}-1`;

const request = (range?: string) =>
  new Request(`http://localhost/api/youtube/stream?videoId=${VIDEO}`, {
    headers: range ? { Range: range } : undefined,
  });

const audioResponse = () =>
  new Response("audio-bytes", {
    status: 200,
    headers: { "content-type": "audio/mp4", "content-length": "11" },
  });

describe("GET /api/youtube/stream concurrency", () => {
  beforeEach(() => {
    players.attempts = 0;
    players.fail = false;
    players.gate = null;
    vi.resetModules();
  });

  it("shares one re-extraction across concurrent requests that hit a revoked URL", async () => {
    // The first extraction's direct URL works for the warm-up request, then
    // YouTube revokes it: only URLs extracted after the first attempt work.
    const fetchMock = vi.fn(async (target: string) => (target === STALE ? new Response("revoked", { status: 403 }) : audioResponse()));
    vi.stubGlobal("fetch", fetchMock);

    const { GET } = await import("@/app/api/youtube/stream/route");

    // Warm the cache; let this first fetch succeed so no re-extraction happens.
    fetchMock.mockResolvedValueOnce(audioResponse());
    expect((await GET(request("bytes=0-1023"))).status).toBe(200);
    expect(players.attempts).toBe(1);

    // Hold the re-extraction open so every concurrent request arrives while it
    // is still in flight.
    let release!: () => void;
    players.gate = { promise: new Promise<void>((res) => (release = res)), resolve: () => release() };

    const pending = Array.from({ length: 5 }, (_, i) => GET(request(`bytes=${i * 1024}-${i * 1024 + 1023}`)));
    await vi.waitFor(() => expect(players.attempts).toBe(2));
    // Give the remaining requests a chance to reach the extraction stage.
    await new Promise((res) => setTimeout(res, 50));
    release();

    const responses = await Promise.all(pending);

    expect(responses.map((r) => r.status)).toEqual([200, 200, 200, 200, 200]);
    expect(await Promise.all(responses.map((r) => r.text()))).toEqual(Array(5).fill("audio-bytes"));
    // Initial extraction + exactly one shared re-extraction.
    expect(players.attempts).toBe(2);
    // Warm-up + each of the five concurrent requests fetched the revoked URL
    // once, then the fresh one.
    expect(fetchMock.mock.calls.filter(([target]) => target === STALE)).toHaveLength(6);
    vi.unstubAllGlobals();
  });

  it("returns 502 when the re-extraction fails, then retries on the next request", async () => {
    const fetchMock = vi.fn(async () => new Response("revoked", { status: 403 }));
    vi.stubGlobal("fetch", fetchMock);

    const { GET } = await import("@/app/api/youtube/stream/route");

    // First extraction succeeds; the URL is then revoked upstream.
    fetchMock.mockResolvedValueOnce(audioResponse());
    expect((await GET(request())).status).toBe(200);
    expect(players.attempts).toBe(1);

    // Make every subsequent extraction fail.
    players.fail = true;

    expect((await GET(request())).status).toBe(502);
    const attemptsAfterFailure = players.attempts;
    expect(attemptsAfterFailure).toBeGreaterThan(1);

    // The failure was not cached: the next request tries extraction again.
    expect((await GET(request())).status).toBe(502);
    expect(players.attempts).toBeGreaterThan(attemptsAfterFailure);

    vi.unstubAllGlobals();
  });
});

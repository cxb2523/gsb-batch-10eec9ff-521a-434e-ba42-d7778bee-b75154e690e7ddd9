import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Unit tests for the extraction/cache layer behind `/api/youtube/stream`.
 *
 * youtubei.js and yt-dlp are stubbed so the tests only exercise the cache,
 * invalidation and in-flight de-duplication: a seek bar drag fires many Range
 * requests at once, and when the cached direct URL has been revoked they must
 * all share a single re-extraction instead of each burning a parse.
 */

const yt = vi.hoisted(() => ({
  /** Number of times the fake player extraction was started. */
  attempts: 0,
  fail: false,
  gate: null as null | { promise: Promise<void>; resolve: () => void },
}));

const spawnMock = vi.hoisted(() => vi.fn());

vi.mock("youtubei.js", () => ({
  ClientType: { ANDROID_VR: "ANDROID_VR", MWEB: "MWEB", WEB: "WEB" },
  Innertube: {
    create: vi.fn(async () => ({
      getBasicInfo: async (videoId: string) => {
        yt.attempts += 1;
        if (yt.gate) await yt.gate.promise;
        if (yt.fail) throw new Error("bot check");
        const url = `https://fake.example/${videoId}-${yt.attempts}`;
        return {
          chooseFormat: () => ({
            url,
            mime_type: "audio/mp4",
            decipher: async () => url,
          }),
        };
      },
      session: { player: {} },
    })),
  },
  Platform: { shim: {} },
}));

vi.mock("node:child_process", () => ({ spawn: spawnMock }));

const VIDEO = "dQw4w9WgXcQ";

/** Fresh module instance per test so the in-memory cache starts empty. */
async function loadStream(): Promise<typeof import("@/lib/youtube-stream")> {
  vi.resetModules();
  return await import("@/lib/youtube-stream");
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe("youtube-stream extraction", () => {
  beforeEach(() => {
    yt.attempts = 0;
    yt.fail = false;
    yt.gate = null;
    spawnMock.mockReset();
    // Any fallback to yt-dlp fails fast; tests that care about the fallback
    // count its invocation rather than running a real process.
    spawnMock.mockImplementation(() => {
      throw new Error("yt-dlp not installed in tests");
    });
  });

  it("extracts a URL once and serves later calls from the cache", async () => {
    const { extractStreamUrl } = await loadStream();

    const first = await extractStreamUrl(VIDEO);
    const second = await extractStreamUrl(VIDEO);

    expect(first.url).toMatch(/^https:\/\/fake\.example\//);
    expect(second).toEqual(first);
    expect(yt.attempts).toBe(1);
  });

  it("shares one in-flight extraction between concurrent callers", async () => {
    const { extractStreamUrl } = await loadStream();
    const gate = deferred();
    yt.gate = gate;

    const pending = Array.from({ length: 5 }, () => extractStreamUrl(VIDEO));
    await vi.waitFor(() => expect(yt.attempts).toBe(1));
    gate.resolve();

    const results = await Promise.all(pending);
    expect(yt.attempts).toBe(1);
    expect(new Set(results.map((r) => r.url)).size).toBe(1);
  });

  it("re-extracts only once for concurrent callers after invalidation", async () => {
    const { extractStreamUrl, invalidateStreamCache } = await loadStream();

    const stale = await extractStreamUrl(VIDEO);
    expect(yt.attempts).toBe(1);
    invalidateStreamCache(VIDEO, stale.url);

    const gate = deferred();
    yt.gate = gate;
    const pending = Array.from({ length: 5 }, () => extractStreamUrl(VIDEO));
    await vi.waitFor(() => expect(yt.attempts).toBe(2));
    gate.resolve();

    const results = await Promise.all(pending);
    expect(yt.attempts).toBe(2);
    expect(results.every((r) => r.url !== stale.url)).toBe(true);
    expect(new Set(results.map((r) => r.url)).size).toBe(1);
  });

  it("does not leave a failed extraction permanently cached", async () => {
    const { extractStreamUrl } = await loadStream();

    yt.fail = true;
    await expect(extractStreamUrl(VIDEO)).rejects.toThrow();
    expect(spawnMock).toHaveBeenCalledTimes(1);

    yt.fail = false;
    const recovered = await extractStreamUrl(VIDEO);
    expect(recovered.url).toMatch(/^https:\/\/fake\.example\//);
    // One failed extraction (3 client attempts + yt-dlp) plus one success.
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(yt.attempts).toBe(4);
  });

  it("shares a failing extraction between concurrent callers, then retries", async () => {
    const { extractStreamUrl } = await loadStream();
    yt.fail = true;

    const results = await Promise.allSettled(Array.from({ length: 5 }, () => extractStreamUrl(VIDEO)));
    expect(results.every((r) => r.status === "rejected")).toBe(true);
    expect(yt.attempts).toBe(3); // three youtube.js clients, one extraction
    expect(spawnMock).toHaveBeenCalledTimes(1);

    yt.fail = false;
    const recovered = await extractStreamUrl(VIDEO);
    expect(recovered.url).toMatch(/^https:\/\/fake\.example\//);
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it("keeps a newer cached entry when an older stale URL is invalidated", async () => {
    const { extractStreamUrl, invalidateStreamCache } = await loadStream();

    const first = await extractStreamUrl(VIDEO);
    expect(yt.attempts).toBe(1);
    invalidateStreamCache(VIDEO, first.url);
    const second = await extractStreamUrl(VIDEO);
    expect(second.url).not.toBe(first.url);
    expect(yt.attempts).toBe(2);

    // A concurrent request still holding the old URL must not evict the entry
    // that was refreshed in the meantime.
    invalidateStreamCache(VIDEO, first.url);
    await extractStreamUrl(VIDEO);
    expect(yt.attempts).toBe(2);

    // Evicting the entry that actually is cached re-extracts.
    invalidateStreamCache(VIDEO, second.url);
    await extractStreamUrl(VIDEO);
    expect(yt.attempts).toBe(3);
  });

  it("invalidates unconditionally when no stale URL is given", async () => {
    const { extractStreamUrl, invalidateStreamCache } = await loadStream();

    await extractStreamUrl(VIDEO);
    invalidateStreamCache(VIDEO);
    await extractStreamUrl(VIDEO);

    expect(yt.attempts).toBe(2);
  });
});

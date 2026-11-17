import WebGLTextureLoaderAsyncHashCache from "./WebGLTextureLoaderAsyncHashCache.js";

const mockGL = (deleted: WebGLTexture[] = []) =>
  ({
    deleteTexture: (t: WebGLTexture) => {
      deleted.push(t);
    },
  }) as unknown as WebGLRenderingContext;

class FakeLoader extends WebGLTextureLoaderAsyncHashCache<number> {
  loadNoCacheCalls = 0;
  override canLoad(input: unknown) {
    return typeof input === "number";
  }
  override inputHash(input: number) {
    return input;
  }
  override loadNoCache(input: number) {
    this.loadNoCacheCalls++;
    return {
      promise: Promise.resolve({
        texture: { id: input } as unknown as WebGLTexture,
        width: 2,
        height: 2,
      }),
      dispose: () => {},
    };
  }
}

test("load resolves and get returns the same value afterwards", async () => {
  const loader = new FakeLoader(mockGL());
  const res = await loader.load(42);
  expect(res).toMatchObject({ width: 2, height: 2 });
  expect(loader.get(42)).toBe(res);
  expect(loader.get(43)).toBeUndefined();
  loader.dispose();
});

test("load is idempotent: same input returns the exact same Promise", () => {
  const loader = new FakeLoader(mockGL());
  const p1 = loader.load(42);
  const p2 = loader.load(42);
  expect(p1).toBe(p2);
  expect(loader.loadNoCacheCalls).toBe(1);
  loader.dispose();
});

test("cancelLoad invokes the underlying dispose and clears the promise", () => {
  let underlyingDisposed = false;
  class CancelableLoader extends WebGLTextureLoaderAsyncHashCache<number> {
    override canLoad(input: unknown) {
      return typeof input === "number";
    }
    override inputHash(input: number) {
      return input;
    }
    override loadNoCache(_input: number) {
      return {
        promise: new Promise<{
          texture: WebGLTexture;
          width: number;
          height: number;
        }>(() => {}),
        dispose: () => {
          underlyingDisposed = true;
        },
      };
    }
  }
  const loader = new CancelableLoader(mockGL());
  loader.load(42);
  loader.cancelLoad(42);
  expect(underlyingDisposed).toBe(true);
  // After cancel, a fresh load() must call loadNoCache again.
  underlyingDisposed = false;
  loader.load(42);
  expect(underlyingDisposed).toBe(false);
});

test("dispose during pending load: pending load resolves but result is dropped", async () => {
  let resolveLoad!: (v: { texture: WebGLTexture; width: number; height: number }) => void;
  class SlowLoader extends WebGLTextureLoaderAsyncHashCache<number> {
    override canLoad(input: unknown) {
      return typeof input === "number";
    }
    override inputHash(input: number) {
      return input;
    }
    override loadNoCache(_input: number) {
      return {
        promise: new Promise<{
          texture: WebGLTexture;
          width: number;
          height: number;
        }>((r) => {
          resolveLoad = r;
        }),
        dispose: () => {},
      };
    }
  }
  const loader = new SlowLoader(mockGL());
  const p = loader.load(42);
  loader.dispose();
  resolveLoad({
    texture: {} as WebGLTexture,
    width: 1,
    height: 1,
  });
  // The promise should never resolve (dispose drops the result).
  const winner = await Promise.race([
    p.then(() => "resolved"),
    new Promise((r) => setTimeout(r, 10, "timeout")),
  ]);
  expect(winner).toBe("timeout");
});

test("dispose deletes every cached texture exactly once", async () => {
  const deleted: WebGLTexture[] = [];
  const loader = new FakeLoader(mockGL(deleted));
  const a = await loader.load(1);
  const b = await loader.load(2);
  loader.dispose();
  expect(deleted).toEqual([a.texture, b.texture]);
});

test("loadNoCache rejection propagates", async () => {
  class FailingLoader extends WebGLTextureLoaderAsyncHashCache<number> {
    override canLoad(input: unknown) {
      return typeof input === "number";
    }
    override inputHash(input: number) {
      return input;
    }
    override loadNoCache(_input: number) {
      return {
        promise: Promise.reject(new Error("boom")),
        dispose: () => {},
      };
    }
  }
  const loader = new FailingLoader(mockGL());
  await expect(loader.load(42)).rejects.toThrow(/boom/);
});

test("load after dispose rejects and does not load or cache anything", async () => {
  const deleted: WebGLTexture[] = [];
  const loader = new FakeLoader(mockGL(deleted));
  loader.dispose();
  expect(loader.loadNoCacheCalls).toBe(0);
  await expect(loader.load(42)).rejects.toThrow(/disposed/);
  expect(loader.loadNoCacheCalls).toBe(0);
  expect(loader.get(42)).toBeUndefined();
  expect(loader.results.size).toBe(0);
  expect(loader.promises.size).toBe(0);
  expect(deleted).toEqual([]);
});

test("repeated dispose deletes every cached texture only once", async () => {
  const deleted: WebGLTexture[] = [];
  const loader = new FakeLoader(mockGL(deleted));
  const a = await loader.load(1);
  const b = await loader.load(2);
  loader.dispose();
  loader.dispose();
  loader.dispose();
  expect(deleted).toEqual([a.texture, b.texture]);
});

test("cancelLoad then immediate reload calls loadNoCache again and keeps the new dispose", async () => {
  const resolvers: ((value: { texture: WebGLTexture; width: number; height: number }) => void)[] =
    [];
  const disposes: jest.Mock[] = [];
  const textures: WebGLTexture[] = [];
  class RacyLoader extends WebGLTextureLoaderAsyncHashCache<number> {
    loadNoCacheCalls = 0;
    override canLoad(input: unknown) {
      return typeof input === "number";
    }
    override inputHash(input: number) {
      return input;
    }
    override loadNoCache(_input: number) {
      this.loadNoCacheCalls++;
      const texture = { id: this.loadNoCacheCalls } as unknown as WebGLTexture;
      textures.push(texture);
      const dispose = jest.fn();
      disposes.push(dispose);
      return {
        promise: new Promise<{
          texture: WebGLTexture;
          width: number;
          height: number;
        }>((resolve) => {
          resolvers.push(resolve);
        }),
        dispose,
      };
    }
  }
  const loader = new RacyLoader(mockGL());
  const oldPromise = loader.load(42);
  loader.cancelLoad(42);
  expect(disposes[0]).toHaveBeenCalledTimes(1);

  const newPromise = loader.load(42);
  expect(newPromise).not.toBe(oldPromise);
  expect(loader.loadNoCacheCalls).toBe(2);

  // The stale first request resolves afterwards. Its result must be dropped
  // and it must not touch the new request's dispose callback.
  resolvers[0]({ texture: textures[0], width: 1, height: 1 });
  const oldWinner = await Promise.race([
    oldPromise.then(() => "resolved"),
    new Promise((r) => setTimeout(r, 10, "timeout")),
  ]);
  expect(oldWinner).toBe("timeout");
  expect(loader.get(42)).toBeUndefined();
  expect(disposes[0]).toHaveBeenCalledTimes(1);
  expect(disposes[1]).not.toHaveBeenCalled();

  // The new request's dispose callback is still wired up.
  loader.cancelLoad(42);
  expect(disposes[1]).toHaveBeenCalledTimes(1);

  // And once re-cancelled, the new promise must not land either.
  resolvers[1]({ texture: textures[1], width: 1, height: 1 });
  const newWinner = await Promise.race([
    newPromise.then(() => "resolved"),
    new Promise((r) => setTimeout(r, 10, "timeout")),
  ]);
  expect(newWinner).toBe("timeout");
  expect(loader.get(42)).toBeUndefined();
});

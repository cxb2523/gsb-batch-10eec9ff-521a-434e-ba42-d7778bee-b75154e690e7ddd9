import { describe, expect, it, vi } from "vitest";
import {
  PlaneArtManager,
  type PlaneArtFactory,
  type PlaneArtHandle,
} from "./PlaneArtManager";

function createHandle(url: string) {
  const handle: PlaneArtHandle & {
    disposed: boolean;
    transforms: Array<[number, number]>;
  } = {
    sourceUrl: url,
    disposed: false,
    transforms: [],
    syncTransform(y, rotationZ) {
      this.transforms.push([y, rotationZ]);
    },
    dispose() {
      this.disposed = true;
    },
  };
  return handle;
}

function createFactory() {
  const created: Array<ReturnType<typeof createHandle>> = [];
  const factory: PlaneArtFactory & {
    created: typeof created;
    create: ReturnType<typeof vi.fn>;
  } = {
    created,
    create: vi.fn((url: string) => {
      const handle = createHandle(url);
      created.push(handle);
      return handle;
    }),
  };
  return factory;
}

function createFallback() {
  return {
    visible: true,
    setVisible(visible: boolean) {
      this.visible = visible;
    },
  };
}

describe("PlaneArtManager", () => {
  it("starts with no custom art", () => {
    const manager = new PlaneArtManager(createFactory());
    expect(manager.current).toBeNull();
  });

  it("creates custom art and hides the fallback player", () => {
    const factory = createFactory();
    const manager = new PlaneArtManager(factory);
    const fallback = createFallback();

    manager.show("data:image/png;base64,plane-1", fallback);

    expect(factory.create).toHaveBeenCalledWith(
      "data:image/png;base64,plane-1"
    );
    expect(manager.current?.sourceUrl).toBe("data:image/png;base64,plane-1");
    expect(fallback.visible).toBe(false);
  });

  it("releases the previous mesh, material, and texture when switching art", () => {
    const factory = createFactory();
    const manager = new PlaneArtManager(factory);
    const fallback = createFallback();

    manager.show("data:image/png;base64,plane-1", fallback);
    const first = factory.created[0];
    manager.show("data:image/png;base64,plane-2", fallback);

    expect(first.disposed).toBe(true);
    expect(manager.current?.sourceUrl).toBe("data:image/png;base64,plane-2");
    expect(fallback.visible).toBe(false);
    expect(factory.create).toHaveBeenCalledTimes(2);
  });

  it("does not rebuild art when the same url is reapplied", () => {
    const factory = createFactory();
    const manager = new PlaneArtManager(factory);
    const fallback = createFallback();

    manager.show("data:image/png;base64,plane-1", fallback);
    manager.show("data:image/png;base64,plane-1", fallback);

    expect(factory.create).toHaveBeenCalledTimes(1);
    expect(factory.created[0].disposed).toBe(false);
    expect(fallback.visible).toBe(false);
  });

  it("restores the fallback player and disposes art when cleared", () => {
    const factory = createFactory();
    const manager = new PlaneArtManager(factory);
    const fallback = createFallback();

    manager.show("data:image/png;base64,plane-1", fallback);
    manager.clear(fallback);

    expect(factory.created[0].disposed).toBe(true);
    expect(manager.current).toBeNull();
    expect(fallback.visible).toBe(true);
  });

  it("clearing with no active art still shows the fallback", () => {
    const manager = new PlaneArtManager(createFactory());
    const fallback = createFallback();

    manager.clear(fallback);

    expect(fallback.visible).toBe(true);
  });

  it("treats an empty url as a clear request", () => {
    const factory = createFactory();
    const manager = new PlaneArtManager(factory);
    const fallback = createFallback();

    manager.show("data:image/png;base64,plane-1", fallback);
    manager.show("", fallback);

    expect(factory.created[0].disposed).toBe(true);
    expect(manager.current).toBeNull();
    expect(fallback.visible).toBe(true);
  });

  it("mirrors transform updates onto the active art only", () => {
    const factory = createFactory();
    const manager = new PlaneArtManager(factory);
    const fallback = createFallback();

    manager.syncTransform(1, 0.5);
    expect(factory.created).toHaveLength(0);

    manager.show("data:image/png;base64,plane-1", fallback);
    manager.syncTransform(2.25, -0.4);
    manager.syncTransform(0, 0.1);

    expect(factory.created[0].transforms).toEqual([
      [2.25, -0.4],
      [0, 0.1],
    ]);
  });

  it("disposes active art on teardown and is safe to call twice", () => {
    const factory = createFactory();
    const manager = new PlaneArtManager(factory);
    const fallback = createFallback();

    manager.show("data:image/png;base64,plane-1", fallback);
    manager.dispose();
    manager.dispose();

    expect(factory.created[0].disposed).toBe(true);
    expect(manager.current).toBeNull();
  });

  it("survives repeated show/clear cycles without leaking handles", () => {
    const factory = createFactory();
    const manager = new PlaneArtManager(factory);
    const fallback = createFallback();

    for (const id of [1, 2, 3]) {
      manager.show(`data:image/png;base64,plane-${id}`, fallback);
    }
    manager.clear(fallback);

    expect(factory.created).toHaveLength(3);
    expect(factory.created.every(handle => handle.disposed)).toBe(true);
    expect(manager.current).toBeNull();
  });
});

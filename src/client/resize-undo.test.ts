import assert from "node:assert/strict";
import { test } from "node:test";
import { ResizeUndoManager, type ResizePhase, type ResizeUndoAdapter } from "./resize-undo";

interface FakeLoad {
  pageId: string;
  json: string;
  resolve: () => void;
}

function makeAdapter(initialIds: string[]) {
  const ids = new Set(initialIds);
  const dimensionCalls: Array<{ width: number; height: number }> = [];
  const loads: FakeLoad[] = [];
  const adapter: ResizeUndoAdapter = {
    pageIds: () => [...ids],
    applyDimensions: (width, height) => dimensionCalls.push({ width, height }),
    loadPage: (pageId, json) =>
      new Promise<void>((resolve) => {
        loads.push({ pageId, json, resolve });
      }),
  };
  return {
    adapter,
    ids,
    dimensionCalls,
    loads,
    settle: (index = 0) => {
      const load = loads[index];
      assert.ok(load, `load #${index} does not exist`);
      load.resolve();
    },
    settleAll: () => {
      const pending = loads.splice(0);
      pending.forEach((l) => l.resolve());
      return pending;
    },
  };
}

function makeManager(initialIds: string[]) {
  const fake = makeAdapter(initialIds);
  const phases: ResizePhase[] = [];
  const restored: Array<{ pageId: string; json: string; historyIndex: number; historyLength: number }> = [];
  const manager = new ResizeUndoManager(
    fake.adapter,
    (phase) => phases.push(phase),
    (page) =>
      restored.push({
        pageId: page.pageId,
        json: page.json,
        historyIndex: page.history.index,
        historyLength: page.history.entries.length,
      })
  );
  return { ...fake, phases, restored, manager };
}

const capture = (tag: string) => (pageId: string) => ({
  json: `${tag}:${pageId}:json`,
  history: { entries: [`${tag}:${pageId}:h0`, `${tag}:${pageId}:h1`], index: 1 },
});

test("starts idle with no resize to undo", () => {
  const { manager } = makeManager(["p1"]);
  assert.equal(manager.currentPhase, "idle");
  assert.equal(manager.canUndo, false);
});

test("arm snapshots every mounted page with independent history copies", () => {
  const t = makeManager(["p1", "p2"]);
  t.manager.arm(800, 600, capture("before"));

  assert.equal(t.manager.currentPhase, "armed");
  assert.equal(t.manager.canUndo, true);
  assert.deepEqual(t.phases, ["armed"]);
});

test("immediate undo restores frame and every page plus the pre-resize history", async () => {
  const t = makeManager(["p1", "p2"]);
  t.manager.arm(800, 600, capture("before"));

  const done = t.manager.undo();
  // Frame flips synchronously for all canvases before any artwork resolves.
  assert.equal(t.manager.currentPhase, "restoring");
  assert.deepEqual(t.dimensionCalls, [{ width: 800, height: 600 }]);
  assert.equal(t.loads.length, 2);
  assert.deepEqual(t.loads.map((l) => l.pageId).sort(), ["p1", "p2"]);
  assert.deepEqual(t.loads.map((l) => l.json).sort(), [
    "before:p1:json",
    "before:p2:json",
  ]);

  t.settleAll();
  await done;

  assert.equal(t.manager.currentPhase, "idle");
  assert.equal(t.manager.canUndo, false);
  // Each page gets its own pre-resize history stack back, not a reset one.
  assert.deepEqual(
    t.restored.map((r) => [r.pageId, r.json, r.historyIndex, r.historyLength]),
    [
      ["p1", "before:p1:json", 1, 2],
      ["p2", "before:p2:json", 1, 2],
    ]
  );
  assert.deepEqual(t.phases, ["armed", "restoring", "idle"]);
});

test("undo is a no-op when idle", async () => {
  const t = makeManager(["p1"]);
  await t.manager.undo();
  assert.equal(t.manager.currentPhase, "idle");
  assert.equal(t.dimensionCalls.length, 0);
  assert.equal(t.loads.length, 0);
  assert.equal(t.restored.length, 0);
});

test("any invalidate after arming makes the resize permanently non-undoable", () => {
  const t = makeManager(["p1", "p2"]);
  t.manager.arm(800, 600, capture("before"));

  t.manager.invalidate();
  assert.equal(t.manager.currentPhase, "idle");
  assert.equal(t.manager.canUndo, false);
  assert.deepEqual(t.phases, ["armed", "idle"]);

  // The entry stays gone even if invalidation fires again (more edits).
  t.manager.invalidate();
  assert.equal(t.manager.currentPhase, "idle");
  assert.deepEqual(t.phases, ["armed", "idle"]);
});

test("invalidation followed by undo never touches the canvases", async () => {
  const t = makeManager(["p1"]);
  t.manager.arm(800, 600, capture("before"));
  t.manager.invalidate();

  await t.manager.undo();

  assert.equal(t.dimensionCalls.length, 0);
  assert.equal(t.loads.length, 0);
  assert.equal(t.restored.length, 0);
});

test("invalidate while idle does nothing", () => {
  const t = makeManager(["p1"]);
  t.manager.invalidate();
  assert.deepEqual(t.phases, []);
  assert.equal(t.manager.currentPhase, "idle");
});

test("an armed snapshot survives until restore settles and cannot be re-undone", async () => {
  const t = makeManager(["p1"]);
  t.manager.arm(800, 600, capture("before"));
  const done = t.manager.undo();
  t.settleAll();
  await done;

  // Second press does nothing: the snapshot was consumed.
  await t.manager.undo();
  assert.equal(t.dimensionCalls.length, 1);
  assert.equal(t.restored.length, 1);
});

test("page switch during restore cannot interleave: all pages still converge", async () => {
  const t = makeManager(["p1", "p2"]);
  t.manager.arm(800, 600, capture("before"));
  const done = t.manager.undo();

  // Pages settle one at a time, in arbitrary order.
  t.settle(1);
  assert.equal(t.manager.currentPhase, "restoring");
  t.settle(0);
  await done;

  assert.equal(t.manager.currentPhase, "idle");
  assert.equal(t.restored.length, 2);
  // Frame was only ever retargeted once, to the pre-resize dimensions.
  assert.deepEqual(t.dimensionCalls, [{ width: 800, height: 600 }]);
});

test("a page unregistered mid-restore is skipped without stranding the round", async () => {
  const t = makeManager(["p1", "p2"]);
  t.manager.arm(800, 600, capture("before"));
  const done = t.manager.undo();

  // p2's canvas unmounts (page deleted) while its load is still pending.
  t.ids.delete("p2");
  t.settleAll();
  await done;

  assert.equal(t.manager.currentPhase, "idle");
  // Only the still-mounted page receives history; the deleted page is not
  // restored onto anything.
  assert.deepEqual(t.restored.map((r) => r.pageId), ["p1"]);
});

test("deleting a captured page while armed withdraws the undo entry", () => {
  const t = makeManager(["p1", "p2"]);
  t.manager.arm(800, 600, capture("before"));

  t.manager.notePageUnregistered("p2");
  assert.equal(t.manager.currentPhase, "idle");
  assert.equal(t.manager.canUndo, false);
});

test("unregistering an unknown page while armed leaves the snapshot usable", () => {
  const t = makeManager(["p1"]);
  t.manager.arm(800, 600, capture("before"));

  t.manager.notePageUnregistered("ghost");
  assert.equal(t.manager.currentPhase, "armed");
});

test("a newly added page unknown to the armed snapshot invalidates it", () => {
  const t = makeManager(["p1"]);
  t.manager.arm(800, 600, capture("before"));

  t.manager.notePageRegistered("p2");
  assert.equal(t.manager.currentPhase, "idle");
  assert.equal(t.manager.canUndo, false);
});

test("re-registering a page the snapshot already covers keeps it armed", () => {
  const t = makeManager(["p1"]);
  t.manager.arm(800, 600, capture("before"));

  t.manager.notePageRegistered("p1");
  assert.equal(t.manager.currentPhase, "armed");
});

test("clear during restoring cancels stale completions before they write", async () => {
  const t = makeManager(["p1", "p2"]);
  t.manager.arm(800, 600, capture("before"));
  const done = t.manager.undo();

  // Editor leaves / a design switch tears the snapshot down mid-flight.
  t.manager.clear();
  assert.equal(t.manager.currentPhase, "idle");
  t.settleAll();
  await done;

  // The late loads resolve but never deliver history into the new session.
  assert.equal(t.restored.length, 0);
});

test("a failed page load does not strand the others in the restoring phase", async () => {
  const ids = new Set(["p1"]);
  const dimensionCalls: Array<{ width: number; height: number }> = [];
  const restored: string[] = [];
  const manager = new ResizeUndoManager(
    {
      pageIds: () => [...ids],
      applyDimensions: (width, height) => dimensionCalls.push({ width, height }),
      loadPage: async () => {
        throw new Error("image decode failed");
      },
    },
    () => {},
    (page) => restored.push(page.pageId)
  );
  manager.arm(800, 600, capture("before"));
  await manager.undo();

  assert.equal(manager.currentPhase, "idle");
  assert.deepEqual(dimensionCalls, [{ width: 800, height: 600 }]);
  assert.deepEqual(restored, []);
});

test("mutating the captured memento after arming cannot corrupt the snapshot", async () => {
  const t = makeManager(["p1"]);
  const memento = { entries: ["h0", "h1"], index: 1 };
  t.manager.arm(800, 600, () => ({
    json: "snapshot-json",
    history: memento,
  }));
  // The caller's stack moves on with new edits.
  memento.entries.push("h2");
  memento.index = 2;

  // The restore hands back the frozen copy, not the mutated live stack.
  t.adapter.loadPage = async () => {};
  await t.manager.undo();
  assert.deepEqual(t.restored, [
    { pageId: "p1", json: "snapshot-json", historyIndex: 1, historyLength: 2 },
  ]);
});

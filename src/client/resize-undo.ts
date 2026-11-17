/**
 * Owns the lifecycle of the cross-page "undo resize" snapshot.
 *
 * A resize touches every page at once, so it cannot live in the per-page undo
 * stacks. This manager makes the two histories mutually exclusive:
 *
 * - `idle`      — no resize to undo. Any edit is a normal per-page edit.
 * - `armed`     — a snapshot of every page exists and the resize is undoable.
 *                 The first edit on any page invalidates it for good, so the
 *                 per-page history can never drag a page back to an old frame.
 * - `restoring` — `undo()` is replaying the snapshot onto every page. No edit
 *                 may land in this window; a generation token ensures late
 *                 async completions (page deleted, editor left, another
 *                 resize) cannot write onto canvases that moved on.
 *
 * The manager is deliberately free of Fabric and DOM: callers inject an
 * adapter for the canvas side effects, which keeps the transition rules
 * testable under plain Node.
 */

export type ResizePhase = "idle" | "armed" | "restoring";

export interface HistoryMemento {
  entries: string[];
  index: number;
}

export interface PageSnapshot {
  /** Serialised canvas content as it was before the resize. */
  json: string;
  /** Per-page undo stack as it was before the resize. */
  history: HistoryMemento;
}

export interface RestoredPage {
  pageId: string;
  json: string;
  history: HistoryMemento;
}

export interface ResizeUndoAdapter {
  /** Page ids whose canvases are currently mounted. */
  pageIds: () => string[];
  /** Retarget every mounted canvas to a frame synchronously. */
  applyDimensions: (width: number, height: number) => void;
  /** Replace one page's artwork. Rejected once must not strand the others. */
  loadPage: (pageId: string, json: string) => Promise<void>;
}

interface StoredSnapshot {
  width: number;
  height: number;
  pages: Map<string, PageSnapshot>;
}

export class ResizeUndoManager {
  private snapshot: StoredSnapshot | null = null;
  private phase: ResizePhase = "idle";
  /** Bumped on every settle/clear so a stale restore round can recognise itself. */
  private generation = 0;

  constructor(
    private readonly adapter: ResizeUndoAdapter,
    private readonly onPhaseChange: (phase: ResizePhase) => void,
    private readonly onPageRestored: (page: RestoredPage) => void
  ) {}

  get currentPhase(): ResizePhase {
    return this.phase;
  }

  /**
   * Read the phase from inside async methods. Accessing `this.phase` directly
   * keeps the narrowing the entry guard established ("armed"), which makes a
   * later compare against "restoring" an illegal comparison under strictNull
   * control-flow analysis. The getter boundary prevents that narrowing.
   */
  private phaseNow(): ResizePhase {
    return this.phase;
  }

  /** The toolbar entry is only ever offered in the armed state. */
  get canUndo(): boolean {
    return this.phase === "armed";
  }

  /**
   * Capture every mounted page before a resize. `capture` reads the live
   * canvas and its history for one page; the manager keeps copies so later
   * per-page history pushes cannot mutate the snapshot.
   */
  arm(
    width: number,
    height: number,
    capture: (pageId: string) => PageSnapshot
  ): void {
    if (this.phase === "restoring") return;
    const pages = new Map<string, PageSnapshot>();
    for (const pageId of this.adapter.pageIds()) {
      const snapshot = capture(pageId);
      // Defensive copy: the caller's history stack keeps mutating as the user
      // edits, and the snapshot must freeze the stack as it was at arm time.
      pages.set(pageId, {
        json: snapshot.json,
        history: {
          entries: [...snapshot.history.entries],
          index: snapshot.history.index,
        },
      });
    }
    this.snapshot = { width, height, pages };
    this.setPhase("armed");
  }

  /**
   * The first edit after a resize ends the resize's undoable life. Called from
   * every mutation path, so the snapshot can never be restored over new work.
   */
  invalidate(): void {
    if (this.phase !== "armed") return;
    this.snapshot = null;
    this.setPhase("idle");
  }

  /** Unconditional teardown — template load, design switch, editor leave. */
  clear(): void {
    this.generation++;
    this.snapshot = null;
    if (this.phase !== "idle") this.setPhase("idle");
  }

  /**
   * A canvas mount that the armed snapshot never knew about (a newly added
   * page) could not be restored, which would leave it on the new frame while
   * every other page reverts. Treat it as an edit and invalidate.
   * Re-mounts of pages the snapshot already covers are harmless.
   */
  notePageRegistered(pageId: string): void {
    if (this.phase === "armed" && this.snapshot && !this.snapshot.pages.has(pageId)) {
      this.invalidate();
    }
  }

  /** A captured page is gone (deleted, unmounted): full restore is impossible. */
  notePageUnregistered(pageId: string): void {
    if (this.phase === "armed" && this.snapshot?.pages.has(pageId)) {
      this.invalidate();
    }
  }

  /**
   * Replay the snapshot across every page that still exists. The frame flips
   * synchronously for all canvases first, so no page keeps a mismatched
   * frame; artwork then converges page by page. Resolves once the whole
   * round settles or once it has been superseded.
   */
  async undo(): Promise<void> {
    if (this.phase !== "armed" || !this.snapshot) return;
    const snapshot = this.snapshot;
    const generation = ++this.generation;
    this.setPhase("restoring");

    this.adapter.applyDimensions(snapshot.width, snapshot.height);

    const isLive = (pageId: string) => this.adapter.pageIds().includes(pageId);
    const tasks = [...snapshot.pages.entries()].map(async ([pageId, page]) => {
      let ok = true;
      try {
        await this.adapter.loadPage(pageId, page.json);
      } catch {
        // A failed image/font on one page must not strand the rest of the
        // design in the restoring phase, and its history must not be handed
        // back over artwork that never changed.
        ok = false;
      }
      // The page may have unmounted, or the round superseded, while its load
      // was in flight. Its history must not touch a live canvas. Re-check
      // liveness here, not just at the start, to close that window.
      if (
        !ok ||
        generation !== this.generation ||
        this.phaseNow() !== "restoring" ||
        !isLive(pageId)
      ) {
        return;
      }
      this.onPageRestored({ pageId, json: page.json, history: page.history });
    });

    await Promise.all(tasks);

    if (generation === this.generation && this.phaseNow() === "restoring") {
      this.snapshot = null;
      this.setPhase("idle");
    }
  }

  private setPhase(phase: ResizePhase): void {
    if (this.phase === phase) return;
    this.phase = phase;
    this.onPhaseChange(phase);
  }
}

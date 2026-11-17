import { useState, useCallback, useRef, useEffect } from "preact/hooks";
import * as fabric from "fabric";
import type { Template, BrandKit } from "../types";
import { reflowCanvas, type Dimensions } from "../resize";
import { ResizeUndoManager, type RestoredPage } from "../resize-undo";
import { buildColorMap, brandFontFor, isHex } from "../lib/brand";
import { downloadDataURL, exportPagesToPDF, renderPageToPNG, slugify } from "../lib/export";

const MAX_HISTORY = 50;

const TEXT_PRESETS = {
  heading: { text: "Add a heading", fontSize: 48, fontWeight: "700", fontFamily: "Montserrat" },
  subheading: { text: "Add a subheading", fontSize: 32, fontWeight: "500", fontFamily: "Inter" },
  body: { text: "Add body text", fontSize: 18, fontWeight: "400", fontFamily: "Inter" },
} as const;

const SHAPE_DEFAULTS = {
  fill: "#6366f1",
  stroke: "",
  strokeWidth: 0,
  opacity: 1,
};

interface CanvasHistory {
  entries: string[];
  index: number;
}

export function useCanvasState(onChange: () => void = () => {}) {
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const canvasMapRef = useRef<Map<string, fabric.Canvas>>(new Map());
  const historyMapRef = useRef<Map<string, CanvasHistory>>(new Map());
  const [activeCanvasId, setActiveCanvasId] = useState<string | null>(null);
  const activeCanvasIdRef = useRef<string | null>(null);
  const [selectedObject, setSelectedObject] = useState<fabric.FabricObject | null>(null);
  const [canvasWidth, setCanvasWidth] = useState(1080);
  const [canvasHeight, setCanvasHeight] = useState(1080);
  const canvasWidthRef = useRef(1080);
  const canvasHeightRef = useRef(1080);
  // A resize spans every page at once, so it cannot be expressed in the
  // per-page undo stacks. The manager owns its snapshot and the phase that
  // keeps resize undo and per-page undo mutually exclusive.
  const resizeManagerRef = useRef<ResizeUndoManager | null>(null);
  const [canUndoResize, setCanUndoResize] = useState(false);
  const [isRestoringResize, setIsRestoringResize] = useState(false);
  const [zoom, setZoom] = useState(0.58);
  const [fitScale, setFitScale] = useState(0.58);
  const [exporting, setExporting] = useState(false);
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);
  // Pages whose canvas is mid `loadFromJSON` (per-page undo or a resize
  // restore). Events fired by that replay must not become new history, and
  // user edits are blocked while the artwork is being replaced.
  const isRestoringRef = useRef<Set<string>>(new Set());

  const getManager = useCallback((): ResizeUndoManager => {
    if (!resizeManagerRef.current) {
      resizeManagerRef.current = new ResizeUndoManager(
        {
          pageIds: () => [...canvasMapRef.current.keys()],
          applyDimensions: (width, height) => applyDimensionsRef.current(width, height),
          loadPage: (pageId, json) => {
            const canvas = canvasMapRef.current.get(pageId);
            if (!canvas) return Promise.resolve();
            isRestoringRef.current.add(pageId);
            return canvas.loadFromJSON(JSON.parse(json)).then(
              () => {
                isRestoringRef.current.delete(pageId);
              },
              () => {
                isRestoringRef.current.delete(pageId);
                throw new Error(`Failed to restore page ${pageId}`);
              }
            );
          },
        },
        (phase) => {
          setCanUndoResize(phase === "armed");
          setIsRestoringResize(phase === "restoring");
        },
        (restored: RestoredPage) => {
          // Hand the page its pre-resize undo stack intact, then re-render
          // its toolbar undo/redo state if it is the page the user sees.
          historyMapRef.current.set(restored.pageId, {
            entries: [...restored.history.entries],
            index: restored.history.index,
          });
          const canvas = canvasMapRef.current.get(restored.pageId);
          canvas?.requestRenderAll();
          updateUndoRedoStateRef.current(restored.pageId);
          onChangeRef.current();
        }
      );
    }
    return resizeManagerRef.current;
  }, []);
  // applyDimensions is defined later; route through a ref so the manager's
  // adapter always calls the current closure without recreating the manager.
  const applyDimensionsRef = useRef<(w: number, h: number) => void>(() => {});
  const updateUndoRedoStateRef = useRef<(pageId: string) => void>(() => {});

  // Helper to get the active canvas
  const getActiveCanvas = useCallback((): fabric.Canvas | null => {
    const id = activeCanvasIdRef.current;
    if (!id) return null;
    return canvasMapRef.current.get(id) ?? null;
  }, []);

  // Update undo/redo state for active canvas
  const updateUndoRedoState = useCallback((pageId: string) => {
    if (pageId !== activeCanvasIdRef.current) return;
    const hist = historyMapRef.current.get(pageId);
    if (!hist) {
      setCanUndo(false);
      setCanRedo(false);
      return;
    }
    setCanUndo(hist.index > 0);
    setCanRedo(hist.index < hist.entries.length - 1);
  }, []);
  updateUndoRedoStateRef.current = updateUndoRedoState;

  // True while the resize snapshot is being replayed. Every editing entry
  // point is refused then, so nothing can land on a canvas whose artwork is
  // being replaced — there is no half-restored state to edit into.
  const isRestoreInProgress = useCallback(
    () => getManager().currentPhase === "restoring",
    [getManager]
  );

  const saveHistory = useCallback((pageId: string) => {
    if (isRestoringRef.current.has(pageId)) return;
    const canvas = canvasMapRef.current.get(pageId);
    if (!canvas) return;
    // An edit lands on top of the resize. Restoring the snapshot would now
    // throw this work away too, so the resize stops being undoable here.
    getManager().invalidate();
    const json = JSON.stringify(canvas.toJSON());
    let hist = historyMapRef.current.get(pageId);
    if (!hist) {
      hist = { entries: [], index: -1 };
      historyMapRef.current.set(pageId, hist);
    }
    // Truncate forward history
    hist.entries = hist.entries.slice(0, hist.index + 1);
    hist.entries.push(json);
    if (hist.entries.length > MAX_HISTORY) {
      hist.entries.shift();
    } else {
      hist.index = hist.entries.length - 1;
    }
    updateUndoRedoState(pageId);
    onChangeRef.current();
  }, [getManager, updateUndoRedoState]);

  const registerCanvas = useCallback((pageId: string, canvas: fabric.Canvas) => {
    canvasMapRef.current.set(pageId, canvas);

    // Selection events
    canvas.on("selection:created", (e) => {
      if (activeCanvasIdRef.current === pageId) {
        setSelectedObject(e.selected?.[0] ?? null);
      }
    });
    canvas.on("selection:updated", (e) => {
      if (activeCanvasIdRef.current === pageId) {
        setSelectedObject(e.selected?.[0] ?? null);
      }
    });
    canvas.on("selection:cleared", () => {
      if (activeCanvasIdRef.current === pageId) {
        setSelectedObject(null);
      }
    });

    // History events
    canvas.on("object:added", () => saveHistory(pageId));
    canvas.on("object:modified", () => saveHistory(pageId));
    canvas.on("object:removed", () => saveHistory(pageId));
    // Fabric fires text:changed per keystroke but only commits object:modified
    // when editing ends with altered text. The snapshot has to die on the
    // first keystroke, not at blur, so an in-flight text edit can never be
    // wiped by a resize restore either.
    canvas.on("text:changed", () => {
      if (!isRestoringRef.current.has(pageId)) getManager().invalidate();
      onChangeRef.current();
    });

    // Initial history snapshot
    setTimeout(() => {
      // A resize restore may already have supplied this page's history.
      if (historyMapRef.current.has(pageId)) return;
      const json = JSON.stringify(canvas.toJSON());
      historyMapRef.current.set(pageId, { entries: [json], index: 0 });
      updateUndoRedoState(pageId);
    }, 100);

    // A page the armed snapshot never covered (newly added after the resize)
    // cannot be restored, so its appearance ends the resize's undoable life.
    getManager().notePageRegistered(pageId);
  }, [getManager, saveHistory, updateUndoRedoState]);

  const unregisterCanvas = useCallback((pageId: string) => {
    canvasMapRef.current.delete(pageId);
    historyMapRef.current.delete(pageId);
    isRestoringRef.current.delete(pageId);
    // The snapshot holds JSON keyed by page id. Once a page it captured is
    // gone -- page deleted, or the editor left for another design -- a full
    // restore is impossible, so the undo entry is withdrawn rather than
    // replayed onto the canvases that are actually mounted.
    getManager().notePageUnregistered(pageId);
  }, [getManager]);

  const setActiveCanvas = useCallback((pageId: string) => {
    const prevId = activeCanvasIdRef.current;
    if (prevId === pageId) return;

    // Clear selection on previous canvas
    if (prevId) {
      const prevCanvas = canvasMapRef.current.get(prevId);
      if (prevCanvas) {
        prevCanvas.discardActiveObject();
        prevCanvas.requestRenderAll();
      }
    }

    activeCanvasIdRef.current = pageId;
    setActiveCanvasId(pageId);
    setSelectedObject(null);
    updateUndoRedoState(pageId);
  }, [updateUndoRedoState]);

  // ── Text ────────────────────────────────────────────────────────────

  const addText = useCallback(
    (preset: "heading" | "subheading" | "body") => {
      const canvas = getActiveCanvas();
      if (!canvas || isRestoreInProgress()) return;
      const cfg = TEXT_PRESETS[preset];
      const text = new fabric.Textbox(cfg.text, {
        left: canvasWidth / 2 - 200,
        top: canvasHeight / 2 - 30,
        width: 400,
        fontSize: cfg.fontSize,
        fontWeight: cfg.fontWeight,
        fontFamily: cfg.fontFamily,
        fill: "#000000",
        textAlign: "center",
        editable: true,
      });
      canvas.add(text);
      canvas.setActiveObject(text);
      canvas.requestRenderAll();
    },
    [getActiveCanvas, canvasWidth, canvasHeight, isRestoreInProgress]
  );

  // ── Shapes ──────────────────────────────────────────────────────────

  const addShape = useCallback(
    (type: "rect" | "circle" | "line" | "triangle") => {
      const canvas = getActiveCanvas();
      if (!canvas || isRestoreInProgress()) return;
      let obj: fabric.FabricObject;
      const cx = canvasWidth / 2;
      const cy = canvasHeight / 2;

      switch (type) {
        case "rect":
          obj = new fabric.Rect({
            left: cx - 75,
            top: cy - 75,
            width: 150,
            height: 150,
            rx: 8,
            ry: 8,
            ...SHAPE_DEFAULTS,
          });
          break;
        case "circle":
          obj = new fabric.Circle({
            left: cx - 60,
            top: cy - 60,
            radius: 60,
            ...SHAPE_DEFAULTS,
          });
          break;
        case "triangle":
          obj = new fabric.Triangle({
            left: cx - 60,
            top: cy - 60,
            width: 120,
            height: 120,
            ...SHAPE_DEFAULTS,
          });
          break;
        case "line":
          obj = new fabric.Line([cx - 100, cy, cx + 100, cy], {
            stroke: "#6366f1",
            strokeWidth: 3,
            fill: "",
          });
          break;
        default:
          return;
      }
      canvas.add(obj);
      canvas.setActiveObject(obj);
      canvas.requestRenderAll();
    },
    [getActiveCanvas, canvasWidth, canvasHeight, isRestoreInProgress]
  );

  // ── Images ──────────────────────────────────────────────────────────

  const addImage = useCallback(
    async (url: string) => {
      const canvas = getActiveCanvas();
      if (!canvas || isRestoreInProgress()) return;
      try {
        const img = await fabric.FabricImage.fromURL(url, { crossOrigin: "anonymous" });
        // A resize restore may have started while the image was downloading.
        if (isRestoreInProgress()) return;
        const scale = Math.min(
          (canvasWidth * 0.6) / (img.width || 1),
          (canvasHeight * 0.6) / (img.height || 1),
          1
        );
        img.set({
          left: canvasWidth / 2 - ((img.width || 0) * scale) / 2,
          top: canvasHeight / 2 - ((img.height || 0) * scale) / 2,
          scaleX: scale,
          scaleY: scale,
        });
        canvas.add(img);
        canvas.setActiveObject(img);
        canvas.requestRenderAll();
      } catch (e) {
        console.error("Failed to load image:", e);
      }
    },
    [getActiveCanvas, canvasWidth, canvasHeight, isRestoreInProgress]
  );

  // ── Background ──────────────────────────────────────────────────────

  const setBackground = useCallback(
    (type: "color" | "gradient" | "image", value: string) => {
      const canvas = getActiveCanvas();
      const pageId = activeCanvasIdRef.current;
      if (!canvas || !pageId || isRestoreInProgress()) return;
      if (type === "color" || type === "gradient") {
        canvas.backgroundColor = value;
        canvas.requestRenderAll();
        saveHistory(pageId);
      } else if (type === "image") {
        fabric.FabricImage.fromURL(value, { crossOrigin: "anonymous" }).then((img) => {
          if (isRestoreInProgress()) return;
          const scaleX = canvasWidth / (img.width || 1);
          const scaleY = canvasHeight / (img.height || 1);
          img.set({ left: 0, top: 0, scaleX, scaleY, selectable: false, evented: false });
          const objects = canvas.getObjects();
          const bgObj = objects.find((o) => (o as any)._isBgImage);
          if (bgObj) canvas.remove(bgObj);
          (img as any)._isBgImage = true;
          canvas.add(img);
          canvas.sendObjectToBack(img);
          canvas.requestRenderAll();
          saveHistory(pageId);
        });
      }
    },
    [getActiveCanvas, canvasWidth, canvasHeight, saveHistory, isRestoreInProgress]
  );

  // ── Object manipulation ─────────────────────────────────────────────

  // Editing a property mutates the live Fabric object, which React can't see.
  // This counter is what re-renders the sidebar. Spreading the object into a
  // new one would also re-render, but it strips the prototype — and in Fabric
  // v6 that takes `.set()` and the `type` getter with it, so the panel would
  // mistake a textbox for a shape and the next edit would throw.
  const [, setSelectionVersion] = useState(0);
  const bumpSelection = () => setSelectionVersion((v) => v + 1);

  const updateSelectedObject = useCallback(
    (props: Record<string, unknown>) => {
      const canvas = getActiveCanvas();
      const pageId = activeCanvasIdRef.current;
      if (!canvas || !selectedObject || !pageId || isRestoreInProgress()) return;
      selectedObject.set(props as Partial<fabric.FabricObject>);
      canvas.requestRenderAll();
      saveHistory(pageId);
      bumpSelection();
    },
    [getActiveCanvas, selectedObject, saveHistory, isRestoreInProgress]
  );

  const changeLayer = useCallback(
    (action: "front" | "forward" | "backward" | "back") => {
      const canvas = getActiveCanvas();
      const pageId = activeCanvasIdRef.current;
      if (!canvas || !selectedObject || !pageId || isRestoreInProgress()) return;
      const changed = action === "front" ? canvas.bringObjectToFront(selectedObject)
        : action === "forward" ? canvas.bringObjectForward(selectedObject)
        : action === "backward" ? canvas.sendObjectBackwards(selectedObject)
        : canvas.sendObjectToBack(selectedObject);
      if (!changed) return;
      canvas.requestRenderAll();
      saveHistory(pageId);
      bumpSelection();
    },
    [getActiveCanvas, selectedObject, saveHistory, isRestoreInProgress]
  );

  const deleteSelected = useCallback(() => {
    const canvas = getActiveCanvas();
    if (!canvas || isRestoreInProgress()) return;
    const active = canvas.getActiveObjects();
    if (active.length === 0) return;
    active.forEach((obj) => canvas.remove(obj));
    canvas.discardActiveObject();
    canvas.requestRenderAll();
  }, [getActiveCanvas, isRestoreInProgress]);

  // ── Undo / Redo ─────────────────────────────────────────────────────

  const restoreFromHistory = useCallback(
    (index: number) => {
      const pageId = activeCanvasIdRef.current;
      const canvas = getActiveCanvas();
      if (!canvas || !pageId) return;
      const hist = historyMapRef.current.get(pageId);
      if (!hist || index < 0 || index >= hist.entries.length) return;
      isRestoringRef.current.add(pageId);
      hist.index = index;
      const json = hist.entries[index];
      canvas.loadFromJSON(JSON.parse(json)).finally(() => {
        isRestoringRef.current.delete(pageId);
        updateUndoRedoState(pageId);
        onChangeRef.current();
      });
    },
    [getActiveCanvas, updateUndoRedoState]
  );

  const undo = useCallback(() => {
    const pageId = activeCanvasIdRef.current;
    if (!pageId || isRestoreInProgress()) return;
    const hist = historyMapRef.current.get(pageId);
    if (!hist) return;
    restoreFromHistory(hist.index - 1);
  }, [restoreFromHistory, isRestoreInProgress]);

  const redo = useCallback(() => {
    const pageId = activeCanvasIdRef.current;
    if (!pageId || isRestoreInProgress()) return;
    const hist = historyMapRef.current.get(pageId);
    if (!hist) return;
    restoreFromHistory(hist.index + 1);
  }, [restoreFromHistory, isRestoreInProgress]);

  // ── Canvas size ─────────────────────────────────────────────────────

  // Retarget every page's canvas to a new frame. Moves no artwork.
  const applyDimensions = useCallback((width: number, height: number) => {
    setCanvasWidth(width);
    setCanvasHeight(height);
    canvasWidthRef.current = width;
    canvasHeightRef.current = height;
    const dpr = window.devicePixelRatio || 1;
    for (const canvas of canvasMapRef.current.values()) {
      canvas.setDimensions({ width: width * dpr, height: height * dpr }, { cssOnly: false });
      canvas.setDimensions({ width, height }, { cssOnly: true });
      canvas.setViewportTransform([dpr, 0, 0, dpr, 0, 0]);
      canvas.requestRenderAll();
    }
  }, []);
  applyDimensionsRef.current = applyDimensions;

  const getCanvasSize = useCallback(
    (): Dimensions => ({ width: canvasWidthRef.current, height: canvasHeightRef.current }),
    []
  );

  const setCanvasSize = useCallback(
    (width: number, height: number, options?: { reflow?: boolean }) => {
      const from = getCanvasSize();
      const to = { width, height };

      // Adopting a saved design's own frame: the stored artwork already fits it.
      if (options?.reflow === false) {
        applyDimensions(width, height);
        return;
      }
      // A restore is replaying the previous snapshot onto every canvas;
      // starting another resize would orphan those in-flight loads.
      if (getManager().currentPhase === "restoring") return;
      if (from.width === to.width && from.height === to.height) return;

      // Capture every page's artwork and its full per-page undo stack before
      // anything moves. The manager copies the memento, so later history
      // pushes cannot reach into the snapshot.
      getManager().arm(from.width, from.height, (pageId) => {
        const canvas = canvasMapRef.current.get(pageId);
        const hist = historyMapRef.current.get(pageId);
        return {
          json: JSON.stringify(canvas!.toJSON()),
          history: hist
            ? { entries: [...hist.entries], index: hist.index }
            : { entries: [], index: -1 },
        };
      });

      applyDimensions(width, height);
      for (const [pageId, canvas] of canvasMapRef.current) {
        reflowCanvas(canvas, from, to);
        // A resize is a commit point: undoing across it page by page would
        // leave that page's artwork sized for the frame it no longer has.
        // The pre-resize stack survives inside the resize snapshot.
        historyMapRef.current.set(pageId, {
          entries: [JSON.stringify(canvas.toJSON())],
          index: 0,
        });
        updateUndoRedoState(pageId);
      }
      onChangeRef.current();
    },
    [applyDimensions, getCanvasSize, getManager, updateUndoRedoState]
  );

  // Restores the frame and every page's artwork together. The frame flips for
  // all pages synchronously; artwork then converges under the manager's
  // restoring lock, and each page gets its pre-resize undo stack back.
  const undoResize = useCallback(() => {
    void getManager().undo();
  }, [getManager]);

  // ── Zoom ────────────────────────────────────────────────────────────

  const zoomToFit = useCallback(() => {
    setZoom(fitScale);
  }, [fitScale]);

  const zoomIn = useCallback(() => {
    setZoom((z) => Math.min(z * 1.2, 3));
  }, []);

  const zoomOut = useCallback(() => {
    setZoom((z) => Math.max(z / 1.2, 0.05));
  }, []);

  // ── Export ──────────────────────────────────────────────────────────

  // Page ids come from the design, which owns their order. A Map has none.
  const canvasesForPages = useCallback(
    (pageIds: string[]) =>
      pageIds
        .map((id) => canvasMapRef.current.get(id))
        .filter((c): c is fabric.Canvas => Boolean(c)),
    []
  );

  const exportPNG = useCallback(
    (designName: string) => {
      const canvas = getActiveCanvas();
      if (!canvas) return;
      downloadDataURL(renderPageToPNG(canvas), `${slugify(designName)}.png`);
    },
    [getActiveCanvas]
  );

  const exportAllPNG = useCallback(
    (pageIds: string[], designName: string) => {
      const canvases = canvasesForPages(pageIds);
      const slug = slugify(designName);
      // Ceiling: one download per page, staggered. Browsers drop downloads fired
      // in the same tick, and prompt once for a burst. Fine for the 5-20 slides a
      // social carousel runs to. If designs ever get long enough for that to be a
      // nuisance, zip them (fflate is already in the tree under jspdf) rather than
      // adding a dependency. The editor mounts every page's canvas at once, so it
      // runs out of memory well before this does.
      canvases.forEach((canvas, i) => {
        setTimeout(() => downloadDataURL(renderPageToPNG(canvas), `${slug}-${i + 1}.png`), i * 250);
      });
    },
    [canvasesForPages]
  );

  const exportPDF = useCallback(
    async (pageIds: string[], designName: string) => {
      const canvases = canvasesForPages(pageIds);
      if (canvases.length === 0) return;
      setExporting(true);
      try {
        await exportPagesToPDF(canvases, canvasWidth, canvasHeight, `${slugify(designName)}.pdf`);
      } catch (e) {
        console.error("Failed to export PDF:", e);
      } finally {
        setExporting(false);
      }
    },
    [canvasesForPages, canvasWidth, canvasHeight]
  );

  // ── Serialization ───────────────────────────────────────────────────

  const getCanvasJSON = useCallback(() => {
    const canvas = getActiveCanvas();
    if (!canvas) return "{}";
    return JSON.stringify(canvas.toJSON());
  }, [getActiveCanvas]);

  const getCanvasJSONForPage = useCallback((pageId: string) => {
    const canvas = canvasMapRef.current.get(pageId);
    if (!canvas) return "{}";
    return JSON.stringify(canvas.toJSON());
  }, []);

  const loadTemplate = useCallback(
    (template: Template) => {
      // The template brings its own frame and artwork, so nothing is reflowed.
      applyDimensions(template.width, template.height);
      // Any pending resize snapshot describes a different design now.
      getManager().clear();
      // Load template JSON onto active canvas
      const canvas = getActiveCanvas();
      const pageId = activeCanvasIdRef.current;
      if (canvas && pageId) {
        isRestoringRef.current.add(pageId);
        canvas.loadFromJSON(JSON.parse(template.canvas_json)).finally(() => {
          isRestoringRef.current.delete(pageId);
          historyMapRef.current.set(pageId, {
            entries: [JSON.stringify(canvas.toJSON())],
            index: 0,
          });
          updateUndoRedoState(pageId);
          onChangeRef.current();
        });
      }
    },
    [applyDimensions, getActiveCanvas, getManager, updateUndoRedoState]
  );

  // ── Brand kit ───────────────────────────────────────────────────────

  // Re-brands the page in one pass: text takes the kit's heading/body font, and
  // every colour in the design is swapped for the brand colour of the same
  // light-to-dark rank (see lib/brand.ts). It is one history entry, so a user
  // who does not like the result presses Cmd+Z once.
  const applyBrandKit = useCallback(
    (kit: BrandKit) => {
      const canvas = getActiveCanvas();
      const pageId = activeCanvasIdRef.current;
      if (!canvas || !pageId) return;

      const objects = canvas.getObjects();
      const used: string[] = [];
      if (isHex(canvas.backgroundColor)) used.push(canvas.backgroundColor);
      for (const obj of objects) {
        if (isHex(obj.fill)) used.push(obj.fill);
        if (isHex(obj.stroke)) used.push(obj.stroke);
      }
      const colorMap = buildColorMap(used, kit.colors);
      const remap = (v: unknown) => (isHex(v) ? colorMap.get(v.toLowerCase()) ?? v : v);

      if (isHex(canvas.backgroundColor)) {
        canvas.backgroundColor = remap(canvas.backgroundColor) as string;
      }

      for (const obj of objects) {
        const props: Record<string, unknown> = {};
        if (isHex(obj.fill)) props.fill = remap(obj.fill);
        if (isHex(obj.stroke)) props.stroke = remap(obj.stroke);
        if (obj instanceof fabric.Textbox || obj instanceof fabric.IText) {
          props.fontFamily = brandFontFor(obj.fontSize ?? 18, kit);
        }
        if (Object.keys(props).length > 0) obj.set(props as Partial<fabric.FabricObject>);
      }

      canvas.requestRenderAll();
      saveHistory(pageId);
      bumpSelection();
    },
    [getActiveCanvas, saveHistory]
  );

  // ── Keyboard shortcuts ──────────────────────────────────────────────

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const meta = e.metaKey || e.ctrlKey;
      if (meta && e.key === "z" && !e.shiftKey) {
        e.preventDefault();
        undo();
      } else if (meta && e.key === "z" && e.shiftKey) {
        e.preventDefault();
        redo();
      } else if ((e.key === "Delete" || e.key === "Backspace") && !isTextEditing()) {
        e.preventDefault();
        deleteSelected();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [undo, redo, deleteSelected]);

  function isTextEditing(): boolean {
    const canvas = getActiveCanvas();
    if (!canvas) return false;
    const obj = canvas.getActiveObject();
    return obj instanceof fabric.Textbox && obj.isEditing === true;
  }

  // Leaving the editor (design switch, navigation away) unmounts every page
  // canvas through unregisterCanvas, which already withdraws the snapshot.
  // This is the belt-and-braces teardown for the hook itself going away, so a
  // late restore promise can never touch state after the editor is gone.
  useEffect(() => {
    const manager = getManager();
    return () => manager.clear();
  }, [getManager]);

  return {
    // Canvas map management
    registerCanvas,
    unregisterCanvas,
    setActiveCanvas,
    activeCanvasId,
    canvasMap: canvasMapRef,
    // For backward compat (right-sidebar uses canvas directly)
    get canvas() {
      return getActiveCanvas();
    },
    selectedObject,
    canvasWidth,
    canvasHeight,
    zoom,
    setZoomRaw: setZoom,
    fitScale,
    setFitScale,
    addText,
    addShape,
    addImage,
    setBackground,
    updateSelectedObject,
    changeLayer,
    deleteSelected,
    undo,
    redo,
    canUndo,
    canRedo,
    setCanvasSize,
    getCanvasSize,
    undoResize,
    canUndoResize,
    isRestoringResize,
    zoomToFit,
    zoomIn,
    zoomOut,
    exportPNG,
    exportAllPNG,
    exportPDF,
    exporting,
    getCanvasJSON,
    getCanvasJSONForPage,
    loadTemplate,
    applyBrandKit,
  };
}

import { settings } from "./state.js";
import { isDrawable, renderBadge } from "./canvas.js";

// How long to wait for an in-flight banner/material asset before exporting
// without it. Decoded assets are already complete, so this only matters for a
// click that races the very first page load.
const ASSET_WAIT_MS = 3000;

/**
 * Waits until an image is safe to draw. Resolves `true` if it is (or becomes)
 * drawable, `false` if it has no source or fails/times out.
 */
const waitForDrawable = (image) => {
  if (image && isDrawable(image)) return Promise.resolve(true);
  if (!image || !image.src) return Promise.resolve(false);
  // Already settled and unusable (e.g. a decode error): don't stall the export.
  if (image.complete) return Promise.resolve(false);

  return new Promise((resolve) => {
    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      image.removeEventListener("load", onLoad);
      image.removeEventListener("error", onError);
      resolve(ok);
    };
    const onLoad = () => finish(true);
    const onError = () => finish(false);
    const timer = setTimeout(() => finish(false), ASSET_WAIT_MS);

    image.addEventListener("load", onLoad);
    image.addEventListener("error", onError);
  });
};

/**
 * Captures the state at click time. Rendering only ever reads this snapshot, so
 * edits made after the click can neither leak into the file nor be corrupted by
 * the export.
 */
const takeSnapshot = () => ({
  image:
    settings.image && isDrawable(settings.image.img) ? settings.image.img : null,
  banner: settings.banner,
  material: settings.material,
  x: settings.x,
  y: settings.y,
  z: settings.z,
  shape: settings.shape,
  grid: settings.grid,
  fileName:
    settings.image && settings.image.fileName
      ? String(settings.image.fileName)
      : "",
});

const buildFileName = (sourceName) => {
  // Existing naming rule: "<image name without extension>-gde-badge.png",
  // falling back to a timestamp when the image has no file name.
  const baseName = sourceName.replace(/\.[^/.]+$/, "");
  return `${baseName || Date.now()}-gde-badge.png`;
};

const saveBlob = (url, fileName) => {
  const anchor = document.createElement("a");
  anchor.download = fileName;
  anchor.href = url;
  anchor.rel = "noopener";
  anchor.style.display = "none";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
};

const performExport = async (snapshot) => {
  // Make sure assets that are part of the finished badge are decoded before we
  // paint. `waitForDrawable` re-reads the same Image object, so the snapshot is
  // still the click-time selection.
  const [bannerReady, materialReady] = await Promise.all([
    waitForDrawable(snapshot.banner),
    snapshot.shape === "material"
      ? waitForDrawable(snapshot.material)
      : Promise.resolve(false),
  ]);

  // Detached canvas: the visible preview is never reused or mutated, so there
  // is no preview state to restore afterwards.
  const canvas = document.createElement("canvas");
  renderBadge(
    canvas,
    {
      ...snapshot,
      banner: bannerReady ? snapshot.banner : null,
      material: materialReady ? snapshot.material : null,
    },
    { isExport: true },
  );

  // A zero-sized canvas would encode to "data:," (a blank/broken file). This
  // should not happen because renderBadge always sizes the canvas, but guard
  // so a degenerate image never yields an empty download.
  if (!canvas.width || !canvas.height) {
    console.warn("Export skipped: canvas has no drawable area.");
    return null;
  }

  let url;
  try {
    url = canvas.toDataURL("image/png");
  } catch (error) {
    console.error("Export failed while encoding the badge.", error);
    return null;
  }

  if (!url || !url.startsWith("data:image/png")) {
    console.warn("Export skipped: PNG encoding produced no data.");
    return null;
  }

  const fileName = buildFileName(snapshot.fileName);
  saveBlob(url, fileName);
  return fileName;
};

// Export jobs are chained so concurrent clicks run one after another. Each job
// renders its own detached canvas from its own click-time snapshot, so a rapid
// double click can neither overwrite the preview nor produce a half-drawn file.
let exportQueue = Promise.resolve();

/**
 * Renders and downloads the badge.
 *
 * Ordering guarantee:
 * 1. snapshot the settings synchronously at click time;
 * 2. wait for banner/material assets (already-decoded assets resolve at once);
 * 3. render on a fresh detached canvas with guides disabled;
 * 4. encode and click the download anchor;
 * 5. drop the canvas.
 *
 * The preview canvas and `settings` are never touched, so there is no restore
 * step that could fail or observe an interleaved state.
 *
 * @return {Promise<string|null>} Resolves with the file name, or null if the
 *   export could not produce a PNG.
 */
export const downloadBadge = () => {
  const snapshot = takeSnapshot();
  // A failed job must not break the queue or surface as an unhandled rejection.
  const job = exportQueue
    .then(() => performExport(snapshot))
    .catch((error) => {
      console.error("Export failed.", error);
      return null;
    });
  exportQueue = job;
  return job;
};

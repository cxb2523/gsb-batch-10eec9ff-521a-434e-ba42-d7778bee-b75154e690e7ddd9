---
"@canvas-tile-engine/renderer-canvas": patch
"@canvas-tile-engine/renderer-server": patch
---

Fix static-cache staleness on the shared Canvas2D pipeline in three places:

- **A reused `cacheKey` now replaces the old layer, not just the bitmap.** Registering the same key again without removing the previous handle marked the old cache entry inactive and dropped it from the map, but the earlier layer still kept a reference to its entry and kept blitting that replaced bitmap every frame. Two registrations under one key therefore both drew, one of them stale — visible through the draw API and as a ghost layer after a `clip` or bounds change. Each entry now carries an `active` flag that the later registration clears, and the superseded layer releases its bitmap and draws nothing from then on. A registration that falls back to dynamic drawing (no offscreen surface, oversized bitmap, empty item list) supersedes the key too, so a dead cache can no longer shadow the dynamic replacement.
- **A failed pixel-ratio re-record is attempted at most once per ratio.** The DPR watcher re-records a static layer when the renderer's ratio changes (browser zoom, another monitor). When that recording failed the old bitmap was retained, but the entry's expected ratio was overwritten with the failed one, so every subsequent frame retried the same doomed allocation. Failed ratios are now recorded in a set: a retained bitmap is not retried at a ratio that already failed, while a ratio that has not yet been tried (or returning to the recorded one) is still handled normally.
- **Static caches re-record at the current camera scale.** Covered by the same path: a ratio change now re-records at whatever scale the camera is at that frame, so a zoom and a monitor switch arriving together produce a cache matched to both, instead of a bitmap recorded at the old scale.

`clearStaticCache` keeps its existing contract: it still only drops the stored reference, and a registered layer keeps blitting what it captured until a new registration supersedes the key.

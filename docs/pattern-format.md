# Pattern Exchange Format Specification

The Bead Grid Studio Pattern Format is an open, versioned specification for exchanging, storing, and rendering discrete grid-based bead patterns, pixel art, and mosaic craft designs.

The canonical JSON Schema is published at [`schemas/pattern.schema.json`](../schemas/pattern.schema.json).

---

## Example Pattern Document

```json
{
  "$schema": "https://zwhy149.github.io/bead-grid-studio/schemas/pattern.schema.json",
  "schemaVersion": 1,
  "type": "bead-grid-studio",
  "version": 2,
  "appVersion": "1.2.0",
  "title": "Star Badge",
  "createdAt": "2026-09-19T08:00:00.000Z",
  "grid": {
    "cols": 4,
    "rows": 4,
    "cells": [
      null, "H7", "H7", null,
      "H7", "A5", "A5", "H7",
      "H7", "A5", "A5", "H7",
      null, "H7", "H7", null
    ]
  },
  "palette": {
    "id": "mard-compatible-base-221",
    "name": "MARD-Compatible Base 221",
    "source": "maxcleme/beadcolors"
  },
  "statistics": {
    "totalBeads": 8,
    "emptyCells": 8,
    "usedColors": 2,
    "density": 0.5,
    "beadCounts": {
      "H7": 6,
      "A5": 2
    },
    "colors": [
      { "code": "H7", "name": "黑色", "hex": "#000000", "count": 6, "share": 0.75 },
      { "code": "A5", "name": "黄橙系", "hex": "#F4D738", "count": 2, "share": 0.25 }
    ]
  },
  "settings": {
    "processMode": "cartoon",
    "maxColors": 32,
    "boardProfile": "mini52"
  },
  "metadata": {}
}
```

---

## Grid Representation

- `grid.cols`: width of the pattern in cells (horizontal axis).
- `grid.rows`: height of the pattern in cells (vertical axis).
- `grid.cells`: 1-dimensional array of length `cols * rows`, stored row-by-row from top-left `(0,0)` to bottom-right `(cols-1, rows-1)`.
- Index calculation: `cellIndex = row * cols + col`.
- Cell value:
  - `null`: empty space (no bead placed).
  - `"<code>"`: string color code corresponding to the referenced palette provider.

### Transparent anchor (H1)

The MARD-compatible palette reserves `H1` as the transparent anchor. A cell
carrying `H1` is a see-through placeholder, not a purchasable bead:

- `H1` never participates in automatic palette matching (quantization works on
  the 220 non-transparent colors only).
- `H1` cells are preserved verbatim in `grid.cells` and round-trip through
  serialize/parse unchanged.
- Material statistics exclude them: they are reported separately as
  `statistics.transparentCells` and never appear in `totalBeads`, `beadCounts`,
  or the per-color material list. Blank (`null`) cells remain in `emptyCells`.

---

## Compatibility and Migration

The format is version-controlled:
- **`schemaVersion: 1`**: Current open exchange contract.
- **`version: 2`**: Current application project format using MARD-compatible 221-color IDs.
- **`version: 1`**: Legacy format using `universal-screen-64-v1`. When opened with `@bead-grid/core`, legacy 64 colors are deterministically mapped via minimum CIEDE2000 perceptual distance to their closest 221 equivalent (the transparent anchor `H1` is never a mapping target) with zero loss of grid geometry.

### Unknown legacy codes: strict vs. lenient import

`parsePattern(input, options)` accepts `{ lenient: boolean }`:

- **Strict (default):** an unrecognized legacy code throws
  `Unknown legacy color code at index <i>: <code>`, naming the flat cell index.
- **Lenient (`{ lenient: true }`):** unrecognized codes degrade to blank
  (`null` / `-1`) cells instead of being silently painted with an arbitrary
  color. Affected cells are listed in `metadata.unknownLegacyCells` as
  `{ index, code }` entries.

Every migrated result records provenance in `metadata`, including
`migratedFromLegacy: true`, `legacyPalette`, `targetPalette`,
`strictMigration`, `unknownLegacyCells`, and `transparentCellIndices`.
Re-serializing a migrated pattern and parsing it again yields identical cell
codes and blank/transparent cell distribution.

---

## Working with Patterns in Code

```javascript
import { createPattern, parsePattern, serializePattern } from '@bead-grid/core';

// Parse from JSON string or file
const pattern = parsePattern(jsonText);

// Access cell at row 5, col 10
const code = pattern.grid.cells[5 * pattern.grid.cols + 10];
console.log(`Cell (10, 5) color: ${code}`);

// Export back to standard JSON
const jsonOutput = serializePattern(pattern);
```

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
  analyzeLineArtSubject,
  analyzePattern,
  analyzeSourceComplexity,
  assessPatternQuality,
  createCustomPalette,
  createPattern,
  deltaE2000,
  deserializePattern,
  despeckleGrid,
  fitPatternInsideBoard,
  generateBeadPattern,
  getPaletteProvider,
  gridForLongSide,
  hexToRgb,
  parsePattern,
  quantizePixels,
  recommendAutoHdSettings,
  recommendDocumentGrid,
  replaceGridColor,
  rgbToCielab,
  rgbToHex,
  rgbToOklab,
  serializePattern,
  validatePattern,
} from '../../packages/core/src/index.js';
import { decodePng } from '../../src/adapters/png.js';

test('color math: hex, rgb, OKLab, and CIEDE2000 distances are accurate and bounded', () => {
  assert.deepEqual(hexToRgb('#FEAC4C'), [254, 172, 76]);
  assert.equal(rgbToHex(254, 172, 76), '#FEAC4C');

  const blackOklab = rgbToOklab([0, 0, 0]);
  const whiteOklab = rgbToOklab([255, 255, 255]);
  assert.ok(blackOklab[0] < 0.01, 'Black L value in OKLab is near 0');
  assert.ok(whiteOklab[0] > 0.99, 'White L value in OKLab is near 1');

  const c1 = rgbToCielab([255, 0, 0]);
  const c2 = rgbToCielab([255, 0, 0]);
  assert.equal(deltaE2000(c1, c2), 0, 'Identical colors have zero deltaE');

  const cDifferent = rgbToCielab([0, 255, 0]);
  assert.ok(deltaE2000(c1, cDifferent) > 50, 'Red vs Green deltaE is large');
});

test('palette: custom palette registration and validation', () => {
  const custom = createCustomPalette({
    id: 'test-palette-mini',
    name: 'Test Mini Palette',
    colors: [
      { code: 'T1', hex: '#FFFFFF', name: 'White' },
      { code: 'T2', hex: '#000000', name: 'Black' },
      { code: 'T3', hex: '#FF0000', name: 'Red' },
      { code: 'T4', hex: '#00FF00', name: 'Green' },
      { code: 'T5', hex: '#0000FF', name: 'Blue' },
    ],
    anchors: { white: 'T1', black: 'T2' },
  });

  assert.equal(custom.colors.length, 5);
  assert.equal(custom.anchors.white, 'T1');
  assert.equal(custom.anchors.black, 'T2');
  assert.ok(custom.colors[0].rgb, 'Color has computed RGB');
  assert.ok(custom.colors[0].lab, 'Color has computed OKLab');
  assert.ok(custom.colors[0].cieLab, 'Color has computed CIELAB');
});

test('quantize: deterministic output on identical inputs', () => {
  // Create a 16x16 gradient test image
  const width = 16;
  const height = 16;
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4;
      data[idx] = Math.round((x / width) * 255);
      data[idx + 1] = Math.round((y / height) * 255);
      data[idx + 2] = 128;
      data[idx + 3] = 255;
    }
  }

  const payload = {
    data,
    width,
    height,
    cols: 8,
    rows: 8,
    maxColors: 16,
    processMode: 'cartoon',
  };

  const run1 = quantizePixels(payload);
  const run2 = quantizePixels(payload);

  assert.equal(run1.cells.length, 64);
  assert.deepEqual(Array.from(run1.cells), Array.from(run2.cells), 'Runs must produce identical cell arrays');
  assert.deepEqual(run1.selected, run2.selected, 'Runs must produce identical selected color palettes');
  assert.equal(run1.nonEmpty, run2.nonEmpty);
});

test('quantize: fixture rocket-badge.png produces valid pattern with expected properties', () => {
  const fixturePath = path.resolve('tests/fixtures/rocket-badge.png');
  const buffer = fs.readFileSync(fixturePath);
  const { data, width, height } = decodePng(buffer);

  assert.equal(width, 1024);
  assert.equal(height, 1024);

  const result = quantizePixels({
    data,
    width,
    height,
    cols: 24,
    rows: 24,
    maxColors: 16,
    processMode: 'cartoon',
    whiteMode: 'auto',
  });

  assert.equal(result.cells.length, 576);
  assert.ok(result.nonEmpty > 50, 'Rocket badge has significant bead coverage');
  assert.ok(result.selected.length <= 16, 'Color count does not exceed maxColors limit');
  assert.ok(result.diagnostics.backgroundPixels > 0, 'Auto whiteMode removed connected white background');
});

test('high-level generateBeadPattern API returns structured pattern model', async () => {
  const fixturePath = path.resolve('tests/fixtures/rocket-badge.png');
  const buffer = fs.readFileSync(fixturePath);
  const imageData = decodePng(buffer);

  const pattern = await generateBeadPattern(imageData, {
    cols: 32,
    rows: 32,
    maxColors: 20,
    title: 'Rocket Badge 32x32',
  });

  assert.equal(pattern.schemaVersion, 1);
  assert.equal(pattern.type, 'bead-grid-studio');
  assert.equal(pattern.grid.cols, 32);
  assert.equal(pattern.grid.rows, 32);
  assert.equal(pattern.grid.cells.length, 1024);
  assert.ok(pattern.statistics.totalBeads > 0);
  assert.ok(pattern.statistics.usedColors <= 20);
  assert.equal(pattern.title, 'Rocket Badge 32x32');
  assert.ok(pattern.statistics.colors.length > 0);
  assert.ok(pattern.statistics.colors[0].count >= pattern.statistics.colors[1]?.count || 0);

  // Test serialization & round-trip parsing
  const json = serializePattern(pattern);
  assert.ok(typeof json === 'string');
  const restored = parsePattern(json);
  assert.equal(restored.grid.cols, 32);
  assert.equal(restored.grid.rows, 32);
  assert.equal(restored.statistics.totalBeads, pattern.statistics.totalBeads);
  assert.deepEqual(restored.grid.cells, pattern.grid.cells);
});

test('pattern: legacy version 1 migration maps correctly to MARD-compatible colors', () => {
  const legacyPattern = {
    type: 'bead-grid-studio',
    version: 1,
    palette: 'universal-screen-64-v1',
    grid: {
      cols: 4,
      rows: 4,
      cells: [
        'N01', 'N01', 'P01', 'P01',
        'N11', 'N11', 'P07', 'P07',
        null, null, 'N01', 'N01',
        null, null, null, null,
      ],
    },
  };

  const migrated = parsePattern(legacyPattern);
  assert.equal(migrated.grid.cols, 4);
  assert.equal(migrated.grid.rows, 4);
  assert.equal(migrated.metadata.migratedFromLegacy, true);
  assert.equal(migrated.statistics.emptyCells, 6);
  assert.equal(migrated.statistics.totalBeads, 10);
  assert.equal(migrated.statistics.transparentCells, 0);
  // N01 should map to H2 (white)
  assert.equal(migrated.grid.cells[0], 'H2');
  // Every migrated cell must be a MARD code present in the current palette
  const paletteCodes = new Set(getPaletteProvider().colors.map((color) => color.code));
  for (const code of migrated.grid.cells) {
    if (code !== null) assert.ok(paletteCodes.has(code), `migrated code ${code} exists in current palette`);
  }
  // Migration provenance is exposed on the import result metadata
  assert.equal(migrated.metadata.legacyPalette, 'universal-screen-64-v1');
  assert.equal(migrated.metadata.targetPalette, 'mard-compatible-base-221');
  assert.equal(migrated.metadata.strictMigration, true);
  assert.deepEqual(migrated.metadata.unknownLegacyCells, []);
  // A non-legacy import must not carry the migration marker
  const modern = parsePattern({
    type: 'bead-grid-studio',
    version: 2,
    palette: { id: 'mard-compatible-base-221' },
    grid: { cols: 4, rows: 4, cells: new Array(16).fill('H7') },
  });
  assert.equal(modern.metadata.migratedFromLegacy, false);
});

test('pattern: legacy migration also recognizes palette object form universal-screen-64-v1', () => {
  const migrated = parsePattern({
    type: 'bead-grid-studio',
    version: 1,
    palette: { id: 'universal-screen-64-v1' },
    grid: {
      cols: 4,
      rows: 4,
      cells: ['N01', null, -1, undefined, ...new Array(12).fill('N11')],
    },
  });
  assert.equal(migrated.metadata.migratedFromLegacy, true);
  assert.equal(migrated.grid.cells[0], 'H2');
  // null, -1 and undefined all normalize to blank cells
  assert.deepEqual(migrated.grid.cells.slice(1, 4), [null, null, null]);
  assert.equal(migrated.statistics.emptyCells, 3);
});

test('pattern: unknown legacy color code throws in strict mode and names the cell index', () => {
  const legacyPattern = {
    type: 'bead-grid-studio',
    version: 1,
    palette: 'universal-screen-64-v1',
    grid: {
      cols: 4,
      rows: 4,
      cells: [
        'N01', 'N01', 'N01', 'N01',
        'N01', 'N01', 'ZZ99', 'N01', // unknown legacy code at flat index 6
        ...new Array(8).fill(null),
      ],
    },
  };

  // Default (strict) behavior: error must point at the offending cell index
  assert.throws(() => parsePattern(legacyPattern), /Unknown legacy color code at index 6: ZZ99/);
  // Explicit strict mode behaves identically
  assert.throws(() => parsePattern(legacyPattern, { lenient: false }), /index 6/);
});

test('pattern: unknown legacy color code degrades to blank cells in lenient mode', () => {
  const legacyPattern = {
    type: 'bead-grid-studio',
    version: 1,
    palette: 'universal-screen-64-v1',
    grid: {
      cols: 4,
      rows: 4,
      cells: [
        'N01', 'ZZ99', 'N01', 'N01',
        'N01', 'N01', 'QQ42', 'N01', // two unknown codes at indices 1 and 6
        ...new Array(8).fill(null),
      ],
    },
  };

  const migrated = parsePattern(legacyPattern, { lenient: true });
  assert.equal(migrated.metadata.migratedFromLegacy, true);
  assert.equal(migrated.metadata.strictMigration, false);
  // Unknown cells become blank, not a silently painted color
  assert.equal(migrated.grid.cells[1], null);
  assert.equal(migrated.grid.cells[6], null);
  assert.equal(migrated.rawIndices[1], -1);
  assert.equal(migrated.rawIndices[6], -1);
  // Known cells still migrate normally
  assert.equal(migrated.grid.cells[0], 'H2');
  // The degraded cells are reported in metadata, including their flat indices
  assert.deepEqual(migrated.metadata.unknownLegacyCells, [
    { index: 1, code: 'ZZ99' },
    { index: 6, code: 'QQ42' },
  ]);
  // 8 explicit nulls + 2 degraded unknowns = 10 empty; 6 migrated beads
  assert.equal(migrated.statistics.emptyCells, 10);
  assert.equal(migrated.statistics.totalBeads, 6);

  // Lenient mode also covers unknown codes in modern (v2) projects
  const modern = parsePattern({
    type: 'bead-grid-studio',
    version: 2,
    palette: { id: 'mard-compatible-base-221' },
    grid: { cols: 4, rows: 4, cells: ['NOPE', ...new Array(15).fill(null)] },
  }, { lenient: true });
  assert.equal(modern.grid.cells[0], null);
  assert.equal(modern.statistics.emptyCells, 16);
  assert.equal(modern.statistics.totalBeads, 0);
});

test('pattern: transparent anchor H1 is preserved on the grid but excluded from material counts', () => {
  const pattern = parsePattern({
    type: 'bead-grid-studio',
    version: 2,
    palette: { id: 'mard-compatible-base-221' },
    grid: {
      cols: 4,
      rows: 4,
      cells: [
        'H1', 'H7', 'H7', null,
        'H7', 'H1', null, null,
        ...new Array(8).fill(null),
      ],
    },
  });

  // H1 stays a first-class cell code rather than being flattened to null
  assert.equal(pattern.grid.cells[0], 'H1');
  assert.equal(pattern.grid.cells[5], 'H1');
  // But it is never counted as purchasable material
  assert.equal(pattern.statistics.transparentCells, 2);
  assert.equal(pattern.statistics.totalBeads, 3);
  assert.equal(pattern.statistics.emptyCells, 11);
  assert.equal(Object.prototype.hasOwnProperty.call(pattern.statistics.beadCounts, 'H1'), false);
  assert.deepEqual(pattern.statistics.colors.map((entry) => entry.code), ['H7']);
  assert.equal(pattern.statistics.beadCounts.H7, 3);
  // analyzePattern directly applies the same transparent exclusion
  const direct = analyzePattern(['H1', 'H1', 'H2', null, -1], getPaletteProvider().colors);
  assert.equal(direct.transparentCells, 2);
  assert.equal(direct.totalBeads, 1);
  assert.equal(direct.emptyCells, 2);
  assert.deepEqual(Object.keys(direct.beadCounts), ['H2']);
  // Transparent anchor never enters auto-matching palette used by the pipeline
  const matchable = getPaletteProvider().colors.filter(getPaletteProvider().autoMatchable);
  assert.equal(matchable.some((color) => color.code === 'H1'), false);
});

test('pattern: migrated and transparent patterns survive serialize/parse round-trips unchanged', () => {
  const legacyPattern = {
    type: 'bead-grid-studio',
    version: 1,
    palette: 'universal-screen-64-v1',
    grid: {
      cols: 4,
      rows: 4,
      cells: [
        'N01', 'H1', 'ZZ99', 'P07',
        null, 'N11', 'H1', 'P01',
        ...new Array(8).fill(null),
      ],
    },
  };

  const migrated = parsePattern(legacyPattern, { lenient: true });
  const roundTrip = parsePattern(serializePattern(migrated));

  // Cell color codes and blank-cell distribution remain identical after
  // re-serialization and re-parsing
  assert.deepEqual(roundTrip.grid.cells, migrated.grid.cells);
  assert.deepEqual(Array.from(roundTrip.rawIndices), Array.from(migrated.rawIndices));
  assert.deepEqual(roundTrip.statistics.beadCounts, migrated.statistics.beadCounts);
  assert.equal(roundTrip.statistics.totalBeads, migrated.statistics.totalBeads);
  assert.equal(roundTrip.statistics.emptyCells, migrated.statistics.emptyCells);
  assert.equal(roundTrip.statistics.transparentCells, migrated.statistics.transparentCells);
  // The re-parsed document is a modern one, but H1 placeholders survive intact
  assert.equal(roundTrip.metadata.migratedFromLegacy, false);
  assert.equal(roundTrip.grid.cells[1], 'H1');
  assert.equal(roundTrip.grid.cells[6], 'H1');
  assert.equal(roundTrip.grid.cells[2], null);

  // Pure H1/blank grid round-trips with zero materials on both sides
  const transparentOnly = parsePattern({
    type: 'bead-grid-studio',
    version: 2,
    palette: { id: 'mard-compatible-base-221' },
    grid: { cols: 4, rows: 4, cells: ['H1', ...new Array(15).fill(null)] },
  });
  const transparentAgain = parsePattern(serializePattern(transparentOnly));
  assert.deepEqual(transparentAgain.grid.cells, transparentOnly.grid.cells);
  assert.equal(transparentAgain.statistics.totalBeads, 0);
  assert.equal(transparentAgain.statistics.transparentCells, 1);
});

test('pattern: dimension and cell-count validations still reject malformed imports', () => {
  const base = (cols, rows, cells) => ({
    type: 'bead-grid-studio',
    version: 2,
    palette: { id: 'mard-compatible-base-221' },
    grid: { cols, rows, cells },
  });

  assert.throws(() => parsePattern(base(3, 4, new Array(12).fill(null))), /Invalid pattern dimensions/);
  assert.throws(() => parsePattern(base(4, 161, new Array(644).fill(null))), /Invalid pattern dimensions/);
  assert.throws(
    () => parsePattern(base(4, 4, new Array(15).fill(null))),
    /Cells array length \(15\) does not match grid dimensions \(4x4 = 16\)/,
  );
  assert.throws(
    () => parsePattern({ ...base(4, 4, new Array(16).fill(null)), type: 'something-else' }),
    /Unsupported pattern type/,
  );
  // Legacy projects are guarded by the same dimension checks
  assert.throws(() => parsePattern({
    type: 'bead-grid-studio',
    version: 1,
    palette: 'universal-screen-64-v1',
    grid: { cols: 2, rows: 2, cells: ['N01', 'N01', 'N01', 'N01'] },
  }), /Invalid pattern dimensions/);
});

test('quantize handles edge case inputs gracefully without throwing', () => {
  const empty = quantizePixels({
    data: null,
    width: 0,
    height: 0,
    cols: 10,
    rows: 10,
  });
  assert.equal(empty.nonEmpty, 0);
  assert.equal(empty.cells.length, 100);

  const transparent = quantizePixels({
    data: new Uint8ClampedArray(4 * 4 * 4).fill(0), // all alpha 0
    width: 4,
    height: 4,
    cols: 4,
    rows: 4,
  });
  assert.equal(transparent.nonEmpty, 0);
});

test('pattern validation: validatePattern accurately validates conformant and non-conformant patterns', () => {
  const validPattern = {
    grid: {
      cols: 10,
      rows: 10,
      cells: new Array(100).fill(null),
    },
  };
  const validResult = validatePattern(validPattern);
  assert.equal(validResult.valid, true);
  assert.equal(validResult.errors.length, 0);

  const invalidPattern = {
    grid: {
      cols: 10,
      rows: 10,
      cells: new Array(50).fill(null), // Mismatched cell count
    },
  };
  const invalidResult = validatePattern(invalidPattern);
  assert.equal(invalidResult.valid, false);
  assert.ok(invalidResult.errors.length > 0);

  // Test deserializePattern alias works identically to parsePattern
  const parsed = deserializePattern(validPattern);
  assert.equal(parsed.grid.cols, 10);
  assert.equal(parsed.grid.rows, 10);
});

test('pattern despeckle: despeckleGrid cleans isolated stray beads', () => {
  // 3x3 grid: all color 1, with a single isolated stray bead color 5 in the center
  const grid = new Int16Array([
    1, 1, 1,
    1, 5, 1,
    1, 1, 1,
  ]);
  const result = despeckleGrid(grid, 3, 3, { minNeighbors: 1 });
  assert.equal(result.changedCount, 1);
  assert.equal(result.cells[4], 1); // Center cell replaced with dominant neighbor 1
});

test('pattern color replace: replaceGridColor remapps all matching beads', () => {
  const grid = new Int16Array([
    1, 2, 1,
    2, 3, 2,
    1, 2, 1,
  ]);
  const result = replaceGridColor(grid, 2, 9);
  assert.equal(result.replacedCount, 4);
  assert.deepEqual(Array.from(result.cells), [
    1, 9, 1,
    9, 3, 9,
    1, 9, 1,
  ]);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { dirname, join, posix, sep } from 'path';
import { fileURLToPath } from 'url';
import loadShader, { getWatchFiles } from '../src/loadShader.js';

const testDir = dirname(fileURLToPath(import.meta.url));
const toPosix = path => path.split(sep).join(posix.sep);

const options = over => ({
  defaultExtension: 'glsl',
  warnDuplicatedImports: true,
  removeDuplicatedImports: false,
  importKeywords: ['#include'],
  onComplete: undefined,
  minify: false,
  root: '/',
  ...over
});

const load = (relative, over = {}) => {
  const shader = join(testDir, relative);
  return loadShader(readFileSync(shader, 'utf8'), shader, options(over));
};

const collectWarnings = async run => {
  const warnings = [];
  const listener = warning => warnings.push(warning);
  process.on('warning', listener);

  try {
    const result = await run();
    await new Promise(resolve => setTimeout(resolve, 20));
    return { result, warnings };
  } finally {
    process.off('warning', listener);
  }
};

test('case and "./" / ".." variants of one chunk share a normalized key', async () => {
  const { result, warnings } = await collectWarnings(() => load('glsl/normalized.frag'));
  const dependencies = [...result.dependentChunks.values()].flat();

  assert.equal(new Set(dependencies).size, 1);
  assert.equal(dependencies.length, 2);
  assert.equal(warnings.length, 1);

  const realPath = toPosix(join(testDir, 'glsl', 'utils', 'normalized.glsl'));
  assert.match(warnings[0].message, new RegExp(realPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(warnings[0].detail, /Duplicated import found in file/);
});

test('normalized duplicates are inlined once with removeDuplicatedImports', async () => {
  const { result } = await collectWarnings(() =>
    load('glsl/normalized.frag', { removeDuplicatedImports: true }));

  assert.equal((result.outputShader.match(/float normalizedChunk/g) || []).length, 1);
});

test('normalized duplicates stay silent with warnDuplicatedImports disabled', async () => {
  const { warnings } = await collectWarnings(() =>
    load('glsl/normalized.frag', { warnDuplicatedImports: false }));

  assert.equal(warnings.length, 0);
});

test('case and "./" variant cycle throws a recursion error with real paths', async () => {
  for (const removeDuplicatedImports of [false, true]) {
    await assert.rejects(
      () => load('glsl/recursion/cycleA.frag', { removeDuplicatedImports }),
      error => {
        assert.match(error.message, /Recursion detected when importing ".*" in ".*"\./);
        assert.ok(!error.message.includes(sep), 'error must not expose win32 separators');
        assert.match(error.message, /cycleA\.frag/);
        assert.match(error.message, /cycleB\.frag/);
        return true;
      }
    );
  }
});

test('addWatchFile dependencies are deduped real paths matching the graph', async () => {
  const { result } = await collectWarnings(() => load('glsl/normalized.frag'));

  const graphKeys = new Set([...result.dependentChunks.values()].flat());
  const watchFiles = getWatchFiles();

  assert.equal(graphKeys.size, 1);
  assert.equal(watchFiles.length, graphKeys.size);
  assert.equal(new Set(watchFiles).size, watchFiles.length, 'watch paths are deduped');
  assert.deepEqual(watchFiles, [toPosix(join(testDir, 'glsl', 'utils', 'normalized.glsl'))]);
});

test('regular multi-level imports keep their pre-normalization output', async () => {
  const { result, warnings } = await collectWarnings(() => load('glsl/main.frag'));

  assert.equal(warnings.length, 0);
  assert.match(result.outputShader, /chunkFn/);
  assert.match(result.outputShader, /chunkRGB/);
  assert.match(result.outputShader, /chunkRed/);
  assert.match(result.outputShader, /chunkGreen/);
  assert.equal((result.outputShader.match(/vec3 chunkRGB/g) || []).length, 1);
});

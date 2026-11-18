import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { dirname, join, posix, sep } from 'path';
import { fileURLToPath } from 'url';
import glsl from '../src/index.js';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const toPosix = p => p.split(sep).join(posix.sep);
const shader = join(repoRoot, 'test', 'glsl', 'normalized.frag');
const source = readFileSync(shader, 'utf8');

const runTransform = async options => {
  const plugin = await glsl(options);
  const watched = [];
  const result = await plugin.transform.handler.call({
    addWatchFile: id => watched.push(id)
  }, source, shader);
  return { result, watched };
};

// 1. Default mode: both inlines retained (legacy), one watch file only.
{
  const { result, watched } = await runTransform({});
  const code = result.code;
  assert.equal((code.match(/float normalizedChunk/g) || []).length, 2, 'keeps both inlines');
  assert.equal(new Set(watched).size, watched.length, 'watch paths are unique');
  assert.deepEqual(watched, [toPosix(join(repoRoot, 'test', 'glsl', 'utils', 'normalized.glsl'))],
    'watch receives the single real dependency path');
  console.log('default mode watch files:', watched);
}

// 2. removeDuplicatedImports: inlined once, same single watch file.
{
  const { result, watched } = await runTransform({ removeDuplicatedImports: true });
  assert.equal((result.code.match(/float normalizedChunk/g) || []).length, 1, 'inlined once');
  assert.deepEqual(watched, [toPosix(join(repoRoot, 'test', 'glsl', 'utils', 'normalized.glsl'))]);
  console.log('dedup mode watch files:', watched);
}

// 3. watch:false disables addWatchFile entirely.
{
  const { watched } = await runTransform({ watch: false });
  assert.deepEqual(watched, []);
  console.log('watch disabled ->', watched);
}

console.log('plugin integration checks passed');

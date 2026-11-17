/**
 * Test runner for the subtitles module.
 *
 * The repository has no test framework installed and video.js cannot be
 * instantiated in plain Node (its track classes need a full DOM). These tests
 * run the real subtitles module against video.js-accurate mocks using the
 * built-in `node:test` runner. esbuild (already a dev dependency via tsup)
 * bundles the TypeScript sources including the @imagekit/javascript runtime
 * dependency, then `node --test` executes the bundle.
 *
 * Usage from packages/video-player:
 *   node javascript/modules/subtitles/__tests__/run-tests.mjs
 */
import { build } from 'esbuild';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const workdir = mkdtempSync(join(tmpdir(), 'ik-subtitle-tests-'));
const outfile = join(workdir, 'subtitle-tests.mjs');

try {
  await build({
    entryPoints: [join(here, 'subtitles.test.ts')],
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    sourcemap: 'inline',
    outfile,
    logLevel: 'warning',
  });

  const exitCode = await new Promise((resolve) => {
    const child = spawn(process.execPath, ['--test', outfile], {
      stdio: 'inherit',
      env: {
        ...process.env,
        // The bundle runs from a temp dir; point it at the real sample fixtures.
        IK_SUBTITLE_SAMPLES_DIR: join(here, 'samples'),
      },
    });
    child.on('close', resolve);
    child.on('error', (err) => {
      console.error(err);
      resolve(1);
    });
  });

  process.exitCode = exitCode ?? 1;
} finally {
  rmSync(workdir, { recursive: true, force: true });
}

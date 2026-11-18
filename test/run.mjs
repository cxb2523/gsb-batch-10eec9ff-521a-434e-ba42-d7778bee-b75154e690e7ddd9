// Test entry point: (re)builds the browser test bundle from src and runs every test page.
// Requires a Chromium-based browser (set CHROME_BIN if it isn't on a standard path).
// Run with: npm test
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const testDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(testDir, '..');
const run = (cmd, args) => execFileSync(cmd, args, { cwd: repoRoot, stdio: 'inherit' });

console.log('Building browser test bundle from src/ ...');
run(process.execPath, [join(repoRoot, 'node_modules', 'rollup', 'dist', 'bin', 'rollup'), '-c', 'rollup.config.test.js']);

const pages = [
  'test/state-convergence.html',
  'test/regression-all.html'
];

let failed = 0;
for (const page of pages) {
  console.log(`\nRunning ${page} ...`);
  try {
    run(process.execPath, [join(testDir, 'run-page.mjs'), page, '15000']);
  } catch {
    failed++;
  }
}

if (failed) {
  console.error(`\n${failed}/${pages.length} test page(s) failed.`);
  process.exit(1);
}
console.log(`\nAll ${pages.length} test pages passed.`);

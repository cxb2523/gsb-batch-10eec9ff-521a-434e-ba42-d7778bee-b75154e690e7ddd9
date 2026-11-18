// Generic headless test runner based on Chrome's --dump-dom.
// It needs no DevTools/CDP connection, so it also works in sessions where
// remote debugging is unavailable (e.g. restricted Windows sandboxes).
//
// Usage: node test/run-page.mjs <pagePath> [virtualTimeBudgetMs]
// Env:   CHROME_BIN=/path/to/chrome-or-edge (otherwise standard locations are probed)
import { spawn, execFileSync } from 'child_process';
import { createServer } from 'http';
import { readFile } from 'fs/promises';
import { rmSync, existsSync } from 'fs';
import { extname, join, normalize } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const pagePath = process.argv[2];
const budget = process.argv[3] || 15000;
const port = 8793 + Math.floor(Math.random() * 100);

if (!pagePath) {
  console.error('Usage: node test/run-page.mjs <pagePath> [virtualTimeBudgetMs]');
  process.exit(2);
}

const findBrowser = () => {
  if (process.env.CHROME_BIN && existsSync(process.env.CHROME_BIN)) return process.env.CHROME_BIN;
  const candidates = [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
  ];
  const found = candidates.find(existsSync);
  if (found) return found;
  for (const cmd of ['chrome', 'chromium', 'google-chrome']) {
    try {
      execFileSync(process.platform === 'win32' ? 'where' : 'which', [cmd], { stdio: 'ignore' });
      return cmd;
    } catch { /* try next */ }
  }
  throw new Error('No Chromium-based browser found. Set CHROME_BIN to a chrome/edge executable.');
};

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.json': 'application/json', '.map': 'application/json',
  '.wasm': 'application/wasm'
};

const server = createServer(async (req, res) => {
  try {
    const urlPath = decodeURIComponent(req.url.split('?')[0]);
    const filePath = normalize(join(repoRoot, urlPath));
    if (!filePath.startsWith(repoRoot)) { res.writeHead(403); res.end('forbidden'); return; }
    const data = await readFile(filePath);
    res.writeHead(200, { 'Content-Type': MIME[extname(filePath)] || 'application/octet-stream' });
    res.end(data);
  } catch {
    res.writeHead(404); res.end('not found');
  }
});
await new Promise(r => server.listen(port, '127.0.0.1', r));

const profileDir = join(tmpdir(), `three-render-objects-test-${process.pid}`);
rmSync(profileDir, { recursive: true, force: true });

const chromeArgs = [
  '--headless=new',
  '--no-sandbox',
  '--disable-dev-shm-usage',
  '--use-gl=angle',
  '--use-angle=swiftshader',
  '--enable-unsafe-swiftshader',
  `--user-data-dir=${profileDir}`,
  ...(budget > 0 ? [`--virtual-time-budget=${budget}`] : ['--timeout=30000']),
  '--run-all-compositor-stages-before-draw',
  '--dump-dom',
  `http://127.0.0.1:${port}/${pagePath}`
];

let out;
try {
  out = await new Promise((resolve, reject) => {
    const proc = spawn(findBrowser(), chromeArgs, { windowsHide: true });
    let stdout = '', stderr = '';
    proc.stdout.on('data', d => { stdout += d; });
    proc.stderr.on('data', d => { stderr += d; });
    proc.on('error', reject);
    proc.on('exit', code => resolve({ code, stdout, stderr }));
    setTimeout(() => { proc.kill(); reject(new Error('browser timeout')); }, 60000);
  });
} finally {
  server.close();
  rmSync(profileDir, { recursive: true, force: true });
}

const m = out.stdout.match(/<div id="results">([\s\S]*?)<\/div>/);
const result = m ? m[1].trim() : null;
console.log('PAGE RESULT:', result);
if (!result || !result.startsWith('PASS')) {
  console.log('--- browser stderr (filtered) ---');
  console.log(out.stderr.split('\n').filter(l => !/TensorFlow|XNNPACK/i.test(l)).slice(0, 15).join('\n'));
  process.exit(1);
}

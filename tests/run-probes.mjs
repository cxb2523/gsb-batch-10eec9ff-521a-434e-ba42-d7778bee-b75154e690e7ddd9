// Runs the in-browser probes in headless Chrome and prints their results.
// Usage: node tests/run-probes.mjs [--chrome <path>]
//
// Requires a dev server (`npm run dev:web`) on port 5173 (or PROBE_PORT).
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';

const PORT = process.env.PROBE_PORT || '5173';
const CANDIDATES = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(Boolean);

const chrome = CANDIDATES.find((p) => existsSync(p));
if (!chrome) {
  console.error('No Chrome/Edge binary found. Set CHROME_PATH.');
  process.exit(2);
}

const pages = ['tests/dispose-probe.html', 'tests/app-flow-probe.html'];
let failed = 0;

for (const page of pages) {
  const url = `http://localhost:${PORT}/${page}`;
  const out = await new Promise((resolve) => {
    const child = spawn(
      chrome,
      [
        '--headless=new',
        '--disable-gpu-sandbox',
        '--enable-unsafe-swiftshader',
        '--use-angle=swiftshader',
        '--no-sandbox',
        '--autoplay-policy=no-user-gesture-required',
        '--virtual-time-budget=120000',
        '--dump-dom',
        url,
      ],
      { stdio: ['ignore', 'pipe', 'ignore'] }
    );
    let body = '';
    child.stdout.on('data', (c) => (body += c));
    child.on('close', () => resolve(body));
  });

  const lines = [...out.matchAll(/<pre[^>]*>([\s\S]*?)<\/pre>/g)].map((m) =>
    m[1].replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&quot;/g, '"').replace(/&amp;/g, '&')
  );
  console.log(`\n=== ${page}`);
  for (const line of lines) console.log(line);
  const passed = /ALL CHECKS PASSED/.test(out);
  if (!passed) failed++;
}

process.exit(failed ? 1 : 0);

/**
 * 视觉验收：主机/客机双窗口联机，在 intro / live / koSlow / 新回合 / 结算 / 重赛
 * 各关键节点同时截取两端画面，输出到 tools/shots/ 供人工/评测比对。
 * 用法：node tools/shoot-net.mjs
 */
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';

const CHROME = process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const BASE = process.env.BASE || 'http://localhost:3123';
const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'shots');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const getJSON = (url) => new Promise((res, rej) => {
  http.get(url, r => { let d = ''; r.on('data', c => d += c); r.on('end', () => res(JSON.parse(d))); }).on('error', rej);
});
let idc = 0;
function cdp(ws, method, params = {}) {
  const id = ++idc;
  return new Promise((resolve, reject) => {
    const onMsg = (data) => {
      const m = JSON.parse(data.toString());
      if (m.id === id) { ws.off('message', onMsg); m.error ? reject(new Error(method + ': ' + JSON.stringify(m.error))) : resolve(m.result); }
    };
    ws.on('message', onMsg);
    ws.send(JSON.stringify({ id, method, params }));
  });
}
async function launch(role, port) {
  const profile = path.join(process.env.USERPROFILE, 'niulai-shot-prof_' + role);
  fs.rmSync(profile, { recursive: true, force: true });
  const p = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
    '--remote-debugging-port=' + port, '--user-data-dir=' + profile,
    '--window-size=1280,800', '--enable-unsafe-swiftshader',
    BASE + '/?lan=1&pick=0&auto=1',
  ], { stdio: 'ignore' });
  for (let i = 0; i < 40; i++) {
    try {
      await getJSON(`http://127.0.0.1:${port}/json/version`);
      const list = await getJSON(`http://127.0.0.1:${port}/json/list`);
      const page = list.find(t => t.type === 'page' && t.url.startsWith(BASE) && t.webSocketDebuggerUrl);
      if (page) return { p, wsUrl: page.webSocketDebuggerUrl, port };
    } catch { /* retry */ }
    await sleep(250);
  }
  throw new Error(role + ' not ready');
}
function session(b) {
  return (async () => {
    const ws = new WebSocket(b.wsUrl, { perMessageDeflate: false, maxPayload: 128 * 1024 * 1024 });
    await new Promise(r => ws.on('open', r));
    await cdp(ws, 'Runtime.enable'); await cdp(ws, 'Page.enable');
    return ws;
  })();
}
const ev = async (ws, expr) => {
  const out = await cdp(ws, 'Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (out.exceptionDetails) throw new Error(out.exceptionDetails.exception?.description || JSON.stringify(out.exceptionDetails));
  return out.result.value;
};
const STATE = `(() => { const g=window.__game; return g ? { phase:g.phase, sub:g.subPhase, round:g.round,
  states:g.fighters.map(f=>f.state), result:!document.getElementById('screen-result').classList.contains('hidden') } : null; })()`;
const shot = async (ws, name) => {
  const r = await cdp(ws, 'Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(OUT, name + '.png'), Buffer.from(r.data, 'base64'));
};
const close = async (b) => {
  try { const v = await getJSON(`http://127.0.0.1:${b.port}/json/version`); const ws = new WebSocket(v.webSocketDebuggerUrl); await new Promise(r => ws.on('open', r)); ws.send(JSON.stringify({ id: 1, method: 'Browser.close' })); await sleep(400); } catch {}
  try { b.p.kill(); } catch {}
};

const run = async () => {
  fs.rmSync(OUT, { recursive: true, force: true }); fs.mkdirSync(OUT, { recursive: true });
  const host = await launch('host', 9351); await sleep(1200);
  const guest = await launch('guest', 9352);
  const hws = await session(host), gws = await session(guest);
  for (let i = 0; i < 30 && !(await ev(hws, STATE)); i++) await sleep(1000);

  const want = [
    ['01-intro', s => s.phase === 'fight' && s.sub === 'intro'],
    ['02-live', s => s.phase === 'fight' && s.sub === 'live' && s.round === 1],
    ['03-koSlow', s => s.phase === 'fight' && s.sub === 'koSlow'],
    ['04-round2-intro', s => s.phase === 'fight' && s.sub === 'intro' && s.round >= 2],
    ['05-result', s => s.phase === 'result'],
  ];
  const taken = new Set();
  const t0 = Date.now();
  while (Date.now() - t0 < 150000 && taken.size < want.length) {
    const hs = await ev(hws, STATE);
    if (!hs) { await sleep(500); continue; }
    for (const [name, pred] of want) {
      if (!taken.has(name) && pred(hs)) {
        await sleep(150);   // 让客机快照到达同一节点
        await shot(hws, name + '_host');
        await shot(gws, name + '_guest');
        const gs = await ev(gws, STATE);
        taken.add(name);
        console.log(`📸 ${name}  host=${JSON.stringify(hs)}  guest=${JSON.stringify(gs)}`);
      }
    }
    await sleep(400);
  }

  // 重赛后再截一组：确认两端都退出结算回到新对局
  if (taken.has('05-result')) {
    await sleep(1000);
    await ev(hws, `document.getElementById('btn-rematch').click(); 1`);
    for (let i = 0; i < 20; i++) {
      const hs = await ev(hws, STATE);
      if (hs && hs.phase === 'fight') {
        await sleep(600);
        await shot(hws, '06-rematch_host'); await shot(gws, '06-rematch_guest');
        console.log('📸 06-rematch  host=' + JSON.stringify(hs) + '  guest=' + JSON.stringify(await ev(gws, STATE)));
        break;
      }
      await sleep(500);
    }
  }
  hws.close(); gws.close();
  await close(host); await close(guest);
  console.log('截图目录：' + OUT);
  process.exit(taken.size === want.length ? 0 : 1);
};
run().catch(e => { console.error(e); process.exit(2); });

/**
 * 回归冒烟：单人直达对战（?fight=）本地模式跑一段，
 * 抓取页面 window.__errors 与关键状态，确认重构未破坏本地/AI 模式。
 * 用法：node tools/test-smoke.mjs
 */
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { WebSocket } from 'ws';

const CHROME = process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const BASE = process.env.BASE || 'http://localhost:3123';
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
async function launch(port, query) {
  const profile = path.join(process.env.USERPROFILE, 'niulai-smoke-prof_' + port);
  fs.rmSync(profile, { recursive: true, force: true });
  const p = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
    '--remote-debugging-port=' + port, '--user-data-dir=' + profile,
    '--window-size=1280,800', '--enable-unsafe-swiftshader',
    BASE + query,
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
  throw new Error('chrome not ready on ' + port);
}
async function ev(b, expr) {
  const ws = new WebSocket(b.wsUrl, { perMessageDeflate: false, maxPayload: 64 * 1024 * 1024 });
  await new Promise(r => ws.on('open', r));
  await cdp(ws, 'Runtime.enable');
  const out = await cdp(ws, 'Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  ws.close();
  if (out.exceptionDetails) throw new Error(out.exceptionDetails.exception?.description || JSON.stringify(out.exceptionDetails));
  return out.result.value;
}
/** 轮询求值直到 window.__game 就绪（页面模块加载有抖动） */
async function evReady(b, expr, tries = 20) {
  for (let i = 0; i < tries; i++) {
    const v = await ev(b, `(window.__game ? (${expr}) : null)`);
    if (v) return v;
    await sleep(500);
  }
  throw new Error('window.__game never became ready');
}
const EXPR = `(() => { const g=window.__game; return {
  phase:g.phase, sub:g.subPhase, round:g.round,
  states:g.fighters.map(f=>f.state), clips:g.fighters.map(f=>!!f.model.clip),
  hp:g.fighters.map(f=>Math.round(f.hp)), errors:window.__errors.slice(-10),
}; })()`;

const run = async () => {
  const results = [];
  const check = (n, c, d = '') => { results.push(!!c); console.log((c ? '  ✅' : '  ❌') + ' ' + n + (d ? ' — ' + d : '')); };

  // 1) AI 模式直达对战
  const ai = await launch(9341, '/?fight=xiaoniu,jinbao&mode=ai');
  await sleep(6000);
  const mid = await evReady(ai, EXPR);
  check('AI 模式留在 fight', mid.phase === 'fight', mid.phase);
  check('AI 模式无 JS 报错', mid.errors.length === 0, JSON.stringify(mid.errors));
  check('AI 模式两角色状态机正常推进', mid.states.every(Boolean), JSON.stringify(mid.states));

  // 2) 必杀展示模式（覆盖 buildSpecialClip 重构后的主机路径）
  const sc = await launch(9342, '/?fight=xiaoniu,jinbao&demo=showcase&full=1');
  const SP_EXPR = `(() => { const g=window.__game;
    return { phase:g.phase, sawSpecial: g.fighters.some(f=>f.state==='special'),
      clipOnSpecial: g.fighters.some(f=>f.state==='special' && !!f.model.clip),
      errors: window.__errors.slice(-10) }; })()`;
  let sp = null;
  for (let i = 0; i < 25; i++) {
    await sleep(1000);
    sp = await evReady(sc, SP_EXPR);
    if (sp.sawSpecial) break;
  }
  check('showcase 演示运行在 fight', sp.phase === 'fight', sp.phase);
  check('必杀状态播放动画片段（buildSpecialClip 主机路径）', sp.sawSpecial && sp.clipOnSpecial, JSON.stringify(sp));
  check('showcase 无 JS 报错', sp.errors.length === 0, JSON.stringify(sp.errors));

  // 3) 本地双人模式可进入并正常推进
  const lo = await launch(9343, '/?fight=xiaoniu,jinbao&mode=local');
  await sleep(4000);
  const loc = await evReady(lo, EXPR);
  check('本地模式 fight 正常', loc.phase === 'fight' && loc.errors.length === 0, JSON.stringify(loc.errors));

  const pass = results.filter(Boolean).length;
  console.log('\\n=== smoke：' + pass + '/' + results.length + ' 通过 ===');
  for (const b of [ai, sc, lo]) {
    try { const v = await getJSON(`http://127.0.0.1:${b.port}/json/version`); const ws = new WebSocket(v.webSocketDebuggerUrl); await new Promise(r => ws.on('open', r)); ws.send(JSON.stringify({ id: 1, method: 'Browser.close' })); await sleep(400); ws.close(); } catch {}
    try { b.p.kill(); } catch {}
  }
  process.exit(pass === results.length ? 0 : 1);
};
run().catch(e => { console.error(e); process.exit(2); });

/**
 * 端到端联机收敛测试（无人值守）：
 * 启动两个 headless Chrome（主机 / 客机），经真实 WebSocket 服务器联机，
 * 主机自动驾驶触发完整 KO → 慢动作 → 回合切换 → 结算 → 重赛流程，
 * 周期性抓取两端 Game 状态并断言客机向主机收敛。
 *
 * 用法：node tools/e2e-nettest.mjs
 */
import { spawn } from 'node:child_process';
import { WebSocket } from 'ws';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const CHROME = process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const BASE = process.env.BASE || 'http://localhost:3123';
const RUN_MS = Number(process.env.RUN_MS || 150000);   // 回合时长 60s，需覆盖 KO→多回合→结算→重赛

const getJSON = (url) => new Promise((res, rej) => {
  http.get(url, r => { let d = ''; r.on('data', c => d += c); r.on('end', () => res(JSON.parse(d))); }).on('error', rej);
});
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

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
  // Chrome 157 要求 user-data-dir 位于真实用户目录（本沙箱 USERPROFILE 被重定向，C:\Windows\Temp 会被拒绝）
  const profile = path.join(process.env.USERPROFILE, 'niulai-e2e-prof_' + role);
  fs.rmSync(profile, { recursive: true, force: true });
  const args = [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
    '--remote-debugging-port=' + port,
    '--user-data-dir=' + profile,
    '--window-size=1280,800',
    '--enable-unsafe-swiftshader',
    BASE + '/?lan=1&pick=0&auto=1',
  ];
  const p = spawn(CHROME, args, { stdio: 'ignore' });
  for (let i = 0; i < 40; i++) {
    try {
      await getJSON(`http://127.0.0.1:${port}/json/version`);
      const list = await getJSON(`http://127.0.0.1:${port}/json/list`);
      const page = list.find(t => t.type === 'page' && t.url.startsWith(BASE) && t.webSocketDebuggerUrl);
      if (page) return { p, wsUrl: page.webSocketDebuggerUrl, role, port };
    } catch { /* still starting */ }
    await sleep(250);
  }
  throw new Error(role + ' chrome did not open debug port');
}

async function closeBrowser(browser) {
  try {
    const v = await getJSON(`http://127.0.0.1:${browser.port}/json/version`);
    const ws = new WebSocket(v.webSocketDebuggerUrl, { perMessageDeflate: false });
    await new Promise(r => ws.on('open', r));
    ws.send(JSON.stringify({ id: 1, method: 'Browser.close' }));
    await sleep(600);
    ws.close();
  } catch { /* already closed */ }
  try { browser.p.kill(); } catch { /* ignore */ }
}

async function evalIn(browser, expr) {
  const ws = new WebSocket(browser.wsUrl, { perMessageDeflate: false, maxPayload: 64 * 1024 * 1024 });
  await new Promise(r => ws.on('open', r));
  await cdp(ws, 'Runtime.enable');
  const out = await cdp(ws, 'Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  ws.close();
  if (out.exceptionDetails) throw new Error(JSON.stringify(out.exceptionDetails.exception?.description || out.exceptionDetails));
  return out.result.value;
}

const STATE_EXPR = `(() => {
  const g = window.__game;
  if (!g) return null;
  return {
    phase: g.phase, sub: g.subPhase, round: g.round, timer: +g.timer.toFixed(2),
    score: g.score, mode: g.mode, stage: g._stageId || null,
    netRole: g.netRole, rx: g.net?.rxCount || 0, lastRx: g.net?.lastRx || null,
    resultShown: !document.getElementById('screen-result').classList.contains('hidden'),
    hudShown: !document.getElementById('hud').classList.contains('hidden'),
    f: g.fighters.map(f => ({
      state: f.state, x: +f.x.toFixed(2), y: +f.y.toFixed(2), hp: Math.round(f.hp),
      hasClip: !!f.model.clip, spKind: f.special?.kind || null,
      bodyRx: +f.model.body.rotation.x.toFixed(2), bodyRz: +f.model.body.rotation.z.toFixed(2),
      poseState: f._poseState || null, roundsWon: f.roundsWon,
    })),
    camFov: g.camera.fov,
    koLoser: g._koLoserIdx ?? null,
    fx: g.fx.particles.length + g.fx.rings.length + (g.fx.phantoms?.length || 0),
  };
})()`;

const asserts = [];
function check(name, cond, detail = '') {
  asserts.push({ name, pass: !!cond, detail: detail ? String(detail).slice(0, 300) : '' });
  console.log((cond ? '  ✅' : '  ❌') + ' ' + name + (detail ? ' — ' + detail : ''));
}

const main = async () => {
  console.log('launching host/guest headless chrome …');
  const host = await launch('host', 9331);
  await sleep(1500);
  const guest = await launch('guest', 9332);

  // 等待匹配 + 自动选人 + 开局（开局耗时有抖动，轮询直到两端都进入 fight）
  let booted = false;
  for (let i = 0; i < 30; i++) {
    await sleep(1000);
    const [h, gu] = await Promise.all([evalIn(host, STATE_EXPR), evalIn(guest, STATE_EXPR)]);
    if (h && gu && h.phase === 'fight' && gu.phase === 'fight') { booted = true; break; }
  }
  console.log(booted ? 'both clients in fight, sampling …' : 'WARN: fight phase not observed before sampling');
  const timeline = [];
  const t0 = Date.now();
  let lastHost = null;
  while (Date.now() - t0 < RUN_MS) {
    const [h, gu] = await Promise.all([evalIn(host, STATE_EXPR), evalIn(guest, STATE_EXPR)]);
    if (!h || !gu) { await sleep(500); continue; }   // 页面重载/导航瞬间的空帧跳过
    timeline.push({ t: +((Date.now() - t0) / 1000).toFixed(1), h, g: gu });
    lastHost = h;
    await sleep(1000);
  }

  // ---------- 断言 ----------
  console.log('\\n=== 断言 ===');
  const first = timeline[0];
  const last = timeline[timeline.length - 1];
  check('两端都进入对局（host fight）', first.h.phase === 'fight', 'host phase=' + first.h.phase);
  check('客机角色为 net-guest', first.g.mode === 'net-guest', first.g.mode);
  check('客机持续收到主机快照', last.g.rx > 30, 'rx=' + last.g.rx + ' lastRx=' + last.g.lastRx);

  // 子阶段镜像：每个采样点客机 sub 应与主机一致（允许 1 个采样点的传输延迟）
  let subMismatch = 0;
  for (let i = 1; i < timeline.length; i++) {
    if (timeline[i].g.sub !== timeline[i].h.sub) {
      // 容忍：主机刚切换、快照还在途（与前一采样点主机相同即视为延迟而非错误）
      const prevHost = timeline[i - 1].h.sub;
      if (timeline[i].g.sub !== prevHost) subMismatch++;
    }
  }
  check('客机子阶段与主机收敛（intro/live/koSlow/roundend）', subMismatch <= 1, 'mismatch frames=' + subMismatch);

  // 舞台以主机快照为准（旧问题：两端各自随机，背景完全不同）
  const stageDiff = timeline.filter(p => p.g.stage && p.h.stage && p.g.stage !== p.h.stage).length;
  check('客机舞台与主机一致（快照驱动重建）', stageDiff === 0,
    'diff samples=' + stageDiff + ' host=' + last.h.stage + ' guest=' + last.g.stage);

  // 经历过 KO 慢动作
  const sawKoSlow = timeline.some(p => p.h.sub === 'koSlow');
  check('主机流程覆盖 KO 慢动作', sawKoSlow);
  const gKo = timeline.filter(p => p.g.sub === 'koSlow');
  if (gKo.length) {
    const p = gKo[0];
    check('客机 koSlow 时败者处于 ko 姿态', p.g.f.some(f => f.state === 'ko'), JSON.stringify(p.g.f.map(f => f.state)));
    check('客机 koSlow 时记录了败者索引（相机聚焦）', p.g.koLoser != null, 'koLoser=' + p.g.koLoser);
  } else {
    check('客机 koSlow 时败者处于 ko 姿态', false, 'guest never entered koSlow');
    check('客机 koSlow 时记录了败者索引（相机聚焦）', false);
  }

  // 回合切换：主机 round 增长后，客机跟随；且新回合客机角色回到 idle、无残留 clip
  const maxRound = Math.max(...timeline.map(p => p.h.round));
  check('流程覆盖多回合（round>=2 或已结算）', maxRound >= 2 || last.h.phase === 'result', 'maxRound=' + maxRound + ' hostPhase=' + last.h.phase);
  // 回合切换检测：intro 仅 1.7s，可能落在 1.2s 采样间隔之间，
  // 因此用“主机回合数增长”定位边界（必然被采到），再找客机在新回合的首个采样
  let roundTwoIdx = -1;
  for (let i = 1; i < timeline.length; i++) {
    if (timeline[i].h.round >= 2 && timeline[i - 1].h.round < 2) { roundTwoIdx = i; break; }
  }
  if (roundTwoIdx >= 0) {
    const gFollow = timeline.slice(roundTwoIdx, roundTwoIdx + 4).some(p => p.g.round >= 2);
    check('客机回合数跟随主机', gFollow);
    // 新回合首个客机采样：优先 intro，采不到则接受新回合的 live 头几帧（残留清理在 round 事件时已完成）
    const window = timeline.slice(roundTwoIdx, roundTwoIdx + 5).map(p => p.g);
    const gFresh = window.find(p => p.round >= 2 && p.sub === 'intro') || window.find(p => p.round >= 2);
    if (gFresh) {
      check('新回合开场客机无残留攻击片段', gFresh.f.every(f => !f.hasClip), JSON.stringify(gFresh.f.map(f => f.hasClip)));
      check('新回合开场客机角色为 idle 且身体无倒地旋转', gFresh.f.every(f => f.state === 'idle' && Math.abs(f.bodyRx) < 0.2), JSON.stringify(gFresh.f.map(f => [f.state, f.bodyRx]))) ;
      check('新回合开场客机旧特效已清理', gFresh.fx === 0, 'leftover fx=' + gFresh.fx);
    } else {
      check('新回合开场客机无残留攻击片段', false, 'no guest round-2 sample');
      check('新回合开场客机角色为 idle 且身体无倒地旋转', false);
      check('新回合开场客机旧特效已清理', false);
    }
  } else if (last.h.phase !== 'result') {
    check('客机回合数跟随主机', false, 'host never reached round 2');
  } else {
    check('客机回合数跟随主机（流程直接结算）', true);
    check('新回合开场客机无残留攻击片段（无下一回合）', true);
    check('新回合开场客机角色为 idle 且身体无倒地旋转（无下一回合）', true);
    check('新回合开场客机旧特效已清理（无下一回合）', true);
  }

  // 姿态一致性：30Hz 快照在途 + 约 1.2s 采样间隔会让快速连段出现相邻采样点的滞后（属正常），
  // 真正的“旧姿势定格/覆盖新回合”缺陷表现为错位跨越整个回合边界（数十秒不收敛）。
  // 阈值取 4 个采样间隔（~5s）：正常滞后最长 2~3 拍即重新对齐，定格缺陷会远超此值
  let maxLagSec = 0;
  const runStart = [null, null];
  const longRuns = [];
  for (let i = 1; i < timeline.length; i++) {
    for (let k = 0; k < 2; k++) {
      const lagging = timeline[i].g.f[k].state !== timeline[i].h.f[k].state &&
        timeline[i].g.f[k].state !== timeline[i - 1].h.f[k].state;
      if (lagging) {
        if (runStart[k] == null) runStart[k] = timeline[i].t;
        const dur = timeline[i].t - runStart[k];
        maxLagSec = Math.max(maxLagSec, dur);
        if (dur >= 3) longRuns.push(`t=${timeline[i].t}s f${k} g=${timeline[i].g.f[k].state} h=${timeline[i].h.f[k].state} (${dur.toFixed(1)}s)`);
      } else runStart[k] = null;
    }
  }
  check('客机姿态错位均在 5s 内收敛（无定格/旧姿势覆盖）', maxLagSec < 5,
    'max divergence run=' + maxLagSec.toFixed(1) + 's' + (longRuns.length ? '；明细: ' + longRuns.join(' | ') : ''));

  // 结算
  const hostResult = timeline.find(p => p.h.phase === 'result');
  if (hostResult) {
    const i = timeline.indexOf(hostResult);
    const gResultSoon = timeline.slice(i, i + 4).some(p => p.g.phase === 'result' && p.g.resultShown);
    check('主机结算后客机进入结算界面', gResultSoon);
    check('客机结算界面与主机比分一致', timeline.slice(i).map(p => p.g).find(p => p.phase === 'result')?.score?.join('-') === hostResult.h.score.join('-'),
      'host=' + hostResult.h.score.join('-'));
    const wIdx = hostResult.h.score[0] >= 2 ? 0 : 1;
    const gRes = timeline.slice(i).map(p => p.g).find(p => p.phase === 'result');
    check('客机胜者保持 win 姿势', gRes?.f?.[wIdx]?.state === 'win', JSON.stringify(gRes?.f?.map(f => f.state)));
  } else {
    check('主机结算后客机进入结算界面', false, 'host never reached result within window');
    check('客机结算界面与主机比分一致', false);
    check('客机胜者保持 win 姿势', false);
  }

  // 重赛：在主机进入 result 后通过 CDP 点击主机的“再来一局”
  if (hostResult) {
    await sleep(800);
    await evalIn(host, `document.getElementById('btn-rematch').click(); 'clicked'`);
    const t1 = Date.now();
    let rematchOk = false, resultGone = false;
    const after = [];
    while (Date.now() - t1 < 6000) {
      const [h, gu] = await Promise.all([evalIn(host, STATE_EXPR), evalIn(guest, STATE_EXPR)]);
      if (!h || !gu) { await sleep(400); continue; }
      after.push({ h, g: gu });
      if (h.phase === 'fight' && gu.phase === 'fight') rematchOk = true;
      if (!gu.resultShown && gu.hudShown) resultGone = true;
      await sleep(500);
    }
    check('重赛后主机自身回到 fight（原 bug：主机卡在结算）', after.some(p => p.h.phase === 'fight'), 'host phases=' + [...new Set(after.map(p => p.h.phase))].join(','));
    check('重赛后客机退出结算界面并显示 HUD', resultGone);
    check('重赛后两端均回到 fight 且客机继续收快照', rematchOk && after[after.length - 1].g.rx > last.g.rx,
      'rx ' + last.g.rx + ' -> ' + after[after.length - 1].g.rx);
    const fresh = after.find(p => p.h.phase === 'fight' && p.g.phase === 'fight');
    if (fresh) {
      check('重赛后客机比分/回合归零与主机一致', fresh.g.round === 1 && fresh.g.score.join('-') === fresh.h.score.join('-'),
        'g=' + JSON.stringify([fresh.g.round, fresh.g.score]) + ' h=' + JSON.stringify([fresh.h.round, fresh.h.score]));
      check('重赛后客机角色 idle 且无残留片段/倒地旋转', fresh.g.f.every(f => f.state === 'idle' && !f.hasClip && Math.abs(f.bodyRx) < 0.2),
        JSON.stringify(fresh.g.f.map(f => [f.state, f.hasClip, f.bodyRx])));
    } else {
      check('重赛后客机比分/回合归零与主机一致', false);
      check('重赛后客机角色 idle 且无残留片段/倒地旋转', false);
    }
  }

  // 返回菜单：主机点击“回到主菜单”
  try {
    await evalIn(host, `document.getElementById('btn-to-menu').click(); 'clicked'`);
    await sleep(2500);
    const [h, gu] = await Promise.all([evalIn(host, STATE_EXPR), evalIn(guest, STATE_EXPR)]);
    check('返回菜单后主机回到 title', h?.phase === 'title', h?.phase);
    check('返回菜单后客机回到 title（退出结算/战斗界面）', gu?.phase === 'title' && !gu?.resultShown, (gu?.phase) + ' result=' + gu?.resultShown);
  } catch (e) {
    check('返回菜单流程', false, e.message);
  }

  const fails = asserts.filter(a => !a.pass);
  console.log('\\n=== 结果：' + (asserts.length - fails.length) + '/' + asserts.length + ' 通过 ===');
  fs.writeFileSync(path.join(ROOT, 'e2e-timeline.json'), JSON.stringify(timeline, null, 1));
  await closeBrowser(host); await closeBrowser(guest);
  process.exit(fails.length ? 1 : 0);
};

main().catch(e => { console.error(e); process.exit(2); });

/**
 * 服务器中继协议测试：验证 state 快照字段（含 sub 子阶段、evts 事件）被原样转发给客机，
 * 以及 cmd 双向透传。不依赖浏览器，纯 WebSocket 打服务器。
 *
 * 用法：node tools/test-relay.mjs
 */
import { WebSocket } from 'ws';

const PORT = process.env.PORT || 3123;
const URL = `ws://127.0.0.1:${PORT}`;
const results = [];
const check = (name, cond, detail = '') => { results.push({ name, pass: !!cond, detail }); console.log((cond ? '  ✅' : '  ❌') + ' ' + name + (detail ? ' — ' + detail : '')); };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function open() {
  const ws = new WebSocket(URL);
  ws.messages = [];
  ws.on('message', d => ws.messages.push(JSON.parse(d.toString())));
  return new Promise((res, rej) => { ws.on('open', () => res(ws)); ws.on('error', rej); });
}
const waitFor = async (ws, type, timeout = 3000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const m = ws.messages.find(x => x.type === type);
    if (m) return m;
    await sleep(30);
  }
  return null;
};

const run = async () => {
  const host = await open();
  host.send(JSON.stringify({ type: 'join' }));
  const r1 = await waitFor(host, 'role');
  check('首个连接被分配 host', r1?.role === 'host');

  const guest = await open();
  guest.send(JSON.stringify({ type: 'join' }));
  const r2 = await waitFor(guest, 'role');
  check('次个连接被分配 guest', r2?.role === 'guest');
  check('主机收到 matched', !!(await waitFor(host, 'matched')));
  check('客机收到 matched', !!(await waitFor(guest, 'matched')));

  // ---- 核心回归：state 快照原样转发（旧 bug 服务器读 msg.data，客机收到空壳）----
  const snap = {
    type: 'state', phase: 'fight', sub: 'koSlow', t: 42.5, round: 2, score: [1, 0],
    f: [{ x: 1, state: 'win' }, { x: -1, state: 'ko' }],
    evts: [{ k: 'ko', slot: 1 }, { k: 'round', n: 2 }],
  };
  host.send(JSON.stringify(snap));
  const got = await waitFor(guest, 'state');
  check('客机收到 state 消息', !!got);
  check('快照保留 phase/sub（子阶段同步的前提）', got?.sub === 'koSlow' && got?.phase === 'fight', 'sub=' + got?.sub);
  check('快照保留 f 木偶数据（旧 bug 下为 undefined）', Array.isArray(got?.f) && got.f.length === 2);
  check('快照保留 evts 事件列表', Array.isArray(got?.evts) && got.evts.length === 2 && got.evts[0].k === 'ko');
  check('快照保留 timer/round/score', got?.t === 42.5 && got?.round === 2 && got?.score?.[0] === 1);

  // ---- cmd 双向透传（rematch / menu / start）----
  host.send(JSON.stringify({ type: 'cmd', cmd: 'rematch' }));
  const rem = await waitFor(guest, 'cmd');
  check('主机 → 客机 cmd rematch 透传', rem?.cmd === 'rematch');
  guest.send(JSON.stringify({ type: 'cmd', cmd: 'menu' }));
  const menu = await waitFor(host, 'cmd');
  check('客机 → 主机 cmd menu 透传', menu?.cmd === 'menu');

  // ---- 输入只送到主机 ----
  guest.send(JSON.stringify({ type: 'input', keys: { lp: true } }));
  const inp = await waitFor(host, 'input');
  check('客机 input 送达主机', inp?.keys?.lp === true);

  // ---- 客机发的 state 不应被转发（服务器只认 host）----
  const before = guest.messages.length;
  guest.send(JSON.stringify({ type: 'state', sub: 'live', f: [] }));
  await sleep(300);
  check('客机伪造 state 不会回灌', host.messages.slice(before).every(m => m.type !== 'state'));

  const fails = results.filter(r => !r.pass);
  console.log('\\n=== relay：' + (results.length - fails.length) + '/' + results.length + ' 通过 ===');
  host.close(); guest.close();
  process.exit(fails.length ? 1 : 0);
};
run().catch(e => { console.error(e); process.exit(2); });

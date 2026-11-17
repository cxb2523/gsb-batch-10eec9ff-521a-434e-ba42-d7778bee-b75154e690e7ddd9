import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';

const root = fileURLToPath(new URL('../', import.meta.url));
const { outputFiles } = await build({ stdin: { contents: `
  export { setupVideo } from './web/js/video-player.js';
  export { trackCfg } from './web/js/trackcfg.js';`, resolveDir: root },
  bundle: true, write: false, format: 'iife', globalName: 'VideoTest' });
const html = await readFile(new URL('../web/player.html', import.meta.url), 'utf8');
const flush = () => new Promise((resolve) => setImmediate(resolve));

function harness(t, { native = true, wakeRequest, nativeExtras } = {}) {
  const dom = new JSDOM(html, { url: 'https://localhost/player.html', runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window, doc = w.document, calls = [];
  t.after(() => { w.dispatchEvent(new w.Event('pagehide')); w.close(); });
  const landscape = new w.EventTarget(); landscape.matches = false;
  w.matchMedia = () => landscape;
  w.LinguaNative = native ? { platform: 'ios', ...nativeExtras } : undefined;
  doc.documentElement.requestFullscreen = async () => { calls.push('fullscreen'); };
  w.screen.orientation = { lock: async () => { calls.push('lock'); }, unlock() {} };
  if (wakeRequest) w.navigator.wakeLock = { request: wakeRequest };
  w.eval(outputFiles[0].text);
  const app = doc.getElementById('app'), video = doc.getElementById('video');
  app.classList.add('has-video');
  Object.defineProperties(video, {
    readyState: { configurable: true, value: 2 },
    videoWidth: { configurable: true, value: 1280 },
    videoHeight: { configurable: true, value: 720 },
  });
  const track = { S: 1, sStart: [0], sEnd: [4], sentences: [{ text: 'Hello.', translation: '你好。' }] };
  const cues = { mode: 'disabled', _items: [],
    addCue(cue) { this._items.push(cue); },
    removeCue(cue) { this._items = this._items.filter((item) => item !== cue); } };
  video.addTextTrack = () => cues;
  w.VTTCue = class { constructor(start, end, text) { Object.assign(this, { startTime: start, endTime: end, text }); } };
  video.webkitPresentationMode = 'inline';
  video.webkitSetPresentationMode = (mode) => {
    video.webkitPresentationMode = mode;
    video.dispatchEvent(new w.Event('webkitpresentationmodechanged'));
  };
  const player = w.VideoTest.setupVideo({ app, video, engine: { track }, toggle() {}, onLayout() {},
    overlayOpen: () => false, openSettings() {} });
  const rotate = async () => { doc.getElementById('btnVideoRotate').click(); await flush(); };
  const turn = async (horizontal) => {
    landscape.matches = horizontal;
    landscape.dispatchEvent(new w.Event('change')); await flush();
  };
  const pointer = (target, type) => target.dispatchEvent(Object.assign(new w.Event(type, { bubbles: true, cancelable: true }),
    { pointerId: 1, button: 0, isPrimary: true, clientX: 160, clientY: 90 }));
  return { w, doc, app, video, player, calls, cues, track, rotate, turn, pointer };
}

test('PiP waits for a video frame before probing Safari support, then opens on the next tap', async (t) => {
  const h = harness(t);
  let probes = 0, requests = 0;
  h.video.webkitSupportsPresentationMode = () => { probes++; return h.video.readyState >= 2; };
  h.video.webkitSetPresentationMode = (mode) => { requests++; h.video.webkitPresentationMode = mode; };
  for (const readyState of [0, 1]) {
    Object.defineProperty(h.video, 'readyState', { configurable: true, value: readyState });
    await h.player.pip.toggle();
    assert.match(h.doc.getElementById('toast').textContent, /视频正在加载/);
    assert.equal(probes, 0);
    assert.equal(requests, 0);
  }
  Object.defineProperty(h.video, 'readyState', { configurable: true, value: 2 });
  await h.player.pip.toggle();
  assert.equal(requests, 1);
  assert.equal(h.player.pip.isActive(), true);
  // Closing an existing PiP must still work if the media becomes unready.
  Object.defineProperty(h.video, 'readyState', { configurable: true, value: 0 });
  await h.player.pip.toggle();
  assert.equal(h.player.pip.isActive(), false);
});

test('loading media does not request standard or Document PiP, or exit landscape', async (t) => {
  const h = harness(t, { native: false });
  let requests = 0;
  h.w.documentPictureInPicture = { requestWindow() { requests++; } };
  h.video.requestPictureInPicture = () => { requests++; };
  await h.rotate();
  Object.defineProperty(h.video, 'readyState', { configurable: true, value: 1 });
  await h.player.pip.toggle();
  assert.equal(requests, 0);
  assert.equal(h.player.isImmersive(), true);
  assert.match(h.doc.getElementById('toast').textContent, /视频正在加载/);
});

test('ready media without a PiP interface still reports unsupported; media errors report a load failure', async (t) => {
  const h = harness(t);
  h.video.webkitSetPresentationMode = undefined;
  await h.player.pip.toggle();
  assert.match(h.doc.getElementById('toast').textContent, /不支持画中画/);
  Object.defineProperty(h.video, 'error', { value: { code: 3 } });
  await h.player.pip.toggle();
  assert.match(h.doc.getElementById('toast').textContent, /视频加载失败/);
});

test('portrait toolbar presses do not reveal video controls or consume button clicks', (t) => {
  const h = harness(t);
  for (const id of ['btnPin', 'btnExplain', 'btnRepeat', 'btnSpeed', 'btnPlay', 'btnDisplay', 'seek']) {
    const button = h.doc.getElementById(id);
    let clicks = 0;
    button.addEventListener('click', () => { clicks++; });
    const target = button.firstElementChild || button;
    assert.equal(h.pointer(target, 'pointerdown'), true, `${id} must retain its default input handling`);
    assert.equal(h.app.classList.contains('controls-visible'), false, `${id} must not reveal video controls`);
    h.pointer(target, 'pointerup'); target.dispatchEvent(new h.w.MouseEvent('click', { bubbles: true }));
    assert.equal(clicks, 1);
  }
});

test('a toolbar press cancels a pending video single tap while immersive controls remain usable', async (t) => {
  const h = harness(t);
  h.video.setPointerCapture = h.video.releasePointerCapture = () => {};
  h.video.getBoundingClientRect = () => ({ left: 0, top: 0, right: 320, width: 320, height: 180 });
  h.pointer(h.video, 'pointerdown'); h.pointer(h.video, 'pointerup');
  h.pointer(h.doc.getElementById('btnSpeed'), 'pointerdown');
  await new Promise((resolve) => h.w.setTimeout(resolve, 350));
  assert.equal(h.app.classList.contains('controls-visible'), false);
  await h.rotate(); h.player.showControls();
  h.pointer(h.video, 'pointerdown'); h.pointer(h.video, 'pointerup');
  h.pointer(h.doc.getElementById('btnToolSettings'), 'pointerdown');
  await new Promise((resolve) => h.w.setTimeout(resolve, 350));
  assert.equal(h.app.classList.contains('controls-visible'), true);
});

test('native iOS manually enters and leaves full-canvas playback without WebKit fullscreen or orientation lock', async (t) => {
  const h = harness(t);
  for (let i = 0; i < 3; i++) {
    await h.rotate();
    assert.equal(h.player.isImmersive(), true);
    assert.equal(h.doc.body.classList.contains('video-rotated'), true);
    assert.equal(h.doc.documentElement.classList.contains('video-immersive'), true);
    await h.rotate();
    assert.equal(h.player.isImmersive(), false);
    assert.equal(h.doc.body.classList.contains('video-rotated'), false);
    assert.equal(h.doc.documentElement.classList.contains('video-immersive'), false);
  }
  assert.deepEqual(h.calls, []);
});

test('physical landscape followed by portrait clears the manual landscape override', async (t) => {
  const h = harness(t);
  await h.rotate(); await h.turn(true);
  assert.equal(h.player.isImmersive(), true);
  assert.equal(h.doc.body.classList.contains('video-rotated'), false);
  await h.turn(false);
  assert.equal(h.player.isImmersive(), false);
  assert.equal(h.doc.body.classList.contains('video-rotated'), false);
  assert.deepEqual(h.calls, []);
});

test('browser fullscreen is retained and audio-only pages never request it on rotation', async (t) => {
  const h = harness(t, { native: false });
  await h.rotate();
  assert.deepEqual(h.calls, ['fullscreen', 'lock']);
  await h.rotate(); h.calls.length = 0;
  h.app.classList.remove('has-video'); await h.turn(true);
  assert.deepEqual(h.calls, []);
  assert.equal(h.player.isImmersive(), false);
});

test('automatic iOS PiP releases immersion and respects subtitle visibility on refresh', async (t) => {
  const h = harness(t);
  await h.rotate();
  h.video.webkitSetPresentationMode('picture-in-picture'); await flush();
  assert.equal(h.player.isImmersive(), false);
  assert.equal(h.doc.body.classList.contains('video-rotated'), false);
  assert.equal(h.cues.mode, 'showing');
  h.w.VideoTest.trackCfg.video.subtitles = 0; h.player.apply();
  assert.equal(h.cues.mode, 'disabled');
  h.w.VideoTest.trackCfg.video.subtitles = 1; h.player.apply();
  assert.equal(h.cues.mode, 'showing');
  await h.turn(true);
  assert.equal(h.player.isImmersive(), false);
  h.video.webkitSetPresentationMode('inline'); await flush();
  assert.equal(h.cues.mode, 'disabled');
  assert.equal(h.player.isImmersive(), true);
});

test('native back exits manual landscape without navigating away', async (t) => {
  const h = harness(t);
  await h.rotate();
  assert.equal(h.w.dispatchEvent(new h.w.CustomEvent('native-back', { cancelable: true })), false);
  await flush(); assert.equal(h.player.isImmersive(), false);
  assert.equal(h.w.dispatchEvent(new h.w.CustomEvent('native-back', { cancelable: true })), true);
});

test('leaving physical landscape restores the regular player until rotation or manual re-entry', async (t) => {
  const h = harness(t);
  const back = h.doc.getElementById('btnBack');
  h.video.currentTime = 12; h.video.playbackRate = 1.5;
  await h.rotate(); await h.player.leaveHorizontal();
  await h.turn(true);
  assert.equal(h.player.isImmersive(), true);
  assert.equal(back.getAttribute('aria-label'), '返回竖屏播放');
  await h.player.leaveHorizontal();
  h.w.dispatchEvent(new h.w.Event('resize'));
  h.w.dispatchEvent(new h.w.Event('pageshow'));
  assert.equal(h.player.isImmersive(), false);
  assert.equal(back.getAttribute('aria-label'), '返回首页');
  assert.equal(h.video.currentTime, 12);
  assert.equal(h.video.playbackRate, 1.5);
  await h.rotate();
  assert.equal(h.player.isImmersive(), true);
  await h.player.leaveHorizontal();
  await h.turn(false); await h.turn(true);
  assert.equal(h.player.isImmersive(), true);
});

test('native back exits physical landscape and releases browser fullscreen and orientation lock', async (t) => {
  const h = harness(t, { native: false });
  let exits = 0, unlocks = 0;
  h.doc.documentElement.requestFullscreen = async () => {
    h.doc.fullscreenElement = h.doc.documentElement;
    h.doc.dispatchEvent(new h.w.Event('fullscreenchange'));
  };
  h.doc.exitFullscreen = async () => {
    exits++; h.doc.fullscreenElement = null;
    h.doc.dispatchEvent(new h.w.Event('fullscreenchange'));
  };
  h.w.screen.orientation.unlock = () => { unlocks++; };
  await h.turn(true);
  assert.equal(h.player.isFullscreen(), true);
  assert.equal(h.w.dispatchEvent(new h.w.CustomEvent('native-back', { cancelable: true })), false);
  await flush();
  assert.equal(h.player.isImmersive(), false);
  assert.equal(h.player.isFullscreen(), false);
  assert.equal(exits, 1); assert.ok(unlocks > 0);
  assert.equal(h.w.dispatchEvent(new h.w.CustomEvent('native-back', { cancelable: true })), true);
});

test('a late wake-lock result is released after leaving immersion', async (t) => {
  let resolveLock, released = 0;
  const h = harness(t, { wakeRequest: () => new Promise((resolve) => { resolveLock = resolve; }) });
  await h.rotate(); await h.rotate();
  resolveLock({ release: async () => { released++; } }); await flush();
  assert.equal(released, 1);
});

test('returning from the background reacquires the immersive wake lock', async (t) => {
  let requests = 0, released = 0;
  const h = harness(t, { wakeRequest: async () => { requests++; return { release: async () => { released++; } }; } });
  await h.rotate();
  Object.defineProperty(h.doc, 'hidden', { configurable: true, value: true });
  h.doc.dispatchEvent(new h.w.Event('visibilitychange')); await flush();
  Object.defineProperty(h.doc, 'hidden', { configurable: true, value: false });
  h.doc.dispatchEvent(new h.w.Event('visibilitychange')); await flush();
  assert.equal(requests, 2); assert.equal(released, 1);
});

test('classic PiP cue text follows the translation switch without a refresh call', async (t) => {
  const h = harness(t);
  h.doc.documentElement.dataset.tr = '1';
  await h.player.pip.toggle();
  assert.equal(h.player.pip.isActive(), true);
  assert.equal(h.cues._items.length, 1);
  assert.equal(h.cues._items[0].text, 'Hello.\n你好。');
  // 开关走主页面的设置通道 (data-tr), 模拟页面已在后台: 不主动调 refresh, 只改属性。
  h.doc.documentElement.dataset.tr = '0'; await flush();
  assert.equal(h.cues._items.length, 1, 'switching translation must not stack cues');
  assert.equal(h.cues._items[0].text, 'Hello.');
  h.doc.documentElement.dataset.tr = '1'; await flush();
  assert.equal(h.cues._items.length, 1);
  assert.equal(h.cues._items[0].text, 'Hello.\n你好。');
  await h.player.pip.toggle();
  assert.equal(h.player.pip.isActive(), false);
});

test('classic PiP rebuilds the cue track from a replaced timeline without duplicate cues', async (t) => {
  const h = harness(t);
  h.doc.documentElement.dataset.tr = '1';
  await h.player.pip.toggle();
  assert.deepEqual(h.cues._items.map((cue) => cue.text), ['Hello.\n你好。']);
  // 整条时间轴被换成另一份数据 (换曲/重新导入): 句数与内容都变了。
  // 应用层不主动调 refresh, 小窗必须自己靠媒体事件愈合 (页面可能正在后台)。
  const next = { S: 2, sStart: [0, 5], sEnd: [5, 9],
    sentences: [{ text: 'New first.', translation: '新的第一句。' }, { text: 'New second.', translation: '' }] };
  h.track.S = next.S;
  h.track.sStart = next.sStart;
  h.track.sEnd = next.sEnd;
  h.track.sentences = next.sentences;
  h.video.dispatchEvent(new h.w.Event('loadedmetadata')); await flush();
  assert.deepEqual(h.cues._items.map((cue) => cue.text),
    ['New first.\n新的第一句。', 'New second.'], 'old cues must be replaced by the new timeline');
  // 再来一次媒体事件不能重复添加 cue。
  h.video.dispatchEvent(new h.w.Event('timeupdate')); await flush();
  assert.equal(h.cues._items.length, 2, 'a repeated media event must not re-add cues');
  h.video.dispatchEvent(new h.w.Event('seeked')); await flush();
  assert.equal(h.cues._items.length, 2);
  await h.player.pip.toggle();
});

test('an in-place subtitle edit reaches classic PiP cues even when the media file is unchanged', async (t) => {
  const h = harness(t);
  h.doc.documentElement.dataset.tr = '1';
  await h.player.pip.toggle();
  assert.equal(h.cues._items[0].text, 'Hello.\n你好。');
  // 字幕编辑保存是同一 track 对象就地改写, 媒体文件不变 (没有 loadedmetadata),
  // 普通播放事件 (timeupdate) 也必须能通过内容指纹识别并整轨重填。
  h.track.sentences[0].text = 'Hello there.';
  h.track.sentences[0].translation = '你好呀。';
  h.video.dispatchEvent(new h.w.Event('timeupdate')); await flush();
  assert.equal(h.cues._items.length, 1);
  assert.equal(h.cues._items[0].text, 'Hello there.\n你好呀。');
  await h.player.pip.toggle();
});

test('Document PiP immediately shows and hides the translation on the switch and follows a new timeline', async (t) => {
  const h = harness(t, { native: false });
  h.doc.documentElement.dataset.tr = '1';
  const pipDom = new JSDOM('<html><head></head><body></body></html>', { url: 'https://localhost/pip.html' });
  t.after(() => pipDom.window.close());
  const pipWin = pipDom.window;
  let closed = false;
  Object.assign(pipWin, { close: () => { closed = true; pipWin.dispatchEvent(new pipWin.Event('pagehide')); } });
  h.w.fetch = async () => ({ ok: true, text: async () => '' });
  h.w.documentPictureInPicture = { requestWindow: async () => pipWin };
  h.video.requestPictureInPicture = undefined;
  await h.player.pip.toggle();
  assert.equal(h.player.pip.isActive(), true);
  const pipDoc = pipWin.document;
  const pipText = pipDoc.querySelector('.pip-text');
  const pipTr = pipDoc.querySelector('.pip-tr');
  assert.ok(pipText && pipTr);
  assert.equal(pipText.textContent, 'Hello.');
  assert.equal(pipTr.textContent, '你好。');
  assert.equal(pipTr.hidden, false);
  // 译文开关变化: 即使页面后台、没有任何媒体事件, MutationObserver 也立即生效。
  h.doc.documentElement.dataset.tr = '0'; await flush();
  assert.equal(pipTr.textContent, '');
  assert.equal(pipTr.hidden, true);
  h.doc.documentElement.dataset.tr = '1'; await flush();
  assert.equal(pipTr.textContent, '你好。');
  assert.equal(pipTr.hidden, false);
  // 整条时间轴替换: 媒体事件驱动重画 (不依赖 rAF)。
  h.track.S = 2;
  h.track.sStart = [0, 5];
  h.track.sEnd = [5, 9];
  h.track.sentences = [{ text: 'Brand new.', translation: '全新的。' }, { text: 'Second.', translation: '' }];
  h.video.dispatchEvent(new h.w.Event('timeupdate')); await flush();
  assert.equal(pipText.textContent, 'Brand new.');
  assert.equal(pipTr.textContent, '全新的。');
  // 关闭小窗: 视频必须回到主页面舞台, 不丢失。
  await h.player.pip.toggle();
  assert.equal(closed, true);
  assert.equal(h.player.pip.isActive(), false);
  assert.equal(h.video.parentNode, h.doc.getElementById('videoStage'));
});

test('Android Activity PiP refills cues on the translation switch and a replaced timeline', async (t) => {
  const h = harness(t, { nativeExtras: { platform: 'android', activityPip: {
    enterPip: async () => ({ controls: false }), updatePip: async () => {},
  } } });
  h.doc.documentElement.dataset.tr = '1';
  await h.player.pip.toggle();
  // 原生容器在系统小窗真正起来后回送 native-pip 事件 (与 Android 插件实现一致)。
  h.w.dispatchEvent(new h.w.CustomEvent('native-pip', { detail: { active: true } }));
  assert.equal(h.player.pip.isActive(), true);
  assert.equal(h.cues.mode, 'showing');
  assert.deepEqual(h.cues._items.map((cue) => cue.text), ['Hello.\n你好。']);
  // 译文开关: Activity PiP 与经典 PiP 共用同一条 cue 同步链路。
  h.doc.documentElement.dataset.tr = '0'; await flush();
  assert.equal(h.cues._items.length, 1, 'translation switch must not duplicate cues');
  assert.equal(h.cues._items[0].text, 'Hello.');
  h.doc.documentElement.dataset.tr = '1'; await flush();
  assert.equal(h.cues._items[0].text, 'Hello.\n你好。');
  // 时间轴替换: 模拟 Activity 还在前台而页面在后台, 只有媒体事件能驱动同步。
  h.track.S = 2;
  h.track.sStart = [0, 6];
  h.track.sEnd = [6, 12];
  h.track.sentences = [{ text: 'Activity one.', translation: '小窗第一句。' },
    { text: 'Activity two.', translation: '小窗第二句。' }];
  h.video.dispatchEvent(new h.w.Event('loadedmetadata')); await flush();
  assert.deepEqual(h.cues._items.map((cue) => cue.text),
    ['Activity one.\n小窗第一句。', 'Activity two.\n小窗第二句。']);
  assert.equal(h.cues._items.length, 2, 'rebuild must not leave or duplicate cues');
  // 原生容器发回关闭事件: cue 轨关闭, 主页面视频元素不受影响。
  h.w.dispatchEvent(new h.w.CustomEvent('native-pip', { detail: { active: false } }));
  assert.equal(h.player.pip.isActive(), false);
  assert.equal(h.cues.mode, 'disabled');
  assert.equal(h.video.parentNode, h.doc.getElementById('videoStage'));
});

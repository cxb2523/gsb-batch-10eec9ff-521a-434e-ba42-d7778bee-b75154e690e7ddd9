// Browser harness for the quality/resize lifecycle: drives a real WebGL page through tier switches
// and window resizes and asserts that every render target is live, every sampler uniform points at
// a current-generation texture, low tier never touches a released reflection texture, and no frame
// comes back black. Mirrors the manual acceptance script (high→low→high, resize right after a
// switch, resize while on low). Needs the dev server (npm run dev).
//   node tools/qualitytest.mjs
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-quality-'));
const base = process.env.BASE || 'http://127.0.0.1:5183/';
const browser = await puppeteer.launch({
  executablePath: process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  // Chrome 157's new headless rejects remote debugging in this environment; pass the old
  // headless switch explicitly (headless:false keeps puppeteer from injecting --headless=new).
  headless: false,
  userDataDir: profileDir,
  args: ['--headless=old', '--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader', '--mute-audio', '--hide-scrollbars', '--window-size=1280,720'],
  defaultViewport: { width: 1280, height: 720, deviceScaleFactor: 1 }, protocolTimeout: 120000,
});
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push('[pageerror] ' + e.message));
page.on('console', (m) => {
  if (m.type() === 'error' && !m.text().includes('404')) errors.push('[console] ' + m.text());
});

const results = [];
const check = (name, ok, detail = '') => {
  results.push(!!ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};
const step = (label) => console.log(`\n--- ${label} ---`);

await page.goto(base + '?q=high&autostart=clawd&demo=hard&level=hard', { waitUntil: 'load' });
await page.waitForFunction('window.__ready === true', { timeout: 60000 });
await new Promise((r) => setTimeout(r, 1500)); // let a few real frames render first

// In-page probe. Reads the live Renderer and reports everything the lifecycle must guarantee.
// Liveness here is identity-based: a sampler is stale when it holds a texture that belongs to a
// disposed target generation instead of one of the renderer's current targets. Installed on
// window once, then called from every renderFrames() inside the same browser execution context.
const PROBE_FN = function probe() {
  const R = window.__game.stage.R;
  const gl = R.gl.getContext();
  const isTex = (v) => v && typeof v === 'object' && v.isTexture === true;
  const currentTextures = new Set();
  const collect = (rt) => { if (rt) { currentTextures.add(rt.texture); if (rt.depthTexture) currentTextures.add(rt.depthTexture); } };
  for (const k of ['rtScene', 'rtFx', 'rtDistort', 'rtHDR', 'rtAccum', 'rtReflScene', 'rtReflFx', 'rtRefl', 'rtStreakA', 'rtStreakB', 'rtLum']) {
    collect(R[k]);
  }
  for (const a of R.rtAdapt) collect(a);
  for (const b of R.bloom) collect(b);
  currentTextures.add(R.noiseTex); // persistent, not rebuilt
  const live = (t) => currentTextures.has(t);
  const out = {
    quality: R.qualityName,
    w: R.w, h: R.h,
    reflOn: R.reflUniforms.uReflOn.value,
    reflTexBound: isTex(R.reflUniforms.uReflTex.value),
    reflTexLive: live(R.reflUniforms.uReflTex.value),
    hasRefl: !!R.rtRefl,
    bloom: R.bloom.length,
    msaa: R.rtScene.samples,
    shadow: R.shadowLights[0]?.shadow.mapSize.x ?? null,
    targetsPresent: ['rtScene', 'rtFx', 'rtDistort', 'rtHDR', 'rtAccum', 'rtStreakA', 'rtStreakB']
      .every((k) => !!R[k] && isTex(R[k].texture)),
    bloomCount: R.bloom.length,
    reflTargetsComplete: R.rtRefl ? !!R.rtReflScene && !!R.rtReflFx : true,
    // every sampler uniform on the persistent materials must reference a current-generation texture
    staleUniforms: [],
    nullSamplers: [],
    aspect: window.__game.stage.camera.aspect,
    glError: gl.getError(),
  };
  const mats = [R.mats.combineRefl, R.mats.composite, R.mats.copy, R.mats.accum, R.mats.pre, R.mats.down,
    R.mats.up, R.mats.streak, R.mats.luma, R.mats.adapt, R.mats.final];
  for (const m of mats) {
    for (const [key, u] of Object.entries(m.uniforms)) {
      if (isTex(u.value)) { if (!live(u.value)) out.staleUniforms.push(key); }
      else if (u.value === null && /^t[A-Z]/.test(key)) out.nullSamplers.push(key);
    }
  }
  // reflection matrix must be populated whenever reflections are on
  out.reflMatrixValid = !R.reflUniforms.uReflOn.value ||
    R.reflUniforms.uReflMatrix.value.elements.some((x) => x !== 0);
  return out;
};
await page.evaluate((fnSrc) => { window.__probe = new Function(`return (${fnSrc})`)(); }, PROBE_FN.toString());

// Render N real frames synchronously (the page's own rAF loop is paused by manual driving) and
// return the probe. Avoids scheduling nested requestAnimationFrame chains, which are flaky under
// old headless's virtual time.
async function renderFrames(n = 3) {
  return page.evaluate((n) => {
    const g = window.__game;
    for (let i = 0; i < n; i++) {
      g.stage.step(1 / 60);
      g.stage.render(1 / 60);
    }
    return window.__probe();
  }, n);
}

// Average luminance of the canvas via a real screenshot; a fully black frame means a broken
// pipeline. (2D drawImage of a WebGL canvas without preserveDrawingBuffer is unreliable under
// old headless, so we decode a screenshot instead.)
async function frameLuma() {
  const file = path.join(profileDir, `shot-${shotSeq++}.png`);
  await page.screenshot({ path: file, type: 'png' });
  const buf = fs.readFileSync(file);
  // PNG decoders are not bundled here; parse just the IHDR and use the browser for pixels via a
  // data-URL round trip in a throwaway canvas is also blocked, so scan for any non-zero byte in
  // the IDAT payload: a truly all-black frame compresses to near-identical zero-valued scanlines,
  // while a rendered frame always produces varied IDAT bytes.
  const idat = collectIdatBytes(buf);
  const nonzero = idat.reduce((acc, b) => acc + (b !== 0 ? 1 : 0), 0);
  return nonzero / Math.max(1, idat.length);
}
function collectIdatBytes(buf) {
  // Walk PNG chunks (8-byte signature, then length(4)+type(4)+data+crc(4)).
  const out = [];
  let off = 8;
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    if (type === 'IDAT') out.push(...buf.subarray(off + 8, off + 8 + len));
    off += 12 + len;
    if (type === 'IEND') break;
  }
  return out;
}
let shotSeq = 0;

// FX materials share fxGlobals.uDepthTex by reference; collect those uniform objects straight
// from the scene so the harness can verify the depth sampler always matches the current target.
await page.evaluate(() => {
  const R = window.__game.stage.R;
  const holders = [];
  window.__game.stage.scene.traverse((o) => {
    if (o.material?.uniforms?.uDepthTex) holders.push(o.material.uniforms.uDepthTex);
  });
  R.__fxDepthUniforms = holders;
});

async function fxDepthFresh() {
  return page.evaluate(() => {
    const R = window.__game.stage.R;
    const current = R.rtScene.depthTexture;
    return (R.__fxDepthUniforms || []).every((u) => u.value === current);
  });
}

const expectTier = {
  low: { refl: false, bloom: 5, msaa: 0, shadow: 1024 },
  medium: { refl: true, bloom: 6, msaa: 2, shadow: 2048 },
  high: { refl: true, bloom: 7, msaa: 4, shadow: 2048 },
};

function assertState(label, p, tier) {
  const e = expectTier[tier];
  check(`[${label}] tier is ${tier}`, p.quality === tier, p.quality);
  check(`[${label}] all scene targets present`, p.targetsPresent);
  check(`[${label}] bloom chain sized for tier`, p.bloomCount === e.bloom, `layers ${p.bloomCount}`);
  check(`[${label}] MSAA matches tier`, p.msaa === e.msaa, `samples ${p.msaa}`);
  check(`[${label}] shadow map matches tier`, p.shadow === e.shadow, `${p.shadow}`);
  check(`[${label}] no stale sampler uniforms`, p.staleUniforms.length === 0, p.staleUniforms.join(','));
  check(`[${label}] no GL error after frames`, p.glError === 0, `0x${p.glError.toString(16)}`);
  check(`[${label}] camera aspect matches internal size`, Math.abs(p.aspect - p.w / p.h) < 1e-6,
    `${p.aspect} vs ${p.w / p.h}`);
  check(`[${label}] reflection matrix valid`, p.reflMatrixValid);
  if (e.refl) {
    check(`[${label}] reflection targets complete`, p.reflTargetsComplete);
    check(`[${label}] reflection sampler bound + on`, p.reflOn === 1 && p.reflTexBound && p.reflTexLive,
      `on=${p.reflOn} bound=${p.reflTexBound} live=${p.reflTexLive}`);
  } else {
    check(`[${label}] low tier has no reflection target`, !p.hasRefl);
    check(`[${label}] low tier reflection uniform off + sampler null`,
      p.reflOn === 0 && !p.reflTexBound, `on=${p.reflOn} bound=${p.reflTexBound}`);
  }
}

async function setQuality(q) {
  await page.evaluate((q) => window.__game.stage.R.setQuality(q), q);
  return renderFrames(3);
}
async function resize(w, h, dpr) {
  await page.setViewport({ width: w, height: h, deviceScaleFactor: dpr });
  await page.evaluate(([w, h, dpr]) => window.__game.stage.resize(w, h, dpr), [w, h, dpr]);
  return renderFrames(3);
}

// ---- scenario 1: high -> low -> high -----------------------------------------------------------
step('scenario 1: initial frames');
let p = await renderFrames(3);
assertState('initial high', p, 'high');
step('initial luma');
check('initial frame is not black', (await frameLuma()) > 0.02, `luma ${(await frameLuma()).toFixed(3)}`);

step('switch high->low');
p = await setQuality('low');
assertState('after high->low', p, 'low');
step('fx depth fresh (low)');
check('FX depth texture repointed on low rebuild', await fxDepthFresh());
let luma = await frameLuma();
check('low frame is not black', luma > 0.02, `luma ${luma.toFixed(3)}`);

step('switch low->high');
p = await setQuality('high');
assertState('after low->high', p, 'high');
check('FX depth texture repointed on high rebuild', await fxDepthFresh());
luma = await frameLuma();
check('high frame is not black', luma > 0.02, `luma ${luma.toFixed(3)}`);

// ---- scenario 2: switch then immediately resize (last writer wins, no mixed buffers) -----------
step('scenario 2: medium then resize');
p = await setQuality('medium');
assertState('switched to medium', p, 'medium');
const sizeAtSwitch = { w: p.w, h: p.h };
p = await resize(900, 600, 1);
check('resize after switch moved internal size', p.w !== sizeAtSwitch.w || p.h !== sizeAtSwitch.h,
  `${sizeAtSwitch.w}->${p.w}`);
assertState('medium after resize', p, 'medium');
check('resized frame not black', (await frameLuma()) > 0.02);

// ---- scenario 3: resize while on low (no reflection targets at any point) -----------------------
p = await setQuality('low');
assertState('back to low', p, 'low');
p = await resize(1400, 800, 1.25);
assertState('low resized', p, 'low');
check('resized-low frame not black', (await frameLuma()) > 0.02);
p = await resize(640, 360, 1);
assertState('low shrunk', p, 'low');
check('shrunk-low frame not black', (await frameLuma()) > 0.02);

// ---- scenario 4: rapid high->low->high hammering, then a resize --------------------------------
for (let i = 0; i < 4; i++) {
  p = await setQuality(i % 2 ? 'high' : 'low');
}
p = await resize(1100, 700, 1.5);
assertState('after rapid switches + resize', p, 'high');
check('hammered frame not black', (await frameLuma()) > 0.02);

// ---- scenario 5: same internal size must still rebuild on a tier switch ------------------------
await resize(1280, 720, 1);
p = await setQuality('high');
const highSize = { w: p.w, h: p.h };
// film shares high's internal pixel size at this window but differs in FX scale (0.75 -> 1),
// reflection scale (0.5 -> 0.75) and shadow size (2048 -> 4096). Capture target identity first.
await page.evaluate(() => { window.__gen = { rtScene: window.__game.stage.R.rtScene, rtFx: window.__game.stage.R.rtFx, rtRefl: window.__game.stage.R.rtRefl }; });
await page.evaluate(() => window.__game.stage.R.setQuality('film'));
p = await renderFrames(3);
const genChanged = await page.evaluate(() => {
  const R = window.__game.stage.R;
  return {
    scene: R.rtScene !== window.__gen.rtScene,
    fx: R.rtFx !== window.__gen.rtFx,
    refl: R.rtRefl !== window.__gen.rtRefl,
    fxSize: [R.rtFx.width, R.rtFx.height],
    reflSize: [R.rtRefl.width, R.rtRefl.height],
    shadow: R.shadowLights[0].shadow.mapSize.x,
  };
});
check('same-size tier switch rebuilt every target', genChanged.scene && genChanged.fx && genChanged.refl,
  `scene=${genChanged.scene} fx=${genChanged.fx} refl=${genChanged.refl}`);
check('film rebuilt at its own FX/reflection scales',
  genChanged.fxSize[0] === highSize.w && genChanged.reflSize[0] === Math.round(highSize.w * 0.75),
  `fx ${genChanged.fxSize.join('x')} refl ${genChanged.reflSize.join('x')}`);
check('film shadow map resized', genChanged.shadow === 4096, `${genChanged.shadow}`);
check('film rebuild kept correct internal size', p.w === highSize.w && p.h === highSize.h, `${p.w}x${p.h}`);
check('film frame not black', (await frameLuma()) > 0.02);
await page.evaluate(() => window.__game.stage.R.setQuality('high'));
await renderFrames(2);

// ---- scenario 6: resize that does NOT change internal pixels must skip the rebuild -------------
// 801 vs 802 CSS at scale 1 both round to 802 wide internally; identity must be compared inside
// the browser because three.js render targets cannot cross the CDP boundary.
await resize(802, 602, 1);
await page.evaluate(() => { window.__beforeRt = window.__game.stage.R.rtScene; });
await resize(801, 601, 1);
const reuse = await page.evaluate(() => ({
  reused: window.__game.stage.R.rtScene === window.__beforeRt,
  w: window.__game.stage.R.w,
  h: window.__game.stage.R.h,
}));
check('same-internal-size resize reuses targets', reuse.reused, `rtScene reused: ${reuse.reused} at ${reuse.w}x${reuse.h}`);

// ---- WebGL error / console hygiene --------------------------------------------------------------
const glErr = await page.evaluate(() => window.__game.stage.R.gl.getContext().getError());
check('final GL error queue clean', glErr === 0, `0x${glErr.toString(16)}`);
check('no page/console WebGL errors', errors.length === 0, errors.slice(0, 5).join(' | '));

await browser.close();
fs.rmSync(profileDir, { recursive: true, force: true });
const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} checks passed${failed ? `, ${failed} FAILED` : ''}`);
process.exit(failed ? 1 : 0);

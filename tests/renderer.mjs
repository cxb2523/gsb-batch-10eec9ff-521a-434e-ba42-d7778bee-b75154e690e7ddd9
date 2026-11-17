/**
 * The renderer's scene changes, driven straight against a WebGL2 canvas in
 * headless Chrome: a change interrupted halfway starts the next one from the
 * scene mostly on screen — its mix, start and length fresh from the new call,
 * running 0 to 1 over the full new length, never jumping to the end — and the
 * first frame of a new scene ignores the last frame of the old one, so no
 * trails or colours of it linger. Re-triggering never turns the screen black.
 *
 * The page is a canvas plus src/app/renderer.ts bundled by esbuild; the test
 * wraps the GL's uniform setters to watch what the shader is told, and reads
 * pixels back to see the picture is never black.
 *
 * Needs a local Chrome (or CHROME=/path/to/chrome); WebGL2 runs on SwiftShader.
 */
import { createServer } from 'node:http';
import { build } from 'esbuild';
import { launch } from '../tools/chrome.mjs';
import { checker, load, root } from '../tools/load.mjs';

const { check, done } = checker();
const { makeScene } = await load('core/scene');

// The renderer and the scene maker, bundled for the page.
const bundle = (
  await build({
    stdin: {
      contents: `export { Renderer } from './src/app/renderer';\nexport { makeScene } from './src/core/scene';`,
      resolveDir: root,
      loader: 'ts',
    },
    bundle: true,
    format: 'iife',
    globalName: 'TestKit',
    platform: 'browser',
    target: 'es2022',
    loader: { '.glsl': 'text' },
    write: false,
    logLevel: 'silent',
  })
).outputFiles[0].text.replace(/<\/script/gi, '<\\/script');

const page = `<!doctype html>
<meta charset="utf-8">
<canvas id="stage" style="width:320px;height:200px"></canvas>
<script>${bundle}</script>
<script>
// Watch the uniforms the renderer sets: name each location, remember each value.
const uniformName = new Map();
const uniformValue = new Map();
const proto = WebGL2RenderingContext.prototype;
const getUniformLocation = proto.getUniformLocation;
proto.getUniformLocation = function (program, name) {
  const location = getUniformLocation.call(this, program, name);
  if (location) uniformName.set(location, name);
  return location;
};
for (const setter of ['uniform1f', 'uniform1i']) {
  const original = proto[setter];
  proto[setter] = function (location, value) {
    const name = uniformName.get(location);
    if (name) uniformValue.set(name, value);
    return original.call(this, location, value);
  };
}
const canvas = document.getElementById('stage');
const renderer = new TestKit.Renderer(canvas);
const pulse = { beatsPerSecond: 2, beat: 0, snare: 0, note: 0, flash: 0, energy: 0.5, level: 0.5, chordHue: 0, calm: false };
let darkest = 1;
window.T = {
  // A scene with a fixed pattern, so the uniforms say which scene is where.
  show: (index, seconds, pattern) => renderer.show(TestKit.makeScene('test', index, 0.6, pattern), seconds),
  // n frames of 0.1s each, remembering the darkest frame seen.
  frames: (n) => {
    for (let i = 0; i < n; i++) {
      renderer.frame(0.1, pulse);
      const gl = canvas.getContext('webgl2');
      const px = new Uint8Array(gl.drawingBufferWidth * gl.drawingBufferHeight * 4);
      gl.readPixels(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight, gl.RGBA, gl.UNSIGNED_BYTE, px);
      let sum = 0;
      for (let p = 0; p < px.length; p += 4) sum += 0.299 * px[p] + 0.587 * px[p + 1] + 0.114 * px[p + 2];
      darkest = Math.min(darkest, sum / (px.length / 4) / 255);
    }
  },
  u: (name) => uniformValue.get(name) ?? null,
  takeDarkest: () => { const d = darkest; darkest = 1; return d; },
};
</script>`;

const server = createServer((req, res) => {
  res.setHeader('content-type', 'text/html; charset=utf-8');
  res.end(page);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${server.address().port}/`;

const browser = await launch({
  width: 480,
  height: 360,
  flags: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
if (!browser) {
  console.log('No Chrome found — set CHROME=/path/to/chrome. Skipping the browser test.');
  server.close();
  process.exit(0);
}
const { send, evaluate, until, errors } = browser;

// The scenes the page is asked to show, made here too, so the uniforms can be
// checked against the very numbers a scene holds. Patterns stand for scenes.
const scene = (index, pattern) => makeScene('test', index, 0.6, pattern);
const near = (a, b) => Math.abs(a - b) < 1e-5;
/** uMix after each of the next n frames. */
const mixes = async (n) => {
  const out = [];
  for (let i = 0; i < n; i++) out.push(await evaluate(`(T.frames(1), T.u('uMix'))`));
  return out;
};
/** The frame a transition completes on; float rounding of the clock can shift it by one. */
const doneAt = (samples) => samples.findIndex((m) => m === 0);

try {
  await send('Page.navigate', { url });
  check('the page runs', await until(`window.T !== undefined`, 5000), true);

  // A hard cut: the scene is there at once, its first frame free of the old one
  await evaluate(`T.show(0, 0, 3)`);
  check('hard cut: the first frame cuts the trails', await evaluate(`(T.frames(1), T.u('uFeedback'))`), 0);
  check('hard cut: no transition running', await evaluate(`T.u('uMix')`), 0);
  check('hard cut: the trails return next frame', near(await evaluate(`(T.frames(1), T.u('uFeedback'))`), scene(0, 3).feedback), true);

  // A transition runs from 0 to 1 over its full length, then completes
  await evaluate(`T.show(1, 2, 10)`);
  const first = await evaluate(`(T.frames(1), [T.u('uA.pattern'), T.u('uB.pattern'), T.u('uB.palShift'), T.u('uMix')])`);
  check('transition: the old scene is the base', first[0], 3);
  check('transition: the new scene is coming', first[1], 10);
  check('transition: the new scene starts its palette fresh', near(first[2], 0.2 * scene(1, 10).paletteSpeed), true);
  check('transition: the mix starts near 0', first[3] > 0 && first[3] < 0.02, true);
  const run = await mixes(21); // frames 2..22 of the 2s change
  check('transition: the mix climbs smoothly', run.slice(0, 18).every((m, i) => i === 0 || m >= run[i - 1]), true);
  check('transition: not done early', run[17] > 0.9 && run[17] < 1, true);
  check('transition: done at its full length', [18, 19].includes(doneAt(run)), true);

  // Interrupted early (mix 0.2): the base is the scene on screen, not the one that never arrived
  await evaluate(`T.show(2, 2, 17)`);
  await evaluate(`T.frames(4)`);
  await evaluate(`T.show(3, 2, 0)`);
  check('interrupted early: the first frame cuts the trails', await evaluate(`(T.frames(1), T.u('uFeedback'))`), 0);
  check('interrupted early: the base is the scene on screen', await evaluate(`T.u('uA.pattern')`), 10);
  check('interrupted early: the newest scene is coming', await evaluate(`T.u('uB.pattern')`), 0);
  const restart = await evaluate(`T.u('uMix')`);
  check('interrupted early: the mix starts over', restart > 0 && restart < 0.02, true);
  const again = await mixes(20); // frames 2..21 of the re-started 2s change
  check('interrupted early: climbs smoothly again', again.slice(0, 18).every((m, i) => i === 0 || m >= again[i - 1]), true);
  check('interrupted early: runs its full new length', again[17] > 0.9 && [18, 19].includes(doneAt(again)), true);

  // Interrupted late (mix 0.75): the scene mostly on screen becomes the base
  await evaluate(`T.show(4, 2, 7)`);
  await evaluate(`T.frames(15)`);
  await evaluate(`T.show(5, 2, 12)`);
  await evaluate(`T.frames(1)`);
  check('interrupted late: the arrived scene is the base', await evaluate(`T.u('uA.pattern')`), 7);
  check('interrupted late: the newest scene is coming', await evaluate(`T.u('uB.pattern')`), 12);
  await evaluate(`T.frames(21)`);
  check('interrupted late: settles on the newest scene', await evaluate(`T.u('uA.pattern')`), 12);

  // Re-triggered in quick succession, the same pattern among them: never black
  await evaluate(`T.takeDarkest()`);
  await evaluate(`T.show(6, 0.6, 5)`);
  await evaluate(`T.frames(2)`);
  await evaluate(`T.show(7, 0.6, 5)`);
  await evaluate(`T.frames(2)`);
  await evaluate(`T.show(8, 0.6, 5)`);
  await evaluate(`T.frames(12)`);
  check('quick re-triggers: the picture never goes black', (await evaluate(`T.takeDarkest()`)) > 0.02, true);
  check('quick re-triggers: the last change settles', await evaluate(`T.u('uMix')`), 0);

  check('no errors on the page', errors, []);
} finally {
  await browser.close();
  server.close();
}

done('renderer');

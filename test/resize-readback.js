/**
 * Verification for WebGL canvas resize -> 2D readback convergence.
 *
 * Run with: node test/resize-readback.js
 *
 * Every case renders a solid color or a gradient with headless-gl, changes the
 * canvas width/height through the public width/height setters, then exports the
 * result as PNG and asserts that the exported image:
 *   - has exactly the new dimensions, and
 *   - contains the freshly rendered pixels (not a stale / stretched frame).
 *
 * Negative cases feed illegal dimensions (negative, non-numeric, zero,
 * over-limit) and assert that nothing throws and the surface stays usable.
 *
 * The suite only depends on the library itself and Node's built-in test runner,
 * so it works with the production dependencies installed.
 */

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

const {createCanvas, loadImage} = require('../lib');

const OUT_DIR = path.join(__dirname, '..', 'snapshot', 'resize-readback');
fs.mkdirSync(OUT_DIR, {recursive: true});

// Decode a PNG buffer into an ImageData-like RGBA array for pixel assertions.
async function decodePNG(buffer, width, height) {
  const image = await loadImage(buffer);
  assert.equal(image.width, width, 'decoded PNG width mismatch');
  assert.equal(image.height, height, 'decoded PNG height mismatch');
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(image, 0, 0);
  return ctx.getImageData(0, 0, width, height);
}
function clearTo(gl, r, g, b) {
  gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
  gl.clearColor(r, g, b, 1);
  gl.clear(gl.COLOR_BUFFER_BIT);
}

// Sample a few pixels spread over the surface so a stretched or stale frame
// cannot pass by accident.
function sampleRegion(data, width, height) {
  const points = [
    [0, 0],
    [width - 1, 0],
    [0, height - 1],
    [width - 1, height - 1],
    [Math.floor(width / 2), Math.floor(height / 2)],
  ];
  return points.map(([x, y]) => {
    const i = 4 * (y * width + x);
    return [data[i], data[i + 1], data[i + 2], data[i + 3]];
  });
}

function assertColor(samples, [r, g, b], label) {
  samples.forEach((px) => {
    assert.deepEqual(px, [r, g, b, 255], `${label}: expected rgba(${r},${g},${b},255), got rgba(${px.join(',')})`);
  });
}

test('toBuffer exports the new size after growing both dimensions', async () => {
  const canvas = createCanvas(32, 24);
  const gl = canvas.getContext('webgl');
  clearTo(gl, 1, 0, 0); // old frame: red

  canvas.width = 64;
  canvas.height = 48;
  assert.equal(gl.drawingBufferWidth, 64);
  assert.equal(gl.drawingBufferHeight, 48);
  clearTo(gl, 0, 1, 0); // new frame: green

  const buffer = canvas.toBuffer();
  fs.writeFileSync(path.join(OUT_DIR, 'grow-both.png'), buffer);
  const imageData = await decodePNG(buffer, 64, 48);
  assertColor(sampleRegion(imageData.data, 64, 48), [0, 255, 0], 'grow-both');
});

test('toBuffer exports the new size after shrinking both dimensions', async () => {
  const canvas = createCanvas(80, 60);
  const gl = canvas.getContext('webgl');
  clearTo(gl, 1, 0, 0);

  canvas.width = 40;
  canvas.height = 30;
  assert.equal(gl.drawingBufferWidth, 40);
  assert.equal(gl.drawingBufferHeight, 30);
  clearTo(gl, 0, 0, 1); // new frame: blue

  const buffer = canvas.toBuffer();
  fs.writeFileSync(path.join(OUT_DIR, 'shrink-both.png'), buffer);
  const imageData = await decodePNG(buffer, 40, 30);
  assertColor(sampleRegion(imageData.data, 40, 30), [0, 0, 255], 'shrink-both');
});

test('setting width alone keeps height and readback stays consistent', async () => {
  const canvas = createCanvas(32, 32);
  const gl = canvas.getContext('webgl');
  clearTo(gl, 1, 0, 0);

  canvas.width = 72;
  assert.equal(canvas.width, 72);
  assert.equal(canvas.height, 32);
  assert.equal(gl.drawingBufferWidth, 72);
  assert.equal(gl.drawingBufferHeight, 32);
  clearTo(gl, 1, 1, 0); // yellow

  const buffer = canvas.toBuffer();
  fs.writeFileSync(path.join(OUT_DIR, 'width-only.png'), buffer);
  const imageData = await decodePNG(buffer, 72, 32);
  assertColor(sampleRegion(imageData.data, 72, 32), [255, 255, 0], 'width-only');
});

test('setting height alone keeps width and readback stays consistent', async () => {
  const canvas = createCanvas(32, 32);
  const gl = canvas.getContext('webgl');
  clearTo(gl, 1, 0, 0);

  canvas.height = 72;
  assert.equal(canvas.width, 32);
  assert.equal(canvas.height, 72);
  assert.equal(gl.drawingBufferWidth, 32);
  assert.equal(gl.drawingBufferHeight, 72);
  clearTo(gl, 0, 1, 1); // cyan

  const buffer = canvas.toBuffer();
  fs.writeFileSync(path.join(OUT_DIR, 'height-only.png'), buffer);
  const imageData = await decodePNG(buffer, 32, 72);
  assertColor(sampleRegion(imageData.data, 32, 72), [0, 255, 255], 'height-only');
});

test('toDataURL reflects the size after several consecutive resizes', async () => {
  const canvas = createCanvas(32, 32);
  const gl = canvas.getContext('webgl');

  const steps = [
    [48, 48, [1, 0, 0]],
    [24, 64, [0, 1, 0]],
    [72, 24, [0, 0, 1]],
  ];

  await steps.reduce(
    (chain, [width, height, [r, g, b]]) => chain.then(async () => {
      canvas.width = width;
      canvas.height = height;
      clearTo(gl, r, g, b);
      const url = canvas.toDataURL();
      assert.match(url, /^data:image\/png;base64,/, 'toDataURL should return a PNG data URL');
      const raw = Buffer.from(url.split(',')[1], 'base64');
      const imageData = await decodePNG(raw, width, height);
      assertColor(
        sampleRegion(imageData.data, width, height),
        [r * 255, g * 255, b * 255],
        `resize ${width}x${height}`,
      );
    }),
    Promise.resolve(),
  );
  fs.writeFileSync(path.join(OUT_DIR, 'dataurl-final.png'), canvas.toBuffer());
});

test('createPNGStream emits an image at the current (resized) dimensions', async () => {
  const canvas = createCanvas(40, 30);
  const gl = canvas.getContext('webgl');
  clearTo(gl, 0.8, 0.2, 0.4);

  canvas.width = 55;
  canvas.height = 44;
  clearTo(gl, 0.2, 0.4, 0.8);

  const buffer = await new Promise((resolve, reject) => {
    const chunks = [];
    const stream = canvas.createPNGStream();
    stream.on('data', chunk => chunks.push(chunk));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
  fs.writeFileSync(path.join(OUT_DIR, 'stream.png'), buffer);
  const imageData = await decodePNG(buffer, 55, 44);
  assertColor(sampleRegion(imageData.data, 55, 44), [51, 102, 204], 'png-stream');
});

test('a resized WebGL canvas is a fresh drawImage source', () => {
  const source = createCanvas(32, 32);
  const gl = source.getContext('webgl');
  clearTo(gl, 1, 0, 0);

  source.width = 48;
  source.height = 40;
  clearTo(gl, 0, 1, 0);

  const target = createCanvas(48, 40);
  const ctx = target.getContext('2d');
  ctx.drawImage(source, 0, 0);
  const imageData = ctx.getImageData(0, 0, 48, 40);
  assertColor(sampleRegion(imageData.data, 48, 40), [0, 255, 0], 'drawImage-source');
});

test('a resized WebGL canvas uploads current pixels as a GL texture', () => {
  const source = createCanvas(32, 32);
  const sgl = source.getContext('webgl');
  clearTo(sgl, 1, 0, 0);

  source.width = 48;
  source.height = 40;
  clearTo(sgl, 0, 0, 1); // blue after resize

  const target = createCanvas(64, 64);
  const dgl = target.getContext('webgl');

  // DOM-style overload: pixels come straight from the canvas element.
  const texture = dgl.createTexture();
  dgl.bindTexture(dgl.TEXTURE_2D, texture);
  dgl.texImage2D(dgl.TEXTURE_2D, 0, dgl.RGBA, dgl.RGBA, dgl.UNSIGNED_BYTE, source);
  assert.equal(dgl.getError(), dgl.NO_ERROR, 'texImage2D with a resized GL canvas failed');
  dgl.texParameteri(dgl.TEXTURE_2D, dgl.TEXTURE_MIN_FILTER, dgl.NEAREST);
  dgl.texParameteri(dgl.TEXTURE_2D, dgl.TEXTURE_MAG_FILTER, dgl.NEAREST);

  const program = createTexturedProgram(dgl);
  dgl.useProgram(program);
  const quad = dgl.createBuffer();
  dgl.bindBuffer(dgl.ARRAY_BUFFER, quad);
  dgl.bufferData(dgl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), dgl.STATIC_DRAW);
  const position = dgl.getAttribLocation(program, 'p');
  dgl.enableVertexAttribArray(position);
  dgl.vertexAttribPointer(position, 2, dgl.FLOAT, false, 0, 0);
  dgl.uniform1i(dgl.getUniformLocation(program, 's'), 0);
  dgl.viewport(0, 0, 64, 64);
  dgl.drawArrays(dgl.TRIANGLES, 0, 3);

  const pixel = new Uint8Array(4);
  dgl.readPixels(32, 32, 1, 1, dgl.RGBA, dgl.UNSIGNED_BYTE, pixel);
  assert.deepEqual([...pixel], [0, 0, 255, 255], 'texture should contain the post-resize blue frame');

  // texSubImage2D must accept the same source without error.
  dgl.texImage2D(
    dgl.TEXTURE_2D, 0, dgl.RGBA, 48, 40, 0, dgl.RGBA, dgl.UNSIGNED_BYTE,
    new Uint8Array(48 * 40 * 4),
  );
  dgl.texSubImage2D(dgl.TEXTURE_2D, 0, 0, 0, dgl.RGBA, dgl.UNSIGNED_BYTE, source);
  assert.equal(dgl.getError(), dgl.NO_ERROR, 'texSubImage2D with a resized GL canvas failed');
});

test('gradient rendered after resize is exported with correct regions', async () => {
  const canvas = createCanvas(64, 64);
  const gl = canvas.getContext('webgl');

  canvas.width = 80;
  canvas.height = 40;

  // Horizontal red -> green gradient across the resized buffer.
  const program = createGradientProgram(gl);
  gl.useProgram(program);
  const quad = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, quad);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  const position = gl.getAttribLocation(program, 'p');
  gl.enableVertexAttribArray(position);
  gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
  gl.viewport(0, 0, 80, 40);
  gl.drawArrays(gl.TRIANGLES, 0, 3);

  const buffer = canvas.toBuffer();
  fs.writeFileSync(path.join(OUT_DIR, 'gradient.png'), buffer);
  const imageData = await decodePNG(buffer, 80, 40);
  const {data, width, height} = imageData;

  // Left edge is red, right edge is green; alpha stays opaque everywhere.
  const left = 4 * (Math.floor(height / 2) * width + 2);
  const right = 4 * (Math.floor(height / 2) * width + (width - 3));
  assert.ok(data[left] > 200 && data[left + 1] < 60, 'left edge should be red');
  assert.ok(data[right] < 60 && data[right + 1] > 200, 'right edge should be green');
  assert.equal(data[left + 3], 255);
  assert.equal(data[right + 3], 255);
});

test('illegal dimensions never throw and leave a consistent, usable surface', () => {
  const canvas = createCanvas(32, 24);
  const gl = canvas.getContext('webgl');
  clearTo(gl, 1, 0, 0);

  const illegal = [-1, -100, 0, NaN, Infinity, -Infinity, 'abc', {}, 1e12, 2147483648, null, undefined];
  illegal.forEach((value) => {
    assert.doesNotThrow(() => {
      canvas.width = value;
      canvas.height = value;
    }, `setting dimension to ${String(value)} threw`);
    assert.equal(canvas.width, 32, `width changed after illegal input ${String(value)}`);
    assert.equal(canvas.height, 24, `height changed after illegal input ${String(value)}`);
    assert.equal(gl.drawingBufferWidth, 32, `GL buffer width changed after illegal input ${String(value)}`);
    assert.equal(gl.drawingBufferHeight, 24, `GL buffer height changed after illegal input ${String(value)}`);
  });

  // A legal resize after the rejected inputs still works.
  canvas.width = 50;
  canvas.height = 36;
  assert.equal(canvas.width, 50);
  assert.equal(canvas.height, 36);
  assert.equal(gl.drawingBufferWidth, 50);
  assert.equal(gl.drawingBufferHeight, 36);
  clearTo(gl, 0, 1, 0);

  const buffer = canvas.toBuffer();
  assert.ok(buffer.length > 0);
});

test('setAttribute routes illegal width/height through the same safe path', () => {
  const canvas = createCanvas(16, 16);
  canvas.getContext('webgl');
  assert.doesNotThrow(() => {
    canvas.setAttribute('width', -5);
    canvas.setAttribute('height', 'nope');
  });
  assert.equal(canvas.width, 16);
  assert.equal(canvas.height, 16);
  canvas.setAttribute('width', 44);
  canvas.setAttribute('height', 33);
  assert.equal(canvas.width, 44);
  assert.equal(canvas.height, 33);
});

test('fractional dimensions are truncated to integer pixels', () => {
  const canvas = createCanvas(32, 32);
  const gl = canvas.getContext('webgl');
  canvas.width = 40.9;
  canvas.height = 28.1;
  assert.equal(canvas.width, 40);
  assert.equal(canvas.height, 28);
  assert.equal(gl.drawingBufferWidth, 40);
  assert.equal(gl.drawingBufferHeight, 28);
});

function createShader(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if(!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    throw new Error(gl.getShaderInfoLog(shader));
  }
  return shader;
}

function linkProgram(gl, vertexSource, fragmentSource) {
  const program = gl.createProgram();
  gl.attachShader(program, createShader(gl, gl.VERTEX_SHADER, vertexSource));
  gl.attachShader(program, createShader(gl, gl.FRAGMENT_SHADER, fragmentSource));
  gl.linkProgram(program);
  if(!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    throw new Error(gl.getProgramInfoLog(program));
  }
  return program;
}

function createTexturedProgram(gl) {
  return linkProgram(
    gl,
    'attribute vec2 p; varying vec2 uv; void main(){uv=p*0.5+0.5;gl_Position=vec4(p,0.0,1.0);}',
    'precision mediump float; varying vec2 uv; uniform sampler2D s; void main(){gl_FragColor=texture2D(s,uv);}',
  );
}

function createGradientProgram(gl) {
  return linkProgram(
    gl,
    'attribute vec2 p; varying float t; void main(){t=p.x*0.5+0.5;gl_Position=vec4(p,0.0,1.0);}',
    'precision mediump float; varying float t; void main(){gl_FragColor=vec4(1.0-t,t,0.0,1.0);}',
  );
}

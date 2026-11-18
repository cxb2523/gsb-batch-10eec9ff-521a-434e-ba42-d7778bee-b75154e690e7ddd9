const {Canvas, Image} = require('canvas');
const EventEmitter = require('events');
const createGLContext = require('gl');

const _ctx = Symbol('ctx');

// Maximum dimension accepted by a canvas surface (also used by the DOM mock).
// Values above this are rejected instead of being forwarded to the native layer.
const MAX_CANVAS_DIMENSION = 2147483647;

/**
 * Normalize a width/height candidate.
 *
 * The native backends (headless-gl resize extension and the cairo surface)
 * both throw "Invalid surface dimensions" for negative, non-finite, non-numeric
 * or oversized values.  Throwing out of a width/height setter would leave the
 * GL drawing buffer and the 2D readback surface diverged, so every candidate is
 * sanitized here.  Returns null when the value must not be applied; callers
 * keep the previous dimension in that case.
 */
function sanitizeDimension(value) {
  const num = Number(value);
  if(!Number.isFinite(num) || num <= 0 || num > MAX_CANVAS_DIMENSION) {
    return null;
  }
  // Canvas dimensions are integer pixels.
  return Math.floor(num);
}

function putImageData(gl, canvas) {
  const {width, height} = canvas;
  const ctx = canvas[_ctx];

  // Always allocate against the CURRENT drawing-buffer size.  Reusing an
  // ImageData created at an older size would either clip the readback (shrink)
  // or read out of bounds (grow), so no buffer is cached across resizes.
  const data = ctx.createImageData(width, height);

  const pixels = new Uint8Array(width * height * 4);
  gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);

  // GL stores rows bottom-up while canvas expects top-down: flip vertically.
  for(let i = 0; i < height; i++) {
    for(let j = 0; j < width; j++) {
      const col = j;
      const row = height - i - 1;
      for(let k = 0; k < 4; k++) {
        const idx = 4 * (row * width + col) + k;
        const idx2 = 4 * (i * width + col) + k;
        data.data[idx] = pixels[idx2];
      }
    }
  }

  ctx.putImageData(data, 0, 0);
  return ctx;
}

class NodeCanvasElement extends Canvas {
  constructor(...args) {
    super(...args);
    this.__event__ = new EventEmitter();
    this.__attributes__ = {};
    this.style = {};
  }

  get width() {
    return super.width;
  }

  set width(value) {
    const next = sanitizeDimension(value);
    if(next === null) {
      // Ignore illegal input entirely: neither the GL buffer nor the 2D
      // surface is touched, so no half-updated state can survive.
      return;
    }
    if(this.__gl__) {
      const ext = this.__gl__.getExtension('STACKGL_resize_drawingbuffer');
      ext.resize(next, this.height);
    }
    super.width = next;
  }

  get height() {
    return super.height;
  }

  set height(value) {
    const next = sanitizeDimension(value);
    if(next === null) {
      return;
    }
    if(this.__gl__) {
      const ext = this.__gl__.getExtension('STACKGL_resize_drawingbuffer');
      ext.resize(this.width, next);
    }
    super.height = next;
  }

  get clientWidth() {
    return super.width;
  }

  get clientHeight() {
    return super.height;
  }

  get __ctx__() {
    const gl = this.__gl__;
    if(gl) {
      putImageData(gl, this);
    }
    return this[_ctx];
  }

  getContext(type, options) {
    if(this.__contextType__ && this.__contextType__ !== type) return null;
    if(this.__gl__) return this.__gl__;
    this.__contextType__ = type;
    if(type === 'webgl' || type === 'webgl2') {
      const {width, height} = this;
      this[_ctx] = super.getContext('2d', options);
      const ctx = createGLContext(width, height, options);
      const _getUniformLocation = ctx.getUniformLocation;

      // Temporary fix https://github.com/stackgl/headless-gl/issues/170
      ctx.getUniformLocation = function (program, name) {
        if(program._uniforms && !/\[\d+\]$/.test(name)) {
          const reg = new RegExp(`${name}\\[\\d+\\]$`);
          for(let i = 0; i < program._uniforms.length; i++) {
            const _name = program._uniforms[i].name;
            if(reg.test(_name)) {
              name = _name;
            }
          }
        }
        return _getUniformLocation.call(this, program, name);
      };

      ctx.canvas = this;

      // Resolve a texImage2D/texSubImage2D pixel source into data headless-gl
      // can consume.  headless-gl's extractImageData() calls
      // source.getContext('2d'), which on a WebGL canvas returns the GL context
      // rather than a 2D one, so the GL canvas has to be converted explicitly.
      const resolvePixels = (pixels) => {
        if(pixels && pixels._image) pixels = pixels._image;
        if(pixels instanceof Image) {
          const canvas = new Canvas(pixels.width, pixels.height);
          canvas.getContext('2d').drawImage(pixels, 0, 0);
          return canvas;
        }
        if(pixels instanceof NodeCanvasElement && pixels.__gl__) {
          // Force a fresh GL -> 2D sync at the current drawing-buffer size so
          // a resized WebGL canvas is never sampled from a stale snapshot, then
          // hand back the ImageData directly (headless-gl accepts any object
          // exposing width/height/data).
          const ctx2d = pixels.__ctx__;
          return ctx2d.getImageData(0, 0, pixels.width, pixels.height);
        }
        return pixels;
      };

      const _texImage2D = ctx.texImage2D;
      ctx.texImage2D = function (...args) {
        args[args.length - 1] = resolvePixels(args[args.length - 1]);
        return _texImage2D.apply(this, args);
      };

      const _texSubImage2D = ctx.texSubImage2D;
      ctx.texSubImage2D = function (...args) {
        args[args.length - 1] = resolvePixels(args[args.length - 1]);
        return _texSubImage2D.apply(this, args);
      };

      this.__gl__ = ctx;
      return this.__gl__;
    }
    return super.getContext(type, options);
  }

  toBuffer(...args) {
    const gl = this.__gl__;
    if(gl) {
      putImageData(gl, this);
    }
    return super.toBuffer(...args);
  }

  toDataURL(...args) {
    const gl = this.__gl__;
    if(gl) {
      putImageData(gl, this);
    }
    return super.toDataURL(...args);
  }

  createPNGStream(...args) {
    const gl = this.__gl__;
    if(gl) {
      putImageData(gl, this);
    }
    return super.createPNGStream(...args);
  }

  createJPEGStream(...args) {
    const gl = this.__gl__;
    if(gl) {
      putImageData(gl, this);
    }
    return super.createJPEGStream(...args);
  }

  createPDFStream(...args) {
    const gl = this.__gl__;
    if(gl) {
      putImageData(gl, this);
    }
    return super.createPDFStream(...args);
  }

  addEventListener(type, listener) {
    return this.__event__.addListener(type, listener);
  }

  removeEventListener(type, listener) {
    if(listener) {
      return this.__event__.removeListener(type, listener);
    }
    return this.removeAllListeners(type);
  }

  dispatchEvent(event) {
    event.target = this;
    return this.emit(event.type, event);
  }

  setAttribute(key, value) {
    this.__attributes__[key] = value;

    if(key === 'width') {
      this.width = value;
    }

    if(key === 'height') {
      this.height = value;
    }
  }

  getAttribute(key) {
    if(key === 'width') {
      return this.width;
    }
    if(key === 'height') {
      return this.height;
    }
    return this.__attributes__[key];
  }

  removeAttribute(key) {
    delete this.__attributes__[key];
  }
}

module.exports = NodeCanvasElement;

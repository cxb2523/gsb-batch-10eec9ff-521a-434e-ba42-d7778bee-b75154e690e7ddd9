// AsciiRenderer — two-pass WebGL rendering pipeline.
//
// Pass 1 (EdgeFBO): runs edge.frag.glsl on the source texture; outputs gradient
//   magnitude, angle, and luminance to a half-float FBO.
//
// Pass 2 (Screen): runs ascii.frag.glsl; reads the EdgeFBO and the glyph atlas
//   to composite the final typographic frame directly to the canvas.
//
// Three.js is used for context management, FBO handling, and built-in WebGL2
// capability detection.  RawShaderMaterial keeps full control of the GLSL.

import * as THREE from 'three';
import { GlyphAtlas } from './GlyphAtlas';
import type { RendererConfig } from './types';

import commonVertSrc from './shaders/common.vert.glsl';
import edgeFragSrc   from './shaders/edge.frag.glsl';
import asciiFragSrc  from './shaders/ascii.frag.glsl';

export class AsciiRenderer {
  private readonly renderer:  THREE.WebGLRenderer;
  private readonly camera:    THREE.OrthographicCamera;
  private readonly geometry:  THREE.PlaneGeometry;

  // Pass 1
  private edgeFBO:      THREE.WebGLRenderTarget;
  private edgeMat:      THREE.RawShaderMaterial;
  private edgeScene:    THREE.Scene;

  // Pass 2
  private asciiMat:     THREE.RawShaderMaterial;
  private asciiScene:   THREE.Scene;

  // State
  private atlas:        GlyphAtlas;
  private atlasTex:     THREE.CanvasTexture;
  private config:       RendererConfig;
  private animId:       number | null = null;
  private sourceTex:    THREE.Texture | null = null;

  // Character grid state.  Kept in sync with uCellCount so the CPU-side text
  // export samples exactly the same cells the shader rendered.
  private cssWidth:     number = 0;
  private cssHeight:    number = 0;
  private gridCols:     number = 1;
  private gridRows:     number = 1;

  constructor(canvas: HTMLCanvasElement, config: RendererConfig) {
    this.config = { ...config };

    this.cssWidth  = canvas.clientWidth;
    this.cssHeight = canvas.clientHeight;
    this.updateGridState();

    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias:            false,
      alpha:                false,
      powerPreference:      'high-performance',
      preserveDrawingBuffer: true, // required for PNG export and ASCII text readback
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(canvas.clientWidth, canvas.clientHeight, false);

    // Orthographic camera looking straight at the quad — no perspective needed
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

    // Full-screen quad: PlaneGeometry(2,2) spans NDC [-1,1] in both axes
    this.geometry = new THREE.PlaneGeometry(2, 2);

    // Glyph atlas — built once, uploaded as a texture
    this.atlas    = new GlyphAtlas({
      charset:    config.charset,
      fontSize:   config.fontSize,
      fontFamily: config.fontFamily,
    });
    this.atlasTex = this.buildAtlasTex();

    // Render targets + materials
    const size    = this.renderer.getSize(new THREE.Vector2());
    this.edgeFBO  = this.makeEdgeFBO(size.x, size.y);
    this.edgeMat  = this.makeEdgeMat(size.x, size.y);
    this.asciiMat = this.makeAsciiMat();
    this.syncCellCountUniform();

    // Scene graphs — one mesh per pass
    const edgeMesh  = new THREE.Mesh(this.geometry, this.edgeMat);
    this.edgeScene  = new THREE.Scene();
    this.edgeScene.add(edgeMesh);

    const asciiMesh  = new THREE.Mesh(this.geometry, this.asciiMat);
    this.asciiScene  = new THREE.Scene();
    this.asciiScene.add(asciiMesh);
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  setSourceTexture(tex: THREE.Texture): void {
    this.sourceTex = tex;
    this.edgeMat.uniforms['uSource'].value  = tex;
    this.asciiMat.uniforms['uSource'].value = tex;
  }

  updateConfig(patch: Partial<RendererConfig>): void {
    Object.assign(this.config, patch);

    if (patch.edgeWeight !== undefined)
      this.asciiMat.uniforms['uEdgeWeight'].value = patch.edgeWeight;

    if (patch.contrast !== undefined)
      this.asciiMat.uniforms['uContrast'].value = patch.contrast;

    if (patch.fgColor !== undefined)
      (this.asciiMat.uniforms['uFgColor'].value as THREE.Color).set(patch.fgColor);

    if (patch.bgColor !== undefined)
      (this.asciiMat.uniforms['uBgColor'].value as THREE.Color).set(patch.bgColor);

    // Charset or font changes require a full atlas rebuild
    const needsAtlas = patch.charset !== undefined
      || patch.fontSize   !== undefined
      || patch.fontFamily !== undefined;

    if (needsAtlas) this.rebuildAtlas();

    // Cell size changes reshape the character grid used by both the shader
    // and the text export.
    if (patch.cellSize !== undefined) {
      this.updateGridState();
      this.syncCellCountUniform();
    }
  }

  resize(cssWidth: number, cssHeight: number): void {
    this.cssWidth  = cssWidth;
    this.cssHeight = cssHeight;
    this.renderer.setSize(cssWidth, cssHeight, false);

    // Actual pixel dimensions after DPR scaling
    const w = this.renderer.domElement.width;
    const h = this.renderer.domElement.height;

    this.edgeFBO.setSize(w, h);
    this.edgeMat.uniforms['uTexelSize'].value.set(1 / w, 1 / h);

    // Recompute the character grid on the CSS-pixel dimensions (same units
    // as cellSize) and push it to the shader.
    this.updateGridState();
    this.syncCellCountUniform();
  }

  render(): void {
    if (!this.sourceTex) return;

    // Pass 1: edge detection to FBO
    this.renderer.setRenderTarget(this.edgeFBO);
    this.renderer.render(this.edgeScene, this.camera);

    // Pass 2: ASCII compositing to screen
    this.renderer.setRenderTarget(null);
    this.renderer.render(this.asciiScene, this.camera);
  }

  /**
   * Start the animation loop.
   * @param onTick  Called every frame before rendering (for GIF/Math source tick).
   * @param onFps   Called once per second with the rolling FPS value.
   */
  startLoop(onTick?: () => void, onFps?: (fps: number) => void): void {
    let frames = 0;
    let t0 = performance.now();

    const loop = () => {
      onTick?.();
      this.render();
      frames++;
      const now = performance.now();
      if (now - t0 >= 1000) {
        onFps?.(Math.round(frames * 1000 / (now - t0)));
        frames = 0;
        t0 = now;
      }
      this.animId = requestAnimationFrame(loop);
    };
    this.animId = requestAnimationFrame(loop);
  }

  stopLoop(): void {
    if (this.animId !== null) {
      cancelAnimationFrame(this.animId);
      this.animId = null;
    }
  }

  /** Capture the current frame as a PNG Blob. Requires preserveDrawingBuffer: true. */
  exportPng(): Promise<Blob | null> {
    return new Promise<Blob | null>((resolve) =>
      this.renderer.domElement.toBlob(resolve, 'image/png'),
    );
  }

  /**
   * Convert the current rendered frame to plain ASCII text via a 2D canvas
   * pixel readback.  Sampling uses the same cols×rows character grid the
   * shader rendered with, so the exported text matches the visible frame.
   *
   * Each grid cell covers the same slice of the frame the shader assigns to
   * it (columns/rows split evenly across the full width/height, matching
   * `floor(vUv * uCellCount)`).  The average luminance of a cell's pixel
   * region is mapped to a charset index the same way ascii.frag.glsl maps
   * intensity: dense characters (index 0) for bright cells, sparse ones
   * (index n-1) for dark cells.
   */
  generateAsciiText(): string {
    const src = this.renderer.domElement;
    const w   = src.width;
    const h   = src.height;
    if (w === 0 || h === 0) return '';

    const tmp = document.createElement('canvas');
    tmp.width  = w;
    tmp.height = h;
    const ctx  = tmp.getContext('2d');
    if (!ctx) return '';
    ctx.drawImage(src, 0, 0);
    const { data: px } = ctx.getImageData(0, 0, w, h);

    // Mirror GlyphAtlas: duplicates are dropped while preserving order, so
    // the text indices and the shader's uCharCount refer to the same glyphs.
    const chars   = [...new Set([...this.config.charset])];
    const n       = chars.length;
    if (n === 0) return '';
    const cols    = this.gridCols;
    const rows    = this.gridRows;

    // Cell boundaries in device pixels, derived from the shader's own cell
    // rule floor(uv * uCellCount) sampled at each pixel centre, so edge cells
    // are neither clipped nor double-counted.
    const xEdges = cellBoundaries(cols, w);
    const yEdges = cellBoundaries(rows, h);

    const lines: string[] = [];
    for (let row = 0; row < rows; row++) {
      let line = '';
      const y0 = yEdges[row];
      const y1 = yEdges[row + 1];
      for (let col = 0; col < cols; col++) {
        const x0 = xEdges[col];
        const x1 = xEdges[col + 1];

        let sum = 0, cnt = 0;
        for (let y = y0; y < y1; y++) {
          const rowOffset = y * w;
          for (let x = x0; x < x1; x++) {
            const i = (rowOffset + x) * 4;
            sum += px[i] * 0.2126 + px[i + 1] * 0.7152 + px[i + 2] * 0.0722;
            cnt++;
          }
        }
        const lum = cnt > 0 ? sum / (cnt * 255) : 0;

        // ascii.frag.glsl: charIndex = floor(intensity * (charCount - 1)),
        // where intensity ~ luminance.  Index 0 is the densest glyph, so a
        // bright cell selects a low index and a dark cell a high one.
        const idx = Math.min(n - 1, Math.floor((1 - lum) * (n - 1)));
        line += chars[idx];
      }
      lines.push(line);
    }
    return lines.join('\n');
  }

  dispose(): void {
    this.stopLoop();
    this.edgeFBO.dispose();
    this.edgeMat.dispose();
    this.asciiMat.dispose();
    this.atlasTex.dispose();
    this.geometry.dispose();
    this.renderer.dispose();
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /**
   * Recompute the character grid from the current CSS dimensions and
   * cellSize.  Both the shader uniform and generateAsciiText() read this
   * state, so the on-screen glyph grid and the copied text always share the
   * same cols/rows.
   */
  private updateGridState(): void {
    const cellSize = Math.max(1, this.config.cellSize);
    this.gridCols = Math.max(1, Math.floor(this.cssWidth  / cellSize));
    this.gridRows = Math.max(1, Math.floor(this.cssHeight / cellSize));
  }

  /** Push the current grid dimensions into the shader's uCellCount uniform. */
  private syncCellCountUniform(): void {
    this.asciiMat.uniforms['uCellCount'].value.set(this.gridCols, this.gridRows);
  }

  private buildAtlasTex(): THREE.CanvasTexture {
    const tex       = new THREE.CanvasTexture(this.atlas.canvas);
    tex.minFilter   = THREE.NearestFilter;
    tex.magFilter   = THREE.NearestFilter;
    tex.needsUpdate = true;
    return tex;
  }

  private makeEdgeFBO(w: number, h: number): THREE.WebGLRenderTarget {
    return new THREE.WebGLRenderTarget(w, h, {
      type:      THREE.HalfFloatType,
      format:    THREE.RGBAFormat,
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
    });
  }

  private makeEdgeMat(w: number, h: number): THREE.RawShaderMaterial {
    return new THREE.RawShaderMaterial({
      glslVersion:    THREE.GLSL3,
      vertexShader:   commonVertSrc,
      fragmentShader: edgeFragSrc,
      uniforms: {
        uSource:    { value: null },
        uTexelSize: { value: new THREE.Vector2(1 / w, 1 / h) },
      },
    });
  }

  private makeAsciiMat(): THREE.RawShaderMaterial {
    const { metrics } = this.atlas;

    return new THREE.RawShaderMaterial({
      glslVersion:    THREE.GLSL3,
      vertexShader:   commonVertSrc,
      fragmentShader: asciiFragSrc,
      uniforms: {
        uSource:     { value: null },
        uEdge:       { value: this.edgeFBO.texture },
        uAtlas:      { value: this.atlasTex },
        uCellCount:  { value: new THREE.Vector2(this.gridCols, this.gridRows) },
        uAtlasDims:  { value: new THREE.Vector2(metrics.cols, metrics.rows) },
        uEdgeWeight: { value: this.config.edgeWeight },
        uContrast:   { value: this.config.contrast },
        uFgColor:    { value: new THREE.Color(this.config.fgColor) },
        uBgColor:    { value: new THREE.Color(this.config.bgColor) },
        uCharCount:  { value: metrics.charCount },
      },
    });
  }

  private rebuildAtlas(): void {
    this.atlasTex.dispose();
    this.atlas    = new GlyphAtlas({
      charset:    this.config.charset,
      fontSize:   this.config.fontSize,
      fontFamily: this.config.fontFamily,
    });
    this.atlasTex = this.buildAtlasTex();

    const u = this.asciiMat.uniforms;
    u['uAtlas'].value     = this.atlasTex;
    u['uAtlasDims'].value.set(this.atlas.metrics.cols, this.atlas.metrics.rows);
    u['uCharCount'].value = this.atlas.metrics.charCount;
  }
}

/**
 * Device-pixel boundaries of `count` evenly spaced cells across `extent`
 * pixels, returned as an array of `count + 1` offsets.
 *
 * A pixel x belongs to cell c when floor((x + 0.5) / extent * count) === c,
 * i.e. the shader's `floor(vUv * uCellCount)` evaluated at the pixel centre.
 * Solving for x gives the boundary ceil(c * extent / count - 0.5), so the CPU
 * cell partition matches the GPU one exactly — including the last partial cell
 * at the right/bottom edge.
 */
function cellBoundaries(count: number, extent: number): number[] {
  const edges = new Array<number>(count + 1);
  for (let i = 0; i <= count; i++) {
    const edge = Math.ceil((i * extent) / count - 0.5);
    edges[i] = Math.min(extent, Math.max(0, edge));
  }
  return edges;
}

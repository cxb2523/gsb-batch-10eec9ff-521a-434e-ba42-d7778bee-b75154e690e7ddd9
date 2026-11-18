// Animated water surface built on the official Three.js Water example, with a
// procedurally generated tileable normal map so no external textures are needed.

import * as THREE from "three";
import { Water } from "three/addons/objects/Water.js";
import { CONFIG } from "../data/config.js";

let cachedNormals = null;

/**
 * Generates a tileable water normal map from layered value noise drawn to a
 * canvas. Quality is plenty for a stylized surface and avoids CDN texture
 * dependencies entirely.
 *
 * The texture is shared by every Water build (and every quality level), so it
 * is generated exactly once and must never be disposed with the surface.
 */
function generateWaterNormals(size = 256) {
  if (cachedNormals) return cachedNormals;

  // tileable height field from summed sine pseudo-noise
  const height = new Float32Array(size * size);
  const octaves = [
    { fx: 2, fy: 3, amp: 1.0, px: 1.7, py: 4.2 },
    { fx: 5, fy: 4, amp: 0.55, px: 2.9, py: 0.8 },
    { fx: 9, fy: 8, amp: 0.3, px: 5.1, py: 2.3 },
    { fx: 16, fy: 17, amp: 0.18, px: 0.4, py: 3.7 },
  ];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = (x / size) * Math.PI * 2;
      const v = (y / size) * Math.PI * 2;
      let h = 0;
      for (const o of octaves) {
        h += Math.sin(u * o.fx + o.px + Math.cos(v * o.fy + o.py)) * o.amp;
        h += Math.cos(v * o.fy * 0.7 + o.px + Math.sin(u * o.fx * 1.3)) * o.amp * 0.6;
      }
      height[y * size + x] = h;
    }
  }

  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d");
  const img = ctx.createImageData(size, size);
  const at = (x, y) => height[((y + size) % size) * size + ((x + size) % size)];
  const strength = 2.2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (at(x + 1, y) - at(x - 1, y)) * strength;
      const dy = (at(x, y + 1) - at(x, y - 1)) * strength;
      const inv = 1 / Math.sqrt(dx * dx + dy * dy + 1);
      const i = (y * size + x) * 4;
      img.data[i] = (-dx * inv * 0.5 + 0.5) * 255;
      img.data[i + 1] = (-dy * inv * 0.5 + 0.5) * 255;
      img.data[i + 2] = inv * 255;
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);

  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.userData.shared = true;
  cachedNormals = tex;
  return tex;
}

// The Water addon keeps its reflection WebGLRenderTarget in a closure and never
// exposes it, so wrapping the surface in `.dispose()` is not enough to release
// the framebuffer/renderbuffer it owns. Capture the target the first time the
// addon binds it, then dispose it properly when the surface is rebuilt.
const reflectionTargets = new WeakMap();

function captureReflectionTarget(water) {
  const base = water.onBeforeRender;
  const mirrorSampler = water.material.uniforms.mirrorSampler;

  water.onBeforeRender = function (renderer, scene, camera) {
    if (reflectionTargets.has(water)) return base.call(this, renderer, scene, camera);

    const setRenderTarget = renderer.setRenderTarget;
    renderer.setRenderTarget = function (target, ...rest) {
      if (target && target.isRenderTarget && target.texture === mirrorSampler.value) {
        reflectionTargets.set(water, target);
      }
      return setRenderTarget.call(this, target, ...rest);
    };

    try {
      return base.call(this, renderer, scene, camera);
    } finally {
      renderer.setRenderTarget = setRenderTarget;
      // Once found, stop intercepting and run the addon's own hook directly.
      if (reflectionTargets.has(water)) water.onBeforeRender = base;
    }
  };
}

/** Releases everything a Water instance owns except the shared normal map. */
function disposeWater(water) {
  if (!water) return;

  // The render target owns the reflection texture, framebuffer and renderbuffer.
  // (If the surface never rendered, no GPU resources were allocated yet.)
  const target = reflectionTargets.get(water);
  if (target) {
    reflectionTargets.delete(water);
    target.dispose();
  }

  water.geometry?.dispose();
  water.material?.dispose();
  // Drop the addon's per-instance render hook so a stale surface can never
  // render into a disposed target.
  water.onBeforeRender = () => {};
}

export class WaterSurface {
  constructor(scene, quality = "high") {
    this.scene = scene;
    this.quality = CONFIG.quality[quality] ? quality : "high";
    this.params = { color: 0x1f5f53, distortion: 1.7, size: 3.2, timeScale: 0.6 };
    this.water = null;
    // Animation phase survives rebuilds so a quality change doesn't visibly
    // restart the ripples from zero.
    this.time = 0;
    // Last sun written by the sky system, re-applied when the surface is
    // rebuilt so a quality change can never reset it to a default sun.
    this.sunDirection = new THREE.Vector3(0.3, 0.8, 0.2).normalize();
    this.sunColor = new THREE.Color(0xffffff);
    this.build();
  }

  /** Reflection texture edge length for the current quality preset. */
  get textureSize() {
    return CONFIG.quality[this.quality]?.waterTex ?? 1024;
  }

  build() {
    if (this.water) this.disposeSurface();

    const texSize = this.textureSize;
    const geometry = new THREE.PlaneGeometry(CONFIG.water.size, CONFIG.water.size);
    const water = new Water(geometry, {
      textureWidth: texSize,
      textureHeight: texSize,
      waterNormals: generateWaterNormals(),
      sunDirection: this.sunDirection.clone(),
      sunColor: this.sunColor.clone(),
      waterColor: this.params.color,
      distortionScale: this.params.distortion,
      fog: true,
    });
    water.rotation.x = -Math.PI / 2;
    water.position.y = CONFIG.water.level;
    water.material.uniforms.time.value = this.time;

    this.scene.add(water);
    this.water = water;
    captureReflectionTarget(water);
    this.applyParams();
  }

  /** Removes and releases the current surface (keeps the shared normal map). */
  disposeSurface() {
    const old = this.water;
    if (!old) return;
    this.scene.remove(old);
    disposeWater(old);
    this.water = null;
  }

  /** Pushes the stored parameter set into the live material uniforms. */
  applyParams() {
    if (!this.water) return;
    const u = this.water.material.uniforms;
    u.waterColor.value.setHex(this.params.color);
    u.distortionScale.value = this.params.distortion;
    u.size.value = this.params.size;
    // timeScale is read by update(); nothing else to write here.
  }

  setParams(p = {}) {
    this.params = { ...this.params, ...p };
    this.applyParams();
  }

  setSun(direction, color) {
    if (direction) this.sunDirection.copy(direction).normalize();
    if (color) this.sunColor.copy(color);
    if (!this.water) return;
    const u = this.water.material.uniforms;
    u.sunDirection.value.copy(this.sunDirection);
    u.sunColor.value.copy(this.sunColor);
  }

  update(dt) {
    this.time += dt * this.params.timeScale;
    if (this.water) this.water.material.uniforms.time.value = this.time;
  }

  setQuality(quality) {
    const next = CONFIG.quality[quality] ? quality : "high";
    if (next === this.quality && this.water) return;
    this.quality = next;
    // Full rebuild: new reflection target at the new size; the old target,
    // material and geometry are released by build() -> disposeSurface().
    // Location params and the last sun/moon state stay applied.
    this.build();
  }
}

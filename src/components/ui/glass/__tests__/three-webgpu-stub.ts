import { vi } from 'vitest'

/**
 * Minimal stand-ins for three/webgpu and three/tsl. The real WebGPURenderer needs a GPU
 * context that jsdom cannot provide; the runtime under test only uses these constructors
 * as containers, so behaviourless doubles are enough. Texture uploads are counted so the
 * "no duplicate texture upload" acceptance criterion can be asserted.
 */

class V2 {
  x: number
  y: number
  constructor(x = 0, y = 0) {
    this.x = x
    this.y = y
  }
  set(x: number, y: number) {
    this.x = x
    this.y = y
    return this
  }
}

class V3 {
  x: number
  y: number
  z: number
  constructor(x = 0, y = 0, z = 0) {
    this.x = x
    this.y = y
    this.z = z
  }
  set(x: number, y: number, z: number) {
    this.x = x
    this.y = y
    this.z = z
    return this
  }
}

export class CanvasTexture {
  /** Upload requests for this specific texture (runtime sets needsUpdate=true once per render). */
  needsUpdateCount = 0
  needsUpdateValue = false
  colorSpace = ''
  premultiplyAlpha = false
  minFilter = 0
  magFilter = 0
  generateMipmaps = false
  disposed = false
  constructor(public canvas: HTMLCanvasElement) {}
  get needsUpdate() {
    return this.needsUpdateValue
  }
  set needsUpdate(v: boolean) {
    if (v) this.needsUpdateCount++
    this.needsUpdateValue = v
  }
  dispose() {
    this.disposed = true
    this.needsUpdateValue = false
  }
}

export class WebGPURenderer {
  domElement: HTMLCanvasElement
  constructor(_opts?: unknown) {
    this.domElement = document.createElement('canvas')
  }
  async init() {}
  setPixelRatio() {}
  setSize() {}
  setClearColor() {}
  async compileAsync() {}
  render = vi.fn()
}

export class OrthographicCamera {
  position = { z: 0 }
}
export class Scene {
  add() {}
}
export class PlaneGeometry {
  dispose() {}
}
export class Mesh {
  frustumCulled = true
  constructor(
    public geometry: unknown,
    public material: unknown,
  ) {}
}
export class MeshBasicNodeMaterial {
  colorNode: unknown
  blending = 0
  transparent = false
  dispose = vi.fn()
}

export const NoBlending = 0
export const NoToneMapping = 0
export const LinearSRGBColorSpace = 'linear-srgb'
export const NoColorSpace = 'no-color-space'
export const LinearFilter = 1
export const LinearMipmapLinearFilter = 2
export const Vector2 = V2
export const Vector3 = V3

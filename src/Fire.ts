import {
  BoxGeometry,
  ShaderMaterial,
  type Texture,
  Color,
  Vector3,
  Vector4,
  Matrix4,
  LinearFilter,
  ClampToEdgeWrapping,
} from 'three'
import { FireShader, type FireShaderUniforms } from './FireShader'
import { AbstractFire } from './internal/AbstractFire'

/**
 * Properties for creating a Fire instance
 */
export interface FireProps {
  /** Fire texture (grayscale mask defining fire shape) */
  fireTex: Texture
  /** Fire color tint (default: 0xeeeeee) */
  color?: Color | string | number
  /** Ray marching iterations - higher = better quality, lower performance (default: 20) */
  iterations?: number
  /** Noise octaves for turbulence (default: 3) */
  octaves?: number
  /** Noise scaling parameters [x, y, z, time] (default: [1, 2, 1, 0.3]) */
  noiseScale?: [number, number, number, number]
  /** Fire shape intensity (default: 1.3) */
  magnitude?: number
  /** Noise lacunarity - frequency multiplier (default: 2.0) */
  lacunarity?: number
  /** Noise gain - amplitude multiplier (default: 0.5) */
  gain?: number
}

/**
 * Volumetric fire effect using ray marching shaders (WebGL / GLSL)
 *
 * Creates a procedural fire effect that renders as a translucent volume.
 * The fire shape is defined by a grayscale texture, with white areas being
 * the most dense part of the fire.
 *
 * @example
 * ```ts
 * const texture = textureLoader.load('fire.png')
 * const fire = new Fire({
 *   fireTex: texture,
 *   color: 0xff4400,
 *   magnitude: 1.5
 * })
 * scene.add(fire)
 *
 * // In animation loop
 * fire.update(time)
 *
 * // When done
 * fire.dispose()
 * ```
 */
export class Fire extends AbstractFire<ShaderMaterial & { uniforms: FireShaderUniforms }> {
  private _iterations: number
  private _octaves: number

  /**
   * Creates a new Fire instance
   *
   * @param props - Configuration options for the fire effect
   */
  constructor({
    fireTex,
    color = 0xeeeeee,
    iterations = 20,
    octaves = 3,
    noiseScale = [1, 2, 1, 0.3],
    magnitude = 1.3,
    lacunarity = 2.0,
    gain = 0.5,
  }: FireProps) {
    const geometry = new BoxGeometry(1, 1, 1)

    const material = new ShaderMaterial({
      defines: {
        ITERATIONS: iterations.toString(),
        OCTAVES: octaves.toString(),
      },
      uniforms: {
        fireTex: { value: fireTex },
        color: { value: color instanceof Color ? color : new Color(color) },
        time: { value: 0.0 },
        seed: { value: Math.random() * 19.19 },
        invModelMatrix: { value: new Matrix4() },
        scale: { value: new Vector3(1, 1, 1) },
        noiseScale: { value: new Vector4(...noiseScale) },
        magnitude: { value: magnitude },
        lacunarity: { value: lacunarity },
        gain: { value: gain },
      },
      vertexShader: FireShader.vertexShader,
      fragmentShader: FireShader.fragmentShader,
      transparent: true,
      depthWrite: false,
      depthTest: false,
    }) as ShaderMaterial & { uniforms: FireShaderUniforms }

    super(geometry, material)

    this._iterations = iterations
    this._octaves = octaves

    // Configure texture
    Fire.configureTexture(fireTex)
  }

  /**
   * Applies the filtering and wrapping rules the fire shader expects.
   * Shared by the constructor and the {@link fireTex} setter.
   */
  private static configureTexture(texture: Texture): void {
    texture.magFilter = texture.minFilter = LinearFilter
    texture.wrapS = texture.wrapT = ClampToEdgeWrapping
  }

  protected getUniforms(): FireShaderUniforms {
    return this.material.uniforms
  }

  /**
   * Fire texture (grayscale mask defining fire shape).
   *
   * Assigning a new texture updates the `fireTex` uniform and re-applies the
   * required filter/wrap settings. The texture is **not** disposed — its
   * lifecycle is owned by the caller. Assigning the texture that is already
   * bound is a no-op.
   */
  public get fireTex(): Texture | null {
    return this.material.uniforms.fireTex.value
  }

  public set fireTex(texture: Texture) {
    if (texture === this.material.uniforms.fireTex.value) return
    Fire.configureTexture(texture)
    this.material.uniforms.fireTex.value = texture
  }

  /**
   * Ray marching iterations - higher = better quality, lower performance.
   *
   * Changing this updates the `ITERATIONS` shader define and flags the
   * material for recompilation. Assigning the current value is a no-op, so
   * no recompile is triggered.
   */
  public get iterations(): number {
    return this._iterations
  }

  public set iterations(value: number) {
    if (value === this._iterations) return
    this._iterations = value
    this.getDefines().ITERATIONS = value.toString()
    this.material.needsUpdate = true
  }

  /**
   * Noise octaves for turbulence.
   *
   * Changing this updates the `OCTAVES` shader define and flags the material
   * for recompilation. Assigning the current value is a no-op, so no
   * recompile is triggered.
   */
  public get octaves(): number {
    return this._octaves
  }

  public set octaves(value: number) {
    if (value === this._octaves) return
    this._octaves = value
    this.getDefines().OCTAVES = value.toString()
    this.material.needsUpdate = true
  }

  /** Returns the material's defines map, creating it if absent. */
  private getDefines(): Record<string, unknown> {
    const material = this.material
    if (!material.defines) {
      material.defines = {}
    }
    return material.defines
  }
}

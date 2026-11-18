import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Fire } from '../src/Fire'
import { Color, Texture, LinearFilter, NearestFilter, ClampToEdgeWrapping } from 'three'

describe('Fire class', () => {
  let mockTexture: Texture

  beforeEach(() => {
    vi.clearAllMocks()
    mockTexture = new Texture()
  })

  describe('constructor', () => {
    it('creates Fire instance with required texture', () => {
      const fire = new Fire({ fireTex: mockTexture })

      expect(fire).toBeInstanceOf(Fire)
      expect(fire.material.uniforms.fireTex.value).toBe(mockTexture)
    })

    it('applies default values correctly', () => {
      const fire = new Fire({ fireTex: mockTexture })

      expect(fire.material.uniforms.magnitude.value).toBe(1.3)
      expect(fire.material.uniforms.lacunarity.value).toBe(2.0)
      expect(fire.material.uniforms.gain.value).toBe(0.5)
      expect(fire.material.uniforms.color.value).toBeInstanceOf(Color)
      expect(fire.material.uniforms.noiseScale.value).toEqual(
        expect.objectContaining({
          x: 1,
          y: 2,
          z: 1,
          w: 0.3,
        }),
      )
    })

    it('applies custom values correctly', () => {
      const fire = new Fire({
        fireTex: mockTexture,
        color: 0xff4400,
        magnitude: 2.5,
        lacunarity: 3.0,
        gain: 0.8,
        iterations: 30,
        octaves: 5,
        noiseScale: [2, 3, 2, 0.5],
      })

      expect(fire.material.uniforms.magnitude.value).toBe(2.5)
      expect(fire.material.uniforms.lacunarity.value).toBe(3.0)
      expect(fire.material.uniforms.gain.value).toBe(0.8)
      expect(fire.material.uniforms.color.value).toBeInstanceOf(Color)
      expect(fire.material.uniforms.noiseScale.value).toEqual(
        expect.objectContaining({
          x: 2,
          y: 3,
          z: 2,
          w: 0.5,
        }),
      )
      expect(fire.material.defines?.ITERATIONS).toBe('30')
      expect(fire.material.defines?.OCTAVES).toBe('5')
    })

    it('accepts Color objects', () => {
      const customColor = new Color('orange')
      const fire = new Fire({
        fireTex: mockTexture,
        color: customColor,
      })

      expect(fire.material.uniforms.color.value).toBe(customColor)
    })

    it('configures material properties for transparency', () => {
      const fire = new Fire({ fireTex: mockTexture })

      expect(fire.material.transparent).toBe(true)
      expect(fire.material.depthWrite).toBe(false)
      expect(fire.material.depthTest).toBe(false)
    })

    it('configures texture filters and wrapping', () => {
      new Fire({ fireTex: mockTexture })

      expect(mockTexture.magFilter).toBe(LinearFilter)
      expect(mockTexture.minFilter).toBe(LinearFilter)
      expect(mockTexture.wrapS).toBe(ClampToEdgeWrapping)
      expect(mockTexture.wrapT).toBe(ClampToEdgeWrapping)
    })

    it('generates random seed', () => {
      const fire1 = new Fire({ fireTex: mockTexture })
      const fire2 = new Fire({ fireTex: mockTexture })

      expect(fire1.material.uniforms.seed.value).toBeTypeOf('number')
      expect(fire2.material.uniforms.seed.value).toBeTypeOf('number')
      // Seeds should be different (statistically very likely)
      expect(fire1.material.uniforms.seed.value).not.toBe(fire2.material.uniforms.seed.value)
    })
  })

  describe('update method', () => {
    let fire: Fire

    beforeEach(() => {
      fire = new Fire({ fireTex: mockTexture })
    })

    it('updates time when provided', () => {
      fire.update(5.5)

      expect(fire.time).toBe(5.5)
      expect(fire.material.uniforms.time.value).toBe(5.5)
    })

    it('updates matrix uniforms', () => {
      const updateMatrixWorldSpy = vi.spyOn(fire, 'updateMatrixWorld')
      const matrixCopySpy = vi.spyOn(fire.material.uniforms.invModelMatrix.value, 'copy')
      const scaleCopySpy = vi.spyOn(fire.material.uniforms.scale.value, 'copy')

      fire.update(1.0)

      expect(updateMatrixWorldSpy).toHaveBeenCalled()
      expect(matrixCopySpy).toHaveBeenCalledWith(fire.matrixWorld)
      expect(scaleCopySpy).toHaveBeenCalledWith(fire.scale)
    })

    it('works without time parameter', () => {
      fire.time = 2.0
      fire.update()

      expect(fire.time).toBe(2.0) // Should remain unchanged
      expect(fire.material.uniforms.time.value).toBe(2.0)
    })
  })

  describe('time property', () => {
    let fire: Fire

    beforeEach(() => {
      fire = new Fire({ fireTex: mockTexture })
    })

    it('gets and sets time correctly', () => {
      fire.time = 3.14

      expect(fire.time).toBe(3.14)
      expect(fire.material.uniforms.time.value).toBe(3.14)
    })
  })

  describe('fireColor property', () => {
    let fire: Fire

    beforeEach(() => {
      fire = new Fire({ fireTex: mockTexture })
    })

    it('gets current color', () => {
      const color = fire.fireColor
      expect(color).toBeInstanceOf(Color)
    })

    it('sets color from hex number', () => {
      fire.fireColor = 0xff0000
      expect(fire.material.uniforms.color.value).toBeInstanceOf(Color)
      expect(fire.material.uniforms.color.value.r).toBe(1)
      expect(fire.material.uniforms.color.value.g).toBe(0)
      expect(fire.material.uniforms.color.value.b).toBe(0)
    })

    it('sets color from string', () => {
      fire.fireColor = 'red'
      expect(fire.material.uniforms.color.value).toBeInstanceOf(Color)
    })

    it('sets color from Color object', () => {
      const customColor = new Color(0.5, 0.8, 0.2)
      fire.fireColor = customColor
      expect(fire.material.uniforms.color.value).toBe(customColor)
    })
  })

  describe('magnitude property', () => {
    let fire: Fire

    beforeEach(() => {
      fire = new Fire({ fireTex: mockTexture })
    })

    it('gets and sets magnitude', () => {
      fire.magnitude = 2.5
      expect(fire.magnitude).toBe(2.5)
      expect(fire.material.uniforms.magnitude.value).toBe(2.5)
    })
  })

  describe('lacunarity property', () => {
    let fire: Fire

    beforeEach(() => {
      fire = new Fire({ fireTex: mockTexture })
    })

    it('gets and sets lacunarity', () => {
      fire.lacunarity = 3.5
      expect(fire.lacunarity).toBe(3.5)
      expect(fire.material.uniforms.lacunarity.value).toBe(3.5)
    })
  })

  describe('gain property', () => {
    let fire: Fire

    beforeEach(() => {
      fire = new Fire({ fireTex: mockTexture })
    })

    it('gets and sets gain', () => {
      fire.gain = 0.75
      expect(fire.gain).toBe(0.75)
      expect(fire.material.uniforms.gain.value).toBe(0.75)
    })
  })

  describe('fireTex property', () => {
    let fire: Fire

    beforeEach(() => {
      fire = new Fire({ fireTex: mockTexture })
    })

    it('gets the current texture', () => {
      expect(fire.fireTex).toBe(mockTexture)
    })

    it('updates the uniform and reconfigures filters/wrapping on change', () => {
      const newTexture = new Texture()
      newTexture.magFilter = NearestFilter

      fire.fireTex = newTexture

      expect(fire.fireTex).toBe(newTexture)
      expect(fire.material.uniforms.fireTex.value).toBe(newTexture)
      expect(newTexture.magFilter).toBe(LinearFilter)
      expect(newTexture.minFilter).toBe(LinearFilter)
      expect(newTexture.wrapS).toBe(ClampToEdgeWrapping)
      expect(newTexture.wrapT).toBe(ClampToEdgeWrapping)
    })

    it('does not dispose the replaced texture (caller owns its lifecycle)', () => {
      const newTexture = new Texture()
      const disposeSpy = vi.spyOn(mockTexture, 'dispose')

      fire.fireTex = newTexture

      expect(disposeSpy).not.toHaveBeenCalled()
    })

    it('is a no-op when assigning the texture already bound', () => {
      // Simulate the caller mutating the texture after construction
      mockTexture.magFilter = NearestFilter

      fire.fireTex = mockTexture

      // Untouched: no reconfiguration happened
      expect(mockTexture.magFilter).toBe(NearestFilter)
      expect(fire.material.uniforms.fireTex.value).toBe(mockTexture)
    })
  })

  describe('iterations property', () => {
    it('gets the initial iterations', () => {
      expect(new Fire({ fireTex: mockTexture }).iterations).toBe(20)
      expect(new Fire({ fireTex: mockTexture, iterations: 30 }).iterations).toBe(30)
    })

    it('updates defines and flags the material for recompile on change', () => {
      const fire = new Fire({ fireTex: mockTexture })
      const version = fire.material.version

      fire.iterations = 42

      expect(fire.iterations).toBe(42)
      expect(fire.material.defines?.ITERATIONS).toBe('42')
      expect(fire.material.version).toBeGreaterThan(version)
    })

    it('does not touch defines or needsUpdate when the value is unchanged', () => {
      const fire = new Fire({ fireTex: mockTexture, iterations: 25 })
      const version = fire.material.version

      fire.iterations = 25

      expect(fire.material.defines?.ITERATIONS).toBe('25')
      expect(fire.material.version).toBe(version)
    })
  })

  describe('octaves property', () => {
    it('gets the initial octaves', () => {
      expect(new Fire({ fireTex: mockTexture }).octaves).toBe(3)
      expect(new Fire({ fireTex: mockTexture, octaves: 5 }).octaves).toBe(5)
    })

    it('updates defines and flags the material for recompile on change', () => {
      const fire = new Fire({ fireTex: mockTexture })
      const version = fire.material.version

      fire.octaves = 7

      expect(fire.octaves).toBe(7)
      expect(fire.material.defines?.OCTAVES).toBe('7')
      expect(fire.material.version).toBeGreaterThan(version)
    })

    it('does not touch defines or needsUpdate when the value is unchanged', () => {
      const fire = new Fire({ fireTex: mockTexture, octaves: 4 })
      const version = fire.material.version

      fire.octaves = 4

      expect(fire.material.defines?.OCTAVES).toBe('4')
      expect(fire.material.version).toBe(version)
    })
  })

  describe('shader uniforms', () => {
    it('initializes all required uniforms', () => {
      const fire = new Fire({ fireTex: mockTexture })
      const uniforms = fire.material.uniforms

      expect(uniforms.fireTex).toBeDefined()
      expect(uniforms.color).toBeDefined()
      expect(uniforms.time).toBeDefined()
      expect(uniforms.seed).toBeDefined()
      expect(uniforms.invModelMatrix).toBeDefined()
      expect(uniforms.scale).toBeDefined()
      expect(uniforms.noiseScale).toBeDefined()
      expect(uniforms.magnitude).toBeDefined()
      expect(uniforms.lacunarity).toBeDefined()
      expect(uniforms.gain).toBeDefined()
    })

    it('has correct uniform types', () => {
      const fire = new Fire({ fireTex: mockTexture })
      const uniforms = fire.material.uniforms

      expect(uniforms.fireTex.value).toBe(mockTexture)
      expect(uniforms.color.value).toBeInstanceOf(Color)
      expect(uniforms.time.value).toBeTypeOf('number')
      expect(uniforms.seed.value).toBeTypeOf('number')
      expect(uniforms.invModelMatrix.value).toBeDefined()
      expect(uniforms.scale.value).toBeDefined()
      expect(uniforms.noiseScale.value).toBeDefined()
      expect(uniforms.magnitude.value).toBeTypeOf('number')
      expect(uniforms.lacunarity.value).toBeTypeOf('number')
      expect(uniforms.gain.value).toBeTypeOf('number')
    })
  })
})

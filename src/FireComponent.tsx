import type React from 'react'
import { useRef, useMemo, useState, useLayoutEffect, forwardRef, type RefObject } from 'react'
import { extend, useLoader } from '@react-three/fiber'
import { Fire as FireMesh, type FireProps as FireMeshProps } from './Fire'
import { Color, TextureLoader, type Texture } from 'three'
import { useFireBindings } from './internal/useFireBindings'

declare module '@react-three/fiber' {
  interface ThreeElements {
    fire: Omit<ThreeElements['mesh'], 'args'> & { args?: [FireMeshProps] }
  }
}

let extended = false
function ensureExtended() {
  if (!extended) {
    extend({ Fire: FireMesh })
    extended = true
  }
}

const DEFAULT_NOISE_SCALE: [number, number, number, number] = [1, 2, 1, 0.3]

/**
 * Props for the Fire React component
 */
export interface FireProps extends Omit<FireMeshProps, 'fireTex'> {
  /** Fire texture URL or Three.js Texture object */
  texture: string | Texture
  /** Auto-update time from useFrame (default: true) */
  autoUpdate?: boolean
  /** Custom update function called each frame */
  onUpdate?: (fire: FireMesh, time: number) => void
  /** Child components */
  children?: React.ReactNode
  /** Position in 3D space */
  position?: [number, number, number]
  /** Rotation in radians */
  rotation?: [number, number, number]
  /** Scale factor (uniform or per-axis) */
  scale?: [number, number, number] | number
}

/**
 * Ref interface for imperative fire control
 */
export interface FireRef {
  /** Fire mesh instance */
  fire: FireMesh | null
  /** Update fire animation manually */
  update: (time?: number) => void
}

type LeafProps = {
  meshProps: Omit<FireMeshProps, 'fireTex'>
  fireRef: RefObject<FireMesh | null>
  forwarded: Record<string, unknown>
  children?: React.ReactNode
}

/**
 * Syncs fire props onto the already-mounted Fire instance.
 *
 * Runs in a layout effect, so updates are applied after React commits but
 * before the next frame is drawn — the user never sees a frame rendered with
 * stale parameters. The effect only re-runs when one of the synced values
 * actually changes, and the Fire setters themselves are no-ops for unchanged
 * values (no shader recompile, no texture reconfiguration, no disposal).
 */
export function useFirePropSync(
  fireRef: RefObject<FireMesh | null>,
  texture: Texture,
  meshProps: Omit<FireMeshProps, 'fireTex'>,
): void {
  const { iterations = 20, octaves = 3, magnitude = 1.3, lacunarity = 2.0, gain = 0.5 } = meshProps
  useLayoutEffect(() => {
    const fire = fireRef.current
    if (!fire) return
    fire.fireTex = texture
    fire.iterations = iterations
    fire.octaves = octaves
    fire.magnitude = magnitude
    fire.lacunarity = lacunarity
    fire.gain = gain
  }, [fireRef, texture, iterations, octaves, magnitude, lacunarity, gain])
}

/**
 * Captures the constructor args once. Later prop changes are synced onto the
 * mounted instance via {@link useFirePropSync} instead of rebuilding the mesh
 * through new `args` (which would dispose a material that is still in use).
 */
function useStableArgs(meshProps: Omit<FireMeshProps, 'fireTex'>, texture: Texture) {
  return useState<[FireMeshProps]>(() => [{ ...meshProps, fireTex: texture }])[0]
}

function FireFromUrl({
  url,
  meshProps,
  fireRef,
  forwarded,
  children,
}: LeafProps & { url: string }) {
  const texture = useLoader(TextureLoader, url)
  const args = useStableArgs(meshProps, texture)
  useFirePropSync(fireRef, texture, meshProps)
  return (
    <fire ref={fireRef} args={args} {...forwarded}>
      {children}
    </fire>
  )
}

/**
 * Leaf renderer for a pre-loaded Texture object. No loader hook runs here.
 */
function FireFromTexture({
  texture,
  meshProps,
  fireRef,
  forwarded,
  children,
}: LeafProps & { texture: Texture }) {
  const args = useStableArgs(meshProps, texture)
  useFirePropSync(fireRef, texture, meshProps)
  return (
    <fire ref={fireRef} args={args} {...forwarded}>
      {children}
    </fire>
  )
}

/**
 * React Three Fiber component for volumetric fire effect
 *
 * Creates a procedural fire effect that can be easily integrated into R3F scenes.
 * The component automatically handles texture loading, animation updates, and
 * provides props for all fire parameters.
 *
 * @example
 * ```tsx
 * <Canvas>
 *   <Fire
 *     texture="/fire.png"
 *     color="orange"
 *     magnitude={1.5}
 *     scale={[2, 3, 2]}
 *     position={[0, 0, 0]}
 *   />
 * </Canvas>
 * ```
 *
 * @example With custom animation
 * ```tsx
 * <Fire
 *   texture="/fire.png"
 *   onUpdate={(fire, time) => {
 *     fire.fireColor.setHSL((time * 0.1) % 1, 1, 0.5)
 *   }}
 * />
 * ```
 *
 * @remarks
 * The underlying mesh disposes its geometry and material automatically when the
 * component unmounts (R3F calls `dispose()`). The texture you pass in is **not**
 * disposed — you own its lifecycle.
 *
 * Changing `texture`, `iterations`, `octaves`, `magnitude`, `lacunarity`, or
 * `gain` updates the already-mounted fire in place (synced after render commit,
 * before the next frame) instead of rebuilding the mesh.
 */
export const FireComponent = forwardRef<FireRef, FireProps>(
  (
    {
      texture,
      color = 0xeeeeee,
      iterations = 20,
      octaves = 3,
      noiseScale = DEFAULT_NOISE_SCALE,
      magnitude = 1.3,
      lacunarity = 2.0,
      gain = 0.5,
      autoUpdate = true,
      onUpdate,
      children,
      ...props
    },
    ref,
  ) => {
    ensureExtended()
    const fireRef = useRef<FireMesh>(null)

    // Memoize the constructor props (everything except the texture)
    const meshProps = useMemo(
      () => ({
        color: color instanceof Color ? color : new Color(color),
        iterations,
        octaves,
        noiseScale,
        magnitude,
        lacunarity,
        gain,
      }),
      [color, iterations, octaves, noiseScale, magnitude, lacunarity, gain],
    )

    useFireBindings(ref, fireRef, autoUpdate, onUpdate)

    return typeof texture === 'string' ? (
      <FireFromUrl url={texture} meshProps={meshProps} fireRef={fireRef} forwarded={props}>
        {children}
      </FireFromUrl>
    ) : (
      <FireFromTexture texture={texture} meshProps={meshProps} fireRef={fireRef} forwarded={props}>
        {children}
      </FireFromTexture>
    )
  },
)

FireComponent.displayName = 'Fire'

/**
 * Hook for easier access to fire instance and controls
 *
 * Provides a ref and helper methods for controlling fire imperatively.
 *
 * @returns Object with ref, fire instance, and update method
 *
 * @example
 * ```tsx
 * function MyComponent() {
 *   const fireRef = useFire()
 *
 *   const handleClick = () => {
 *     if (fireRef.fire) {
 *       fireRef.fire.magnitude = 2.0
 *     }
 *   }
 *
 *   return (
 *     <Fire ref={fireRef.ref} texture="/fire.png" />
 *   )
 * }
 * ```
 */
export const useFire = () => {
  const ref = useRef<FireRef>(null)
  return {
    /** Ref to pass to Fire component */
    ref,
    /** Fire mesh instance (null until mounted) — read fresh on every access */
    get fire() {
      return ref.current?.fire ?? null
    },
    /** Update fire animation manually */
    update: (time?: number) => ref.current?.update(time),
  }
}

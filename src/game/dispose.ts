import * as THREE from 'three';

// GPU resource ownership.
//
// Model files are loaded once and cached for the lifetime of the page (see
// assets.ts), so their geometries, materials and textures are shared by every
// city scene: the start-screen preview, a run, and each retry. A city is torn
// down before the next one is built, so a teardown that blindly walks the
// scene graph and disposes everything it finds frees GPU buffers the next scene
// still references — models blink out, materials come back black, and the
// renderer has to re-upload and recompile them on the first frame.
//
// Shared resources are tagged with `userData.noDispose`. `disposeObject3D()`
// releases only what the scene itself created and leaves anything coming from
// the shared model cache untouched.

export const NO_DISPOSE = 'noDispose';
export const DISPOSE_WITH_SCENE = 'disposeWithScene';

interface Markable {
  userData: Record<string, any>;
}

/** True when a resource belongs to the shared model cache. */
export function isShared(resource: Markable | null | undefined): boolean {
  return !!(resource && resource.userData && resource.userData[NO_DISPOSE]);
}

/** Tag a resource as owned by the shared asset cache, not by a scene. */
export function markShared<T extends Markable>(resource: T): T {
  resource.userData[NO_DISPOSE] = true;
  return resource;
}

/** Mark a resource as scene-owned even though it sits on a cached object
 *  (e.g. the golden plane's recoloured material clones). */
export function markOwned<T extends Markable>(resource: T): T {
  delete resource.userData[NO_DISPOSE];
  resource.userData[DISPOSE_WITH_SCENE] = true;
  return resource;
}

function isOwned(resource: Markable | null | undefined): boolean {
  return !!(resource && resource.userData && resource.userData[DISPOSE_WITH_SCENE]);
}

export function eachMeshMaterial(mesh: THREE.Mesh, fn: (material: THREE.Material) => void): void {
  const material = mesh.material as THREE.Material | THREE.Material[] | null | undefined;
  if (!material) return;
  if (Array.isArray(material)) {
    for (const m of material) if (m) fn(m);
  } else {
    fn(material);
  }
}

/** Visit every texture referenced by a material, including shader uniforms. */
export function eachMaterialTexture(material: THREE.Material, fn: (texture: THREE.Texture) => void): void {
  for (const value of Object.values(material as unknown as Record<string, unknown>)) {
    const tex = value as THREE.Texture | null;
    if (tex && tex.isTexture) fn(tex);
  }
  const uniforms = (material as THREE.ShaderMaterial).uniforms;
  if (uniforms) {
    for (const uniform of Object.values(uniforms)) {
      const value = (uniform as { value?: unknown } | undefined)?.value as THREE.Texture | null | undefined;
      if (value && value.isTexture) fn(value);
    }
  }
}

/** Tag a whole cached model: its nodes, geometries, materials and textures. */
export function markSharedAsset(root: THREE.Object3D): void {
  root.traverse((obj) => {
    markShared(obj);
    const mesh = obj as THREE.Mesh;
    if (!mesh.isMesh) return;
    if (mesh.geometry) markShared(mesh.geometry);
    eachMeshMaterial(mesh, (material) => {
      markShared(material);
      eachMaterialTexture(material, markShared);
    });
  });
}

/**
 * Release everything a scene owns: geometries, materials, the textures those
 * materials reference, per-instance buffers and light shadow maps.
 *
 * Objects under a `userData.noDispose` node — meshes instanced from a cached
 * model, their shared geometries/materials/textures — are left alone. Only
 * resources explicitly marked `disposeWithScene` inside such a subtree (the
 * golden plane's material clones) are released. Sprite geometry is skipped
 * because three.js shares one unit quad across every Sprite in the process.
 *
 * Disposal is deduplicated, so materials shared within one scene (curbs,
 * hills, banners, …) are released exactly once, and calling this twice is
 * harmless.
 */
export function disposeObject3D(root: THREE.Object3D): void {
  const geometries = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>();
  const textures = new Set<THREE.Texture>();
  const instanced: THREE.InstancedMesh[] = [];
  const lights: THREE.Light[] = [];

  const collectTextures = (material: THREE.Material) => {
    eachMaterialTexture(material, (texture) => {
      if (!isShared(texture)) textures.add(texture);
    });
  };

  const walk = (obj: THREE.Object3D, sharedTree: boolean) => {
    const shared = sharedTree || isShared(obj);

    const maybeInstanced = obj as THREE.InstancedMesh;
    if (maybeInstanced.isInstancedMesh) instanced.push(maybeInstanced);
    const maybeLight = obj as THREE.Light;
    if (maybeLight.isLight) lights.push(maybeLight);

    // Meshes, sprites, lines and points all carry geometry/material.
    const renderable = obj as THREE.Mesh;
    if (renderable.geometry || renderable.material) {
      const isSprite = (obj as unknown as THREE.Sprite).isSprite;
      if (!shared) {
        // Every Sprite shares one internal geometry owned by three.js itself.
        const geometry = renderable.geometry;
        if (geometry && !isSprite && !isShared(geometry)) geometries.add(geometry);
      }
      eachMeshMaterial(renderable, (material) => {
        const owned = isOwned(material);
        if (isShared(material) && !owned) return;
        materials.add(material);
        // Textures belonging to a cached model are left to the cache; only
        // collect textures from resources the scene itself created (including
        // the golden plane's material clones).
        if (!shared || owned) collectTextures(material);
      });
    }

    for (const child of obj.children) walk(child, shared);
  };

  walk(root, false);

  // Background/environment maps are not scene-graph nodes.
  const scene = root as THREE.Scene;
  for (const candidate of [scene.background, scene.environment] as (THREE.Texture | THREE.Color | null | undefined)[]) {
    const tex = candidate as THREE.Texture | null | undefined;
    if (tex && (tex as THREE.Texture).isTexture && !isShared(tex)) textures.add(tex as THREE.Texture);
  }

  // Instance matrices/colors are per-scene buffers even when the geometry and
  // material come from the cache, so those are always released.
  for (const mesh of instanced) mesh.dispose();
  for (const geometry of geometries) geometry.dispose();

  for (const texture of textures) texture.dispose();
  for (const material of materials) material.dispose();

  // Shadow maps are render targets allocated per light by the renderer; they
  // are never released by geometry/material disposal. Only lights that still
  // cast shadows have one (adaptive quality can turn it off).
  for (const light of lights) {
    if (isShared(light)) continue;
    const shadow = (light as THREE.DirectionalLight).shadow;
    if (shadow && typeof shadow.dispose === 'function') shadow.dispose();
  }

  root.clear();
}

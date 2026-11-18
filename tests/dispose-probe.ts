// Browser probe: exercises the real city lifecycle in a WebGL context and
// reports whether shared model resources survive preview -> run -> menu -> run
// cycles while scene-owned resources are still released.
//
// Run via vite (`npm run dev:web`) at /dispose-probe.html.
import * as THREE from 'three';
import { buildWorld } from '../src/game/world';
import { loadAssets, type GameAssets } from '../src/game/assets';
import { createPlane } from '../src/game/plane';
import { Explosion } from '../src/game/explosion';
import type { ContributionDay } from '../src/game/types';

interface Check {
  name: string;
  ok: boolean;
  detail: string;
}
const checks: Check[] = [];
const check = (name: string, ok: boolean, detail = '') => {
  checks.push({ name, ok, detail });
  const line = `${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`;
  console.log(line);
  const el = document.createElement('pre');
  el.textContent = line;
  el.style.color = ok ? '#1a7f37' : '#cf222e';
  el.style.margin = '0';
  el.style.font = '12px monospace';
  document.body.appendChild(el);
};

// ---- disposal instrumentation (records which GPU handles really got freed) ----
const disposedGeos = new Map<string, number>();
const disposedMats = new Map<string, number>();
const disposedTexs = new Map<string, number>();
const disposedInstances = new Map<string, number>();
const origGeoDispose = THREE.BufferGeometry.prototype.dispose;
const origMatDispose = THREE.Material.prototype.dispose;
const origTexDispose = THREE.Texture.prototype.dispose;
const origInstDispose = THREE.InstancedMesh.prototype.dispose;
THREE.BufferGeometry.prototype.dispose = function (this: THREE.BufferGeometry) {
  disposedGeos.set(this.uuid, (disposedGeos.get(this.uuid) ?? 0) + 1);
  return origGeoDispose.call(this);
};
THREE.Material.prototype.dispose = function (this: THREE.Material) {
  disposedMats.set(this.uuid, (disposedMats.get(this.uuid) ?? 0) + 1);
  return origMatDispose.call(this);
};
THREE.Texture.prototype.dispose = function (this: THREE.Texture) {
  disposedTexs.set(this.uuid, (disposedTexs.get(this.uuid) ?? 0) + 1);
  return origTexDispose.call(this);
};
THREE.InstancedMesh.prototype.dispose = function (this: THREE.InstancedMesh) {
  disposedInstances.set(this.uuid, (disposedInstances.get(this.uuid) ?? 0) + 1);
  return origInstDispose.call(this) as any;
};

// Contribution data shaped like a real year: zero-commit rest days, quiet days,
// busy days and a few spikes, all seven weekdays covered.
function makeDays(kind: 'amber' | 'coral'): ContributionDay[] {
  const days: ContributionDay[] = [];
  const start = Date.UTC(2025, 10, 18);
  for (let i = 0; i < 365; i++) {
    const d = new Date(start + i * 86400000);
    const weekday = d.getUTCDay();
    let count = 0;
    if (kind === 'amber') {
      const h = Math.abs(Math.sin(i * 12.9898) * 43758.5453) % 1;
      if (h > 0.45) count = Math.floor(h * 8);
      if (h > 0.97) count += 24;
    } else {
      const h = Math.abs(Math.sin(i * 78.233 + 3.1) * 96321.11) % 1;
      if (h > 0.12) count = Math.floor(h * 22) + 1;
      if (i % 31 === 0) count = 55;
    }
    days.push({ date: d.toISOString().slice(0, 10), count, weekday });
  }
  return days;
}

interface SceneResources {
  geos: Set<string>;
  mats: Set<string>;
  texs: Set<string>;
  instanced: THREE.InstancedMesh[];
  cachedMeshes: number;
}

function sceneResources(scene: THREE.Scene): SceneResources {
  const geos = new Set<string>();
  const mats = new Set<string>();
  const texs = new Set<string>();
  const instanced: THREE.InstancedMesh[] = [];
  let cachedMeshes = 0;
  scene.traverse((obj) => {
    const inst = obj as THREE.InstancedMesh;
    if (inst.isInstancedMesh) instanced.push(inst);
    const renderable = obj as THREE.Mesh;
    if (!renderable.geometry && !renderable.material) return;
    if (!(obj as unknown as THREE.Sprite).isSprite && renderable.geometry) geos.add(renderable.geometry.uuid);
    const material = renderable.material as THREE.Material | THREE.Material[] | undefined;
    if (material) {
      for (const m of Array.isArray(material) ? material : [material]) {
        if (!m) continue;
        mats.add(m.uuid);
        for (const v of Object.values(m as unknown as Record<string, unknown>)) {
          const t = v as THREE.Texture;
          if (t && t.isTexture) texs.add(t.uuid);
        }
      }
    }
    if (obj.userData?.noDispose || (renderable.material && !Array.isArray(renderable.material) && (renderable.material as THREE.Material).userData?.noDispose)) {
      cachedMeshes++;
    }
  });
  return { geos, mats, texs, instanced, cachedMeshes };
}

interface SharedResources {
  geos: Set<string>;
  mats: Set<string>;
  texs: Set<string>;
}
function collectAssetResources(assets: GameAssets): SharedResources {
  const geos = new Set<string>();
  const mats = new Set<string>();
  const texs = new Set<string>();
  const roots: THREE.Object3D[] = [];
  if (assets.plane) roots.push(assets.plane);
  roots.push(...assets.cityBuildings, ...assets.trees);
  if (assets.bush) roots.push(assets.bush);
  if (assets.acUnit) roots.push(assets.acUnit);
  for (const root of roots) {
    root.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (!mesh.isMesh) return;
      if (mesh.geometry) geos.add(mesh.geometry.uuid);
      const material = mesh.material as THREE.Material | THREE.Material[];
      for (const m of Array.isArray(material) ? material : [material]) {
        if (!m) continue;
        mats.add(m.uuid);
        for (const v of Object.values(m as unknown as Record<string, unknown>)) {
          const t = v as THREE.Texture;
          if (t && t.isTexture) texs.add(t.uuid);
        }
      }
    });
  }
  return { geos, mats, texs };
}

const countDisposed = (ids: Set<string>, log: Map<string, number>) =>
  [...ids].filter((id) => (log.get(id) ?? 0) > 0).length;

/** Textures bound to SpriteMaterials (cloud billboards, explosion puffs). */
function spriteMapIds(root: THREE.Object3D): Set<string> {
  const ids = new Set<string>();
  root.traverse((obj) => {
    const sprite = obj as THREE.Sprite;
    if (!sprite.isSprite) return;
    const map = (sprite.material as THREE.SpriteMaterial | undefined)?.map;
    if (map) ids.add(map.uuid);
  });
  return ids;
}

async function main() {
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setSize(640, 360);
  renderer.shadowMap.enabled = true;
  document.body.appendChild(renderer.domElement);

  // three.js gives every Sprite one process-wide geometry; it must never be
  // disposed by a city teardown.
  const spriteGeoSample = new THREE.Sprite().geometry.uuid;

  const assets = await loadAssets();
  const shared = collectAssetResources(assets);
  check(
    'assets loaded and tagged noDispose',
    !!assets.plane && assets.cityBuildings.length === 3 && assets.trees.length === 3 && !!assets.bush && !!assets.acUnit,
    `plane=${!!assets.plane} buildings=${assets.cityBuildings.length} trees=${assets.trees.length}`
  );
  check('cached model resources discovered', shared.geos.size > 0 && shared.mats.size > 0, `${shared.geos.size} geos, ${shared.mats.size} mats, ${shared.texs.size} texs`);

  const amber = makeDays('amber');
  const coral = makeDays('coral');
  check(
    'fixture has zero-commit and high-commit days',
    amber.some((d) => d.count === 0) && amber.some((d) => d.count >= 10) && coral.some((d) => d.count === 0) && coral.some((d) => d.count >= 10)
  );

  const camera = new THREE.PerspectiveCamera(60, 640 / 360, 0.1, 1200);
  camera.position.set(40, 38, -40);
  camera.lookAt(0, 8, -40);

  // ---- 1. start-screen preview for user A ----
  const previewA = buildWorld(amber, assets);
  // Two cities live side by side only here: sprite maps present in both are the
  // page-wide bakes (cloud variants); the sun disc's glow is per-scene.
  const twin = buildWorld(coral, assets);
  const cloudTextureIds = new Set([...spriteMapIds(previewA.scene)].filter((id) => spriteMapIds(twin.scene).has(id)));
  twin.dispose();
  const puffTextureIds = spriteMapIds(new Explosion().group);
  check('preview cloud textures discovered', cloudTextureIds.size > 0, `${cloudTextureIds.size} textures`);
  const preA = sceneResources(previewA.scene);
  renderer.render(previewA.scene, camera);
  check('preview A renders cached models', preA.cachedMeshes > 0, `${preA.cachedMeshes} cached-model meshes`);
  check('preview A instances trees/buildings/AC', preA.instanced.length > 0, `${preA.instanced.length} instanced meshes`);
  const preASharedGeos = countDisposed(shared.geos, disposedGeos);
  check('no cached geometry disposed during preview A', preASharedGeos === 0, `${preASharedGeos} disposed`);

  // ---- 2. switch preview to user B: old preview destroyed, new city built ----
  previewA.dispose();
  const previewB = buildWorld(coral, assets);
  const preB = sceneResources(previewB.scene);
  renderer.render(previewB.scene, camera);
  const disposedSharedGeos = countDisposed(shared.geos, disposedGeos);
  const disposedSharedMats = countDisposed(shared.mats, disposedMats);
  const disposedSharedTexs = countDisposed(shared.texs, disposedTexs);
  check('preview switch keeps every cached geometry', disposedSharedGeos === 0, `${disposedSharedGeos}/${shared.geos.size} disposed`);
  check('preview switch keeps every cached material', disposedSharedMats === 0, `${disposedSharedMats}/${shared.mats.size} disposed`);
  check('preview switch keeps every cached texture', disposedSharedTexs === 0, `${disposedSharedTexs}/${shared.texs.size} disposed`);
  const reuseGeo = [...shared.geos].filter((id) => preB.geos.has(id)).length;
  const reuseMat = [...shared.mats].filter((id) => preB.mats.has(id)).length;
  check('preview B reuses cached geometries (no reload)', reuseGeo > 0, `${reuseGeo}/${shared.geos.size} in scene`);
  check('preview B reuses cached materials', reuseMat > 0, `${reuseMat}/${shared.mats.size} in scene`);
  const previewOwnedGeos = new Set([...preA.geos].filter((id) => !shared.geos.has(id)));
  check(
    'preview A ground/tower/sky geometry disposed',
    countDisposed(previewOwnedGeos, disposedGeos) === previewOwnedGeos.size,
    `${countDisposed(previewOwnedGeos, disposedGeos)}/${previewOwnedGeos.size}`
  );

  // ---- 3. take off: preview destroyed, run world built ----
  previewB.dispose();
  const runA = buildWorld(amber, assets);
  const planeA = createPlane(640 / 360, assets, false);
  runA.scene.add(planeA.camera);
  const explosionA = new Explosion();
  runA.scene.add(explosionA.group);
  renderer.render(runA.scene, planeA.camera);
  const runAres = sceneResources(runA.scene);
  check('run A renders cached models', runAres.cachedMeshes > 0, `${runAres.cachedMeshes} meshes`);
  check(
    'nothing cached disposed on take-off',
    countDisposed(shared.geos, disposedGeos) === 0 && countDisposed(shared.mats, disposedMats) === 0 && countDisposed(shared.texs, disposedTexs) === 0,
    `geos=${countDisposed(shared.geos, disposedGeos)} mats=${countDisposed(shared.mats, disposedMats)} texs=${countDisposed(shared.texs, disposedTexs)}`
  );

  // ---- 4. back to menu, then retry same user ----
  explosionA.dispose();
  planeA.dispose();
  runA.dispose();
  const menuB = buildWorld(coral, assets);
  renderer.render(menuB.scene, camera);
  menuB.dispose();
  const runA2 = buildWorld(amber, assets);
  const planeA2 = createPlane(640 / 360, assets, true); // golden plane path
  runA2.scene.add(planeA2.camera);
  const explosionA2 = new Explosion();
  runA2.scene.add(explosionA2.group);
  renderer.render(runA2.scene, planeA2.camera);
  const runA2res = sceneResources(runA2.scene);
  check(
    'menu -> retry keeps cached geometries',
    countDisposed(shared.geos, disposedGeos) === 0,
    `${countDisposed(shared.geos, disposedGeos)}/${shared.geos.size} disposed`
  );
  check(
    'menu -> retry keeps cached materials',
    countDisposed(shared.mats, disposedMats) === 0,
    `${countDisposed(shared.mats, disposedMats)}/${shared.mats.size} disposed`
  );
  check(
    'retry reuses cached geometries in the new scene',
    [...shared.geos].filter((id) => runA2res.geos.has(id)).length > 0,
    `${[...shared.geos].filter((id) => runA2res.geos.has(id)).length}/${shared.geos.size}`
  );

  // ---- 5. repeated preview/run cycles stay stable ----
  let cycleFailures = 0;
  let active = { world: runA2, plane: planeA2, explosion: explosionA2 };
  for (let i = 0; i < 5; i++) {
    active.explosion.dispose();
    active.plane.dispose();
    active.world.dispose();
    const days = i % 2 === 0 ? coral : amber;
    const w = buildWorld(days, assets);
    const p = createPlane(640 / 360, assets, i % 2 === 0);
    w.scene.add(p.camera);
    const e = new Explosion();
    w.scene.add(e.group);
    renderer.render(w.scene, p.camera);
    const counts = sceneResources(w.scene);
    const geosPresent = [...shared.geos].filter((id) => counts.geos.has(id)).length;
    const matsPresent = [...shared.mats].filter((id) => counts.mats.has(id)).length;
    if (geosPresent === 0 || matsPresent === 0) {
      cycleFailures++;
      check(`cycle ${i} still shows cached models`, false, `geos=${geosPresent} mats=${matsPresent}`);
    }
    active = { world: w, plane: p, explosion: e };
  }
  active.explosion.dispose();
  active.plane.dispose();
  active.world.dispose();
  check('5 preview/run cycles keep cached models visible', cycleFailures === 0, `${5 - cycleFailures}/5`);
  check(
    'no cached resource ever disposed across all cycles',
    countDisposed(shared.geos, disposedGeos) === 0 && countDisposed(shared.mats, disposedMats) === 0 && countDisposed(shared.texs, disposedTexs) === 0,
    `geos=${countDisposed(shared.geos, disposedGeos)} mats=${countDisposed(shared.mats, disposedMats)} texs=${countDisposed(shared.texs, disposedTexs)}`
  );
  // cloud billboards + explosion puffs share their bakes across the page
  check('process-wide Sprite geometry never disposed', (disposedGeos.get(spriteGeoSample) ?? 0) === 0, `${disposedGeos.get(spriteGeoSample) ?? 0} disposals`);
  const cloudTexDisposed = [...cloudTextureIds].filter((id) => disposedTexs.has(id)).length;
  check('cached cloud textures survive every cycle', cloudTexDisposed === 0, `${cloudTexDisposed}/${cloudTextureIds.size} disposed`);
  const puffTexDisposed = [...puffTextureIds].filter((id) => disposedTexs.has(id)).length;
  check('cached explosion puff textures survive every cycle', puffTexDisposed === 0, `${puffTexDisposed}/${puffTextureIds.size} disposed`);

  // ---- 6. scene-owned resources really are released ----
  const ownedWorld = buildWorld(amber, assets);
  // A second concurrently-live world reveals textures baked once per page and
  // reused by every city (the cloud sprites); those are intentionally kept.
  const siblingWorld = buildWorld(coral, assets);
  const owned = sceneResources(ownedWorld.scene);
  const sibling = sceneResources(siblingWorld.scene);
  siblingWorld.dispose();
  const ownedGeos = new Set([...owned.geos].filter((id) => !shared.geos.has(id)));
  const ownedMats = new Set([...owned.mats].filter((id) => !shared.mats.has(id)));
  const ownedTexs = new Set([...owned.texs].filter((id) => !shared.texs.has(id)));
  const crossWorldTexs = new Set([...ownedTexs].filter((id) => sibling.texs.has(id)));
  const sceneOnlyTexs = new Set([...ownedTexs].filter((id) => !crossWorldTexs.has(id)));
  check('scene creates its own geometry (merged towers/ground/sky)', ownedGeos.size > 0, `${ownedGeos.size} geos`);
  check('scene creates its own materials', ownedMats.size > 0, `${ownedMats.size} mats`);
  check('scene creates its own textures', sceneOnlyTexs.size > 0, `${sceneOnlyTexs.size} scene-only texs, ${crossWorldTexs.size} page-shared cloud texs`);
  const instancedBefore = owned.instanced.length;
  ownedWorld.dispose();
  check(
    'scene-owned geometries disposed',
    countDisposed(ownedGeos, disposedGeos) === ownedGeos.size,
    `${countDisposed(ownedGeos, disposedGeos)}/${ownedGeos.size}`
  );
  check(
    'scene-owned materials disposed',
    countDisposed(ownedMats, disposedMats) === ownedMats.size,
    `${countDisposed(ownedMats, disposedMats)}/${ownedMats.size}`
  );
  check(
    'scene-owned textures disposed (facade, road, grass, sky, sun)',
    countDisposed(sceneOnlyTexs, disposedTexs) === sceneOnlyTexs.size,
    `${countDisposed(sceneOnlyTexs, disposedTexs)}/${sceneOnlyTexs.size}`
  );
  check(
    'page-shared cloud textures survive a city teardown',
    countDisposed(crossWorldTexs, disposedTexs) === 0,
    `${countDisposed(crossWorldTexs, disposedTexs)}/${crossWorldTexs.size} disposed`
  );
  check('scene instanced meshes existed', instancedBefore > 0, `${instancedBefore}`);

  // cached-model instanced meshes must still release their per-instance buffers
  const cachedInstanced = owned.instanced.filter((m) => m.userData?.noDispose).map((m) => m.uuid);
  const cachedInstancedDisposed = cachedInstanced.filter((id) => (disposedInstances.get(id) ?? 0) > 0).length;
  check(
    'cached-model instanced meshes release their own instance buffers',
    cachedInstanced.length > 0 && cachedInstancedDisposed === cachedInstanced.length,
    `${cachedInstancedDisposed}/${cachedInstanced.length}`
  );

  // ---- 6b. the golden plane's cloned materials are scene-owned ----
  const goldenPlane = createPlane(640 / 360, assets, true);
  const goldenMats: string[] = [];
  const goldenGeos: string[] = [];
  goldenPlane.cockpit.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (!mesh.isMesh) return;
    if (mesh.geometry) goldenGeos.push(mesh.geometry.uuid);
    const material = mesh.material as THREE.Material | THREE.Material[];
    for (const m of Array.isArray(material) ? material : [material]) if (m) goldenMats.push(m.uuid);
  });
  const goldCloneMats = goldenMats.filter((id) => !shared.mats.has(id));
  goldenPlane.dispose();
  const goldCloneDisposed = goldCloneMats.filter((id) => (disposedMats.get(id) ?? 0) > 0).length;
  check(
    'golden-plane material clones are disposed',
    goldCloneMats.length > 0 && goldCloneDisposed === goldCloneMats.length,
    `${goldCloneDisposed}/${goldCloneMats.length} clones`
  );
  check(
    'golden-plane model resources (shared) survive',
    goldenMats.filter((id) => shared.mats.has(id)).every((id) => (disposedMats.get(id) ?? 0) === 0) &&
      goldenGeos.filter((id) => shared.geos.has(id)).every((id) => (disposedGeos.get(id) ?? 0) === 0),
    `${goldenMats.filter((id) => shared.mats.has(id)).length} inherited mats kept`
  );

  // ---- 7. dispose twice is harmless ----
  const twice = buildWorld(coral, assets);
  twice.dispose();
  let threw = false;
  try {
    twice.dispose();
  } catch {
    threw = true;
  }
  check('second dispose() is harmless', !threw);

  // ---- 8. a final render still shows cached models after everything ----
  const finalWorld = buildWorld(coral, assets);
  renderer.render(finalWorld.scene, camera);
  const finalRes = sceneResources(finalWorld.scene);
  check(
    'final city still renders cached models',
    [...shared.geos].filter((id) => finalRes.geos.has(id)).length > 0 &&
      [...shared.mats].filter((id) => finalRes.mats.has(id)).length > 0,
    `geos=${[...shared.geos].filter((id) => finalRes.geos.has(id)).length} mats=${[...shared.mats].filter((id) => finalRes.mats.has(id)).length}`
  );
  finalWorld.dispose();

  // ---- 9. renderer memory stays flat across many city rebuilds ----
  // This is the end-to-end leak check: scene-owned buffers must be released,
  // while the cached models are uploaded once and reused.
  let stableWorld = buildWorld(amber, assets);
  renderer.render(stableWorld.scene, camera);
  const baselineMemory = { ...renderer.info.memory };
  const baselinePrograms = renderer.info.programs?.length ?? 0;
  for (let i = 0; i < 12; i++) {
    stableWorld.dispose();
    stableWorld = buildWorld(i % 2 === 0 ? coral : amber, assets);
    renderer.render(stableWorld.scene, camera);
  }
  const endMemory = { ...renderer.info.memory };
  check(
    'renderer geometry count stays bounded over 12 rebuilds',
    endMemory.geometries <= baselineMemory.geometries + 10,
    `${baselineMemory.geometries} -> ${endMemory.geometries}`
  );
  check(
    'renderer texture count stays bounded over 12 rebuilds',
    endMemory.textures <= baselineMemory.textures + 10,
    `${baselineMemory.textures} -> ${endMemory.textures}`
  );
  const endPrograms = renderer.info.programs?.length ?? 0;
  check(
    'shader programs do not recompile per city',
    endPrograms <= baselinePrograms + 4,
    `${baselinePrograms} -> ${endPrograms}`
  );

  const ok = checks.every((c) => c.ok);
  (window as any).__probeResult = { ok, checks };
  const summary = document.createElement('h3');
  summary.textContent = ok ? 'ALL CHECKS PASSED' : 'SOME CHECKS FAILED';
  summary.style.color = ok ? '#1a7f37' : '#cf222e';
  document.body.prepend(summary);
}

main().catch((err) => {
  console.error(err);
  (window as any).__probeResult = { ok: false, error: String(err && (err as Error).stack ? (err as Error).stack : err) };
});

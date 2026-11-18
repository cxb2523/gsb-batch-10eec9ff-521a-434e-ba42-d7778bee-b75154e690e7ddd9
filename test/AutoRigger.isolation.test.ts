import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as THREE from 'three';
import { AutoRigger } from '../src/core/AutoRigger';
import { JointType } from '../src/types';
import { detectJointsProcedural, computeRigIntoBuffers } from '../src/worker/rigCompute';

const JOINT_COUNT = Object.values(JointType).length;

/**
 * FakeWorker speaks the real worker's message protocol and runs the real
 * (procedural) rigging computation, so tests exercise genuine bone positions
 * and skin weights for both SAB and TRANSFERABLE modes.
 */
class FakeWorker {
  onmessage: ((e: any) => void) | null = null;
  onerror: ((e: any) => void) | null = null;

  static lastInstance: FakeWorker | null = null;

  /** Test knobs */
  rigDelay: (msgId: number, vertexCount: number) => number = () => 1;
  shouldFailRig: (msgId: number, vertexCount: number) => boolean = () => false;
  sentMessages: { type: string; payload: any; msgId: number }[] = [];

  constructor(_url: any, _opts?: any) {
    FakeWorker.lastInstance = this;
  }

  postMessage(data: any, _transfers?: any) {
    this.sentMessages.push(data);
    const { type, payload, msgId } = data;

    if (type === 'INIT') {
      setTimeout(() => this.onmessage?.({ data: { type: 'INIT_DONE', msgId } }), 0);
      return;
    }

    if (type === 'RIG') {
      const { mode, posBuffer, indicesBuffer, weightsBuffer, falloff } = payload;
      const positions = new Float32Array(posBuffer);
      const vertexCount = positions.length / 3;
      const delay = this.rigDelay(msgId, vertexCount);

      setTimeout(() => {
        if (this.shouldFailRig(msgId, vertexCount)) {
          this.onmessage?.({ data: { type: 'ERROR', payload: 'Simulated worker failure', msgId } });
          return;
        }
        const skinIndices = new Uint16Array(indicesBuffer);
        const skinWeights = new Float32Array(weightsBuffer);
        const rig = detectJointsProcedural(positions);
        computeRigIntoBuffers(positions, rig, falloff, skinIndices, skinWeights);

        if (mode === 'TRANSFERABLE') {
          this.onmessage?.({
            data: { type: 'RIG_DONE', payload: { rig, indicesBuffer, weightsBuffer }, msgId }
          });
        } else {
          this.onmessage?.({ data: { type: 'RIG_DONE', payload: { rig }, msgId } });
        }
      }, delay);
    }
  }

  terminate() {}
}

/** Deterministic humanoid-box mesh: x ∈ [cx±0.2h], y ∈ [0,h], z ∈ [±0.05h]. */
function makeCharacterMesh(centerX: number, height: number, vertexCount = 48): THREE.Mesh {
  const positions = new Float32Array(vertexCount * 3);
  for (let i = 0; i < vertexCount; i++) {
    const t = vertexCount === 1 ? 0 : i / (vertexCount - 1);
    const u = ((i * 37) % 13) / 12; // spans [0, 1]
    positions[i * 3 + 0] = centerX + (u - 0.5) * 0.4 * height;
    positions[i * 3 + 1] = t * height;
    positions[i * 3 + 2] = (u - 0.5) * 0.1 * height;
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  return new THREE.Mesh(geometry, new THREE.MeshBasicMaterial());
}

function hipsWorldX(skinnedMesh: THREE.SkinnedMesh): number {
  const hips = skinnedMesh.skeleton.bones.find(b => b.name === JointType.Hips)!;
  return hips.position.x;
}

function skinWeightAttr(skinnedMesh: THREE.SkinnedMesh): Float32Array {
  return skinnedMesh.geometry.getAttribute('skinWeight').array as Float32Array;
}

function skinIndexAttr(skinnedMesh: THREE.SkinnedMesh): Uint16Array {
  return skinnedMesh.geometry.getAttribute('skinIndex').array as Uint16Array;
}

function expectNormalizedWeights(skinnedMesh: THREE.SkinnedMesh): void {
  const weights = skinWeightAttr(skinnedMesh);
  const indices = skinIndexAttr(skinnedMesh);
  const vertexCount = weights.length / 4;
  for (let v = 0; v < vertexCount; v++) {
    const sum = weights[v * 4] + weights[v * 4 + 1] + weights[v * 4 + 2] + weights[v * 4 + 3];
    expect(sum).toBeCloseTo(1, 4);
    for (let k = 0; k < 4; k++) {
      expect(indices[v * 4 + k]).toBeLessThan(JOINT_COUNT);
    }
  }
}

describe('AutoRigger state isolation', () => {
  const originalWorker = (globalThis as any).Worker;
  const hadCOI = Object.prototype.hasOwnProperty.call(globalThis, 'crossOriginIsolated');
  const originalCOI = (globalThis as any).crossOriginIsolated;

  beforeEach(() => {
    (globalThis as any).Worker = FakeWorker;
    Object.defineProperty(globalThis, 'crossOriginIsolated', {
      value: false, writable: true, configurable: true
    });
  });

  afterEach(() => {
    (globalThis as any).Worker = originalWorker;
    if (hadCOI) {
      Object.defineProperty(globalThis, 'crossOriginIsolated', {
        value: originalCOI, writable: true, configurable: true
      });
    } else {
      delete (globalThis as any).crossOriginIsolated;
    }
    FakeWorker.lastInstance = null;
  });

  async function makeEngine(): Promise<AutoRigger> {
    const engine = new AutoRigger();
    await engine.init();
    return engine;
  }

  it('sequential rig() calls: second mesh gets only its own bones and weights', async () => {
    const engine = await makeEngine();

    const meshA = makeCharacterMesh(0, 2);
    const meshB = makeCharacterMesh(100, 8);

    const skinnedA = await engine.rig(meshA);
    // Snapshot A's results before the second rig.
    const hipsABefore = hipsWorldX(skinnedA);
    const weightsABefore = Array.from(skinWeightAttr(skinnedA));
    const indicesABefore = Array.from(skinIndexAttr(skinnedA));

    const skinnedB = await engine.rig(meshB);

    // B's skeleton reflects B's bounds, not A's.
    expect(hipsWorldX(skinnedB)).toBeCloseTo(100, 3);
    expect(hipsWorldX(skinnedB)).not.toBeCloseTo(hipsABefore, 1);
    expect(skinnedB.skeleton.bones).toHaveLength(JOINT_COUNT);
    expectNormalizedWeights(skinnedB);

    // A's previously returned SkinnedMesh is untouched by the second rig.
    expect(hipsWorldX(skinnedA)).toBeCloseTo(hipsABefore, 6);
    expect(Array.from(skinWeightAttr(skinnedA))).toEqual(weightsABefore);
    expect(Array.from(skinIndexAttr(skinnedA))).toEqual(indicesABefore);

    // The two results share no backing buffers.
    expect(skinWeightAttr(skinnedA).buffer).not.toBe(skinWeightAttr(skinnedB).buffer);
    expect(skinIndexAttr(skinnedA).buffer).not.toBe(skinIndexAttr(skinnedB).buffer);

    // No pending requests left behind.
    expect((engine as any).pendingRequests.size).toBe(0);
  });

  it('concurrent rig() calls: each promise resolves with its own request result', async () => {
    const engine = await makeEngine();
    const worker = FakeWorker.lastInstance!;

    // First RIG request (msgId 2, after INIT) resolves LAST.
    worker.rigDelay = (msgId) => (msgId === 2 ? 30 : 1);

    const meshA = makeCharacterMesh(0, 2);
    const meshB = makeCharacterMesh(100, 8);

    const [skinnedA, skinnedB] = await Promise.all([engine.rig(meshA), engine.rig(meshB)]);

    // Despite out-of-order completion, results match their own inputs.
    expect(hipsWorldX(skinnedA)).toBeCloseTo(0, 3);
    expect(hipsWorldX(skinnedB)).toBeCloseTo(100, 3);
    expectNormalizedWeights(skinnedA);
    expectNormalizedWeights(skinnedB);
    expect((engine as any).pendingRequests.size).toBe(0);
  });

  it('a failed request rejects its own promise and does not affect later requests', async () => {
    const engine = await makeEngine();
    const worker = FakeWorker.lastInstance!;

    const goodMesh1 = makeCharacterMesh(0, 2);
    const skinned1 = await engine.rig(goodMesh1);

    // Fail exactly one request (the mesh with 13 vertices).
    worker.shouldFailRig = (_msgId, vertexCount) => vertexCount === 13;
    const badMesh = makeCharacterMesh(50, 4, 13);

    await expect(engine.rig(badMesh)).rejects.toThrow('Simulated worker failure');

    // The failure left no stale pending request behind.
    expect((engine as any).pendingRequests.size).toBe(0);

    // Subsequent requests still work and produce correct results.
    worker.shouldFailRig = () => false;
    const goodMesh2 = makeCharacterMesh(100, 8);
    const skinned2 = await engine.rig(goodMesh2);
    expect(hipsWorldX(skinned2)).toBeCloseTo(100, 3);
    expectNormalizedWeights(skinned2);

    // The failed request never replaced the active skeleton in between:
    // after the failure, animate() still drove the first successful rig.
    expect((engine as any).activeSkeleton).toBe(skinned2.skeleton);
    expect((engine as any).activeSkeleton).not.toBe(skinned1.skeleton);
  });

  it('a failed request does not disturb other in-flight requests', async () => {
    const engine = await makeEngine();
    const worker = FakeWorker.lastInstance!;

    worker.rigDelay = (_msgId, vertexCount) => (vertexCount === 13 ? 1 : 20);
    worker.shouldFailRig = (_msgId, vertexCount) => vertexCount === 13;

    const badMesh = makeCharacterMesh(50, 4, 13);
    const goodMesh = makeCharacterMesh(100, 8);

    const [badResult, goodResult] = await Promise.allSettled([
      engine.rig(badMesh),
      engine.rig(goodMesh)
    ]);

    expect(badResult.status).toBe('rejected');
    expect(goodResult.status).toBe('fulfilled');
    if (goodResult.status === 'fulfilled') {
      expect(hipsWorldX(goodResult.value)).toBeCloseTo(100, 3);
    }
    expect((engine as any).pendingRequests.size).toBe(0);
  });

  it('SAB and TRANSFERABLE modes produce identical skeletons and normalized weights', async () => {
    const engine = await makeEngine();
    const worker = FakeWorker.lastInstance!;

    const meshPositions = { cx: 25, h: 3 };

    // TRANSFERABLE path (crossOriginIsolated = false from beforeEach).
    const transferableResult = await engine.rig(makeCharacterMesh(meshPositions.cx, meshPositions.h));

    // SAB path.
    Object.defineProperty(globalThis, 'crossOriginIsolated', {
      value: true, writable: true, configurable: true
    });
    const sabResult = await engine.rig(makeCharacterMesh(meshPositions.cx, meshPositions.h));

    // Both transport paths were actually exercised.
    const rigModes = worker.sentMessages.filter(m => m.type === 'RIG').map(m => m.payload.mode);
    expect(rigModes).toEqual(['TRANSFERABLE', 'SAB']);

    // Bone names and hierarchy match.
    const tBones = transferableResult.skeleton.bones;
    const sBones = sabResult.skeleton.bones;
    expect(sBones.map(b => b.name)).toEqual(tBones.map(b => b.name));
    expect(sBones.map(b => b.parent?.name ?? null)).toEqual(tBones.map(b => b.parent?.name ?? null));

    // Bone positions match.
    for (let i = 0; i < tBones.length; i++) {
      expect(sBones[i].position.x).toBeCloseTo(tBones[i].position.x, 6);
      expect(sBones[i].position.y).toBeCloseTo(tBones[i].position.y, 6);
      expect(sBones[i].position.z).toBeCloseTo(tBones[i].position.z, 6);
    }

    // Skin indices and normalized weights match across modes.
    expect(Array.from(skinIndexAttr(sabResult))).toEqual(Array.from(skinIndexAttr(transferableResult)));
    const tW = skinWeightAttr(transferableResult);
    const sW = skinWeightAttr(sabResult);
    for (let i = 0; i < tW.length; i++) {
      expect(sW[i]).toBeCloseTo(tW[i], 6);
    }
    expectNormalizedWeights(transferableResult);
    expectNormalizedWeights(sabResult);
  });

  it('animate() drives only the most recently bound skeleton', async () => {
    const engine = await makeEngine();
    const solve = vi.fn();
    (engine as any).ikSolver = { solve, addTarget: vi.fn() };

    const skinnedA = await engine.rig(makeCharacterMesh(0, 2));
    engine.animate();
    expect(solve).toHaveBeenLastCalledWith(skinnedA.skeleton);

    const skinnedB = await engine.rig(makeCharacterMesh(100, 8));
    engine.animate();
    expect(solve).toHaveBeenLastCalledWith(skinnedB.skeleton);
    expect(solve).toHaveBeenCalledTimes(2);
    // Skeleton A was only driven before B was bound.
    expect(solve.mock.calls[0][0]).toBe(skinnedA.skeleton);
    expect(solve.mock.calls[1][0]).toBe(skinnedB.skeleton);
  });

  it('worker crash rejects all in-flight requests instead of hanging', async () => {
    const engine = await makeEngine();
    const worker = FakeWorker.lastInstance!;

    // Never answer RIG messages — simulate a crash instead.
    worker.rigDelay = () => 1000;
    const pending = engine.rig(makeCharacterMesh(0, 2));
    // Attach a no-op catch before triggering the crash to avoid unhandled rejection noise.
    const assertion = expect(pending).rejects.toThrow('[AutoRig] Worker error');

    worker.onerror?.({ message: 'uncaught' } as ErrorEvent);
    await assertion;
    expect((engine as any).pendingRequests.size).toBe(0);
  });
});

import { describe, it, expect } from 'vitest';
import {
  detectJointsProcedural,
  computeRigIntoBuffers,
  constructSkeleton
} from '../src/worker/rigCompute';
import { JointType } from '../src/types';

const JOINT_COUNT = Object.values(JointType).length;

/**
 * Builds a deterministic vertex cloud filling a humanoid-sized box:
 * x ∈ [cx − 0.2h, cx + 0.2h], y ∈ [0, h], z ∈ [−0.05h, 0.05h].
 * The first two vertices pin the exact bounding-box corners.
 */
function makePositions(centerX: number, height: number, vertexCount: number): Float32Array {
  const positions = new Float32Array(vertexCount * 3);
  for (let i = 0; i < vertexCount; i++) {
    const t = vertexCount === 1 ? 0 : i / (vertexCount - 1);
    const u = ((i * 37) % 13) / 12; // spans [0, 1]
    positions[i * 3 + 0] = centerX + (u - 0.5) * 0.4 * height;
    positions[i * 3 + 1] = t * height;
    positions[i * 3 + 2] = (u - 0.5) * 0.1 * height;
  }
  return positions;
}

describe('worker rig computation — clean state per request', () => {
  it('derives joint positions solely from the current mesh bounds', () => {
    const rigA = detectJointsProcedural(makePositions(0, 2, 64));
    const rigB = detectJointsProcedural(makePositions(100, 8, 64));

    expect(rigA.joints[JointType.Hips].position.x).toBeCloseTo(0, 5);
    expect(rigA.joints[JointType.Hips].position.y).toBeCloseTo(0.52 * 2, 5);

    expect(rigB.joints[JointType.Hips].position.x).toBeCloseTo(100, 5);
    expect(rigB.joints[JointType.Hips].position.y).toBeCloseTo(0.52 * 8, 5);

    // Re-running the first mesh after the second must reproduce the exact
    // same skeleton — nothing may be carried over between computations.
    const rigA2 = detectJointsProcedural(makePositions(0, 2, 64));
    expect(rigA2).toEqual(rigA);
  });

  it('produces a 19+ joint skeleton with the expected hierarchy', () => {
    const rig = detectJointsProcedural(makePositions(0, 1.8, 32));
    expect(Object.keys(rig.joints)).toHaveLength(JOINT_COUNT);
    expect(rig.hierarchy[JointType.Hips]).toEqual([
      JointType.Spine, JointType.LeftUpLeg, JointType.RightUpLeg
    ]);
    expect(rig.hierarchy[JointType.Head]).toEqual([]);
  });

  it('wipes stale bone/weight data from the output buffers before writing', () => {
    const positions = makePositions(0, 2, 32);
    const rig = detectJointsProcedural(positions);
    const vertexCount = positions.length / 3;

    // Simulate buffers still holding a previous round's garbage.
    const skinIndices = new Uint16Array(vertexCount * 4).fill(0xFFFF);
    const skinWeights = new Float32Array(vertexCount * 4).fill(999);

    computeRigIntoBuffers(positions, rig, 2.0, skinIndices, skinWeights);

    for (let i = 0; i < vertexCount * 4; i++) {
      expect(skinIndices[i]).not.toBe(0xFFFF);
      expect(skinIndices[i]).toBeLessThan(JOINT_COUNT);
      expect(skinWeights[i]).toBeGreaterThanOrEqual(0);
      expect(skinWeights[i]).toBeLessThanOrEqual(1);
      expect(Number.isFinite(skinWeights[i])).toBe(true);
    }

    // Weights are normalized per vertex.
    for (let v = 0; v < vertexCount; v++) {
      const sum =
        skinWeights[v * 4 + 0] +
        skinWeights[v * 4 + 1] +
        skinWeights[v * 4 + 2] +
        skinWeights[v * 4 + 3];
      expect(sum).toBeCloseTo(1, 4);
    }
  });

  it('fully overwrites a previous result when buffers are reused for a different mesh', () => {
    const vertexCount = 48;
    const posA = makePositions(0, 2, vertexCount);
    const posB = makePositions(100, 8, vertexCount);

    const sharedIndices = new Uint16Array(vertexCount * 4);
    const sharedWeights = new Float32Array(vertexCount * 4);

    // Round 1: mesh A into the shared buffers.
    computeRigIntoBuffers(posA, detectJointsProcedural(posA), 2.0, sharedIndices, sharedWeights);

    // Round 2: mesh B into the SAME buffers.
    const rigB = detectJointsProcedural(posB);
    computeRigIntoBuffers(posB, rigB, 2.0, sharedIndices, sharedWeights);

    // Reference: mesh B computed into fresh buffers.
    const freshIndices = new Uint16Array(vertexCount * 4);
    const freshWeights = new Float32Array(vertexCount * 4);
    computeRigIntoBuffers(posB, detectJointsProcedural(posB), 2.0, freshIndices, freshWeights);

    // No residue from mesh A may remain — results must be bit-identical.
    expect(Array.from(sharedIndices)).toEqual(Array.from(freshIndices));
    expect(Array.from(sharedWeights)).toEqual(Array.from(freshWeights));
  });

  it('handles degenerate (empty) meshes without NaN joints', () => {
    const rig = detectJointsProcedural(new Float32Array(0));
    for (const joint of Object.values(rig.joints)) {
      expect(Number.isFinite(joint.position.x)).toBe(true);
      expect(Number.isFinite(joint.position.y)).toBe(true);
      expect(Number.isFinite(joint.position.z)).toBe(true);
    }
  });

  it('constructSkeleton copies keypoints into plain data (no tensor memory aliasing)', () => {
    const keypoints = new Float32Array(JOINT_COUNT * 3).fill(1);
    const confidences = new Float32Array(JOINT_COUNT).fill(0.5);
    const rig = constructSkeleton(keypoints, confidences);

    // Mutating the source arrays afterwards must not affect the rig.
    keypoints.fill(-777);
    confidences.fill(0);
    expect(rig.joints[JointType.Hips].position.x).toBe(1);
    expect(rig.joints[JointType.Hips].confidence).toBe(0.5);
  });
});

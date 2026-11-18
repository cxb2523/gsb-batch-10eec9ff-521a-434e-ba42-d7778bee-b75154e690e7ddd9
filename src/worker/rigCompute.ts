import { SkeletonRig, JointType, Joint } from '../types';

/**
 * Pure, stateless rigging computation shared by the Web Worker and tests.
 *
 * Every function here derives its output solely from its arguments — no
 * module-level bone or weight data is retained between invocations, so a
 * rigging pass can never observe results from a previous one.
 */

const JOINT_HIERARCHY: Record<JointType, JointType[]> = {
  [JointType.Hips]: [JointType.Spine, JointType.LeftUpLeg, JointType.RightUpLeg],
  [JointType.Spine]: [JointType.Chest],
  [JointType.Chest]: [JointType.Neck, JointType.LeftShoulder, JointType.RightShoulder],
  [JointType.Neck]: [JointType.Head],
  [JointType.Head]: [],
  [JointType.LeftShoulder]: [JointType.LeftArm],
  [JointType.LeftArm]: [JointType.LeftForeArm],
  [JointType.LeftForeArm]: [JointType.LeftHand],
  [JointType.LeftHand]: [],
  [JointType.RightShoulder]: [JointType.RightArm],
  [JointType.RightArm]: [JointType.RightForeArm],
  [JointType.RightForeArm]: [JointType.RightHand],
  [JointType.RightHand]: [],
  [JointType.LeftUpLeg]: [JointType.LeftLeg],
  [JointType.LeftLeg]: [JointType.LeftFoot],
  [JointType.LeftFoot]: [],
  [JointType.RightUpLeg]: [JointType.RightLeg],
  [JointType.RightLeg]: [JointType.RightFoot],
  [JointType.RightFoot]: []
};

export function constructSkeleton(keypoints: Float32Array, confidences: Float32Array): SkeletonRig {
  const joints = {} as Record<JointType, Joint>;
  const types = Object.values(JointType);

  for (let i = 0; i < types.length; i++) {
    joints[types[i]] = {
      type: types[i],
      position: {
        x: keypoints[i * 3 + 0],
        y: keypoints[i * 3 + 1],
        z: keypoints[i * 3 + 2]
      },
      confidence: confidences[i]
    };
  }

  const hierarchy: Record<JointType, JointType[]> = { ...JOINT_HIERARCHY };

  return { joints, hierarchy };
}

export function detectJointsProcedural(positions: Float32Array): SkeletonRig {
  const vertexCount = positions.length / 3;
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;

  for (let i = 0; i < vertexCount; i++) {
    const x = positions[i * 3 + 0];
    const y = positions[i * 3 + 1];
    const z = positions[i * 3 + 2];
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
    if (z < minZ) minZ = z;
    if (z > maxZ) maxZ = z;
  }

  if (vertexCount === 0) {
    // Degenerate mesh: fall back to a unit box at the origin instead of
    // propagating Infinity/NaN into the skeleton.
    minX = minY = minZ = 0;
    maxX = maxY = maxZ = 0;
  }

  const cx = (minX + maxX) * 0.5;
  const cz = (minZ + maxZ) * 0.5;
  const h = Math.max(maxY - minY, 1e-4);

  const keypointMap: Record<JointType, { x: number, y: number, z: number }> = {
    [JointType.Hips]: { x: cx, y: minY + 0.52 * h, z: cz },
    [JointType.Spine]: { x: cx, y: minY + 0.62 * h, z: cz },
    [JointType.Chest]: { x: cx, y: minY + 0.74 * h, z: cz },
    [JointType.Neck]: { x: cx, y: minY + 0.84 * h, z: cz },
    [JointType.Head]: { x: cx, y: minY + 0.94 * h, z: cz },
    [JointType.LeftShoulder]: { x: cx - 0.12 * h, y: minY + 0.80 * h, z: cz },
    [JointType.RightShoulder]: { x: cx + 0.12 * h, y: minY + 0.80 * h, z: cz },
    [JointType.LeftArm]: { x: cx - 0.22 * h, y: minY + 0.72 * h, z: cz },
    [JointType.RightArm]: { x: cx + 0.22 * h, y: minY + 0.72 * h, z: cz },
    [JointType.LeftForeArm]: { x: cx - 0.32 * h, y: minY + 0.55 * h, z: cz },
    [JointType.RightForeArm]: { x: cx + 0.32 * h, y: minY + 0.55 * h, z: cz },
    [JointType.LeftHand]: { x: cx - 0.40 * h, y: minY + 0.40 * h, z: cz },
    [JointType.RightHand]: { x: cx + 0.40 * h, y: minY + 0.40 * h, z: cz },
    [JointType.LeftUpLeg]: { x: cx - 0.08 * h, y: minY + 0.48 * h, z: cz },
    [JointType.RightUpLeg]: { x: cx + 0.08 * h, y: minY + 0.48 * h, z: cz },
    [JointType.LeftLeg]: { x: cx - 0.08 * h, y: minY + 0.26 * h, z: cz },
    [JointType.RightLeg]: { x: cx + 0.08 * h, y: minY + 0.26 * h, z: cz },
    [JointType.LeftFoot]: { x: cx - 0.09 * h, y: minY + 0.04 * h, z: cz + 0.05 * h },
    [JointType.RightFoot]: { x: cx + 0.09 * h, y: minY + 0.04 * h, z: cz + 0.05 * h },
  };

  const types = Object.values(JointType);
  const keypoints = new Float32Array(types.length * 3);
  const confidences = new Float32Array(types.length);

  for (let i = 0; i < types.length; i++) {
    const pt = keypointMap[types[i]] || { x: cx, y: minY + 0.5 * h, z: cz };
    keypoints[i * 3 + 0] = pt.x;
    keypoints[i * 3 + 1] = pt.y;
    keypoints[i * 3 + 2] = pt.z;
    confidences[i] = 1.0;
  }

  return constructSkeleton(keypoints, confidences);
}

function distToSegment(px: number, py: number, pz: number, ax: number, ay: number, az: number, bx: number, by: number, bz: number): number {
  const abx = bx - ax;
  const aby = by - ay;
  const abz = bz - az;
  const apx = px - ax;
  const apy = py - ay;
  const apz = pz - az;

  const abLenSq = abx * abx + aby * aby + abz * abz;
  if (abLenSq < 1e-8) {
    return Math.sqrt(apx * apx + apy * apy + apz * apz);
  }

  const t = Math.max(0, Math.min(1, (apx * abx + apy * aby + apz * abz) / abLenSq));
  const projX = ax + t * abx;
  const projY = ay + t * aby;
  const projZ = az + t * abz;

  const dx = px - projX;
  const dy = py - projY;
  const dz = pz - projZ;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

export function calculateBoneWeights(
  positions: Float32Array,
  rig: SkeletonRig,
  falloff: number,
  skinIndices: Uint16Array,
  skinWeights: Float32Array
): void {
  const vertexCount = positions.length / 3;
  const boneTypes = Object.keys(rig.joints) as JointType[];

  // Build bone segments from hierarchy
  const segments: { boneIdx: number; ax: number; ay: number; az: number; bx: number; by: number; bz: number }[] = [];
  for (let b = 0; b < boneTypes.length; b++) {
    const parentType = boneTypes[b];
    const parentPos = rig.joints[parentType].position;
    const children = rig.hierarchy[parentType] || [];

    if (children.length > 0) {
      for (const childType of children) {
        const childPos = rig.joints[childType].position;
        segments.push({
          boneIdx: b,
          ax: parentPos.x, ay: parentPos.y, az: parentPos.z,
          bx: childPos.x, by: childPos.y, bz: childPos.z,
        });
      }
    } else {
      // Leaf joint: point capsule
      segments.push({
        boneIdx: b,
        ax: parentPos.x, ay: parentPos.y, az: parentPos.z,
        bx: parentPos.x, by: parentPos.y, bz: parentPos.z,
      });
    }
  }

  for (let i = 0; i < vertexCount; i++) {
    const vx = positions[i * 3 + 0];
    const vy = positions[i * 3 + 1];
    const vz = positions[i * 3 + 2];

    const distances: { index: number, weight: number }[] = [];

    for (const seg of segments) {
      const dist = distToSegment(vx, vy, vz, seg.ax, seg.ay, seg.az, seg.bx, seg.by, seg.bz);
      const weight = 1.0 / Math.pow(dist + 0.001, falloff);
      distances.push({ index: seg.boneIdx, weight });
    }

    distances.sort((a, b) => b.weight - a.weight);
    const top4 = distances.slice(0, 4);
    const totalWeight = top4.reduce((sum, d) => sum + d.weight, 0);

    skinIndices[i * 4 + 0] = top4[0]?.index ?? 0;
    skinIndices[i * 4 + 1] = top4[1]?.index ?? 0;
    skinIndices[i * 4 + 2] = top4[2]?.index ?? 0;
    skinIndices[i * 4 + 3] = top4[3]?.index ?? 0;

    skinWeights[i * 4 + 0] = (top4[0]?.weight ?? 0) / totalWeight;
    skinWeights[i * 4 + 1] = (top4[1]?.weight ?? 0) / totalWeight;
    skinWeights[i * 4 + 2] = (top4[2]?.weight ?? 0) / totalWeight;
    skinWeights[i * 4 + 3] = (top4[3]?.weight ?? 0) / totalWeight;
  }
}

/**
 * Computes this request's skinning data into the caller-provided buffers.
 *
 * Both output buffers are wiped before any weights are written, so bone
 * indices or weights left over from a previous rigging pass (the buffers may
 * be shared memory that outlives a single request) can never leak into the
 * result of this one.
 */
export function computeRigIntoBuffers(
  positions: Float32Array,
  rig: SkeletonRig,
  falloff: number,
  skinIndices: Uint16Array,
  skinWeights: Float32Array
): void {
  skinIndices.fill(0);
  skinWeights.fill(0);
  calculateBoneWeights(positions, rig, falloff, skinIndices, skinWeights);
}

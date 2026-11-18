import * as ort from 'onnxruntime-web';
import { SkeletonRig } from '../types';
import {
  constructSkeleton,
  detectJointsProcedural,
  computeRigIntoBuffers
} from './rigCompute';

// The ONNX session is the only state kept between requests — it is the loaded
// model, not rigging data. All bone/weight computation state lives inside the
// handler of a single request and is discarded when the response is posted.
let session: ort.InferenceSession | null = null;

function meshToTensor(positions: Float32Array, resolution: number): ort.Tensor {
  const grid = new Float32Array(1 * 1 * resolution * resolution * resolution);
  const vertexCount = positions.length / 3;

  if (vertexCount === 0) {
    return new ort.Tensor('float32', grid, [1, 1, resolution, resolution, resolution]);
  }

  // 1. Compute Axis-Aligned Bounding Box (AABB)
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

  const rangeX = Math.max(maxX - minX, 1e-5);
  const rangeY = Math.max(maxY - minY, 1e-5);
  const rangeZ = Math.max(maxZ - minZ, 1e-5);
  const maxRange = Math.max(rangeX, rangeY, rangeZ);
  const scale = (resolution - 2) / maxRange;

  // 2. Voxelize mesh surface into 3D density grid
  for (let i = 0; i < vertexCount; i++) {
    const x = positions[i * 3 + 0];
    const y = positions[i * 3 + 1];
    const z = positions[i * 3 + 2];

    const vx = Math.floor((x - minX) * scale) + 1;
    const vy = Math.floor((y - minY) * scale) + 1;
    const vz = Math.floor((z - minZ) * scale) + 1;

    if (vx >= 0 && vx < resolution && vy >= 0 && vy < resolution && vz >= 0 && vz < resolution) {
      const idx = vx + vy * resolution + vz * resolution * resolution;
      grid[idx] = Math.min(1.0, grid[idx] + 0.25);
    }
  }

  return new ort.Tensor('float32', grid, [1, 1, resolution, resolution, resolution]);
}

async function detectJoints(positions: Float32Array): Promise<SkeletonRig> {
  if (!session) {
    return detectJointsProcedural(positions);
  }
  try {
    const tensor = meshToTensor(positions, 64);
    const feeds: Record<string, ort.Tensor> = { input_tensor: tensor };
    const results = await session.run(feeds);
    const keypoints = results.output_keypoints.data as Float32Array;
    const confidences = results.output_confidences.data as Float32Array;
    return constructSkeleton(keypoints, confidences);
  } catch (err) {
    return detectJointsProcedural(positions);
  }
}

self.onmessage = async (e: MessageEvent) => {
  const { type, payload, msgId } = e.data;

  try {
    if (type === 'INIT') {
      const { modelPath } = payload;
      try {
        ort.env.wasm.wasmPaths = 'https://cdn.jsdelivr.net/npm/onnxruntime-web/dist/';
        session = await ort.InferenceSession.create(modelPath, {
          executionProviders: ['webgpu', 'webgl', 'wasm']
        });
      } catch (err: any) {
        // Fall back gracefully to procedural joint estimation
        session = null;
      }
      (self as any).postMessage({ type: 'INIT_DONE', msgId });
    }
    else if (type === 'RIG') {
      const { mode, posBuffer, indicesBuffer, weightsBuffer, falloff } = payload;
      const positions = new Float32Array(posBuffer);
      const skinIndices = new Uint16Array(indicesBuffer);
      const skinWeights = new Float32Array(weightsBuffer);

      const rig = await detectJoints(positions);
      // computeRigIntoBuffers wipes both output buffers before writing, so no
      // bone indices or weights from a previous RIG request can leak into
      // this one — every request starts from a clean slate.
      computeRigIntoBuffers(positions, rig, falloff, skinIndices, skinWeights);

      if (mode === 'TRANSFERABLE') {
        (self as any).postMessage({
          type: 'RIG_DONE',
          payload: { rig, indicesBuffer, weightsBuffer },
          msgId
        }, [indicesBuffer, weightsBuffer]);
      } else {
        (self as any).postMessage({ type: 'RIG_DONE', payload: { rig }, msgId });
      }
    }
  } catch (err: any) {
    (self as any).postMessage({ type: 'ERROR', payload: err?.message ?? String(err), msgId });
  }
};

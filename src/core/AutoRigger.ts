import * as THREE from 'three';
import { MeshAnalyzer } from '../topology/MeshAnalyzer';
import { ProceduralIK } from '../ik/ProceduralIK';
import { RiggingOptions, IKTarget, SkeletonRig } from '../types';

interface PendingRequest {
  resolve: (value: any) => void;
  reject: (reason: any) => void;
}

export class AutoRigger {
  private analyzer: MeshAnalyzer;
  private ikSolver: ProceduralIK;
  private worker: Worker | null = null;
  private isInitialized = false;
  private msgIdCounter = 0;
  private pendingRequests = new Map<number, PendingRequest>();
  private activeSkeleton?: THREE.Skeleton;

  constructor(private options: RiggingOptions = {}) {
    this.analyzer = new MeshAnalyzer();
    this.ikSolver = new ProceduralIK(options.ikIterations ?? 15);
  }

  async init(): Promise<void> {
    if (this.isInitialized) return;

    // Fallback URL resolving for both Vite and plain build output
    const workerUrl = new URL(
      // @ts-ignore
      import.meta.env ? '../worker/rigWorker.ts' : './worker/rigWorker.js',
      import.meta.url
    );
    this.worker = new Worker(workerUrl, { type: 'module' });

    this.worker.onmessage = (e) => this.handleWorkerMessage(e);
    this.worker.onerror = (e) => {
      // A crashed worker can never answer its in-flight messages: reject every
      // pending request so their promises fail instead of hanging forever.
      this.failAllPending(new Error(`[AutoRig] Worker error: ${(e as ErrorEvent).message ?? 'unknown'}`));
    };

    console.log('[AutoRig] Initializing ML Engine in Worker...');

    await this.postWorkerMessage('INIT', {
      modelPath: this.options.modelPath || '/models/joint_estimator_v1.onnx'
    });

    this.isInitialized = true;
    console.log('[AutoRig] Ready.');
  }

  private handleWorkerMessage(e: MessageEvent) {
    const { type, payload, msgId } = e.data ?? {};
    const req = this.pendingRequests.get(msgId);

    // Unknown or already-settled msgId: ignore without touching other
    // in-flight requests.
    if (!req) {
      if (type === 'ERROR') {
        console.error('[AutoRig] Worker error:', payload);
      }
      return;
    }

    // Settle exactly this request and remove it from the pending map first,
    // so no stale handlers remain for subsequent requests.
    this.pendingRequests.delete(msgId);

    if (type === 'ERROR') {
      req.reject(new Error(typeof payload === 'string' ? payload : payload?.message ?? 'Worker request failed'));
    } else {
      req.resolve(payload);
    }
  }

  private failAllPending(error: Error): void {
    const pending = Array.from(this.pendingRequests.values());
    this.pendingRequests.clear();
    for (const req of pending) {
      req.reject(error);
    }
  }

  private postWorkerMessage(type: string, payload: any, transfers: Transferable[] = []): Promise<any> {
    return new Promise((resolve, reject) => {
      const msgId = ++this.msgIdCounter;
      this.pendingRequests.set(msgId, { resolve, reject });
      try {
        this.worker!.postMessage({ type, payload, msgId }, transfers);
      } catch (err) {
        // postMessage itself failed (e.g. uncloneable payload): don't leak
        // the pending entry.
        this.pendingRequests.delete(msgId);
        reject(err);
      }
    });
  }

  private static extractRig(payload: any): SkeletonRig {
    if (!payload || !payload.rig || !payload.rig.joints) {
      throw new Error('[AutoRig] Worker response is missing the skeleton rig.');
    }
    return payload.rig as SkeletonRig;
  }

  /**
   * Dual-Pipe Autonomous Auto-Rigging:
   * 1. If crossOriginIsolated & SharedArrayBuffer are available: zero-copy shared memory.
   * 2. Otherwise: zero-copy Transferable ArrayBuffers (works anywhere without COOP/COEP headers).
   *
   * Every call allocates its own buffers and binds only the rig, indices and
   * weights returned for *this* request — no state from a previous rigging
   * pass is reused, and concurrent calls never observe each other's results.
   */
  async rig(mesh: THREE.Mesh): Promise<THREE.SkinnedMesh> {
    if (!this.isInitialized || !this.worker) throw new Error('[AutoRig] Engine not initialized.');

    console.log('[AutoRig] Analyzing topology & detecting joints in Worker...');

    const geometry = mesh.geometry;
    const positions = geometry.attributes.position.array as Float32Array;
    const vertexCount = positions.length / 3;
    const falloff = this.options.skinningFalloff ?? 2.0;

    const isSABSupported = typeof SharedArrayBuffer !== 'undefined' &&
      (typeof crossOriginIsolated !== 'undefined' ? crossOriginIsolated : false);

    let rig: SkeletonRig;
    let skinIndices: Uint16Array;
    let skinWeights: Float32Array;

    if (isSABSupported) {
      // Tier 1: SharedArrayBuffer Zero-Copy (fresh buffers per request)
      const posBuffer = new SharedArrayBuffer(positions.length * Float32Array.BYTES_PER_ELEMENT);
      new Float32Array(posBuffer).set(positions);

      const indicesBuffer = new SharedArrayBuffer(vertexCount * 4 * Uint16Array.BYTES_PER_ELEMENT);
      const weightsBuffer = new SharedArrayBuffer(vertexCount * 4 * Float32Array.BYTES_PER_ELEMENT);

      const payload = await this.postWorkerMessage('RIG', {
        mode: 'SAB',
        posBuffer,
        indicesBuffer,
        weightsBuffer,
        falloff
      });

      rig = AutoRigger.extractRig(payload);
      console.log('[AutoRig] Applying procedural skin weights (SAB mode)...');
      skinIndices = new Uint16Array(indicesBuffer);
      skinWeights = new Float32Array(weightsBuffer);
    } else {
      // Tier 2: Universal Transferable ArrayBuffer Zero-Copy (No CORS/Spectre headers required)
      const posBuffer = new Float32Array(positions).buffer;
      const indicesBuffer = new ArrayBuffer(vertexCount * 4 * Uint16Array.BYTES_PER_ELEMENT);
      const weightsBuffer = new ArrayBuffer(vertexCount * 4 * Float32Array.BYTES_PER_ELEMENT);

      const payload = await this.postWorkerMessage('RIG', {
        mode: 'TRANSFERABLE',
        posBuffer,
        indicesBuffer,
        weightsBuffer,
        falloff
      }, [posBuffer, indicesBuffer, weightsBuffer]);

      rig = AutoRigger.extractRig(payload);
      if (!payload.indicesBuffer || !payload.weightsBuffer) {
        throw new Error('[AutoRig] Worker response is missing the skinning buffers.');
      }
      console.log('[AutoRig] Applying procedural skin weights (Transferable mode)...');
      skinIndices = new Uint16Array(payload.indicesBuffer);
      skinWeights = new Float32Array(payload.weightsBuffer);
    }

    const skinnedMesh = this.analyzer.bindSkeletonWithWeights(mesh, rig, skinIndices, skinWeights);
    // The newly bound skeleton becomes the active one only after a successful
    // bind. A failed request rejects above and leaves the previously bound
    // skeleton untouched, so animate() always drives the most recent
    // *successful* rig.
    this.activeSkeleton = skinnedMesh.skeleton;
    return skinnedMesh;
  }

  /**
   * Alias for rig(mesh) for backward compatibility.
   */
  async autoRig(mesh: THREE.Mesh): Promise<THREE.SkinnedMesh> {
    return this.rig(mesh);
  }

  animate(): void {
    if (this.activeSkeleton) {
      this.ikSolver.solve(this.activeSkeleton);
    }
  }

  setIKTarget(target: IKTarget): void {
    this.ikSolver.addTarget(target);
  }

  /**
   * Rejects all in-flight requests and terminates the worker.
   */
  dispose(): void {
    this.failAllPending(new Error('[AutoRig] Engine disposed.'));
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
    this.isInitialized = false;
    this.activeSkeleton = undefined;
  }
}

export { AutoRigger as RiggingEngine };

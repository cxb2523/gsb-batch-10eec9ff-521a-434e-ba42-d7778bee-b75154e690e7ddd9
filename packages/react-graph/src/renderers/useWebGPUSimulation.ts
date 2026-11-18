// ============================================================================
// useWebGPUSimulation Hook
//
// Wraps ForceGraphSimulation with optional WebGPU acceleration.
// When WebGPU is available and renderer != 'webgl', the GPU engine runs the
// force step; otherwise the hook falls back to the CPU-based d3-force sim.
// ============================================================================

import { useRef, useMemo, useCallback, useEffect, useState } from 'react';
import {
  ForceGraphSimulation,
  DEFAULT_FORCE_GRAPH_CONFIG,
  type ForceGraphConfig,
  type TopToken,
  type TraderEdge,
} from '@web3viz/core';
import { WebGPUForceEngine, type GPUNodeData, type GPUEdgeData } from './webgpu';
import type { RendererType } from './auto-detect';

interface GPUSimState {
  sim: ForceGraphSimulation;
  /** True when the WebGPU engine is initialised and driving the force step. */
  gpuActive: boolean;
  /**
   * True once the WebGPU initialisation attempt has settled (success or
   * failure) — i.e. the active renderer is known and will not change.
   */
  gpuResolved: boolean;
  update: (topTokens: TopToken[], traderEdges: TraderEdge[]) => void;
  dispose: () => void;
  tick: () => void;
}

/** d3-force alpha floor — below this the simulation is considered cooled. */
const ALPHA_MIN = 0.001;

/**
 * Hook that manages a ForceGraphSimulation instance.
 *
 * When `renderer` is 'auto' or 'webgpu', it attempts to initialise a WebGPU
 * compute pipeline for the force step. If unavailable (or `renderer === 'webgl'`),
 * the CPU-based d3-force simulation is used directly.
 */
export function useWebGPUSimulation(
  renderer: RendererType = 'auto',
  config?: ForceGraphConfig,
): GPUSimState {
  const simRef = useRef<ForceGraphSimulation | null>(null);
  const engineRef = useRef<WebGPUForceEngine | null>(null);
  const readbackPendingRef = useRef(false);
  // GPU-side alpha, mirroring the d3 simulation's cooling schedule.
  const alphaRef = useRef(1);
  const [gpuActive, setGpuActive] = useState(false);
  const [gpuResolved, setGpuResolved] = useState(renderer === 'webgl');

  const sim = useMemo(() => {
    if (simRef.current) return simRef.current;
    const s = new ForceGraphSimulation(config);
    simRef.current = s;
    return s;
  }, [config]);

  // Resolved force configuration (user overrides over core defaults) — used
  // to parameterise the GPU compute shader so both paths behave alike.
  const resolvedConfig = useMemo(
    () => ({ ...DEFAULT_FORCE_GRAPH_CONFIG, ...config }),
    [config],
  );

  // Attempt WebGPU initialisation. 'webgl' skips the GPU path entirely.
  useEffect(() => {
    if (renderer === 'webgl') {
      setGpuActive(false);
      setGpuResolved(true);
      return;
    }

    let cancelled = false;
    const engine = new WebGPUForceEngine();

    engine
      .init()
      .then((ok) => {
        if (cancelled) {
          engine.dispose();
          return;
        }
        if (ok && engine.ready) {
          engineRef.current = engine;
          setGpuActive(true);
        } else {
          engine.dispose();
        }
        setGpuResolved(true);
      })
      .catch(() => {
        if (cancelled) return;
        engine.dispose();
        setGpuActive(false);
        setGpuResolved(true);
      });

    return () => {
      cancelled = true;
      if (engineRef.current === engine) engineRef.current = null;
      engine.dispose();
    };
  }, [renderer]);

  const update = useCallback(
    (topTokens: TopToken[], traderEdges: TraderEdge[]) => {
      sim.update(topTokens, traderEdges);

      const engine = engineRef.current;
      if (!engine || !engine.ready) return;

      // Mirror the CPU sim's reheat so the GPU cooling schedule stays in sync.
      alphaRef.current = 0.3;

      const nodes = sim.nodes;
      const indexById = new Map<string, number>();
      const gpuNodes: GPUNodeData[] = new Array(nodes.length);
      for (let i = 0; i < nodes.length; i++) {
        const n = nodes[i];
        indexById.set(n.id, i);
        gpuNodes[i] = {
          x: n.x ?? 0,
          y: n.y ?? 0,
          z: n.z ?? 0,
          radius: n.radius,
          vx: n.vx ?? 0,
          vy: n.vy ?? 0,
          vz: n.vz ?? 0,
          nodeType: n.type === 'hub' ? 0 : 1,
        };
      }

      const gpuEdges: GPUEdgeData[] = [];
      for (const e of sim.edges) {
        const source = indexById.get(e.sourceId);
        const target = indexById.get(e.targetId);
        if (source === undefined || target === undefined) continue;
        const srcNode = nodes[source];
        const tgtNode = nodes[target];
        const hubToHub = srcNode.type === 'hub' && tgtNode.type === 'hub';
        gpuEdges.push({
          source,
          target,
          restLength: hubToHub
            ? resolvedConfig.hubLinkDistance
            : resolvedConfig.agentLinkDistanceBase,
          strength: hubToHub ? 0.1 : 0.3,
        });
      }

      // Re-creates GPU buffers and the bind group whenever the node/edge
      // counts change, so the compute pass never reads stale buffers.
      engine.uploadGraph(gpuNodes, gpuEdges);
    },
    [sim, resolvedConfig],
  );

  const tick = useCallback(() => {
    const engine = engineRef.current;
    if (!engine || !engine.ready) {
      sim.tick();
      return;
    }

    engine.tick({
      nodeCount: sim.nodes.length,
      edgeCount: sim.edges.length,
      deltaTime: 1,
      alpha: alphaRef.current,
      alphaDecay: resolvedConfig.alphaDecay,
      alphaMin: ALPHA_MIN,
      velocityDecay: resolvedConfig.velocityDecay,
      centerStrength: resolvedConfig.centerStrength,
      collisionStrength: resolvedConfig.collisionStrength,
      hubCharge: resolvedConfig.hubChargeStrength,
      agentCharge: resolvedConfig.agentChargeStrength,
    });

    // Cool down like d3-force: alpha += (target - alpha) * alphaDecay, target = 0.
    alphaRef.current = Math.max(
      alphaRef.current * (1 - resolvedConfig.alphaDecay),
      ALPHA_MIN,
    );

    // Read positions back and sync them into the CPU-side node objects that
    // the render components read. Skip if a previous readback is in flight,
    // and ignore stale results from before a graph re-upload.
    if (!readbackPendingRef.current) {
      readbackPendingRef.current = true;
      const expectedNodes = sim.nodes.length;
      engine
        .readPositions()
        .then((positions) => {
          readbackPendingRef.current = false;
          if (!positions) return;
          const nodes = sim.nodes;
          if (nodes.length !== expectedNodes) return;
          const count = Math.min(nodes.length, positions.length / 4);
          for (let i = 0; i < count; i++) {
            nodes[i].x = positions[i * 4];
            nodes[i].y = positions[i * 4 + 1];
            nodes[i].z = positions[i * 4 + 2];
          }
        })
        .catch(() => {
          readbackPendingRef.current = false;
        });
    }
  }, [sim, resolvedConfig]);

  const dispose = useCallback(() => {
    if (engineRef.current) {
      engineRef.current.dispose();
      engineRef.current = null;
    }
    sim.dispose();
  }, [sim]);

  return { sim, gpuActive, gpuResolved, update, dispose, tick };
}

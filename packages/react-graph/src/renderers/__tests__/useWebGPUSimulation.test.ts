// ============================================================================
// useWebGPUSimulation + WebGPUForceEngine tests
//
// Covers: GPU enablement, CPU fallback, node-count changes (buffer rebuild),
// zero-node safety, and disposal — using a mocked WebGPU device.
// ============================================================================

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import {
  ForceGraphSimulation,
  type TopToken,
  type TraderEdge,
} from '@web3viz/core';
import { WebGPUForceEngine } from '../webgpu';
import { useWebGPUSimulation } from '../useWebGPUSimulation';

// ---------------------------------------------------------------------------
// Mock WebGPU device
// ---------------------------------------------------------------------------

interface MockBuffer {
  size: number;
  usage: number;
  destroyed: boolean;
  destroy: ReturnType<typeof vi.fn>;
  mapAsync: ReturnType<typeof vi.fn>;
  getMappedRange: ReturnType<typeof vi.fn>;
  unmap: ReturnType<typeof vi.fn>;
}

function createMockGPU() {
  const buffers: MockBuffer[] = [];
  const bindGroups: unknown[] = [];
  const dispatches: number[] = [];

  const device = {
    createBuffer: vi.fn((desc: { size: number; usage: number }) => {
      const buf: MockBuffer = {
        size: desc.size,
        usage: desc.usage,
        destroyed: false,
        destroy: vi.fn(() => {
          buf.destroyed = true;
        }),
        mapAsync: vi.fn(async () => {}),
        getMappedRange: vi.fn(() => new ArrayBuffer(desc.size)),
        unmap: vi.fn(),
      };
      buffers.push(buf);
      return buf;
    }),
    createShaderModule: vi.fn(() => ({})),
    createComputePipeline: vi.fn(() => ({
      getBindGroupLayout: vi.fn(() => ({})),
    })),
    createBindGroup: vi.fn((desc: unknown) => {
      bindGroups.push(desc);
      return {};
    }),
    createCommandEncoder: vi.fn(() => ({
      beginComputePass: vi.fn(() => ({
        setPipeline: vi.fn(),
        setBindGroup: vi.fn(),
        dispatchWorkgroups: vi.fn((n: number) => {
          dispatches.push(n);
        }),
        end: vi.fn(),
      })),
      copyBufferToBuffer: vi.fn(),
      finish: vi.fn(() => ({})),
    })),
    queue: { writeBuffer: vi.fn(), submit: vi.fn() },
    destroy: vi.fn(),
  };

  const adapter = { requestDevice: vi.fn(async () => device) };
  const gpu = { requestAdapter: vi.fn(async () => adapter) };

  return { gpu, adapter, device, buffers, bindGroups, dispatches };
}

// ---------------------------------------------------------------------------
// navigator.gpu install/uninstall helpers
// ---------------------------------------------------------------------------

let originalGpuDescriptor: PropertyDescriptor | undefined;

beforeEach(() => {
  if (originalGpuDescriptor === undefined) {
    originalGpuDescriptor = Object.getOwnPropertyDescriptor(window.navigator, 'gpu');
  }
});

afterEach(() => {
  if (originalGpuDescriptor) {
    Object.defineProperty(window.navigator, 'gpu', originalGpuDescriptor);
  } else {
    delete (window.navigator as unknown as Record<string, unknown>).gpu;
  }
  vi.restoreAllMocks();
});

function installMockGPU(gpu: unknown): void {
  Object.defineProperty(window.navigator, 'gpu', {
    value: gpu,
    configurable: true,
    writable: true,
  });
}

// ---------------------------------------------------------------------------
// Test data helpers
// ---------------------------------------------------------------------------

let tokenSeq = 0;

function makeTopToken(overrides: Partial<TopToken> = {}): TopToken {
  return {
    tokenAddress: `token_${tokenSeq++}`,
    symbol: 'TKN',
    name: 'Token',
    chain: 'solana',
    trades: 100,
    volume: 50000,
    nativeSymbol: 'SOL',
    ...overrides,
  };
}

function makeTraderEdge(tokenAddress: string, overrides: Partial<TraderEdge> = {}): TraderEdge {
  return {
    trader: `trader_${tokenSeq++}`,
    tokenAddress,
    chain: 'solana',
    trades: 5,
    volume: 1000,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// WebGPUForceEngine
// ---------------------------------------------------------------------------

describe('WebGPUForceEngine', () => {
  it('reports not ready and fails init when WebGPU is unavailable', async () => {
    const engine = new WebGPUForceEngine();
    expect(engine.ready).toBe(false);
    expect(await engine.init()).toBe(false);
    expect(engine.ready).toBe(false);
  });

  it('initialises with a mocked GPU device', async () => {
    const mock = createMockGPU();
    installMockGPU(mock.gpu);

    const engine = new WebGPUForceEngine();
    expect(await engine.init()).toBe(true);
    expect(engine.ready).toBe(true);
    expect(mock.device.createShaderModule).toHaveBeenCalledTimes(1);
    expect(mock.device.createComputePipeline).toHaveBeenCalledTimes(1);

    engine.dispose();
  });

  it('does not leak devices across repeated init calls', async () => {
    const mock = createMockGPU();
    installMockGPU(mock.gpu);

    const engine = new WebGPUForceEngine();
    await engine.init();
    await engine.init(); // already ready — must be a no-op
    expect(mock.adapter.requestDevice).toHaveBeenCalledTimes(1);

    engine.dispose();
    expect(mock.device.destroy).toHaveBeenCalledTimes(1);

    // Re-initialising after dispose creates a fresh device.
    await engine.init();
    expect(mock.adapter.requestDevice).toHaveBeenCalledTimes(2);
    expect(engine.ready).toBe(true);

    engine.dispose();
    expect(mock.device.destroy).toHaveBeenCalledTimes(2);
  });

  it('rebuilds buffers and bind group when the node count changes', async () => {
    const mock = createMockGPU();
    installMockGPU(mock.gpu);

    const engine = new WebGPUForceEngine();
    await engine.init();

    const node = { x: 1, y: 2, z: 3, radius: 0.5, vx: 0, vy: 0, vz: 0, nodeType: 0 };
    engine.uploadGraph([node, node], [{ source: 0, target: 1, restLength: 25, strength: 0.1 }]);

    const firstBuffers = [...mock.buffers];
    expect(mock.device.createBindGroup).toHaveBeenCalledTimes(1);
    // position buffer: 2 nodes * 4 floats * 4 bytes
    expect(firstBuffers[0].size).toBe(32);

    // Grow to 3 nodes — old buffers must be destroyed, new ones created.
    engine.uploadGraph(
      [node, node, node],
      [
        { source: 0, target: 1, restLength: 25, strength: 0.1 },
        { source: 0, target: 2, restLength: 25, strength: 0.1 },
        { source: 1, target: 2, restLength: 25, strength: 0.1 },
      ],
    );

    expect(firstBuffers.every((b) => b.destroyed)).toBe(true);
    expect(mock.device.createBindGroup).toHaveBeenCalledTimes(2);
    const secondBuffers = mock.buffers.slice(firstBuffers.length);
    expect(secondBuffers.length).toBe(firstBuffers.length);
    expect(secondBuffers[0].size).toBe(48); // 3 nodes * 16 bytes
    expect(secondBuffers.every((b) => !b.destroyed)).toBe(true);

    engine.dispose();
  });

  it('releases buffers when the graph becomes empty', async () => {
    const mock = createMockGPU();
    installMockGPU(mock.gpu);

    const engine = new WebGPUForceEngine();
    await engine.init();

    const node = { x: 0, y: 0, z: 0, radius: 1, vx: 0, vy: 0, vz: 0, nodeType: 0 };
    engine.uploadGraph([node], []);
    const allocated = [...mock.buffers];
    expect(allocated.length).toBeGreaterThan(0);

    engine.uploadGraph([], []);
    expect(allocated.every((b) => b.destroyed)).toBe(true);

    engine.dispose();
  });

  it('tick is a safe no-op with zero nodes', async () => {
    const mock = createMockGPU();
    installMockGPU(mock.gpu);

    const engine = new WebGPUForceEngine();
    await engine.init();

    const params = {
      nodeCount: 0,
      edgeCount: 0,
      deltaTime: 1,
      alpha: 0.3,
      alphaDecay: 0.01,
      alphaMin: 0.001,
      velocityDecay: 0.4,
      centerStrength: 0.03,
      collisionStrength: 0.7,
      hubCharge: -200,
      agentCharge: -8,
    };

    // No upload at all.
    expect(() => engine.tick(params)).not.toThrow();

    // Explicit empty upload.
    engine.uploadGraph([], []);
    expect(() => engine.tick(params)).not.toThrow();
    expect(mock.device.createCommandEncoder).not.toHaveBeenCalled();

    engine.dispose();
  });

  it('dispatches one workgroup per 256 nodes on tick', async () => {
    const mock = createMockGPU();
    installMockGPU(mock.gpu);

    const engine = new WebGPUForceEngine();
    await engine.init();

    const node = { x: 0, y: 0, z: 0, radius: 1, vx: 0, vy: 0, vz: 0, nodeType: 0 };
    engine.uploadGraph([node, node, node], []);
    engine.tick({
      nodeCount: 3,
      edgeCount: 0,
      deltaTime: 1,
      alpha: 0.3,
      alphaDecay: 0.01,
      alphaMin: 0.001,
      velocityDecay: 0.4,
      centerStrength: 0.03,
      collisionStrength: 0.7,
      hubCharge: -200,
      agentCharge: -8,
    });

    expect(mock.dispatches).toEqual([1]);
    expect(mock.device.queue.submit).toHaveBeenCalledTimes(1);

    engine.dispose();
  });

  it('dispose destroys buffers and device and is idempotent', async () => {
    const mock = createMockGPU();
    installMockGPU(mock.gpu);

    const engine = new WebGPUForceEngine();
    await engine.init();
    const node = { x: 0, y: 0, z: 0, radius: 1, vx: 0, vy: 0, vz: 0, nodeType: 0 };
    engine.uploadGraph([node], []);

    engine.dispose();
    expect(mock.buffers.every((b) => b.destroyed)).toBe(true);
    expect(mock.device.destroy).toHaveBeenCalledTimes(1);
    expect(engine.ready).toBe(false);

    expect(() => engine.dispose()).not.toThrow();
    expect(mock.device.destroy).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// useWebGPUSimulation
// ---------------------------------------------------------------------------

describe('useWebGPUSimulation', () => {
  it('never attempts WebGPU when renderer is webgl', async () => {
    const mock = createMockGPU();
    installMockGPU(mock.gpu);
    const cpuTick = vi.spyOn(ForceGraphSimulation.prototype, 'tick');

    const { result } = renderHook(() => useWebGPUSimulation('webgl'));

    expect(result.current.gpuActive).toBe(false);
    expect(result.current.gpuResolved).toBe(true);
    expect(mock.gpu.requestAdapter).not.toHaveBeenCalled();

    act(() => {
      result.current.update([makeTopToken()], []);
      result.current.tick();
    });
    expect(cpuTick).toHaveBeenCalledTimes(1);

    result.current.dispose();
  });

  it('falls back to the CPU simulation when WebGPU is unavailable (auto)', async () => {
    // No navigator.gpu installed.
    const cpuTick = vi.spyOn(ForceGraphSimulation.prototype, 'tick');

    const { result } = renderHook(() => useWebGPUSimulation('auto'));

    await waitFor(() => expect(result.current.gpuResolved).toBe(true));
    expect(result.current.gpuActive).toBe(false);

    act(() => {
      result.current.update([makeTopToken()], []);
      result.current.tick();
    });
    expect(cpuTick).toHaveBeenCalledTimes(1);

    result.current.dispose();
  });

  it('falls back to the CPU simulation when WebGPU init fails (webgpu)', async () => {
    installMockGPU({ requestAdapter: vi.fn(async () => null) });

    const { result } = renderHook(() => useWebGPUSimulation('webgpu'));

    await waitFor(() => expect(result.current.gpuResolved).toBe(true));
    expect(result.current.gpuActive).toBe(false);

    result.current.dispose();
  });

  it('activates the GPU path when WebGPU is available', async () => {
    const mock = createMockGPU();
    installMockGPU(mock.gpu);

    const uploadSpy = vi.spyOn(WebGPUForceEngine.prototype, 'uploadGraph');
    const gpuTickSpy = vi.spyOn(WebGPUForceEngine.prototype, 'tick');
    const cpuTick = vi.spyOn(ForceGraphSimulation.prototype, 'tick');

    const { result } = renderHook(() => useWebGPUSimulation('auto'));

    await waitFor(() => expect(result.current.gpuActive).toBe(true));
    expect(result.current.gpuResolved).toBe(true);

    const tokenA = makeTopToken({ tokenAddress: 'A' });
    const tokenB = makeTopToken({ tokenAddress: 'B' });
    act(() => {
      result.current.update([tokenA, tokenB], [makeTraderEdge('A'), makeTraderEdge('B')]);
    });

    expect(uploadSpy).toHaveBeenCalledTimes(1);
    const [gpuNodes, gpuEdges] = uploadSpy.mock.calls[0];
    // 2 hubs + 2 agents
    expect(gpuNodes).toHaveLength(4);
    expect(gpuNodes[0]).toMatchObject({ nodeType: 0 });
    expect(gpuNodes[2]).toMatchObject({ nodeType: 1 });
    // 1 hub-hub edge + 2 agent-hub edges
    expect(gpuEdges).toHaveLength(3);
    for (const edge of gpuEdges) {
      expect(edge.source).toBeLessThan(gpuNodes.length);
      expect(edge.target).toBeLessThan(gpuNodes.length);
    }

    act(() => {
      result.current.tick();
    });
    expect(gpuTickSpy).toHaveBeenCalledTimes(1);
    expect(cpuTick).not.toHaveBeenCalled();

    // Readback syncs GPU positions back into the CPU-side node objects.
    await waitFor(() => {
      for (const n of result.current.sim.nodes) {
        expect(Number.isFinite(n.x)).toBe(true);
        expect(Number.isFinite(n.y)).toBe(true);
        expect(Number.isFinite(n.z)).toBe(true);
      }
    });

    result.current.dispose();
  });

  it('re-uploads the graph when the node count changes', async () => {
    const mock = createMockGPU();
    installMockGPU(mock.gpu);

    const uploadSpy = vi.spyOn(WebGPUForceEngine.prototype, 'uploadGraph');

    const { result } = renderHook(() => useWebGPUSimulation('auto'));
    await waitFor(() => expect(result.current.gpuActive).toBe(true));

    act(() => {
      result.current.update(
        [makeTopToken({ tokenAddress: 'A' }), makeTopToken({ tokenAddress: 'B' })],
        [],
      );
    });
    expect(uploadSpy).toHaveBeenCalledTimes(1);
    expect(uploadSpy.mock.calls[0][0]).toHaveLength(2);

    act(() => {
      result.current.update(
        [
          makeTopToken({ tokenAddress: 'A' }),
          makeTopToken({ tokenAddress: 'B' }),
          makeTopToken({ tokenAddress: 'C' }),
        ],
        [],
      );
    });
    expect(uploadSpy).toHaveBeenCalledTimes(2);
    expect(uploadSpy.mock.calls[1][0]).toHaveLength(3);

    // The engine rebuilt its buffers for the new node count.
    const positionBuffers = mock.buffers.filter((b) => b.usage & 0x0080);
    const live = positionBuffers.filter((b) => !b.destroyed);
    expect(live[0].size).toBe(3 * 16);

    result.current.dispose();
  });

  it('handles updates with zero nodes while GPU is active', async () => {
    const mock = createMockGPU();
    installMockGPU(mock.gpu);

    const { result } = renderHook(() => useWebGPUSimulation('auto'));
    await waitFor(() => expect(result.current.gpuActive).toBe(true));

    act(() => {
      result.current.update([], []);
    });
    expect(() => {
      act(() => {
        result.current.tick();
      });
    }).not.toThrow();
    expect(mock.dispatches).toHaveLength(0);

    result.current.dispose();
  });

  it('disposes the GPU engine and CPU sim on dispose and unmount', async () => {
    const mock = createMockGPU();
    installMockGPU(mock.gpu);

    const engineDispose = vi.spyOn(WebGPUForceEngine.prototype, 'dispose');
    const simDispose = vi.spyOn(ForceGraphSimulation.prototype, 'dispose');

    const { result, unmount } = renderHook(() => useWebGPUSimulation('auto'));
    await waitFor(() => expect(result.current.gpuActive).toBe(true));

    act(() => {
      result.current.update([makeTopToken()], []);
    });

    result.current.dispose();
    expect(engineDispose).toHaveBeenCalled();
    expect(simDispose).toHaveBeenCalledTimes(1);
    expect(mock.buffers.every((b) => b.destroyed)).toBe(true);
    expect(mock.device.destroy).toHaveBeenCalledTimes(1);

    // Unmount must not throw or double-destroy.
    expect(() => unmount()).not.toThrow();
    expect(mock.device.destroy).toHaveBeenCalledTimes(1);
  });
});

import type { ModuleParams } from '../../types/graph';

export interface ConnectionSource {
  buffer: Float32Array;
  sourceId: string;
  sourcePort: string;
}

export abstract class Module {
  id: string;
  kind: string;
  params: ModuleParams;
  inputs: Record<string, Float32Array>;
  outputs: Record<string, Float32Array>;
  inputConnections: Record<string, ConnectionSource[]>;
  scratchBuffers: Map<string, Float32Array>;

  constructor(id: string, kind: string, params: ModuleParams = {}) {
    this.id = id;
    this.kind = kind;
    this.params = params;
    this.inputs = {};
    this.outputs = {};
    this.inputConnections = {};
    this.scratchBuffers = new Map();
  }

  abstract process(): void;

  /**
   * Live parameter update from the UI. Subclasses that cache params in
   * fields override applyParams() to re-read them; there is no rebuild, so
   * oscillator phases and delay buffers survive the change.
   */
  setParam(key: string, value: number | string): void {
    (this.params as Record<string, number | string>)[key] = value;
    this.applyParams();
  }

  /**
   * Replaces this module's whole parameter set when a graph reload reuses the
   * instance. Every incoming value is pushed through setParam() — the same
   * path a live UI edit takes — so cached fields are refreshed without
   * touching DSP state (oscillator phase, delay buffer, slew value). Params
   * absent from `params` fall back to the module's defaults.
   */
  replaceParams(params: ModuleParams): void {
    this.params = {};
    let applied = false;
    for (const [key, value] of Object.entries(params) as Array<
      [string, number | string | undefined]
    >) {
      if (value === undefined) continue;
      this.setParam(key, value);
      applied = true;
    }
    // With no incoming params no setParam() ran applyParams(); do it here so
    // omitted params fall back to the module's defaults.
    if (!applied) this.applyParams();
  }

  protected applyParams(): void {}

  getScratchBuffer(): Float32Array {
    if (!this.scratchBuffers.has('temp')) {
      this.scratchBuffers.set('temp', new Float32Array(128));
    }
    return this.scratchBuffers.get('temp')!;
  }
}

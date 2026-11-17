import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { decibelsToGain } from '@/core/audio/gain-staging'
import { DEFAULT_LIMITER_CEILING_DB, lookaheadMsToSamples } from '@/core/audio-dsp/peak-limiter'
import { LIMITER_PROCESSOR_NAME, type LimiterTelemetryMessage } from '@/audio/worklets/limiter-message'

const { MockGain } = vi.hoisted(() => {
  class MockGain {
    input = { connect: vi.fn() }
    connect = vi.fn()
    disconnect = vi.fn()
    dispose = vi.fn()
    toDestination = vi.fn()
    gain = { rampTo: vi.fn(), value: 1 }
  }
  return { MockGain }
})

vi.mock('tone', () => ({
  Gain: MockGain,
  getContext: vi.fn(() => ({ rawContext: undefined, state: 'running' }))
}))

import { MasterOutput } from '@/audio/mixer/master-output'

interface FakeWorkletNode {
  port: {
    onmessage: ((event: MessageEvent<LimiterTelemetryMessage>) => void) | null
    postMessage: ReturnType<typeof vi.fn>
  }
  connect: ReturnType<typeof vi.fn>
  disconnect: ReturnType<typeof vi.fn>
  context: unknown
  name: string
}

let workletInstances: FakeWorkletNode[] = []

class FakeAudioWorkletNode implements FakeWorkletNode {
  port = { onmessage: null as FakeWorkletNode['port']['onmessage'], postMessage: vi.fn() }
  connect = vi.fn()
  disconnect = vi.fn()
  context: unknown
  name: string

  constructor(context: unknown, name: string, _options?: AudioWorkletNodeOptions) {
    this.context = context
    this.name = name
    workletInstances.push(this)
  }
}

function createContext(options: { failModule?: boolean; usableFallback?: boolean } = {}): BaseAudioContext {
  const context: Record<string, unknown> = {
    sampleRate: 48000,
    audioWorklet: {
      addModule: options.failModule
        ? vi.fn().mockRejectedValue(new Error('worklet blocked'))
        : vi.fn().mockResolvedValue(undefined)
    }
  }
  if (options.usableFallback !== false) {
    context.createGain = vi.fn(() => ({ gain: { value: 1 }, connect: vi.fn(), disconnect: vi.fn() }))
    context.createWaveShaper = vi.fn(() => ({
      curve: null,
      oversample: 'none',
      connect: vi.fn(),
      disconnect: vi.fn()
    }))
  }
  return context as unknown as BaseAudioContext
}

describe('MasterOutput protection runtime', () => {
  beforeEach(() => {
    workletInstances = []
    vi.stubGlobal('AudioWorkletNode', FakeAudioWorkletNode)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('installs the limiter worklet as the final stage and reports latency', async () => {
    const output = new MasterOutput()
    const context = createContext()
    const createNode = vi.fn(
      (name: string, options: AudioWorkletNodeOptions) =>
        new FakeAudioWorkletNode(context, name, options) as unknown as AudioWorkletNode
    )

    const ready = await output.initialize(context, createNode)

    expect(ready).toBe(true)
    expect(output.isActive()).toBe(true)
    expect(output.getStatus()).toBe('active')
    expect(output.getError()).toBeNull()
    expect(createNode).toHaveBeenCalledWith(LIMITER_PROCESSOR_NAME, expect.any(Object))

    const node = workletInstances[0]
    expect(node.name).toBe(LIMITER_PROCESSOR_NAME)
    expect(node.port.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'config', ceilingDb: DEFAULT_LIMITER_CEILING_DB })
    )

    const snapshot = output.getSnapshot()
    expect(snapshot.latencySamples).toBe(lookaheadMsToSamples(2, 48000))
    expect(snapshot.latencyMs).toBeCloseTo(2, 6)
    expect(output.getLatencySeconds()).toBeCloseTo(0.002, 9)
    expect(snapshot.ceilingDb).toBe(DEFAULT_LIMITER_CEILING_DB)

    output.dispose()
  })

  it('exposes gain reduction and post-protection telemetry from the worklet', async () => {
    const output = new MasterOutput()
    await output.initialize(createContext())
    const node = workletInstances[0]

    const message: LimiterTelemetryMessage = {
      type: 'telemetry',
      gainReductionDb: 3.5,
      maxGainReductionDb: 6.25,
      sanitizedSamples: 4,
      latencySamples: 96,
      postProtection: {
        leftPeakDb: -1,
        rightPeakDb: -1.2,
        leftRmsDb: -12,
        rightRmsDb: -12.4,
        overloadSamples: 0,
        nonFiniteSamples: 0,
        frames: 2048
      }
    }
    node.port.onmessage?.({ data: message } as MessageEvent<LimiterTelemetryMessage>)

    expect(output.getGainReductionDb()).toBe(3.5)
    const snapshot = output.getSnapshot()
    expect(snapshot.maxGainReductionDb).toBe(6.25)
    expect(snapshot.sanitizedSamples).toBe(4)
    expect(snapshot.postProtection?.leftPeakDb).toBe(-1)

    output.resetTelemetry()
    expect(output.getGainReductionDb()).toBe(0)
    expect(output.getSnapshot().postProtection).toBeNull()

    output.dispose()
  })

  it('marks a visible bounded fallback when the worklet cannot load', async () => {
    const output = new MasterOutput()
    const context = createContext({ failModule: true })

    const ready = await output.initialize(context)

    expect(ready).toBe(false)
    expect(output.isActive()).toBe(false)
    expect(output.getStatus()).toBe('fallback')
    expect(output.getError()).toContain('worklet blocked')
    expect(output.getLatencySeconds()).toBe(0)
    expect(context.createWaveShaper).toHaveBeenCalled()

    const clip = (context.createWaveShaper as ReturnType<typeof vi.fn>).mock.results[0].value as {
      curve: Float32Array
    }
    for (const value of clip.curve) {
      expect(Math.abs(value)).toBeLessThanOrEqual(decibelsToGain(DEFAULT_LIMITER_CEILING_DB) + 1e-9)
    }

    output.dispose()
  })

  it('flags failure instead of silently passing audio when even the fallback is impossible', async () => {
    const output = new MasterOutput()
    const context = createContext({ failModule: true, usableFallback: false })

    const ready = await output.initialize(context)

    expect(ready).toBe(false)
    expect(output.getStatus()).toBe('failed')
    expect(output.getError()).toContain('Fallback protection unavailable')

    output.dispose()
  })

  it('reports zeroed telemetry in the fallback snapshot instead of stale worklet readings', async () => {
    const output = new MasterOutput()
    const context = createContext({ failModule: true })

    await output.initialize(context)

    const snapshot = output.getSnapshot()
    expect(snapshot.status).toBe('fallback')
    expect(snapshot.error).toContain('worklet blocked')
    expect(snapshot.latencySamples).toBe(0)
    expect(snapshot.latencyMs).toBe(0)
    expect(snapshot.gainReductionDb).toBe(0)
    expect(snapshot.maxGainReductionDb).toBe(0)
    expect(snapshot.sanitizedSamples).toBe(0)
    expect(snapshot.postProtection).toBeNull()
    expect(output.getGainReductionDb()).toBe(0)
    expect(output.getLatencySeconds()).toBe(0)

    output.dispose()
  })

  it('ignores late worklet telemetry that arrives after a downgrade', async () => {
    const output = new MasterOutput()
    await output.initialize(createContext({ failModule: true }))
    expect(output.getStatus()).toBe('fallback')

    const lateMessage: LimiterTelemetryMessage = {
      type: 'telemetry',
      gainReductionDb: 9.5,
      maxGainReductionDb: 12,
      sanitizedSamples: 7,
      latencySamples: 96,
      postProtection: {
        leftPeakDb: -0.5,
        rightPeakDb: -0.6,
        leftRmsDb: -10,
        rightRmsDb: -10.2,
        overloadSamples: 0,
        nonFiniteSamples: 0,
        frames: 1920
      }
    }
    const handler = (output as unknown as { handleMessage: (message: LimiterTelemetryMessage) => void }).handleMessage
    handler.call(output, lateMessage)

    const snapshot = output.getSnapshot()
    expect(snapshot.gainReductionDb).toBe(0)
    expect(snapshot.maxGainReductionDb).toBe(0)
    expect(snapshot.sanitizedSamples).toBe(0)
    expect(snapshot.latencySamples).toBe(0)
    expect(snapshot.postProtection).toBeNull()

    output.dispose()
  })

  it('pushes ceiling changes to the worklet while active', async () => {
    const output = new MasterOutput()
    await output.initialize(createContext())
    const node = workletInstances[0]
    node.port.postMessage.mockClear()

    output.setCeilingDb(-6)

    expect(output.getCeilingDb()).toBe(-6)
    expect(output.getSnapshot().ceilingDb).toBe(-6)
    expect(node.port.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'config', ceilingDb: -6 }))

    output.dispose()
  })

  it('clamps ceiling changes to the supported range', async () => {
    const output = new MasterOutput()
    await output.initialize(createContext())

    output.setCeilingDb(5)
    expect(output.getCeilingDb()).toBe(0)
    output.setCeilingDb(-99)
    expect(output.getCeilingDb()).toBe(-24)

    output.dispose()
  })

  it('recomputes the fallback clip curve when the ceiling changes in fallback', async () => {
    const output = new MasterOutput()
    const context = createContext({ failModule: true })
    await output.initialize(context)
    expect(output.getStatus()).toBe('fallback')

    const clip = (context.createWaveShaper as ReturnType<typeof vi.fn>).mock.results[0].value as {
      curve: Float32Array | null
    }
    const originalCurve = clip.curve

    output.setCeilingDb(-12)

    expect(output.getSnapshot().ceilingDb).toBe(-12)
    expect(clip.curve).not.toBe(originalCurve)
    const newCeiling = decibelsToGain(-12)
    for (const value of clip.curve!) {
      expect(Math.abs(value)).toBeLessThanOrEqual(newCeiling + 1e-9)
    }
    expect(clip.curve![clip.curve!.length - 1]).toBeCloseTo(newCeiling, 6)

    output.dispose()
  })

  it('keeps the failure visible when the ceiling changes on the failed path', async () => {
    const output = new MasterOutput()
    const context = createContext({ failModule: true, usableFallback: false })
    await output.initialize(context)
    expect(output.getStatus()).toBe('failed')

    output.setCeilingDb(-6)

    // The new value is stored for a future re-initialization, but the error stays visible and
    // the failed snapshot never reports live telemetry.
    expect(output.getCeilingDb()).toBe(-6)
    expect(output.getStatus()).toBe('failed')
    expect(output.getError()).toContain('Fallback protection unavailable')
    const snapshot = output.getSnapshot()
    expect(snapshot.status).toBe('failed')
    expect(snapshot.error).toBeTruthy()
    expect(snapshot.ceilingDb).toBe(-6)
    expect(snapshot.gainReductionDb).toBe(0)
    expect(snapshot.postProtection).toBeNull()

    output.dispose()
  })
})

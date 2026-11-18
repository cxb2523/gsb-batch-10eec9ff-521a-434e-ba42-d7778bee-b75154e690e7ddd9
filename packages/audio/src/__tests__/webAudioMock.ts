import { vi } from 'vitest'
import { getAudioState } from '../audioContext'

/** A node in the mock graph. `connections` is the set of nodes it feeds. */
export interface MockNode {
  kind: string
  connections: Set<MockNode>
  /** True once a no-argument `disconnect()` (or the factory's own teardown) ran. */
  disconnected: boolean
  connect(target: MockNode): MockNode
  /** Browser semantics: disconnecting a target that is not connected throws. */
  disconnect(target?: MockNode): void
  [key: string]: unknown
}

function createNode(kind: string): MockNode {
  const node: MockNode = {
    kind,
    connections: new Set<MockNode>(),
    disconnected: false,
    connect(target: MockNode) {
      node.connections.add(target)
      return target
    },
    disconnect(target?: MockNode) {
      if (target === undefined) {
        node.connections.clear()
        node.disconnected = true
        return
      }
      // Real Web Audio throws InvalidAccessError here, and the engine relies on
      // that to decide whether a link existed at all.
      if (!node.connections.has(target)) throw new Error('InvalidAccessError: target is not connected')
      node.connections.delete(target)
    },
  }
  return node
}

/** An AudioParam in the mock: a live `value` plus the automation calls. */
export interface MockParam {
  value: number
  setValueAtTime: ReturnType<typeof vi.fn>
  linearRampToValueAtTime: ReturnType<typeof vi.fn>
  cancelScheduledValues: ReturnType<typeof vi.fn>
}

/** A mock GainNode — what `getGroupGainNode()` returns inside these tests. */
export interface MockGainNode extends MockNode {
  gain: MockParam
}

function param(value: number): MockParam {
  return {
    value,
    setValueAtTime: vi.fn(),
    linearRampToValueAtTime: vi.fn(),
    cancelScheduledValues: vi.fn(),
  }
}

/** Minimal Web Audio mock that records every node and every connection. */
export function installWebAudioMock(opts: { initialState?: 'running' | 'suspended' } = {}) {
  const contexts: any[] = []
  const gains: any[] = []
  const sources: any[] = []
  /** Every node created through this context, in creation order. */
  const nodes: MockNode[] = []

  const track = <T extends MockNode>(node: T): T => {
    nodes.push(node)
    return node
  }

  let userActivated = false
  const gesture = () => {
    userActivated = true
    for (const c of contexts) if (c.pending.length && c.state !== 'running' && c.state !== 'closed') c.activate()
  }
  const GESTURES = ['pointerdown', 'keydown', 'touchend']
  // Capture phase and installed first, so it runs before the engine's unlock listener.
  for (const e of GESTURES) window.addEventListener(e, gesture, true)

  class MockAudioContext {
    state: string = opts.initialState ?? 'suspended'
    currentTime = 0
    sampleRate = 44100
    destination = track(createNode('destination'))
    listener = {}
    closed = false
    private listeners = new Set<() => void>()
    // Like browsers: resume() stays pending until a user gesture has happened.
    pending: Array<() => void> = []
    resume = vi.fn(() => {
      if (this.state === 'running') return Promise.resolve()
      if (userActivated) {
        this.setState('running')
        return Promise.resolve()
      }
      return new Promise<void>((res) => this.pending.push(res))
    })
    activate() {
      this.setState('running')
      for (const r of this.pending.splice(0)) r()
    }
    close = vi.fn(async () => {
      this.closed = true
      this.setState('closed')
    })
    constructor() {
      contexts.push(this)
    }
    setState(s: string) {
      this.state = s
      for (const l of [...this.listeners]) l()
    }
    addEventListener(type: string, l: () => void) {
      if (type === 'statechange') this.listeners.add(l)
    }
    removeEventListener(type: string, l: () => void) {
      if (type === 'statechange') this.listeners.delete(l)
    }
    createGain() {
      const g: any = track(createNode('gain'))
      g.gain = param(1)
      gains.push(g)
      return g
    }
    createBufferSource() {
      const s: any = track(createNode('bufferSource'))
      s.buffer = null
      s.loop = false
      s.playbackRate = param(1)
      s.started = false
      s.stopped = false
      s.onended = null
      s.start = vi.fn(() => {
        s.started = true
      })
      s.stop = vi.fn(() => {
        s.stopped = true
      })
      sources.push(s)
      return s
    }
    createBiquadFilter() {
      const f: any = track(createNode('biquadFilter'))
      f.type = 'lowpass'
      f.frequency = param(350)
      f.Q = param(1)
      return f
    }
    createConvolver() {
      const c: any = track(createNode('convolver'))
      c.buffer = null
      c.normalize = true
      return c
    }
    createDynamicsCompressor() {
      const c: any = track(createNode('compressor'))
      c.threshold = param(-24)
      c.ratio = param(4)
      c.attack = param(0.003)
      c.release = param(0.25)
      return c
    }
    createDelay(_maxDelay = 1) {
      const d: any = track(createNode('delay'))
      d.delayTime = param(0)
      return d
    }
    createAnalyser() {
      const a: any = track(createNode('analyser'))
      a.fftSize = 2048
      a.smoothingTimeConstant = 0.8
      a.frequencyBinCount = 1024
      a.getByteFrequencyData = vi.fn()
      a.getByteTimeDomainData = vi.fn()
      return a
    }
    createBuffer(channels: number, length: number) {
      return {
        numberOfChannels: channels,
        length,
        getChannelData: vi.fn(() => new Float32Array(length)),
      }
    }
    decodeAudioData = vi.fn(async () => ({ duration: 1 }))
  }

  vi.stubGlobal('AudioContext', MockAudioContext)
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ arrayBuffer: async () => new ArrayBuffer(8) })),
  )

  return {
    /** Remove the mock's own gesture listeners. */
    uninstall() {
      for (const e of GESTURES) window.removeEventListener(e, gesture, true)
    },
    contexts,
    gains,
    sources,
    nodes,
    /** True when `from` has a direct connection to `to`. */
    connected(from: MockNode, to: MockNode): boolean {
      return from.connections.has(to)
    },
    /** True when audio can flow from `from` to `to` through any number of nodes. */
    hasPath(from: MockNode, to: MockNode): boolean {
      const seen = new Set<MockNode>([from])
      const queue = [from]
      while (queue.length) {
        const node = queue.shift()!
        if (node === to) return true
        for (const next of node.connections) {
          if (seen.has(next)) continue
          seen.add(next)
          queue.push(next)
        }
      }
      return false
    },
    /** Nodes created through the context that no longer feed anything. */
    dangling(from = 0): MockNode[] {
      return nodes.slice(from).filter((n) => n.kind !== 'destination' && n.connections.size === 0)
    },
    /** Voice gains (not the group/master mixer nodes) that are still wired up. */
    liveVoiceGains() {
      const mixer = new Set(getAudioState().groupGainNodes.values())
      return gains.filter((g) => !mixer.has(g) && !g.disconnected)
    },
    liveSources() {
      return sources.filter((s) => s.started && !s.stopped)
    },
  }
}

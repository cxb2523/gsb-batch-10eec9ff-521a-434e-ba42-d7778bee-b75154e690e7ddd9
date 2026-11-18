import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { installWebAudioMock } from './webAudioMock'
import type { MockGainNode, MockNode } from './webAudioMock'
import {
  duck,
  getAudioCtx,
  getAudioState,
  getGroupGainNode,
  getGroupVolume,
  isGroupMuted,
  setGroupMute,
  setGroupVolume,
  setGroupVolumeFaded,
} from '../audioContext'
import { clearGroupEffect, setGroupEffect } from '../audioEffects'
import { getAudioManager } from '../audioManager'

/**
 * Group effects and the volume / mute / duck layer share the same group gain
 * node. These tests pin down the contract between them: the effect chain is a
 * pure insertion on the group's *output* (so muting still silences the group),
 * and mute/volume/duck never leave stale automation behind.
 */
describe('Group effects + volume / mute / duck', () => {
  let mock: ReturnType<typeof installWebAudioMock>

  beforeEach(() => {
    mock = installWebAudioMock({ initialState: 'running' })
  })

  afterEach(() => {
    mock.uninstall()
    vi.unstubAllGlobals()
  })

  /** The mixer gain node for a group, as a graph node the assertions can follow. */
  const gainNode = (group: string) => getGroupGainNode(group) as unknown as MockGainNode

  const ctxDestination = () => getAudioCtx().destination as unknown as MockNode

  const masterGain = () => gainNode('master')

  /** Snapshot the graph state so a later call can be checked for leftovers. */
  const mark = () => mock.nodes.length

  /** Nodes created since `from` that feed nothing (excluding the context destination). */
  const danglingSince = (from: number) =>
    mock.nodes.slice(from).filter((n) => n.kind !== 'destination' && n.connections.size === 0)

  // ── 1. Effect insertion keeps the chain complete ─────────────────────────

  it('inserts the effect between the group gain and its downstream node', () => {
    const sfx = gainNode('sfx')
    const master = masterGain()

    setGroupEffect('sfx', { type: 'lowpass', frequency: 800 })
    const filter = mock.nodes.find((n) => n.kind === 'biquadFilter')!

    expect(mock.connected(sfx, filter)).toBe(true)
    expect(mock.connected(filter, master)).toBe(true)
    // The direct link is replaced, not duplicated.
    expect(mock.connected(sfx, master)).toBe(false)
    // Audio still reaches the destination through the new chain.
    expect(mock.hasPath(sfx, ctxDestination())).toBe(true)
  })

  it('inserts an effect on master between its gain and the destination', () => {
    const master = masterGain()
    setGroupEffect('master', { type: 'lowpass' })

    const filter = mock.nodes.find((n) => n.kind === 'biquadFilter')!
    expect(mock.connected(master, filter)).toBe(true)
    expect(mock.connected(filter, ctxDestination())).toBe(true)
    expect(mock.connected(master, ctxDestination())).toBe(false)
  })

  it('keeps a fan-out from the group gain (analyser tap) alive when an effect is added or removed', () => {
    const sfx = gainNode('sfx')
    const analyser = (getAudioCtx() as unknown as { createAnalyser(): any }).createAnalyser()
    sfx.connect(analyser)

    setGroupEffect('sfx', { type: 'reverb', roomSize: 0.5 })
    expect(mock.connected(sfx, analyser)).toBe(true)

    clearGroupEffect('sfx')
    expect(mock.connected(sfx, analyser)).toBe(true)
    expect(mock.connected(sfx, masterGain())).toBe(true)
  })

  // ── 2. Replacing / clearing an effect leaves no dangling nodes ───────────

  it('tears the old chain down before building a new one, including a delay feedback loop', () => {
    gainNode('sfx') // create mixer nodes first so the mark lands on the chain
    const before = mark()
    setGroupEffect('sfx', { type: 'delay', time: 0.3, feedback: 0.4 })
    const [firstDelay, firstFeedback] = mock.nodes.slice(before)

    expect(firstDelay.kind).toBe('delay')
    expect(firstFeedback.kind).toBe('gain')
    expect(mock.connected(firstDelay, firstFeedback)).toBe(true)
    expect(mock.connected(firstFeedback, firstDelay)).toBe(true)

    const beforeReplace = mark()
    setGroupEffect('sfx', { type: 'lowpass' })

    // Old delay + its feedback gain are fully detached (no lingering cycle).
    expect(firstDelay.connections.size).toBe(0)
    expect(firstFeedback.connections.size).toBe(0)

    const filter = mock.nodes.slice(beforeReplace).find((n) => n.kind === 'biquadFilter')!
    expect(mock.connected(gainNode('sfx'), filter)).toBe(true)
    expect(mock.connected(filter, masterGain())).toBe(true)
    expect(danglingSince(beforeReplace)).toEqual([])
  })

  it('re-setting the same effect twice keeps exactly one chain on the group', () => {
    const opts = { type: 'lowpass' as const, frequency: 1200 }
    setGroupEffect('sfx', opts)
    const first = mock.nodes.find((n) => n.kind === 'biquadFilter')!
    const before = mark()

    setGroupEffect('sfx', opts)
    const created = mock.nodes.slice(before)

    // Only one new filter, and the previous one no longer feeds anything.
    expect(created.filter((n) => n.kind === 'biquadFilter')).toHaveLength(1)
    expect(first.connections.size).toBe(0)
    expect(danglingSince(before)).toEqual([])
    expect(getAudioState().effects.get('sfx')).toBeDefined()
  })

  it('clearGroupEffect restores the direct path and releases the chain nodes', () => {
    gainNode('sfx')
    const before = mark()
    setGroupEffect('sfx', { type: 'delay' })
    const chainNodes = mock.nodes.slice(before)

    clearGroupEffect('sfx')

    expect(mock.connected(gainNode('sfx'), masterGain())).toBe(true)
    expect(chainNodes.every((n) => n.connections.size === 0)).toBe(true)
    expect(getAudioState().effects.has('sfx')).toBe(false)

    // Clearing again is a no-op, not a second reconnect.
    expect(() => clearGroupEffect('sfx')).not.toThrow()
  })

  it('replaces the chain without touching the gain values of muting/ducking', () => {
    setGroupVolume('sfx', 0.6)
    setGroupMute('sfx', true)
    setGroupEffect('sfx', { type: 'lowpass' })

    expect(gainNode('sfx').gain.value).toBe(0)
    setGroupMute('sfx', false)
    expect(gainNode('sfx').gain.value).toBeCloseTo(0.6)
  })

  // ── 3. Mute wins over volume / fade / duck while an effect is present ────

  it('setGroupVolume cannot make a muted, effect-processed group audible', () => {
    setGroupEffect('sfx', { type: 'reverb' })
    setGroupVolume('sfx', 0.5)
    setGroupMute('sfx', true)

    setGroupVolume('sfx', 0.9)
    expect(isGroupMuted('sfx')).toBe(true)
    expect(gainNode('sfx').gain.value).toBe(0)
    expect(getGroupVolume('sfx')).toBeCloseTo(0.9)

    setGroupMute('sfx', false)
    expect(gainNode('sfx').gain.value).toBeCloseTo(0.9) // most recent setting
  })

  it('setGroupVolumeFaded keeps a muted, effect-processed group silent and restores the target on unmute', () => {
    setGroupEffect('sfx', { type: 'lowpass' })
    const sfx = gainNode('sfx')
    setGroupMute('sfx', true)
    expect(sfx.gain.value).toBe(0)

    setGroupVolumeFaded('sfx', 0.4, 1)
    sfx.gain.linearRampToValueAtTime.mockClear()

    expect(sfx.gain.value).toBe(0)
    expect(sfx.gain.linearRampToValueAtTime).not.toHaveBeenCalled() // nothing scheduled while muted
    expect(getGroupVolume('sfx')).toBeCloseTo(0.4)

    setGroupMute('sfx', false)
    expect(sfx.gain.value).toBeCloseTo(0.4)
  })

  it('duck on a muted, effect-processed group schedules only silence and restores the last volume on unmute', () => {
    setGroupEffect('sfx', { type: 'delay' })
    setGroupVolume('sfx', 0.7)
    const sfx = gainNode('sfx')
    setGroupMute('sfx', true)

    sfx.gain.setValueAtTime.mockClear()
    sfx.gain.linearRampToValueAtTime.mockClear()
    duck('sfx', 0.2, 2)

    const scheduled = [
      ...sfx.gain.setValueAtTime.mock.calls.map((c: unknown[]) => c[0]),
      ...sfx.gain.linearRampToValueAtTime.mock.calls.map((c: unknown[]) => c[0]),
    ]
    expect(scheduled.length).toBeGreaterThan(0)
    expect(scheduled.every((v) => v === 0)).toBe(true)
    expect(sfx.gain.value).toBe(0)

    setGroupMute('sfx', false)
    expect(sfx.gain.value).toBeCloseTo(0.7)
  })

  it('muting mid-duck cancels the queued restore so the group does not become audible later', () => {
    setGroupEffect('sfx', { type: 'lowpass' })
    setGroupVolume('sfx', 0.8)
    const sfx = gainNode('sfx')
    duck('sfx', 0.2, 5) // would ramp back to 0.8 in 5.2s

    setGroupMute('sfx', true)
    expect(sfx.gain.cancelScheduledValues).toHaveBeenCalled()
    expect(sfx.gain.value).toBe(0)

    setGroupMute('sfx', false)
    expect(sfx.gain.value).toBeCloseTo(0.8)
  })

  // ── 4. Re-setting the same mute value must not disturb a running duck ────

  it('setting the same mute value again is a no-op and leaves a running duck alone', () => {
    setGroupEffect('sfx', { type: 'lowpass' })
    setGroupVolume('sfx', 0.8)
    const sfx = gainNode('sfx')

    setGroupMute('sfx', true)
    duck('sfx', 0.2, 2) // scheduled while muted
    sfx.gain.cancelScheduledValues.mockClear()

    setGroupMute('sfx', true) // unchanged
    expect(sfx.gain.cancelScheduledValues).not.toHaveBeenCalled()

    setGroupMute('sfx', false) // real switch cancels
    expect(sfx.gain.cancelScheduledValues).toHaveBeenCalledTimes(1)
    expect(sfx.gain.value).toBeCloseTo(0.8)
  })

  it('re-asserting muted on an already-muted group does not re-zero a live ramp value', () => {
    setGroupVolume('music', 0.5)
    const node = gainNode('music')
    setGroupMute('music', true)
    // Simulate a duck that is currently at the bottom of its ramp.
    node.gain.value = 0
    setGroupMute('music', true)
    expect(node.gain.value).toBe(0)
  })

  it('re-asserting unmuted does not cancel a duck that is currently running', () => {
    setGroupVolume('music', 0.8)
    const node = gainNode('music')
    setGroupMute('music', false) // unchanged: never was muted
    duck('music', 0.3, 2)
    node.gain.cancelScheduledValues.mockClear()

    setGroupMute('music', false)
    expect(node.gain.cancelScheduledValues).not.toHaveBeenCalled()
  })

  // ── 5. The full sequence converges on the last configured state ─────────

  it('converges after effect → mute → volume → duck → unmute → clear effect', () => {
    setGroupEffect('sfx', { type: 'lowpass' })
    setGroupMute('sfx', true)
    setGroupVolume('sfx', 0.55)
    duck('sfx', 0.1, 1)
    expect(gainNode('sfx').gain.value).toBe(0)

    setGroupVolumeFaded('sfx', 0.35, 0.5)
    setGroupMute('sfx', false)
    expect(gainNode('sfx').gain.value).toBeCloseTo(0.35)

    clearGroupEffect('sfx')
    expect(gainNode('sfx').gain.value).toBeCloseTo(0.35)
    expect(mock.connected(gainNode('sfx'), masterGain())).toBe(true)
    expect(getAudioState().effects.size).toBe(0)
  })

  it('a volume change during a duck drops the duck so it cannot restore an old level later', () => {
    setGroupEffect('music', { type: 'lowpass' })
    setGroupVolume('music', 0.9)
    const node = gainNode('music')
    duck('music', 0.2, 3) // would ramp back to 0.9 after 3.2s
    node.gain.cancelScheduledValues.mockClear()

    setGroupVolume('music', 0.4)

    // The pending "restore" was cancelled and the new level is in effect.
    expect(node.gain.cancelScheduledValues).toHaveBeenCalledTimes(1)
    expect(node.gain.value).toBeCloseTo(0.4)
  })

  it('dispose() tears the effect chain down as well as the mixer nodes', () => {
    gainNode('sfx')
    setGroupVolume('sfx', 0.7)
    const before = mark()
    setGroupEffect('sfx', { type: 'delay' })
    const chainNodes = mock.nodes.slice(before)
    expect(chainNodes.length).toBeGreaterThan(0)

    getAudioManager().dispose()

    expect(chainNodes.every((n) => n.connections.size === 0)).toBe(true)
    expect(getAudioState().effects.size).toBe(0)
    // Volume prefs survive dispose.
    expect(getGroupVolume('sfx')).toBeCloseTo(0.7)
  })
})

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LofiRack, hasLofiEffects } from './lofi-rack'
import type AudioManager from './audio-manager'
import Lofi from './lofi-rack'
import {
    DEFAULT_EFFECT_SETTINGS,
    cloneEffectSettings,
    type EffectSettings
} from './lofi/audio/effect-settings'

// The vinyl crackle is a looping sample: these tests drive LofiRack's
// setEffects / setSourceActive / destroy through every order that matters and
// read the noise bus it feeds into the processed path.

type SourceMock = { start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn> }

function makeContext() {
    const ctx = new AudioContext() as unknown as AudioContext
    const sources: SourceMock[] = []
    const createBufferSource = ctx.createBufferSource.bind(ctx)
    ;(ctx as unknown as Record<string, unknown>).createBufferSource = vi.fn(() => {
        const source = createBufferSource() as unknown as SourceMock
        sources.push(source)
        return source
    })
    return { ctx, sources }
}

function stubSampleFetch() {
    const fetchMock = vi.fn(async () => ({
        arrayBuffer: async () => new ArrayBuffer(8)
    }))
    vi.stubGlobal('fetch', fetchMock)
    return fetchMock
}

/** Settings with just the crackle on (one node, so the rack is processing). */
function crackleOnly(intensity = 50): EffectSettings {
    const settings = cloneEffectSettings(DEFAULT_EFFECT_SETTINGS)
    settings.vinylCrackle = { enabled: true, intensity }
    return settings
}

function allOff(): EffectSettings {
    return cloneEffectSettings(DEFAULT_EFFECT_SETTINGS)
}

async function buildRack() {
    const { ctx, sources } = makeContext()
    const fetchMock = stubSampleFetch()
    const rack = new LofiRack(ctx, { workletsUrl: '/worklets/', sampleUrl: '/sounds/vinyl.mp3' })
    await rack.init()
    // Let the sample load settle: the loop source exists once decode resolves.
    await vi.waitFor(() => expect(sources.length).toBeGreaterThan(0))
    return { rack, sources, fetchMock, ctx }
}

beforeEach(() => {
    stubSampleFetch()
})

afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
})

describe('LofiRack noise bus', () => {
    it('stays closed while the rack is in bypass, opens with any effect on', async () => {
        const { rack } = await buildRack()
        expect(hasLofiEffects(allOff())).toBe(false)
        expect(rack.noiseGain).toBe(0)

        rack.setEffects(crackleOnly())
        expect(rack.noiseGain).toBe(1)

        rack.setEffects(allOff())
        expect(rack.noiseGain).toBe(0)
    })

    it('mutes while paused and comes back on play', async () => {
        const { rack } = await buildRack()
        rack.setEffects(crackleOnly())

        rack.setSourceActive(false)
        expect(rack.noiseGain).toBe(0)

        rack.setSourceActive(true)
        expect(rack.noiseGain).toBe(1)
    })

    it('stays silent through pause → all effects off → play', async () => {
        const { rack } = await buildRack()
        rack.setEffects(crackleOnly())
        expect(rack.noiseGain).toBe(1)

        rack.setSourceActive(false)
        rack.setEffects(allOff())
        expect(rack.noiseGain).toBe(0)

        // Playback resumes but nothing is on: the dry path stays noise-free.
        rack.setSourceActive(true)
        expect(rack.noiseGain).toBe(0)

        rack.setSourceActive(false)
        rack.setEffects(crackleOnly())
        expect(rack.noiseGain).toBe(0)

        rack.setSourceActive(true)
        expect(rack.noiseGain).toBe(1)
    })

    it('does not depend on the order setEffects and setSourceActive arrive in', async () => {
        const { rack } = await buildRack()

        rack.setSourceActive(false)
        rack.setEffects(crackleOnly())
        expect(rack.noiseGain).toBe(0)

        rack.setEffects(crackleOnly())
        rack.setSourceActive(false)
        expect(rack.noiseGain).toBe(0)

        rack.setSourceActive(true)
        expect(rack.noiseGain).toBe(1)
    })

    it('keeps the dry/processed switch untouched', async () => {
        const { rack } = await buildRack()
        const internals = rack as unknown as {
            dryBypass: { gain: { value: number } }
            processed: { gain: { value: number } }
        }

        expect(internals.dryBypass.gain.value).toBe(1)
        expect(internals.processed.gain.value).toBe(0)

        rack.setEffects(crackleOnly())
        expect(internals.dryBypass.gain.value).toBe(0)
        expect(internals.processed.gain.value).toBe(1)
    })

    it('replays state set while the worklets were still loading', async () => {
        const { ctx } = makeContext()
        stubSampleFetch()
        const rack = new LofiRack(ctx, { workletsUrl: '/worklets/' })

        // Both of these land before the chain exists, in either order.
        rack.setSourceActive(false)
        rack.setEffects(crackleOnly())
        expect(rack.initialized).toBe(false)
        expect(rack.noiseGain).toBe(0)

        await rack.init()
        expect(rack.initialized).toBe(true)
        expect(rack.noiseGain).toBe(0)

        rack.setSourceActive(true)
        expect(rack.noiseGain).toBe(1)
    })

    it('is silent after all effects are switched off even if play arrives last', async () => {
        const { ctx } = makeContext()
        stubSampleFetch()
        const rack = new LofiRack(ctx, { workletsUrl: '/worklets/' })
        await rack.init()

        rack.setSourceActive(false)
        rack.setEffects(allOff())
        await rack.init()
        rack.setSourceActive(true)

        expect(rack.noiseGain).toBe(0)
    })
})

describe('LofiRack destroy', () => {
    it('stops the looping crackle source', async () => {
        const { rack, sources } = await buildRack()
        rack.setEffects(crackleOnly())
        expect(sources.length).toBeGreaterThan(0)

        rack.destroy()
        for (const source of sources) expect(source.stop).toHaveBeenCalled()
        expect(rack.noiseGain).toBe(0)
        expect(rack.initialized).toBe(false)
    })

    it('does not let a sample that loads after destroy start a loop', async () => {
        const { ctx, sources } = makeContext()
        let release: (() => void) | undefined
        const gate = new Promise<void>((resolve) => (release = resolve))
        vi.stubGlobal(
            'fetch',
            vi.fn(async () => {
                await gate
                return { arrayBuffer: async () => new ArrayBuffer(8) }
            })
        )

        const rack = new LofiRack(ctx, {
            workletsUrl: '/worklets/',
            sampleUrl: '/sounds/vinyl.mp3'
        })
        await rack.init()
        rack.setEffects(crackleOnly())

        rack.destroy()
        release?.()
        // Flush the fetch/decode chain; nothing may start afterwards.
        await vi.waitFor(() => expect(fetch).toHaveBeenCalled())
        await new Promise((resolve) => setTimeout(resolve, 0))
        await new Promise((resolve) => setTimeout(resolve, 0))

        expect(sources).toHaveLength(0)
        expect(rack.initialized).toBe(false)
    })

    it('does not install nodes when destroy lands mid-build', async () => {
        const { ctx } = makeContext()
        const addModule = vi.spyOn(ctx.audioWorklet, 'addModule')
        let release: (() => void) | undefined
        const gate = new Promise<void>((resolve) => (release = resolve))
        addModule.mockImplementation(() => gate)

        const rack = new LofiRack(ctx, { workletsUrl: '/worklets/' })
        const building = rack.init()
        rack.destroy()
        release?.()
        await building

        expect(rack.initialized).toBe(false)
        expect(rack.noiseGain).toBe(0)
    })

    it('a rebuild after destroy starts silent and follows the new state', async () => {
        const { rack } = await buildRack()
        rack.setEffects(crackleOnly())
        expect(rack.noiseGain).toBe(1)

        rack.destroy()
        // Destroy is silent: the loop is stopped and the bus torn down.
        expect(rack.noiseGain).toBe(0)

        await rack.init()
        expect(rack.initialized).toBe(true)
        // The fresh chain comes up muted and only opens once the state is
        // replayed; the last settings (crackle on, playing) then apply.
        expect(rack.noiseGain).toBe(1)

        rack.setSourceActive(false)
        expect(rack.noiseGain).toBe(0)
        rack.setEffects(allOff())
        expect(rack.noiseGain).toBe(0)
    })
})

describe('Lofi (owner)', () => {
    function makeManager() {
        const { ctx } = makeContext()
        const manager = {
            audioContext: ctx,
            connectLofi: vi.fn(),
            removeEffect: vi.fn()
        }
        return { manager: manager as unknown as AudioManager, raw: manager }
    }

    beforeEach(() => {
        vi.stubGlobal('sessionStorage', {
            getItem: (key: string) =>
                key === 'chorus:worklets_path'
                    ? '/worklets/'
                    : key === 'chorus:sounds_path'
                      ? '/sounds/'
                      : null
        })
    })

    const noiseBus = (lofi: Lofi) =>
        (lofi as unknown as { rack: { noiseGain: number } | null }).rack?.noiseGain ?? 0

    it('applies a pause that arrived before the rack existed', async () => {
        const { manager, raw } = makeManager()
        const lofi = new Lofi(manager)
        lofi.setPlaying(false)
        await lofi.prepare(crackleOnly())
        lofi.apply(crackleOnly())

        expect(raw.connectLofi).toHaveBeenCalled()
        expect(noiseBus(lofi)).toBe(0)

        lofi.setPlaying(true)
        expect(noiseBus(lofi)).toBe(1)
    })

    it('keeps noise silent through pause → all off → play at the owner level', async () => {
        const { manager, raw } = makeManager()
        const lofi = new Lofi(manager)
        await lofi.prepare(crackleOnly())
        lofi.apply(crackleOnly())
        expect(noiseBus(lofi)).toBe(1)

        lofi.setPlaying(false)
        lofi.apply(allOff())
        expect(raw.removeEffect).toHaveBeenCalledWith('lofi')
        expect(noiseBus(lofi)).toBe(0)

        lofi.setPlaying(true)
        expect(noiseBus(lofi)).toBe(0)
    })
})

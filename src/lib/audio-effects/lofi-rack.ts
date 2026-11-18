// Chorus's rack of the lovelofi effects (vendored under ./lofi, see its README):
// one input, one output, setEffects(settings). It mirrors lovelofi's
// GenEffectRack with two differences. Slowdown is left out, because Chorus slows
// the media element itself (quick-presets.ts turns a preset's slowdown into a
// playback rate). And the worklet and sample URLs come from the extension,
// since this runs inside the Spotify page where a relative path would 404.
import type AudioManager from './audio-manager'
import { LowPassEffect } from './lofi/audio/effects/low-pass'
import { HighPassEffect } from './lofi/audio/effects/high-pass'
import { TapeSaturationEffect } from './lofi/audio/effects/tape-saturation'
import { DEFAULT_REVERB_PROFILE, ReverbEffect } from './lofi/audio/effects/reverb'
import { BitcrusherEffect } from './lofi/audio/effects/bitcrusher'
import { ChorusEffect } from './lofi/audio/effects/chorus'
import { PitchWobbleEffect } from './lofi/audio/effects/pitch-wobble'
import { StereoDriftEffect } from './lofi/audio/effects/stereo-drift'
import { DropoutEffect } from './lofi/audio/effects/dropout'
import { VinylCrackleEffect } from './lofi/audio/effects/vinyl-crackle'
import { VocalCutEffect } from './lofi/audio/effects/vocal-cut'
import { EqualizerEffect } from './lofi/audio/effects/equalizer'
import {
    DEFAULT_EFFECT_SETTINGS,
    normalizeEffectSettings,
    type EffectSettings
} from './lofi/audio/effect-settings'

/** Worklet processors the rack registers, served from the extension's /worklets/. */
export const LOFI_WORKLETS = ['bitcrusher', 'pitch-wobble', 'stereo-drift', 'dropout', 'vocal-cut']

/** Whether any effect node would be doing work. Slowdown is a rate, not a node. */
export function hasLofiEffects(settings: EffectSettings): boolean {
    const { slowdown, equalizer, ...nodes } = settings
    void slowdown
    return Object.values(nodes).some((effect) => effect.enabled) || Boolean(equalizer?.enabled)
}

/**
 * Whether two settings differ only in intensities and EQ gains: the same
 * effects on, the same reverb space. Anything else means nodes join or leave
 * the chain, or an impulse response is regenerated, which wants the muted path.
 */
export function sameLofiShape(a: EffectSettings, b: EffectSettings): boolean {
    const { equalizer: eqA, ...nodesA } = a
    const { equalizer: eqB, ...nodesB } = b
    for (const key of Object.keys(nodesA) as (keyof typeof nodesA)[]) {
        if (nodesA[key].enabled !== nodesB[key].enabled) return false
    }
    if (
        (a.reverb.profile ?? DEFAULT_REVERB_PROFILE) !==
        (b.reverb.profile ?? DEFAULT_REVERB_PROFILE)
    )
        return false
    return Boolean(eqA?.enabled) === Boolean(eqB?.enabled)
}

type Nodes = {
    lowPass: LowPassEffect
    highPass: HighPassEffect
    tapeSaturation: TapeSaturationEffect
    reverb: ReverbEffect
    bitcrusher: BitcrusherEffect
    chorus: ChorusEffect
    pitchWobble: PitchWobbleEffect
    stereoDrift: StereoDriftEffect
    dropout: DropoutEffect
    vinylCrackle: VinylCrackleEffect
    vocalCut: VocalCutEffect
    equalizer: EqualizerEffect
}

export class LofiRack {
    readonly input: GainNode
    readonly output: GainNode
    private ctx: AudioContext
    private workletsUrl: string
    private sampleUrl?: string
    private nodes?: Nodes
    private dryBypass?: GainNode
    private processed?: GainNode
    private texture?: GainNode
    private sourceActive = true
    /** The state the last setEffects asked for, replayed when the nodes exist. */
    private settings: EffectSettings = normalizeEffectSettings(DEFAULT_EFFECT_SETTINGS)
    /** True while no effect is on: the dry path is in use. Starts bypassed. */
    private bypassed = true
    /** Set by destroy(); a late sample load or a late build must not revive sound. */
    private destroyed = false
    /** Bumped per build so a destroy/re-init race has an unambiguous winner. */
    private generation = 0
    private ready?: Promise<void>

    constructor(ctx: AudioContext, urls: { workletsUrl: string; sampleUrl?: string }) {
        this.ctx = ctx
        this.workletsUrl = urls.workletsUrl
        this.sampleUrl = urls.sampleUrl
        this.input = ctx.createGain()
        this.output = ctx.createGain()
    }

    /** Load the worklets and build the chain once; later calls share the first. */
    init(): Promise<void> {
        // A destroyed rack starts over from scratch; the generation tells a
        // build that was awaiting its worklets whether destroy() superseded it.
        this.destroyed = false
        if (!this.ready) {
            const generation = ++this.generation
            this.ready = this.build(generation).catch((error) => {
                if (this.generation === generation) this.ready = undefined
                throw error
            })
        }
        return this.ready
    }

    get initialized(): boolean {
        return Boolean(this.nodes)
    }

    /** The noise bus level: 1 while the crackle can be heard, 0 in bypass or paused. */
    get noiseGain(): number {
        return this.texture?.gain.value ?? 0
    }

    private async build(generation: number): Promise<void> {
        await Promise.all(
            LOFI_WORKLETS.map((name) =>
                this.ctx.audioWorklet.addModule(`${this.workletsUrl}${name}-processor.js`)
            )
        )
        // destroy() (or a newer build) landed while the modules loaded: don't
        // install a chain that no longer has an owner.
        if (this.destroyed || generation !== this.generation) return

        const ctx = this.ctx
        const n: Nodes = {
            lowPass: new LowPassEffect(ctx),
            highPass: new HighPassEffect(ctx),
            tapeSaturation: new TapeSaturationEffect(ctx),
            reverb: new ReverbEffect(ctx),
            bitcrusher: new BitcrusherEffect(ctx),
            chorus: new ChorusEffect(ctx),
            pitchWobble: new PitchWobbleEffect(ctx),
            stereoDrift: new StereoDriftEffect(ctx),
            dropout: new DropoutEffect(ctx),
            vinylCrackle: new VinylCrackleEffect(ctx, this.sampleUrl),
            vocalCut: new VocalCutEffect(ctx),
            equalizer: new EqualizerEffect(ctx)
        }
        this.dryBypass = ctx.createGain()
        this.processed = ctx.createGain()
        this.texture = ctx.createGain()

        // The same order as lovelofi's rack, minus slowdown. The dry path is a
        // parallel gain that setBypass switches against the processed path, so
        // with nothing on the rack is a plain wire.
        this.input.connect(this.dryBypass)
        this.input.connect(n.lowPass.node)
        n.lowPass.node.connect(n.highPass.node)
        n.highPass.node.connect(n.vocalCut.node)
        n.vocalCut.node.connect(n.tapeSaturation.input)
        n.tapeSaturation.output.connect(n.bitcrusher.node)
        n.bitcrusher.node.connect(n.reverb.input)
        n.reverb.output.connect(n.chorus.input)
        n.chorus.output.connect(n.pitchWobble.node)
        n.pitchWobble.node.connect(n.stereoDrift.node)
        n.stereoDrift.node.connect(n.dropout.node)
        n.dropout.node.connect(this.processed)
        this.processed.connect(n.equalizer.input)
        n.equalizer.output.connect(this.output)
        this.dryBypass.connect(this.output)

        // Crackle is a looping sample mixed into the processed path. Its bus is
        // opened only while the rack is actually processing and the element is
        // playing (updateTexture), so bypass and pause both silence it.
        n.vinylCrackle.output.connect(this.texture)
        this.texture.connect(this.processed)
        this.texture.gain.value = 0

        this.nodes = n
        // Replay whatever was asked for before the nodes existed, so a caller
        // that set effects (or paused) during the worklet load is not lost.
        this.applySettings(this.settings)
    }

    setEffects(settings: EffectSettings): void {
        this.settings = normalizeEffectSettings(settings)
        this.applySettings(this.settings)
    }

    private applySettings(s: EffectSettings): void {
        const n = this.nodes
        if (!n || !this.dryBypass || !this.processed) return

        // Enabled first, then intensity: most effects ignore setIntensity while off.
        n.lowPass.enabled = s.lowPass.enabled
        n.lowPass.setIntensity(s.lowPass.intensity)
        n.highPass.enabled = s.highPass.enabled
        n.highPass.setIntensity(s.highPass.intensity)
        n.tapeSaturation.enabled = s.tapeSaturation.enabled
        n.tapeSaturation.setIntensity(s.tapeSaturation.intensity)
        n.reverb.enabled = s.reverb.enabled
        n.reverb.setProfile(s.reverb.profile ?? DEFAULT_REVERB_PROFILE)
        n.reverb.setIntensity(s.reverb.intensity)
        n.bitcrusher.enabled = s.bitcrusher.enabled
        n.bitcrusher.setIntensity(s.bitcrusher.intensity)
        n.chorus.enabled = s.chorus.enabled
        n.chorus.setIntensity(s.chorus.intensity)
        n.vinylCrackle.enabled = s.vinylCrackle.enabled
        n.vinylCrackle.setIntensity(s.vinylCrackle.intensity)
        n.pitchWobble.enabled = s.pitchWobble.enabled
        n.pitchWobble.setIntensity(s.pitchWobble.intensity)
        n.stereoDrift.enabled = s.stereoDrift.enabled
        n.stereoDrift.setIntensity(s.stereoDrift.intensity)
        n.dropout.enabled = s.dropout.enabled
        n.dropout.setIntensity(s.dropout.intensity)
        n.vocalCut.enabled = s.vocalCut.enabled
        n.vocalCut.setIntensity(s.vocalCut.intensity)
        n.equalizer.setSettings(s.equalizer ?? { enabled: false, bands: [] })

        this.bypassed = !hasLofiEffects(s)
        this.dryBypass.gain.value = this.bypassed ? 1 : 0
        this.processed.gain.value = this.bypassed ? 0 : 1
        this.updateTexture()
    }

    /** Pause mutes the crackle loop; play brings it back. */
    setSourceActive(active: boolean): void {
        this.sourceActive = active
        this.updateTexture()
    }

    /**
     * The crackle bus is open only when it can be heard: the rack is processing
     * (not bypassed) and the element is playing. Both inputs are stored, so the
     * order setEffects / setSourceActive arrive in does not matter.
     */
    private updateTexture(): void {
        if (!this.texture) return
        const audible = !this.bypassed && this.sourceActive
        this.texture.gain.value = audible ? 1 : 0
    }

    destroy(): void {
        // Mark first: the crackle effect's sample load may still be in flight and
        // must not start a loop after this point, nor may a build in progress
        // finish and install nodes.
        this.destroyed = true
        this.generation++
        this.nodes?.vinylCrackle.destroy()
        this.nodes?.chorus.destroy()
        try {
            this.input.disconnect()
            this.output.disconnect()
        } catch {
            // never connected
        }
        this.texture?.disconnect()
        this.texture = undefined
        this.dryBypass = undefined
        this.processed = undefined
        this.nodes = undefined
        this.ready = undefined
    }
}

/**
 * Owner of the rack on the Chorus side, in the mould of Reverb / Equalizer /
 * MSProcessor: builds it lazily on the manager's AudioContext and keeps it in
 * the chain only while a lofi effect is on, so idle listening costs nothing.
 */
export default class Lofi {
    private _audioManager: AudioManager
    private rack: LofiRack | null = null
    private settings: EffectSettings = DEFAULT_EFFECT_SETTINGS
    private connected = false
    private playing = true

    constructor(audioManager: AudioManager) {
        this._audioManager = audioManager
    }

    get active(): boolean {
        return hasLofiEffects(this.settings)
    }

    /**
     * Build the rack if these settings will need it: five worklet modules and
     * the crackle sample, which takes a moment on a fresh page. Nothing in the
     * chain changes, so this runs with the music still audible; `apply` then
     * does only the wiring, which is what the caller mutes for.
     */
    async prepare(settings: EffectSettings): Promise<void> {
        if (hasLofiEffects(normalizeEffectSettings(settings))) await this.ensureRack()
    }

    apply(settings: EffectSettings): void {
        this.settings = normalizeEffectSettings(settings)
        // Recorded on the rack even before it is built, so a build that is still
        // in flight finishes with these settings rather than the defaults.
        this.rack?.setEffects(this.settings)

        if (!this.active) {
            if (this.connected) {
                this.connected = false
                this._audioManager.removeEffect('lofi')
            }
            return
        }

        // Not built: prepare() was skipped or failed (and said so).
        if (!this.rack?.initialized) return
        if (!this.connected) {
            this.connected = true
            this._audioManager.connectLofi(this.rack)
        }
    }

    /**
     * A slider mid-drag: new intensities for effects that are already on, set
     * straight on the live rack with no mute and no chain rebuild. False when
     * the change needs the full path (an effect switched, a new reverb space,
     * or a rack that is still being built).
     */
    tweak(settings: EffectSettings): boolean {
        const next = normalizeEffectSettings(settings)
        if (!this.rack?.initialized || !this.connected || !sameLofiShape(this.settings, next))
            return false
        this.settings = next
        this.rack.setEffects(next)
        return true
    }

    /** audioManager.disconnect() drops every effect; put the rack back if it should be on. */
    reconnect(): void {
        this.connected = false
        if (this.rack?.initialized && this.active) {
            this.connected = true
            this._audioManager.connectLofi(this.rack)
        }
    }

    setPlaying(playing: boolean): void {
        this.playing = playing
        this.rack?.setSourceActive(playing)
    }

    private async ensureRack(): Promise<LofiRack | null> {
        const ctx = this._audioManager.audioContext
        if (!ctx) return null

        if (!this.rack) {
            const workletsUrl = sessionStorage.getItem('chorus:worklets_path')
            const soundsUrl = sessionStorage.getItem('chorus:sounds_path')
            if (!workletsUrl) {
                console.error('Lofi: worklets path not found in session storage')
                return null
            }
            this.rack = new LofiRack(ctx, {
                workletsUrl,
                sampleUrl: soundsUrl ? `${soundsUrl}vinyl-crackle.mp3` : undefined
            })
            // State that arrived before the rack existed (a settings update, a
            // pause) is recorded on it now and replayed once the chain builds.
            this.rack.setEffects(this.settings)
            this.rack.setSourceActive(this.playing)
        }

        try {
            await this.rack.init()
        } catch (error) {
            console.error('Lofi: failed to build the effect rack', error)
            return null
        }
        return this.rack
    }
}

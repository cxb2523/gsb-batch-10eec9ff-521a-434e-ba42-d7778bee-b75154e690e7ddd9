/**
 * Tests for runtime reconfiguration of the AudioWorklet processor.
 *
 * The real Emscripten WASM build is not available in every environment, so
 * the processor is exercised against the in-JS mock WASM module (resolved via
 * the 'libadlmidi-wasm' alias, the same bare specifier the production
 * bundler rewrites). A minimal AudioWorklet harness provides the global
 * AudioWorkletProcessor base class, registerProcessor hook and a fake
 * MessagePort, so the full message round-trip (postMessage -> handleMessage
 * -> reply) is verified.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { MOCK_MAX_CHIPS, MOCK_FOUR_OPS_PER_CHIP } from './helpers/mock-wasm.js';

// ---------------------------------------------------------------------------
// AudioWorklet global harness (must exist before importing the processor)
// ---------------------------------------------------------------------------

let registeredProcessor = null;

class FakeMessagePort {
    constructor() {
        this.onmessage = null;
        /** @type {object[]} */
        this.queue = [];
        /** @type {Set<(msg: object) => void>} */
        this.waiters = new Set();
    }

    postMessage(msg) {
        this.queue.push(msg);
        for (const waiter of this.waiters) waiter(msg);
    }

    /** Drop previously received messages so the next waitFor targets a fresh reply. */
    clear() {
        this.queue.length = 0;
    }

    /**
     * Wait for the next message matching `type`.
     * @param {string} type
     * @returns {Promise<object>}
     */
    waitFor(type) {
        const already = this.queue.find((m) => m.type === type);
        if (already) return Promise.resolve(already);
        return new Promise((resolve) => {
            const waiter = (msg) => {
                if (msg.type === type) {
                    this.waiters.delete(waiter);
                    resolve(msg);
                }
            };
            this.waiters.add(waiter);
        });
    }
}

globalThis.sampleRate = 44100;

globalThis.AudioWorkletProcessor = class AudioWorkletProcessor {
    constructor() {
        this.port = new FakeMessagePort();
    }
};

globalThis.registerProcessor = (name, ctor) => {
    if (name !== 'adl-midi-processor') {
        throw new Error(`Unexpected processor name: ${name}`);
    }
    registeredProcessor = ctor;
};

// Static import: vitest resolves 'libadlmidi-wasm' through the test alias.
await import('../../src/processor.js');

/**
 * Instantiate the processor and wait for its asynchronous 'ready' message.
 * @param {object} [processorOptions]
 * @returns {Promise<{processor: object, port: FakeMessagePort}>}
 */
async function createProcessor(processorOptions = {}) {
    if (!registeredProcessor) {
        throw new Error('Processor was not registered');
    }
    const processor = new registeredProcessor({ processorOptions });
    const port = processor.port;
    await port.waitFor('ready');
    return { processor, port };
}

/**
 * Send a message to the processor and capture its next reply of `replyType`.
 * @param {object} processor
 * @param {FakeMessagePort} port
 * @param {object} msg
 * @param {string} replyType
 * @returns {Promise<object>}
 */
function roundTrip(processor, port, msg, replyType) {
    port.clear();
    const reply = port.waitFor(replyType);
    processor.handleMessage(msg);
    return reply;
}

describe('Processor runtime reconfiguration', () => {
    let processor;
    let port;
    let module;

    beforeEach(async () => {
        ({ processor, port } = await createProcessor());
        module = processor.adl;
        module.callLog.length = 0;
    });

    it('registers the worklet processor and becomes ready', () => {
        expect(registeredProcessor).toBeTruthy();
        expect(processor.ready).toBe(true);
        expect(port.queue.some((m) => m.type === 'ready')).toBe(true);
    });

    it('reports requested vs obtained chip counts after a runtime configure', async () => {
        const reply = await roundTrip(processor, port, {
            type: 'configure',
            settings: { numChips: 4 }
        }, 'configured');

        expect(reply.type).toBe('configured');
        expect(reply.requested).toEqual({ numChips: 4 });
        expect(reply.obtained).toEqual({ numChips: 4 });

        // Dedicated obtained query must return the applied (real) value.
        const chips = await roundTrip(processor, port, {
            type: 'getNumChipsObtained'
        }, 'numChipsObtained');
        expect(chips).toMatchObject({ chips: 4 });
    });

    it('clamps an oversized chip request without throwing and reports the granted value', async () => {
        const oversized = MOCK_MAX_CHIPS + 10;

        let reply;
        expect(() => {
            reply = roundTrip(processor, port, {
                type: 'configure',
                settings: { numChips: oversized }
            }, 'configured');
        }).not.toThrow();
        reply = await reply;

        expect(reply.requested.numChips).toBe(oversized);
        expect(reply.obtained.numChips).toBe(MOCK_MAX_CHIPS);
        expect(reply.obtained.numChips).toBeLessThanOrEqual(reply.requested.numChips);

        const chips = await roundTrip(processor, port, {
            type: 'getNumChipsObtained'
        }, 'numChipsObtained');
        expect(chips.chips).toBe(MOCK_MAX_CHIPS);

        // The plain getNumChips query keeps reporting the requested value,
        // keeping "requested" and "obtained" distinguishable.
        const requested = await roundTrip(processor, port, {
            type: 'getNumChips'
        }, 'numChips');
        expect(requested.chips).toBe(oversized);
    });

    it('clamps an out-of-capacity 4-op channel request and does not throw', async () => {
        // The processor defaults to 4 chips; first reduce to a single chip so
        // it can only provide MOCK_FOUR_OPS_PER_CHIP four-op channels.
        await roundTrip(processor, port, {
            type: 'configure',
            settings: { numChips: 1 }
        }, 'configured');

        const oversized = MOCK_FOUR_OPS_PER_CHIP * 5;
        const reply = await roundTrip(processor, port, {
            type: 'configure',
            settings: { numFourOpChannels: oversized }
        }, 'configured');

        expect(reply.requested.numFourOpChannels).toBe(oversized);
        expect(reply.obtained.numFourOpChannels).toBe(MOCK_FOUR_OPS_PER_CHIP);
        expect(Number.isFinite(reply.obtained.numFourOpChannels)).toBe(true);

        const obtained = await roundTrip(processor, port, {
            type: 'getNumFourOpChannelsObtained'
        }, 'numFourOpChannelsObtained');
        expect(obtained.channels).toBe(MOCK_FOUR_OPS_PER_CHIP);
    });

    it('re-synchronizes playback state around capacity changes', async () => {
        // Hold a note before reconfiguring, exactly like mid-playback use.
        processor.handleMessage({
            type: 'noteOn', channel: 0, note: 60, velocity: 100
        });

        await roundTrip(processor, port, {
            type: 'configure',
            settings: { numChips: 2, numFourOpChannels: 3 }
        }, 'configured');

        // Controlled sequence: release occupancy, apply both capacities,
        // then re-sync real-time state.
        const names = module.callLog.map((entry) => entry[0]);
        const panicIndex = names.indexOf('adl_panic');
        const setChipsIndex = names.indexOf('adl_setNumChips');
        const setFourOpsIndex = names.indexOf('adl_setNumFourOpsChn');
        const resetIndex = names.indexOf('adl_rt_resetState');

        expect(panicIndex).toBeGreaterThanOrEqual(0);
        expect(setChipsIndex).toBeGreaterThan(panicIndex);
        expect(setFourOpsIndex).toBeGreaterThan(setChipsIndex);
        expect(resetIndex).toBeGreaterThan(setFourOpsIndex);

        // Play mode must be preserved so the audio stream keeps running.
        expect(processor.playMode).toBe('realtime');
    });

    it('keeps applying non-capacity settings in the established order', async () => {
        await roundTrip(processor, port, {
            type: 'configure',
            settings: { emulator: 2, numChips: 2, bank: 72, softPan: false }
        }, 'configured');

        const names = module.callLog.map((entry) => entry[0]);
        const emulatorIndex = names.indexOf('adl_switchEmulator');
        const panicIndex = names.indexOf('adl_panic');
        const setChipsIndex = names.indexOf('adl_setNumChips');
        const resetIndex = names.indexOf('adl_rt_resetState');
        const setBankIndex = names.indexOf('adl_setBank');
        const softPanIndex = names.indexOf('adl_setSoftPanEnabled');

        // Emulator switch remains first (partialReset semantics), then the
        // controlled capacity change, then bank and soft pan.
        expect(emulatorIndex).toBe(0);
        expect(panicIndex).toBeGreaterThan(emulatorIndex);
        expect(setChipsIndex).toBeGreaterThan(panicIndex);
        expect(resetIndex).toBeGreaterThan(setChipsIndex);
        expect(setBankIndex).toBeGreaterThan(resetIndex);
        expect(softPanIndex).toBeGreaterThan(setBankIndex);

        // The granted chip count is observable on the mock player.
        const playerPtr = processor.midi;
        expect(module._adl_getNumChipsObtained(playerPtr)).toBe(2);
    });

    it('stays consistent across two consecutive configure calls', async () => {
        const first = await roundTrip(processor, port, {
            type: 'configure',
            settings: { numChips: 3 }
        }, 'configured');
        expect(first.obtained.numChips).toBe(3);

        const second = await roundTrip(processor, port, {
            type: 'configure',
            settings: { numChips: 1, numFourOpChannels: 2 }
        }, 'configured');

        expect(second.requested).toEqual({ numChips: 1, numFourOpChannels: 2 });
        expect(second.obtained).toEqual({ numChips: 1, numFourOpChannels: 2 });

        // Subsequent queries agree with the last configure result.
        const chips = await roundTrip(processor, port, {
            type: 'getNumChipsObtained'
        }, 'numChipsObtained');
        const fourOps = await roundTrip(processor, port, {
            type: 'getNumFourOpChannelsObtained'
        }, 'numFourOpChannelsObtained');
        expect(chips.chips).toBe(1);
        expect(fourOps.channels).toBe(2);
    });

    it('returns empty requested/obtained payloads for non-capacity configures', async () => {
        const reply = await roundTrip(processor, port, {
            type: 'configure',
            settings: { bank: 40, softPan: true }
        }, 'configured');

        expect(reply.requested).toEqual({});
        expect(reply.obtained).toEqual({});

        // No capacity-change sequence should have run.
        const names = module.callLog.map((entry) => entry[0]);
        expect(names).not.toContain('adl_panic');
        expect(names).toContain('adl_setBank');
    });

    it('routes standalone setNumChips through the same controlled path', async () => {
        processor.handleMessage({ type: 'setNumChips', chips: 2 });

        const names = module.callLog.map((entry) => entry[0]);
        expect(names).toContain('adl_panic');
        expect(names).toContain('adl_setNumChips');
        expect(names).toContain('adl_rt_resetState');
        expect(names.indexOf('adl_panic')).toBeLessThan(names.indexOf('adl_setNumChips'));
        expect(names.indexOf('adl_setNumChips')).toBeLessThan(
            names.indexOf('adl_rt_resetState')
        );

        const chips = await roundTrip(processor, port, {
            type: 'getNumChipsObtained'
        }, 'numChipsObtained');
        expect(chips.chips).toBe(2);
    });

    it('does not alter the initial processorOptions-driven settings behavior', async () => {
        // A second processor built with processorOptions settings applies
        // them at construction exactly as before (no configure message).
        const { processor: presetProcessor, port: presetPort } =
            await createProcessor({ settings: { numChips: 5, bank: 72 } });

        expect(presetPort.queue.filter((m) => m.type === 'configured')).toHaveLength(0);
        expect(presetProcessor.settings.numChips).toBe(5);
        expect(presetProcessor.settings.bank).toBe(72);

        const chips = await roundTrip(presetProcessor, presetPort, {
            type: 'getNumChipsObtained'
        }, 'numChipsObtained');
        // Requested 5 is within the mock's ceiling, so it is granted fully.
        expect(chips.chips).toBe(5);
    });
});

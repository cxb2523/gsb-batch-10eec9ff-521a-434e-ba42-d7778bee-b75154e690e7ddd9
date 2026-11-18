/**
 * Tests for AdlMidiCore.configure() — the controlled runtime reconfiguration
 * path on the platform-agnostic core API.
 *
 * These run against the in-JS mock WASM module (no Emscripten build needed),
 * which models libADLMIDI's request-vs-obtained clamping semantics.
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { fileURLToPath } from 'url';
import { join } from 'path';
import { MOCK_MAX_CHIPS, MOCK_FOUR_OPS_PER_CHIP } from './helpers/mock-wasm.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const MOCK_CORE_PATH = join(__dirname, 'helpers', 'mock-wasm.js');

let AdlMidiCore;
beforeAll(async () => {
    ({ AdlMidiCore } = await import('../../src/core.js'));
});

describe('AdlMidiCore runtime configure (requested vs obtained)', () => {
    let synth;

    beforeEach(async () => {
        synth = await AdlMidiCore.create({ corePath: MOCK_CORE_PATH });
        synth.init(44100);
        // Drop construction-time entries so ordering assertions only see the
        // calls made by the configure() under test.
        synth.module.callLog.length = 0;
    });

    afterEach(() => {
        synth?.close();
        synth = null;
    });

    it('returns matching requested and obtained values within capacity', () => {
        const result = synth.configure({ numChips: 4 });

        expect(result.requested).toEqual({ numChips: 4 });
        expect(result.obtained).toEqual({ numChips: 4 });

        // The dedicated obtained getter agrees with the configure result.
        expect(synth.getNumChipsObtained()).toBe(4);
        // The plain getter keeps reporting the requested value.
        expect(synth.getNumChips()).toBe(4);
    });

    it('reports a reasonable obtained chip count after runtime modification', () => {
        const result = synth.configure({ numChips: 3 });
        expect(result.obtained.numChips).toBeGreaterThan(0);
        expect(result.obtained.numChips).toBeLessThanOrEqual(result.requested.numChips);
        expect(synth.getNumChipsObtained()).toBe(3);
    });

    it('clamps an out-of-capacity 4-op channel request without throwing', () => {
        // Default setup has one chip -> at most MOCK_FOUR_OPS_PER_CHIP 4-op
        // channels can be granted.
        const hugeRequest = MOCK_FOUR_OPS_PER_CHIP * 10;

        let result;
        expect(() => {
            result = synth.configure({ numFourOpChannels: hugeRequest });
        }).not.toThrow();

        expect(result.requested.numFourOpChannels).toBe(hugeRequest);
        expect(result.obtained.numFourOpChannels).toBe(MOCK_FOUR_OPS_PER_CHIP);
        expect(result.obtained.numFourOpChannels)
            .toBeLessThanOrEqual(result.requested.numFourOpChannels);

        // Querying afterward returns the applied (real) value, not the request.
        expect(synth.getNumFourOpChannelsObtained()).toBe(MOCK_FOUR_OPS_PER_CHIP);
        // The requested value remains observable via the plain getter.
        expect(synth.getNumFourOpChannels()).toBe(hugeRequest);
    });

    it('clamps oversized chip requests and keeps the synth usable', () => {
        const result = synth.configure({ numChips: MOCK_MAX_CHIPS + 50 });

        expect(result.requested.numChips).toBe(MOCK_MAX_CHIPS + 50);
        expect(result.obtained.numChips).toBe(MOCK_MAX_CHIPS);
        expect(synth.getNumChipsObtained()).toBe(MOCK_MAX_CHIPS);

        // The synth must still accept notes and render after clamping.
        expect(() => {
            synth.noteOn(0, 60, 100);
            const samples = synth.generate(128);
            expect(samples).toBeInstanceOf(Float32Array);
            expect(samples.length).toBe(256);
        }).not.toThrow();
    });

    it('stays consistent after two consecutive configure calls', () => {
        const first = synth.configure({ numChips: 4, numFourOpChannels: 6 });
        expect(first.obtained).toEqual({ numChips: 4, numFourOpChannels: 6 });

        const second = synth.configure({ numChips: 1, numFourOpChannels: 2 });
        expect(second.requested).toEqual({ numChips: 1, numFourOpChannels: 2 });
        expect(second.obtained).toEqual({ numChips: 1, numFourOpChannels: 2 });

        // All read-back paths agree after the second configure.
        expect(synth.getNumChips()).toBe(1);
        expect(synth.getNumChipsObtained()).toBe(1);
        expect(synth.getNumFourOpChannels()).toBe(2);
        expect(synth.getNumFourOpChannelsObtained()).toBe(2);
    });

    it('recomputes the granted 4-op capacity when the chip count grows', () => {
        // Start with one chip and an explicit request beyond one chip's
        // capacity: granted value is clamped to one chip's worth.
        let result = synth.configure({ numFourOpChannels: MOCK_FOUR_OPS_PER_CHIP * 4 });
        expect(result.obtained.numFourOpChannels).toBe(MOCK_FOUR_OPS_PER_CHIP);

        // Adding chips raises the available 4-op ceiling; a later configure
        // re-requesting the same value obtains more.
        result = synth.configure({
            numChips: 4,
            numFourOpChannels: MOCK_FOUR_OPS_PER_CHIP * 4
        });
        expect(result.obtained.numChips).toBe(4);
        expect(result.obtained.numFourOpChannels).toBe(MOCK_FOUR_OPS_PER_CHIP * 4);
        expect(synth.getNumChipsObtained()).toBe(4);
        expect(synth.getNumFourOpChannelsObtained()).toBe(MOCK_FOUR_OPS_PER_CHIP * 4);
    });

    it('clears held notes before applying a capacity change', () => {
        synth.noteOn(0, 60, 100);
        synth.noteOn(1, 64, 90);

        // The mock player records held notes; configure must panic them away.
        const player = synth.module;
        const heldBefore = [...player.callLog].length;

        synth.configure({ numChips: 2 });

        const sequence = player.callLog.slice(heldBefore).map((entry) => entry[0]);
        expect(sequence[0]).toBe('adl_panic');
        expect(sequence).toContain('adl_setNumChips');
        expect(sequence.lastIndexOf('adl_rt_resetState'))
            .toBeGreaterThan(sequence.indexOf('adl_setNumChips'));
    });

    it('applies bank/softPan alongside a capacity change in the same call', () => {
        const result = synth.configure({
            emulator: 2,
            numChips: 2,
            bank: 72,
            softPan: true,
            deepVibrato: true,
        });

        expect(result.obtained.numChips).toBe(2);

        const sequence = synth.module.callLog.map((entry) => entry[0]);
        const emulatorIndex = sequence.indexOf('adl_switchEmulator');
        const panicIndex = sequence.indexOf('adl_panic');
        const chipsIndex = sequence.indexOf('adl_setNumChips');
        const resetIndex = sequence.indexOf('adl_rt_resetState');
        const bankIndex = sequence.indexOf('adl_setBank');
        const panIndex = sequence.indexOf('adl_setSoftPanEnabled');

        // Emulator switch stays first (it performs a partialReset).
        expect(emulatorIndex).toBe(0);
        // Controlled capacity sequence then runs in order.
        expect(panicIndex).toBeGreaterThan(emulatorIndex);
        expect(chipsIndex).toBeGreaterThan(panicIndex);
        expect(resetIndex).toBeGreaterThan(chipsIndex);
        // Non-capacity settings apply after the controlled capacity sequence.
        expect(bankIndex).toBeGreaterThan(resetIndex);
        expect(panIndex).toBeGreaterThan(bankIndex);
    });

    it('returns empty requested/obtained objects when no capacity key is sent', () => {
        const result = synth.configure({ bank: 40 });
        expect(result.requested).toEqual({});
        expect(result.obtained).toEqual({});

        const sequence = synth.module.callLog.map((entry) => entry[0]);
        expect(sequence).not.toContain('adl_panic');
        expect(sequence).toContain('adl_setBank');
    });
});

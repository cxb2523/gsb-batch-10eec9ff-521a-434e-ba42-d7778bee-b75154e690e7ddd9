/**
 * Mock Emscripten module for libADLMIDI WASM builds.
 *
 * The real WASM build cannot be produced in environments without the
 * Emscripten toolchain, so processor/core tests exercise the message and
 * configuration logic against this in-JS double. It models the subset of the
 * libADLMIDI C API used by src/processor.js and src/core.js, including the
 * request-vs-obtained clamping semantics of adl_setNumChips /
 * adl_setNumFourOpsChn.
 *
 * Every exposed player is a plain object so tests can inspect state directly.
 */

// Modeled hardware ceiling: libADLMIDI itself accepts up to 100 requested
// chips, but an actual build may grant fewer. The mock grants at most 6.
export const MOCK_MAX_CHIPS = 6;
// Each emulated OPL3 chip exposes 6 four-operator channels.
export const MOCK_FOUR_OPS_PER_CHIP = 6;

/**
 * Create a fresh mock player state object.
 * @returns {object}
 */
function createPlayer() {
    return {
        // Chip capacity
        chipsRequested: 1,
        chipsObtained: 1,
        // 4-op channel capacity (-1 = auto)
        fourOpsRequested: -1,
        fourOpsObtained: MOCK_FOUR_OPS_PER_CHIP,
        // Other settings
        bank: 0,
        softPan: 0,
        deepVibrato: 0,
        deepTremolo: 0,
        emulator: 0,
        // Bookkeeping
        notesOn: new Set(),
        closed: false,
    };
}

/**
 * Recompute the granted 4-op channel count from the current request and the
 * granted chip count, mirroring libADLMIDI's clamp behavior.
 * @param {object} player
 */
function recomputeFourOpsObtained(player) {
    const capacity = player.chipsObtained * MOCK_FOUR_OPS_PER_CHIP;
    if (player.fourOpsRequested < 0) {
        // Auto: libADLMIDI picks a default bounded by the available capacity.
        player.fourOpsObtained = capacity;
    } else {
        player.fourOpsObtained = Math.min(player.fourOpsRequested, capacity);
    }
}

/**
 * Build a mock Emscripten-style module.
 * @param {object} [options]
 * @returns {Promise<object>} Resolves to the module (async to match Emscripten)
 */
export default async function createMockADLMIDI(options) {
    // `options` mirrors the Emscripten module config and is intentionally
    // accepted but unused by the mock.
    void options;

    /** @type {Map<number, object>} */
    const players = new Map();
    let nextPlayerId = 1;
    let nextHeapAddr = 1024;

    // Simple bump allocator backing the typed-array heaps.
    const heapBuffer = new ArrayBuffer(1024 * 1024);

    const module = {
        // Shared call log so tests can assert ordering of the controlled
        // capacity-change sequence (panic -> setters -> rt_resetState).
        callLog: [],

        HEAPU8: new Uint8Array(heapBuffer),
        HEAP16: new Int16Array(heapBuffer),
        HEAP32: new Int32Array(heapBuffer),

        _malloc(size) {
            const ptr = nextHeapAddr;
            nextHeapAddr += size;
            return ptr;
        },

        _free() {
            // Bump allocator: no-op free.
        },

        getValue(ptr, type) {
            const view = type === 'i16'
                ? new Int16Array(heapBuffer, ptr, 1)
                : new Int32Array(heapBuffer, ptr, 1);
            return view[0];
        },

        setValue(ptr, value, type) {
            const view = type === 'i16'
                ? new Int16Array(heapBuffer, ptr, 1)
                : new Int32Array(heapBuffer, ptr, 1);
            view[0] = value;
        },

        UTF8ToString(ptr) {
            if (!ptr) return '';
            const bytes = module.HEAPU8;
            let end = ptr;
            while (end < bytes.length && bytes[end] !== 0) end += 1;
            return Buffer.from(bytes.subarray(ptr, end)).toString('utf8');
        },

        // ===================== Lifecycle =====================

        _adl_init(/* sampleRate */) {
            const id = nextPlayerId++;
            players.set(id, createPlayer());
            module.callLog.push(['adl_init', id]);
            return id;
        },

        _adl_close(playerPtr) {
            const player = players.get(playerPtr);
            if (player) player.closed = true;
            players.delete(playerPtr);
            module.callLog.push(['adl_close', playerPtr]);
        },

        // ===================== Capacity (requested vs obtained) =====================

        _adl_setNumChips(playerPtr, count) {
            const player = players.get(playerPtr);
            module.callLog.push(['adl_setNumChips', count]);
            if (!player) return -1;
            // libADLMIDI clamps the request itself to [1, 100]; the granted
            // count may still be lower than the request.
            const requested = Math.max(1, Math.min(100, count));
            player.chipsRequested = requested;
            player.chipsObtained = Math.min(requested, MOCK_MAX_CHIPS);
            recomputeFourOpsObtained(player);
            return 0;
        },

        _adl_getNumChips(playerPtr) {
            const player = players.get(playerPtr);
            return player ? player.chipsRequested : 0;
        },

        _adl_getNumChipsObtained(playerPtr) {
            const player = players.get(playerPtr);
            return player ? player.chipsObtained : 0;
        },

        _adl_setNumFourOpsChn(playerPtr, count) {
            const player = players.get(playerPtr);
            module.callLog.push(['adl_setNumFourOpsChn', count]);
            if (!player) return -1;
            player.fourOpsRequested = count;
            recomputeFourOpsObtained(player);
            return 0;
        },

        _adl_getNumFourOpsChn(playerPtr) {
            const player = players.get(playerPtr);
            return player ? player.fourOpsRequested : 0;
        },

        _adl_getNumFourOpsChnObtained(playerPtr) {
            const player = players.get(playerPtr);
            return player ? player.fourOpsObtained : 0;
        },

        // ===================== State / playback control =====================

        _adl_panic(playerPtr) {
            const player = players.get(playerPtr);
            module.callLog.push(['adl_panic']);
            if (player) player.notesOn.clear();
        },

        _adl_rt_resetState(playerPtr) {
            const player = players.get(playerPtr);
            module.callLog.push(['adl_rt_resetState']);
            if (player) player.notesOn.clear();
        },

        _adl_reset(playerPtr) {
            module.callLog.push(['adl_reset', playerPtr]);
        },

        _adl_rt_noteOn(playerPtr, channel, note /* velocity */) {
            const player = players.get(playerPtr);
            if (player) player.notesOn.add(`${channel}:${note}`);
        },

        _adl_rt_noteOff(playerPtr, channel, note) {
            const player = players.get(playerPtr);
            if (player) player.notesOn.delete(`${channel}:${note}`);
        },

        _adl_generate(/* playerPtr, sampleCount, bufferPtr */) {
            // Rendering is not exercised by configuration tests.
        },

        _adl_play(/* playerPtr, sampleCount, bufferPtr */) {
            // File rendering is not exercised by configuration tests.
        },

        // ===================== Other settings =====================

        _adl_switchEmulator(playerPtr, emulator) {
            const player = players.get(playerPtr);
            module.callLog.push(['adl_switchEmulator', emulator]);
            if (player) player.emulator = emulator;
            return 0;
        },

        _adl_setBank(playerPtr, bank) {
            const player = players.get(playerPtr);
            module.callLog.push(['adl_setBank', bank]);
            if (player) player.bank = bank;
            return 0;
        },

        _adl_setSoftPanEnabled(playerPtr, enabled) {
            const player = players.get(playerPtr);
            module.callLog.push(['adl_setSoftPanEnabled', enabled]);
            if (player) player.softPan = enabled ? 1 : 0;
        },

        _adl_setHVibrato(playerPtr, enabled) {
            const player = players.get(playerPtr);
            module.callLog.push(['adl_setHVibrato', enabled]);
            if (player) player.deepVibrato = enabled ? 1 : 0;
        },

        _adl_setHTremolo(playerPtr, enabled) {
            const player = players.get(playerPtr);
            module.callLog.push(['adl_setHTremolo', enabled]);
            if (player) player.deepTremolo = enabled ? 1 : 0;
        },

        _adl_getBanksCount() {
            return 1;
        },

        _adl_getBankNames() {
            return 0;
        },
    };

    // Any other C entry point the code under test might touch becomes a
    // recorded no-op instead of throwing a TypeError.
    return new Proxy(module, {
        get(target, prop) {
            if (prop in target) {
                return target[prop];
            }
            if (typeof prop === 'string' && prop.startsWith('_')) {
                return (...args) => {
                    target.callLog.push([prop.slice(1), ...args]);
                    return 0;
                };
            }
            return undefined;
        },
    });
}

/**
 * Offline Web Audio test setup.
 *
 * The APU is written against the browser Web Audio API. For offline
 * verification we run under Node with the `web-audio-engine` polyfill, which
 * provides a standards-compatible OfflineAudioContext (gain automation,
 * AudioBufferSourceNode scheduling, DynamicsCompressor, etc.).
 *
 * Everything the engine imports is covered by the polyfill; the APU never
 * touches audio-worklet-only features on its main signal path (the colorizer
 * is constructed but bypassed).
 */

import { OfflineAudioContext as PolyfilledOfflineAudioContext } from 'web-audio-engine';

// Prefer a native implementation (future Node / browsers) and fall back to
// the polyfill when the runtime has none.
if (!globalThis.OfflineAudioContext) {
  Object.defineProperty(globalThis, 'OfflineAudioContext', {
    value: PolyfilledOfflineAudioContext,
    writable: true,
    configurable: true,
  });
}

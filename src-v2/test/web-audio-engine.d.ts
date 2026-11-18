/**
 * Minimal ambient declarations for the `web-audio-engine` offline audio
 * polyfill used by the Node test suite. The package ships no TypeScript
 * types; its OfflineAudioContext is API-compatible with the DOM's, so we
 * reuse the standard lib type for the constructor and instances.
 */

declare module 'web-audio-engine' {
  // The polyfill's constructors are API-compatible with the standard DOM
  // audio contexts; the instance types differ only in internals.
  export const OfflineAudioContext: {
    new (
      numberOfChannels: number,
      length: number,
      sampleRate: number
    ): OfflineAudioContext;
  };
  export const StreamAudioContext: {
    new (): AudioContext;
  };
  export const RenderingAudioContext: {
    new (): AudioContext;
  };
  export const WebAudioContext: {
    new (): AudioContext;
  };
}

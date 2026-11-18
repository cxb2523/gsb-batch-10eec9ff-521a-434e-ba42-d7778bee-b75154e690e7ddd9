import { useEffect } from 'react';
import { audioManager } from '../lib/audio';
import { KEY_CODE_MAP, keyStateManager } from '../lib/keyState';

/**
 * A global hook to handle keyboard audio feedback for the 9 game keys.
 * This should be mounted once at the root of the application.
 *
 * It follows the converged pressed state from the key state manager: a
 * note starts when a key becomes pressed and keeps sounding while any
 * input source (keyboard or touch) still holds it; it is released only
 * when the key is truly released.
 */
export function useGlobalAudio() {
  useEffect(() => {
    const unsubscribePress = keyStateManager.onPress((code) => {
      const keyInfo = KEY_CODE_MAP[code];
      if (keyInfo === undefined) return;

      // Initialize audio on first key press if not already done
      if (!audioManager.isInitialized()) {
        audioManager.start();
      }

      audioManager.playNote(keyInfo.key);
    });

    const unsubscribeRelease = keyStateManager.onRelease((code) => {
      const keyInfo = KEY_CODE_MAP[code];
      if (keyInfo === undefined) return;
      audioManager.releaseNote(keyInfo.key);
    });

    const unsubscribeReset = keyStateManager.onReset(() => {
      audioManager.releaseAll();
    });

    return () => {
      unsubscribePress();
      unsubscribeRelease();
      unsubscribeReset();
      audioManager.releaseAll(); // Stop any sound when the app unmounts
    };
  }, []); // Empty dependency array ensures this runs only once
}

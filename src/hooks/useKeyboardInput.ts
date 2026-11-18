import { useEffect } from 'react';
import { bindKeyboard } from '../lib/keyState';

/**
 * Feeds real keyboard events into the shared key state manager.
 * Mounted once at the root of the application.
 */
export function useKeyboardInput() {
  useEffect(() => bindKeyboard(window), []);
}

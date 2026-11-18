/**
 * Centralized pressed-state management for the nine game keys.
 *
 * A key can be held by several input sources at once (the physical
 * keyboard and/or individual touch points on the overlay). The manager
 * keeps a set of active sources per key: a key becomes pressed when its
 * first source goes down and is released only when EVERY source holding
 * it has let go. Both the game logic and the audio feedback subscribe to
 * the converged press/release events exposed here.
 */

export const KEY_CODE_MAP: Record<string, { index: number; key: string }> = {
  KeyA: { index: 0, key: 'a' },
  KeyS: { index: 1, key: 's' },
  KeyD: { index: 2, key: 'd' },
  KeyF: { index: 3, key: 'f' },
  Space: { index: 4, key: ' ' },
  KeyJ: { index: 5, key: 'j' },
  KeyK: { index: 6, key: 'k' },
  KeyL: { index: 7, key: 'l' },
  Semicolon: { index: 8, key: ';' },
};

/** Source id used for the physical keyboard. */
export const KEYBOARD_SOURCE = 'keyboard';

/** Source id used for one touch point on the touch overlay. */
export function touchSource(identifier: number): string {
  return `touch:${identifier}`;
}

/** Maps a touch overlay zone index (0-8) to a keyboard code. */
export const TOUCH_ZONE_CODE_MAP: Record<number, string> = {
  0: 'KeyA',
  1: 'KeyS',
  2: 'KeyD',
  3: 'KeyF',
  4: 'KeyJ',
  5: 'KeyK',
  6: 'KeyL',
  7: 'Semicolon',
  8: 'Space',
};

export type KeyListener = (code: string) => void;
export type ResetListener = () => void;

export class KeyStateManager {
  private sourcesByCode = new Map<string, Set<string>>();
  private pressListeners = new Set<KeyListener>();
  private releaseListeners = new Set<KeyListener>();
  private resetListeners = new Set<ResetListener>();

  /**
   * Registers a press from a source. Returns true (and emits onPress) only
   * when the key transitions from fully released to pressed; repeat presses
   * from an already-holding source are ignored.
   */
  press(source: string, code: string): boolean {
    if (!(code in KEY_CODE_MAP)) return false;
    let sources = this.sourcesByCode.get(code);
    if (sources?.has(source)) return false;
    const wasPressed = sources !== undefined && sources.size > 0;
    if (!sources) {
      sources = new Set();
      this.sourcesByCode.set(code, sources);
    }
    sources.add(source);
    if (!wasPressed) this.emit(this.pressListeners, code);
    return !wasPressed;
  }

  /**
   * Registers a release from a source. Returns true (and emits onRelease)
   * only when no source holds the key anymore.
   */
  release(source: string, code: string): boolean {
    const sources = this.sourcesByCode.get(code);
    if (!sources || !sources.delete(source)) return false;
    if (sources.size === 0) {
      this.sourcesByCode.delete(code);
      this.emit(this.releaseListeners, code);
      return true;
    }
    return false;
  }

  /**
   * Releases every key held by one source (e.g. the keyboard, or a single
   * touch point). Returns the codes that became fully released.
   */
  releaseSource(source: string): string[] {
    const fullyReleased: string[] = [];
    for (const [code, sources] of Array.from(this.sourcesByCode)) {
      if (sources.delete(source) && sources.size === 0) {
        this.sourcesByCode.delete(code);
        fullyReleased.push(code);
        this.emit(this.releaseListeners, code);
      }
    }
    return fullyReleased;
  }

  isPressed(code: string): boolean {
    const sources = this.sourcesByCode.get(code);
    return sources !== undefined && sources.size > 0;
  }

  /**
   * Clears every source for every key (level restart, back to menu, level
   * complete) and notifies onReset listeners so they can drop any residual
   * pressed state and stop sustained notes.
   */
  reset(): void {
    this.sourcesByCode.clear();
    for (const listener of this.resetListeners) listener();
  }

  onPress(listener: KeyListener): () => void {
    this.pressListeners.add(listener);
    return () => {
      this.pressListeners.delete(listener);
    };
  }

  onRelease(listener: KeyListener): () => void {
    this.releaseListeners.add(listener);
    return () => {
      this.releaseListeners.delete(listener);
    };
  }

  onReset(listener: ResetListener): () => void {
    this.resetListeners.add(listener);
    return () => {
      this.resetListeners.delete(listener);
    };
  }

  private emit(listeners: Set<KeyListener>, code: string): void {
    for (const listener of listeners) listener(code);
  }
}

/** Shared singleton used by the game. */
export const keyStateManager = new KeyStateManager();

/**
 * Tracks which overlay zone each active touch point is currently in and
 * keeps a key state manager in sync:
 * - each touch point is its own source, so several fingers can hold the
 *   same key and it stays pressed until the last one lifts;
 * - sliding a finger between zones releases the old key and presses the
 *   new one exactly once (no duplicate presses);
 * - ending/cancelling a touch, or sliding it out of every zone, reliably
 *   releases its key.
 */
export class TouchKeyTracker {
  private touchToZone = new Map<number, number>();
  private manager: KeyStateManager;

  constructor(manager: KeyStateManager) {
    this.manager = manager;
  }

  touchStart(identifier: number, zoneIndex: number): void {
    if (zoneIndex < 0 || this.touchToZone.has(identifier)) return;
    const code = TOUCH_ZONE_CODE_MAP[zoneIndex];
    if (!code) return;
    this.touchToZone.set(identifier, zoneIndex);
    this.manager.press(touchSource(identifier), code);
  }

  touchMove(identifier: number, zoneIndex: number): void {
    const oldZone = this.touchToZone.get(identifier) ?? -1;
    if (oldZone === zoneIndex) return;
    if (oldZone !== -1) {
      this.manager.release(touchSource(identifier), TOUCH_ZONE_CODE_MAP[oldZone]);
    }
    const code = TOUCH_ZONE_CODE_MAP[zoneIndex];
    if (code) {
      this.touchToZone.set(identifier, zoneIndex);
      this.manager.press(touchSource(identifier), code);
    } else {
      // Finger moved out of every zone: reliably release its key.
      this.touchToZone.delete(identifier);
    }
  }

  touchEnd(identifier: number): void {
    const zone = this.touchToZone.get(identifier);
    if (zone === undefined) return;
    this.touchToZone.delete(identifier);
    this.manager.release(touchSource(identifier), TOUCH_ZONE_CODE_MAP[zone]);
  }

  isZoneTouched(zoneIndex: number): boolean {
    for (const zone of this.touchToZone.values()) {
      if (zone === zoneIndex) return true;
    }
    return false;
  }

  /** Releases every tracked touch (overlay unmount or game reset). */
  reset(): void {
    for (const identifier of Array.from(this.touchToZone.keys())) {
      this.manager.releaseSource(touchSource(identifier));
    }
    this.touchToZone.clear();
  }
}

/**
 * Binds real keyboard events to the key state manager. Holding a key down
 * does not retrigger (the keyboard is a single source), and releasing it
 * releases the key only if no other source holds it. Returns an unbind
 * function that also releases everything the keyboard is holding.
 */
export function bindKeyboard(
  target: Window,
  manager: KeyStateManager = keyStateManager,
): () => void {
  const handleKeyDown = (e: KeyboardEvent) => {
    if (!(e.code in KEY_CODE_MAP)) return;
    e.preventDefault();
    manager.press(KEYBOARD_SOURCE, e.code);
  };

  const handleKeyUp = (e: KeyboardEvent) => {
    if (!(e.code in KEY_CODE_MAP)) return;
    e.preventDefault();
    manager.release(KEYBOARD_SOURCE, e.code);
  };

  target.addEventListener('keydown', handleKeyDown);
  target.addEventListener('keyup', handleKeyUp);

  return () => {
    target.removeEventListener('keydown', handleKeyDown);
    target.removeEventListener('keyup', handleKeyUp);
    manager.releaseSource(KEYBOARD_SOURCE);
  };
}

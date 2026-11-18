/**
 * Local verification for the converged (per-source counted) key state.
 *
 * Drives the real KeyStateManager / TouchKeyTracker / bindKeyboard with
 * fabricated touch and keyboard event samples and checks the resulting
 * press/release event streams:
 *
 *   1. two fingers press the same key, then lift one by one
 *   2. one finger slides across zones (and out of every zone)
 *   3. touch cancel releases keys reliably
 *   4. keyboard + touch hold the same key, released in both orders
 *   5. desktop keyboard behavior: no repeat while held, release on keyup
 *   6. reset clears every source (level restart / back to menu)
 *
 * Run with: node tests/verify-key-state.ts   (Node >= 23.6, type stripping)
 */

import {
  KeyStateManager,
  TouchKeyTracker,
  bindKeyboard,
  KEY_CODE_MAP,
} from '../src/lib/keyState.ts';

type KeyEventEntry = ['press' | 'release', string];

let failures = 0;

function check(label: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    console.log(`  ok   - ${label}`);
  } else {
    failures += 1;
    console.error(`  FAIL - ${label}\n         expected: ${e}\n         actual:   ${a}`);
  }
}

function createRig() {
  const manager = new KeyStateManager();
  const log: KeyEventEntry[] = [];
  let resetCount = 0;
  manager.onPress((code) => log.push(['press', code]));
  manager.onRelease((code) => log.push(['release', code]));
  manager.onReset(() => { resetCount += 1; });
  const tracker = new TouchKeyTracker(manager);
  return { manager, tracker, log, getResetCount: () => resetCount };
}

// --- Fabricated keyboard events -------------------------------------------

function fakeKeyboardEvent(type: 'keydown' | 'keyup', code: string): KeyboardEvent {
  const event = new Event(type) as unknown as KeyboardEvent;
  Object.defineProperty(event, 'code', { value: code });
  return event;
}

function createKeyboard(manager: KeyStateManager) {
  const target = new EventTarget();
  bindKeyboard(target as unknown as Window, manager);
  return {
    down: (code: string) => target.dispatchEvent(fakeKeyboardEvent('keydown', code)),
    up: (code: string) => target.dispatchEvent(fakeKeyboardEvent('keyup', code)),
  };
}

// --- Scenario 1: two fingers on the same key, lifted one by one -----------

console.log('Scenario 1: two fingers press the same key, then lift one by one');
{
  const { manager, tracker, log } = createRig();

  tracker.touchStart(1, 0); // finger 1 on zone 0 (KeyA)
  tracker.touchStart(2, 0); // finger 2 on the same zone
  check('single press event for two fingers', log, [['press', 'KeyA']]);
  check('key is pressed', manager.isPressed('KeyA'), true);

  tracker.touchEnd(1); // first finger lifts: key must stay pressed
  check('no release while second finger holds', log, [['press', 'KeyA']]);
  check('key still pressed', manager.isPressed('KeyA'), true);

  tracker.touchEnd(2); // last finger lifts: now it releases
  check('release only after all fingers lift', log, [['press', 'KeyA'], ['release', 'KeyA']]);
  check('key fully released', manager.isPressed('KeyA'), false);
}

// --- Scenario 2: one finger slides across zones ---------------------------

console.log('Scenario 2: one finger slides across zones');
{
  const { manager, tracker, log } = createRig();

  tracker.touchStart(1, 0); // press KeyA
  tracker.touchMove(1, 1);  // slide to zone 1: release KeyA, press KeyS
  check('slide releases old key and presses new key once', log, [
    ['press', 'KeyA'],
    ['release', 'KeyA'],
    ['press', 'KeyS'],
  ]);

  tracker.touchMove(1, 1);  // move within the same zone: no duplicate events
  check('no duplicate events inside the same zone', log, [
    ['press', 'KeyA'],
    ['release', 'KeyA'],
    ['press', 'KeyS'],
  ]);

  tracker.touchMove(1, -1); // slide out of every zone: reliable release
  check('sliding out of all zones releases the key', log, [
    ['press', 'KeyA'],
    ['release', 'KeyA'],
    ['press', 'KeyS'],
    ['release', 'KeyS'],
  ]);
  check('no key pressed anymore', manager.isPressed('KeyS'), false);

  tracker.touchEnd(1);      // lifting afterwards must not double-release
  check('touch end after moving out is a no-op', log, [
    ['press', 'KeyA'],
    ['release', 'KeyA'],
    ['press', 'KeyS'],
    ['release', 'KeyS'],
  ]);
}

// --- Scenario 3: touch cancel releases keys reliably ----------------------

console.log('Scenario 3: touch cancel releases keys reliably');
{
  const { manager, tracker, log } = createRig();

  tracker.touchStart(1, 2); // KeyD
  tracker.touchStart(2, 8); // Space
  tracker.touchEnd(1);      // cancel path uses the same touchEnd handling
  check('cancelled touch releases its key only', log, [
    ['press', 'KeyD'],
    ['press', 'Space'],
    ['release', 'KeyD'],
  ]);
  check('other touch still held', manager.isPressed('Space'), true);

  tracker.reset();          // overlay unmount / cancel of remaining touches
  check('tracker reset releases remaining touches', log, [
    ['press', 'KeyD'],
    ['press', 'Space'],
    ['release', 'KeyD'],
    ['release', 'Space'],
  ]);
  check('nothing pressed after tracker reset',
    Object.keys(KEY_CODE_MAP).some((code) => manager.isPressed(code)), false);

  tracker.touchEnd(2);      // late touchend for an already-cleared touch
  check('late touch end is a no-op', log, [
    ['press', 'KeyD'],
    ['press', 'Space'],
    ['release', 'KeyD'],
    ['release', 'Space'],
  ]);
}

// --- Scenario 4: keyboard + touch hold the same key -----------------------

console.log('Scenario 4: keyboard and touch hold the same key, released separately');
{
  // keyboard first, then touch
  const { manager, tracker, log } = createRig();
  const keyboard = createKeyboard(manager);

  keyboard.down('KeyJ');
  tracker.touchStart(1, 4); // zone 4 is KeyJ
  check('touch on keyboard-held key adds no duplicate press', log, [['press', 'KeyJ']]);

  keyboard.up('KeyJ');      // keyboard lets go, finger still down
  check('key stays pressed after keyboard release', log, [['press', 'KeyJ']]);
  check('key still pressed', manager.isPressed('KeyJ'), true);

  tracker.touchEnd(1);      // last source releases
  check('release once every source let go', log, [['press', 'KeyJ'], ['release', 'KeyJ']]);
}
{
  // touch first, then keyboard (reverse order)
  const { manager, tracker, log } = createRig();
  const keyboard = createKeyboard(manager);

  tracker.touchStart(2, 4); // KeyJ
  keyboard.down('KeyJ');
  check('keyboard on touch-held key adds no duplicate press', log, [['press', 'KeyJ']]);

  tracker.touchEnd(2);      // finger lets go, keyboard still held
  check('key stays pressed after touch release', log, [['press', 'KeyJ']]);
  check('key still pressed', manager.isPressed('KeyJ'), true);

  keyboard.up('KeyJ');
  check('release once every source let go', log, [['press', 'KeyJ'], ['release', 'KeyJ']]);
}

// --- Scenario 5: desktop keyboard behavior stays intact -------------------

console.log('Scenario 5: keyboard mapping, no auto-repeat, release on keyup');
{
  const { manager, log } = createRig();
  const keyboard = createKeyboard(manager);

  keyboard.down('KeyA');
  keyboard.down('KeyA');    // OS auto-repeat while held
  keyboard.down('KeyA');
  check('holding a key does not retrigger', log, [['press', 'KeyA']]);

  keyboard.up('KeyA');
  check('keyup releases the key', log, [['press', 'KeyA'], ['release', 'KeyA']]);

  keyboard.up('KeyA');      // stray keyup without a press
  check('stray keyup is a no-op', log, [['press', 'KeyA'], ['release', 'KeyA']]);

  keyboard.down('KeyQ');    // unmapped key
  keyboard.up('KeyQ');
  check('unmapped keys are ignored', log, [['press', 'KeyA'], ['release', 'KeyA']]);

  for (const code of Object.keys(KEY_CODE_MAP)) {
    keyboard.down(code);
    keyboard.up(code);
  }
  check('all nine keys map and release correctly', log.slice(2), [
    ...Object.keys(KEY_CODE_MAP).flatMap((code): KeyEventEntry[] => [['press', code], ['release', code]]),
  ]);
  check('keyboard source fully released',
    Object.keys(KEY_CODE_MAP).some((code) => manager.isPressed(code)), false);
}

// --- Scenario 6: reset clears every source --------------------------------

console.log('Scenario 6: reset clears all sources (restart / back to menu)');
{
  const { manager, tracker, log, getResetCount } = createRig();
  const keyboard = createKeyboard(manager);

  keyboard.down('KeyS');
  tracker.touchStart(1, 0); // KeyA
  tracker.touchStart(2, 8); // Space
  check('three keys held across sources', [
    manager.isPressed('KeyS'),
    manager.isPressed('KeyA'),
    manager.isPressed('Space'),
  ], [true, true, true]);

  manager.reset();
  check('reset notified listeners', getResetCount(), 1);
  check('no key pressed after reset',
    Object.keys(KEY_CODE_MAP).some((code) => manager.isPressed(code)), false);

  keyboard.up('KeyS');      // releases arriving after the reset
  tracker.touchEnd(1);
  tracker.touchEnd(2);
  check('no stale release events after reset', log, [
    ['press', 'KeyS'],
    ['press', 'KeyA'],
    ['press', 'Space'],
  ]);
}

// --- Summary ----------------------------------------------------------------

if (failures > 0) {
  console.error(`\n${failures} check(s) FAILED`);
  process.exit(1);
}
console.log('\nAll key-state convergence checks passed.');

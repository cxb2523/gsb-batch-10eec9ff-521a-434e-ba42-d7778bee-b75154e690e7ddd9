// Headless surf tests: build a 50° ramp exactly the way MapBuilder does
// (tilted box brush) and ride it. A working surf implementation keeps the
// player pinned to the face — no friction, never counted as grounded, and
// critically never dead-stopped by repeated same-plane clipping (the classic
// "sticking" failure at overbounce 1.0). Exercises tryPlayerMove's crease
// handling and overbounce selection.

import { describe, expect, it } from 'vitest';
import { vec3 } from '../../math/vec3';
import { World } from '../../physics/World/World';
import { brushFromAABB, brushFromOrientedBox } from '../../physics/Collision/Collision';
import { PlayerController } from '../PlayerController';
import { tryPlayerMove } from './TryPlayerMove';
import { DEFAULT_SETTINGS } from '../../settings/Settings';
import type { Settings } from '../../settings/Settings';

const DT = 1 / 128;

function makeSettings(overrides: Partial<Settings> = {}): Settings {
  return { ...structuredClone(DEFAULT_SETTINGS), ...overrides };
}

/**
 * 50° face like MapBuilder.ramp(0, -run, 0, 50, ...), but very wide (x is the
 * ride direction) so tests can ride it for seconds without falling off an end.
 */
function surfWorld(): World {
  const world = new World();
  const t = (50 * Math.PI) / 180;
  const L = 280;
  const ax = vec3(1, 0, 0);
  const ay = vec3(0, Math.cos(t), -Math.sin(t));
  const az = vec3(0, Math.sin(t), Math.cos(t));
  const foot = vec3(0, 0, -L * Math.cos(t));
  const center = vec3(
    foot.x + az.x * (L / 2) - ay.x * 4,
    foot.y + az.y * (L / 2) - ay.y * 4,
    foot.z + az.z * (L / 2) - ay.z * 4,
  );
  world.solids.push(brushFromOrientedBox(center, vec3(8192, 8, L / 2), ax, ay, az));
  return world;
}

describe('surfing', () => {
  it('does not freeze at the epsilon fixed point (exact captured state)', () => {
    // Full-precision state captured from a live freeze: resting at exactly
    // DIST_EPSILON off the face with velocity clipped exactly parallel.
    // Float noise in the trace endpoint used to produce femto-fraction
    // phantom hits here, pinning the position while gravity pumped velocity.
    const world = surfWorld();
    const player = new PlayerController(
      world,
      makeSettings(),
      vec3(0, 133.05351157766984, -89.59780135568705),
    );
    player.velocity.y = -236.02081025578147;
    player.velocity.z = -195.42278848836006;

    const startZ = player.origin.z;
    for (let i = 0; i < 64; i++) player.tick(DT);
    // The slide must actually integrate — well over 50 units of travel in
    // half a second at these speeds.
    expect(startZ - player.origin.z).toBeGreaterThan(50);
    const speed = Math.hypot(player.velocity.x, player.velocity.y, player.velocity.z);
    expect(speed).toBeGreaterThan(200);
  });

  it('a straight drop onto the face converts to along-plane slide (no stick)', () => {
    const player = new PlayerController(surfWorld(), makeSettings(), vec3(0, 200, -80));
    player.velocity.y = -200;
    for (let i = 0; i < 128; i++) player.tick(DT);
    expect(player.onGround).toBe(false);
    // Gravity's along-plane component keeps accelerating the slide.
    expect(player.horizontalSpeed).toBeGreaterThan(150);
    expect(player.velocity.y).toBeLessThan(0);
  });

  it('rides the face for seconds while strafing into it, holding speed', () => {
    // Spawn low on the face — strafe-pumping climbs ~20 u/s, and starting
    // high would legitimately summit the test ramp's ridge and stand on it.
    const player = new PlayerController(surfWorld(), makeSettings(), vec3(0, 100, -140));
    // View along +x; strafe-right pushes +z, into the face.
    player.yaw = -90;
    player.input.right = true;
    player.velocity.x = 150;

    let stuckTicks = 0;
    let groundedTicks = 0;
    for (let i = 0; i < 384; i++) {
      // 3 seconds
      player.tick(DT);
      if (i > 30) {
        if (player.horizontalSpeed < 5) stuckTicks++;
        if (player.onGround) groundedTicks++;
      }
    }

    // The regression this guards: duplicate clip planes used to zero the
    // velocity within a few contacts ("surf is cooked").
    expect(stuckTicks).toBe(0);
    expect(groundedTicks).toBe(0);
    // Pure into-face strafe holds position and speed (no friction bleed);
    // along-track gains would come from carving, not from this input.
    expect(player.horizontalSpeed).toBeGreaterThan(140);
    // Still held on the face — not dumped below the foot.
    expect(player.origin.y).toBeGreaterThan(0);
  });

  it('transitions smoothly from the ramp base onto the floor (buried foot)', () => {
    // Map-accurate setup: 50° face with its foot sunk 32u below a floor at
    // y=0, exactly like MapBuilder.ramp(). This guards the phantom-strip
    // regression: an unburied foot leaves hull-expanded collision protruding
    // past the visible base, causing invisible bumps, tunneling, and stops.
    const world = new World();
    const t = (50 * Math.PI) / 180;
    const L = 280;
    const ax = vec3(1, 0, 0);
    const ay = vec3(0, Math.cos(t), -Math.sin(t));
    const az = vec3(0, Math.sin(t), Math.cos(t));
    const foot = vec3(0, -32, -L * Math.cos(t));
    const center = vec3(
      foot.x + az.x * (L / 2) - ay.x * 4,
      foot.y + az.y * (L / 2) - ay.y * 4,
      foot.z + az.z * (L / 2) - ay.z * 4,
    );
    world.solids.push(brushFromOrientedBox(center, vec3(4096, 8, L / 2), ax, ay, az));
    world.solids.push(
      brushFromOrientedBox(vec3(0, -32, 0), vec3(8192, 32, 8192), vec3(1, 0, 0), vec3(0, 1, 0), vec3(0, 0, 1)),
    );

    // Start high on the face and ride it all the way down and out.
    const player = new PlayerController(world, makeSettings(), vec3(0, 160, -60));
    player.velocity.y = -100;
    let landedTick = -1;
    for (let i = 0; i < 384; i++) {
      player.tick(DT);
      // Never tunnel into the floor or the ramp interior.
      expect(player.origin.y).toBeGreaterThan(-1);
      if (player.onGround && landedTick === -1) {
        landedTick = i;
        // The moment of touchdown: the along-ramp slide carried through the
        // base onto the floor with its horizontal speed intact — no phantom
        // bumper, no dead stop. (Friction takes over afterwards; that's
        // normal ground movement.)
        expect(player.horizontalSpeed).toBeGreaterThan(150);
      }
    }
    expect(landedTick).toBeGreaterThan(30); // spent real time surfing first
    expect(player.onGround).toBe(true);
  });

  it('pumping the strafe against the face never zeroes velocity (aa 800 worst case)', () => {
    const player = new PlayerController(
      surfWorld(),
      makeSettings({ airAccelerate: 800 }),
      vec3(0, 140, -100),
    );
    player.yaw = -90;
    player.input.right = true;
    player.velocity.x = 80;
    for (let i = 0; i < 384; i++) {
      player.tick(DT);
      if (i > 40) {
        expect(player.horizontalSpeed).toBeGreaterThan(5);
      }
    }
  });
});

describe('wall contact (overbounce 1, allFraction)', () => {
  function wallWorld(): World {
    const world = new World();
    // Vertical wall: solid for x >= 100.
    world.solids.push(brushFromAABB(vec3(100, -512, -4096), vec3(200, 4096, 4096)));
    return world;
  }

  it('slides along an airborne first impact at full along-wall speed (no 1.001 bleed)', () => {
    const player = new PlayerController(wallWorld(), makeSettings(), vec3(82, 500, 0));
    player.velocity.x = 600;
    player.velocity.z = 200;
    player.tick(DT);
    expect(player.velocity.z).toBeCloseTo(200, 6);
    expect(player.velocity.x).toBeLessThanOrEqual(0.05);
  });

  it('zeroes velocity when the player cannot move at all this tick', () => {
    const world = wallWorld();
    const player = new PlayerController(world, makeSettings(), vec3(83.96875, 500, 0)); // flush against the wall
    player.velocity.x = 600;
    player.tick(DT);
    expect(player.horizontalSpeed).toBeLessThan(1);
  });
});

// A tick can bump several times. MINIMUM_MOVE_FRACTION zeroes a sweep that
// covers almost none of the move so it can't wreck the distance maths — but
// "that sweep was negligible" must not be mistaken for "the mover never moved
// this tick". A wall-projected slide routinely leaves only a hair of the frame
// available, and the old allFraction-sum test read that as a dead stop and
// wiped the tangential speed. Only a tick where no sweep advanced at all is
// allowed to zero the velocity.
describe('airborne wall slide: deciding whether the tick moved at all', () => {
  /** A tall vertical wall: solid for x >= 100, so the face is at x = 100. */
  function wallWorld(): World {
    const world = new World();
    world.solids.push(brushFromAABB(vec3(100, -512, -4096), vec3(200, 4096, 4096)));
    return world;
  }

  /** Open air, no geometry at all — nothing to hit, nothing to slide on. */
  function emptyWorld(): World {
    return new World();
  }

  it('keeps the tangential speed on an oblique airborne wall hit', () => {
    // Start just short of the face at x=100 (hull half-width 16): one tick of
    // 400 u/s covers 3.1u, enough to reach it.
    const player = new PlayerController(wallWorld(), makeSettings(), vec3(82, 500, 0));
    player.velocity.x = 400;
    player.velocity.z = 300;
    player.tick(DT);
    // The into-wall component is removed; the along-wall one survives intact.
    expect(player.velocity.z).toBeCloseTo(300, 6);
    expect(player.velocity.x).toBeLessThanOrEqual(0.05);
  });

  it('keeps sliding along the wall across many frames of held input', () => {
    const world = wallWorld();
    const player = new PlayerController(world, makeSettings(), vec3(70, 500, -200));
    player.yaw = -90; // strafe-right pushes +z, along the wall
    player.input.right = true;
    player.velocity.z = 300;

    let previousZ = player.origin.z;
    for (let i = 0; i < 192; i++) {
      player.tick(DT);
      // Every tick must still carry along-wall speed: never a dead stop.
      expect(player.horizontalSpeed).toBeGreaterThan(250);
      // ...and it must actually keep integrating down the wall.
      if (i > 2) expect(player.origin.z).toBeGreaterThan(previousZ);
      previousZ = player.origin.z;
    }
    expect(player.onGround).toBe(false);
  });

  it('records the wall contact with its real fraction (not the clamped 0)', () => {
    // Resting a hair further out than the trace epsilon: the sweep into the
    // wall completes a vanishingly small (but positive) share of the frame.
    // That fraction is deliberately rounded away for the distance maths, yet
    // the contact itself is real and must reach the per-tick log with its
    // true fraction — movement diagnostics read it from there.
    const world = wallWorld();
    // Face is at x = 84 - DIST_EPSILON (hull-expanded); sit 1e-7 further out.
    const player = new PlayerController(world, makeSettings(), vec3(84 - 0.03125 - 1e-7, 500, 0));
    player.velocity.x = 600;
    player.velocity.z = 300;

    const fractions: number[] = [];
    let loggedFraction = Number.NaN;
    const origTrace = player.world.trace.bind(player.world);
    (player.world as { trace: typeof origTrace }).trace = ((...args: Parameters<typeof origTrace>) => {
      const tr = origTrace(...args);
      if (tr.normal !== null && fractions.length === 0) {
        fractions.push(tr.fraction);
        // The contact is pushed right after this trace returns, so read what
        // landed in the log on the very next sweep.
      } else if (fractions.length === 1 && Number.isNaN(loggedFraction)) {
        if (player.contactsThisTick.count > 0) loggedFraction = player.contactsThisTick.data[3];
      }
      return tr;
    }) as typeof origTrace;
    player.tick(DT);
    (player.world as { trace: typeof origTrace }).trace = origTrace;

    expect(fractions.length).toBeGreaterThan(0);
    // A real, positive fraction well below MINIMUM_MOVE_FRACTION (1e-4).
    expect(fractions[0]).toBeGreaterThan(0);
    expect(fractions[0]).toBeLessThan(1e-4);
    // The crash line: the contact carried its *real* fraction to the log
    // instead of the clamped 0 the distance maths works with.
    expect(loggedFraction).toBe(fractions[0]);
    // ...and the slide kept its along-wall velocity.
    expect(player.velocity.z).toBeCloseTo(300, 6);
  });

  it('still zeroes velocity when the tick genuinely moves nothing', () => {
    // No geometry and no motion: every sweep returns fraction 1 over a
    // zero-length move, so nothing advances — the velocity must be dropped.
    const player = new PlayerController(emptyWorld(), makeSettings(), vec3(0, 500, 0));
    player.velocity.x = 0;
    player.velocity.y = 0;
    player.velocity.z = 0;
    // Give it a velocity whose swing is fully absorbed by the wall so that
    // literally no position change is possible this tick.
    const walled = new PlayerController(wallWorld(), makeSettings(), vec3(83.96875, 500, 0));
    walled.velocity.x = 600;
    walled.tick(DT);
    expect(walled.horizontalSpeed).toBeLessThan(1);

    player.tick(DT);
    expect(player.horizontalSpeed).toBe(0);
  });

  it('keeps the tangential speed when every sweep is sub-threshold but real', () => {
    // The exact shape of the bug, isolated from map geometry: a wall-projected
    // slide whose *entire* remaining frame is below MINIMUM_MOVE_FRACTION.
    // Those fractions are real movement (they are rounded away only so they
    // can't wreck the distance maths), so the tick must not be treated as a
    // dead stop. Driven through a stub trace so real brushes can't blur it.
    const player = new PlayerController(emptyWorld(), makeSettings(), vec3(0, 500, 0));
    player.velocity.x = 600;
    player.velocity.z = 300;

    const WALL = vec3(-1, 0, 0);
    const tiny = 1e-6; // well under MINIMUM_MOVE_FRACTION (1e-4)
    const stub = {
      trace(start: { x: number; y: number; z: number }, end: { x: number; y: number; z: number }, _mins: unknown, _maxs: unknown, out: Record<string, unknown>) {
        // Brush the wall: only a millionth of the requested move survives.
        out.fraction = tiny;
        (out.endPos as { x: number; y: number; z: number }).x = start.x + (end.x - start.x) * tiny;
        (out.endPos as { x: number; y: number; z: number }).y = start.y + (end.y - start.y) * tiny;
        (out.endPos as { x: number; y: number; z: number }).z = start.z + (end.z - start.z) * tiny;
        out.normal = WALL;
        out.startSolid = false;
        out.allSolid = false;
        return out;
      },
    };
    (player as unknown as { world: typeof stub }).world = stub;

    tryPlayerMove(player, DT);

    // Along-wall speed survives; the into-wall component is gone.
    expect(player.velocity.z).toBeCloseTo(300, 6);
    expect(player.velocity.x).toBeLessThanOrEqual(0.05);
    // The wall contact is still logged, with its real (sub-threshold) fraction.
    expect(player.contactsThisTick.count).toBeGreaterThan(0);
    expect(player.contactsThisTick.data[3]).toBe(tiny);
  });
});

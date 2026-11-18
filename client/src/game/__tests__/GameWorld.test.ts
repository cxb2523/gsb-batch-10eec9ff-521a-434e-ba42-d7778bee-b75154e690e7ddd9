import { describe, expect, it, vi } from "vitest";
import { GameWorld } from "../GameWorld";
import { STAGES } from "../levelData";
import type { Platform } from "../types";
import { createStubCtx } from "./stubCtx";

const STEP = 1 / 60;

type Internals = {
  loadStage: (index: number) => void;
  stage: (typeof STAGES)[number];
  player: {
    x: number;
    y: number;
    w: number;
    h: number;
    vx: number;
    vy: number;
    onGround: boolean;
  };
  status: string;
  time: number;
  spawnX: number;
  spawnY: number;
  checkpointSpawn: (c: { x: number; y: number; w: number; h: number }) => {
    x: number;
    y: number;
  };
};

function makeWorld() {
  const onHud = vi.fn();
  const onAudioCue = vi.fn();
  const world = new GameWorld(createStubCtx(), { onHud, onAudioCue });
  return { world, internals: world as unknown as Internals, onHud, onAudioCue };
}

// Loads the stage that actually contains moving platforms (index 1).
function loadPlatformStage() {
  const built = makeWorld();
  built.internals.loadStage(1);
  return built;
}

// Places the player standing on a platform and runs one settle tick so vertical
// collision re-affirms the footing and the support link is established.
function standOn(
  world: GameWorld,
  internals: Internals,
  platform: Platform,
  offsetX = 10
) {
  internals.player.x = platform.x + offsetX;
  internals.player.y = platform.y - internals.player.h;
  internals.player.vx = 0;
  internals.player.vy = 0;
  internals.player.onGround = true;
  world.tick(STEP);
}

describe("moving platforms carry the rider", () => {
  it("translates a standing player by exactly the platform's horizontal delta", () => {
    const { world, internals } = loadPlatformStage();
    const platform = internals.stage.platforms[0];
    platform.vx = 1; // deterministic; never reverses inside the test window
    standOn(world, internals, platform);

    const startPlatX = platform.x;
    const startPlayerX = internals.player.x;
    for (let i = 0; i < 20; i++) world.tick(STEP);

    const platDelta = platform.x - startPlatX;
    const playerDelta = internals.player.x - startPlayerX;
    expect(platDelta).toBeGreaterThan(0);
    expect(playerDelta).toBeCloseTo(platDelta, 6);
  });

  it("keeps carrying the player after the platform reverses direction", () => {
    const { world, internals } = loadPlatformStage();
    const platform = internals.stage.platforms[0];
    standOn(world, internals, platform);
    const startPlatX = platform.x;
    const startPlayerX = internals.player.x;

    // Long enough for the platform to hit minX/maxX and bounce back.
    for (let i = 0; i < 240; i++) world.tick(STEP);

    expect(internals.player.x - startPlayerX).toBeCloseTo(
      platform.x - startPlatX,
      6
    );
  });

  it("stops following immediately once the player leaves the platform", () => {
    const { world, internals } = loadPlatformStage();
    const platform = internals.stage.platforms[0];
    platform.vx = 1;
    standOn(world, internals, platform);
    const xAfterRide = internals.player.x;

    // Detach: airborne and vertically clear of the platform.
    internals.player.onGround = false;
    internals.player.y = platform.y - 120;
    const platBefore = platform.x;
    world.tick(STEP);

    expect(platform.x - platBefore).toBeGreaterThan(0);
    expect(internals.player.x).toBe(xAfterRide);
  });

  it("does not push the rider through an adjacent wall or past the level bounds", () => {
    const { world, internals } = loadPlatformStage();
    const platform = internals.stage.platforms[0];
    platform.x = platform.maxX;
    platform.vx = 1;
    standOn(world, internals, platform, platform.w - internals.player.w - 2);

    // A solid wall immediately to the player's right.
    const wall = {
      x: internals.player.x + internals.player.w + 4,
      y: platform.y - 60,
      w: 20,
      h: 80,
    };
    internals.stage.solids.push(wall);
    for (let i = 0; i < 10; i++) world.tick(STEP);

    expect(internals.player.x + internals.player.w).toBeLessThanOrEqual(wall.x);
    expect(internals.player.x).toBeGreaterThanOrEqual(0);
    expect(internals.player.x + internals.player.w).toBeLessThanOrEqual(
      internals.stage.width
    );
  });
});

describe("pause freezes the whole scene", () => {
  it("freezes platforms, enemies and the scene clock while paused, then resumes in place", () => {
    const { world, internals } = loadPlatformStage();
    const platform = internals.stage.platforms[0];
    const enemy = internals.stage.enemies[0];

    for (let i = 0; i < 10; i++) world.tick(STEP);
    const platBefore = platform.x;
    const enemyBefore = enemy.x;
    const playerBefore = internals.player.x;
    const timeBefore = internals.time;

    world.press("pause");
    expect(internals.status).toBe("paused");
    // A long pause, including a multi-second delta compressed into one frame.
    for (let i = 0; i < 60; i++) world.tick(STEP);
    world.tick(5);

    expect(platform.x).toBe(platBefore);
    expect(enemy.x).toBe(enemyBefore);
    expect(internals.player.x).toBe(playerBefore);
    expect(internals.time).toBe(timeBefore);

    world.press("pause");
    expect(internals.status).toBe("playing");
    // The resume frame is clock-reset, so this is one ordinary step from the frozen spot.
    world.tick(STEP);
    const expected =
      platBefore + platform.vx * Math.min(2.2, Math.max(0.4, STEP * 60));
    expect(platform.x).toBeCloseTo(expected, 6);
  });

  it("does not apply a stale background-tab frame as one giant catch-up step on resume", () => {
    const { world, internals } = loadPlatformStage();
    const platform = internals.stage.platforms[0];
    for (let i = 0; i < 10; i++) world.tick(STEP);
    const frozenX = platform.x;

    world.press("pause");
    world.press("pause"); // resume: the render clock was stale while the tab was hidden
    // First frame after returning carries the entire hidden duration as dt.
    world.tick(10);

    // Without the clock reset the platform would jump by up to the 2.2-step cap;
    // a correct resume moves it by exactly one normal frame instead.
    const expected =
      frozenX + platform.vx * Math.min(2.2, Math.max(0.4, STEP * 60));
    expect(platform.x).toBeCloseTo(expected, 6);
  });

  it("keeps shard bob frozen while paused", () => {
    const { world, internals } = loadPlatformStage();
    const shard = internals.stage.shards[0];
    for (let i = 0; i < 5; i++) world.tick(STEP);
    const bobBefore = shard.bob;
    world.press("pause");
    for (let i = 0; i < 30; i++) world.tick(STEP);
    expect(shard.bob).toBe(bobBefore);
  });
});

describe("checkpoint respawn sits on the attached ground", () => {
  it.each(STAGES.map((stage, index) => [index, stage] as const))(
    "stage %#: every checkpoint spawn stands on ground and never overlaps a solid",
    stageIndex => {
      const { internals } = makeWorld();
      internals.loadStage(stageIndex);
      for (const checkpoint of internals.stage.checkpoints) {
        const spawn = internals.checkpointSpawn(checkpoint);
        const feetY = spawn.y + internals.player.h;
        const ground = internals.stage.solids.find(
          s =>
            s.y === feetY &&
            spawn.x + internals.player.w > s.x &&
            spawn.x < s.x + s.w
        );
        expect(
          ground,
          `stage ${stageIndex + 1} checkpoint x=${checkpoint.x}`
        ).toBeDefined();
        for (const solid of internals.stage.solids) {
          const overlap =
            spawn.x < solid.x + solid.w &&
            spawn.x + internals.player.w > solid.x &&
            spawn.y < solid.y + solid.h &&
            spawn.y + internals.player.h > solid.y;
          expect(
            overlap,
            `stage ${stageIndex + 1} spawn embedded in a solid`
          ).toBe(false);
        }
      }
    }
  );

  it("records corrected spawn coordinates when a checkpoint is activated", () => {
    const { world, internals } = loadPlatformStage();
    const checkpoint = internals.stage.checkpoints[0];
    internals.player.x = checkpoint.x;
    internals.player.y = checkpoint.y;
    world.tick(STEP);

    expect(checkpoint.active).toBe(true);
    const ground = internals.stage.solids.find(
      s =>
        internals.spawnX + internals.player.w > s.x &&
        internals.spawnX < s.x + s.w &&
        s.y === internals.spawnY + internals.player.h
    );
    expect(ground).toBeDefined();
  });
});

describe("regression guards: stage data, score and audio callbacks", () => {
  it("keeps three stages with their authored platform and enemy counts", () => {
    expect(STAGES).toHaveLength(3);
    expect(STAGES.map(s => s.platforms.length)).toEqual([0, 4, 4]);
    expect(STAGES.map(s => s.enemies.length)).toEqual([6, 7, 9]);
  });

  it("still fires the same audio cue on collection", () => {
    const { world, internals, onAudioCue } = loadPlatformStage();
    const shard = internals.stage.shards[0];
    internals.player.x = shard.x;
    internals.player.y = shard.y;
    world.tick(STEP);
    expect(onAudioCue).toHaveBeenCalledWith("collect");
  });
});

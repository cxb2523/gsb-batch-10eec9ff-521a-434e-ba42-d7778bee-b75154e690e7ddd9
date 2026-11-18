import { describe, expect, it } from 'vitest';

import {
  angleDelta,
  BASE_SPEED,
  BOOST_RESTART_AT,
  BOOST_SECONDS,
  BOOST_SPEED,
  canBoost,
  createSnake,
  MIN_BOOST_MASS,
  moveSnake,
  radiusFor,
  SEGMENT_SPACING,
  segmentsFor,
  STAMINA_DRAIN,
  STAMINA_MAX,
  tickStamina,
  turnRateFor,
} from './wiggle-snake';

const make = (mass = 20, x = 0, y = 0, angle = 0) =>
  createSnake({ id: 1, name: 'T', skin: 0, isPlayer: true, mass, angle, x, y });

describe('sizing', () => {
  it('grows fatter and longer with mass, up to a cap', () => {
    expect(radiusFor(100)).toBeGreaterThan(radiusFor(10));
    expect(segmentsFor(100)).toBeGreaterThan(segmentsFor(10));
    expect(radiusFor(1e6)).toBe(40);
    expect(segmentsFor(1e6)).toBe(500);
  });

  it('turns big snakes slower than small ones', () => {
    expect(turnRateFor(2000)).toBeLessThan(turnRateFor(10));
  });
});

describe('angleDelta', () => {
  it('takes the short way round', () => {
    expect(angleDelta(0, Math.PI / 2)).toBeCloseTo(Math.PI / 2);
    expect(angleDelta(3, -3)).toBeCloseTo(Math.PI * 2 - 6);
    expect(angleDelta(-3, 3)).toBeCloseTo(6 - Math.PI * 2);
  });
});

describe('moveSnake', () => {
  it('lays a straight trail behind a fresh snake', () => {
    const snake = make();
    expect(snake.body).toHaveLength(segmentsFor(20) + 1);
    expect(snake.body[1].x).toBeCloseTo(-SEGMENT_SPACING);
  });

  it('moves the head at base speed and keeps samples evenly spaced', () => {
    const snake = make();
    for (let i = 0; i < 30; i++) moveSnake(snake, 1 / 60, 3000);
    expect(snake.body[0].x).toBeCloseTo(BASE_SPEED * 0.5);
    for (let i = 2; i < snake.body.length; i++) {
      const a = snake.body[i - 1];
      const b = snake.body[i];
      expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeCloseTo(SEGMENT_SPACING);
    }
    expect(snake.body).toHaveLength(segmentsFor(20) + 1);
  });

  it('boosts only when it has mass to spare', () => {
    const big = make(100);
    big.boosting = true;
    moveSnake(big, 0.1, 3000);
    expect(big.body[0].x).toBeCloseTo(BOOST_SPEED * 0.1);

    const tiny = make(MIN_BOOST_MASS);
    tiny.boosting = true;
    moveSnake(tiny, 0.1, 3000);
    expect(tiny.body[0].x).toBeCloseTo(BASE_SPEED * 0.1);
  });

  it('turns no faster than its turn rate', () => {
    const snake = make();
    snake.targetAngle = Math.PI;
    moveSnake(snake, 0.1, 3000);
    expect(snake.angle).toBeCloseTo(turnRateFor(20) * 0.1);
  });

  it('slides along the wall instead of leaving the arena', () => {
    const snake = make(20, 990, 0);
    for (let i = 0; i < 20; i++) moveSnake(snake, 0.05, 1000);
    expect(Math.hypot(snake.body[0].x, snake.body[0].y)).toBeLessThanOrEqual(1000);
  });

  it('grows a longer tail after eating', () => {
    const snake = make();
    snake.mass = 200;
    moveSnake(snake, 0.01, 3000);
    expect(snake.body).toHaveLength(segmentsFor(200) + 1);
  });

  it('will not boost at zero stamina or while locked out', () => {
    const snake = make(100);
    snake.boosting = true;
    snake.stamina = 0;
    moveSnake(snake, 0.1, 3000);
    expect(snake.body[0].x).toBeCloseTo(BASE_SPEED * 0.1);

    const locked = make(100);
    locked.boosting = true;
    locked.boostLocked = true;
    moveSnake(locked, 0.1, 3000);
    expect(locked.body[0].x).toBeCloseTo(BASE_SPEED * 0.1);
  });
});

describe('stamina', () => {
  it('starts full, and a full tank lasts about two seconds of boosting', () => {
    const snake = make(100);
    snake.boosting = true;
    expect(snake.stamina).toBe(STAMINA_MAX);
    expect(BOOST_SECONDS).toBeCloseTo(2);
    tickStamina(snake, BOOST_SECONDS / 2);
    expect(snake.stamina).toBeCloseTo(STAMINA_MAX / 2);
    expect(canBoost(snake)).toBe(true);
    tickStamina(snake, BOOST_SECONDS / 2);
    expect(snake.stamina).toBe(0);
    expect(canBoost(snake)).toBe(false);
  });

  it('drains at the real rate only while actually boosting', () => {
    const idle = make(100);
    tickStamina(idle, 1);
    expect(idle.stamina).toBe(STAMINA_MAX);

    const boosting = make(100);
    boosting.boosting = true;
    tickStamina(boosting, 1);
    expect(boosting.stamina).toBeCloseTo(STAMINA_MAX - STAMINA_DRAIN);
  });

  it('refills about 1.5x faster than it drains after letting go', () => {
    const snake = make(100);
    snake.stamina = 0;
    const before = snake.stamina;
    tickStamina(snake, 0.2);
    expect(snake.stamina - before).toBeCloseTo(STAMINA_DRAIN * 1.5 * 0.2);
    for (let i = 0; i < 20; i++) tickStamina(snake, 0.5);
    expect(snake.stamina).toBe(STAMINA_MAX);
  });

  it('locks boost when the tank runs dry and ignores a held key until the tank recovers', () => {
    const snake = make(100);
    snake.boosting = true;
    for (let i = 0; i < Math.round(BOOST_SECONDS * 60); i++) tickStamina(snake, 1 / 60);
    expect(snake.stamina).toBe(0);
    expect(snake.boostLocked).toBe(true);

    // still holding boost: the tank refills but the latch holds until the threshold
    snake.boosting = true;
    let guard = 0;
    while (snake.stamina < BOOST_RESTART_AT - 1e-9 && guard++ < 10_000) {
      tickStamina(snake, 1 / 60);
      if (snake.stamina < BOOST_RESTART_AT - 1e-9) expect(canBoost(snake)).toBe(false);
    }
    expect(snake.boostLocked).toBe(false);
    expect(canBoost(snake)).toBe(true);
  });

  it('does not stutter at the critical point: locked boost stays locked frame after frame', () => {
    const snake = make(100);
    snake.boosting = true;
    // one frame's worth of energy, but not quite enough to finish the frame above zero
    snake.stamina = STAMINA_DRAIN / 120;
    tickStamina(snake, 1 / 60);
    expect(snake.stamina).toBe(0);
    expect(snake.boostLocked).toBe(true);
    for (let i = 0; i < 5; i++) {
      tickStamina(snake, 1 / 60);
      expect(canBoost(snake)).toBe(false);
    }
  });
});

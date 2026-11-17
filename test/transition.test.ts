import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Atmosphere } from '../src/atmosphere.js';
import { aggregateCover } from '../src/clouds.js';
import { resolveWeather, type WeatherInput } from '../src/weather.js';
import type { AtmosphereState } from '../src/state.js';

// Transitions between weathers. resolveWeather never resolves a frame with
// rain and snow at once, nor one whose total cover disagrees with what its
// cloud genera add up to — so no frame of a set() transition may either.
// A canvas here is only its numbers; the renderer is a stand-in.

const { FakeRenderer } = vi.hoisted(() => {
  class FakeRenderer {
    available = true;
    ready = true;
    colorSpace = 'srgb';
    cloudScale = 1;
    rays = 0;
    cumulonimbus = 'auto';
    render = vi.fn();
    prepare = vi.fn();
    dispose = vi.fn();
    isSettled = vi.fn(() => true);
    takeGpuTimes = () => [];
    readonly canvas: HTMLCanvasElement;
    constructor(canvas: HTMLCanvasElement) {
      this.canvas = canvas;
    }
    resize(w: number, h: number) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
  }
  return { FakeRenderer };
});

vi.mock('../src/renderer.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/renderer.js')>(),
  AtmosphereRenderer: FakeRenderer,
}));

let tick: (t: number) => void;
// well past any performance.now() of the process, so the first frame's dt is real
let now = 1_000_000;

beforeEach(() => {
  now = 1_000_000;
  vi.stubGlobal('requestAnimationFrame', (f: (t: number) => void) => { tick = f; return 1; });
  vi.stubGlobal('cancelAnimationFrame', () => {});
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
});

afterEach(() => vi.unstubAllGlobals());

const canvas = () =>
  ({ width: 0, height: 0, clientWidth: 640, clientHeight: 360 }) as HTMLCanvasElement;

const mount = (weather: WeatherInput) =>
  new Atmosphere(canvas(), { weather, fps: 60, resolutionScale: 1 });

/** set() to the weather, then run the loop for `seconds`, checking every drawn frame */
function transition(
  sky: Atmosphere,
  weather: WeatherInput,
  seconds: number,
  check: (s: Readonly<AtmosphereState>) => void,
): void {
  sky.set({ weather });
  for (let i = 0, frames = Math.round(seconds * 60); i < frames; i++) {
    tick(now += 1000 / 60);
    check(sky.state);
  }
}

/** how far a resolved weather's own cover stands from what its genera add up to */
const residualOf = (weather: WeatherInput) => {
  const s = resolveWeather(weather);
  return s.cloudCover - aggregateCover(s.clouds);
};

/** the cover never drifts further from the genera's aggregate than the endpoints themselves do */
const coverBound = (...weathers: WeatherInput[]) =>
  Math.max(...weathers.map((w) => Math.abs(residualOf(w)))) + 1e-9;

const neverRainsAndSnows = (s: Readonly<AtmosphereState>) => {
  expect(Math.min(s.rain, s.snow)).toBe(0);
};

describe('set() rain → snow', () => {
  it('never shows rain and snow in the same frame', () => {
    const sky = mount('rain');
    let rained = false, snowed = false;
    transition(sky, 'snow', 20, (s) => {
      neverRainsAndSnows(s);
      if (s.rain > 0) rained = true;
      if (s.snow > 0) snowed = true;
    });
    // the transition really happened: rain fell, stopped, and the snow came on
    expect(rained).toBe(true);
    expect(snowed).toBe(true);
    expect(sky.state.rain).toBe(0);
    expect(sky.state.snow).toBeCloseTo(resolveWeather('snow').snow, 2);
  });

  it('keeps the total cover with the genera throughout', () => {
    const sky = mount('rain');
    const bound = coverBound('rain', 'snow');
    transition(sky, 'snow', 20, (s) => {
      expect(Math.abs(s.cloudCover - aggregateCover(s.clouds))).toBeLessThanOrEqual(bound);
    });
  });

  it('and the snow does not start before the rain has stopped', () => {
    const sky = mount('rain');
    transition(sky, 'snow', 20, (s) => {
      if (s.rain > 0) expect(s.snow).toBe(0);
    });
  });
});

describe('set() snow → rain', () => {
  it('never shows snow and rain in the same frame either', () => {
    const sky = mount('snow');
    transition(sky, 'rain', 20, neverRainsAndSnows);
    expect(sky.state.snow).toBe(0);
    expect(sky.state.rain).toBeCloseTo(resolveWeather('rain').rain, 2);
  });
});

describe('set() thunderstorm → clear', () => {
  it('keeps the total cover with the genera as the deck thins out', () => {
    const sky = mount('thunderstorm');
    const bound = coverBound('thunderstorm', 'clear');
    let thinned = false;
    transition(sky, 'clear', 20, (s) => {
      expect(Math.abs(s.cloudCover - aggregateCover(s.clouds))).toBeLessThanOrEqual(bound);
      neverRainsAndSnows(s);
      if (aggregateCover(s.clouds) < 0.3) thinned = true;
    });
    // the genera did thin out while the cover followed them
    expect(thinned).toBe(true);
    expect(sky.state.cloudCover).toBeLessThan(0.01);
    expect(sky.state.rain).toBe(0);
  });
});

describe('set() between weathers whose genera add up to their cover', () => {
  // with explicit genera, resolveWeather's cover IS the genera's aggregate,
  // so a transition frame must match it to float error
  const RAINY = { clouds: { nimbostratus: 0.9, stratocumulus: 0.4 }, precipitation: 8, windSpeed: 7 };
  const SNOWY = { clouds: { nimbostratus: 0.6, altostratus: 0.5, cirrostratus: 0.3 }, precipitation: 3, precipitationType: 'snow' } as const;

  it('re-aggregates the cover from the current genera every frame, exactly', () => {
    const sky = mount(RAINY);
    transition(sky, SNOWY, 20, (s) => {
      expect(Math.abs(s.cloudCover - aggregateCover(s.clouds))).toBeLessThan(1e-9);
      neverRainsAndSnows(s);
    });
    expect(sky.state.rain).toBe(0);
    expect(sky.state.snow).toBeGreaterThan(0);
  });
});

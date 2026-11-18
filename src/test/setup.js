import { afterEach, vi } from 'vitest';
import { cleanup } from '@testing-library/react';

// jsdom has no canvas implementation; the particle canvas only needs a no-op
// 2D context to keep its animation loop alive during tests.
const createMockContext = () =>
  new Proxy(
    {},
    {
      get: (_target, prop) => {
        if (prop === 'canvas') return undefined;
        return () => {};
      },
      set: () => true,
    }
  );

HTMLCanvasElement.prototype.getContext = function getContext() {
  return createMockContext();
};

afterEach(() => {
  cleanup();
  vi.clearAllTimers();
  vi.useRealTimers();
});

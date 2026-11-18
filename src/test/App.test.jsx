import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, fireEvent, act, screen } from '@testing-library/react';

vi.mock('../utils/audio', () => ({
  audioSynth: {
    playWaterSound: vi.fn(),
    playGrowSound: vi.fn(),
    playFanfareSound: vi.fn(),
    stopAll: vi.fn(),
  },
}));

import { App } from '../App';
import { audioSynth } from '../utils/audio';

const reasons = () => document.querySelectorAll('.reason-item').length;
const modal = () => document.querySelector('.modal-card');
const waterButton = () => screen.getByRole('button', { name: /Regar con amor|Otro poquito|Está creciendo|Regar con mas amor|Floreció/ });

const clickWater = () => {
  fireEvent.click(waterButton());
};

// Waits out one full watering flow (grow/modal + ripple + input lock).
const finishFlow = () => {
  act(() => {
    vi.advanceTimersByTime(1300);
  });
};

const waterOnce = () => {
  clickWater();
  finishFlow();
};

describe('watering flow', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('ignores rapid repeated clicks and advances exactly one stage', () => {
    render(<App />);

    expect(reasons()).toBe(0);

    for (let i = 0; i < 6; i++) {
      clickWater();
    }

    // Stage update only happens once, after the delayed callback.
    expect(reasons()).toBe(0);
    act(() => {
      vi.advanceTimersByTime(400);
    });
    expect(reasons()).toBe(1);
    expect(audioSynth.playGrowSound).toHaveBeenCalledTimes(1);
    expect(audioSynth.playGrowSound).toHaveBeenCalledWith(1);

    // Remaining time does not produce extra stage jumps.
    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(reasons()).toBe(1);
    expect(audioSynth.playGrowSound).toHaveBeenCalledTimes(1);
  });

  it('opens the blessing card once and ignores the button while it is visible', () => {
    render(<App />);

    for (let i = 0; i < 5; i++) {
      waterOnce();
    }

    expect(reasons()).toBe(5);
    expect(screen.getByRole('button', { name: /Regar con mas amor/ })).toBeTruthy();
    expect(modal()).toBeNull();

    clickWater();
    // Duplicate clicks before the popup must not stack popups or stages.
    clickWater();
    clickWater();
    expect(modal()).toBeNull();

    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(modal()).not.toBeNull();
    expect(document.querySelectorAll('.modal-card').length).toBe(1);
    expect(reasons()).toBe(5);

    finishFlow();

    // Button must not advance anything while the card is on screen.
    clickWater();
    finishFlow();
    expect(reasons()).toBe(5);
    expect(document.querySelectorAll('.modal-card').length).toBe(1);
    // Five advances (stage 0 -> 5), each with its own grow sound.
    expect(audioSynth.playGrowSound).toHaveBeenCalledTimes(5);

    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(reasons()).toBe(5);
    expect(document.querySelectorAll('.modal-card').length).toBe(1);
  });

  it('resets to the initial state after blooming and never runs stale callbacks', () => {
    render(<App />);

    for (let i = 0; i < 5; i++) {
      waterOnce();
    }
    clickWater();
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(modal()).not.toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /Ver la flor de mi amor/ }));

    // Bloomed state: flower visible, card gone, button says Floreció.
    expect(modal()).toBeNull();
    expect(document.querySelector('.sunflower-bloom-wrapper.blooming')).not.toBeNull();
    expect(screen.getByRole('button', { name: /Floreció/ })).toBeTruthy();

    // Watering after bloom returns to the initial screen.
    clickWater();
    expect(reasons()).toBe(0);
    expect(modal()).toBeNull();
    expect(document.querySelector('.sunflower-bloom-wrapper.blooming')).toBeNull();
    expect(screen.getByRole('button', { name: /Regar con amor/ })).toBeTruthy();
    expect(audioSynth.stopAll).toHaveBeenCalled();

    // No stale callback may re-advance the stage or re-open the card later.
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(reasons()).toBe(0);
    expect(modal()).toBeNull();
    expect(document.querySelector('.sunflower-bloom-wrapper.blooming')).toBeNull();
    expect(screen.getByRole('button', { name: /Regar con amor/ })).toBeTruthy();
  });

  it('keeps working after a reset: watering advances one stage again', () => {
    render(<App />);

    for (let i = 0; i < 5; i++) {
      waterOnce();
    }
    clickWater();
    act(() => {
      vi.advanceTimersByTime(500);
    });
    fireEvent.click(screen.getByRole('button', { name: /Ver la flor de mi amor/ }));
    clickWater();
    finishFlow();

    expect(reasons()).toBe(0);
    clickWater();
    finishFlow();
    expect(reasons()).toBe(1);
  });
});

import Note from "@/audio/note";
import Player from "@/audio/play";
import { Track } from "@/audio/track";
import { durationToSeconds } from "@/audio/util";
import { afterEach, expect, test, vi } from "vitest";

class MockTrack implements Track {
  name: string;

  notes: Array<Note>;

  record: Array<[number, number]>;

  stopped: number;

  constructor() {
    this.name = "MockTrack";
    this.notes = [];
    this.record = [];
    this.stopped = 0;
  }

  play(
    _context: AudioContext,
    _destination: AudioNode,
    index: number,
    time: number
  ) {
    this.record.push([index, time]);
  }

  stop() {
    this.stopped += 1;
  }
}

interface MockContext extends AudioContext {
  currentTime: number;
}

function mockContext(currentTime: number): MockContext {
  return { currentTime } as MockContext;
}

afterEach(() => {
  vi.useRealTimers();
});

test("Sanity check for durationToSeconds", () => {
  const actual = durationToSeconds(60.0, 1);
  expect(actual).toBe(4.0);
});

test("Check timing for playing tracks", () => {
  const context = mockContext(0.1);
  const destination = {} as AudioNode;
  const track = new MockTrack();

  const player = new Player(16, 1 / 16, 0.075, 120.0, 0.025);
  player.playTick(context, destination, [track]);

  expect(track.record).toEqual([[0, 0.15]]);
});

test("Stopping cancels scheduling and silences pending audio", () => {
  vi.useFakeTimers();

  const context = mockContext(0.1);
  const destination = {} as AudioNode;
  const track = new MockTrack();

  const player = new Player(16, 1 / 16, 0.075, 120.0, 0.025);
  player.start(context, destination, [track]);

  expect(player.loop).toBe(true);
  expect(track.record).toHaveLength(1);
  expect(track.record[0][0]).toBe(0);
  expect(track.record[0][1]).toBeCloseTo(0.1);

  player.stop();

  expect(player.loop).toBe(false);
  expect(player.index).toBe(-1);
  expect(track.stopped).toBe(1);
  expect(vi.getTimerCount()).toBe(0);

  const scheduled = track.record.length;
  context.currentTime = 1.0;
  vi.advanceTimersByTime(1000);

  expect(track.record).toHaveLength(scheduled);
});

test("Stopping while looping prevents later scheduler runs", () => {
  vi.useFakeTimers();

  const context = mockContext(0);
  const destination = {} as AudioNode;
  const track = new MockTrack();

  const player = new Player(16, 1 / 16, 0.075, 120.0, 0.025);
  player.start(context, destination, [track]);

  const scheduled = track.record.length;
  player.stop();

  context.currentTime = 10.0;
  vi.advanceTimersByTime(1000);

  expect(track.record).toHaveLength(scheduled);
  expect(player.index).toBe(-1);
});

test("Restarting playback begins at the first step", () => {
  vi.useFakeTimers();

  const context = mockContext(0.1);
  const destination = {} as AudioNode;
  const track = new MockTrack();

  const player = new Player(16, 1 / 16, 0.075, 120.0, 0.025);
  player.start(context, destination, [track]);

  // Advance the audio clock and let the loop schedule several steps.
  context.currentTime = 0.2;
  vi.advanceTimersByTime(50);
  expect(player.index).toBeGreaterThan(0);

  player.stop();
  track.record = [];

  // Changing the tempo while stopped affects the next playback run.
  player.tempo = 60.0;
  context.currentTime = 5.0;
  player.start(context, destination, [track]);

  expect(player.index).toBe(0);
  expect(track.record[0][0]).toBe(0);
  expect(track.record[0][1]).toBeCloseTo(5.0);
});

test("Repeated starts do not create parallel scheduler chains", () => {
  vi.useFakeTimers();

  const context = mockContext(0);
  const destination = {} as AudioNode;
  const track = new MockTrack();

  const player = new Player(16, 1 / 16, 0.075, 120.0, 0.025);
  player.start(context, destination, [track]);
  player.start(context, destination, [track]);

  // Only the second run may have a pending timeout.
  expect(vi.getTimerCount()).toBe(1);

  player.stop();
  expect(vi.getTimerCount()).toBe(0);
  expect(track.stopped).toBe(2);
});

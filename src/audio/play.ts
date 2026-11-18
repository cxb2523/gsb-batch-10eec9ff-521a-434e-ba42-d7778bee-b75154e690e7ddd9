import { Track } from "@/audio/track";
import { durationToSeconds } from "@/audio/util";

/**
 * Manages playback and scheduling of tracks through a web audio context.
 */
export default class Player {
  /** Internal position counter. */
  index: number;

  length: number;

  lookahead: number;

  /** Whether playback is currently active. */
  loop: boolean;

  step: number;

  tempo: number;

  /** Audio context time of the last scheduled step. */
  timer: number;

  tick: number;

  /** Handle for the pending scheduler timeout, if any. */
  timeout?: ReturnType<typeof setTimeout>;

  /** Audio context time and grid index of each scheduled step. */
  steps: Array<{ index: number; time: number }>;

  /** Identifier of the current scheduler chain. */
  private _run: number;

  /** Tracks of the current playback run. */
  private _tracks: Array<Track>;

  constructor(
    length: number,
    lookahead: number,
    step: number,
    tempo: number,
    tick: number
  ) {
    this.index = -1;
    this.length = length;
    this.lookahead = lookahead;
    this.loop = false;
    this.step = step;
    this.tempo = tempo;
    this.tick = tick;
    this.timer = 0;
    this._run = 0;
    this.steps = [];
    this._tracks = [];
  }

  /**
   * Grid index of the step that is audible at a given audio context time.
   *
   * @param time  Audio context time.
   * @returns Index of the audible step, or -1 when nothing is scheduled.
   */
  position(time: number): number {
    let index = -1;

    this.steps.forEach((step) => {
      if (step.time <= time) {
        index = step.index;
      }
    });

    return index;
  }

  /**
   * Check if next audio step is within the current schedular lookahead range.
   *
   * @param stepDuration  Size of next audio step.
   * @param stop  End of lookahead range.
   * @returns Whether step is within the current schedular lookahead range.
   */
  next(stepDuration: number, lookaheadStop: number): boolean {
    if (this.timer + stepDuration >= lookaheadStop) {
      return false;
    }

    this.timer += stepDuration;
    this.index = (this.index + 1) % this.length;
    return true;
  }

  /**
   * Schedules audio playback for tracks.
   *
   * Tempo is read on every tick, so changes while playing take effect on the
   * next scheduled step.
   *
   * @param context  Associated audio context.
   * @param tracks  Tracks to play.
   */
  playTick(
    context: AudioContext,
    destination: AudioNode,
    tracks: Array<Track>
  ): void {
    this._tracks = tracks;

    const stepDuration = durationToSeconds(this.tempo, this.step);

    // An invalid tempo would otherwise schedule nothing or rewind the
    // scheduler into an endless catch up loop.
    if (Number.isFinite(stepDuration) && stepDuration > 0) {
      // If the timer fell more than one step behind the audio clock, such
      // as when a tab was throttled, resynchronize rather than scheduling a
      // burst of steps whose time has already passed. Playback resumes with
      // the next step starting at the current audio time.
      if (this.timer < context.currentTime - stepDuration) {
        this.timer = context.currentTime - stepDuration;
      }

      const lookaheadStop = context.currentTime + this.lookahead;

      while (this.next(stepDuration, lookaheadStop)) {
        this.steps.push({ index: this.index, time: this.timer });

        tracks.forEach((track) =>
          track.play(context, destination, this.index, this.timer)
        );
      }

      // Only keep steps around the audio clock that have not been superseded
      // yet, so the list does not grow without bound during a long loop.
      this.steps = this.steps.filter(
        (step) => step.time >= context.currentTime - stepDuration
      );
    }

    if (this.loop) {
      const run = this._run;

      this.timeout = setTimeout(() => {
        this.timeout = undefined;

        // A stale timeout from a previous run must not advance a newly
        // started scheduler chain.
        if (this.loop && this._run === run) {
          this.playTick(context, destination, tracks);
        }
      }, 1000 * this.tick);
    }
  }

  /**
   * Start playback from the first step.
   *
   * Any previous playback run is stopped first, so repeated starts can not
   * create parallel scheduler chains. The first step is scheduled at the
   * current audio time, which keeps the grid position aligned with the
   * audible beat.
   *
   * @param context  Associated audio context.
   * @param destination  Node to connect track audio to.
   * @param tracks  Tracks to play.
   */
  start(
    context: AudioContext,
    destination: AudioNode,
    tracks: Array<Track>
  ): void {
    this.stop();

    const stepDuration = durationToSeconds(this.tempo, this.step);
    if (!Number.isFinite(stepDuration) || stepDuration <= 0) {
      return;
    }

    this.loop = true;
    this.index = -1;
    this.timer = context.currentTime - stepDuration;

    this.playTick(context, destination, tracks);
  }

  /**
   * Stop playback, cancel pending scheduling, and silence audio that was
   * scheduled but has not finished playing yet.
   */
  stop(): void {
    this.loop = false;
    this._run += 1;

    if (this.timeout !== undefined) {
      clearTimeout(this.timeout);
      this.timeout = undefined;
    }

    this._tracks.forEach((track) => track.stop?.());
    this._tracks = [];
    this.steps = [];
    this.index = -1;
    this.timer = 0;
  }
}

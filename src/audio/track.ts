import Note from "@/audio/note";
import { getSample } from "@/audio/util";

export interface Track {
  name: string;
  notes: Array<Note>;
  play(
    context: AudioContext,
    destination: AudioNode,
    index: number,
    time: number
  ): void;
  /**
   * Silence audio that has been scheduled but has not finished playing yet.
   */
  stop?(): void;
}

export class SampleTrack implements Track {
  buffer: AudioBuffer | null;

  filePath: string;

  name: string;

  notes: Array<Note>;

  step: number;

  /** Sources scheduled by the loop that have not finished playing yet. */
  sources: Set<AudioBufferSourceNode>;

  constructor(name: string, filePath: string, length: number) {
    this.buffer = null;
    this.filePath = filePath;
    this.name = name;
    this.notes = Array.from({ length }, (_, index) => ({
      active: false,
      index,
    }));
    this.step = length;
    this.sources = new Set();
  }

  async loadSample(context: AudioContext): Promise<void> {
    this.buffer = await getSample(context, this.filePath);
  }

  /**
   * Play a single preview of this track without registering it for playback.
   */
  note(context: AudioContext, destination: AudioNode, time: number): void {
    const source = this._source(context, destination);
    source.onended = () => source.disconnect();
    source.start(time);
  }

  play(
    context: AudioContext,
    destination: AudioNode,
    index: number,
    time: number
  ): void {
    if (!this.notes[index].active) {
      return;
    }

    const source = this._source(context, destination);
    this.sources.add(source);

    // Forget the source once it finishes so the set does not grow without
    // bound during a long playback session.
    source.onended = () => {
      this.sources.delete(source);
      source.disconnect();
    };

    source.start(time);
  }

  stop(): void {
    this.sources.forEach((source) => {
      try {
        source.stop();
      } catch {
        // The source has already finished playing.
      }
      source.disconnect();
    });
    this.sources.clear();
  }

  private _source(
    context: AudioContext,
    destination: AudioNode
  ): AudioBufferSourceNode {
    const source = context.createBufferSource();
    source.buffer = this.buffer;
    source.connect(destination);
    return source;
  }
}

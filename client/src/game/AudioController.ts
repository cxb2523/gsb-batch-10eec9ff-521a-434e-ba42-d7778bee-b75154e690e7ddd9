import type { CustomizationSnapshot } from "../../../shared/customization";

/**
 * Structural subset of HTMLAudioElement the controller needs. Real elements
 * satisfy it directly; tests pass hand-written stubs.
 */
export interface AudioElementLike {
  src: string;
  volume: number;
  muted: boolean;
  currentTime: number;
  paused: boolean;
  play(): Promise<void> | void;
  pause(): void;
  load(): void;
  removeAttribute?(qualifiedName: string): void;
}

function sourcesDiffer(current: string, next: string | undefined): boolean {
  return (current ?? "") !== (next ?? "");
}

/**
 * Owns the two custom audio channels (ambient loop and lift sound).
 *
 * React keeps rendering the <audio> elements and dispatching customization
 * events; this controller guarantees that muting, volume changes, and source
 * swaps take effect immediately and that an old source is stopped and unloaded
 * before a new one can play.
 */
export class AudioController {
  private ambientUrl = "";
  private flapUrl = "";
  private muted = false;
  private volume = 1;

  constructor(
    private readonly ambient: AudioElementLike,
    private readonly flap: AudioElementLike
  ) {}

  /** Applies a full snapshot: settings first so a new source starts at the right level. */
  applySnapshot(snapshot: CustomizationSnapshot): void {
    this.applySettings(snapshot.settings.volume, snapshot.settings.muted);
    this.setAmbientSource(snapshot.assets.ambientAudio?.url);
    this.setFlapSource(snapshot.assets.flapAudio?.url);
  }

  /**
   * Updates gain and mute on both channels immediately. Unmuting resumes the
   * ambient loop when a track is loaded.
   */
  applySettings(volume: number, muted: boolean): void {
    this.volume = volume;
    this.muted = muted;
    for (const element of [this.ambient, this.flap]) {
      element.volume = volume;
      element.muted = muted;
    }
    if (!muted && this.ambientUrl) {
      this.safePlay(this.ambient);
    }
  }

  /**
   * Swaps the ambient track. The previous source is paused, rewound, unloaded,
   * and the element src cleared so it cannot keep playing behind the new one.
   */
  setAmbientSource(url: string | undefined): void {
    const next = url ?? "";
    if (!sourcesDiffer(this.ambientUrl, next)) return;
    this.ambientUrl = next;
    this.swapSource(this.ambient, next);
    // The ambient loop only starts after the first player interaction.
    if (next && !this.muted) {
      this.safePlay(this.ambient);
    }
  }

  /**
   * Swaps the lift sound. A flap sound mid-play is cut immediately and the old
   * source is unloaded; the new sound stays armed for the next lift action.
   */
  setFlapSource(url: string | undefined): void {
    const next = url ?? "";
    if (!sourcesDiffer(this.flapUrl, next)) return;
    this.flapUrl = next;
    this.swapSource(this.flap, next);
  }

  /** Handles a lift action: keeps the ambient loop alive and fires the flap sound. */
  onFlap(): void {
    if (this.muted) return;
    if (this.ambientUrl) {
      this.safePlay(this.ambient);
    }
    if (this.flapUrl) {
      this.flap.currentTime = 0;
      this.safePlay(this.flap);
    }
  }

  /** Stops every channel and releases the media resources on unmount. */
  dispose(): void {
    for (const element of [this.ambient, this.flap]) {
      element.pause();
      element.currentTime = 0;
      element.removeAttribute?.("src");
      element.load();
    }
    this.ambientUrl = "";
    this.flapUrl = "";
  }

  private swapSource(element: AudioElementLike, url: string): void {
    element.pause();
    element.currentTime = 0;
    if (url) {
      element.src = url;
    } else {
      element.removeAttribute?.("src");
    }
    // load() aborts and releases the previous media resource and arms the new src.
    element.load();
  }

  private safePlay(element: AudioElementLike): void {
    try {
      const result = element.play();
      if (result && typeof result.catch === "function") {
        result.catch(() => undefined);
      }
    } catch {
      // Autoplay can be blocked before a user gesture; gameplay stays functional.
    }
  }
}

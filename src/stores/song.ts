import Player from "@/audio/play";
import { SampleTrack } from "@/audio/track";
import { defineStore } from "pinia";
import { reactive, ref } from "vue";

class Audio {
  private _context?: AudioContext;
  private _gainNode?: GainNode;

  // Browsers require an audio context to start or resume after a
  // user event. For more information, visit https://goo.gl/7K7WLu.
  context(): AudioContext {
    if (this._context === undefined) {
      this._context = new AudioContext();
    }
    return this._context;
  }

  /**
   * Shared output node. Playback, note previews, volume, and mute all route
   * through this single gain node.
   */
  gainNode(): GainNode {
    if (this._gainNode === undefined) {
      const context = this.context();
      this._gainNode = context.createGain();
      this._gainNode.connect(context.destination);
    }
    return this._gainNode;
  }
}

export const useSongStore = defineStore("song", () => {
  const audio = new Audio();
  const alert = reactive({ message: "", type: "error" });
  const player = ref(new Player(16, 1 / 16, 0.075, 120.0, 0.025));
  const tempo = ref(120);
  const tracks = reactive([
    new SampleTrack("Kick", "data/kick.wav", player.value.length),
    new SampleTrack("Snare", "data/snare.wav", player.value.length),
    new SampleTrack("Mid-Tom", "data/tom.wav", player.value.length),
    new SampleTrack("Hi-Hat", "data/hi_hat.wav", player.value.length),
  ]);
  const volume = ref(100.0);
  /** Grid index of the step that is currently audible. */
  const playingIndex = ref(-1);
  let frame = 0;

  /**
   * Follow the audio clock and update the highlighted grid step.
   *
   * The audio clock is authoritative, so the highlight stays aligned with the
   * sound even when tempo changes or the scheduler timer is delayed.
   */
  function followPlayhead(): void {
    const context = audio.context();
    playingIndex.value = player.value.position(context.currentTime);

    // Guard the animation frame API so the store also works in environments
    // without a rendering loop, such as unit tests.
    if (player.value.loop && typeof requestAnimationFrame === "function") {
      frame = requestAnimationFrame(followPlayhead);
    }
  }

  function startPlayhead(): void {
    if (typeof cancelAnimationFrame === "function") {
      cancelAnimationFrame(frame);
    }
    followPlayhead();
  }

  function stopPlayhead(): void {
    if (typeof cancelAnimationFrame === "function") {
      cancelAnimationFrame(frame);
    }
    frame = 0;
    playingIndex.value = -1;
  }

  function resetAlert(): void {
    alert.message = "";
  }

  async function loadSamples(): Promise<void> {
    await Promise.all(tracks.map((track) => track.loadSample(audio.context())));
  }

  function setTempo(value: number): void {
    tempo.value = value;

    // Ignore transient invalid values, such as an empty input field, so that
    // a running loop keeps its last valid tempo instead of stalling.
    if (Number.isFinite(value) && value > 0) {
      player.value.tempo = value;
    }
  }

  function setVolume(value: number): void {
    volume.value = value;
    audio.gainNode().gain.value = value / 100.0;
  }

  function playNote(trackName: string): void {
    const context = audio.context();
    context.resume();

    const track = tracks.filter((track) => track.name == trackName)[0];
    track.note(context, audio.gainNode(), context.currentTime);
  }

  function toggleNoteActive(trackName: string, noteIndex: number): void {
    const track = tracks.filter((track) => track.name == trackName)[0];
    track.notes[noteIndex].active = !track.notes[noteIndex].active;
  }

  function togglePlaying(): void {
    if (player.value.loop) {
      player.value.stop();
      stopPlayhead();
      return;
    }

    if (!Number.isFinite(tempo.value) || tempo.value <= 0) {
      alert.message = "Tempo must be a postive number";
      alert.type = "error";
      return;
    }

    const context = audio.context();
    context.resume();
    player.value.start(context, audio.gainNode(), tracks);
    startPlayhead();
  }

  return {
    alert,
    audio,
    loadSamples,
    player,
    playingIndex,
    playNote,
    resetAlert,
    setTempo,
    setVolume,
    tempo,
    toggleNoteActive,
    togglePlaying,
    tracks,
    volume,
  };
});

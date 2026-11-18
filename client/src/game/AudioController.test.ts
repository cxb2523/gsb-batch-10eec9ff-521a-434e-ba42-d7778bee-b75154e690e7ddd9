import { describe, expect, it, vi } from "vitest";
import { AudioController, type AudioElementLike } from "./AudioController";
import {
  CUSTOMIZATION_DEFAULTS,
  type CustomizationSnapshot,
} from "../../../shared/customization";

type StubAudio = AudioElementLike & {
  play: ReturnType<typeof vi.fn>;
  pause: ReturnType<typeof vi.fn>;
  load: ReturnType<typeof vi.fn>;
  removeAttribute: ReturnType<typeof vi.fn>;
};

function createAudioStub(): StubAudio {
  const stub: StubAudio = {
    src: "",
    volume: 1,
    muted: false,
    currentTime: 0,
    paused: true,
    play: vi.fn(() => Promise.resolve()),
    pause: vi.fn(),
    load: vi.fn(),
    // Mirrors the DOM: removing the reflected src attribute clears the property.
    removeAttribute: vi.fn((qualifiedName: string) => {
      if (qualifiedName === "src") stub.src = "";
    }),
  };
  return stub;
}

function createController() {
  const ambient = createAudioStub();
  const flap = createAudioStub();
  const controller = new AudioController(ambient, flap);
  return { controller, ambient, flap };
}

function snapshot(
  overrides: Partial<CustomizationSnapshot["settings"]> = {},
  assets: CustomizationSnapshot["assets"] = {}
): CustomizationSnapshot {
  return {
    settings: { ...CUSTOMIZATION_DEFAULTS, ...overrides },
    assets,
  };
}

function audioRecord(url: string) {
  return {
    slot: "ambientAudio" as const,
    url,
    fileName: "track.mp3",
    mimeType: "audio/mpeg",
  };
}

describe("AudioController settings", () => {
  it("applies volume and mute to both channels immediately", () => {
    const { controller, ambient, flap } = createController();

    controller.applySettings(0.32, false);
    expect(ambient.volume).toBe(0.32);
    expect(flap.volume).toBe(0.32);
    expect(ambient.muted).toBe(false);
    expect(flap.muted).toBe(false);

    controller.applySettings(0.32, true);
    expect(ambient.muted).toBe(true);
    expect(flap.muted).toBe(true);
  });

  it("mutes without starting playback and resumes ambient on unmute", () => {
    const { controller, ambient } = createController();
    controller.setAmbientSource("data:audio/mpeg;base64,ambient");
    ambient.play.mockClear();

    controller.applySettings(0.5, true);
    expect(ambient.play).not.toHaveBeenCalled();

    controller.applySettings(0.5, false);
    expect(ambient.play).toHaveBeenCalledTimes(1);
  });

  it("unmuting with no ambient track does not attempt playback", () => {
    const { controller, ambient } = createController();
    controller.applySettings(0.5, true);
    ambient.play.mockClear();

    controller.applySettings(0.5, false);
    expect(ambient.play).not.toHaveBeenCalled();
  });
});

describe("AudioController source switching", () => {
  it("arms a new ambient source and loads it", () => {
    const { controller, ambient } = createController();

    controller.setAmbientSource("data:audio/mpeg;base64,a");

    expect(ambient.src).toBe("data:audio/mpeg;base64,a");
    expect(ambient.load).toHaveBeenCalledTimes(1);
    expect(ambient.play).toHaveBeenCalledTimes(1);
  });

  it("pauses, rewinds, and unloads the old source before swapping ambient tracks", () => {
    const { controller, ambient } = createController();
    controller.setAmbientSource("data:audio/mpeg;base64,a");
    ambient.pause.mockClear();
    ambient.load.mockClear();

    controller.setAmbientSource("data:audio/mpeg;base64,b");

    expect(ambient.pause).toHaveBeenCalled();
    expect(ambient.currentTime).toBe(0);
    expect(ambient.src).toBe("data:audio/mpeg;base64,b");
    expect(ambient.load).toHaveBeenCalledTimes(1);
  });

  it("stops the old flap sound immediately when replaced", () => {
    const { controller, flap } = createController();
    controller.setFlapSource("data:audio/mpeg;base64,flap-a");
    flap.pause.mockClear();
    flap.load.mockClear();

    controller.setFlapSource("data:audio/mpeg;base64,flap-b");

    expect(flap.pause).toHaveBeenCalled();
    expect(flap.currentTime).toBe(0);
    expect(flap.src).toBe("data:audio/mpeg;base64,flap-b");
    expect(flap.load).toHaveBeenCalledTimes(1);
  });

  it("clearing a source removes the src attribute and reloads", () => {
    const { controller, ambient } = createController();
    controller.setAmbientSource("data:audio/mpeg;base64,a");
    ambient.removeAttribute.mockClear();
    ambient.load.mockClear();

    controller.setAmbientSource(undefined);

    expect(ambient.removeAttribute).toHaveBeenCalledWith("src");
    expect(ambient.src).toBe("");
    expect(ambient.load).toHaveBeenCalledTimes(1);
    expect(ambient.pause).toHaveBeenCalled();
  });

  it("ignores redundant source assignments", () => {
    const { controller, ambient } = createController();
    controller.setAmbientSource("data:audio/mpeg;base64,a");
    ambient.load.mockClear();
    ambient.play.mockClear();

    controller.setAmbientSource("data:audio/mpeg;base64,a");

    expect(ambient.load).not.toHaveBeenCalled();
    expect(ambient.play).not.toHaveBeenCalled();
  });

  it("does not autoplay a newly selected ambient track while muted", () => {
    const { controller, ambient } = createController();
    controller.applySettings(0.7, true);

    controller.setAmbientSource("data:audio/mpeg;base64,a");
    expect(ambient.play).not.toHaveBeenCalled();
  });

  it("arms flap sources without autoplaying them", () => {
    const { controller, flap } = createController();
    controller.setFlapSource("data:audio/mpeg;base64,flap");
    expect(flap.play).not.toHaveBeenCalled();
  });
});

describe("AudioController flap actions", () => {
  it("plays the flap sound from the start and keeps ambient alive", () => {
    const { controller, ambient, flap } = createController();
    controller.setAmbientSource("data:audio/mpeg;base64,ambient");
    controller.setFlapSource("data:audio/mpeg;base64,flap");
    ambient.play.mockClear();
    flap.play.mockClear();
    flap.currentTime = 0.6;

    controller.onFlap();

    expect(flap.currentTime).toBe(0);
    expect(flap.play).toHaveBeenCalledTimes(1);
    expect(ambient.play).toHaveBeenCalledTimes(1);
  });

  it("does nothing while muted", () => {
    const { controller, ambient, flap } = createController();
    controller.setAmbientSource("data:audio/mpeg;base64,ambient");
    controller.setFlapSource("data:audio/mpeg;base64,flap");
    controller.applySettings(0.7, true);
    ambient.play.mockClear();
    flap.play.mockClear();

    controller.onFlap();

    expect(ambient.play).not.toHaveBeenCalled();
    expect(flap.play).not.toHaveBeenCalled();
  });

  it("works when only one of the two channels is configured", () => {
    const { controller, ambient, flap } = createController();
    controller.setFlapSource("data:audio/mpeg;base64,flap");

    controller.onFlap();

    expect(flap.play).toHaveBeenCalledTimes(1);
    expect(ambient.play).not.toHaveBeenCalled();
  });

  it("swallows rejected play promises without throwing", () => {
    const { controller, flap } = createController();
    flap.play.mockImplementation(() => Promise.reject(new Error("blocked")));
    controller.setFlapSource("data:audio/mpeg;base64,flap");

    expect(() => controller.onFlap()).not.toThrow();
  });

  it("also tolerates play() throwing synchronously", () => {
    const { controller, flap } = createController();
    flap.play.mockImplementation(() => {
      throw new Error("not allowed");
    });
    controller.setFlapSource("data:audio/mpeg;base64,flap");

    expect(() => controller.onFlap()).not.toThrow();
  });
});

describe("AudioController snapshots and teardown", () => {
  it("applies a full snapshot: settings then both sources", () => {
    const { controller, ambient, flap } = createController();

    controller.applySnapshot(
      snapshot(
        { volume: 0.4, muted: false },
        {
          ambientAudio: audioRecord("data:audio/mpeg;base64,ambient"),
          flapAudio: {
            slot: "flapAudio",
            url: "data:audio/mpeg;base64,flap",
            fileName: "flap.mp3",
            mimeType: "audio/mpeg",
          },
        }
      )
    );

    expect(ambient.volume).toBe(0.4);
    expect(flap.volume).toBe(0.4);
    expect(ambient.src).toBe("data:audio/mpeg;base64,ambient");
    expect(flap.src).toBe("data:audio/mpeg;base64,flap");
  });

  it("dispose stops and unloads every channel", () => {
    const { controller, ambient, flap } = createController();
    controller.setAmbientSource("data:audio/mpeg;base64,a");
    controller.setFlapSource("data:audio/mpeg;base64,f");

    controller.dispose();

    for (const element of [ambient, flap]) {
      expect(element.pause).toHaveBeenCalled();
      expect(element.currentTime).toBe(0);
      expect(element.removeAttribute).toHaveBeenCalledWith("src");
      expect(element.load).toHaveBeenCalled();
    }
  });
});

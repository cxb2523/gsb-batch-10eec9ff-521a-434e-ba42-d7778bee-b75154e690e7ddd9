import { describe, expect, it, vi } from "vitest";
import {
  applyCustomizationSnapshot,
  resolveBackgroundState,
  type WorldCustomizationView,
} from "./customizationController";
import {
  CUSTOMIZATION_DEFAULTS,
  type CustomizationSettings,
  type CustomizationSnapshot,
} from "../../../shared/customization";

function settings(
  overrides: Partial<CustomizationSettings> = {}
): CustomizationSettings {
  return { ...CUSTOMIZATION_DEFAULTS, ...overrides };
}

function snapshot(
  settingsOverrides: Partial<CustomizationSettings> = {},
  assets: CustomizationSnapshot["assets"] = {}
): CustomizationSnapshot {
  return { settings: settings(settingsOverrides), assets };
}

function record(slot: string, url: string) {
  return {
    slot: slot as never,
    url,
    fileName: `${slot}.bin`,
    mimeType: "application/octet-stream",
  };
}

function createViewStub(): WorldCustomizationView & {
  calls: string[];
  accent: string[];
  paces: number[];
  reflowArgs: Array<[string, number]>;
  planeUrls: string[];
  backgroundCalls: string[];
} {
  const calls: string[] = [];
  return {
    calls,
    accent: [],
    paces: [],
    reflowArgs: [],
    planeUrls: [],
    backgroundCalls: [],
    setAccentColor(hexColor) {
      calls.push("accent");
      this.accent.push(hexColor);
    },
    setPace(pace) {
      calls.push("pace");
      this.paces.push(pace);
    },
    reflowGates(gateColor, gateOpening) {
      calls.push("reflow");
      this.reflowArgs.push([gateColor, gateOpening]);
    },
    showCustomPlane(imageUrl) {
      calls.push("showPlane");
      this.planeUrls.push(imageUrl);
    },
    clearCustomPlane() {
      calls.push("clearPlane");
    },
    showDefaultBackground() {
      calls.push("defaultBg");
      this.backgroundCalls.push("default");
    },
    showCustomBackground(mode) {
      calls.push("customBg");
      this.backgroundCalls.push(mode);
    },
  };
}

describe("resolveBackgroundState", () => {
  it("returns the default background for the default mode regardless of assets", () => {
    const state = resolveBackgroundState(settings(), {
      backgroundImage: record("backgroundImage", "data:image/png;base64,aa"),
      backgroundVideo: record("backgroundVideo", "data:video/mp4;base64,bb"),
    });
    expect(state).toEqual({ kind: "default" });
  });

  it("selects a custom image only when image mode and an image url exist", () => {
    const state = resolveBackgroundState(
      settings({ backgroundMode: "image" }),
      {
        backgroundImage: record("backgroundImage", "data:image/png;base64,aa"),
      }
    );
    expect(state).toEqual({ kind: "custom", mode: "image" });
  });

  it("selects a custom video only when video mode and a video url exist", () => {
    const state = resolveBackgroundState(
      settings({ backgroundMode: "video" }),
      {
        backgroundVideo: record("backgroundVideo", "data:video/mp4;base64,bb"),
      }
    );
    expect(state).toEqual({ kind: "custom", mode: "video" });
  });

  it("falls back to default when the selected mode has no matching asset", () => {
    const imageModeNoAsset = resolveBackgroundState(
      settings({ backgroundMode: "image" }),
      { backgroundVideo: record("backgroundVideo", "data:video/mp4;base64,bb") }
    );
    expect(imageModeNoAsset).toEqual({ kind: "default" });

    const videoModeNoAsset = resolveBackgroundState(
      settings({ backgroundMode: "video" }),
      { backgroundImage: record("backgroundImage", "data:image/png;base64,aa") }
    );
    expect(videoModeNoAsset).toEqual({ kind: "default" });
  });

  it("never lets an image and video background be active at the same time", () => {
    const imageState = resolveBackgroundState(
      settings({ backgroundMode: "image" }),
      {
        backgroundImage: record("backgroundImage", "data:image/png;base64,aa"),
        backgroundVideo: record("backgroundVideo", "data:video/mp4;base64,bb"),
      }
    );
    expect(imageState).toEqual({ kind: "custom", mode: "image" });

    const videoState = resolveBackgroundState(
      settings({ backgroundMode: "video" }),
      {
        backgroundImage: record("backgroundImage", "data:image/png;base64,aa"),
        backgroundVideo: record("backgroundVideo", "data:video/mp4;base64,bb"),
      }
    );
    expect(videoState).toEqual({ kind: "custom", mode: "video" });
  });

  it("switches straight from a video background back to the default background", () => {
    const state = resolveBackgroundState(
      settings({ backgroundMode: "default" }),
      { backgroundVideo: record("backgroundVideo", "data:video/mp4;base64,bb") }
    );
    expect(state).toEqual({ kind: "default" });
  });
});

describe("applyCustomizationSnapshot", () => {
  it("applies the full default snapshot through the view", () => {
    const view = createViewStub();
    applyCustomizationSnapshot(snapshot(), view);

    expect(view.accent).toEqual([CUSTOMIZATION_DEFAULTS.accentColor]);
    expect(view.paces).toEqual([CUSTOMIZATION_DEFAULTS.pace]);
    expect(view.reflowArgs).toEqual([
      [CUSTOMIZATION_DEFAULTS.gateColor, CUSTOMIZATION_DEFAULTS.gateOpening],
    ]);
    expect(view.calls).toContain("clearPlane");
    expect(view.backgroundCalls).toEqual(["default"]);
  });

  it("shows custom plane art when a plane image url is present", () => {
    const view = createViewStub();
    applyCustomizationSnapshot(
      snapshot(
        {},
        { planeImage: record("planeImage", "data:image/png;base64,plane") }
      ),
      view
    );
    expect(view.planeUrls).toEqual(["data:image/png;base64,plane"]);
    expect(view.calls).not.toContain("clearPlane");
  });

  it("clears custom plane art when the plane asset is removed", () => {
    const view = createViewStub();
    applyCustomizationSnapshot(
      snapshot(
        {},
        { planeImage: record("planeImage", "data:image/png;base64,plane") }
      ),
      view
    );
    applyCustomizationSnapshot(snapshot(), view);

    expect(view.calls.lastIndexOf("clearPlane")).toBeGreaterThan(
      view.calls.lastIndexOf("showPlane")
    );
  });

  it("reflows existing gates with the new color and opening multiplier", () => {
    const view = createViewStub();
    applyCustomizationSnapshot(
      snapshot({ gateColor: "#112233", gateOpening: 1.15 }),
      view
    );
    expect(view.reflowArgs).toEqual([["#112233", 1.15]]);
  });

  it("routes image and video modes to distinct background callbacks", () => {
    const imageView = createViewStub();
    applyCustomizationSnapshot(
      snapshot(
        { backgroundMode: "image" },
        {
          backgroundImage: record(
            "backgroundImage",
            "data:image/png;base64,sky"
          ),
        }
      ),
      imageView
    );
    expect(imageView.backgroundCalls).toEqual(["image"]);

    const videoView = createViewStub();
    applyCustomizationSnapshot(
      snapshot(
        { backgroundMode: "video" },
        {
          backgroundVideo: record(
            "backgroundVideo",
            "data:video/mp4;base64,loop"
          ),
        }
      ),
      videoView
    );
    expect(videoView.backgroundCalls).toEqual(["video"]);
  });

  it("always reflows gates even while the flight is in progress", () => {
    const view = createViewStub();
    applyCustomizationSnapshot(snapshot({ pace: 1.3, gateOpening: 0.8 }), view);
    expect(view.paces).toEqual([1.3]);
    expect(view.reflowArgs[0][1]).toBe(0.8);
  });

  it("only touches visual operations, never score or flight phase", () => {
    const view: WorldCustomizationView = {
      setAccentColor: vi.fn(),
      setPace: vi.fn(),
      reflowGates: vi.fn(),
      showCustomPlane: vi.fn(),
      clearCustomPlane: vi.fn(),
      showDefaultBackground: vi.fn(),
      showCustomBackground: vi.fn(),
    };
    applyCustomizationSnapshot(
      snapshot(
        { gateOpening: 0.9 },
        { planeImage: record("planeImage", "data:image/png;base64,p") }
      ),
      view
    );

    // The contract surface has no score/phase hooks for customization to misuse.
    expect(Object.keys(view).sort()).toEqual(
      [
        "clearCustomPlane",
        "reflowGates",
        "setAccentColor",
        "setPace",
        "showCustomBackground",
        "showCustomPlane",
        "showDefaultBackground",
      ].sort()
    );
    expect(view.setPace).toHaveBeenCalledTimes(1);
    expect(view.reflowGates).toHaveBeenCalledWith(
      CUSTOMIZATION_DEFAULTS.gateColor,
      0.9
    );
  });
});

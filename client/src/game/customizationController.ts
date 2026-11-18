import type {
  BackgroundMode,
  CustomizationAssetRecord,
  CustomizationSettings,
  CustomizationSnapshot,
} from "../../../shared/customization";

export type CustomBackgroundMode = Exclude<BackgroundMode, "default">;

export type BackgroundState =
  | { kind: "default" }
  | { kind: "custom"; mode: CustomBackgroundMode };

/**
 * Decides which background the scene must present. Only one background can ever
 * be active: a selected mode without a matching asset falls back to the default
 * instead of leaving a stale image or video layer on screen.
 */
export function resolveBackgroundState(
  settings: CustomizationSettings,
  assets: Partial<Record<string, CustomizationAssetRecord>>
): BackgroundState {
  if (
    settings.backgroundMode === "image" &&
    Boolean(assets.backgroundImage?.url)
  ) {
    return { kind: "custom", mode: "image" };
  }
  if (
    settings.backgroundMode === "video" &&
    Boolean(assets.backgroundVideo?.url)
  ) {
    return { kind: "custom", mode: "video" };
  }
  return { kind: "default" };
}

/**
 * Rendering-side operations needed to apply a customization snapshot.
 * GameWorld implements this interface with Babylon meshes and materials;
 * tests can supply hand-written stubs.
 */
export interface WorldCustomizationView {
  setAccentColor(hexColor: string): void;
  setPace(pace: number): void;
  reflowGates(gateColor: string, gateOpening: number): void;
  showCustomPlane(imageUrl: string): void;
  clearCustomPlane(): void;
  showDefaultBackground(): void;
  showCustomBackground(mode: CustomBackgroundMode): void;
}

/**
 * Applies a full customization snapshot without touching score, best score, or
 * the flight phase. Every branch goes through the view so resource cleanup is
 * owned by the renderer and remains deterministic.
 */
export function applyCustomizationSnapshot(
  snapshot: CustomizationSnapshot,
  view: WorldCustomizationView
): void {
  const { settings, assets } = snapshot;

  view.setAccentColor(settings.accentColor);
  view.setPace(settings.pace);
  view.reflowGates(settings.gateColor, settings.gateOpening);

  const planeUrl = assets.planeImage?.url;
  if (planeUrl) {
    view.showCustomPlane(planeUrl);
  } else {
    view.clearCustomPlane();
  }

  const background = resolveBackgroundState(settings, assets);
  if (background.kind === "custom") {
    view.showCustomBackground(background.mode);
  } else {
    view.showDefaultBackground();
  }
}

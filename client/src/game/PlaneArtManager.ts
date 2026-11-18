/**
 * Lifecycle owner for the custom player artwork so that switching aircraft art
 * mid-flight always releases the previous mesh and its material/texture.
 *
 * The renderer (GameWorld) supplies factories and the fallback player mesh.
 * Everything else — dedupe, disposal order, and fallback visibility — lives
 * here and can be exercised with stub objects in node tests.
 */
export interface PlaneArtHandle {
  /** Source URL the handle was created from. */
  readonly sourceUrl: string;
  /** Mirrors the fallback plane's transform onto the custom art. */
  syncTransform(y: number, rotationZ: number): void;
  /** Releases the mesh, its material, and any GPU texture. */
  dispose(): void;
}

export interface PlaneArtFactory {
  create(url: string): PlaneArtHandle;
}

export class PlaneArtManager {
  private art: PlaneArtHandle | null = null;

  constructor(private readonly factory: PlaneArtFactory) {}

  get current(): PlaneArtHandle | null {
    return this.art;
  }

  /**
   * Shows custom plane art for `url`. Reapplying the same URL is a no-op so a
   * repeated customization event never churns textures. The fallback player
   * mesh is hidden while custom art is on stage.
   */
  show(url: string, fallback: { setVisible(visible: boolean): void }): void {
    if (!url) {
      this.clear(fallback);
      return;
    }
    if (this.art?.sourceUrl === url) {
      fallback.setVisible(false);
      return;
    }
    this.releaseArt();
    this.art = this.factory.create(url);
    fallback.setVisible(false);
  }

  /** Disposes the custom art and brings the fallback player back on stage. */
  clear(fallback: { setVisible(visible: boolean): void }): void {
    this.releaseArt();
    fallback.setVisible(true);
  }

  /** Keeps the custom art glued to the fallback plane's motion. */
  syncTransform(y: number, rotationZ: number): void {
    this.art?.syncTransform(y, rotationZ);
  }

  /** Final teardown when the whole world is disposed. */
  dispose(): void {
    this.releaseArt();
  }

  private releaseArt(): void {
    const active = this.art;
    if (!active) return;
    this.art = null;
    active.dispose();
  }
}

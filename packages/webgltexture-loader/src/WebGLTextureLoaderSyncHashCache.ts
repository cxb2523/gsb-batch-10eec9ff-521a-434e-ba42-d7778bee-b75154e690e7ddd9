import WebGLTextureLoader, { type TextureAndSize } from "./WebGLTextureLoader.js";

export default class WebGLTextureLoaderSyncHashCache<T> extends WebGLTextureLoader<T> {
  inputHash(_input: T): unknown {
    return "";
  }

  getNoCache(_input: T): TextureAndSize {
    throw new Error("getNoCache must be implemented");
  }

  results: Map<unknown, TextureAndSize> = new Map();
  promises: Map<unknown, Promise<TextureAndSize>> = new Map();

  _disposed = false;

  /**
   * Terminal: once disposed, the loader can never load again. `load()` rejects,
   * `get()` returns undefined and no `getNoCache()` call is made. Calling
   * `dispose()` again is a no-op (textures are deleted exactly once).
   */
  override dispose(): void {
    if (this._disposed) return;
    this._disposed = true;
    const { results, promises } = this;
    results.forEach((r) => {
      this.disposeTexture(r.texture);
    });
    results.clear();
    promises.clear();
  }

  disposeTexture(texture: WebGLTexture): void {
    this.gl.deleteTexture(texture);
  }

  override get(input: T): TextureAndSize | undefined {
    if (this._disposed) return undefined;
    const hash = this.inputHash(input);
    const result = this.results.get(hash);
    if (result) return result;
    const freshResult = this.getNoCache(input);
    this.results.set(hash, freshResult);
    return freshResult;
  }

  override load(input: T): Promise<TextureAndSize> {
    if (this._disposed) {
      return Promise.reject(new Error("WebGLTextureLoaderSyncHashCache: loader has been disposed"));
    }
    const hash = this.inputHash(input);
    const existing = this.promises.get(hash);
    if (existing) return existing;
    const promise = Promise.resolve(this.get(input)!);
    this.promises.set(hash, promise);
    return promise;
  }
}

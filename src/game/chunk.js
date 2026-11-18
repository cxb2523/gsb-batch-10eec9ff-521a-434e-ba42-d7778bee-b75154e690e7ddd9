/**
 * A column of blocks LENGTH by WIDTH wide and HEIGHT tall. Blocks are stored
 * as one byte ids, and the mesh only lives on the GPU.
 */
class Chunk {
  /**
   * Create a chunk from generated blocks
   * @param {number} x Chunk x coordinate
   * @param {number} z Chunk z coordinate
   * @param {Uint8Array} blocks Block ids, empty if not given
   * @param {Map<string, Uint32Array>} features Chunk key -> packed blocks this chunk's trees place in that chunk
   */
  constructor(x, z, blocks = new Uint8Array(LENGTH * WIDTH * HEIGHT), features = new Map()) {
    this.x = x;
    this.z = z;
    this.X = this.x * LENGTH; // world x of the chunk's corner
    this.Z = this.z * WIDTH; // world z of the chunk's corner
    this.blocks = blocks;
    this.features = features;
    this.decorated = false;
    this.solidMesh = null; // {buffer, faces} of opaque and cutout blocks, on the GPU
    this.translucentMesh = null; // {buffer, faces} of translucent blocks, drawn after every solid mesh
    this.complete = false;
    this.calculating = false;
    this.meshError = false; // the last mesh failed, so it waits for the blocks to change instead of retrying every frame
    this._meshVersion = 0; // bumped whenever the blocks the mesh is built from change
    this._requestId = 0; // id of the mesh request in flight, or 0 when none is
    this._pendingRequest = 0; // request id the chunk is waiting for, or 0
    this._builtVersion = -1; // version of the blocks the mesh on the GPU was built from
  }

  /**
   * Add the trees that this chunk and its neighbors grow into it, then the
   * player's edits. Every neighbor must be generated first.
   */
  decorate() {
    const key = getChunkKey(this.x, this.z);

    for (let dx = -1; dx <= 1; dx++) {
      for (let dz = -1; dz <= 1; dz++) {
        const features = getLoadedChunk(this.x + dx, this.z + dz).features.get(key);
        if (features) applyFeatureBlocks(this.blocks, features);
      }
    }

    data.edits.applyTo(this);
    this.decorated = true;
  }

  /**
   * Draw the chunk's opaque and cutout blocks
   */
  render() {
    this._drawMesh(this.solidMesh);
    data.renderedChunks++;
  }

  /**
   * Draw the chunk's translucent blocks, after every chunk's solid blocks
   */
  renderTranslucent() {
    this._drawMesh(this.translucentMesh);
  }

  /**
   * Check whether the chunk has translucent blocks to draw
   * @returns {boolean} Whether renderTranslucent draws anything
   */
  hasTranslucent() {
    return this.translucentMesh != null;
  }

  /**
   * Note that blocks the mesh is built from changed, either in this chunk or
   * in the border it copies from its neighbors. This is what makes a mesh
   * request already on its way stale: the blocks its mesh is being built from
   * are no longer the blocks there, so setMesh drops its result.
   */
  markDirty() {
    this._meshVersion++;
    this.meshError = false;
  }

  /**
   * Check whether the chunk needs a mesh built for its current blocks
   * @returns {boolean} Whether the loader should build a mesh for it
   */
  needsMesh() {
    if (this.calculating || this.meshError) return false;

    return !this.complete || this._builtVersion !== this._meshVersion;
  }

  /**
   * Mark the chunk as having a mesh on the way, built from the blocks as they
   * are now. The chunk and its neighbors must be decorated first.
   * @returns {{version: number, request: number}} Version of the blocks the
   *   mesh will be built from, and the id of this request, both for setMesh
   */
  startMesh() {
    this.calculating = true;
    this.meshError = false;
    this._pendingRequest = ++this._requestId;

    return { version: this._meshVersion, request: this._pendingRequest };
  }

  /**
   * Upload built meshes to the GPU, unless the blocks they were built from
   * changed or the chunk was freed while they were built. A dropped result
   * still stops the chunk waiting if it was the newest request, so it can be
   * built again.
   * @param {{version: number, request: number}} started Values from startMesh
   * @param {{solid: Object, translucent: Object}} mesh Meshes from buildChunkMesh
   * @returns {boolean} Whether the meshes were uploaded
   */
  setMesh(started, mesh) {
    if (started.request === this._pendingRequest) {
      this._pendingRequest = 0;
      this.calculating = false;
    }

    if (started.version !== this._meshVersion) return false;

    this.solidMesh = this._uploadMesh(this.solidMesh, mesh.solid);
    this.translucentMesh = this._uploadMesh(this.translucentMesh, mesh.translucent);
    this.complete = true;
    this._builtVersion = started.version;
    return true;
  }

  /**
   * Stop waiting for a mesh that failed, so the chunk is not left marked as
   * meshing. It is built again the next time its blocks change, instead of
   * being retried every frame. Failures of requests that were already
   * replaced are ignored, so they cannot undo newer work.
   * @param {{version: number, request: number}} [started] Values from startMesh for the failed request. Defaults to the newest request.
   */
  meshFailed(started = { request: this._pendingRequest }) {
    if (started.request !== this._pendingRequest) return;

    this._pendingRequest = 0;
    this.calculating = false;
    this.meshError = true;
  }

  /**
   * Rebuild the mesh on the main thread right away, for changes the player
   * should see immediately. Marking the chunk dirty invalidates any request
   * still on its way, so it cannot replace this mesh when it arrives.
   */
  buildMeshNow() {
    this.markDirty();
    this.setMesh(this.startMesh(), buildChunkMesh(createMeshArea(this), this.X, this.Z));
  }

  /**
   * Free the chunk's mesh, keeping its blocks
   */
  freeMesh() {
    this._meshVersion++;
    this._pendingRequest = 0;
    this.solidMesh = this._uploadMesh(this.solidMesh, null);
    this.translucentMesh = this._uploadMesh(this.translucentMesh, null);
    this.complete = false;
    this.calculating = false;
    this.meshError = false;
  }

  /**
   * Free everything the chunk holds on the GPU before it is dropped
   */
  unload() {
    this.freeMesh();
  }

  /**
   * Replace a mesh on the GPU, reusing its buffer, or freeing it when there is nothing to draw
   * @param {{buffer: Buffer, faces: number}|null} current Mesh on the GPU now
   * @param {{vertices: Float32Array, indices: Uint32Array}|null} data New mesh data
   * @returns {{buffer: Buffer, faces: number}|null} Mesh on the GPU
   */
  _uploadMesh(current, data) {
    if (data == null || data.indices.length === 0) {
      current?.buffer.destroy(gl);
      return null;
    }

    const buffer = current?.buffer ?? new Buffer();
    buffer.upload(gl, data.vertices, data.indices);
    return { buffer: buffer, faces: data.indices.length / 6 };
  }

  /**
   * Draw a mesh
   * @param {{buffer: Buffer, faces: number}|null} mesh Mesh on the GPU
   */
  _drawMesh(mesh) {
    if (mesh == null) return;

    mesh.buffer.setUsing(gl);
    setupVertexAttribs();
    gl.drawElements(gl.TRIANGLES, 6 * mesh.faces, gl.UNSIGNED_INT, 0);
  }
}

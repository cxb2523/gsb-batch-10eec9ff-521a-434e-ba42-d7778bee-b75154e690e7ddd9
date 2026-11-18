/**
 * Loads the real chunk, meshing, editing and loading sources into an isolated
 * VM context, so mesh behaviour can be driven without a browser.
 *
 * Only the things a browser provides are replaced:
 * - GPU buffers keep the mesh they were last given, so tests can inspect it
 * - the worker pool is a controllable fake, so a test decides exactly when a
 *   background result comes back
 * - the frame budget is created fresh, with a clock that never runs out
 *
 * Chunks, block ids, the mesher, the edit path, the loader and its version
 * bookkeeping are the real src/ code.
 */

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..', '..');

// Files the chunk loading, meshing and editing code depends on, in page order
const SOURCE_FILES = [
  'src/other/math.js',
  'src/libraries/pseudo-random.js',
  'src/libraries/noise.js',
  'src/graphics-3d/create-cube.js',
  'src/graphics-3d/atlas.js',
  'src/graphics-3d/mesh-builder.js',
  'src/graphics-3d/chunk-mesher.js',
  'src/game/block-registry.js',
  'src/game/terrain.js',
  'src/game/generate.js',
  'src/game/chunk-edits.js',
  'src/graphics-3d/blocks.js',
  'src/game/chunk-tasks.js',
  'src/game/chunk-worker-pool.js',
  'src/game/frame-budget.js',
  'src/game/chunk.js',
  'src/game/chunk-loader.js'
];

/**
 * Create a fresh game context with synthetic chunks and a controllable worker
 * @param {Object} [options] World and harness settings
 * @param {number} [options.length] Chunk size in x
 * @param {number} [options.width] Chunk size in z
 * @param {number} [options.height] World height
 * @param {string} [options.root] Directory holding src/, for other checkouts
 * @returns {Object} Harness with helpers that drive the real code
 */
function createGame({ length = 16, width = 16, height = 32, root = ROOT } = {}) {
  const logs = [];

  const context = vm.createContext({
    console: { log() {}, warn() {}, error: (...args) => logs.push(args.join(' ')) }
  });

  // Globals the sources read before any chunk work happens
  context.LENGTH = length;
  context.WIDTH = width;
  context.HEIGHT = height;
  context.Chunks = {};
  context.gl = { ARRAY_BUFFER: 1, ELEMENT_ARRAY_BUFFER: 2, STATIC_DRAW: 3 };
  context.performance = { now: () => 0 };
  context.player = { x: length / 2, y: 20, z: width / 2 };
  context.seedPhrase = 'test-seed';
  context.data = { renderDistance: 2, mode: 'superflat', edits: null, renderedChunks: 0, chunksGenerated: 0 };
  // postMessage clones its payload, so the fake pool clones tasks too
  context.structuredClone = structuredClone;

  vm.runInContext(`
    class Buffer {
      constructor() { this.vertices = null; this.indices = null; this.destroyed = false; }
      upload(gl, vertices, indices) { this.vertices = vertices; this.indices = indices; }
      destroy() { this.destroyed = true; }
      setUsing() {}
      setAttributes() {}
    }
  `, context, { filename: 'test-support/buffer.js' });

  for (const file of SOURCE_FILES)
    vm.runInContext(fs.readFileSync(path.join(root, file), 'utf8'), context, { filename: file });

  // Helpers live in the context so they can see the sources' top level
  // bindings, not just the properties they put on the global object
  vm.runInContext(`
    __h = {
      workerBuilds: 0, // meshes built for worker tasks
      mainBuilds: 0, // meshes built on the main thread
      submitted: [], // worker tasks waiting for a result
      capacity: true, // whether the fake pool accepts tasks

      /** Start from an empty world with no queued work */
      reset() {
        Chunks = {};
        data.edits = new ChunkEdits();
        data.renderedChunks = 0;
        pendingChunks.clear();
        failedChunks.clear();
        finishedTasks = [];
        loaderEpoch = 0;
        lastUnloadCenter = null;
        this.workerBuilds = 0;
        this.mainBuilds = 0;
        this.submitted = [];
        this.capacity = true;
        chunkWorkers = {
          getWorkerCount: () => 1,
          hasCapacity: () => __h.capacity,
          hasInlineTask: () => false,
          runInline() {},
          submit: (task, onDone) => __h.submitted.push({ task: structuredClone(task), onDone: onDone })
        };
        frameBudget.startFrame(0);
        frameBudget.startFrame(1);
        // Block layers come from the atlas, and meshing waits until they exist
        useAtlasTileLayers(new Uint8Array(TXRW * TXRH));
      },

      /** Add a chunk, filling its blocks from a callback */
      addChunk(cx, cz, fill, decorated = true) {
        const chunk = new Chunk(cx, cz);
        for (let x = 0; x < LENGTH; x++)
          for (let z = 0; z < WIDTH; z++)
            for (let y = 0; y < HEIGHT; y++) {
              const type = fill(x, y, z);
              if (type != null) chunk.blocks[getBlockIndex(x, y, z)] = getBlockTypeId(type);
            }
        chunk.decorated = decorated;
        if (Chunks[cx] == null) Chunks[cx] = {};
        Chunks[cx][cz] = chunk;
        return chunk;
      },

      chunk: (cx, cz) => getLoadedChunk(cx, cz),
      blockType: type => getBlockTypeId(type),
      blockAt: (x, y, z) => getBlockIdAt(x, y, z),
      edit: (x, y, z, type) => editBlock(x, y, z, type, true),
      index: (x, y, z) => getBlockIndex(x, y, z),

      /** Ask for a chunk's mesh, as the loader does when it comes into range */
      requestMesh(cx, cz) { requestMesh(getLoadedChunk(cx, cz)); },

      /** Deliver one queued worker task's result to its callback */
      deliverNext() {
        const job = __h.submitted.shift();
        if (!job) return false;
        const { result } = runChunkTask(job.task);
        job.onDone(null, result);
        return true;
      },

      /** Deliver every queued worker task in the order it was submitted */
      deliverAll() {
        let ran = 0;
        while (__h.deliverNext()) ran++;
        return ran;
      },

      /** Report the oldest queued worker task as failed */
      failNext(message = 'worker died') {
        const job = __h.submitted.shift();
        if (!job) return false;
        job.onDone(message, null);
        return true;
      },

      /** Let the loader take finished results and start more work */
      finish() {
        frameBudget.startFrame(performance.now());
        finishTasks(floor(player.x / LENGTH), floor(player.z / WIDTH), data.renderDistance);
      },

      /** Run one loader frame with workers that answer at once */
      frame() {
        generateRadius();
        __h.deliverAll();
        __h.finish();
      },

      /** Run loader frames until nothing is left to do */
      settle(maxFrames = 60) {
        let idle = 0;
        for (let i = 0; i < maxFrames && idle < 3; i++) {
          const before = __h.workerBuilds + __h.submitted.length;
          __h.frame();
          if (__h.workerBuilds + __h.submitted.length === before) idle++;
          else idle = 0;
        }
      },

      /** The mesh a chunk currently has on the GPU */
      gpuMesh(cx, cz) {
        const chunk = getLoadedChunk(cx, cz);
        if (!chunk || !chunk.solidMesh) return null;
        return {
          solid: { vertices: chunk.solidMesh.buffer.vertices, indices: chunk.solidMesh.buffer.indices },
          translucent: chunk.translucentMesh == null ? null : {
            vertices: chunk.translucentMesh.buffer.vertices,
            indices: chunk.translucentMesh.buffer.indices
          }
        };
      },

      /** The mesh a chunk's blocks should make right now */
      expectedMesh(cx, cz) {
        const chunk = getLoadedChunk(cx, cz);
        // Build without counting, so checking a mesh doesn't look like a rebuild
        return __realBuildChunkMesh(createMeshArea(chunk), chunk.X, chunk.Z);
      },

      /** Whether a chunk's GPU mesh is the one its blocks make */
      meshMatchesBlocks(cx, cz) {
        const gpu = __h.gpuMesh(cx, cz);
        if (!gpu) return false;
        const expected = __h.expectedMesh(cx, cz);
        return __h.sameArray(gpu.solid.vertices, expected.solid.vertices) &&
          __h.sameArray(gpu.solid.indices, expected.solid.indices) &&
          __h.samePart(gpu.translucent, expected.translucent);
      },

      /** Whether two GPU meshes are identical */
      sameMesh(a, b) {
        if (a == null || b == null) return a === b;
        return __h.sameArray(a.solid.vertices, b.solid.vertices) &&
          __h.sameArray(a.solid.indices, b.solid.indices) &&
          __h.samePart(a.translucent, b.translucent);
      },

      samePart: (a, b) => __h.isEmptyPart(a) && __h.isEmptyPart(b)
        ? true
        : a != null && b != null && __h.sameArray(a.vertices, b.vertices) && __h.sameArray(a.indices, b.indices),

      // A mesh with no faces is not uploaded, so it is stored as null
      isEmptyPart: part => part == null || part.indices.length === 0,

      sameArray: (a, b) => a != null && b != null && a.length === b.length &&
        a.every((value, i) => value === b[i]),

      /** Chunk flags and counters the tests care about */
      state(cx, cz) {
        const chunk = getLoadedChunk(cx, cz);
        return {
          complete: chunk.complete,
          calculating: chunk.calculating,
          meshError: chunk.meshError,
          decorated: chunk.decorated,
          needsMesh: chunk.needsMesh(),
          version: chunk._meshVersion,
          pendingRequest: chunk._pendingRequest,
          builtVersion: chunk._builtVersion
        };
      },

      /** Every loaded chunk with its flags, for whole-world checks */
      allChunks() {
        const list = [];
        for (const x in Chunks)
          for (const z in Chunks[x]) {
            const chunk = Chunks[x][z];
            list.push({
              cx: chunk.x,
              cz: chunk.z,
              complete: chunk.complete,
              needsMesh: chunk.needsMesh()
            });
          }
        return list;
      },

      /** Total mesh builds so far, on the main thread and in workers */
      buildCount() { return __h.mainBuilds + __h.workerBuilds; },

      world() { return getWorldSettings(); }
    };

    // Count mesh builds by where they ran, so a rebuild loop is visible
    __realBuildChunkMesh = buildChunkMesh;
    buildChunkMesh = function (area, X, Z) {
      if (__h.buildingForWorker) __h.workerBuilds++;
      else __h.mainBuilds++;
      return __realBuildChunkMesh(area, X, Z);
    };

    // runChunkTask is the worker side of the pool, so mark its builds
    __realRunChunkTask = runChunkTask;
    runChunkTask = function (task) {
      __h.buildingForWorker = task.type === 'mesh';
      try { return __realRunChunkTask(task); }
      finally { __h.buildingForWorker = false; }
    };
  `, context, { filename: 'test-support/harness.js' });

  const h = vm.runInContext('__h', context);
  h.vm = code => vm.runInContext(code, context);
  h.context = context;
  h.logs = logs;
  h.LENGTH = length;
  h.WIDTH = width;
  h.HEIGHT = height;
  h.reset();
  return h;
}

/**
 * Fill a chunk with a flat floor, so meshes are small but real
 * @param {string} [top] Block type for the floor
 * @returns {function(number, number, number): (string|null)} Block callback
 */
function flatFloor(top = 'stone') {
  return (x, y, z) => (y === 0 ? top : null);
}

module.exports = { createGame, flatFloor };

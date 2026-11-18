/**
 * Tests for keeping edited chunks and asynchronously built chunk meshes
 * consistent. They drive the real loader, Chunk, mesher and edit path, and
 * only replace the GPU buffers and the worker pool, so a test decides exactly
 * when an in-flight background result comes back.
 *
 * The race under test: an edit rebuilds the chunks it affects on the main
 * thread at once, while a worker may still be building a mesh for one of them
 * from the blocks as they were before the edit. That older result must be
 * dropped when it arrives, or it would overwrite the newer mesh and leave
 * stale seams, corner shading or block light behind.
 *
 * Run with: node --test test/
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { createGame, flatFloor } = require('./support/chunk-harness.js');

/** Surround the chunk under test with plain chunks so meshing has neighbors */
function addWorld(game, radius = 2) {
  for (let cx = -radius; cx <= radius; cx++)
    for (let cz = -radius; cz <= radius; cz++) game.addChunk(cx, cz, flatFloor());
}

/** Let the loader build and upload meshes for the whole world */
function settleWorld(game) {
  game.settle();
  for (const { cx, cz } of game.allChunks())
    if (!game.state(cx, cz).complete) game.requestMesh(cx, cz);
  game.settle();
}

/** Assert that every chunk with a mesh shows its current blocks */
function assertAllChunksMatch(game, message) {
  for (const { cx, cz, complete } of game.allChunks()) {
    if (!complete) continue;
    assert.ok(game.meshMatchesBlocks(cx, cz), `${message}: chunk ${cx},${cz} mesh is stale`);
  }
}

test('editing a block at a chunk edge updates the neighbor seam at once', () => {
  const game = createGame();
  addWorld(game);
  settleWorld(game);

  const seamBefore = game.gpuMesh(1, 0).solid.vertices.slice();

  // A block right on chunk 0,0's +x side, whose faces shade chunk 1,0's seam
  game.edit(15, 1, 0, 'stone');

  assert.ok(game.meshMatchesBlocks(0, 0), 'the edited chunk rebuilds immediately');
  assert.ok(game.meshMatchesBlocks(1, 0), 'the neighbor across the seam rebuilds immediately');

  const seamAfter = game.gpuMesh(1, 0).solid.vertices;
  let changed = 0;
  for (let i = 0; i < seamAfter.length; i++)
    if (seamAfter[i] !== seamBefore[i]) changed++;
  assert.ok(changed > 0, 'the neighbor seam actually changed, not just re-uploaded');

  // Breaking the block again brings the neighbor back to its original seam
  game.edit(15, 1, 0, null);
  assert.ok(game.meshMatchesBlocks(1, 0), 'the neighbor returns to its original seam');
});

test('editing a block at a chunk corner updates a diagonal neighbor corner shade', () => {
  const game = createGame();
  addWorld(game);
  settleWorld(game);

  const cornerBefore = game.gpuMesh(1, 1).solid.vertices.slice();

  // A block at 0,0's +x,+z corner shades the corner of chunk 1,1
  game.edit(15, 1, 15, 'stone');

  assert.ok(game.meshMatchesBlocks(0, 0));
  assert.ok(game.meshMatchesBlocks(1, 1), 'the diagonal neighbor rebuilds at once');

  game.edit(15, 1, 15, null);
  assert.ok(game.meshMatchesBlocks(1, 1));
  assert.ok(
    game.gpuMesh(1, 1).solid.vertices.every((value, i) => value === cornerBefore[i]),
    'the diagonal neighbor mesh returns to exactly its original state'
  );
});

test('block light from an edit reaches the neighbor chunk mesh', () => {
  const game = createGame();
  addWorld(game);
  settleWorld(game);

  const before = game.gpuMesh(1, 0).solid.vertices.slice();
  game.edit(15, 1, 0, 'red_glow_block');

  const after = game.gpuMesh(1, 0).solid.vertices;
  assert.ok(game.meshMatchesBlocks(1, 0), 'the lit neighbor rebuilds at once');
  assert.ok(
    after.some((value, i) => value !== before[i]),
    'the glowing block changes the neighbor mesh shading, so its light is not left behind'
  );
});

test('a mesh result from before an edit is dropped, not uploaded', () => {
  const game = createGame();
  addWorld(game);
  settleWorld(game);

  const beforeEdit = game.gpuMesh(0, 0).solid.indices.length;

  // Start a worker mesh whose blocks are the ones before the edit
  game.requestMesh(0, 0);
  assert.equal(game.submitted.length, 1, 'one mesh is on its way');

  game.edit(5, 1, 5, 'stone');
  const afterEdit = game.gpuMesh(0, 0).solid.vertices.slice();
  assert.ok(game.gpuMesh(0, 0).solid.indices.length > beforeEdit,
    'the edit added the new block face at once');

  // The older result comes back now and must be ignored
  game.deliverAll();
  game.finish();

  assert.ok(
    game.gpuMesh(0, 0).solid.vertices.every((value, i) => value === afterEdit[i]),
    'the stale result did not replace the mesh the edit built'
  );
  assert.ok(game.meshMatchesBlocks(0, 0), 'the chunk still shows its edited blocks');
});

test('the last of several edits made while a mesh is in flight wins', () => {
  const game = createGame();
  addWorld(game);
  settleWorld(game);

  game.requestMesh(0, 0);
  game.edit(5, 1, 5, 'stone');
  game.edit(5, 1, 5, null);
  game.edit(5, 1, 5, 'log');

  game.deliverAll();
  game.finish();

  assert.ok(game.meshMatchesBlocks(0, 0), 'the mesh is the one the last edit should make');
  assert.equal(game.blockAt(5, 1, 5), game.blockType('log'));

  // Later frames must not bring the stale mesh back either
  game.settle();
  assert.ok(game.meshMatchesBlocks(0, 0), 'later frames keep the last edit');
});

test('results arriving out of order never replace a newer mesh', () => {
  const game = createGame();
  addWorld(game);
  settleWorld(game);

  // Two meshes on their way, then an edit that affects both chunks
  game.requestMesh(0, 0);
  game.requestMesh(1, 0);
  game.edit(15, 1, 0, 'stone');

  // Deliver the older request for the edited chunk first, then the other
  game.deliverAll();
  game.finish();

  assert.ok(game.meshMatchesBlocks(0, 0), 'chunk 0,0 shows its newest blocks');
  assert.ok(game.meshMatchesBlocks(1, 0), 'chunk 1,0 shows its newest blocks');

  game.settle();
  assertAllChunksMatch(game, 'later frames keep both chunks correct');
});

test('one edit rebuilds each affected chunk once and then stops', () => {
  const game = createGame();
  addWorld(game);
  settleWorld(game);

  const idleBuilds = game.buildCount();
  for (let i = 0; i < 20; i++) game.frame();
  assert.equal(game.buildCount(), idleBuilds, 'idle frames do not rebuild meshes');

  // A block in the middle of a chunk only touches that chunk
  game.edit(8, 1, 8, 'stone');
  assert.equal(game.mainBuilds, 1, 'only the edited chunk is rebuilt at once');

  const afterEdit = game.buildCount();
  for (let i = 0; i < 20; i++) game.frame();
  assert.equal(game.buildCount(), afterEdit, 'the edit does not trigger an endless rebuild loop');

  // Repeating the same edit changes nothing, so nothing is rebuilt
  game.edit(8, 1, 8, 'stone');
  assert.equal(game.mainBuilds, 1, 'a no-op edit rebuilds nothing');
});

test('a block on a chunk corner rebuilds exactly the four chunks it touches', () => {
  const game = createGame();
  addWorld(game);
  settleWorld(game);

  game.edit(15, 1, 15, 'stone');
  assert.equal(game.mainBuilds, 4, 'the edited chunk and its 3 neighbors rebuild once each');

  game.settle();
  assertAllChunksMatch(game, 'every affected chunk is rebuilt from the latest blocks');
  assert.equal(game.mainBuilds, 4, 'no further main thread rebuilds happen');
});

test('an invalidated request is dropped and the loader rebuilds the chunk', () => {
  const game = createGame();
  addWorld(game);
  settleWorld(game);

  // A request whose result is no longer wanted, with no synchronous rebuild
  game.requestMesh(0, 0);
  game.chunk(0, 0).markDirty();

  game.deliverAll();
  game.finish();
  assert.equal(game.state(0, 0).complete, true, 'the dropped result did not take the old mesh away');

  game.settle();
  assert.ok(game.meshMatchesBlocks(0, 0), 'the loader rebuilds the chunk from its blocks');
  assert.equal(game.state(0, 0).calculating, false, 'the chunk is not left marked as meshing');
  assert.equal(game.state(0, 0).needsMesh, false, 'the chunk is not left needing another mesh');
});

test('a failed mesh stops waiting and is rebuilt after the next edit', () => {
  const game = createGame();
  addWorld(game);
  settleWorld(game);

  // A worker mesh fails, as it would when a worker dies
  game.requestMesh(0, 0);
  game.failNext('worker died');
  game.finish();

  assert.equal(game.state(0, 0).calculating, false, 'the chunk stops waiting after a failure');

  // Idle frames must not spin on the failed chunk
  const builds = game.buildCount();
  for (let i = 0; i < 10; i++) game.frame();
  assert.equal(game.buildCount(), builds, 'a failed chunk is not retried every frame');

  // An edit clears the failure and the chunk becomes correct again
  game.edit(5, 1, 5, 'stone');
  assert.ok(game.meshMatchesBlocks(0, 0), 'the edit gives the chunk a correct mesh again');
});

test('a failure of a replaced request does not disturb the newer one', () => {
  const game = createGame();
  addWorld(game);
  settleWorld(game);

  // Two requests for the same chunk, as when an edit invalidated the first
  game.requestMesh(0, 0);
  game.requestMesh(0, 0);
  const [oldJob, newJob] = game.submitted.splice(0, 2);

  // The replaced request fails after that: the chunk must keep waiting for
  // the newer one rather than treat the chunk as failed
  oldJob.onDone('worker died', null);
  game.finish();
  assert.equal(game.state(0, 0).calculating, true, 'the chunk is still waiting for the newer request');
  assert.equal(game.state(0, 0).meshError, false, 'a replaced request does not mark the chunk failed');

  // The newer request then arrives and is shown
  newJob.onDone(null, game.vm('runChunkTask')(newJob.task).result);
  game.finish();
  assert.equal(game.state(0, 0).calculating, false);
  assert.ok(game.meshMatchesBlocks(0, 0), 'the newer request gives the chunk its mesh');
  assert.equal(game.state(0, 0).needsMesh, false, 'the chunk has nothing left to build');
});

test('an edit at a seam rebuilds a neighbor whose mesh failed', () => {
  const game = createGame();
  addWorld(game);

  // Chunk 1,0 has no mesh, because its first mesh failed and it is waiting
  // for the blocks to change before trying again
  game.requestMesh(1, 0);
  game.failNext('worker died');
  game.finish();
  assert.equal(game.state(1, 0).meshError, true, 'the failed neighbor is waiting for a change');
  assert.equal(game.state(1, 0).complete, false);

  // The edit reaches chunks that are not drawn yet too, so the neighbor is
  // built from the blocks as they are now instead of staying empty
  game.edit(15, 1, 0, 'stone');

  game.settle();
  assert.ok(game.meshMatchesBlocks(1, 0), 'the neighbor is rebuilt after its failed mesh');
  assert.ok(game.meshMatchesBlocks(0, 0), 'the edited chunk is correct too');
});

test('an edit next to a chunk that has not been meshed yet shows up when it loads', () => {
  const game = createGame();
  addWorld(game);

  // Chunk 1,0 is loaded but has no mesh yet, as when the loader has not
  // reached it: only chunk 0,0 is meshed
  assert.equal(game.state(1, 0).complete, false);
  game.requestMesh(0, 0);
  game.deliverAll();
  game.finish();
  assert.ok(game.meshMatchesBlocks(0, 0));

  game.edit(15, 1, 0, 'stone');
  assert.ok(game.meshMatchesBlocks(0, 0), 'the edited chunk rebuilds at once');

  // Loading then builds the neighbor from the blocks as they now are
  game.settle();
  assert.ok(game.meshMatchesBlocks(1, 0), 'the neighbor loads with the latest blocks');
  assert.ok(game.meshMatchesBlocks(0, 0), 'the edited chunk stays correct');
});

test('random edits, deliveries and failures converge on the latest blocks', () => {
  // A fixed seed keeps the sequence reproducible while mixing every ordering
  let seed = 20241118;
  const random = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  const pick = list => list[Math.floor(random() * list.length)];
  const radius = 2;
  const inRange = [];
  for (let cx = -radius; cx <= radius; cx++)
    for (let cz = -radius; cz <= radius; cz++) inRange.push([cx, cz]);

  for (let trial = 0; trial < 12; trial++) {
    const game = createGame();
    for (const [cx, cz] of inRange) game.addChunk(cx, cz, flatFloor());

    for (let step = 0; step < 60; step++) {
      const roll = random();

      if (roll < 0.2) game.vm('generateRadius()');
      else if (roll < 0.4) game.deliverAll();
      else if (roll < 0.5) game.finish();
      else if (roll < 0.58) game.failNext();
      else {
        const [cx, cz] = pick(inRange);
        if (!game.state(cx, cz).complete) continue;

        const x = cx * game.LENGTH + Math.floor(random() * game.LENGTH);
        const z = cz * game.WIDTH + Math.floor(random() * game.WIDTH);
        const y = 1 + Math.floor(random() * 4);
        game.edit(x, y, z, random() < 0.5 ? null : pick(['stone', 'log', 'red_glow_block']));
      }
    }

    // Once things settle, every drawn chunk matches its blocks and no chunk
    // is left waiting for a mesh that will never arrive
    for (let i = 0; i < 60; i++) game.frame();
    assertAllChunksMatch(game, `trial ${trial} after settling`);
    for (const [cx, cz] of inRange) {
      assert.equal(game.state(cx, cz).calculating, false, `chunk ${cx},${cz} is not left meshing`);
    }

    // And the settled world stops rebuilding until something changes
    const builds = game.buildCount();
    for (let i = 0; i < 20; i++) game.frame();
    assert.equal(game.buildCount(), builds, `trial ${trial} does not rebuild endlessly`);
  }
});

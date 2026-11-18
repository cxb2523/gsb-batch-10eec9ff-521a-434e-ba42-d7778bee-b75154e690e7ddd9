# Running the tests

The chunk tests drive the real sources from Node, in an isolated VM context, so
they need no browser and no dependencies. Node 18 or newer is enough (they use
the built-in `node:test` runner).

From the repository root:

```sh
node --test "test/*.test.js"
```

`test/support/chunk-harness.js` loads the real chunk, meshing, editing and
loader sources in page order, and replaces only what a browser provides: GPU
buffers keep the mesh they were last given, and the worker pool is a fake whose
results the test delivers or fails on demand. That makes the race between an
edit's synchronous rebuild and an in-flight worker mesh deterministic to
exercise.

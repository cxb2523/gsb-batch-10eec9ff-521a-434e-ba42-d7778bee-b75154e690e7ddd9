# Shared-model dispose probes

Browser probes for the city-teardown resource-ownership fix. They run the real
`buildWorld()` / `createPlane()` / `Explosion` / `main.ts` code in a WebGL
context, instrument `THREE.*.dispose`, and report whether resources from the
page-wide model cache survive the preview → run → menu → retry lifecycle while
scene-owned resources are still released.

## Run

```sh
npm run dev:web          # vite on :5173
node tests/run-probes.mjs
```

`run-probes.mjs` looks for Chrome/Edge (override with `CHROME_PATH`) and loads:

- `tests/dispose-probe.html` — programmatic lifecycle: two previews, a run, a
  menu state, five rebuild cycles, golden-plane path, scene-owned release,
  renderer memory stability over 12 rebuilds.
- `tests/app-flow-probe.html` — the real app from `main.ts`, with fetch stubbed
  to deterministic contribution data (zero-commit rest days + high-commit
  spikes): start preview for user A → take off as user B → crash/win → menu →
  retry the same user.

Both pages print `PASS`/`FAIL` lines and end with `ALL CHECKS PASSED` when
everything holds. `window.__probeResult` carries the same data for tooling.

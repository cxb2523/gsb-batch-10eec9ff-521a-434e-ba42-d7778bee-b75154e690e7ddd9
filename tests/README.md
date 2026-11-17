# Keyframe camera fallback verification

These samples verify one shared rule for choosing the camera used by a
"key camera" view. The player (`seekTimePlayer`) and the editor viewport
(`update` -> `renderCameraViewport`) both call `getKeyframeCamera`, which picks:

1. the camera of the keyframe exactly at the requested time;
2. otherwise the camera of the nearest **earlier** keyframe that has a camera;
3. otherwise the default camera (`cameraId 0`).

No camera is ever dereferenced when it is null: rendering goes through
`renderWithCamera` / `renderCameraViewport`, which return `false` instead.

## 1. Node test suite (no browser required)

```sh
node tests/camera-fallback.test.js
```

Loads `player.js` in a `vm` sandbox with a stubbed `WebGLRenderer`, then checks:

- exact keyframe hit, forward-only camera keyframe, and no-camera-keyframe scenes;
- player and editor viewport resolve the *same* camera object;
- deleting a camera node repoints keyframes at the default camera;
- removing a keyframe re-seeks from the playhead;
- the keyframe info panel tolerates data for a missing node;
- position/rotation/scale interpolation and FOV/aspect behavior are unchanged;
- real `demos/lightcycles.json` data.

## 2. Visual sample (browser)

Open `tests/camera-fallback-demo.html` directly in a browser (`file://` works).
It renders three side-by-side cases and prints PASS/FAIL under each:

| case | time | expected camera |
| --- | --- | --- |
| exact keyframe hit | 200 | camera B |
| only a forward keyframe has a camera | 50 | default camera |
| no keyframe has a camera | 120 | default camera |

## 3. Editor smoke test (browser)

Open `tests/editor-smoke-test.html` in a browser. It boots the real editor,
creates a camera node and a keyframe using it, deletes the node through
`deleteNode()`, and asserts that:

- the keyframe's camera is repointed to the default camera;
- the viewport still renders and the key camera label/dropdown fall back;
- the keyframe info panel survives a missing node;
- the player resolves the same fallback camera.

A results panel in the top-right corner lists each check.

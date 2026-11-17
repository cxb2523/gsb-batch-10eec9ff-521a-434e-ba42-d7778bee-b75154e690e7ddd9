# Subtitle translation-track lifecycle tests

These tests cover the async race conditions between translation tracks when
`setTextTracks` is called again (for example when the video source is
switched), using self-made local `transcript`/`VTT` fixtures.

## How to run

From `packages/video-player` (Node.js 20+, no extra packages needed - the
runner uses the built-in `node:test` runner and `esbuild`, which is already a
dev dependency through `tsup`):

```bash
node javascript/modules/subtitles/__tests__/run-tests.mjs
# or
yarn test:subtitles
```

The runner bundles the TypeScript sources with esbuild into a temp directory
and executes the bundle with `node --test`. The sample fixtures are passed in
through `IK_SUBTITLE_SAMPLES_DIR` so they are read from this folder regardless
of where the bundle lives.

## Why a mock player

The real `video.js` `TextTrack` / `HTMLTrackElement` classes need a full DOM
and cannot be constructed in plain Node. `mock-player.ts` reproduces the exact
video.js semantics the subtitles module relies on:

- `TextTrack.mode` is a live getter/setter defaulting to `disabled`
- `TextTrack.default` is stored per track and is immutable
- `addCue` appends to an inspectable `cues` array
- `HTMLTrackElement.track` returns the paired `TextTrack`
- `addRemoteTextTrack` / `removeRemoteTextTrack` keep the remote track list and
  track-element list in sync
- `textTracks()` mirrors `remoteTextTracks()`, like the real player

`globalThis.fetch` is replaced per test with a controllable router that can
serve file bodies, return HTTP errors, or **defer** a response until
`flushPending()` is called - this is what makes the "late response from an old
source" scenario deterministic. `globalThis.VTTCue` is replaced with a plain
mock because Node does not provide one.

## Samples (self-made fixtures)

| File | Purpose |
| --- | --- |
| `samples/source-a.transcript` | Word-timed transcript for video source **alpha** (base auto-generated track) |
| `samples/source-b.transcript` | Word-timed transcript for video source **bravo** (the switched-to source) |
| `samples/source-a-fr.vtt` / `source-a-de.vtt` | French/German translations of source alpha |
| `samples/source-b-fr.vtt` / `source-b-de.vtt` | French/German translations of source bravo |

Translation URLs still follow the production rule: the nth entry of
`translations` maps to the nth URL returned by `prepareSubtitleSrc`
(`...ik-gensubtitle.vtt?tr=lang-<code>`); the mock fetch router matches on
those URL patterns. A `signerFn` is wired in where noted, so the existing
signing code path is exercised unchanged.

## The three required scenarios and what to observe

### 1. Old translation track resolves late after a source switch

Test: *"stale translation track of the previous source cannot mutate the
player after a source switch"*

1. Source alpha is configured with French (default) + German translations; the
   French VTT route is **deferred**.
2. Before it returns, `setTextTracks` runs again for source bravo.
3. Observe: the alpha tracks are removed; bravo creates a fresh base + two
   translation tracks and its default French track is `showing` with bravo
   cues; exactly one track is `showing`.
4. The deferred alpha French response is then flushed.
5. Observe: the stale track still has **zero cues**, keeps its original
   `disabled` mode and label, is never re-added to the player, and the bravo
   default track remains the single `showing` track.

### 2. A single translation track fails to fetch

Tests: *"a failed translation track is marked failed and stays disabled..."*
and *"a failed DEFAULT translation track never forces itself showing..."*

- The French VTT route returns HTTP 500 while German and the transcript
  succeed.
- Observe: the French track gets **no cues**, its label (on both the
  `HTMLTrackElement` and the `TextTrack`, which is what the captions menu
  renders) ends with `(failed to load)`, and it stays `disabled`.
- The base auto-generated track keeps its default `showing` selection, the
  German sibling still loads its own cues, and there is never more than one
  `showing` track. The second test additionally proves that even a track
  configured with `default: true` cannot become `showing` when its fetch
  fails.

### 3. Default translation track displays normally

Test: *"a successfully loaded default translation track is shown and remains
the sole showing track"*

- Both VTT routes succeed; French is the default.
- Observe: the French track is `showing` and contains the French cues, German
  is `disabled` with the German cues (URL-to-track order preserved), the base
  track is not `showing`, and exactly one subtitle/caption track is `showing`.

## Regression guards

Two extra tests pin behavior that must not change: the existing validation
that rejects two default translations, and that ordinary `src`-based VTT
tracks are still created with their signed URL and are removed on the next
`setTextTracks` call.

## Verifying the fix matters

Running the suite against the pre-fix `subtitles.ts` (e.g.
`git stash push -- javascript/modules/subtitles/subtitles.ts`) makes the
source-switch, failure-marking and cleanup tests fail; with the fix restored
all six tests pass.

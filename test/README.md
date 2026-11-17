# Scritch player tests

Browser-based test harness for the player in `../index.html`. No external dependencies —
uses only PowerShell (media generation + local static server) and a locally installed
Chrome or Edge for the headless run.

## Run

```
powershell -NoProfile -ExecutionPolicy Bypass -File test/run-tests.ps1
```

The script:

1. `gen-media.ps1` — generates small PCM WAV files into `test/media/`.
2. `serve.ps1` — serves the repo root at `http://127.0.0.1:8321/` and accepts
   `POST /__results` (the harness posts its output there, saved to `test/results.txt`).
3. Opens `test/run.html` in headless Chrome/Edge, waits for the results, prints them.

`run.html` loads the player in iframes via `index.html?config=test/config-*.json`
(the `?config=` query param overrides the default `config.json` fetch; the config
file format itself is unchanged) and drives the real player internals:

- `config-loop.json` — preview track (`previewStart`/`previewEnd`/`originalDuration`)
  with `loopCount: 2`: each replay must restart playback and reset the scrubber fill,
  scrubber handle, and time text to the preview start; after loops are exhausted the
  next track loads with a clean scrubber.
- `config-drag.json` — pointer-drag the scrubber, release (playback position must
  sync to the drag result), then switch tracks: drag state and progress display must
  be cleared and redrawn for the new track's preview region; the old position must
  not leak into the new track. Also covers switching mid-drag.
- `config-locked.json` — all tracks locked: nothing gets selected, next/prev are no-ops.
- `config-mixed.json` — locked + broken tracks are skipped by next/prev.
- `config-allerror.json` — all tracks fail to load: next/prev don't throw and don't
  select another broken track.

Generated files (`test/media/`, `test/results.txt`, browser profile dirs) are git-ignored.

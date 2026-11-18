---
title: usePlayer
description: usePlayer composable API — state, controls, loadSource and thumbnail data reference.
---

# usePlayer

Low-level composable that powers `VideoPlayer` internally. Use it when you need direct access to player state and controls — for example, to build a fully custom UI.

## Import

```ts
import { usePlayer } from '@vue-player/vue'
```

## Signature

```ts
function usePlayer(
  videoRef: Ref<HTMLVideoElement | null>,
  options?: UsePlayerOptions,
): {
  state: DeepReadonly<PlayerState>
  controls: PlayerControls
  loadSource: (src: string) => Promise<void>
  thumbnails: Readonly<Ref<readonly ThumbnailCue[]>>
  thumbnailsLoading: Readonly<Ref<boolean>>
  reloadThumbnails: () => Promise<void>
}
```

## Parameters

| Parameter | Type | Description |
|---|---|---|
| `videoRef` | `Ref<HTMLVideoElement \| null>` | A template ref bound to a `<video>` element |
| `options.thumbnails` | `MaybeRefOrGetter<string \| null \| undefined>` | WebVTT thumbnail manifest for the current source. May be a plain string, a ref or a getter so it can follow the active source |

## Returns

### `state`

Readonly reactive `PlayerState` object. See [PlayerState](/api/types#playerstate).

### `controls`

Object with methods to control playback. See [PlayerControls](/api/types#playercontrols).

### `loadSource`

Loads a new video source into the player. Automatically detects the source type (`mp4`, `hls`) and sets up the appropriate adapter:

```ts
loadSource('https://example.com/video.mp4')
loadSource('https://example.com/stream.m3u8')  // triggers hls.js
```

Calling `loadSource` on an already-playing video will stop playback, destroy adapters, and start fresh. The thumbnail list is cleared at the same time and refetched for the new source.

### `thumbnails`

Read-only cue list for the currently loaded source. It is empty while a manifest request is in flight, after a failed request, and when no manifest is configured. See [Thumbnail Previews](/guide/thumbnails#source-lifecycle).

### `thumbnailsLoading`

`true` while a thumbnail manifest request is in flight.

### `reloadThumbnails`

Re-fetches the manifest for the current source, e.g. after a transient network error. Never rejects — a failure leaves the cue list empty.

## Basic Usage

```vue
<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { usePlayer } from '@vue-player/vue'

const videoRef = ref<HTMLVideoElement | null>(null)
const { state, controls, loadSource } = usePlayer(videoRef)

onMounted(() => {
  loadSource('https://example.com/video.mp4')
})
</script>

<template>
  <video ref="videoRef" />

  <div>
    <button @click="controls.play()">Play</button>
    <button @click="controls.pause()">Pause</button>
    <button @click="controls.seek(0)">Restart</button>
  </div>

  <p>{{ state.currentTime.toFixed(1) }} / {{ state.duration.toFixed(1) }}</p>
</template>
```

## Notes

- `usePlayer` attaches native `<video>` event listeners inside `onMounted` and cleans them up in `onUnmounted` — it must be called inside a component `setup`.
- `VideoPlayer` uses `usePlayer` internally. You only need this composable when building a custom player shell.
- The `state` object is `readonly` — never mutate it directly. Use `controls` methods instead.
- Thumbnail loading never blocks playback: a failed manifest leaves `thumbnails` empty while `loadSource` and the timeline keep working.

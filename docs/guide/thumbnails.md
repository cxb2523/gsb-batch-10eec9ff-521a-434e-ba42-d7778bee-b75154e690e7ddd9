---
title: Thumbnail Previews
description: Show timeline thumbnail previews from a WebVTT sprite sheet. Compatible with standard ffmpeg workflows.
---

# Thumbnail Previews

Hovering the timeline shows a thumbnail preview from the video. vue-player reads a [WebVTT](https://developer.mozilla.org/en-US/docs/Web/API/WebVTT_API) file that maps time ranges to image frames — either individual images or a sprite sheet.

## Basic Usage

Pass the URL of a WebVTT file to the `thumbnails` prop:

```vue
<template>
  <VideoPlayer
    src="https://example.com/video.mp4"
    thumbnails="https://example.com/thumbnails.vtt"
  />
</template>
```

## VTT File Format

### Individual Images

Each cue points to a separate image file:

```
WEBVTT

00:00:00.000 --> 00:00:05.000
/thumbnails/frame_000.jpg

00:00:05.000 --> 00:00:10.000
/thumbnails/frame_005.jpg

00:00:10.000 --> 00:00:15.000
/thumbnails/frame_010.jpg
```

### Sprite Sheet (recommended)

All frames packed into a single image, referenced with `#xywh=x,y,w,h` fragments. This is the most efficient approach — one HTTP request for all thumbnails:

```
WEBVTT

00:00:00.000 --> 00:00:05.000
/thumbnails/sprite.jpg#xywh=0,0,160,90

00:00:05.000 --> 00:00:10.000
/thumbnails/sprite.jpg#xywh=160,0,160,90

00:00:10.000 --> 00:00:15.000
/thumbnails/sprite.jpg#xywh=320,0,160,90
```

## Generating Thumbnails with ffmpeg

### Individual frames (one image per 5 seconds)

```sh
ffmpeg -i video.mp4 \
  -vf "fps=1/5,scale=160:90" \
  -q:v 5 \
  thumbnails/frame_%03d.jpg
```

Then generate the VTT manually or with a script.

### Sprite sheet

```sh
mkdir -p thumbnails
ffmpeg -i video.mp4 \
  -vf "fps=1/5,scale=160:90,tile=10x10" \
  -frames:v 1 \
  -update 1 \
  -q:v 5 \
  thumbnails/sprite.jpg
```

The `tile=10x10` filter packs up to 100 frames into a single image in a 10-column grid.

## Relative URLs

Relative paths in the VTT file are resolved relative to the VTT file's own URL, so you can keep the VTT and images in the same directory:

```
WEBVTT

00:00:00.000 --> 00:00:05.000
frame_000.jpg#xywh=0,0,160,90
```

## Source Lifecycle

Thumbnail loading is tied to the video source. When `src` changes, the player:

1. Clears the current cue list immediately, so no frame from the previous video can be shown while the new one loads.
2. Aborts any in-flight manifest request.
3. Fetches the manifest for the new source.

A late response for an old source is discarded. If the manifest request fails (network error, 404, malformed file), the cue list simply stays empty — playback and timeline dragging keep working, and the tooltip still shows the time and chapter name.

Hovering outside the manifest's time range behaves the same way: no preview image, but the timestamp and chapter label remain.

### Per-source manifests

The `thumbnails` prop can change independently of `src` (for example, when each entry in a source list carries its own manifest):

```vue
<script setup lang="ts">
import { ref } from 'vue'

const sources = [
  { src: '/video-a.mp4', thumbnails: '/thumbs-a.vtt' },
  { src: '/video-b.mp4', thumbnails: '/thumbs-b.vtt' },
]
const active = ref(sources[0])
</script>

<template>
  <VideoPlayer :src="active.src" :thumbnails="active.thumbnails" />
  <button v-for="s in sources" :key="s.src" @click="active = s">
    {{ s.src }}
  </button>
</template>
```

Changing both at once still results in a single manifest request for the new source.

## ThumbnailCue Type

If you need to parse the VTT manually or generate cues programmatically, use the `parseThumbnailVtt` utility from `@vue-player/core`:

```ts
import { parseThumbnailVtt } from '@vue-player/core'

const cues = await parseThumbnailVtt('https://example.com/thumbnails.vtt')
```

`parseThumbnailVtt` never throws — a failed request resolves to `[]`. Each returned cue has the following shape:

```ts
interface ThumbnailCue {
  start: number // cue start time in seconds
  end: number // cue end time in seconds
  url: string // absolute image URL
  x?: number // sprite x offset (px)
  y?: number // sprite y offset (px)
  w?: number // sprite frame width (px)
  h?: number // sprite frame height (px)
}
```

Cues are returned sorted by `start` time, and malformed cues (invalid timestamps, a missing image line, reversed ranges) are skipped.

## usePlayer Integration

When building a custom UI with `usePlayer`, pass the manifest URL as an option. The composable loads it whenever `loadSource` is called, and exposes the result as a read-only ref:

```ts
import { usePlayer } from '@vue-player/vue'

const { state, controls, loadSource, thumbnails } = usePlayer(videoRef, {
  thumbnails: () => activeSource.value.thumbnails,
})
```

| Return | Type | Description |
|---|---|---|
| `thumbnails` | `Readonly<Ref<readonly ThumbnailCue[]>>` | Cues for the current source |
| `thumbnailsLoading` | `Readonly<Ref<boolean>>` | A manifest request is in flight |
| `reloadThumbnails()` | `() => Promise<void>` | Re-fetch the manifest for the current source |

Pair them with `resolveTimelinePreview` to build a custom tooltip that always keeps the preview frame and chapter in sync:

```ts
import { resolveTimelinePreview } from '@vue-player/core'

// `time` is a position in the video's own timeline (seconds).
const { time, chapter, cue } = resolveTimelinePreview(chapters, thumbnails.value, seekTime)
```


export type {
  PlayerState,
  PlayerError,
  PlayerOptions,
  VideoSource,
  Quality,
  Track,
  Chapter,
  ThumbnailCue,
} from './types'

export { detectSourceType } from './utils/source'
export type { SourceType } from './utils/source'

export { formatTime, parseTimecode } from './utils/time'
export { parseThumbnailVtt, parseVttText } from './utils/parseThumbnailVtt'
export type { ParseThumbnailOptions } from './utils/parseThumbnailVtt'
export { createThumbnailLoader } from './utils/thumbnailLoader'
export type {
  ThumbnailLoader,
  ThumbnailLoaderOptions,
  ThumbnailLoaderState,
} from './utils/thumbnailLoader'
export { findChapterAt, findThumbnailCue, resolveTimelinePreview } from './utils/timeline'
export type { TimelinePreview } from './utils/timeline'

export {
  isFullscreenSupported,
  isPiPSupported,
  enterFullscreen,
  exitFullscreen,
  getFullscreenElement,
} from './utils/fullscreen'

export { createNativeAdapter } from './adapters/native'
export type { NativeAdapter } from './adapters/native'

export { createHlsAdapter } from './adapters/hls'
export { createDashAdapter } from './adapters/dash'

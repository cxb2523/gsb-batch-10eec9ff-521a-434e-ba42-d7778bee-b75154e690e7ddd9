import { useEffect, useRef, useState } from 'react';
import {
  parseThumbnailsVtt,
  PreviewThumbnail,
} from '../utils/parseThumbnailsVtt';

const warn = (source: string, error: unknown): void => {
  console.warn(
    `react-video-seek-slider: failed to load preview thumbnails from ${source}`,
    error
  );
};

/**
 * Returns the thumbnails as is, or loads and parses them when given a VTT URL.
 *
 * While a URL is loading — and when it fails (network error, non-2xx response
 * or a VTT file without cues) — the result stays `undefined`, so callers can
 * fall back to `getPreviewScreenUrl` and never render frames from a previously
 * used source. Successful loads are cached per URL for the lifetime of the
 * component: switching back to an already loaded URL is instant and does not
 * refetch, and a late response for a URL that is no longer active is ignored.
 */
export function usePreviewThumbnails(
  source: string | PreviewThumbnail[] | undefined
): PreviewThumbnail[] | undefined {
  const cache = useRef(new Map<string, PreviewThumbnail[]>());
  // The cache lives in a ref so that reading it never causes an extra fetch,
  // while this counter makes a finished load re-render the component.
  const [, setRevision] = useState(0);

  useEffect(() => {
    if (typeof source !== 'string' || cache.current.has(source)) {
      return;
    }

    let vttUrl: string;

    try {
      vttUrl = new URL(source, document.baseURI).href;
    } catch (error) {
      warn(source, error);
      return;
    }

    const controller = new AbortController();

    fetch(vttUrl, { signal: controller.signal })
      .then((response) => {
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }

        return response.text();
      })
      .then((text) => {
        // The source changed or the component unmounted while the response was
        // in flight: a late response must not replace the active source.
        if (controller.signal.aborted) {
          return;
        }

        const thumbnails = parseThumbnailsVtt(text, vttUrl);

        if (thumbnails.length === 0) {
          throw new Error('the VTT file contains no thumbnail cues');
        }

        if (!cache.current.has(source)) {
          cache.current.set(source, thumbnails);
        }

        setRevision((revision) => revision + 1);
      })
      .catch((error: unknown) => {
        if (
          controller.signal.aborted ||
          (error instanceof Error && error.name === 'AbortError')
        ) {
          return;
        }

        warn(source, error);
      });

    return () => controller.abort();
  }, [source]);

  if (typeof source !== 'string') {
    return source;
  }

  // Read the cache during render: a URL that already loaded is reused on the
  // very same render, before any effect runs.
  return cache.current.get(source);
}

import {
  type KawarpContextOptions,
  Kawarp as KawarpCore,
  type KawarpOptions,
  type KawarpVideoOptions,
} from "@kawarp/core";
import {
  type CSSProperties,
  forwardRef,
  type RefObject,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
} from "react";

export type {
  KawarpContextOptions,
  KawarpOptions,
  KawarpVideoOptions,
} from "@kawarp/core";

export interface KawarpRef {
  /** The underlying Kawarp instance */
  instance: KawarpCore | null;
  /** Load an image from a URL */
  loadImage: (src: string) => Promise<void>;
  /** Load from a Blob or File */
  loadBlob: (blob: Blob) => Promise<void>;
  /** Load colors as a gradient source */
  loadGradient: (colors: string[], angle?: number) => void;
  /** Start the animation */
  start: () => void;
  /** Stop the animation */
  stop: () => void;
}

export interface KawarpProps extends KawarpOptions, KawarpContextOptions {
  /** Additional class name for the canvas */
  className?: string;
  /** Additional styles for the canvas */
  style?: CSSProperties;
  /** Image URL to load (auto-loads when changed) */
  src?: string;
  /** Playing video to use as the source; takes precedence over src */
  video?: HTMLVideoElement | null;
  /** Sampling options for the video source */
  videoOptions?: Omit<KawarpVideoOptions, "onError">;
  /** Whether to auto-start animation (default: true) */
  autoPlay?: boolean;
  /** Callback when the image is loaded */
  onLoad?: () => void;
  /** Callback when an error occurs */
  onError?: (error: Error) => void;
}

export interface UseKawarpReturn {
  /** Ref to pass to the Kawarp component */
  ref: RefObject<KawarpRef | null>;
  /** Load an image from a URL */
  loadImage: (src: string) => Promise<void>;
  /** Load from a Blob or File */
  loadBlob: (blob: Blob) => Promise<void>;
  /** Load colors as a gradient source */
  loadGradient: (colors: string[], angle?: number) => void;
  /** Start the animation */
  start: () => void;
  /** Stop the animation */
  stop: () => void;
}

/**
 * Hook to control a Kawarp component imperatively
 *
 * @example
 * ```tsx
 * const { ref, loadImage, loadBlob } = useKawarp();
 *
 * // Load images without ref.current?.
 * await loadImage('https://example.com/image.jpg');
 * await loadBlob(file);
 *
 * <Kawarp ref={ref} src={initialSrc} />
 * ```
 */
export function useKawarp(): UseKawarpReturn {
  const ref = useRef<KawarpRef | null>(null);

  const loadImage = useCallback(async (src: string) => {
    await ref.current?.loadImage(src);
  }, []);

  const loadBlob = useCallback(async (blob: Blob) => {
    await ref.current?.loadBlob(blob);
  }, []);

  const loadGradient = useCallback((colors: string[], angle?: number) => {
    ref.current?.loadGradient(colors, angle);
  }, []);

  const start = useCallback(() => {
    ref.current?.start();
  }, []);

  const stop = useCallback(() => {
    ref.current?.stop();
  }, []);

  return { ref, loadImage, loadBlob, loadGradient, start, stop };
}

export const Kawarp = forwardRef<KawarpRef, KawarpProps>(function Kawarp(
  {
    className,
    style,
    src,
    video,
    videoOptions,
    autoPlay = true,
    onLoad,
    onError,
    warpIntensity,
    blurPasses,
    animationSpeed,
    transitionDuration,
    saturation,
    tintColor,
    tintIntensity,
    dithering,
    scale,
    highPrecisionInput,
    highPrecisionOutput,
  },
  ref,
) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const kawarpRef = useRef<KawarpCore | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const initializedRef = useRef(false);
  const currentSrcRef = useRef<string | undefined>(undefined);
  const lastVideoRef = useRef<HTMLVideoElement | null | undefined>(undefined);
  // Whether the canvas currently shows a video frame rather than an image.
  // Every image load clears it and the first video frame sets it; it is not
  // reset when the video element changes because the on-screen content has
  // not changed until a new frame actually arrives.
  const screenShowsVideoRef = useRef(false);
  const frameCallbackIdRef = useRef<number | null>(null);
  const onLoadRef = useRef(onLoad);
  const onErrorRef = useRef(onError);
  const videoFailedRef = useRef(false);

  // Expose imperative methods
  useImperativeHandle(
    ref,
    () => ({
      get instance() {
        return kawarpRef.current;
      },
      loadImage: async (url: string) => {
        await kawarpRef.current?.loadImage(url);
      },
      loadBlob: async (blob: Blob) => {
        await kawarpRef.current?.loadBlob(blob);
      },
      loadGradient: (colors: string[], angle?: number) => {
        kawarpRef.current?.loadGradient(colors, angle);
      },
      start: () => {
        kawarpRef.current?.start();
      },
      stop: () => {
        kawarpRef.current?.stop();
      },
    }),
    [],
  );

  // Initialize Kawarp
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    let cancelled = false;

    const kawarp = new KawarpCore(canvas, {
      warpIntensity,
      blurPasses,
      animationSpeed,
      transitionDuration,
      saturation,
      tintColor,
      tintIntensity,
      dithering,
      scale,
      highPrecisionInput,
      highPrecisionOutput,
    });
    kawarpRef.current = kawarp;
    initializedRef.current = true;

    // Load initial image if provided; with a video it shows until the first frame
    if (src) {
      currentSrcRef.current = src;
      screenShowsVideoRef.current = false;
      kawarp
        .loadImage(src)
        .then(() => {
          if (cancelled) return;
          onLoad?.();
          if (autoPlay) kawarp.start();
        })
        .catch((error) => {
          if (cancelled) return;
          onError?.(error instanceof Error ? error : new Error(String(error)));
        });
    } else if (autoPlay) {
      kawarp.start();
    }

    return () => {
      cancelled = true;
      kawarp.dispose();
      kawarpRef.current = null;
      initializedRef.current = false;
    };
    // Only run on mount/unmount - options and src are updated separately
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Auto-load when src changes; src takes over again once the video is cleared
  useEffect(() => {
    const kawarp = kawarpRef.current;
    if (!initializedRef.current || !kawarp) return;
    const previousVideo = lastVideoRef.current;
    lastVideoRef.current = video;
    const leavingVideo = !video && !!previousVideo;
    const srcChanged = src !== currentSrcRef.current;
    currentSrcRef.current = src;
    if (leavingVideo) kawarp.unloadVideo();

    // While a video is set, src only matters as the poster of a new video or
    // the fallback of a failed one; loading it otherwise would replace the video
    // Runs before the new video resets videoFailedRef, so a cleared video that
    // already fell back to src does not load it again
    const shouldLoad = video
      ? srcChanged && (video !== previousVideo || videoFailedRef.current)
      : srcChanged || (leavingVideo && !videoFailedRef.current);
    if (src && shouldLoad) {
      screenShowsVideoRef.current = false;
      kawarp
        .loadImage(src)
        .then(() => onLoad?.())
        .catch((error) => {
          onError?.(error instanceof Error ? error : new Error(String(error)));
        });
    }
  }, [src, video, onLoad, onError]);

  useEffect(() => {
    onLoadRef.current = onLoad;
    onErrorRef.current = onError;
  });

  // A new video gets a fresh attempt and resumes animation like autoPlay does for src
  useEffect(() => {
    videoFailedRef.current = false;
    if (video && autoPlay) kawarpRef.current?.start();
  }, [video]);

  // Mark the on-screen content as video once the current element presents a
  // frame. A failure before that point leaves the poster visible or loading,
  // so the fallback must not reload that same src (which would duplicate the
  // load and its onLoad event). Options-only re-runs keep the flag instead of
  // resetting the video's progress, and switching elements keeps whatever is
  // still on screen until a new frame arrives.
  useEffect(() => {
    const kawarp = kawarpRef.current;
    if (!video || !kawarp || screenShowsVideoRef.current) return;
    if (video.readyState >= video.HAVE_CURRENT_DATA && video.videoWidth > 0) {
      screenShowsVideoRef.current = true;
      return;
    }
    if (typeof video.requestVideoFrameCallback !== "function") return;
    frameCallbackIdRef.current = video.requestVideoFrameCallback(() => {
      frameCallbackIdRef.current = null;
      screenShowsVideoRef.current = true;
    });
    return () => {
      if (frameCallbackIdRef.current !== null) {
        video.cancelVideoFrameCallback(frameCallbackIdRef.current);
        frameCallbackIdRef.current = null;
      }
    };
  }, [video]);

  useEffect(() => {
    const kawarp = kawarpRef.current;
    if (!kawarp || !video || videoFailedRef.current) return;
    const reportVideoError = (error: unknown) => {
      videoFailedRef.current = true;
      onErrorRef.current?.(
        error instanceof Error ? error : new Error(String(error)),
      );
      const fallbackSrc = currentSrcRef.current;
      if (!fallbackSrc || kawarpRef.current !== kawarp) return;
      // No video frame has replaced the poster, so it is still visible or its
      // in-flight load will show it: reloading src now would duplicate the
      // load and its onLoad event
      if (!screenShowsVideoRef.current) {
        return;
      }
      kawarp
        .loadImage(fallbackSrc)
        .then(() => onLoadRef.current?.())
        .catch((loadError) => {
          onErrorRef.current?.(
            loadError instanceof Error
              ? loadError
              : new Error(String(loadError)),
          );
        });
    };
    try {
      kawarp.loadVideo(video, { ...videoOptions, onError: reportVideoError });
    } catch (error) {
      reportVideoError(error);
    }
  }, [
    video,
    videoOptions?.sampleWidth,
    videoOptions?.sampleHeight,
    videoOptions?.downsampleFactor,
    videoOptions?.frameRate,
    videoOptions?.smoothing,
  ]);

  // Memoize tintColor to prevent unnecessary updates
  const stableTintColor = useMemo(
    () => tintColor,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tintColor?.[0], tintColor?.[1], tintColor?.[2]],
  );

  // Update options when props change
  useEffect(() => {
    kawarpRef.current?.setOptions({
      warpIntensity,
      blurPasses,
      animationSpeed,
      transitionDuration,
      saturation,
      tintColor: stableTintColor,
      tintIntensity,
      dithering,
      scale,
    });
  }, [
    warpIntensity,
    blurPasses,
    animationSpeed,
    transitionDuration,
    saturation,
    stableTintColor,
    tintIntensity,
    dithering,
    scale,
  ]);

  // Handle resize with ResizeObserver (debounced, with devicePixelRatio)
  useEffect(() => {
    const container = containerRef.current;
    const canvas = canvasRef.current;
    if (!container || !canvas) return;

    let resizeTimeout: ReturnType<typeof setTimeout> | null = null;

    const updateSize = () => {
      const rect = container.getBoundingClientRect();
      canvas.width = Math.round(rect.width);
      canvas.height = Math.round(rect.height);
      kawarpRef.current?.resize();
    };

    const debouncedUpdateSize = () => {
      if (resizeTimeout) clearTimeout(resizeTimeout);
      resizeTimeout = setTimeout(updateSize, 100);
    };

    const resizeObserver = new ResizeObserver(debouncedUpdateSize);
    resizeObserver.observe(container);
    updateSize();

    return () => {
      resizeObserver.disconnect();
      if (resizeTimeout) clearTimeout(resizeTimeout);
    };
  }, []);

  return (
    <div
      ref={containerRef}
      className={className}
      style={{ position: "relative", ...style }}
    >
      <canvas
        ref={canvasRef}
        style={{
          position: "absolute",
          inset: 0,
          width: "100%",
          height: "100%",
        }}
      />
    </div>
  );
});

export default Kawarp;

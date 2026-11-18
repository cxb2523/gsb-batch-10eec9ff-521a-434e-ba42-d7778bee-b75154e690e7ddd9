"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { ExternalLink } from "lucide-react"
import { PlayerBuffer } from "@/components/loading-skeletons"
import { Button } from "@/components/ui/button"
import { useToast } from "@/components/ui/use-toast"

interface EnhancedMediaPlayerProps {
  type: string
  id: string
  title: string
  season?: number
  episode?: number
}

// How long an iframe may take to fire onLoad before we consider the
// current source broken and fall back to the next candidate.
export const IFRAME_LOAD_TIMEOUT_MS = 8000

interface StreamResponse {
  candidates?: unknown
  embedUrl?: unknown
  error?: string
}

function toCandidateList(data: StreamResponse): string[] {
  if (Array.isArray(data.candidates)) {
    return data.candidates.filter((candidate): candidate is string => typeof candidate === "string")
  }
  // Backwards compatibility with the single-source response shape.
  return typeof data.embedUrl === "string" ? [data.embedUrl] : []
}

export default function EnhancedMediaPlayer({ type, id, title, season = 1, episode = 1 }: EnhancedMediaPlayerProps) {
  const [candidates, setCandidates] = useState<string[]>([])
  const [currentIndex, setCurrentIndex] = useState(0)
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [frameLoaded, setFrameLoaded] = useState(false)
  // Incrementing this value restarts the whole fetch-and-play cycle
  // from the first candidate (used by the Retry button).
  const [retryCount, setRetryCount] = useState(0)
  const { toast } = useToast()

  // Refs mirror the latest state so timeout callbacks always read the
  // current generation instead of a value captured at schedule time.
  const candidatesRef = useRef<string[]>([])
  const currentIndexRef = useRef(0)
  const frameLoadedRef = useRef(false)

  candidatesRef.current = candidates
  currentIndexRef.current = currentIndex

  const currentUrl = candidates[currentIndex] ?? null

  const advanceToNextCandidate = useCallback(() => {
    // A late onLoad may have landed just before the timer fired.
    if (frameLoadedRef.current) {
      return
    }

    const nextIndex = currentIndexRef.current + 1
    if (nextIndex >= candidatesRef.current.length) {
      const message = "All streaming sources failed to load. Please try again."
      setError(message)
      toast({ title: "Streaming Error", description: message, variant: "destructive" })
      return
    }

    setCurrentIndex(nextIndex)
  }, [toast])

  // Fetch the priority-ordered candidate list whenever the target media
  // changes or the user requests a retry. Everything from a previous
  // generation is torn down in the cleanup so stale callbacks can never
  // overwrite the state of the newly selected episode.
  useEffect(() => {
    let cancelled = false
    const controller = new AbortController()

    setIsLoading(true)
    setError(null)
    setCandidates([])
    setCurrentIndex(0)
    frameLoadedRef.current = false
    setFrameLoaded(false)

    const fetchCandidates = async () => {
      try {
        const params = new URLSearchParams({ tmdbId: id, type })

        if (type === "tv") {
          params.append("season", season.toString())
          params.append("episode", episode.toString())
        }

        const response = await fetch(`/api/stream?${params.toString()}`, {
          signal: controller.signal,
        })
        const data: StreamResponse = await response.json().catch(() => ({}))

        if (!response.ok) {
          throw new Error(data.error || "Failed to fetch streaming source")
        }

        const nextCandidates = toCandidateList(data)

        if (cancelled) {
          return
        }

        if (nextCandidates.length === 0) {
          throw new Error("No streaming sources available")
        }

        setCandidates(nextCandidates)
        setIsLoading(false)
      } catch (err) {
        if (cancelled || controller.signal.aborted) {
          return
        }
        const message = err instanceof Error ? err.message : "Failed to load streaming source"
        setError(message)
        setIsLoading(false)
        toast({ title: "Streaming Error", description: message, variant: "destructive" })
      }
    }

    fetchCandidates()

    return () => {
      cancelled = true
      controller.abort()
    }
  }, [id, type, season, episode, retryCount, toast])

  // Reset the per-source loading state whenever we switch to another
  // candidate or restart the cycle.
  useEffect(() => {
    frameLoadedRef.current = false
    setFrameLoaded(false)
  }, [currentIndex, retryCount])

  // Arm the load timeout for the active iframe. If onLoad does not fire
  // in time (or the loaded document is a cross-origin error page that
  // never signals playback), move on to the next candidate. The cleanup
  // guarantees pending timers are cancelled on every source/episode switch.
  useEffect(() => {
    if (candidates.length === 0 || error) {
      return
    }

    const timeoutId = setTimeout(() => {
      if (!frameLoadedRef.current) {
        advanceToNextCandidate()
      }
    }, IFRAME_LOAD_TIMEOUT_MS)

    return () => clearTimeout(timeoutId)
  }, [candidates, currentIndex, retryCount, error, advanceToNextCandidate])

  const handleFrameLoad = useCallback(() => {
    frameLoadedRef.current = true
    setFrameLoaded(true)
  }, [])

  const handleRetry = useCallback(() => {
    // Re-fetch the list and restart from the first candidate.
    setRetryCount((count) => count + 1)
  }, [])

  return (
    <div className="flex flex-col gap-2">
      <div className="relative w-full aspect-video bg-black">
        {isLoading ? (
          <PlayerBuffer label="Loading video player..." />
        ) : error ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center p-4 text-center">
            <p className="text-xl font-semibold text-destructive mb-2">Unable to load video</p>
            <p className="text-muted-foreground">{error}</p>
            <Button className="mt-4" onClick={handleRetry}>
              Try Again
            </Button>
          </div>
        ) : currentUrl ? (
          <>
            <iframe
              key={`${retryCount}-${currentIndex}-${currentUrl}`}
              src={currentUrl}
              title={title}
              onLoad={handleFrameLoad}
              className={`absolute inset-0 h-full w-full transition-opacity duration-500 ${frameLoaded ? "opacity-100" : "opacity-0"}`}
              allowFullScreen
              allow="autoplay; fullscreen; encrypted-media; picture-in-picture"
            />
            {!frameLoaded && (
              <PlayerBuffer
                label={`Loading source ${currentIndex + 1} of ${candidates.length}...`}
              />
            )}
          </>
        ) : (
          <div className="absolute inset-0 flex items-center justify-center">
            <p className="text-xl">No video source available</p>
          </div>
        )}
      </div>
      {currentUrl && !isLoading && !error && (
        <p className="text-sm text-muted-foreground">
          {"Player not loading? "}
          <a
            href={currentUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 font-medium text-primary underline-offset-4 hover:underline"
          >
            Open in a new tab
            <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
          </a>
        </p>
      )}
    </div>
  )
}

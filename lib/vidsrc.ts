// VidSrc base URLs for fallback, ordered by priority
export const VIDSRC_BASE_URLS = [
  "https://vidsrc.icu",
  "https://vidsrc.stream",
  "https://vidsrc.me",
  "https://vidsrc.to",
]

/**
 * Builds the embed URL for a movie on a given VidSrc base URL.
 */
export function buildMovieEmbedUrl(baseUrl: string, tmdbId: string): string {
  return `${baseUrl}/embed/${tmdbId}`
}

/**
 * Builds the embed URL for a TV episode on a given VidSrc base URL.
 */
export function buildTVEmbedUrl(baseUrl: string, tmdbId: string, season: number, episode: number): string {
  return `${baseUrl}/embed/tv/${tmdbId}/${season}/${episode}`
}

/**
 * Builds every candidate embed URL for the requested content,
 * ordered by the priority of the base URLs.
 */
export function buildEmbedCandidates(
  type: string,
  tmdbId: string,
  season?: number,
  episode?: number,
): string[] {
  return VIDSRC_BASE_URLS.map((baseUrl) =>
    type === "tv"
      ? buildTVEmbedUrl(baseUrl, tmdbId, season ?? 1, episode ?? 1)
      : buildMovieEmbedUrl(baseUrl, tmdbId),
  )
}

/**
 * Checks if a URL is accessible
 */
export async function checkUrl(url: string): Promise<boolean> {
  try {
    const response = await fetch(url, {
      method: "HEAD",
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
      },
    })
    return response.ok
  } catch (error) {
    console.error(`Error checking URL ${url}:`, error)
    return false
  }
}

/**
 * Probes every candidate embed URL and returns the ones that answered
 * successfully, preserving the original priority order.
 */
export async function probeCandidates(candidates: string[]): Promise<string[]> {
  const results = await Promise.all(
    candidates.map(async (url) => ({ url, ok: await checkUrl(url) })),
  )
  return results.filter((result) => result.ok).map((result) => result.url)
}

/**
 * Gets a working embed URL for a movie
 */
export async function getMovieEmbed(tmdbId: string): Promise<string | null> {
  for (const embedUrl of buildEmbedCandidates("movie", tmdbId)) {
    if (await checkUrl(embedUrl)) {
      return embedUrl
    }
  }
  return null
}

/**
 * Gets a working embed URL for a TV show episode
 */
export async function getTVEmbed(tmdbId: string, season: number, episode: number): Promise<string | null> {
  for (const embedUrl of buildEmbedCandidates("tv", tmdbId, season, episode)) {
    if (await checkUrl(embedUrl)) {
      return embedUrl
    }
  }
  return null
}

import { type NextRequest, NextResponse } from "next/server"

import { buildEmbedCandidates, probeCandidates } from "@/lib/vidsrc"

export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams
  const tmdbId = searchParams.get("tmdbId")
  const type = searchParams.get("type") || "movie"
  const season = searchParams.get("season")
  const episode = searchParams.get("episode")

  if (!tmdbId) {
    return NextResponse.json({ error: "Missing tmdbId parameter" }, { status: 400 })
  }

  if (type !== "movie" && type !== "tv") {
    return NextResponse.json({ error: "Invalid parameters for TV show" }, { status: 400 })
  }

  const seasonNum = season ? Number.parseInt(season, 10) : NaN
  const episodeNum = episode ? Number.parseInt(episode, 10) : NaN

  if (type === "tv" && (!season || !episode || Number.isNaN(seasonNum) || Number.isNaN(episodeNum))) {
    return NextResponse.json({ error: "Invalid parameters for TV show" }, { status: 400 })
  }

  // Build the full priority-ordered candidate list from the shared
  // VidSrc helpers so the domain list lives in exactly one place.
  const candidates = buildEmbedCandidates(type, tmdbId, seasonNum, episodeNum)

  // Keep only the sources the server can reach, preserving priority order.
  const availableCandidates = await probeCandidates(candidates)

  if (availableCandidates.length === 0) {
    return NextResponse.json({ error: "No available streaming sources found" }, { status: 404 })
  }

  return NextResponse.json({
    candidates: availableCandidates,
    // Kept for backwards compatibility with any single-source consumer.
    embedUrl: availableCandidates[0],
  })
}

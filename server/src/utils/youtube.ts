/**
 * Utility functions for YouTube video ID parsing, timestamp validation, and playback rate validation.
 */

// Supported YouTube playback rates
export const SUPPORTED_PLAYBACK_RATES = [0.25, 0.5, 0.75, 1.0, 1.25, 1.5, 1.75, 2.0] as const;

export type SupportedPlaybackRate = (typeof SUPPORTED_PLAYBACK_RATES)[number];

/**
 * Validates and extracts a canonical 11-character YouTube video ID.
 * Accepts:
 * - Direct 11-char alphanumeric ID (e.g., "dQw4w9WgXcQ")
 * - Full YouTube watch URLs (e.g., "https://www.youtube.com/watch?v=dQw4w9WgXcQ")
 * - Shortened youtu.be URLs (e.g., "https://youtu.be/dQw4w9WgXcQ")
 * - Embed URLs (e.g., "https://www.youtube.com/embed/dQw4w9WgXcQ")
 * - Shorts URLs (e.g., "https://www.youtube.com/shorts/dQw4w9WgXcQ")
 */
export function extractYouTubeVideoId(input: unknown): string | null {
  if (typeof input !== "string") {
    return null;
  }

  const trimmed = input.trim();
  if (!trimmed) {
    return null;
  }

  // 1. Direct 11-character format: [a-zA-Z0-9_-]{11}
  if (/^[a-zA-Z0-9_-]{11}$/.test(trimmed)) {
    return trimmed;
  }

  // 2. URL parsing
  try {
    const url = new URL(trimmed);
    const hostname = url.hostname.toLowerCase();

    if (hostname.includes("youtube.com")) {
      const v = url.searchParams.get("v");
      if (v && /^[a-zA-Z0-9_-]{11}$/.test(v)) {
        return v;
      }

      // Check /embed/:id
      const embedMatch = url.pathname.match(/\/embed\/([a-zA-Z0-9_-]{11})/);
      if (embedMatch) {
        return embedMatch[1];
      }

      // Check /shorts/:id
      const shortsMatch = url.pathname.match(/\/shorts\/([a-zA-Z0-9_-]{11})/);
      if (shortsMatch) {
        return shortsMatch[1];
      }
    } else if (hostname === "youtu.be") {
      const pathId = url.pathname.slice(1).split("/")[0].split("?")[0];
      if (/^[a-zA-Z0-9_-]{11}$/.test(pathId)) {
        return pathId;
      }
    }
  } catch {
    // Input is not a valid URL
  }

  return null;
}

/**
 * Validates that a timestamp is a non-negative, finite number within reasonable bounds (0 to 86400s / 24h).
 */
export function isValidTimestamp(ts: unknown): ts is number {
  if (typeof ts !== "number" || !Number.isFinite(ts) || Number.isNaN(ts)) {
    return false;
  }
  return ts >= 0 && ts <= 86400;
}

/**
 * Validates that a playback rate is one of the supported standard YouTube rates.
 */
export function isValidPlaybackRate(rate: unknown): rate is SupportedPlaybackRate {
  if (typeof rate !== "number" || !Number.isFinite(rate)) {
    return false;
  }
  return (SUPPORTED_PLAYBACK_RATES as readonly number[]).includes(rate);
}

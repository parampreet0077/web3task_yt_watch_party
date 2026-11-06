/**
 * YouTube Data API v3 Search and Metadata Service
 *
 * Implements video search and duration lookup using native Node.js fetch.
 * Features 5-minute in-memory caching and strict quota/error management.
 * The API key is securely loaded from environment variables and never exposed to clients.
 */

export interface YouTubeSearchResult {
  videoId: string;
  title: string;
  channelTitle: string;
  thumbnailUrl: string;
  durationSec: number;
  durationFormatted: string;
  description?: string;
}

export interface YouTubeVideoDetails {
  videoId: string;
  title: string;
  channelTitle: string;
  thumbnailUrl: string;
  durationSec: number;
  durationFormatted: string;
}

export class YouTubeApiError extends Error {
  statusCode: number;
  code: string;

  constructor(message: string, statusCode = 500, code = "YOUTUBE_API_ERROR") {
    super(message);
    this.name = "YouTubeApiError";
    this.statusCode = statusCode;
    this.code = code;
  }
}

/**
 * Parses ISO 8601 duration format (e.g., "PT3M45S", "PT1H2M10S", "PT45S") to total seconds.
 */
export function parseISO8601Duration(durationStr?: string): number {
  if (!durationStr || typeof durationStr !== "string") return 0;
  const match = durationStr.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!match) return 0;

  const hours = parseInt(match[1] || "0", 10);
  const minutes = parseInt(match[2] || "0", 10);
  const seconds = parseInt(match[3] || "0", 10);

  return hours * 3600 + minutes * 60 + seconds;
}

/**
 * Formats seconds into MM:SS or HH:MM:SS format.
 */
export function formatDuration(totalSeconds: number): string {
  if (!Number.isFinite(totalSeconds) || totalSeconds <= 0) return "00:00";
  const total = Math.floor(totalSeconds);
  const hrs = Math.floor(total / 3600);
  const mins = Math.floor((total % 3600) / 60);
  const secs = total % 60;

  const mm = mins.toString().padStart(2, "0");
  const ss = secs.toString().padStart(2, "0");

  if (hrs > 0) {
    return `${hrs}:${mm}:${ss}`;
  }
  return `${mm}:${ss}`;
}

// In-Memory 5-minute caches
interface CacheEntry<T> {
  data: T;
  expiresAt: number;
}

const SEARCH_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const RECOMMENDATIONS_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour (long-lived cache for recommendations)
const searchCache = new Map<string, CacheEntry<YouTubeSearchResult[]>>();
const videoDetailsCache = new Map<string, CacheEntry<YouTubeVideoDetails>>();
const recommendationsCache = new Map<string, CacheEntry<YouTubeSearchResult[]>>();

function cleanExpiredCache(): void {
  const now = Date.now();
  for (const [key, entry] of searchCache.entries()) {
    if (now > entry.expiresAt) searchCache.delete(key);
  }
  for (const [key, entry] of videoDetailsCache.entries()) {
    if (now > entry.expiresAt) videoDetailsCache.delete(key);
  }
  for (const [key, entry] of recommendationsCache.entries()) {
    if (now > entry.expiresAt) recommendationsCache.delete(key);
  }
}

/**
 * Search YouTube videos via YouTube Data API v3.
 * Automatically fetches contentDetails for accurate durations.
 */
export async function searchYouTubeVideos(
  query: string,
  maxResults = 15
): Promise<YouTubeSearchResult[]> {
  const trimmed = typeof query === "string" ? query.trim() : "";

  if (!trimmed || trimmed.length === 0) {
    throw new YouTubeApiError("Search query cannot be empty", 400, "INVALID_QUERY");
  }

  if (trimmed.length > 100) {
    throw new YouTubeApiError("Search query must be 100 characters or fewer", 400, "QUERY_TOO_LONG");
  }

  const cacheKey = `${trimmed.toLowerCase()}:${maxResults}`;
  const now = Date.now();

  // Check in-memory cache
  const cached = searchCache.get(cacheKey);
  if (cached && now < cached.expiresAt) {
    return cached.data;
  }

  const apiKey = process.env.YOUTUBE_API_KEY?.trim();
  if (!apiKey) {
    throw new YouTubeApiError(
      "YouTube Data API v3 key is not configured (YOUTUBE_API_KEY is missing). Add YOUTUBE_API_KEY to server/.env or Render dashboard, or use the 'Paste Link / ID' tab.",
      503,
      "API_KEY_NOT_CONFIGURED"
    );
  }

  cleanExpiredCache();

  // 1. Execute Search request
  const searchUrl = new URL("https://www.googleapis.com/youtube/v3/search");
  searchUrl.searchParams.set("part", "snippet");
  searchUrl.searchParams.set("type", "video");
  searchUrl.searchParams.set("maxResults", String(Math.min(maxResults, 25)));
  searchUrl.searchParams.set("q", trimmed);
  searchUrl.searchParams.set("key", apiKey);

  let searchRes: Response;
  try {
    searchRes = await fetch(searchUrl.toString(), {
      headers: { Accept: "application/json" },
    });
  } catch (err: any) {
    console.error("[YouTube API Fetch Error]:", err?.message || err);
    throw new YouTubeApiError(
      "Failed to connect to YouTube API. Please check your network connection.",
      502,
      "UPSTREAM_UNREACHABLE"
    );
  }

  if (!searchRes.ok) {
    let errBody: any = null;
    try {
      errBody = await searchRes.json();
    } catch {
      // Ignore
    }

    const firstReason = errBody?.error?.errors?.[0]?.reason || "";
    const rawMessage = (errBody?.error?.message || "").toLowerCase();

    // 1. Quota limit exceeded
    if (searchRes.status === 403 && (firstReason === "quotaExceeded" || firstReason.includes("quota") || rawMessage.includes("quota"))) {
      throw new YouTubeApiError(
        "YouTube API daily quota limit exceeded. Please try again tomorrow or add video links directly via 'Paste Link / ID'.",
        429,
        "QUOTA_EXCEEDED"
      );
    }

    // 2. API not enabled in Google Cloud
    if (searchRes.status === 403 && (firstReason === "accessNotConfigured" || rawMessage.includes("has not been used") || rawMessage.includes("disabled"))) {
      throw new YouTubeApiError(
        "YouTube Data API v3 is not enabled in your Google Cloud project. Enable it at https://console.cloud.google.com/apis/library/youtube.googleapis.com",
        403,
        "API_NOT_ENABLED"
      );
    }

    // 3. Invalid API key
    if (
      searchRes.status === 400 &&
      (firstReason === "keyInvalid" || rawMessage.includes("api key not valid") || rawMessage.includes("invalid api key"))
    ) {
      throw new YouTubeApiError(
        "The configured YOUTUBE_API_KEY is invalid. Please verify your Google Cloud API key in server/.env.",
        400,
        "INVALID_API_KEY"
      );
    }

    // 4. Restricted API key (IP or Referrer block)
    if (searchRes.status === 403 && (firstReason === "ipRefererBlocked" || rawMessage.includes("restricted"))) {
      throw new YouTubeApiError(
        "The configured YOUTUBE_API_KEY has IP or HTTP referrer restrictions that prevent server-side calls.",
        403,
        "API_KEY_RESTRICTED"
      );
    }

    if (searchRes.status === 400) {
      throw new YouTubeApiError("Invalid search request parameters", 400, "BAD_REQUEST");
    }

    console.error(`[YouTube API Error ${searchRes.status}]:`, errBody?.error?.message || "Unknown error");
    throw new YouTubeApiError(
      `YouTube search service returned status ${searchRes.status}. Please use direct video link fallback.`,
      searchRes.status >= 500 ? 502 : searchRes.status,
      "UPSTREAM_ERROR"
    );
  }

  const searchData = (await searchRes.json()) as { items?: any[] };
  const items = Array.isArray(searchData.items) ? searchData.items : [];

  if (items.length === 0) {
    searchCache.set(cacheKey, { data: [], expiresAt: now + SEARCH_CACHE_TTL_MS });
    return [];
  }

  // 2. Fetch Duration & Content Details for returned video IDs in a single batch
  const videoIds = items
    .map((item) => item?.id?.videoId)
    .filter((id): id is string => typeof id === "string" && id.length > 0);

  const durationMap = new Map<string, number>();

  if (videoIds.length > 0) {
    try {
      const videosUrl = new URL("https://www.googleapis.com/youtube/v3/videos");
      videosUrl.searchParams.set("part", "contentDetails");
      videosUrl.searchParams.set("id", videoIds.join(","));
      videosUrl.searchParams.set("key", apiKey);

      const videosRes = await fetch(videosUrl.toString(), {
        headers: { Accept: "application/json" },
      });

      if (videosRes.ok) {
        const videosData = (await videosRes.json()) as { items?: any[] };
        if (Array.isArray(videosData.items)) {
          for (const vItem of videosData.items) {
            const vId = vItem?.id;
            const isoDuration = vItem?.contentDetails?.duration;
            if (vId && isoDuration) {
              durationMap.set(vId, parseISO8601Duration(isoDuration));
            }
          }
        }
      }
    } catch (err) {
      console.warn("[YouTube API Videos Batch Warning]: Could not fetch video durations:", err);
    }
  }

  // 3. Assemble sanitized results
  const results: YouTubeSearchResult[] = items.map((item) => {
    const videoId = item?.id?.videoId || "";
    const snippet = item?.snippet || {};
    const durationSec = durationMap.get(videoId) || 0;

    return {
      videoId,
      title: snippet.title || "Untitled Video",
      channelTitle: snippet.channelTitle || "Unknown Channel",
      thumbnailUrl:
        snippet.thumbnails?.medium?.url ||
        snippet.thumbnails?.high?.url ||
        snippet.thumbnails?.default?.url ||
        `https://img.youtube.com/vi/${videoId}/mqdefault.jpg`,
      durationSec,
      durationFormatted: formatDuration(durationSec),
      description: snippet.description || "",
    };
  });

  // Store in cache
  searchCache.set(cacheKey, { data: results, expiresAt: now + SEARCH_CACHE_TTL_MS });
  return results;
}

/**
 * Retrieves detailed metadata for a single YouTube video ID.
 * Returns cached data when available.
 */
export async function fetchVideoDetails(videoId: string): Promise<YouTubeVideoDetails | null> {
  const cleanId = typeof videoId === "string" ? videoId.trim() : "";
  if (!cleanId || cleanId.length !== 11) return null;

  const now = Date.now();
  const cached = videoDetailsCache.get(cleanId);
  if (cached && now < cached.expiresAt) {
    return cached.data;
  }

  const apiKey = process.env.YOUTUBE_API_KEY?.trim();
  if (!apiKey) {
    // Zero-key fallback: use YouTube oEmbed API for real public title, author, and thumbnail
    try {
      const oembedRes = await fetch(
        `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${cleanId}&format=json`,
        { headers: { Accept: "application/json" } }
      );
      if (oembedRes.ok) {
        const oembedData = (await oembedRes.json()) as any;
        const details: YouTubeVideoDetails = {
          videoId: cleanId,
          title: oembedData.title || `YouTube Video (${cleanId})`,
          channelTitle: oembedData.author_name || "YouTube",
          thumbnailUrl: oembedData.thumbnail_url || `https://img.youtube.com/vi/${cleanId}/mqdefault.jpg`,
          durationSec: 0,
          durationFormatted: "--:--",
        };
        videoDetailsCache.set(cleanId, { data: details, expiresAt: now + SEARCH_CACHE_TTL_MS });
        return details;
      }
    } catch {
      // Fallback below
    }
    return null;
  }

  try {
    const url = new URL("https://www.googleapis.com/youtube/v3/videos");
    url.searchParams.set("part", "snippet,contentDetails");
    url.searchParams.set("id", cleanId);
    url.searchParams.set("key", apiKey);

    const res = await fetch(url.toString(), {
      headers: { Accept: "application/json" },
    });

    if (!res.ok) return null;

    const data = (await res.json()) as { items?: any[] };
    const item = data.items?.[0];
    if (!item) return null;

    const snippet = item.snippet || {};
    const durationSec = parseISO8601Duration(item.contentDetails?.duration);

    const details: YouTubeVideoDetails = {
      videoId: cleanId,
      title: snippet.title || "Untitled Video",
      channelTitle: snippet.channelTitle || "Unknown Channel",
      thumbnailUrl:
        snippet.thumbnails?.medium?.url ||
        snippet.thumbnails?.high?.url ||
        snippet.thumbnails?.default?.url ||
        `https://img.youtube.com/vi/${cleanId}/mqdefault.jpg`,
      durationSec,
      durationFormatted: formatDuration(durationSec),
    };

    videoDetailsCache.set(cleanId, { data: details, expiresAt: now + SEARCH_CACHE_TTL_MS });
    return details;
  } catch (err) {
    console.warn(`[fetchVideoDetails Warning for ${cleanId}]:`, err);
    return null;
  }
}

/**
 * Extracts high-signal music keywords from a video title and channel name.
 * Strips bracketed text like "(Official Music Video)", "[4K]", "HD", etc.
 */
export function extractRecommendationKeywords(title?: string, channelTitle?: string): string {
  if (!title && !channelTitle) return "trending music hits";

  let raw = (title || "").trim();
  // Strip parenthesized/bracketed metadata like (Official Video), [Lyrics], etc.
  raw = raw.replace(/[\(\[\{][^\)\]\}]*[\)\]\}]/g, " ");
  // Strip common noisy symbols
  raw = raw.replace(/[|#@&!_~:/\\]/g, " ");
  // Strip common music boilerplate terms
  raw = raw.replace(/\b(official|music|video|audio|lyrics|hd|4k|feat|ft|remix|version|prod|explicit)\b/gi, " ");
  raw = raw.replace(/\s+/g, " ").trim();

  if (channelTitle && channelTitle.trim().length > 0) {
    const cleanChan = channelTitle.replace(/[|#@&!_~]/g, " ").trim();
    if (!raw.toLowerCase().includes(cleanChan.toLowerCase())) {
      raw = `${cleanChan} ${raw}`.trim();
    }
  }

  return raw.slice(0, 80) || "top music tracks";
}

/**
 * Curated high-fidelity music recommendations for zero-key mode or quota-exhausted environments.
 * Uses real public YouTube video IDs with accurate durations and standard thumbnails.
 */
export function getCuratedFallbackRecommendations(excludeVideoId?: string): YouTubeSearchResult[] {
  const curated: YouTubeSearchResult[] = [
    {
      videoId: "jfKfPfyJRdk",
      title: "lofi hip hop radio 📚 - beats to relax/study to",
      channelTitle: "Lofi Girl",
      thumbnailUrl: "https://img.youtube.com/vi/jfKfPfyJRdk/mqdefault.jpg",
      durationSec: 1800,
      durationFormatted: "30:00",
      description: "Peaceful lofi hip hop beats for studying, working, or chilling.",
    },
    {
      videoId: "5qap5aO4i9A",
      title: "lofi hip hop radio 💤 - beats to sleep/chill to",
      channelTitle: "Lofi Girl",
      thumbnailUrl: "https://img.youtube.com/vi/5qap5aO4i9A/mqdefault.jpg",
      durationSec: 2400,
      durationFormatted: "40:00",
      description: "Soothing nighttime chillhop beats.",
    },
    {
      videoId: "kJQP7kiw5Fk",
      title: "Luis Fonsi - Despacito ft. Daddy Yankee",
      channelTitle: "Luis Fonsi",
      thumbnailUrl: "https://img.youtube.com/vi/kJQP7kiw5Fk/mqdefault.jpg",
      durationSec: 282,
      durationFormatted: "04:42",
      description: "Global Latin pop sensation hit.",
    },
    {
      videoId: "JGwWNGJdvx8",
      title: "Ed Sheeran - Shape of You",
      channelTitle: "Ed Sheeran",
      thumbnailUrl: "https://img.youtube.com/vi/JGwWNGJdvx8/mqdefault.jpg",
      durationSec: 263,
      durationFormatted: "04:23",
      description: "Hit pop track from ÷ (Divide).",
    },
    {
      videoId: "OPf0YbXqDm0",
      title: "Mark Ronson - Uptown Funk ft. Bruno Mars",
      channelTitle: "Mark Ronson",
      thumbnailUrl: "https://img.youtube.com/vi/OPf0YbXqDm0/mqdefault.jpg",
      durationSec: 270,
      durationFormatted: "04:30",
      description: "Funk-pop party anthem.",
    },
    {
      videoId: "fJ9rUzIMcZQ",
      title: "Queen – Bohemian Rhapsody",
      channelTitle: "Queen Official",
      thumbnailUrl: "https://img.youtube.com/vi/fJ9rUzIMcZQ/mqdefault.jpg",
      durationSec: 359,
      durationFormatted: "05:59",
      description: "Legendary classic rock masterpiece.",
    },
    {
      videoId: "9bZkp7q19f0",
      title: "PSY - GANGNAM STYLE (강남스타일)",
      channelTitle: "officialpsy",
      thumbnailUrl: "https://img.youtube.com/vi/9bZkp7q19f0/mqdefault.jpg",
      durationSec: 252,
      durationFormatted: "04:12",
      description: "Iconic K-pop worldwide mega-hit.",
    },
    {
      videoId: "CevxZvSJLk8",
      title: "Katy Perry - Roar",
      channelTitle: "Katy Perry",
      thumbnailUrl: "https://img.youtube.com/vi/CevxZvSJLk8/mqdefault.jpg",
      durationSec: 270,
      durationFormatted: "04:30",
      description: "Empowering pop anthem.",
    },
    {
      videoId: "09R8_2nJtjg",
      title: "Maroon 5 - Sugar",
      channelTitle: "Maroon 5",
      thumbnailUrl: "https://img.youtube.com/vi/09R8_2nJtjg/mqdefault.jpg",
      durationSec: 301,
      durationFormatted: "05:01",
      description: "Pop-funk celebration track.",
    },
    {
      videoId: "hT_nvWreIhg",
      title: "OneRepublic - Counting Stars",
      channelTitle: "OneRepublic",
      thumbnailUrl: "https://img.youtube.com/vi/hT_nvWreIhg/mqdefault.jpg",
      durationSec: 283,
      durationFormatted: "04:43",
      description: "Energetic folk-pop track.",
    },
  ];

  return curated.filter((item) => !excludeVideoId || item.videoId !== excludeVideoId);
}

/**
 * Retrieves related YouTube video recommendations based on the currently playing video.
 * Uses title + channel keywords, leverages in-memory caching (1 hour TTL), and excludes current video.
 * Seamlessly falls back to curated suggestions if API key is unconfigured or quota is exhausted.
 */
export async function getYouTubeRecommendations(
  videoId?: string,
  title?: string,
  channelTitle?: string,
  limit = 10
): Promise<YouTubeSearchResult[]> {
  const cleanId = typeof videoId === "string" ? videoId.trim() : "";
  const cacheKey = `rec:${cleanId || "generic"}:${(title || "").slice(0, 30).toLowerCase()}:${limit}`;
  const now = Date.now();

  const cached = recommendationsCache.get(cacheKey);
  if (cached && now < cached.expiresAt) {
    return cached.data;
  }

  let resolvedTitle = title;
  let resolvedChannel = channelTitle;

  // If title was omitted but videoId provided, attempt to look up metadata
  if (!resolvedTitle && cleanId) {
    const details = await fetchVideoDetails(cleanId);
    if (details) {
      resolvedTitle = details.title;
      resolvedChannel = details.channelTitle;
    }
  }

  const query = extractRecommendationKeywords(resolvedTitle, resolvedChannel);
  let results: YouTubeSearchResult[] = [];

  try {
    const fetched = await searchYouTubeVideos(query, Math.min(limit + 3, 20));
    results = fetched.filter((item) => item.videoId !== cleanId).slice(0, limit);
  } catch (err: any) {
    console.warn(`[getYouTubeRecommendations] YouTube search fallback triggered (${err?.message || err})`);
    results = getCuratedFallbackRecommendations(cleanId).slice(0, limit);
  }

  if (results.length === 0) {
    results = getCuratedFallbackRecommendations(cleanId).slice(0, limit);
  }

  recommendationsCache.set(cacheKey, { data: results, expiresAt: now + RECOMMENDATIONS_CACHE_TTL_MS });
  return results;
}

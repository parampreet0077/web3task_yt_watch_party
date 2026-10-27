export const SUPPORTED_PLAYBACK_RATES = [0.25, 0.5, 0.75, 1.0, 1.25, 1.5, 1.75, 2.0] as const;

/**
 * Validates and extracts canonical 11-character YouTube video ID.
 * Supports:
 * - 11-character video ID
 * - https://www.youtube.com/watch?v=ID
 * - https://youtu.be/ID
 * - https://www.youtube.com/embed/ID
 * - https://www.youtube.com/shorts/ID
 */
export function extractYouTubeVideoId(input: string): string | null {
  if (!input || typeof input !== 'string') return null;
  const trimmed = input.trim();
  if (!trimmed) return null;

  // 1. Direct 11-character format
  if (/^[a-zA-Z0-9_-]{11}$/.test(trimmed)) {
    return trimmed;
  }

  // 2. URL parsing
  try {
    const url = new URL(trimmed);
    const hostname = url.hostname.toLowerCase();

    if (hostname.includes('youtube.com')) {
      const v = url.searchParams.get('v');
      if (v && /^[a-zA-Z0-9_-]{11}$/.test(v)) {
        return v;
      }

      const embedMatch = url.pathname.match(/\/embed\/([a-zA-Z0-9_-]{11})/);
      if (embedMatch) {
        return embedMatch[1];
      }

      const shortsMatch = url.pathname.match(/\/shorts\/([a-zA-Z0-9_-]{11})/);
      if (shortsMatch) {
        return shortsMatch[1];
      }
    } else if (hostname === 'youtu.be') {
      const pathId = url.pathname.slice(1).split('/')[0].split('?')[0];
      if (/^[a-zA-Z0-9_-]{11}$/.test(pathId)) {
        return pathId;
      }
    }
  } catch {
    // Not a URL
  }

  return null;
}

/**
 * Formats seconds into MM:SS or HH:MM:SS.
 */
export function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '00:00';
  const totalSecs = Math.floor(seconds);
  const hrs = Math.floor(totalSecs / 3600);
  const mins = Math.floor((totalSecs % 3600) / 60);
  const secs = totalSecs % 60;

  const mm = mins.toString().padStart(2, '0');
  const ss = secs.toString().padStart(2, '0');

  if (hrs > 0) {
    return `${hrs}:${mm}:${ss}`;
  }
  return `${mm}:${ss}`;
}

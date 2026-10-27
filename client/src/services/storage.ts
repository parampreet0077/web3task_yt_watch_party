import type { StoredSession } from '../types/room';

const STORAGE_KEY = 'watchparty_active_session';

/**
 * Safely persists raw session token and room identifiers in localStorage.
 * Tokens are never placed in URLs, query params, or logged to console.
 */
export function saveRoomSession(session: StoredSession): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
  } catch (err) {
    console.error('Failed to store room session in localStorage', err);
  }
}

/**
 * Retrieves the stored session for room restoration upon page refresh.
 */
export function getStoredRoomSession(): StoredSession | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed && parsed.roomCode && parsed.token && parsed.participantId) {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Clears the stored session upon room leave or invalidation.
 */
export function clearRoomSession(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Ignore storage errors
  }
}

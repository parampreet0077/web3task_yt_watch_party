import crypto from "node:crypto";

// 32-character unambiguous alphanumeric charset (excluding 0, O, 1, I to avoid human transcription errors)
const ROOM_CODE_CHARSET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const ROOM_CODE_LENGTH = 6;

/**
 * Generates an unpredictable, cryptographically random 6-character room code.
 */
export function generateRoomCode(): string {
  const bytes = crypto.randomBytes(ROOM_CODE_LENGTH);
  let code = "";
  for (let i = 0; i < ROOM_CODE_LENGTH; i++) {
    code += ROOM_CODE_CHARSET[bytes[i] % ROOM_CODE_CHARSET.length];
  }
  return code;
}

/**
 * Generates a 256-bit cryptographically secure random session token.
 */
export function generateSessionToken(): string {
  return crypto.randomBytes(32).toString("hex");
}

/**
 * Computes a SHA-256 digest of the raw session token.
 * Only the hash is ever stored in the database.
 */
export function hashSessionToken(rawToken: string): string {
  return crypto.createHash("sha256").update(rawToken).digest("hex");
}

/**
 * Validates a candidate token hash against a stored hash using constant-time comparison.
 */
export function verifyTokenHash(candidateHash: string, storedHash: string): boolean {
  if (candidateHash.length !== storedHash.length) {
    return false;
  }
  return crypto.timingSafeEqual(
    Buffer.from(candidateHash, "utf-8"),
    Buffer.from(storedHash, "utf-8")
  );
}

// Secret for signing room-scoped moderator invite tokens
const INVITE_SECRET =
  process.env.MOD_INVITE_SECRET ||
  process.env.DATABASE_URL ||
  "watchparty-mod-invite-secret-key-2026";

// Tokens are valid for 24 hours by default
const INVITE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

// In-memory revocation tracking: roomCode -> cutoff timestamp
const roomRevocationCutoffs = new Map<string, number>();

/**
 * Generates an HMAC-signed room-scoped moderator invite token.
 * Binds the room code, a cryptographic salt, and timestamp into the token.
 * Format: <salt>.<timestamp>.<signature>
 */
export function generateModInviteToken(roomCode: string): string {
  const salt = crypto.randomBytes(16).toString("hex");
  const cutoff = roomRevocationCutoffs.get(roomCode.toUpperCase()) || 0;
  const now = Date.now();
  const timestamp = Math.max(now, cutoff + 1).toString();
  const payload = `${roomCode.toUpperCase()}:${salt}:${timestamp}`;
  const signature = crypto.createHmac("sha256", INVITE_SECRET).update(payload).digest("hex");
  return `${salt}.${timestamp}.${signature}`;
}

/**
 * Validates a moderator invite token for a specific room.
 * Uses constant-time comparison, validates HMAC signature, and checks expiry / revocation.
 */
export function verifyModInviteToken(roomCode: string, token: string): boolean {
  if (!token || typeof token !== "string") return false;
  const parts = token.split(".");
  if (parts.length !== 3) return false;

  const [salt, timestampStr, signature] = parts;
  const timestamp = parseInt(timestampStr, 10);
  if (isNaN(timestamp)) return false;

  const now = Date.now();
  // Reject if older than max age or in the future
  if (now - timestamp > INVITE_MAX_AGE_MS || timestamp > now + 60000) {
    return false;
  }

  // Check revocation cutoff for this room
  const cutoff = roomRevocationCutoffs.get(roomCode.toUpperCase());
  if (cutoff && timestamp <= cutoff) {
    return false;
  }

  const payload = `${roomCode.toUpperCase()}:${salt}:${timestampStr}`;
  const expectedSignature = crypto.createHmac("sha256", INVITE_SECRET).update(payload).digest("hex");

  if (signature.length !== expectedSignature.length) {
    return false;
  }

  return crypto.timingSafeEqual(
    Buffer.from(signature, "utf-8"),
    Buffer.from(expectedSignature, "utf-8")
  );
}

/**
 * Revokes all previous invite tokens for a room by setting a cutoff timestamp.
 */
export function revokeRoomModInvites(roomCode: string): void {
  roomRevocationCutoffs.set(roomCode.toUpperCase(), Date.now());
}

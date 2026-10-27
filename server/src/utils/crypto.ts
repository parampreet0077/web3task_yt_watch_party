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

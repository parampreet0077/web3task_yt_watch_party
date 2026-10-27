import { prisma } from "../config/prisma.js";
import { hashSessionToken, verifyTokenHash } from "../utils/crypto.js";
import type { Participant, Room } from "@prisma/client";

export interface SessionVerificationSuccess {
  success: true;
  participant: Participant;
  room: Room;
}

export interface SessionVerificationFailure {
  success: false;
  statusCode: number;
  error: string;
  message: string;
}

export type SessionVerificationResult =
  | SessionVerificationSuccess
  | SessionVerificationFailure;

/**
 * Validates a raw room-scoped session token against PostgreSQL.
 * Performs constant-time token comparison and room-boundary validation.
 * Never trusts client-supplied participant IDs or roles.
 */
export async function verifyParticipantSession(
  rawToken: string | undefined,
  targetRoomCode?: string
): Promise<SessionVerificationResult> {
  if (!rawToken || typeof rawToken !== "string" || rawToken.trim().length === 0) {
    return {
      success: false,
      statusCode: 401,
      error: "Unauthorized",
      message: "A valid session token is required in Authorization, x-session-token, or auth.token",
    };
  }

  const cleanToken = rawToken.trim();
  const candidateHash = hashSessionToken(cleanToken);

  let participant: (Participant & { room: Room }) | null = null;
  let attempts = 0;
  while (attempts < 3) {
    try {
      participant = await prisma.participant.findUnique({
        where: { tokenHash: candidateHash },
        include: { room: true },
      });
      break;
    } catch (err: any) {
      attempts++;
      if (
        attempts < 3 &&
        (err?.code === "P1001" ||
          err?.code === "P1017" ||
          err?.message?.includes("Can't reach database") ||
          err?.message?.includes("Server has closed the connection"))
      ) {
        await new Promise((r) => setTimeout(r, 800));
      } else {
        throw err;
      }
    }
  }

  if (!participant) {
    return {
      success: false,
      statusCode: 401,
      error: "Unauthorized",
      message: "Invalid or expired session token",
    };
  }

  // Constant-time hash verification to mitigate timing side-channel attacks
  if (!verifyTokenHash(candidateHash, participant.tokenHash)) {
    return {
      success: false,
      statusCode: 401,
      error: "Unauthorized",
      message: "Token verification failed",
    };
  }

  // If a roomCode is specified, ensure participant belongs to that specific room
  if (
    targetRoomCode &&
    participant.room.code.toUpperCase() !== targetRoomCode.trim().toUpperCase()
  ) {
    return {
      success: false,
      statusCode: 403,
      error: "Forbidden",
      message: "Session token does not belong to the targeted room",
    };
  }

  return {
    success: true,
    participant,
    room: participant.room,
  };
}

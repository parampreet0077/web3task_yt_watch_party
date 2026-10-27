import type { Response, NextFunction } from "express";
import { verifyParticipantSession } from "../services/auth.service.js";
import type { AuthenticatedRequest } from "../types/auth.js";

/**
 * Middleware that authenticates a request using the client-supplied raw session token.
 * Validates the token against the cryptographic hash stored in PostgreSQL.
 * Verifies that the participant belongs to the specific room referenced in the route.
 */
export async function authenticateParticipant(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const authHeader = req.headers.authorization;
    const customHeader = req.headers["x-session-token"];

    let rawToken: string | undefined;

    if (authHeader && authHeader.startsWith("Bearer ")) {
      rawToken = authHeader.slice(7).trim();
    } else if (typeof customHeader === "string") {
      rawToken = customHeader.trim();
    }

    const targetCode = typeof req.params.code === "string" ? req.params.code : undefined;
    const result = await verifyParticipantSession(rawToken, targetCode);

    if (!result.success) {
      res.status(result.statusCode).json({
        error: result.error,
        message: result.message,
      });
      return;
    }

    req.participant = result.participant;
    req.room = result.room;

    next();
  } catch (error) {
    console.error("[AuthMiddleware Error]:", error);
    res.status(500).json({
      error: "Internal Server Error",
      message: "An error occurred while verifying your session",
    });
  }
}

/**
 * Middleware ensuring the authenticated participant possesses the HOST role.
 */
export function requireHost(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): void {
  if (!req.participant || req.participant.role !== "HOST") {
    res.status(403).json({
      error: "Forbidden",
      message: "Only the room Host is authorized to perform this action",
    });
    return;
  }
  next();
}

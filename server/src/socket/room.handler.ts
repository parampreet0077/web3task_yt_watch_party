import type { Server as SocketIOServer, Socket } from "socket.io";
import { prisma } from "../config/prisma.js";
import { verifyParticipantSession } from "../services/auth.service.js";
import { socketRegistry, type SocketMetadata } from "./registry.js";
import { registerPlaybackHandlers } from "./playback.handler.js";
import { registerRequestHandlers } from "./request.handler.js";
import { toSafePlaybackState, type SafePlaybackState } from "./playback.types.js";
import type { Role } from "@prisma/client";

export interface SafeParticipant {
  id: string;
  displayName: string;
  role: Role;
  isConnected: boolean;
  joinedAt: Date;
  lastActiveAt: Date;
}

export interface SocketSessionData {
  participantId: string;
  roomId: string;
  roomCode: string;
  displayName: string;
  role: Role;
  joinedRoom: boolean;
}

/**
 * Derives the internal, isolated Socket.IO room channel identifier.
 * Prevents arbitrary internal room access by standardizing the prefix.
 */
export function getRoomChannel(roomCode: string): string {
  return `room:${roomCode.trim().toUpperCase()}`;
}

/**
 * Fetches the safe, sanitized participant roster for a given room.
 * Strips all secret hashes, session tokens, and internal database keys.
 */
export async function dbRetry<T>(fn: () => Promise<T>, maxAttempts = 3): Promise<T> {
  let attempt = 0;
  while (attempt < maxAttempts) {
    try {
      return await fn();
    } catch (err: any) {
      attempt++;
      if (
        attempt < maxAttempts &&
        (err?.code === "P1001" ||
          err?.code === "P1017" ||
          err?.message?.includes("Can't reach database") ||
          err?.message?.includes("Server has closed the connection") ||
          err?.message?.includes("Connection pool timeout"))
      ) {
        await new Promise((r) => setTimeout(r, 600 * attempt));
      } else {
        throw err;
      }
    }
  }
  throw new Error("dbRetry failed");
}

export async function getSafeRoster(roomId: string): Promise<SafeParticipant[]> {
  return dbRetry(() =>
    prisma.participant.findMany({
      where: { roomId },
      select: {
        id: true,
        displayName: true,
        role: true,
        isConnected: true,
        joinedAt: true,
        lastActiveAt: true,
      },
      orderBy: { joinedAt: "asc" },
    })
  );
}

// Module-level reference to the active Socket.IO server instance
let ioInstance: SocketIOServer | null = null;

/**
 * Sets up Socket.IO authentication middleware and real-time room event handlers.
 */
export function setupSocketIO(io: SocketIOServer): void {
  ioInstance = io;

  // 1. Authenticate every incoming WebSocket handshake using the room-scoped session token
  io.use(async (socket: Socket, next) => {
    try {
      const auth = socket.handshake.auth || {};
      const headers = socket.handshake.headers || {};

      let rawToken: string | undefined;

      if (typeof auth.token === "string" && auth.token.trim().length > 0) {
        rawToken = auth.token.trim();
      } else if (
        typeof headers["x-session-token"] === "string" &&
        headers["x-session-token"].trim().length > 0
      ) {
        rawToken = headers["x-session-token"].trim();
      } else if (
        typeof headers.authorization === "string" &&
        headers.authorization.startsWith("Bearer ")
      ) {
        rawToken = headers.authorization.slice(7).trim();
      }

      const targetRoomCode =
        typeof auth.roomCode === "string" ? auth.roomCode.trim() : undefined;

      const verification = await verifyParticipantSession(rawToken, targetRoomCode);

      if (!verification.success) {
        const err = new Error(verification.message);
        (err as any).data = {
          statusCode: verification.statusCode,
          error: verification.error,
          message: verification.message,
        };
        return next(err);
      }

      // Populate verified, immutable session data on socket
      const sessionData: SocketSessionData = {
        participantId: verification.participant.id,
        roomId: verification.room.id,
        roomCode: verification.room.code,
        displayName: verification.participant.displayName,
        role: verification.participant.role,
        joinedRoom: false,
      };

      socket.data = sessionData;
      next();
    } catch (error) {
      console.error("[SocketAuthMiddleware Error]:", error);
      next(new Error("Internal error occurred during authentication"));
    }
  });

  // 2. Connection event handling for authenticated sockets
  io.on("connection", (socket: Socket) => {
    const session = socket.data as SocketSessionData;

    // Emit initial connection confirmation (retained for diagnostics/backwards compatibility)
    socket.emit("health:ready", {
      status: "connected",
      socketId: socket.id,
      participantId: session.participantId,
      roomCode: session.roomCode,
      timestamp: new Date().toISOString(),
    });

    // Enforce server-side room membership: reject any events if room has not been joined
    socket.use(([eventName, ..._args], next) => {
      const allowedPreJoinEvents = ["room:join", "ping", "disconnect"];
      if (!session.joinedRoom && !allowedPreJoinEvents.includes(eventName)) {
        return next(
          new Error("Unauthorized: Must join authorized room before emitting events")
        );
      }
      next();
    });

    // Event: Ping / Pong latency check
    socket.on("ping", () => {
      socket.emit("pong", { timestamp: Date.now() });
    });

    // Register Authoritative Playback and Control Request Handlers
    registerPlaybackHandlers(socket, io);
    registerRequestHandlers(socket, io);

    // Event: Join authorized room
    socket.on(
      "room:join",
      async (
        payload: { roomCode?: string } | undefined,
        ack?: (response: {
          success: boolean;
          error?: string;
          roster?: SafeParticipant[];
          playback?: SafePlaybackState | null;
        }) => void
      ) => {
        try {
          // If roomCode payload is supplied, enforce that it matches the authorized session room
          if (
            payload?.roomCode &&
            payload.roomCode.trim().toUpperCase() !== session.roomCode.toUpperCase()
          ) {
            const errorMsg = "Forbidden: Session token is not authorized for requested room";
            if (typeof ack === "function") ack({ success: false, error: errorMsg });
            socket.emit("error", { message: errorMsg, code: "FORBIDDEN" });
            return;
          }

          // Verify participant has not been removed from the database
          const participantRecord = await dbRetry(() =>
            prisma.participant.findUnique({
              where: { id: session.participantId },
            })
          );

          if (!participantRecord || participantRecord.roomId !== session.roomId) {
            const errorMsg = "Participant session no longer exists in this room";
            if (typeof ack === "function") ack({ success: false, error: errorMsg });
            socket.emit("error", { message: errorMsg, code: "SESSION_EXPIRED" });
            socket.disconnect(true);
            return;
          }

          const roomChannel = getRoomChannel(session.roomCode);

          // Join the internal Socket.IO room channel
          await socket.join(roomChannel);
          session.joinedRoom = true;

          const meta: SocketMetadata = {
            participantId: session.participantId,
            roomId: session.roomId,
            roomCode: session.roomCode,
            displayName: session.displayName,
            role: session.role,
          };

          // Register active socket in registry (handles multiple tabs/connections)
          const { isFirstSocket } = socketRegistry.addSocket(
            session.participantId,
            socket.id,
            meta
          );

          // If this is the participant's first active socket, persist isConnected = true in DB
          if (isFirstSocket) {
            await dbRetry(() =>
              prisma.participant.update({
                where: { id: session.participantId },
                data: { isConnected: true, lastActiveAt: new Date() },
              })
            );

            // Notify other room members that a participant has joined
            socket.to(roomChannel).emit("room:participant-joined", {
              participant: {
                id: session.participantId,
                displayName: session.displayName,
                role: session.role,
                isConnected: true,
                joinedAt: participantRecord.joinedAt,
                lastActiveAt: new Date(),
              },
            });
          }

          // Fetch current safe participant roster
          const roster = await getSafeRoster(session.roomId);

          // Fetch current authoritative room playback state
          const room = await prisma.room.findUnique({
            where: { id: session.roomId },
          });
          const playback = room ? toSafePlaybackState(room) : null;

          // Broadcast roster update to all room members
          io.to(roomChannel).emit("room:roster", { participants: roster });

          // Send confirmation back to joining socket with roster and current playback state
          socket.emit("room:joined", {
            roomCode: session.roomCode,
            participant: {
              id: session.participantId,
              displayName: session.displayName,
              role: session.role,
              isConnected: true,
            },
            roster,
            playback,
          });

          if (typeof ack === "function") {
            ack({ success: true, roster, playback });
          }
        } catch (error) {
          console.error("[room:join Error]:", error);
          if (typeof ack === "function") {
            ack({ success: false, error: "Internal error joining room" });
          }
        }
      }
    );

    // Event: Leave room gracefully
    socket.on(
      "room:leave",
      async (
        _payload: unknown,
        ack?: (response: { success: boolean; error?: string }) => void
      ) => {
        try {
          if (!session.joinedRoom) {
            if (typeof ack === "function") ack({ success: true });
            return;
          }

          const roomChannel = getRoomChannel(session.roomCode);
          await socket.leave(roomChannel);
          session.joinedRoom = false;

          const removed = socketRegistry.removeSocket(socket.id);

          // If no remaining active sockets for this participant, mark disconnected in DB
          if (removed && removed.isLastSocket) {
            try {
              await prisma.participant.update({
                where: { id: session.participantId },
                data: { isConnected: false, lastActiveAt: new Date() },
              });
            } catch {
              // Participant record may have been deleted
            }

            // Notify remaining room members
            io.to(roomChannel).emit("room:participant-left", {
              participantId: session.participantId,
              displayName: session.displayName,
            });

            // Broadcast updated roster to room
            const roster = await getSafeRoster(session.roomId);
            io.to(roomChannel).emit("room:roster", { participants: roster });
          }

          socket.emit("room:left", { roomCode: session.roomCode });

          if (typeof ack === "function") {
            ack({ success: true });
          }
        } catch (error) {
          console.error("[room:leave Error]:", error);
          if (typeof ack === "function") {
            ack({ success: false, error: "Internal error leaving room" });
          }
        }
      }
    );

    // Event: Request current roster on-demand
    socket.on(
      "room:get-roster",
      async (
        _payload: unknown,
        ack?: (response: { success: boolean; roster?: SafeParticipant[]; error?: string }) => void
      ) => {
        try {
          if (!session.joinedRoom) {
            const errorMsg = "Must join room before requesting roster";
            if (typeof ack === "function") ack({ success: false, error: errorMsg });
            socket.emit("error", { message: errorMsg, code: "UNAUTHORIZED" });
            return;
          }

          const roster = await getSafeRoster(session.roomId);
          if (typeof ack === "function") {
            ack({ success: true, roster });
          } else {
            socket.emit("room:roster", { participants: roster });
          }
        } catch (error) {
          console.error("[room:get-roster Error]:", error);
          if (typeof ack === "function") {
            ack({ success: false, error: "Failed to retrieve roster" });
          }
        }
      }
    );

    // Event: Explicit Host transfer via Socket.IO
    socket.on(
      "room:transfer-host",
      async (
        payload: { targetParticipantId?: string },
        ack?: (res: { success: boolean; error?: string; formerHost?: any; newHost?: any }) => void
      ) => {
        try {
          if (!session.joinedRoom) {
            const errorMsg = "Must join room before transferring ownership";
            if (typeof ack === "function") ack({ success: false, error: errorMsg });
            socket.emit("error", { message: errorMsg, code: "UNAUTHORIZED" });
            return;
          }

          const targetParticipantId = payload?.targetParticipantId?.trim();
          if (!targetParticipantId) {
            const errorMsg = "Target participant ID is required";
            if (typeof ack === "function") ack({ success: false, error: errorMsg });
            socket.emit("error", { message: errorMsg, code: "INVALID_TARGET" });
            return;
          }

          if (targetParticipantId === session.participantId) {
            const errorMsg = "Cannot transfer host ownership to yourself";
            if (typeof ack === "function") ack({ success: false, error: errorMsg });
            socket.emit("error", { message: errorMsg, code: "SELF_TRANSFER" });
            return;
          }

          // Transactionally execute host transfer with atomic single-host guarantee
          const result = await prisma.$transaction(async (tx) => {
            // 1. Atomic conditional demotion: ONLY succeeds if caller is still actively Role.HOST
            const demoteResult = await tx.participant.updateMany({
              where: { id: session.participantId, roomId: session.roomId, role: "HOST" },
              data: { role: "MODERATOR" },
            });

            if (demoteResult.count === 0) {
              throw new Error("UNAUTHORIZED_TRANSFER: Caller is not the current Host of this room");
            }

            const target = await tx.participant.findFirst({
              where: { id: targetParticipantId, roomId: session.roomId },
            });

            if (!target) {
              throw new Error("NOT_FOUND: Target participant not found in this room");
            }

            if (target.role === "HOST") {
              throw new Error("ALREADY_HOST: Target participant is already the Host");
            }

            const updatedNewHost = await tx.participant.update({
              where: { id: target.id },
              data: { role: "HOST" },
              select: { id: true, displayName: true, role: true, isConnected: true, joinedAt: true },
            });

            const updatedFormerHost = await tx.participant.findUnique({
              where: { id: session.participantId },
              select: { id: true, displayName: true, role: true, isConnected: true, joinedAt: true },
            });

            return { formerHost: updatedFormerHost!, newHost: updatedNewHost };
          });

          session.role = "MODERATOR";

          await broadcastHostTransfer(
            session.roomCode,
            session.roomId,
            result.formerHost.id,
            result.newHost.id,
            result.newHost.displayName
          );

          if (typeof ack === "function") {
            ack({ success: true, formerHost: result.formerHost, newHost: result.newHost });
          }
        } catch (error: any) {
          const msg = error?.message || "Failed to transfer host ownership";
          if (typeof ack === "function") ack({ success: false, error: msg });
          socket.emit("error", { message: msg });
        }
      }
    );

    // Event: Participant submits a genuine role change request (e.g. to become Moderator)
    socket.on(
      "role:request",
      async (
        payload: { requestedRole?: string } | undefined,
        ack?: (res: { success: boolean; error?: string; requestId?: string }) => void
      ) => {
        try {
          if (!session.joinedRoom) {
            const errorMsg = "Must join room before requesting a role";
            if (typeof ack === "function") ack({ success: false, error: errorMsg });
            socket.emit("error", { message: errorMsg, code: "UNAUTHORIZED" });
            return;
          }

          const requestedRole = payload?.requestedRole || "MODERATOR";
          if (requestedRole !== "MODERATOR") {
            const errorMsg = "Only MODERATOR role requests are supported";
            if (typeof ack === "function") ack({ success: false, error: errorMsg });
            socket.emit("error", { message: errorMsg, code: "INVALID_ROLE" });
            return;
          }

          const caller = await prisma.participant.findUnique({
            where: { id: session.participantId },
          });

          if (!caller || caller.roomId !== session.roomId) {
            const errorMsg = "Participant session no longer exists in this room";
            if (typeof ack === "function") ack({ success: false, error: errorMsg });
            socket.emit("error", { message: errorMsg, code: "SESSION_EXPIRED" });
            return;
          }

          if (caller.role === "MODERATOR" || caller.role === "HOST") {
            const errorMsg = "You are already a Moderator or Host in this room";
            if (typeof ack === "function") ack({ success: false, error: errorMsg });
            return;
          }

          const requestId = `rolereq-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
          const roomChannel = getRoomChannel(session.roomCode);

          // Broadcast to room channel so Host receives the role request popup
          io.to(roomChannel).emit("role:requested", {
            requestId,
            participant: {
              id: caller.id,
              displayName: caller.displayName,
              role: caller.role,
            },
            requestedRole: "MODERATOR",
            timestamp: new Date().toISOString(),
          });

          if (typeof ack === "function") {
            ack({ success: true, requestId });
          }
        } catch (err: any) {
          console.error("[role:request Error]:", err);
          if (typeof ack === "function") ack({ success: false, error: "Failed to submit role request" });
        }
      }
    );

    // Event: Room Host resolves a role change request (APPROVE or REJECT)
    socket.on(
      "role:resolve-request",
      async (
        payload: { requestId: string; participantId: string; action: "APPROVE" | "REJECT" },
        ack?: (res: { success: boolean; error?: string; status?: string }) => void
      ) => {
        try {
          if (!session.joinedRoom) {
            const errorMsg = "Must join room before resolving role requests";
            if (typeof ack === "function") ack({ success: false, error: errorMsg });
            socket.emit("error", { message: errorMsg, code: "UNAUTHORIZED" });
            return;
          }

          // Authorize: Caller must be the active Room Host
          const caller = await prisma.participant.findUnique({
            where: { id: session.participantId },
          });

          if (!caller || caller.roomId !== session.roomId || caller.role !== "HOST") {
            const errorMsg = "Forbidden: Only the Room Host can approve or reject role requests";
            if (typeof ack === "function") ack({ success: false, error: errorMsg });
            socket.emit("error", { message: errorMsg, code: "FORBIDDEN" });
            return;
          }

          const { requestId, participantId, action } = payload || {};
          if (!requestId || !participantId || !action) {
            const errorMsg = "requestId, participantId, and action ('APPROVE' | 'REJECT') are required";
            if (typeof ack === "function") ack({ success: false, error: errorMsg });
            return;
          }

          const target = await prisma.participant.findFirst({
            where: { id: participantId, roomId: session.roomId },
          });

          if (!target) {
            const errorMsg = "Target participant no longer exists in this room";
            if (typeof ack === "function") ack({ success: false, error: errorMsg });
            return;
          }

          const roomChannel = getRoomChannel(session.roomCode);

          if (action === "APPROVE") {
            // Apply role promotion in PostgreSQL
            await prisma.participant.update({
              where: { id: target.id },
              data: { role: "MODERATOR" },
            });

            // Authoritative roster broadcast
            const roster = await getSafeRoster(session.roomId);
            io.to(roomChannel).emit("room:roster", { participants: roster });

            // Broadcast role resolution
            io.to(roomChannel).emit("role:request-resolved", {
              requestId,
              participantId: target.id,
              displayName: target.displayName,
              status: "APPROVED",
              role: "MODERATOR",
            });

            io.to(roomChannel).emit("room:notice", {
              message: `${target.displayName} was promoted to Moderator by the Host`,
            });

            if (typeof ack === "function") ack({ success: true, status: "APPROVED" });
          } else {
            // Rejection
            io.to(roomChannel).emit("role:request-resolved", {
              requestId,
              participantId: target.id,
              displayName: target.displayName,
              status: "REJECTED",
            });

            if (typeof ack === "function") ack({ success: true, status: "REJECTED" });
          }
        } catch (err: any) {
          console.error("[role:resolve-request Error]:", err);
          if (typeof ack === "function") ack({ success: false, error: "Failed to resolve role request" });
        }
      }
    );

    // Event: Abrupt disconnect (browser closed, network drop, etc.)
    socket.on("disconnect", async (_reason: string) => {
      try {
        if (!session.joinedRoom) {
          return;
        }

        const roomChannel = getRoomChannel(session.roomCode);
        const removed = socketRegistry.removeSocket(socket.id);

        // Only mark disconnected and broadcast if this was the last active socket for this participant
        if (removed && removed.isLastSocket) {
          try {
            await prisma.participant.update({
              where: { id: session.participantId },
              data: { isConnected: false, lastActiveAt: new Date() },
            });
          } catch {
            // Participant might have been deleted via REST
          }

          // Notify room members
          io.to(roomChannel).emit("room:participant-left", {
            participantId: session.participantId,
            displayName: session.displayName,
          });

          // Broadcast updated roster to room
          const roster = await getSafeRoster(session.roomId);
          io.to(roomChannel).emit("room:roster", { participants: roster });
        }
      } catch (error) {
        console.error("[Socket disconnect Error]:", error);
      }
    });
  });
}

/**
 * Handles real-time cleanup and notification when a participant is removed via REST API.
 * Disconnects any active Socket.IO connections held by the removed participant and notifies room members.
 */
export async function handleParticipantRemoved(
  participantId: string,
  roomCode: string,
  displayName: string,
  roomId: string
): Promise<void> {
  if (!ioInstance) return;

  const roomChannel = getRoomChannel(roomCode);
  const socketIds = socketRegistry.clearParticipant(participantId);

  // Terminate any active socket connections for the removed participant
  for (const socketId of socketIds) {
    const activeSocket = ioInstance.sockets.sockets.get(socketId);
    if (activeSocket) {
      activeSocket.emit("room:kicked", {
        reason: "You have been removed from the room by the host",
      });
      activeSocket.leave(roomChannel);
      activeSocket.disconnect(true);
    }
  }

  // Notify other room members
  ioInstance.to(roomChannel).emit("room:participant-left", {
    participantId,
    displayName,
  });

  // Broadcast updated roster
  const roster = await getSafeRoster(roomId);
  ioInstance.to(roomChannel).emit("room:roster", { participants: roster });
}

/**
 * Broadcasts an updated safe participant roster to all members of a room.
 * Invoked when participant roles are updated via REST API.
 */
export async function broadcastRosterUpdate(
  roomCode: string,
  roomId: string
): Promise<void> {
  if (!ioInstance) return;

  const roomChannel = getRoomChannel(roomCode);
  const roster = await getSafeRoster(roomId);
  ioInstance.to(roomChannel).emit("room:roster", { participants: roster });
}

/**
 * Broadcasts a host ownership transfer event and updated roster to all members of a room.
 */
export async function broadcastHostTransfer(
  roomCode: string,
  roomId: string,
  previousHostId: string,
  newHostId: string,
  newHostDisplayName: string
): Promise<void> {
  if (!ioInstance) return;

  const roomChannel = getRoomChannel(roomCode);
  ioInstance.to(roomChannel).emit("room:host-transferred", {
    previousHostId,
    newHostId,
    newHostDisplayName,
  });

  const roster = await getSafeRoster(roomId);
  ioInstance.to(roomChannel).emit("room:roster", { participants: roster });
}

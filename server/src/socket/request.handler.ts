import type { Server as SocketIOServer, Socket } from "socket.io";
import { RequestType, RequestStatus } from "@prisma/client";
import { prisma } from "../config/prisma.js";
import { getRoomChannel, type SocketSessionData } from "./room.handler.js";
import {
  toSafeControlRequest,
  toSafePlaybackState,
  computeCurrentPlaybackTimestamp,
  type SafeControlRequest,
  type SafePlaybackState,
} from "./playback.types.js";
import {
  extractYouTubeVideoId,
  isValidTimestamp,
} from "../utils/youtube.js";

/**
 * Validates that the participant still exists and has HOST or MODERATOR role.
 */
async function verifyHostOrModerator(
  session: SocketSessionData
): Promise<{
  authorized: boolean;
  error?: string;
  code?: string;
  participant?: any;
  room?: any;
}> {
  if (!session.joinedRoom) {
    return {
      authorized: false,
      error: "Unauthorized: Must join authorized room before resolving control requests",
      code: "UNAUTHORIZED",
    };
  }

  const participant = await prisma.participant.findUnique({
    where: { id: session.participantId },
    include: { room: true },
  });

  if (!participant || participant.roomId !== session.roomId) {
    return {
      authorized: false,
      error: "Participant session no longer exists in this room",
      code: "SESSION_EXPIRED",
    };
  }

  if (participant.role !== "HOST" && participant.role !== "MODERATOR") {
    return {
      authorized: false,
      error: "Forbidden: Only the Room Host or a Moderator can approve or reject control requests",
      code: "FORBIDDEN",
    };
  }

  return {
    authorized: true,
    participant,
    room: participant.room,
  };
}

/**
 * Registers all Participant Control Request event handlers on a socket.
 */
export function registerRequestHandlers(socket: Socket, io: SocketIOServer): void {
  const session = socket.data as SocketSessionData;

  // 1. Submit Control Request (Available to all room participants)
  socket.on(
    "request:create",
    async (
      payload?: {
        type?: string;
        targetTimestamp?: number;
        targetVideoId?: string;
      },
      ack?: (res: { success: boolean; request?: SafeControlRequest; error?: string }) => void
    ) => {
      try {
        if (!session.joinedRoom) {
          const errorMsg = "Must join authorized room before submitting control requests";
          if (typeof ack === "function") ack({ success: false, error: errorMsg });
          socket.emit("error", { message: errorMsg, code: "UNAUTHORIZED" });
          return;
        }

        const participant = await prisma.participant.findUnique({
          where: { id: session.participantId },
          include: { room: true },
        });

        if (!participant || participant.roomId !== session.roomId) {
          const errorMsg = "Participant session no longer exists in this room";
          if (typeof ack === "function") ack({ success: false, error: errorMsg });
          socket.emit("error", { message: errorMsg, code: "SESSION_EXPIRED" });
          return;
        }

        const room = participant.room;

        // Validate request type
        const typeStr = payload?.type?.trim().toUpperCase();
        if (
          !typeStr ||
          !Object.values(RequestType).includes(typeStr as RequestType)
        ) {
          const errorMsg = "Invalid request type. Must be one of: PLAY, PAUSE, SEEK, CHANGE_VIDEO";
          if (typeof ack === "function") ack({ success: false, error: errorMsg });
          socket.emit("error", { message: errorMsg, code: "INVALID_REQUEST_TYPE" });
          return;
        }

        const requestType = typeStr as RequestType;
        let validatedTimestamp: number | null = null;
        let validatedVideoId: string | null = null;

        if (requestType === RequestType.CHANGE_VIDEO) {
          const parsedId = extractYouTubeVideoId(payload?.targetVideoId);
          if (!parsedId) {
            const errorMsg = "Invalid target video ID or URL for CHANGE_VIDEO request";
            if (typeof ack === "function") ack({ success: false, error: errorMsg });
            socket.emit("error", { message: errorMsg, code: "INVALID_VIDEO_ID" });
            return;
          }
          validatedVideoId = parsedId;
        } else {
          // PLAY, PAUSE, SEEK require an active video in the room
          if (!room.currentVideoId) {
            const errorMsg = "No video selected in this room. Cannot request playback actions until a video is chosen.";
            if (typeof ack === "function") ack({ success: false, error: errorMsg });
            socket.emit("error", { message: errorMsg, code: "NO_VIDEO_SELECTED" });
            return;
          }

          if (requestType === RequestType.SEEK) {
            if (
              payload?.targetTimestamp === undefined ||
              !isValidTimestamp(payload.targetTimestamp)
            ) {
              const errorMsg = "Invalid target timestamp for SEEK request: must be a non-negative finite number";
              if (typeof ack === "function") ack({ success: false, error: errorMsg });
              socket.emit("error", { message: errorMsg, code: "INVALID_TIMESTAMP" });
              return;
            }
            validatedTimestamp = payload.targetTimestamp;
          }
        }

        // Persist new control request with PENDING status
        const created = await prisma.controlRequest.create({
          data: {
            roomId: session.roomId,
            participantId: session.participantId,
            type: requestType,
            targetTimestamp: validatedTimestamp,
            targetVideoId: validatedVideoId,
            status: RequestStatus.PENDING,
          },
          include: {
            participant: {
              select: { id: true, displayName: true, role: true },
            },
          },
        });

        const safeRequest = toSafeControlRequest(created);
        const roomChannel = getRoomChannel(session.roomCode);

        // Notify room members that a new request has been submitted
        io.to(roomChannel).emit("request:created", { request: safeRequest });

        if (typeof ack === "function") {
          ack({ success: true, request: safeRequest });
        }
      } catch (error) {
        console.error("[request:create Error]:", error);
        if (typeof ack === "function") {
          ack({ success: false, error: "Failed to create control request" });
        }
      }
    }
  );

  // 2. List Control Requests (Pending or all)
  socket.on(
    "request:list",
    async (
      payload?: { status?: string },
      ack?: (res: { success: boolean; requests?: SafeControlRequest[]; error?: string }) => void
    ) => {
      try {
        if (!session.joinedRoom) {
          const errorMsg = "Must join authorized room before listing requests";
          if (typeof ack === "function") ack({ success: false, error: errorMsg });
          socket.emit("error", { message: errorMsg, code: "UNAUTHORIZED" });
          return;
        }

        let statusFilter: RequestStatus | undefined;
        if (payload?.status) {
          const upper = payload.status.trim().toUpperCase();
          if (Object.values(RequestStatus).includes(upper as RequestStatus)) {
            statusFilter = upper as RequestStatus;
          }
        }

        const requests = await prisma.controlRequest.findMany({
          where: {
            roomId: session.roomId,
            ...(statusFilter ? { status: statusFilter } : {}),
          },
          include: {
            participant: {
              select: { id: true, displayName: true, role: true },
            },
          },
          orderBy: { createdAt: "desc" },
          take: 50,
        });

        const safeRequests = requests.map(toSafeControlRequest);

        if (typeof ack === "function") {
          ack({ success: true, requests: safeRequests });
        } else {
          socket.emit("request:list", { requests: safeRequests });
        }
      } catch (error) {
        console.error("[request:list Error]:", error);
        if (typeof ack === "function") {
          ack({ success: false, error: "Failed to retrieve control requests" });
        }
      }
    }
  );

  // Helper function to resolve (approve or reject) a request
  async function resolveRequest(
    requestId: string,
    action: "APPROVE" | "REJECT",
    ack?: (res: {
      success: boolean;
      request?: SafeControlRequest;
      state?: SafePlaybackState;
      error?: string;
    }) => void
  ) {
    try {
      const authCheck = await verifyHostOrModerator(session);
      if (!authCheck.authorized) {
        if (typeof ack === "function") ack({ success: false, error: authCheck.error });
        socket.emit("error", { message: authCheck.error, code: authCheck.code });
        return;
      }

      if (!requestId || typeof requestId !== "string") {
        const errorMsg = "A valid requestId string is required";
        if (typeof ack === "function") ack({ success: false, error: errorMsg });
        socket.emit("error", { message: errorMsg, code: "INVALID_REQUEST_ID" });
        return;
      }

      // Check current request state
      const targetReq = await prisma.controlRequest.findUnique({
        where: { id: requestId },
        include: { room: true },
      });

      if (!targetReq || targetReq.roomId !== session.roomId) {
        const errorMsg = "Control request not found in this room";
        if (typeof ack === "function") ack({ success: false, error: errorMsg });
        socket.emit("error", { message: errorMsg, code: "REQUEST_NOT_FOUND" });
        return;
      }

      if (targetReq.status !== RequestStatus.PENDING) {
        const errorMsg = `Control request has already been resolved with status "${targetReq.status}"`;
        if (typeof ack === "function") ack({ success: false, error: errorMsg });
        socket.emit("error", { message: errorMsg, code: "ALREADY_RESOLVED" });
        return;
      }

      const room = targetReq.room;
      const roomChannel = getRoomChannel(session.roomCode);

      if (action === "REJECT") {
        // Atomic status update to REJECTED (guarantees exactly-once resolution)
        const updated = await prisma.controlRequest.updateMany({
          where: { id: requestId, status: RequestStatus.PENDING },
          data: { status: RequestStatus.REJECTED, resolvedAt: new Date() },
        });

        if (updated.count === 0) {
          const errorMsg = "Control request was already resolved by another moderator";
          if (typeof ack === "function") ack({ success: false, error: errorMsg });
          socket.emit("error", { message: errorMsg, code: "ALREADY_RESOLVED" });
          return;
        }

        const resolvedReq = await prisma.controlRequest.findUnique({
          where: { id: requestId },
          include: {
            participant: {
              select: { id: true, displayName: true, role: true },
            },
          },
        });

        const safeReq = toSafeControlRequest(resolvedReq!);
        io.to(roomChannel).emit("request:resolved", { request: safeReq });

        if (typeof ack === "function") {
          ack({ success: true, request: safeReq });
        }
        return;
      }

      // Action === "APPROVE"
      // Re-validate request parameters against authoritative room playback rules
      let roomUpdateData: any = {};
      const now = new Date();

      switch (targetReq.type) {
        case RequestType.CHANGE_VIDEO: {
          if (!targetReq.targetVideoId) {
            const errorMsg = "Cannot approve CHANGE_VIDEO: missing target video ID";
            if (typeof ack === "function") ack({ success: false, error: errorMsg });
            socket.emit("error", { message: errorMsg, code: "INVALID_REQUEST_PAYLOAD" });
            return;
          }
          roomUpdateData = {
            currentVideoId: targetReq.targetVideoId,
            currentTimestamp: 0.0,
            isPlaying: false,
            playbackRate: 1.0,
            lastSyncAt: now,
          };
          break;
        }

        case RequestType.PLAY: {
          if (!room.currentVideoId) {
            const errorMsg = "Cannot approve PLAY: no video selected in room";
            if (typeof ack === "function") ack({ success: false, error: errorMsg });
            socket.emit("error", { message: errorMsg, code: "NO_VIDEO_SELECTED" });
            return;
          }
          const currentTimestamp = computeCurrentPlaybackTimestamp(
            room.currentTimestamp,
            room.isPlaying,
            room.playbackRate,
            room.lastSyncAt
          );
          roomUpdateData = {
            isPlaying: true,
            currentTimestamp,
            lastSyncAt: now,
          };
          break;
        }

        case RequestType.PAUSE: {
          if (!room.currentVideoId) {
            const errorMsg = "Cannot approve PAUSE: no video selected in room";
            if (typeof ack === "function") ack({ success: false, error: errorMsg });
            socket.emit("error", { message: errorMsg, code: "NO_VIDEO_SELECTED" });
            return;
          }
          const currentTimestamp = computeCurrentPlaybackTimestamp(
            room.currentTimestamp,
            room.isPlaying,
            room.playbackRate,
            room.lastSyncAt
          );
          roomUpdateData = {
            isPlaying: false,
            currentTimestamp,
            lastSyncAt: now,
          };
          break;
        }

        case RequestType.SEEK: {
          if (!room.currentVideoId) {
            const errorMsg = "Cannot approve SEEK: no video selected in room";
            if (typeof ack === "function") ack({ success: false, error: errorMsg });
            socket.emit("error", { message: errorMsg, code: "NO_VIDEO_SELECTED" });
            return;
          }
          if (
            targetReq.targetTimestamp === null ||
            !isValidTimestamp(targetReq.targetTimestamp)
          ) {
            const errorMsg = "Cannot approve SEEK: invalid target timestamp";
            if (typeof ack === "function") ack({ success: false, error: errorMsg });
            socket.emit("error", { message: errorMsg, code: "INVALID_TIMESTAMP" });
            return;
          }
          roomUpdateData = {
            currentTimestamp: targetReq.targetTimestamp,
            lastSyncAt: now,
          };
          break;
        }
      }

      // Execute request approval and room state update atomically in a transaction
      const [resolvedReq, updatedRoom] = await prisma.$transaction(async (tx) => {
        // Atomic status transition check
        const updateCount = await tx.controlRequest.updateMany({
          where: { id: requestId, status: RequestStatus.PENDING },
          data: { status: RequestStatus.APPROVED, resolvedAt: now },
        });

        if (updateCount.count === 0) {
          throw new Error("ALREADY_RESOLVED");
        }

        const roomResult = await tx.room.update({
          where: { id: session.roomId },
          data: roomUpdateData,
        });

        const reqResult = await tx.controlRequest.findUnique({
          where: { id: requestId },
          include: {
            participant: {
              select: { id: true, displayName: true, role: true },
            },
          },
        });

        return [reqResult!, roomResult];
      });

      const safeReq = toSafeControlRequest(resolvedReq);
      const safeState = toSafePlaybackState(updatedRoom);

      // Broadcast resolution and updated playback state to room
      io.to(roomChannel).emit("request:resolved", { request: safeReq });
      io.to(roomChannel).emit("playback:state", { state: safeState });

      if (typeof ack === "function") {
        ack({ success: true, request: safeReq, state: safeState });
      }
    } catch (error: any) {
      if (error?.message === "ALREADY_RESOLVED") {
        const errorMsg = "Control request was already resolved by another moderator";
        if (typeof ack === "function") ack({ success: false, error: errorMsg });
        socket.emit("error", { message: errorMsg, code: "ALREADY_RESOLVED" });
        return;
      }
      console.error("[resolveRequest Error]:", error);
      if (typeof ack === "function") {
        ack({ success: false, error: "Failed to resolve control request" });
      }
    }
  }

  // 3. Resolve Request (Generic: APPROVE or REJECT)
  socket.on(
    "request:resolve",
    async (
      payload?: { requestId?: string; action?: "APPROVE" | "REJECT" },
      ack?: (res: {
        success: boolean;
        request?: SafeControlRequest;
        state?: SafePlaybackState;
        error?: string;
      }) => void
    ) => {
      const action = payload?.action?.toUpperCase() as "APPROVE" | "REJECT";
      if (action !== "APPROVE" && action !== "REJECT") {
        const errorMsg = "Invalid resolution action: must be 'APPROVE' or 'REJECT'";
        if (typeof ack === "function") ack({ success: false, error: errorMsg });
        socket.emit("error", { message: errorMsg, code: "INVALID_ACTION" });
        return;
      }
      await resolveRequest(payload?.requestId || "", action, ack);
    }
  );

  // 4. Convenience alias: request:approve
  socket.on(
    "request:approve",
    async (
      payload?: { requestId?: string },
      ack?: (res: {
        success: boolean;
        request?: SafeControlRequest;
        state?: SafePlaybackState;
        error?: string;
      }) => void
    ) => {
      await resolveRequest(payload?.requestId || "", "APPROVE", ack);
    }
  );

  // 5. Convenience alias: request:reject
  socket.on(
    "request:reject",
    async (
      payload?: { requestId?: string },
      ack?: (res: {
        success: boolean;
        request?: SafeControlRequest;
        state?: SafePlaybackState;
        error?: string;
      }) => void
    ) => {
      await resolveRequest(payload?.requestId || "", "REJECT", ack);
    }
  );
}

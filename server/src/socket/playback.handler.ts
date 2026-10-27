import type { Server as SocketIOServer, Socket } from "socket.io";
import { prisma } from "../config/prisma.js";
import { getRoomChannel, type SocketSessionData } from "./room.handler.js";
import {
  toSafePlaybackState,
  computeCurrentPlaybackTimestamp,
  type SafePlaybackState,
} from "./playback.types.js";
import {
  extractYouTubeVideoId,
  isValidTimestamp,
  isValidPlaybackRate,
} from "../utils/youtube.js";

/**
 * Validates that the calling socket belongs to a joined room and possesses HOST or MODERATOR role.
 * Queries PostgreSQL dynamically to guarantee fresh, authoritative role state.
 * Includes transient retry logic for Neon serverless cold-start connection drops (P1001 / P1017).
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
      error: "Unauthorized: Must join authorized room before executing playback commands",
      code: "UNAUTHORIZED",
    };
  }

  // Retry up to 3 times on transient Neon serverless connection drops
  let participant: any = null;
  let attempts = 0;
  while (attempts < 3) {
    try {
      participant = await prisma.participant.findUnique({
        where: { id: session.participantId },
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
      error:
        "Forbidden: Only the Room Host or a Moderator can control playback directly. Participants must submit a control request.",
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
 * Registers all authoritative playback command handlers on an authenticated Socket.IO socket.
 */
export function registerPlaybackHandlers(socket: Socket, io: SocketIOServer): void {
  const session = socket.data as SocketSessionData;

  // 1. Play Video
  socket.on(
    "playback:play",
    async (
      payload?: { timestamp?: number; playbackRate?: number; syncToken?: string },
      ack?: (res: { success: boolean; state?: SafePlaybackState; error?: string }) => void
    ) => {
      try {
        const authCheck = await verifyHostOrModerator(session);
        if (!authCheck.authorized) {
          if (typeof ack === "function") ack({ success: false, error: authCheck.error });
          socket.emit("error", { message: authCheck.error, code: authCheck.code });
          return;
        }

        const room = authCheck.room;

        // A newly created or empty room cannot play without a selected video
        if (!room.currentVideoId) {
          const errorMsg = "No video selected. Change video before starting playback.";
          if (typeof ack === "function") ack({ success: false, error: errorMsg });
          socket.emit("error", { message: errorMsg, code: "NO_VIDEO_SELECTED" });
          return;
        }

        // Validate optional timestamp
        let newTimestamp: number;
        if (payload?.timestamp !== undefined) {
          if (!isValidTimestamp(payload.timestamp)) {
            const errorMsg = "Invalid playback timestamp: must be a non-negative finite number";
            if (typeof ack === "function") ack({ success: false, error: errorMsg });
            socket.emit("error", { message: errorMsg, code: "INVALID_TIMESTAMP" });
            return;
          }
          newTimestamp = payload.timestamp;
        } else {
          newTimestamp = computeCurrentPlaybackTimestamp(
            room.currentTimestamp,
            room.isPlaying,
            room.playbackRate,
            room.lastSyncAt
          );
        }

        // Validate optional playback rate
        let newRate = room.playbackRate;
        if (payload?.playbackRate !== undefined) {
          if (!isValidPlaybackRate(payload.playbackRate)) {
            const errorMsg = "Invalid playback rate: must be one of [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2]";
            if (typeof ack === "function") ack({ success: false, error: errorMsg });
            socket.emit("error", { message: errorMsg, code: "INVALID_PLAYBACK_RATE" });
            return;
          }
          newRate = payload.playbackRate;
        }

        // Echo loop prevention: if already playing at this exact timestamp/rate, skip redundant DB write
        if (room.isPlaying && payload?.timestamp === undefined && newRate === room.playbackRate) {
          const currentState = toSafePlaybackState(room, payload?.syncToken);
          if (typeof ack === "function") ack({ success: true, state: currentState });
          return;
        }

        const now = new Date();
        const updatedRoom = await prisma.room.update({
          where: { id: room.id },
          data: {
            isPlaying: true,
            currentTimestamp: newTimestamp,
            playbackRate: newRate,
            lastSyncAt: now,
          },
        });

        const safeState = toSafePlaybackState(updatedRoom, payload?.syncToken);
        const roomChannel = getRoomChannel(session.roomCode);

        // Broadcast authoritative playback state to all participants in this room
        io.to(roomChannel).emit("playback:state", { state: safeState });

        if (typeof ack === "function") {
          ack({ success: true, state: safeState });
        }
      } catch (error) {
        console.error("[playback:play Error]:", error);
        if (typeof ack === "function") {
          ack({ success: false, error: "Internal error processing play command" });
        }
      }
    }
  );

  // 2. Pause Video
  socket.on(
    "playback:pause",
    async (
      payload?: { timestamp?: number; syncToken?: string },
      ack?: (res: { success: boolean; state?: SafePlaybackState; error?: string }) => void
    ) => {
      try {
        const authCheck = await verifyHostOrModerator(session);
        if (!authCheck.authorized) {
          if (typeof ack === "function") ack({ success: false, error: authCheck.error });
          socket.emit("error", { message: authCheck.error, code: authCheck.code });
          return;
        }

        const room = authCheck.room;

        if (!room.currentVideoId) {
          const errorMsg = "No video selected. Cannot pause without an active video.";
          if (typeof ack === "function") ack({ success: false, error: errorMsg });
          socket.emit("error", { message: errorMsg, code: "NO_VIDEO_SELECTED" });
          return;
        }

        let pauseTimestamp: number;
        if (payload?.timestamp !== undefined) {
          if (!isValidTimestamp(payload.timestamp)) {
            const errorMsg = "Invalid pause timestamp: must be a non-negative finite number";
            if (typeof ack === "function") ack({ success: false, error: errorMsg });
            socket.emit("error", { message: errorMsg, code: "INVALID_TIMESTAMP" });
            return;
          }
          pauseTimestamp = payload.timestamp;
        } else {
          pauseTimestamp = computeCurrentPlaybackTimestamp(
            room.currentTimestamp,
            room.isPlaying,
            room.playbackRate,
            room.lastSyncAt
          );
        }

        // Echo loop prevention: if already paused with matching timestamp, skip redundant write
        if (!room.isPlaying && payload?.timestamp === undefined) {
          const currentState = toSafePlaybackState(room, payload?.syncToken);
          if (typeof ack === "function") ack({ success: true, state: currentState });
          return;
        }

        const now = new Date();
        const updatedRoom = await prisma.room.update({
          where: { id: room.id },
          data: {
            isPlaying: false,
            currentTimestamp: pauseTimestamp,
            lastSyncAt: now,
          },
        });

        const safeState = toSafePlaybackState(updatedRoom, payload?.syncToken);
        const roomChannel = getRoomChannel(session.roomCode);

        // Broadcast authoritative pause state to room members
        io.to(roomChannel).emit("playback:state", { state: safeState });

        if (typeof ack === "function") {
          ack({ success: true, state: safeState });
        }
      } catch (error) {
        console.error("[playback:pause Error]:", error);
        if (typeof ack === "function") {
          ack({ success: false, error: "Internal error processing pause command" });
        }
      }
    }
  );

  // 3. Seek Video
  socket.on(
    "playback:seek",
    async (
      payload?: { timestamp?: number; syncToken?: string },
      ack?: (res: { success: boolean; state?: SafePlaybackState; error?: string }) => void
    ) => {
      try {
        const authCheck = await verifyHostOrModerator(session);
        if (!authCheck.authorized) {
          if (typeof ack === "function") ack({ success: false, error: authCheck.error });
          socket.emit("error", { message: authCheck.error, code: authCheck.code });
          return;
        }

        const room = authCheck.room;

        if (!room.currentVideoId) {
          const errorMsg = "No video selected. Cannot seek without an active video.";
          if (typeof ack === "function") ack({ success: false, error: errorMsg });
          socket.emit("error", { message: errorMsg, code: "NO_VIDEO_SELECTED" });
          return;
        }

        if (payload?.timestamp === undefined || !isValidTimestamp(payload.timestamp)) {
          const errorMsg = "Invalid seek timestamp: must be a non-negative finite number";
          if (typeof ack === "function") ack({ success: false, error: errorMsg });
          socket.emit("error", { message: errorMsg, code: "INVALID_TIMESTAMP" });
          return;
        }

        const now = new Date();
        const updatedRoom = await prisma.room.update({
          where: { id: room.id },
          data: {
            currentTimestamp: payload.timestamp,
            lastSyncAt: now,
          },
        });

        const safeState = toSafePlaybackState(updatedRoom, payload?.syncToken);
        const roomChannel = getRoomChannel(session.roomCode);

        // Broadcast seek state to room members
        io.to(roomChannel).emit("playback:state", { state: safeState });

        if (typeof ack === "function") {
          ack({ success: true, state: safeState });
        }
      } catch (error) {
        console.error("[playback:seek Error]:", error);
        if (typeof ack === "function") {
          ack({ success: false, error: "Internal error processing seek command" });
        }
      }
    }
  );

  // 4. Change Video
  socket.on(
    "playback:change-video",
    async (
      payload?: { videoId?: string; syncToken?: string },
      ack?: (res: { success: boolean; state?: SafePlaybackState; error?: string }) => void
    ) => {
      try {
        const authCheck = await verifyHostOrModerator(session);
        if (!authCheck.authorized) {
          if (typeof ack === "function") ack({ success: false, error: authCheck.error });
          socket.emit("error", { message: authCheck.error, code: authCheck.code });
          return;
        }

        const room = authCheck.room;

        const parsedVideoId = extractYouTubeVideoId(payload?.videoId);
        if (!parsedVideoId) {
          const errorMsg =
            "Invalid YouTube video ID or URL. Provide a valid 11-character video ID or YouTube URL.";
          if (typeof ack === "function") ack({ success: false, error: errorMsg });
          socket.emit("error", { message: errorMsg, code: "INVALID_VIDEO_ID" });
          return;
        }

        const now = new Date();
        const updatedRoom = await prisma.room.update({
          where: { id: room.id },
          data: {
            currentVideoId: parsedVideoId,
            currentTimestamp: 0.0,
            isPlaying: false, // Default to paused at beginning of newly loaded video
            playbackRate: 1.0,
            lastSyncAt: now,
          },
        });

        const safeState = toSafePlaybackState(updatedRoom, payload?.syncToken);
        const roomChannel = getRoomChannel(session.roomCode);

        // Broadcast newly selected video to all participants
        io.to(roomChannel).emit("playback:state", { state: safeState });

        if (typeof ack === "function") {
          ack({ success: true, state: safeState });
        }
      } catch (error) {
        console.error("[playback:change-video Error]:", error);
        if (typeof ack === "function") {
          ack({ success: false, error: "Internal error processing change video command" });
        }
      }
    }
  );

  // 5. Set Playback Rate
  socket.on(
    "playback:set-rate",
    async (
      payload?: { playbackRate?: number; syncToken?: string },
      ack?: (res: { success: boolean; state?: SafePlaybackState; error?: string }) => void
    ) => {
      try {
        const authCheck = await verifyHostOrModerator(session);
        if (!authCheck.authorized) {
          if (typeof ack === "function") ack({ success: false, error: authCheck.error });
          socket.emit("error", { message: authCheck.error, code: authCheck.code });
          return;
        }

        const room = authCheck.room;

        if (payload?.playbackRate === undefined || !isValidPlaybackRate(payload.playbackRate)) {
          const errorMsg =
            "Invalid playback rate: must be one of [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2]";
          if (typeof ack === "function") ack({ success: false, error: errorMsg });
          socket.emit("error", { message: errorMsg, code: "INVALID_PLAYBACK_RATE" });
          return;
        }

        const currentTimestamp = computeCurrentPlaybackTimestamp(
          room.currentTimestamp,
          room.isPlaying,
          room.playbackRate,
          room.lastSyncAt
        );

        const now = new Date();
        const updatedRoom = await prisma.room.update({
          where: { id: room.id },
          data: {
            playbackRate: payload.playbackRate,
            currentTimestamp,
            lastSyncAt: now,
          },
        });

        const safeState = toSafePlaybackState(updatedRoom, payload?.syncToken);
        const roomChannel = getRoomChannel(session.roomCode);

        io.to(roomChannel).emit("playback:state", { state: safeState });

        if (typeof ack === "function") {
          ack({ success: true, state: safeState });
        }
      } catch (error) {
        console.error("[playback:set-rate Error]:", error);
        if (typeof ack === "function") {
          ack({ success: false, error: "Internal error processing playback rate command" });
        }
      }
    }
  );

  // 6. Get Current Playback State (Available to all authorized room participants)
  socket.on(
    "playback:get-state",
    async (
      _payload: unknown,
      ack?: (res: { success: boolean; state?: SafePlaybackState; error?: string }) => void
    ) => {
      try {
        if (!session.joinedRoom) {
          const errorMsg = "Must join authorized room before requesting playback state";
          if (typeof ack === "function") ack({ success: false, error: errorMsg });
          socket.emit("error", { message: errorMsg, code: "UNAUTHORIZED" });
          return;
        }

        const room = await prisma.room.findUnique({
          where: { id: session.roomId },
        });

        if (!room) {
          const errorMsg = "Room not found";
          if (typeof ack === "function") ack({ success: false, error: errorMsg });
          socket.emit("error", { message: errorMsg, code: "ROOM_NOT_FOUND" });
          return;
        }

        const safeState = toSafePlaybackState(room);

        if (typeof ack === "function") {
          ack({ success: true, state: safeState });
        } else {
          socket.emit("playback:state", { state: safeState });
        }
      } catch (error) {
        console.error("[playback:get-state Error]:", error);
        if (typeof ack === "function") {
          ack({ success: false, error: "Failed to retrieve playback state" });
        }
      }
    }
  );
}

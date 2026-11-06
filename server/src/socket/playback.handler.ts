import type { Server as SocketIOServer, Socket } from "socket.io";
import { prisma } from "../config/prisma.js";
import { getRoomChannel, type SocketSessionData } from "./room.handler.js";
import {
  toSafePlaybackState,
  computeCurrentPlaybackTimestamp,
  type SafePlaybackState,
  type PlaybackMetadata,
} from "./playback.types.js";
import {
  extractYouTubeVideoId,
  isValidTimestamp,
  isValidPlaybackRate,
} from "../utils/youtube.js";
import {
  advanceQueueOnVideoEnd,
  type SafeQueueItem,
} from "../services/queue.service.js";
import { fetchVideoDetails } from "../services/youtube.service.js";

/** In-memory cache for room video metadata (title, channel, duration, thumbnail) */
const roomMetadataCache = new Map<string, PlaybackMetadata>();

export function getRoomPlaybackMetadata(roomId: string): PlaybackMetadata | null {
  return roomMetadataCache.get(roomId) || null;
}

export function setRoomPlaybackMetadata(roomId: string, metadata: Partial<PlaybackMetadata>): void {
  const existing = roomMetadataCache.get(roomId) || {};
  roomMetadataCache.set(roomId, { ...existing, ...metadata });
}

/**
 * Validates that the calling socket belongs to a joined room and possesses HOST or MODERATOR role.
 * Queries PostgreSQL dynamically to guarantee fresh, authoritative role state.
 * Includes transient retry logic for Neon serverless cold-start connection drops (P1001 / P1017).
 */
export async function verifyHostOrModerator(
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
          const currentState = toSafePlaybackState(room, payload?.syncToken, roomMetadataCache.get(session.roomId));
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

        const safeState = toSafePlaybackState(updatedRoom, payload?.syncToken, roomMetadataCache.get(session.roomId));
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
          const currentState = toSafePlaybackState(room, payload?.syncToken, roomMetadataCache.get(session.roomId));
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

        const safeState = toSafePlaybackState(updatedRoom, payload?.syncToken, roomMetadataCache.get(session.roomId));
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

        const safeState = toSafePlaybackState(updatedRoom, payload?.syncToken, roomMetadataCache.get(session.roomId));
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
      payload?: {
        videoId?: string;
        syncToken?: string;
        autoPlay?: boolean;
        title?: string;
        channelTitle?: string;
        thumbnailUrl?: string;
        durationSec?: number;
      },
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

        const shouldAutoPlay = payload?.autoPlay === true;
        const now = new Date();
        const updatedRoom = await prisma.room.update({
          where: { id: room.id },
          data: {
            currentVideoId: parsedVideoId,
            currentTimestamp: 0.0,
            isPlaying: shouldAutoPlay,
            playbackRate: 1.0,
            lastSyncAt: now,
          },
        });

        const initialMeta: PlaybackMetadata = {
          videoTitle: payload?.title || null,
          channelTitle: payload?.channelTitle || null,
          thumbnailUrl: payload?.thumbnailUrl || `https://img.youtube.com/vi/${parsedVideoId}/mqdefault.jpg`,
          durationSec: typeof payload?.durationSec === "number" && payload.durationSec > 0 ? payload.durationSec : 0,
        };
        roomMetadataCache.set(session.roomId, initialMeta);

        const safeState = toSafePlaybackState(updatedRoom, payload?.syncToken, initialMeta);
        const roomChannel = getRoomChannel(session.roomCode);

        // Broadcast newly selected video to all participants
        io.to(roomChannel).emit("playback:state", { state: safeState });

        if (typeof ack === "function") {
          ack({ success: true, state: safeState });
        }

        // Asynchronously resolve full details in background if title/duration were missing
        if (!initialMeta.videoTitle || !initialMeta.durationSec) {
          fetchVideoDetails(parsedVideoId).then((details) => {
            if (details) {
              const currentMeta = roomMetadataCache.get(session.roomId) || {};
              const enriched: PlaybackMetadata = {
                videoTitle: currentMeta.videoTitle || details.title,
                channelTitle: currentMeta.channelTitle || details.channelTitle,
                thumbnailUrl: currentMeta.thumbnailUrl || details.thumbnailUrl,
                durationSec: currentMeta.durationSec || details.durationSec,
              };
              roomMetadataCache.set(session.roomId, enriched);

              prisma.room.findUnique({ where: { id: session.roomId } }).then((freshRoom) => {
                if (freshRoom && freshRoom.currentVideoId === parsedVideoId) {
                  const stateWithDetails = toSafePlaybackState(freshRoom, undefined, enriched);
                  io.to(roomChannel).emit("playback:state", { state: stateWithDetails });
                }
              }).catch(() => {});
            }
          }).catch(() => {});
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

        const safeState = toSafePlaybackState(updatedRoom, payload?.syncToken, roomMetadataCache.get(session.roomId));
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

        const safeState = toSafePlaybackState(room, undefined, roomMetadataCache.get(session.roomId));

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

  // 7. Video Ended / Auto-Advance (Client reports current video completed playback)
  socket.on(
    "playback:ended",
    async (
      payload?: { videoId?: string },
      ack?: (res: {
        success: boolean;
        advanced?: boolean;
        emptyQueue?: boolean;
        reason?: string;
        state?: SafePlaybackState;
        queue?: SafeQueueItem[];
        error?: string;
      }) => void
    ) => {
      try {
        if (!session.joinedRoom) {
          const errorMsg = "Must join authorized room before emitting playback:ended";
          if (typeof ack === "function") ack({ success: false, error: errorMsg });
          socket.emit("error", { message: errorMsg, code: "UNAUTHORIZED" });
          return;
        }

        const endedVideoId = typeof payload?.videoId === "string" ? payload.videoId.trim() : "";
        if (!endedVideoId) {
          const errorMsg = "videoId is required in playback:ended payload";
          if (typeof ack === "function") ack({ success: false, error: errorMsg });
          socket.emit("error", { message: errorMsg, code: "INVALID_VIDEO_ID" });
          return;
        }

        const roomChannel = getRoomChannel(session.roomCode);
        const result = await advanceQueueOnVideoEnd(session.roomId, endedVideoId);

        if (result.advanced && result.updatedRoom) {
          if (result.nextItem) {
            roomMetadataCache.set(session.roomId, {
              videoTitle: result.nextItem.title,
              channelTitle: result.nextItem.channelTitle,
              thumbnailUrl: result.nextItem.thumbnailUrl,
              durationSec: result.nextItem.durationSec,
            });
          }
          const safeState = toSafePlaybackState(result.updatedRoom, undefined, roomMetadataCache.get(session.roomId));
          io.to(roomChannel).emit("playback:state", { state: safeState });
          io.to(roomChannel).emit("queue:updated", {
            queue: result.queue || [],
            action: "auto-next",
            activeItemId: result.nextItem?.id,
          });

          if (typeof ack === "function") {
            ack({ success: true, advanced: true, state: safeState, queue: result.queue });
          }
        } else if (result.emptyQueue && result.updatedRoom) {
          roomMetadataCache.delete(session.roomId);
          const safeState = toSafePlaybackState(result.updatedRoom, undefined, null);
          io.to(roomChannel).emit("playback:state", { state: safeState });
          io.to(roomChannel).emit("queue:updated", {
            queue: result.queue || [],
            action: "empty",
          });

          if (typeof ack === "function") {
            ack({
              success: true,
              advanced: false,
              emptyQueue: true,
              state: safeState,
              queue: result.queue,
            });
          }
        } else {
          // ALREADY_ADVANCED or harmless duplicate
          if (typeof ack === "function") {
            ack({ success: true, advanced: false, reason: result.reason || "ALREADY_ADVANCED" });
          }
        }
      } catch (error) {
        console.error("[playback:ended Error]:", error);
        if (typeof ack === "function") {
          ack({ success: false, error: "Internal error processing playback ended event" });
        }
      }
    }
  );

  // 8. Sync Video Metadata (Player discovers video duration/title and syncs across all devices)
  socket.on(
    "playback:sync-metadata",
    async (
      payload?: {
        videoId?: string;
        durationSec?: number;
        title?: string;
        channelTitle?: string;
        thumbnailUrl?: string;
      },
      ack?: (res: { success: boolean; state?: SafePlaybackState }) => void
    ) => {
      try {
        if (!session.joinedRoom) {
          if (typeof ack === "function") ack({ success: false });
          return;
        }

        const room = await prisma.room.findUnique({ where: { id: session.roomId } });
        if (!room || !room.currentVideoId) {
          if (typeof ack === "function") ack({ success: false });
          return;
        }

        // Only accept metadata matching the currently active room video
        if (payload?.videoId && payload.videoId !== room.currentVideoId) {
          if (typeof ack === "function") ack({ success: false });
          return;
        }

        const existing = roomMetadataCache.get(session.roomId) || {};
        const updatedMeta: PlaybackMetadata = {
          videoTitle: payload?.title || existing.videoTitle || null,
          channelTitle: payload?.channelTitle || existing.channelTitle || null,
          thumbnailUrl: payload?.thumbnailUrl || existing.thumbnailUrl || null,
          durationSec: typeof payload?.durationSec === "number" && payload.durationSec > 0
            ? payload.durationSec
            : existing.durationSec || 0,
        };

        roomMetadataCache.set(session.roomId, updatedMeta);

        const safeState = toSafePlaybackState(room, undefined, updatedMeta);
        const roomChannel = getRoomChannel(session.roomCode);

        // Broadcast enriched state with accurate duration to Phone Remote
        io.to(roomChannel).emit("playback:state", { state: safeState });

        if (typeof ack === "function") {
          ack({ success: true, state: safeState });
        }
      } catch (err) {
        console.warn("[playback:sync-metadata Warning]:", err);
        if (typeof ack === "function") ack({ success: false });
      }
    }
  );
}

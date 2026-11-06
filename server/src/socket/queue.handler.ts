import type { Server as SocketIOServer, Socket } from "socket.io";
import { getRoomChannel, type SocketSessionData } from "./room.handler.js";
import { verifyHostOrModerator } from "./playback.handler.js";
import { toSafePlaybackState, type SafePlaybackState } from "./playback.types.js";
import {
  getRoomQueue,
  addQueueItem,
  removeQueueItem,
  reorderQueueItem,
  clearRoomQueue,
  advanceQueueManual,
  QueueServiceError,
  type SafeQueueItem,
  type AddQueueItemInput,
} from "../services/queue.service.js";

/**
 * Registers real-time Queue command and synchronization handlers on an authenticated Socket.IO socket.
 */
export function registerQueueHandlers(socket: Socket, io: SocketIOServer): void {
  const session = socket.data as SocketSessionData;

  // 1. List Queue (available to all authorized participants in the room)
  socket.on(
    "queue:list",
    async (
      _payload: unknown,
      ack?: (res: { success: boolean; queue?: SafeQueueItem[]; error?: string }) => void
    ) => {
      try {
        if (!session.joinedRoom) {
          const errorMsg = "Must join authorized room before fetching queue";
          if (typeof ack === "function") ack({ success: false, error: errorMsg });
          socket.emit("error", { message: errorMsg, code: "UNAUTHORIZED" });
          return;
        }

        const queue = await getRoomQueue(session.roomId);

        if (typeof ack === "function") {
          ack({ success: true, queue });
        } else {
          socket.emit("queue:updated", { queue, action: "list" });
        }
      } catch (error) {
        console.error("[queue:list Error]:", error);
        if (typeof ack === "function") {
          ack({ success: false, error: "Failed to retrieve room queue" });
        }
      }
    }
  );

  // 2. Add to Queue (Host or Moderator only)
  socket.on(
    "queue:add",
    async (
      payload?: AddQueueItemInput,
      ack?: (res: {
        success: boolean;
        item?: SafeQueueItem;
        queue?: SafeQueueItem[];
        error?: string;
      }) => void
    ) => {
      try {
        const authCheck = await verifyHostOrModerator(session);
        if (!authCheck.authorized) {
          if (typeof ack === "function") ack({ success: false, error: authCheck.error });
          socket.emit("error", { message: authCheck.error, code: authCheck.code });
          return;
        }

        if (!payload?.videoId || typeof payload.videoId !== "string") {
          const errorMsg = "videoId is required to add video to queue";
          if (typeof ack === "function") ack({ success: false, error: errorMsg });
          socket.emit("error", { message: errorMsg, code: "INVALID_VIDEO_ID" });
          return;
        }

        const createdItem = await addQueueItem(session.roomId, session.participantId, {
          videoId: payload.videoId,
          title: payload.title,
          channelTitle: payload.channelTitle,
          thumbnailUrl: payload.thumbnailUrl,
          durationSec: payload.durationSec,
          playNext: Boolean(payload.playNext),
        });

        const updatedQueue = await getRoomQueue(session.roomId);
        const roomChannel = getRoomChannel(session.roomCode);

        // Broadcast authoritative queue snapshot to all room members
        io.to(roomChannel).emit("queue:updated", {
          queue: updatedQueue,
          action: "add",
          item: createdItem,
        });

        if (typeof ack === "function") {
          ack({ success: true, item: createdItem, queue: updatedQueue });
        }
      } catch (error: any) {
        console.error("[queue:add Error]:", error);
        const errorMsg = error instanceof QueueServiceError ? error.message : "Failed to add video to queue";
        if (typeof ack === "function") {
          ack({ success: false, error: errorMsg });
        }
        socket.emit("error", { message: errorMsg, code: error?.code || "QUEUE_ADD_FAILED" });
      }
    }
  );

  // 3. Remove Queue Item (Host or Moderator only)
  socket.on(
    "queue:remove",
    async (
      payload?: { itemId?: string },
      ack?: (res: { success: boolean; queue?: SafeQueueItem[]; error?: string }) => void
    ) => {
      try {
        const authCheck = await verifyHostOrModerator(session);
        if (!authCheck.authorized) {
          if (typeof ack === "function") ack({ success: false, error: authCheck.error });
          socket.emit("error", { message: authCheck.error, code: authCheck.code });
          return;
        }

        if (!payload?.itemId || typeof payload.itemId !== "string") {
          const errorMsg = "itemId is required to remove queue item";
          if (typeof ack === "function") ack({ success: false, error: errorMsg });
          socket.emit("error", { message: errorMsg, code: "INVALID_ITEM_ID" });
          return;
        }

        await removeQueueItem(session.roomId, payload.itemId);

        const updatedQueue = await getRoomQueue(session.roomId);
        const roomChannel = getRoomChannel(session.roomCode);

        // Broadcast authoritative queue snapshot to all room members
        io.to(roomChannel).emit("queue:updated", {
          queue: updatedQueue,
          action: "remove",
          itemId: payload.itemId,
        });

        if (typeof ack === "function") {
          ack({ success: true, queue: updatedQueue });
        }
      } catch (error: any) {
        console.error("[queue:remove Error]:", error);
        const errorMsg = error instanceof QueueServiceError ? error.message : "Failed to remove queue item";
        if (typeof ack === "function") {
          ack({ success: false, error: errorMsg });
        }
        socket.emit("error", { message: errorMsg, code: error?.code || "QUEUE_REMOVE_FAILED" });
      }
    }
  );

  // 4. Reorder Queue Item (Host or Moderator only)
  socket.on(
    "queue:reorder",
    async (
      payload?: { itemId?: string; targetPosition?: number },
      ack?: (res: { success: boolean; queue?: SafeQueueItem[]; error?: string }) => void
    ) => {
      try {
        const authCheck = await verifyHostOrModerator(session);
        if (!authCheck.authorized) {
          if (typeof ack === "function") ack({ success: false, error: authCheck.error });
          socket.emit("error", { message: authCheck.error, code: authCheck.code });
          return;
        }

        if (!payload?.itemId || typeof payload.itemId !== "string") {
          const errorMsg = "itemId is required to reorder queue item";
          if (typeof ack === "function") ack({ success: false, error: errorMsg });
          socket.emit("error", { message: errorMsg, code: "INVALID_ITEM_ID" });
          return;
        }

        if (typeof payload?.targetPosition !== "number" || payload.targetPosition < 1) {
          const errorMsg = "targetPosition must be a positive integer";
          if (typeof ack === "function") ack({ success: false, error: errorMsg });
          socket.emit("error", { message: errorMsg, code: "INVALID_POSITION" });
          return;
        }

        const updatedQueue = await reorderQueueItem(session.roomId, payload.itemId, payload.targetPosition);
        const roomChannel = getRoomChannel(session.roomCode);

        // Broadcast authoritative queue snapshot to all room members
        io.to(roomChannel).emit("queue:updated", {
          queue: updatedQueue,
          action: "reorder",
        });

        if (typeof ack === "function") {
          ack({ success: true, queue: updatedQueue });
        }
      } catch (error: any) {
        console.error("[queue:reorder Error]:", error);
        const errorMsg = error instanceof QueueServiceError ? error.message : "Failed to reorder queue item";
        if (typeof ack === "function") {
          ack({ success: false, error: errorMsg });
        }
        socket.emit("error", { message: errorMsg, code: error?.code || "QUEUE_REORDER_FAILED" });
      }
    }
  );

  // 5. Play Next Video Immediately (Host or Moderator only)
  socket.on(
    "queue:play-next",
    async (
      payload?: { itemId?: string },
      ack?: (res: {
        success: boolean;
        playback?: SafePlaybackState;
        queue?: SafeQueueItem[];
        error?: string;
      }) => void
    ) => {
      try {
        const authCheck = await verifyHostOrModerator(session);
        if (!authCheck.authorized) {
          if (typeof ack === "function") ack({ success: false, error: authCheck.error });
          socket.emit("error", { message: authCheck.error, code: authCheck.code });
          return;
        }

        const result = await advanceQueueManual(session.roomId, payload?.itemId);
        const safeState = toSafePlaybackState(result.updatedRoom);
        const roomChannel = getRoomChannel(session.roomCode);

        // Broadcast both playback state and updated queue to all room members
        io.to(roomChannel).emit("playback:state", { state: safeState });
        io.to(roomChannel).emit("queue:updated", {
          queue: result.queue,
          action: "play-next",
          activeItemId: result.nextItem.id,
        });

        if (typeof ack === "function") {
          ack({ success: true, playback: safeState, queue: result.queue });
        }
      } catch (error: any) {
        console.error("[queue:play-next Error]:", error);
        const errorMsg = error instanceof QueueServiceError ? error.message : "Failed to play next item in queue";
        if (typeof ack === "function") {
          ack({ success: false, error: errorMsg });
        }
        socket.emit("error", { message: errorMsg, code: error?.code || "QUEUE_PLAY_NEXT_FAILED" });
      }
    }
  );

  // 6. Clear Queue (Host or Moderator only)
  socket.on(
    "queue:clear",
    async (
      _payload: unknown,
      ack?: (res: { success: boolean; queue?: SafeQueueItem[]; error?: string }) => void
    ) => {
      try {
        const authCheck = await verifyHostOrModerator(session);
        if (!authCheck.authorized) {
          if (typeof ack === "function") ack({ success: false, error: authCheck.error });
          socket.emit("error", { message: authCheck.error, code: authCheck.code });
          return;
        }

        await clearRoomQueue(session.roomId);

        const updatedQueue = await getRoomQueue(session.roomId);
        const roomChannel = getRoomChannel(session.roomCode);

        // Broadcast cleared queue to all room members
        io.to(roomChannel).emit("queue:updated", {
          queue: updatedQueue,
          action: "clear",
        });

        if (typeof ack === "function") {
          ack({ success: true, queue: updatedQueue });
        }
      } catch (error: any) {
        console.error("[queue:clear Error]:", error);
        const errorMsg = error instanceof QueueServiceError ? error.message : "Failed to clear room queue";
        if (typeof ack === "function") {
          ack({ success: false, error: errorMsg });
        }
        socket.emit("error", { message: errorMsg, code: error?.code || "QUEUE_CLEAR_FAILED" });
      }
    }
  );
}

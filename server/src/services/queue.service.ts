import { QueueStatus, type Role } from "@prisma/client";
import { prisma } from "../config/prisma.js";
import { extractYouTubeVideoId } from "../utils/youtube.js";
import { fetchVideoDetails, formatDuration } from "./youtube.service.js";

export interface SafeQueueItem {
  id: string;
  roomId: string;
  videoId: string;
  title: string;
  channelTitle: string | null;
  thumbnailUrl: string | null;
  durationSec: number;
  durationFormatted: string;
  position: number;
  status: QueueStatus;
  createdAt: Date;
  playedAt: Date | null;
  addedBy: {
    id: string;
    displayName: string;
    role: Role;
  };
}

export interface AddQueueItemInput {
  videoId: string;
  title?: string;
  channelTitle?: string;
  thumbnailUrl?: string;
  durationSec?: number;
  playNext?: boolean;
}

export class QueueServiceError extends Error {
  statusCode: number;
  code: string;

  constructor(message: string, statusCode = 400, code = "QUEUE_ERROR") {
    super(message);
    this.name = "QueueServiceError";
    this.statusCode = statusCode;
    this.code = code;
  }
}

function formatSafeQueueItem(item: any): SafeQueueItem {
  const durationSec = typeof item.durationSec === "number" ? item.durationSec : 0;
  return {
    id: item.id,
    roomId: item.roomId,
    videoId: item.videoId,
    title: item.title,
    channelTitle: item.channelTitle || null,
    thumbnailUrl: item.thumbnailUrl || null,
    durationSec,
    durationFormatted: formatDuration(durationSec),
    position: item.position,
    status: item.status,
    createdAt: item.createdAt,
    playedAt: item.playedAt || null,
    addedBy: {
      id: item.addedBy?.id || item.addedById,
      displayName: item.addedBy?.displayName || "Participant",
      role: item.addedBy?.role || "PARTICIPANT",
    },
  };
}

/**
 * Retrieves the current room queue (QUEUED and currently PLAYING items), sorted by position.
 */
export async function getRoomQueue(roomId: string): Promise<SafeQueueItem[]> {
  const items = await prisma.queueItem.findMany({
    where: {
      roomId,
      status: { in: [QueueStatus.QUEUED, QueueStatus.PLAYING] },
    },
    include: {
      addedBy: {
        select: { id: true, displayName: true, role: true },
      },
    },
    orderBy: { position: "asc" },
  });

  return items.map(formatSafeQueueItem);
}

/**
 * Adds a new video to the room's persistent queue.
 * Automatically fetches metadata from YouTube Data API if title or duration are omitted.
 * If playNext is true, atomically inserts at the top of the queue (position 1).
 */
export async function addQueueItem(
  roomId: string,
  addedById: string,
  input: AddQueueItemInput
): Promise<SafeQueueItem> {
  const parsedVideoId = extractYouTubeVideoId(input.videoId);
  if (!parsedVideoId) {
    throw new QueueServiceError("Invalid YouTube video ID or URL", 400, "INVALID_VIDEO_ID");
  }

  let title = typeof input.title === "string" && input.title.trim().length > 0 ? input.title.trim() : "";
  let channelTitle = typeof input.channelTitle === "string" ? input.channelTitle.trim() : null;
  let thumbnailUrl = typeof input.thumbnailUrl === "string" ? input.thumbnailUrl.trim() : null;
  let durationSec = typeof input.durationSec === "number" && input.durationSec >= 0 ? Math.floor(input.durationSec) : 0;

  // Auto-fill missing metadata via YouTube service when possible
  if (!title || durationSec === 0 || !thumbnailUrl) {
    try {
      const details = await fetchVideoDetails(parsedVideoId);
      if (details) {
        if (!title) title = details.title;
        if (!channelTitle) channelTitle = details.channelTitle;
        if (!thumbnailUrl) thumbnailUrl = details.thumbnailUrl;
        if (durationSec === 0) durationSec = details.durationSec;
      }
    } catch {
      // Fallback below
    }
  }

  if (!title) {
    title = `YouTube Video (${parsedVideoId})`;
  }
  if (!thumbnailUrl) {
    thumbnailUrl = `https://img.youtube.com/vi/${parsedVideoId}/mqdefault.jpg`;
  }

  // Persist inside an atomic transaction
  const createdItem = await prisma.$transaction(async (tx) => {
    if (input.playNext) {
      // Shift all existing QUEUED items up by 1 to make position 1 available
      await tx.queueItem.updateMany({
        where: { roomId, status: QueueStatus.QUEUED },
        data: { position: { increment: 1 } },
      });

      return await tx.queueItem.create({
        data: {
          roomId,
          addedById,
          videoId: parsedVideoId,
          title: title.slice(0, 200),
          channelTitle: channelTitle ? channelTitle.slice(0, 100) : null,
          thumbnailUrl: thumbnailUrl ? thumbnailUrl.slice(0, 500) : null,
          durationSec,
          position: 1,
          status: QueueStatus.QUEUED,
        },
        include: {
          addedBy: {
            select: { id: true, displayName: true, role: true },
          },
        },
      });
    } else {
      // Append to the end of the queue
      const lastItem = await tx.queueItem.findFirst({
        where: { roomId, status: QueueStatus.QUEUED },
        orderBy: { position: "desc" },
        select: { position: true },
      });

      const nextPosition = lastItem ? lastItem.position + 1 : 1;

      return await tx.queueItem.create({
        data: {
          roomId,
          addedById,
          videoId: parsedVideoId,
          title: title.slice(0, 200),
          channelTitle: channelTitle ? channelTitle.slice(0, 100) : null,
          thumbnailUrl: thumbnailUrl ? thumbnailUrl.slice(0, 500) : null,
          durationSec,
          position: nextPosition,
          status: QueueStatus.QUEUED,
        },
        include: {
          addedBy: {
            select: { id: true, displayName: true, role: true },
          },
        },
      });
    }
  });

  return formatSafeQueueItem(createdItem);
}

/**
 * Removes a queue item from the specified room and normalizes remaining positions.
 */
export async function removeQueueItem(roomId: string, itemId: string): Promise<boolean> {
  const item = await prisma.queueItem.findUnique({
    where: { id: itemId },
    select: { id: true, roomId: true },
  });

  if (!item || item.roomId !== roomId) {
    throw new QueueServiceError("Queue item not found in this room", 404, "ITEM_NOT_FOUND");
  }

  await prisma.$transaction(async (tx) => {
    await tx.queueItem.delete({
      where: { id: itemId },
    });

    // Re-index remaining QUEUED items to keep positions sequential (1, 2, 3...)
    const remaining = await tx.queueItem.findMany({
      where: { roomId, status: QueueStatus.QUEUED },
      orderBy: { position: "asc" },
      select: { id: true },
    });

    for (let i = 0; i < remaining.length; i++) {
      await tx.queueItem.update({
        where: { id: remaining[i].id },
        data: { position: i + 1 },
      });
    }
  });

  return true;
}

/**
 * Reorders a queue item to a specified 1-based target position.
 */
export async function reorderQueueItem(
  roomId: string,
  itemId: string,
  targetPosition: number
): Promise<SafeQueueItem[]> {
  if (!Number.isFinite(targetPosition) || targetPosition < 1) {
    throw new QueueServiceError("targetPosition must be a positive integer", 400, "INVALID_POSITION");
  }

  return await prisma.$transaction(async (tx) => {
    const items = await tx.queueItem.findMany({
      where: { roomId, status: QueueStatus.QUEUED },
      orderBy: { position: "asc" },
      include: {
        addedBy: {
          select: { id: true, displayName: true, role: true },
        },
      },
    });

    const currentIndex = items.findIndex((i) => i.id === itemId);
    if (currentIndex === -1) {
      throw new QueueServiceError("Queue item not found in this room", 404, "ITEM_NOT_FOUND");
    }

    const clampedTargetIndex = Math.max(0, Math.min(items.length - 1, Math.floor(targetPosition) - 1));

    if (currentIndex === clampedTargetIndex) {
      return items.map(formatSafeQueueItem);
    }

    // Rearrange array
    const [movedItem] = items.splice(currentIndex, 1);
    items.splice(clampedTargetIndex, 0, movedItem);

    // Apply sequential positions (1..N)
    for (let idx = 0; idx < items.length; idx++) {
      items[idx].position = idx + 1;
      await tx.queueItem.update({
        where: { id: items[idx].id },
        data: { position: idx + 1 },
      });
    }

    return items.map(formatSafeQueueItem);
  });
}

/**
 * Clears all pending QUEUED items in the room.
 */
export async function clearRoomQueue(roomId: string): Promise<boolean> {
  await prisma.queueItem.deleteMany({
    where: {
      roomId,
      status: QueueStatus.QUEUED,
    },
  });
  return true;
}

/**
 * Manually advances playback to the next item in the queue (or a specified item).
 * Marks the active item as PLAYED, promotes target item to PLAYING, updates room state.
 */
export async function advanceQueueManual(
  roomId: string,
  itemId?: string
): Promise<{ updatedRoom: any; nextItem: SafeQueueItem; queue: SafeQueueItem[] }> {
  const { updatedRoom, playingItem } = await prisma.$transaction(
    async (tx) => {
      let targetItem: any = null;

      if (itemId) {
        targetItem = await tx.queueItem.findFirst({
          where: { id: itemId, roomId, status: QueueStatus.QUEUED },
          include: {
            addedBy: {
              select: { id: true, displayName: true, role: true },
            },
          },
        });
        if (!targetItem) {
          throw new QueueServiceError("Target queue item not found", 404, "ITEM_NOT_FOUND");
        }
      } else {
        targetItem = await tx.queueItem.findFirst({
          where: { roomId, status: QueueStatus.QUEUED },
          orderBy: { position: "asc" },
          include: {
            addedBy: {
              select: { id: true, displayName: true, role: true },
            },
          },
        });
        if (!targetItem) {
          throw new QueueServiceError("Queue is empty", 400, "QUEUE_EMPTY");
        }
      }

      const now = new Date();

      // Mark any currently PLAYING items as PLAYED
      await tx.queueItem.updateMany({
        where: { roomId, status: QueueStatus.PLAYING },
        data: { status: QueueStatus.PLAYED, playedAt: now },
      });

      // Mark selected item as PLAYING
      const playingItem = await tx.queueItem.update({
        where: { id: targetItem.id },
        data: { status: QueueStatus.PLAYING, playedAt: now, position: 0 },
        include: {
          addedBy: {
            select: { id: true, displayName: true, role: true },
          },
        },
      });

      // Update room playback state
      const updatedRoom = await tx.room.update({
        where: { id: roomId },
        data: {
          currentVideoId: targetItem.videoId,
          currentTimestamp: 0.0,
          isPlaying: true,
          playbackRate: 1.0,
          lastSyncAt: now,
        },
      });

      // Renormalize remaining QUEUED items to 1..N
      const remaining = await tx.queueItem.findMany({
        where: { roomId, status: QueueStatus.QUEUED },
        orderBy: { position: "asc" },
        select: { id: true },
      });

      if (remaining.length > 0) {
        await Promise.all(
          remaining.map((item, idx) =>
            tx.queueItem.update({
              where: { id: item.id },
              data: { position: idx + 1 },
            })
          )
        );
      }

      return { updatedRoom, playingItem };
    },
    { timeout: 20000, maxWait: 10000 }
  );

  const queue = await getRoomQueue(roomId);

  return {
    updatedRoom,
    nextItem: formatSafeQueueItem(playingItem),
    queue,
  };
}

/**
 * Handles automatic queue advance when a video finishes playback.
 * Atomic and idempotent: rejects duplicate end events if the video has already advanced.
 */
export async function advanceQueueOnVideoEnd(
  roomId: string,
  endedVideoId: string
): Promise<{
  advanced: boolean;
  reason?: string;
  emptyQueue?: boolean;
  updatedRoom?: any;
  nextItem?: SafeQueueItem;
  queue?: SafeQueueItem[];
}> {
  const txResult = await prisma.$transaction(
    async (tx) => {
      const room = await tx.room.findUnique({
        where: { id: roomId },
      });

      if (!room) {
        return { advanced: false, reason: "ROOM_NOT_FOUND" };
      }

      // Concurrency guard: if room.currentVideoId is no longer endedVideoId,
      // another client has already triggered advance
      if (room.currentVideoId !== endedVideoId) {
        return { advanced: false, reason: "ALREADY_ADVANCED" };
      }

      // Find next queued item
      const nextItem = await tx.queueItem.findFirst({
        where: { roomId, status: QueueStatus.QUEUED },
        orderBy: { position: "asc" },
        include: {
          addedBy: {
            select: { id: true, displayName: true, role: true },
          },
        },
      });

      const now = new Date();

      if (!nextItem) {
        // Atomic update guarded by currentVideoId
        const updated = await tx.room.updateMany({
          where: { id: roomId, currentVideoId: endedVideoId },
          data: {
            isPlaying: false,
            lastSyncAt: now,
          },
        });

        if (updated.count === 0) {
          return { advanced: false, reason: "ALREADY_ADVANCED" };
        }

        await tx.queueItem.updateMany({
          where: { roomId, status: QueueStatus.PLAYING },
          data: { status: QueueStatus.PLAYED, playedAt: now },
        });

        const updatedRoom = await tx.room.findUnique({ where: { id: roomId } });

        return {
          advanced: false,
          emptyQueue: true,
          updatedRoom,
        };
      }

      // Next item exists: advance playback conditionally on currentVideoId matching
      const updated = await tx.room.updateMany({
        where: { id: roomId, currentVideoId: endedVideoId },
        data: {
          currentVideoId: nextItem.videoId,
          currentTimestamp: 0.0,
          isPlaying: true,
          playbackRate: 1.0,
          lastSyncAt: now,
        },
      });

      if (updated.count === 0) {
        return { advanced: false, reason: "ALREADY_ADVANCED" };
      }

      await tx.queueItem.updateMany({
        where: { roomId, status: QueueStatus.PLAYING },
        data: { status: QueueStatus.PLAYED, playedAt: now },
      });

      const playingItem = await tx.queueItem.update({
        where: { id: nextItem.id },
        data: { status: QueueStatus.PLAYING, playedAt: now, position: 0 },
        include: {
          addedBy: {
            select: { id: true, displayName: true, role: true },
          },
        },
      });

      // Renormalize remaining QUEUED items to 1..N
      const remaining = await tx.queueItem.findMany({
        where: { roomId, status: QueueStatus.QUEUED },
        orderBy: { position: "asc" },
        select: { id: true },
      });

      if (remaining.length > 0) {
        await Promise.all(
          remaining.map((item, idx) =>
            tx.queueItem.update({
              where: { id: item.id },
              data: { position: idx + 1 },
            })
          )
        );
      }

      const updatedRoom = await tx.room.findUnique({ where: { id: roomId } });

      return {
        advanced: true,
        updatedRoom,
        playingItem,
      };
    },
    { timeout: 20000, maxWait: 10000 }
  );

  if (!txResult.advanced && !txResult.emptyQueue) {
    return txResult;
  }

  const queue = await getRoomQueue(roomId);

  if (txResult.emptyQueue) {
    return {
      advanced: false,
      emptyQueue: true,
      updatedRoom: txResult.updatedRoom,
      queue,
    };
  }

  return {
    advanced: true,
    updatedRoom: txResult.updatedRoom,
    nextItem: formatSafeQueueItem(txResult.playingItem),
    queue,
  };
}

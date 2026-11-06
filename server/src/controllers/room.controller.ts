import type { Request, Response } from "express";
import { Role } from "@prisma/client";
import { prisma } from "../config/prisma.js";
import {
  generateRoomCode,
  generateSessionToken,
  hashSessionToken,
  generateModInviteToken,
  verifyModInviteToken,
  revokeRoomModInvites,
} from "../utils/crypto.js";
import {
  handleParticipantRemoved,
  broadcastRosterUpdate,
  broadcastHostTransfer,
  broadcastQueueUpdate,
} from "../socket/room.handler.js";
import type { AuthenticatedRequest } from "../types/auth.js";
import {
  searchYouTubeVideos,
  getYouTubeRecommendations,
  fetchVideoDetails,
  YouTubeApiError,
} from "../services/youtube.service.js";
import {
  getRoomQueue,
  addQueueItem,
  removeQueueItem,
  reorderQueueItem,
  QueueServiceError,
} from "../services/queue.service.js";

/**
 * Controller: Create a new Watch Party Room with an initial Host participant.
 * POST /api/rooms
 */
export async function createRoom(req: Request, res: Response): Promise<void> {
  try {
    const { displayName, title } = req.body;

    // Validate displayName
    if (
      !displayName ||
      typeof displayName !== "string" ||
      displayName.trim().length === 0 ||
      displayName.trim().length > 40
    ) {
      res.status(400).json({
        error: "Bad Request",
        message: "Display name is required and must be between 1 and 40 characters",
      });
      return;
    }

    const trimmedTitle = typeof title === "string" && title.trim().length > 0
      ? title.trim().slice(0, 100)
      : "YouTube Watch Party";

    // Generate unique room code with collision retry handling
    let roomCode = "";
    const MAX_RETRIES = 5;
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      const candidateCode = generateRoomCode();
      const existing = await prisma.room.findUnique({
        where: { code: candidateCode },
        select: { id: true },
      });
      if (!existing) {
        roomCode = candidateCode;
        break;
      }
    }

    if (!roomCode) {
      res.status(500).json({
        error: "Internal Server Error",
        message: "Failed to generate a unique room code. Please try again.",
      });
      return;
    }

    // Generate cryptographic session token and its SHA-256 hash
    const rawSessionToken = generateSessionToken();
    const tokenHash = hashSessionToken(rawSessionToken);

    // Persist Room and Host Participant atomically
    const { room, host } = await prisma.$transaction(async (tx) => {
      const createdRoom = await tx.room.create({
        data: {
          code: roomCode,
          title: trimmedTitle,
          currentVideoId: null, // No video selected until the Host loads one
          currentTimestamp: 0.0,
          isPlaying: false,
          playbackRate: 1.0,
        },
      });

      const createdHost = await tx.participant.create({
        data: {
          roomId: createdRoom.id,
          displayName: displayName.trim(),
          role: Role.HOST,
          tokenHash,
          isConnected: false, // Truthful status: false until live WebSocket connection connects
        },
      });

      return { room: createdRoom, host: createdHost };
    });

    res.status(201).json({
      room: {
        id: room.id,
        code: room.code,
        title: room.title,
        currentVideoId: room.currentVideoId,
        currentTimestamp: room.currentTimestamp,
        isPlaying: room.isPlaying,
        playbackRate: room.playbackRate,
        createdAt: room.createdAt,
        updatedAt: room.updatedAt,
      },
      participant: {
        id: host.id,
        displayName: host.displayName,
        role: host.role,
        joinedAt: host.joinedAt,
      },
      sessionToken: rawSessionToken,
    });
  } catch (error) {
    console.error("[createRoom Error]:", error);
    res.status(500).json({
      error: "Internal Server Error",
      message: "An unexpected error occurred while creating the room",
    });
  }
}

/**
 * Controller: Join an existing Watch Party Room as a Participant.
 * POST /api/rooms/:code/join
 */
export async function joinRoom(req: Request, res: Response): Promise<void> {
  try {
    const { code } = req.params;
    const { displayName, inviteToken } = req.body;

    if (!code || typeof code !== "string" || code.trim().length === 0) {
      res.status(400).json({
        error: "Bad Request",
        message: "Room code parameter is required",
      });
      return;
    }

    if (
      !displayName ||
      typeof displayName !== "string" ||
      displayName.trim().length === 0 ||
      displayName.trim().length > 40
    ) {
      res.status(400).json({
        error: "Bad Request",
        message: "Display name is required and must be between 1 and 40 characters",
      });
      return;
    }

    // Fetch room with transient retry for Neon connection drops
    let room: any = null;
    let attempts = 0;
    while (attempts < 3) {
      try {
        room = await prisma.room.findUnique({
          where: { code: code.toUpperCase() },
        });
        break;
      } catch (err: any) {
        attempts++;
        if (
          attempts < 3 &&
          (err?.code === "P1001" ||
            err?.message?.includes("Can't reach database") ||
            err?.message?.includes("Closed"))
        ) {
          await new Promise((r) => setTimeout(r, 700));
        } else {
          throw err;
        }
      }
    }

    if (!room) {
      res.status(404).json({
        error: "Not Found",
        message: `No active room found with code "${code.toUpperCase()}"`,
      });
      return;
    }

    // Securely determine role based on valid room-scoped moderator invite token
    let assignedRole: Role = Role.PARTICIPANT;
    if (inviteToken && typeof inviteToken === "string") {
      const isModInviteValid = verifyModInviteToken(room.code, inviteToken.trim());
      if (isModInviteValid) {
        assignedRole = Role.MODERATOR;
        console.log(
          `[joinRoom]: Assigning MODERATOR role to "${displayName.trim()}" in room ${room.code} via verified QR invite token.`
        );
      }
    }

    // Generate cryptographic session token and its SHA-256 hash
    const rawSessionToken = generateSessionToken();
    const tokenHash = hashSessionToken(rawSessionToken);

    // Persist new participant with transient retry
    let participant: any = null;
    attempts = 0;
    while (attempts < 3) {
      try {
        participant = await prisma.participant.create({
          data: {
            roomId: room.id,
            displayName: displayName.trim(),
            role: assignedRole,
            tokenHash,
            isConnected: false, // Truthful status: false until live WebSocket connection connects
          },
        });
        break;
      } catch (err: any) {
        attempts++;
        if (
          attempts < 3 &&
          (err?.code === "P1001" ||
            err?.message?.includes("Can't reach database") ||
            err?.message?.includes("Closed"))
        ) {
          await new Promise((r) => setTimeout(r, 700));
        } else {
          throw err;
        }
      }
    }

    res.status(201).json({
      room: {
        id: room.id,
        code: room.code,
        title: room.title,
        currentVideoId: room.currentVideoId,
        currentTimestamp: room.currentTimestamp,
        isPlaying: room.isPlaying,
        playbackRate: room.playbackRate,
        createdAt: room.createdAt,
        updatedAt: room.updatedAt,
      },
      participant: {
        id: participant.id,
        displayName: participant.displayName,
        role: participant.role,
        joinedAt: participant.joinedAt,
      },
      sessionToken: rawSessionToken,
    });
  } catch (error) {
    console.error("[joinRoom Error]:", error);
    res.status(500).json({
      error: "Internal Server Error",
      message: "An unexpected error occurred while joining the room",
    });
  }
}

/**
 * Controller: Retrieve Room information and public participant roster.
 * GET /api/rooms/:code
 * Requires authenticated session token.
 */
export async function getRoom(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const room = req.room!;
    const currentParticipant = req.participant!;

    const participants = await prisma.participant.findMany({
      where: { roomId: room.id },
      select: {
        id: true,
        displayName: true,
        role: true,
        isConnected: true,
        joinedAt: true,
        lastActiveAt: true,
      },
      orderBy: { joinedAt: "asc" },
    });

    res.status(200).json({
      room: {
        id: room.id,
        code: room.code,
        title: room.title,
        currentVideoId: room.currentVideoId,
        currentTimestamp: room.currentTimestamp,
        isPlaying: room.isPlaying,
        playbackRate: room.playbackRate,
        lastSyncAt: room.lastSyncAt,
        createdAt: room.createdAt,
        updatedAt: room.updatedAt,
      },
      currentParticipant: {
        id: currentParticipant.id,
        displayName: currentParticipant.displayName,
        role: currentParticipant.role,
      },
      participants,
    });
  } catch (error) {
    console.error("[getRoom Error]:", error);
    res.status(500).json({
      error: "Internal Server Error",
      message: "An error occurred while fetching room details",
    });
  }
}

/**
 * Controller: Update a participant's role (promote to Moderator / demote to Participant).
 * PATCH /api/rooms/:code/participants/:participantId/role
 * Requires Host authentication.
 */
export async function updateParticipantRole(
  req: AuthenticatedRequest,
  res: Response
): Promise<void> {
  try {
    const participantId = typeof req.params.participantId === "string" ? req.params.participantId : undefined;
    if (!participantId) {
      res.status(400).json({
        error: "Bad Request",
        message: "Valid participantId parameter is required",
      });
      return;
    }

    const { role } = req.body;
    const currentHost = req.participant!;
    const room = req.room!;

    // Validate target role
    if (!role || typeof role !== "string") {
      res.status(400).json({
        error: "Bad Request",
        message: "Target role is required",
      });
      return;
    }

    if (role === "HOST") {
      res.status(400).json({
        error: "Bad Request",
        message: "Host transfer is not permitted through this endpoint",
      });
      return;
    }

    if (role !== "MODERATOR" && role !== "PARTICIPANT") {
      res.status(400).json({
        error: "Bad Request",
        message: "Role must be either MODERATOR or PARTICIPANT",
      });
      return;
    }

    // Prevent Host from modifying their own role
    if (participantId === currentHost.id) {
      res.status(400).json({
        error: "Bad Request",
        message: "Host cannot demote or modify their own role",
      });
      return;
    }

    // Verify target participant exists in this room
    const targetParticipant = await prisma.participant.findFirst({
      where: {
        id: participantId,
        roomId: room.id,
      },
    });

    if (!targetParticipant) {
      res.status(404).json({
        error: "Not Found",
        message: "Participant not found in this room",
      });
      return;
    }

    if (targetParticipant.role === Role.HOST) {
      res.status(400).json({
        error: "Bad Request",
        message: "Cannot modify role of another Host",
      });
      return;
    }

    // Apply role change
    const updated = await prisma.participant.update({
      where: { id: targetParticipant.id },
      data: { role: role as Role },
      select: {
        id: true,
        displayName: true,
        role: true,
        isConnected: true,
        joinedAt: true,
      },
    });

    // Notify active Socket.IO room members of updated roster
    void broadcastRosterUpdate(room.code, room.id);

    res.status(200).json({
      message: `Participant role successfully updated to ${role}`,
      participant: updated,
    });
  } catch (error) {
    console.error("[updateParticipantRole Error]:", error);
    res.status(500).json({
      error: "Internal Server Error",
      message: "An error occurred while updating participant role",
    });
  }
}

/**
 * Controller: Generate/retrieve a secure moderator invite token for the Car Screen QR.
 * GET /api/rooms/:code/mod-invite
 * Requires Host authentication.
 */
export async function getModInviteTokenController(
  req: AuthenticatedRequest,
  res: Response
): Promise<void> {
  try {
    const room = req.room!;
    const shouldRevoke = req.query.revoke === "true";

    if (shouldRevoke) {
      revokeRoomModInvites(room.code);
    }

    const inviteToken = generateModInviteToken(room.code);

    res.status(200).json({
      roomCode: room.code,
      inviteToken,
      expiresInSeconds: 86400,
    });
  } catch (error) {
    console.error("[getModInviteTokenController Error]:", error);
    res.status(500).json({
      error: "Internal Server Error",
      message: "Failed to generate moderator invite token",
    });
  }
}

/**
 * Controller: Remove a participant from the room.
 * DELETE /api/rooms/:code/participants/:participantId
 * Requires Host authentication.
 */
export async function removeParticipant(
  req: AuthenticatedRequest,
  res: Response
): Promise<void> {
  try {
    const participantId = typeof req.params.participantId === "string" ? req.params.participantId : undefined;
    if (!participantId) {
      res.status(400).json({
        error: "Bad Request",
        message: "Valid participantId parameter is required",
      });
      return;
    }

    const currentHost = req.participant!;
    const room = req.room!;

    // Prevent Host from removing themselves
    if (participantId === currentHost.id) {
      res.status(400).json({
        error: "Bad Request",
        message: "Host cannot remove themselves from the room",
      });
      return;
    }

    // Verify target participant belongs to this room
    const target = await prisma.participant.findFirst({
      where: {
        id: participantId,
        roomId: room.id,
      },
    });

    if (!target) {
      res.status(404).json({
        error: "Not Found",
        message: "Participant not found in this room",
      });
      return;
    }

    // Delete participant
    await prisma.participant.delete({
      where: { id: target.id },
    });

    // Evict any active Socket.IO connections and notify room members
    void handleParticipantRemoved(target.id, room.code, target.displayName, room.id);

    res.status(200).json({
      message: "Participant removed successfully",
      removedParticipantId: target.id,
    });
  } catch (error) {
    console.error("[removeParticipant Error]:", error);
    res.status(500).json({
      error: "Internal Server Error",
      message: "An error occurred while removing the participant",
    });
  }
}

/**
 * Controller: Explicit Host Transfer.
 * POST /api/rooms/:code/transfer-host or POST /api/rooms/:code/participants/:participantId/transfer-host
 * Requires Host authentication.
 * Atomically reassigns Host role to target and demotes caller to Moderator.
 */
export async function transferHost(
  req: AuthenticatedRequest,
  res: Response
): Promise<void> {
  try {
    const targetParticipantId =
      (typeof req.params.participantId === "string" && req.params.participantId.trim()) ||
      (typeof req.body?.newHostParticipantId === "string" && req.body.newHostParticipantId.trim()) ||
      undefined;

    if (!targetParticipantId) {
      res.status(400).json({
        error: "Bad Request",
        message: "Valid newHostParticipantId parameter or body field is required",
      });
      return;
    }

    const currentHost = req.participant!;
    const room = req.room!;

    // Cannot transfer host ownership to yourself
    if (targetParticipantId === currentHost.id) {
      res.status(400).json({
        error: "Bad Request",
        message: "Cannot transfer host ownership to yourself",
      });
      return;
    }

    // Atomic transaction ensuring single-host guarantee and concurrency safety
    const result = await prisma.$transaction(async (tx) => {
      // 1. Atomic conditional demotion: ONLY succeeds if caller is still actively Role.HOST
      const demoteResult = await tx.participant.updateMany({
        where: { id: currentHost.id, roomId: room.id, role: Role.HOST },
        data: { role: Role.MODERATOR },
      });

      if (demoteResult.count === 0) {
        throw new Error("UNAUTHORIZED_TRANSFER: Caller is not the current Host of this room");
      }

      // 2. Verify target participant exists in this room
      const target = await tx.participant.findFirst({
        where: { id: targetParticipantId, roomId: room.id },
      });

      if (!target) {
        throw new Error("NOT_FOUND: Target participant not found in this room");
      }

      if (target.role === Role.HOST) {
        throw new Error("ALREADY_HOST: Target participant is already the Host");
      }

      // 3. Promote target participant to HOST
      const updatedNewHost = await tx.participant.update({
        where: { id: target.id },
        data: { role: Role.HOST },
        select: {
          id: true,
          displayName: true,
          role: true,
          isConnected: true,
          joinedAt: true,
        },
      });

      const updatedFormerHost = await tx.participant.findUnique({
        where: { id: currentHost.id },
        select: {
          id: true,
          displayName: true,
          role: true,
          isConnected: true,
          joinedAt: true,
        },
      });

      return { formerHost: updatedFormerHost!, newHost: updatedNewHost };
    });

    // Broadcast host transfer & updated roster to room
    void broadcastHostTransfer(
      room.code,
      room.id,
      result.formerHost.id,
      result.newHost.id,
      result.newHost.displayName
    );

    res.status(200).json({
      message: `Room ownership successfully transferred to ${result.newHost.displayName}`,
      formerHost: result.formerHost,
      newHost: result.newHost,
    });
  } catch (error: any) {
    if (error?.message?.startsWith("UNAUTHORIZED_TRANSFER")) {
      res.status(403).json({
        error: "Forbidden",
        message: "Only the active Room Host can transfer room ownership",
      });
      return;
    }
    if (error?.message?.startsWith("NOT_FOUND")) {
      res.status(404).json({
        error: "Not Found",
        message: "Target participant not found in this room",
      });
      return;
    }
    if (error?.message?.startsWith("ALREADY_HOST")) {
      res.status(400).json({
        error: "Bad Request",
        message: "Target participant is already the Host",
      });
      return;
    }

    console.error("[transferHost Error]:", error);
    res.status(500).json({
      error: "Internal Server Error",
      message: "An unexpected error occurred while transferring host ownership",
    });
  }
}

/**
 * Controller: Search YouTube videos via YouTube Data API v3.
 * GET /api/rooms/:code/search?q=:query
 * Requires Host or Moderator role.
 */
export async function searchVideos(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const query = typeof req.query.q === "string" ? req.query.q : "";
    if (!query || query.trim().length === 0) {
      res.status(400).json({
        error: "Bad Request",
        message: "Search query parameter 'q' is required",
      });
      return;
    }

    const results = await searchYouTubeVideos(query);
    res.status(200).json({
      query: query.trim(),
      results,
      items: results,
    });
  } catch (error: any) {
    if (error instanceof YouTubeApiError) {
      res.status(error.statusCode).json({
        error: error.code,
        message: error.message,
      });
      return;
    }
    console.error("[searchVideos Error]:", error);
    res.status(500).json({
      error: "Internal Server Error",
      message: "An unexpected error occurred while searching YouTube",
    });
  }
}

/**
 * Controller: Get the room's persistent video queue.
 * GET /api/rooms/:code/queue
 * Accessible to all room participants.
 */
export async function getQueue(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const room = req.room!;
    const queue = await getRoomQueue(room.id);
    res.status(200).json({ queue });
  } catch (error: any) {
    console.error("[getQueue Error]:", error);
    res.status(500).json({
      error: "Internal Server Error",
      message: "An error occurred while fetching the room queue",
    });
  }
}

/**
 * Controller: Add a video to the room's persistent queue.
 * POST /api/rooms/:code/queue
 * Requires Host or Moderator role.
 */
export async function addToQueue(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const room = req.room!;
    const participant = req.participant!;
    const { videoId, title, channelTitle, thumbnailUrl, durationSec, playNext } = req.body || {};

    if (!videoId || typeof videoId !== "string") {
      res.status(400).json({
        error: "Bad Request",
        message: "videoId is required",
      });
      return;
    }

    const item = await addQueueItem(room.id, participant.id, {
      videoId,
      title,
      channelTitle,
      thumbnailUrl,
      durationSec,
      playNext: Boolean(playNext),
    });

    const updatedQueue = await getRoomQueue(room.id);
    broadcastQueueUpdate(room.code, updatedQueue, "add", { item });

    res.status(201).json({
      success: true,
      item,
      queue: updatedQueue,
    });
  } catch (error: any) {
    if (error instanceof QueueServiceError) {
      res.status(error.statusCode).json({
        error: error.code,
        message: error.message,
      });
      return;
    }
    console.error("[addToQueue Error]:", error);
    res.status(500).json({
      error: "Internal Server Error",
      message: "An unexpected error occurred while adding to the queue",
    });
  }
}

/**
 * Controller: Remove an item from the room queue.
 * DELETE /api/rooms/:code/queue/:itemId
 * Requires Host or Moderator role.
 */
export async function removeFromQueue(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const room = req.room!;
    const itemId = typeof req.params.itemId === "string" ? req.params.itemId : "";

    if (!itemId) {
      res.status(400).json({
        error: "Bad Request",
        message: "itemId parameter is required",
      });
      return;
    }

    await removeQueueItem(room.id, itemId);

    const updatedQueue = await getRoomQueue(room.id);
    broadcastQueueUpdate(room.code, updatedQueue, "remove", { itemId });

    res.status(200).json({
      success: true,
      message: "Queue item successfully removed",
      queue: updatedQueue,
    });
  } catch (error: any) {
    if (error instanceof QueueServiceError) {
      res.status(error.statusCode).json({
        error: error.code,
        message: error.message,
      });
      return;
    }
    console.error("[removeFromQueue Error]:", error);
    res.status(500).json({
      error: "Internal Server Error",
      message: "An unexpected error occurred while removing the queue item",
    });
  }
}

/**
 * Controller: Reorder an item in the room queue.
 * PATCH /api/rooms/:code/queue/reorder
 * Requires Host or Moderator role.
 */
export async function reorderQueue(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const room = req.room!;
    const { itemId, targetPosition } = req.body || {};

    if (!itemId || typeof itemId !== "string") {
      res.status(400).json({
        error: "Bad Request",
        message: "itemId is required in request body",
      });
      return;
    }

    if (typeof targetPosition !== "number" || targetPosition < 1) {
      res.status(400).json({
        error: "Bad Request",
        message: "targetPosition must be a positive number",
      });
      return;
    }

    const updatedQueue = await reorderQueueItem(room.id, itemId, targetPosition);
    broadcastQueueUpdate(room.code, updatedQueue, "reorder");

    res.status(200).json({
      success: true,
      queue: updatedQueue,
    });
  } catch (error: any) {
    if (error instanceof QueueServiceError) {
      res.status(error.statusCode).json({
        error: error.code,
        message: error.message,
      });
      return;
    }
    console.error("[reorderQueue Error]:", error);
    res.status(500).json({
      error: "Internal Server Error",
      message: "An unexpected error occurred while reordering the queue",
    });
  }
}

/**
 * Controller: Get video recommendations based on the currently playing or requested video.
 * GET /api/rooms/:code/recommendations?videoId=...&title=...&channel=...&limit=...
 * Accessible to all room participants.
 */
export async function getRecommendationsController(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const room = req.room!;
    const videoId =
      typeof req.query.videoId === "string" && req.query.videoId.trim().length > 0
        ? req.query.videoId.trim()
        : room.currentVideoId || undefined;

    const title = typeof req.query.title === "string" ? req.query.title.trim() : undefined;
    const channel = typeof req.query.channel === "string" ? req.query.channel.trim() : undefined;
    const limitNum =
      typeof req.query.limit === "string"
        ? Math.min(Math.max(parseInt(req.query.limit, 10) || 10, 1), 20)
        : 10;

    const recommendations = await getYouTubeRecommendations(videoId, title, channel, limitNum);

    res.status(200).json({
      success: true,
      count: recommendations.length,
      recommendations,
    });
  } catch (error: any) {
    console.error("[getRecommendations Error]:", error);
    res.status(500).json({
      error: "Internal Server Error",
      message: "An unexpected error occurred while fetching video recommendations",
    });
  }
}

/**
 * Controller: Get video metadata details for a given YouTube video ID.
 * GET /api/rooms/:code/video-details?videoId=...
 * Accessible to all room participants.
 */
export async function getVideoDetailsController(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const videoId = typeof req.query.videoId === "string" ? req.query.videoId.trim() : "";
    if (!videoId) {
      res.status(400).json({
        error: "Bad Request",
        message: "videoId query parameter is required",
      });
      return;
    }

    const details = await fetchVideoDetails(videoId);
    if (!details) {
      res.status(404).json({
        error: "Not Found",
        message: "Could not retrieve details for this video",
      });
      return;
    }

    res.status(200).json({
      success: true,
      details,
    });
  } catch (error: any) {
    console.error("[getVideoDetails Error]:", error);
    res.status(500).json({
      error: "Internal Server Error",
      message: "An unexpected error occurred while fetching video details",
    });
  }
}

import { Router } from "express";
import {
  createRoom,
  joinRoom,
  getRoom,
  updateParticipantRole,
  removeParticipant,
  transferHost,
  searchVideos,
  getQueue,
  addToQueue,
  removeFromQueue,
  reorderQueue,
  getModInviteTokenController,
  getRecommendationsController,
  getVideoDetailsController,
} from "../controllers/room.controller.js";
import {
  authenticateParticipant,
  requireHost,
  requireHostOrModerator,
} from "../middleware/auth.js";

const router = Router();

// Public endpoints
router.post("/", createRoom);
router.post("/:code/join", joinRoom);

// Protected endpoints (requires valid session token for targeted room)
router.get("/:code", authenticateParticipant, getRoom);

// Video Recommendations & Details (Accessible to all room participants)
router.get("/:code/recommendations", authenticateParticipant, getRecommendationsController);
router.get("/:code/video-details", authenticateParticipant, getVideoDetailsController);

// YouTube Search (Host and Moderator only)
router.get(
  "/:code/search",
  authenticateParticipant,
  requireHostOrModerator,
  searchVideos
);

// Room Queue Endpoints
// View queue (all room participants)
router.get(
  "/:code/queue",
  authenticateParticipant,
  getQueue
);

// Add to queue (Host and Moderator only)
router.post(
  "/:code/queue",
  authenticateParticipant,
  requireHostOrModerator,
  addToQueue
);

// Remove from queue (Host and Moderator only)
router.delete(
  "/:code/queue/:itemId",
  authenticateParticipant,
  requireHostOrModerator,
  removeFromQueue
);

// Reorder queue (Host and Moderator only)
router.patch(
  "/:code/queue/reorder",
  authenticateParticipant,
  requireHostOrModerator,
  reorderQueue
);

// Host-restricted participant management endpoints
router.get(
  "/:code/mod-invite",
  authenticateParticipant,
  requireHost,
  getModInviteTokenController
);

router.patch(
  "/:code/participants/:participantId/role",
  authenticateParticipant,
  requireHost,
  updateParticipantRole
);

router.delete(
  "/:code/participants/:participantId",
  authenticateParticipant,
  requireHost,
  removeParticipant
);

// Host ownership transfer endpoints
router.post(
  "/:code/transfer-host",
  authenticateParticipant,
  requireHost,
  transferHost
);

router.post(
  "/:code/participants/:participantId/transfer-host",
  authenticateParticipant,
  requireHost,
  transferHost
);

export default router;

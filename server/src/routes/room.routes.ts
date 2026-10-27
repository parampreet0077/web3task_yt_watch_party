import { Router } from "express";
import {
  createRoom,
  joinRoom,
  getRoom,
  updateParticipantRole,
  removeParticipant,
  transferHost,
} from "../controllers/room.controller.js";
import { authenticateParticipant, requireHost } from "../middleware/auth.js";

const router = Router();

// Public endpoints
router.post("/", createRoom);
router.post("/:code/join", joinRoom);

// Protected endpoints (requires valid session token for targeted room)
router.get("/:code", authenticateParticipant, getRoom);

// Host-restricted participant management endpoints
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

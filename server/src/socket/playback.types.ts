import type { Role, RequestType, RequestStatus } from "@prisma/client";

/**
 * Authoritative, sanitized playback state emitted to room participants.
 * Contains precise timing metadata to allow clients to calculate drift and synchronize smoothly.
 */
export interface SafePlaybackState {
  currentVideoId: string | null;
  currentTimestamp: number;
  isPlaying: boolean;
  playbackRate: number;
  lastSyncAt: string;
  serverTime: number;
  syncToken?: string;
}

/**
 * Sanitized control request representation emitted to room participants.
 * Completely free of private tokens, internal IDs, or sensitive hashes.
 */
export interface SafeControlRequest {
  id: string;
  roomId: string;
  participant: {
    id: string;
    displayName: string;
    role: Role;
  };
  type: RequestType;
  targetTimestamp: number | null;
  targetVideoId: string | null;
  status: RequestStatus;
  createdAt: string;
  resolvedAt: string | null;
}

/**
 * Computes the authoritative video playback timestamp dynamically.
 * If the room is playing, advances the position based on the elapsed real time and playback rate.
 */
export function computeCurrentPlaybackTimestamp(
  storedTimestamp: number,
  isPlaying: boolean,
  playbackRate: number,
  lastSyncAt: Date
): number {
  if (!isPlaying) {
    return Math.max(0, storedTimestamp);
  }

  const now = Date.now();
  const elapsedSeconds = ((now - lastSyncAt.getTime()) / 1000) * playbackRate;
  return Math.max(0, storedTimestamp + Math.max(0, elapsedSeconds));
}

/**
 * Maps a Room database record into a clean SafePlaybackState DTO.
 */
export function toSafePlaybackState(
  room: {
    currentVideoId: string | null;
    currentTimestamp: number;
    isPlaying: boolean;
    playbackRate: number;
    lastSyncAt: Date;
  },
  syncToken?: string
): SafePlaybackState {
  const currentTimestamp = computeCurrentPlaybackTimestamp(
    room.currentTimestamp,
    room.isPlaying,
    room.playbackRate,
    room.lastSyncAt
  );

  return {
    currentVideoId: room.currentVideoId,
    currentTimestamp: Number(currentTimestamp.toFixed(3)),
    isPlaying: room.isPlaying,
    playbackRate: room.playbackRate,
    lastSyncAt: room.lastSyncAt.toISOString(),
    serverTime: Date.now(),
    ...(syncToken ? { syncToken } : {}),
  };
}

/**
 * Maps a ControlRequest database record into a clean SafeControlRequest DTO.
 */
export function toSafeControlRequest(request: {
  id: string;
  roomId: string;
  participant: {
    id: string;
    displayName: string;
    role: Role;
  };
  type: RequestType;
  targetTimestamp: number | null;
  targetVideoId: string | null;
  status: RequestStatus;
  createdAt: Date;
  resolvedAt: Date | null;
}): SafeControlRequest {
  return {
    id: request.id,
    roomId: request.roomId,
    participant: {
      id: request.participant.id,
      displayName: request.participant.displayName,
      role: request.participant.role,
    },
    type: request.type,
    targetTimestamp:
      typeof request.targetTimestamp === "number"
        ? Number(request.targetTimestamp.toFixed(3))
        : null,
    targetVideoId: request.targetVideoId,
    status: request.status,
    createdAt: request.createdAt.toISOString(),
    resolvedAt: request.resolvedAt ? request.resolvedAt.toISOString() : null,
  };
}

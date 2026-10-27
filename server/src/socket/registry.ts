import type { Role } from "@prisma/client";

export interface SocketMetadata {
  participantId: string;
  roomId: string;
  roomCode: string;
  displayName: string;
  role: Role;
}

export interface AddSocketResult {
  isFirstSocket: boolean;
  activeCount: number;
}

export interface RemoveSocketResult {
  meta: SocketMetadata;
  isLastSocket: boolean;
  remainingCount: number;
}

/**
 * In-Memory Socket Connection Registry for tracking active Socket.IO connections.
 *
 * Single-Server Architecture Note (Requirement 10):
 * This registry stores active socket associations in-memory on the current process node.
 * It accurately handles multiple tabs/connections per participant on a single server.
 * In a horizontally scaled multi-instance deployment, this in-memory registry would be
 * replaced with a shared distributed store (such as Redis Sets/Hashes) paired with
 * @socket.io/redis-adapter or Redis Streams pub/sub.
 */
export class SocketRegistry {
  /** Map of participantId -> Set of active socket IDs */
  private participantSockets: Map<string, Set<string>> = new Map();

  /** Map of socketId -> SocketMetadata */
  private socketMeta: Map<string, SocketMetadata> = new Map();

  /**
   * Registers a socket connection for a participant.
   * If the participant currently has zero active sockets, `isFirstSocket` will be true.
   */
  public addSocket(
    participantId: string,
    socketId: string,
    meta: SocketMetadata
  ): AddSocketResult {
    let sockets = this.participantSockets.get(participantId);
    let isFirstSocket = false;

    if (!sockets) {
      sockets = new Set();
      this.participantSockets.set(participantId, sockets);
      isFirstSocket = true;
    }

    sockets.add(socketId);
    this.socketMeta.set(socketId, meta);

    return {
      isFirstSocket,
      activeCount: sockets.size,
    };
  }

  /**
   * Deregisters a socket connection when a tab closes or client leaves/disconnects.
   * Returns metadata and whether this was the participant's last active socket.
   */
  public removeSocket(socketId: string): RemoveSocketResult | null {
    const meta = this.socketMeta.get(socketId);
    if (!meta) {
      return null;
    }

    this.socketMeta.delete(socketId);
    const sockets = this.participantSockets.get(meta.participantId);

    if (!sockets) {
      return {
        meta,
        isLastSocket: true,
        remainingCount: 0,
      };
    }

    sockets.delete(socketId);
    const remainingCount = sockets.size;
    let isLastSocket = false;

    if (remainingCount === 0) {
      this.participantSockets.delete(meta.participantId);
      isLastSocket = true;
    }

    return {
      meta,
      isLastSocket,
      remainingCount,
    };
  }

  /**
   * Retrieves all active socket IDs for a given participant.
   */
  public getSocketsForParticipant(participantId: string): string[] {
    const sockets = this.participantSockets.get(participantId);
    return sockets ? Array.from(sockets) : [];
  }

  /**
   * Checks if a participant has at least one active socket connection.
   */
  public isParticipantConnected(participantId: string): boolean {
    const sockets = this.participantSockets.get(participantId);
    return Boolean(sockets && sockets.size > 0);
  }

  /**
   * Retrieves metadata associated with a given socket ID.
   */
  public getSocketMetadata(socketId: string): SocketMetadata | undefined {
    return this.socketMeta.get(socketId);
  }

  /**
   * Clears all socket associations for a participant (e.g. when removed by Host).
   * Returns the list of socket IDs that were cleared.
   */
  public clearParticipant(participantId: string): string[] {
    const sockets = this.participantSockets.get(participantId);
    if (!sockets) {
      return [];
    }

    const socketIds = Array.from(sockets);
    for (const socketId of socketIds) {
      this.socketMeta.delete(socketId);
    }
    this.participantSockets.delete(participantId);

    return socketIds;
  }
}

// Global singleton instance for the single-server application
export const socketRegistry = new SocketRegistry();

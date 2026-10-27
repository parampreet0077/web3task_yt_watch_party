export type Role = 'HOST' | 'MODERATOR' | 'PARTICIPANT';

export type RequestType = 'PLAY' | 'PAUSE' | 'SEEK' | 'CHANGE_VIDEO';

export type RequestStatus = 'PENDING' | 'APPROVED' | 'REJECTED';

export interface RoomData {
  id: string;
  code: string;
  title: string;
  currentVideoId: string | null;
  currentTimestamp: number;
  isPlaying: boolean;
  playbackRate: number;
  lastSyncAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface ParticipantData {
  id: string;
  displayName: string;
  role: Role;
  isConnected: boolean;
  joinedAt?: string;
  lastActiveAt?: string;
}

export interface SafePlaybackState {
  currentVideoId: string | null;
  currentTimestamp: number;
  isPlaying: boolean;
  playbackRate: number;
  lastSyncAt: string;
  serverTime: number;
  syncToken?: string;
}

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

export interface RoleRequest {
  requestId: string;
  participant: {
    id: string;
    displayName: string;
    role: Role;
  };
  requestedRole: Role;
  timestamp: string;
}

export interface StoredSession {
  roomCode: string;
  token: string;
  participantId: string;
  displayName: string;
}

export interface CreateRoomResponse {
  room: RoomData;
  participant: ParticipantData;
  sessionToken: string;
}

export interface JoinRoomResponse {
  room: RoomData;
  participant: ParticipantData;
  sessionToken: string;
}

export interface GetRoomResponse {
  room: RoomData;
  currentParticipant: ParticipantData;
  participants: ParticipantData[];
}

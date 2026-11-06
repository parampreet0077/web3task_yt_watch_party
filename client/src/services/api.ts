import type {
  CreateRoomResponse,
  JoinRoomResponse,
  GetRoomResponse,
  Role,
} from '../types/room';
import { resolveBackendUrl } from '../utils/env';

const BACKEND_URL = resolveBackendUrl();

export class ApiError extends Error {
  statusCode: number;
  data: any;

  constructor(message: string, statusCode: number, data?: any) {
    super(message);
    this.name = 'ApiError';
    this.statusCode = statusCode;
    this.data = data;
  }
}

async function request<T>(endpoint: string, options: RequestInit = {}): Promise<T> {
  const url = `${BACKEND_URL}${endpoint}`;
  let response: Response;

  try {
    response = await fetch(url, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...options.headers,
      },
    });
  } catch (_err) {
    throw new ApiError(
      'Unable to connect to WatchParty server. The backend may be spinning up or temporarily unreachable. Please retry in a few moments.',
      0
    );
  }

  let data: any = null;
  try {
    data = await response.json();
  } catch {
    data = null;
  }

  if (!response.ok) {
    const errorMsg = data?.message || data?.error || `Request failed with status ${response.status}`;
    throw new ApiError(errorMsg, response.status, data);
  }

  return data as T;
}

export async function createRoom(displayName: string, title?: string): Promise<CreateRoomResponse> {
  return request<CreateRoomResponse>('/api/rooms', {
    method: 'POST',
    body: JSON.stringify({ displayName: displayName.trim(), title: title?.trim() }),
  });
}

export async function joinRoom(
  roomCode: string,
  displayName: string,
  inviteToken?: string
): Promise<JoinRoomResponse> {
  return request<JoinRoomResponse>(`/api/rooms/${roomCode.trim().toUpperCase()}/join`, {
    method: 'POST',
    body: JSON.stringify({
      displayName: displayName.trim(),
      ...(inviteToken ? { inviteToken: inviteToken.trim() } : {}),
    }),
  });
}

export async function getModInviteToken(
  roomCode: string,
  sessionToken: string,
  revoke = false
): Promise<{ roomCode: string; inviteToken: string; expiresInSeconds: number }> {
  const url = `/api/rooms/${roomCode.trim().toUpperCase()}/mod-invite${revoke ? '?revoke=true' : ''}`;
  return request<{ roomCode: string; inviteToken: string; expiresInSeconds: number }>(url, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${sessionToken}`,
    },
  });
}

export async function getRoom(roomCode: string, sessionToken: string): Promise<GetRoomResponse> {
  return request<GetRoomResponse>(`/api/rooms/${roomCode.trim().toUpperCase()}`, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${sessionToken}`,
    },
  });
}

export async function updateParticipantRole(
  roomCode: string,
  participantId: string,
  role: Role,
  sessionToken: string
): Promise<any> {
  return request<any>(`/api/rooms/${roomCode.trim().toUpperCase()}/participants/${participantId}/role`, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${sessionToken}`,
    },
    body: JSON.stringify({ role }),
  });
}

export async function removeParticipant(
  roomCode: string,
  participantId: string,
  sessionToken: string
): Promise<any> {
  return request<any>(`/api/rooms/${roomCode.trim().toUpperCase()}/participants/${participantId}`, {
    method: 'DELETE',
    headers: {
      Authorization: `Bearer ${sessionToken}`,
    },
  });
}

export async function transferHostRole(
  roomCode: string,
  newHostParticipantId: string,
  sessionToken: string
): Promise<{ message: string; formerHost: any; newHost: any }> {
  return request<{ message: string; formerHost: any; newHost: any }>(
    `/api/rooms/${roomCode.trim().toUpperCase()}/transfer-host`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${sessionToken}`,
      },
      body: JSON.stringify({ newHostParticipantId }),
    }
  );
}

export async function checkBackendHealth(): Promise<{ status: string }> {
  return request<{ status: string }>('/api/health', { method: 'GET' });
}

export interface YouTubeSearchResult {
  videoId: string;
  title: string;
  channelTitle: string;
  thumbnailUrl: string;
  durationSec: number;
  durationFormatted: string;
}

export interface YouTubeSearchResponse {
  query: string;
  count: number;
  cached: boolean;
  results: YouTubeSearchResult[];
}

/**
 * Searches YouTube videos via the room-authorized backend proxy.
 * Available only to Host and Moderator.
 */
export async function searchYouTubeVideos(
  roomCode: string,
  query: string,
  sessionToken: string
): Promise<YouTubeSearchResponse> {
  return request<YouTubeSearchResponse>(
    `/api/rooms/${roomCode.trim().toUpperCase()}/search?q=${encodeURIComponent(query.trim())}`,
    {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${sessionToken}`,
      },
    }
  );
}

export interface YouTubeRecommendationsResponse {
  success: boolean;
  count: number;
  recommendations: Array<{
    videoId: string;
    title: string;
    channelTitle: string;
    thumbnailUrl: string;
    durationSec: number;
    durationFormatted: string;
    description?: string;
  }>;
}

/**
 * Fetches YouTube video recommendations related to the current playing video.
 * Accessible to all room participants.
 */
export async function getYouTubeRecommendations(
  roomCode: string,
  sessionToken: string,
  options?: { videoId?: string; title?: string; channel?: string; limit?: number }
): Promise<YouTubeRecommendationsResponse> {
  const params = new URLSearchParams();
  if (options?.videoId) params.set('videoId', options.videoId);
  if (options?.title) params.set('title', options.title);
  if (options?.channel) params.set('channel', options.channel);
  if (options?.limit) params.set('limit', String(options.limit));

  const queryStr = params.toString() ? `?${params.toString()}` : '';
  return request<YouTubeRecommendationsResponse>(
    `/api/rooms/${roomCode.trim().toUpperCase()}/recommendations${queryStr}`,
    {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${sessionToken}`,
      },
    }
  );
}

/**
 * Retrieves detailed metadata for a YouTube video via the backend proxy.
 */
export async function getVideoDetails(
  roomCode: string,
  sessionToken: string,
  videoId: string
): Promise<{ success: boolean; details: any }> {
  return request<{ success: boolean; details: any }>(
    `/api/rooms/${roomCode.trim().toUpperCase()}/video-details?videoId=${encodeURIComponent(videoId.trim())}`,
    {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${sessionToken}`,
      },
    }
  );
}

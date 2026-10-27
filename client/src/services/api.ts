import type {
  CreateRoomResponse,
  JoinRoomResponse,
  GetRoomResponse,
  Role,
} from '../types/room';

const BACKEND_URL = (import.meta.env.VITE_BACKEND_URL || 'http://localhost:5000').replace(/\/+$/, '');

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

export async function joinRoom(roomCode: string, displayName: string): Promise<JoinRoomResponse> {
  return request<JoinRoomResponse>(`/api/rooms/${roomCode.trim().toUpperCase()}/join`, {
    method: 'POST',
    body: JSON.stringify({ displayName: displayName.trim() }),
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

import { useEffect, useRef, useState, useCallback } from 'react';
import { io, type Socket } from 'socket.io-client';
import type {
  ParticipantData,
  SafePlaybackState,
  SafeControlRequest,
  RequestType,
  Role,
  RoleRequest,
} from '../types/room';

const SOCKET_URL = (
  import.meta.env.VITE_SOCKET_URL ||
  import.meta.env.VITE_BACKEND_URL ||
  'http://localhost:5000'
).replace(/\/+$/, '');

/** Wraps a socket.emit-with-ack in a timeout promise to prevent indefinite hangs. */
function emitWithTimeout<T>(
  socket: Socket,
  event: string,
  payload: unknown,
  timeoutMs = 15000
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Socket event "${event}" timed out after ${timeoutMs / 1000}s`));
    }, timeoutMs);
    socket.emit(event, payload, (res: T) => {
      clearTimeout(timer);
      resolve(res);
    });
  });
}

export interface UseWatchPartySocketOptions {
  roomCode: string | null;
  sessionToken: string | null;
  onKicked?: (reason: string) => void;
  onError?: (message: string, code?: string) => void;
}

export function useWatchPartySocket(options: UseWatchPartySocketOptions) {
  const { roomCode, sessionToken, onKicked, onError } = options;

  const socketRef = useRef<Socket | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  const [isJoined, setIsJoined] = useState(false);
  const [roster, setRoster] = useState<ParticipantData[]>([]);
  const [playbackState, setPlaybackState] = useState<SafePlaybackState | null>(null);
  const [controlRequests, setControlRequests] = useState<SafeControlRequest[]>([]);
  const [roleRequests, setRoleRequests] = useState<RoleRequest[]>([]);
  const [lastNotice, setLastNotice] = useState<string | null>(null);

  // Keep callback props in stable refs to prevent tearing down the socket connection on every re-render
  const onKickedRef = useRef(onKicked);
  const onErrorRef = useRef(onError);
  useEffect(() => { onKickedRef.current = onKicked; }, [onKicked]);
  useEffect(() => { onErrorRef.current = onError; }, [onError]);

  // Track locally initiated action to avoid echo loops
  const lastSyncTokenRef = useRef<string | null>(null);

  useEffect(() => {
    if (!roomCode || !sessionToken) {
      if (socketRef.current) {
        socketRef.current.disconnect();
        socketRef.current = null;
      }
      setIsConnected(false);
      setIsJoined(false);
      return;
    }

    const socket = io(SOCKET_URL, {
      transports: ['websocket', 'polling'],
      autoConnect: true,
      auth: {
        token: sessionToken,
        roomCode,
      },
      reconnectionAttempts: 10,
      reconnectionDelay: 1000,
    });

    socketRef.current = socket;

    socket.on('connect', () => {
      setIsConnected(true);
      // Join authorized room
      socket.emit(
        'room:join',
        { roomCode },
        (res: { success: boolean; roster?: ParticipantData[]; playback?: SafePlaybackState; error?: string }) => {
          if (res.success) {
            setIsJoined(true);
            if (res.roster) setRoster(res.roster);
            if (res.playback) setPlaybackState(res.playback);

            // Fetch initial list of requests now that room channel is joined
            socket.emit('request:list', {}, (reqRes: { success: boolean; requests?: SafeControlRequest[] }) => {
              if (reqRes?.success && Array.isArray(reqRes.requests)) {
                setControlRequests(reqRes.requests);
              }
            });
          } else if (res.error) {
            onErrorRef.current?.(res.error);
          }
        }
      );
    });

    socket.on('disconnect', (reason) => {
      setIsConnected(false);
      setIsJoined(false);
      if (reason === 'io server disconnect') {
        // Server forcefully disconnected
      }
    });

    socket.on('connect_error', (err) => {
      setIsConnected(false);
      onErrorRef.current?.(err.message, 'CONNECT_ERROR');
    });

    // Room joined event
    socket.on(
      'room:joined',
      (data: { roomCode: string; participant: ParticipantData; roster: ParticipantData[]; playback: SafePlaybackState }) => {
        setIsJoined(true);
        if (data.roster) setRoster(data.roster);
        if (data.playback) setPlaybackState(data.playback);

        // Fetch initial list of requests
        socket.emit('request:list', {}, (reqRes: { success: boolean; requests?: SafeControlRequest[] }) => {
          if (reqRes?.success && Array.isArray(reqRes.requests)) {
            setControlRequests(reqRes.requests);
          }
        });
      }
    );

    // Roster broadcasts
    socket.on('room:roster', (data: { participants: ParticipantData[] }) => {
      if (Array.isArray(data.participants)) {
        setRoster(data.participants);
      }
    });

    socket.on('room:participant-joined', (data: { participant: ParticipantData }) => {
      setLastNotice(`${data.participant.displayName} joined the party`);
    });

    socket.on('room:participant-left', (data: { participantId: string; displayName: string }) => {
      setLastNotice(`${data.displayName} left the party`);
    });

    socket.on('room:kicked', (data: { reason: string }) => {
      setIsJoined(false);
      setIsConnected(false);
      onKickedRef.current?.(data.reason || 'You have been removed from the room by the Host');
    });

    // Playback state updates (with stale packet protection)
    socket.on('playback:state', (data: { state: SafePlaybackState }) => {
      if (data?.state) {
        setPlaybackState((prev) => {
          // Reject stale out-of-order packets for the same video
          if (
            prev?.currentVideoId === data.state.currentVideoId &&
            prev?.serverTime &&
            data.state.serverTime &&
            data.state.serverTime < prev.serverTime
          ) {
            return prev;
          }
          return data.state;
        });
      }
    });

    // Host ownership transfer event
    socket.on(
      'room:host-transferred',
      (data: { previousHostId: string; newHostId: string; newHostDisplayName: string }) => {
        setLastNotice(`${data.newHostDisplayName} is now the Room Host`);
      }
    );

    // Control request events
    socket.on('request:created', (data: { request: SafeControlRequest }) => {
      if (data?.request) {
        setControlRequests((prev) => {
          const exists = prev.some((r) => r.id === data.request.id);
          if (exists) return prev;
          return [data.request, ...prev];
        });
        setLastNotice(`${data.request.participant.displayName} requested: ${data.request.type}`);
      }
    });

    socket.on('request:resolved', (data: { request: SafeControlRequest }) => {
      if (data?.request) {
        setControlRequests((prev) =>
          prev.map((r) => (r.id === data.request.id ? data.request : r))
        );
        const actionText = data.request.status === 'APPROVED' ? 'approved' : 'rejected';
        setLastNotice(`Request was ${actionText}`);
      }
    });

    // Role request events
    socket.on('role:requested', (data: RoleRequest) => {
      if (data?.requestId) {
        setRoleRequests((prev) => {
          if (prev.some((r) => r.requestId === data.requestId)) return prev;
          return [data, ...prev];
        });
        setLastNotice(`${data.participant.displayName} requested Moderator role`);
      }
    });

    socket.on('role:request-resolved', (data: { requestId: string; participantId: string; displayName?: string; status: string }) => {
      if (data?.requestId) {
        setRoleRequests((prev) => prev.filter((r) => r.requestId !== data.requestId));
      }
    });

    socket.on('error', (data: { message: string; code?: string }) => {
      onErrorRef.current?.(data.message, data.code);
    });

    return () => {
      socket.emit('room:leave');
      socket.disconnect();
      socketRef.current = null;
    };
  }, [roomCode, sessionToken]);

  // Helper to generate echo-prevention sync token
  const createSyncToken = () => {
    const token = `cli-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    lastSyncTokenRef.current = token;
    return token;
  };

  // Playback Commands
  const playVideo = useCallback(
    (timestamp?: number, playbackRate?: number): Promise<boolean> => {
      return new Promise((resolve) => {
        if (!socketRef.current) return resolve(false);
        const syncToken = createSyncToken();
        emitWithTimeout<{ success: boolean; state?: SafePlaybackState; error?: string }>(
          socketRef.current,
          'playback:play',
          { timestamp, playbackRate, syncToken }
        )
          .then((res) => {
            if (res.success && res.state) {
              setPlaybackState(res.state);
              resolve(true);
            } else {
              if (res.error) onErrorRef.current?.(res.error);
              resolve(false);
            }
          })
          .catch((err) => {
            onErrorRef.current?.(err.message || 'Playback command timed out');
            resolve(false);
          });
      });
    },
    []
  );

  const pauseVideo = useCallback(
    (timestamp?: number): Promise<boolean> => {
      return new Promise((resolve) => {
        if (!socketRef.current) return resolve(false);
        const syncToken = createSyncToken();
        emitWithTimeout<{ success: boolean; state?: SafePlaybackState; error?: string }>(
          socketRef.current,
          'playback:pause',
          { timestamp, syncToken }
        )
          .then((res) => {
            if (res.success && res.state) {
              setPlaybackState(res.state);
              resolve(true);
            } else {
              if (res.error) onErrorRef.current?.(res.error);
              resolve(false);
            }
          })
          .catch((err) => {
            onErrorRef.current?.(err.message || 'Pause command timed out');
            resolve(false);
          });
      });
    },
    []
  );

  const seekVideo = useCallback(
    (timestamp: number): Promise<boolean> => {
      return new Promise((resolve) => {
        if (!socketRef.current) return resolve(false);
        const syncToken = createSyncToken();
        emitWithTimeout<{ success: boolean; state?: SafePlaybackState; error?: string }>(
          socketRef.current,
          'playback:seek',
          { timestamp, syncToken }
        )
          .then((res) => {
            if (res.success && res.state) {
              setPlaybackState(res.state);
              resolve(true);
            } else {
              if (res.error) onErrorRef.current?.(res.error);
              resolve(false);
            }
          })
          .catch((err) => {
            onErrorRef.current?.(err.message || 'Seek command timed out');
            resolve(false);
          });
      });
    },
    []
  );

  const changeVideo = useCallback(
    (videoId: string): Promise<boolean> => {
      return new Promise((resolve) => {
        if (!socketRef.current) {
          onErrorRef.current?.('Not connected to room. Please wait for reconnection.');
          return resolve(false);
        }
        const syncToken = createSyncToken();
        emitWithTimeout<{ success: boolean; state?: SafePlaybackState; error?: string }>(
          socketRef.current,
          'playback:change-video',
          { videoId, syncToken }
        )
          .then((res) => {
            if (res.success && res.state) {
              setPlaybackState(res.state);
              resolve(true);
            } else {
              if (res.error) onErrorRef.current?.(res.error);
              resolve(false);
            }
          })
          .catch((err) => {
            onErrorRef.current?.(err.message || 'Video change request timed out. Server may be starting up, please retry.');
            resolve(false);
          });
      });
    },
    []
  );

  const setPlaybackRate = useCallback(
    (playbackRate: number): Promise<boolean> => {
      return new Promise((resolve) => {
        if (!socketRef.current) return resolve(false);
        const syncToken = createSyncToken();
        emitWithTimeout<{ success: boolean; state?: SafePlaybackState; error?: string }>(
          socketRef.current,
          'playback:set-rate',
          { playbackRate, syncToken }
        )
          .then((res) => {
            if (res.success && res.state) {
              setPlaybackState(res.state);
              resolve(true);
            } else {
              if (res.error) onErrorRef.current?.(res.error);
              resolve(false);
            }
          })
          .catch((err) => {
            onErrorRef.current?.(err.message || 'Playback rate change timed out');
            resolve(false);
          });
      });
    },
    []
  );

  // Control Requests
  const createControlRequest = useCallback(
    (
      type: RequestType,
      targetTimestamp?: number,
      targetVideoId?: string
    ): Promise<{ success: boolean; error?: string }> => {
      return new Promise((resolve) => {
        if (!socketRef.current) return resolve({ success: false, error: 'Socket disconnected' });
        socketRef.current.emit(
          'request:create',
          { type, targetTimestamp, targetVideoId },
          (res: { success: boolean; request?: SafeControlRequest; error?: string }) => {
            if (res.success && res.request) {
              setControlRequests((prev) => [res.request!, ...prev]);
              resolve({ success: true });
            } else {
              resolve({ success: false, error: res.error || 'Failed to submit request' });
            }
          }
        );
      });
    },
    []
  );

  const approveControlRequest = useCallback(
    (requestId: string): Promise<boolean> => {
      return new Promise((resolve) => {
        if (!socketRef.current) return resolve(false);
        socketRef.current.emit(
          'request:approve',
          { requestId },
          (res: { success: boolean; request?: SafeControlRequest; state?: SafePlaybackState; error?: string }) => {
            if (res.success) {
              if (res.request) {
                setControlRequests((prev) =>
                  prev.map((r) => (r.id === requestId ? res.request! : r))
                );
              }
              if (res.state) {
                setPlaybackState(res.state);
              }
              resolve(true);
            } else {
              if (res.error) onErrorRef.current?.(res.error);
              resolve(false);
            }
          }
        );
      });
    },
    []
  );

  const rejectControlRequest = useCallback(
    (requestId: string): Promise<boolean> => {
      return new Promise((resolve) => {
        if (!socketRef.current) return resolve(false);
        socketRef.current.emit(
          'request:reject',
          { requestId },
          (res: { success: boolean; request?: SafeControlRequest; error?: string }) => {
            if (res.success) {
              if (res.request) {
                setControlRequests((prev) =>
                  prev.map((r) => (r.id === requestId ? res.request! : r))
                );
              }
              resolve(true);
            } else {
              if (res.error) onErrorRef.current?.(res.error);
              resolve(false);
            }
          }
        );
      });
    },
    []
  );

  const transferHost = useCallback(
    (targetParticipantId: string): Promise<boolean> => {
      return new Promise((resolve) => {
        if (!socketRef.current) return resolve(false);
        socketRef.current.emit(
          'room:transfer-host',
          { targetParticipantId },
          (res: { success: boolean; error?: string }) => {
            if (res.success) {
              resolve(true);
            } else {
              if (res.error) onErrorRef.current?.(res.error);
              resolve(false);
            }
          }
        );
      });
    },
    []
  );

  const requestRole = useCallback(
    (requestedRole: Role = 'MODERATOR'): Promise<{ success: boolean; error?: string }> => {
      return new Promise((resolve) => {
        if (!socketRef.current) return resolve({ success: false, error: 'Socket disconnected' });
        socketRef.current.emit(
          'role:request',
          { requestedRole },
          (res: { success: boolean; requestId?: string; error?: string }) => {
            if (res.success) {
              resolve({ success: true });
            } else {
              resolve({ success: false, error: res.error || 'Failed to submit role request' });
            }
          }
        );
      });
    },
    []
  );

  const resolveRoleRequest = useCallback(
    (requestId: string, participantId: string, action: 'APPROVE' | 'REJECT'): Promise<boolean> => {
      return new Promise((resolve) => {
        if (!socketRef.current) return resolve(false);
        socketRef.current.emit(
          'role:resolve-request',
          { requestId, participantId, action },
          (res: { success: boolean; error?: string; status?: string }) => {
            if (res.success) {
              setRoleRequests((prev) => prev.filter((r) => r.requestId !== requestId));
              resolve(true);
            } else {
              if (res.error) onErrorRef.current?.(res.error);
              resolve(false);
            }
          }
        );
      });
    },
    []
  );

  return {
    isConnected,
    isJoined,
    roster,
    playbackState,
    controlRequests,
    roleRequests,
    lastNotice,
    lastSyncTokenRef,
    playVideo,
    pauseVideo,
    seekVideo,
    changeVideo,
    setPlaybackRate,
    createControlRequest,
    approveControlRequest,
    rejectControlRequest,
    transferHost,
    requestRole,
    resolveRoleRequest,
  };
}

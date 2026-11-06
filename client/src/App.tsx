import { useEffect, useState, useCallback } from 'react';
import type { RoomData, ParticipantData, Role, RequestType } from './types/room';
import {
  createRoom as apiCreateRoom,
  joinRoom as apiJoinRoom,
  getRoom as apiGetRoom,
  updateParticipantRole as apiUpdateRole,
  removeParticipant as apiRemoveParticipant,
  transferHostRole as apiTransferHost,
  ApiError,
} from './services/api';
import {
  saveRoomSession,
  getStoredRoomSession,
  clearRoomSession,
} from './services/storage';
import { useWatchPartySocket } from './hooks/useWatchPartySocket';
import { Navbar } from './components/Navbar';
import { LandingPage } from './components/LandingPage';
import { CinematicPlayer } from './components/CinematicPlayer';
import { ParticipantRoster } from './components/ParticipantRoster';
import { ChangeVideoModal } from './components/ChangeVideoModal';
import { YouTubeSearchModal } from './components/YouTubeSearchModal';
import { QueueDrawer } from './components/QueueDrawer';
import { CarModeView } from './components/CarModeView';
import { PhoneRemoteView } from './components/PhoneRemoteView';
import { RemoteQRModal } from './components/RemoteQRModal';
import { ControlRequestsModal } from './components/ControlRequestsModal';
import { RoleRequestPopup } from './components/RoleRequestPopup';
import { Toast } from './components/Toast';
import './index.css';
import './landing.css';

type AppMode = 'standard' | 'car' | 'remote';

export default function App() {
  // Mode State derived from URL query parameter
  const getInitialMode = (): AppMode => {
    try {
      const params = new URLSearchParams(window.location.search);
      const m = params.get('mode');
      // Remote mode is preserved when joining via QR link
      if (m === 'remote') return 'remote';
      // Car mode is ONLY preserved when reconnecting/refreshing an active stored session
      if (m === 'car' && getStoredRoomSession()) return 'car';
    } catch {}
    return 'standard';
  };

  const [currentMode, setCurrentMode] = useState<AppMode>(getInitialMode);

  // Session & Room State
  const [sessionToken, setSessionToken] = useState<string | null>(null);
  const [currentParticipant, setCurrentParticipant] = useState<ParticipantData | null>(null);
  const [room, setRoom] = useState<RoomData | null>(null);

  // UI state
  const [isInitializing, setIsInitializing] = useState(true);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const [toastType, setToastType] = useState<'info' | 'success' | 'error'>('info');

  // Modals & Drawers
  const [isSearchModalOpen, setIsSearchModalOpen] = useState(false);
  const [isQueueDrawerOpen, setIsQueueDrawerOpen] = useState(false);
  const [isRemoteQROpen, setIsRemoteQROpen] = useState(false);
  const [isChangeVideoModalOpen, setIsChangeVideoModalOpen] = useState(false);
  const [isRequestsModalOpen, setIsRequestsModalOpen] = useState(false);

  // Notification helper
  const notify = useCallback((msg: string, type: 'info' | 'success' | 'error' = 'info') => {
    setToastMessage(msg);
    setToastType(type);
  }, []);

  const handleKicked = useCallback((reason: string) => {
    clearRoomSession();
    setRoom(null);
    setCurrentParticipant(null);
    setSessionToken(null);
    setCurrentMode('standard');
    try {
      window.history.replaceState(null, '', window.location.pathname);
    } catch {}
    notify(reason, 'error');
  }, [notify]);

  const handleSocketError = useCallback((msg: string) => {
    notify(msg, 'error');
  }, [notify]);

  // Mode Switching
  const handleToggleMode = (newMode: AppMode) => {
    setCurrentMode(newMode);
    try {
      const url = new URL(window.location.href);
      if (newMode === 'standard') {
        url.searchParams.delete('mode');
      } else {
        url.searchParams.set('mode', newMode);
      }
      window.history.replaceState(null, '', url.toString());
    } catch {}
  };

  // Socket Hook
  const {
    isConnected,
    roster,
    playbackState,
    queue,
    controlRequests,
    roleRequests,
    lastNotice,
    playVideo,
    pauseVideo,
    seekVideo,
    changeVideo,
    setPlaybackRate,
    createControlRequest,
    approveControlRequest,
    rejectControlRequest,
    requestRole,
    resolveRoleRequest,
    addToQueue,
    removeFromQueue,
    reorderQueue,
    playNextInQueue,
    clearQueue,
    notifyVideoEnded,
    syncVideoMetadata,
  } = useWatchPartySocket({
    roomCode: room?.code || null,
    sessionToken,
    onKicked: handleKicked,
    onError: handleSocketError,
  });

  const [dismissedRoleRequestIds, setDismissedRoleRequestIds] = useState<Set<string>>(new Set());

  // Display socket notices via Toast
  useEffect(() => {
    if (lastNotice) {
      notify(lastNotice, 'info');
    }
  }, [lastNotice, notify]);

  // Session recovery on refresh
  useEffect(() => {
    const restoreSession = async () => {
      const stored = getStoredRoomSession();
      if (!stored) {
        setIsInitializing(false);
        // Clean up any stale mode=car from URL if no active room session exists
        try {
          const params = new URLSearchParams(window.location.search);
          if (params.get('mode') === 'car') {
            params.delete('mode');
            const newQuery = params.toString();
            window.history.replaceState(null, '', window.location.pathname + (newQuery ? `?${newQuery}` : ''));
          }
        } catch {}
        return;
      }

      // If the URL explicitly requests a different room than what is stored,
      // clear the stale session so the user can join the newly requested room.
      try {
        const params = new URLSearchParams(window.location.search);
        const requestedCode = (params.get('room') || params.get('code') || '').trim().toUpperCase();
        if (requestedCode && requestedCode !== stored.roomCode) {
          clearRoomSession();
          setIsInitializing(false);
          return;
        }
      } catch {}

      try {
        const data = await apiGetRoom(stored.roomCode, stored.token);
        setRoom(data.room);
        setCurrentParticipant(data.currentParticipant);
        setSessionToken(stored.token);
      } catch (err: unknown) {
        clearRoomSession();
        if (err instanceof ApiError && (err.statusCode === 401 || err.statusCode === 404)) {
          notify('Previous session has expired. Please create or join a room.', 'info');
        }
      } finally {
        setIsInitializing(false);
      }
    };

    restoreSession();
  }, [notify]);

  // Handle Room Creation
  const handleCreateRoom = async (displayName: string, title?: string) => {
    if (isSubmitting) return;
    setIsSubmitting(true);
    setErrorMessage(null);
    try {
      const res = await apiCreateRoom(displayName, title);
      saveRoomSession({
        roomCode: res.room.code,
        token: res.sessionToken,
        participantId: res.participant.id,
        displayName: res.participant.displayName,
      });
      // Creating a room MUST enter Standard Mode by default
      setCurrentMode('standard');
      try {
        const url = new URL(window.location.href);
        url.searchParams.delete('mode');
        window.history.replaceState(null, '', url.pathname + (url.search ? url.search : ''));
      } catch {}
      setRoom(res.room);
      setCurrentParticipant(res.participant);
      setSessionToken(res.sessionToken);
      notify('Room created successfully! Share the code to invite friends.', 'success');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to create room';
      setErrorMessage(msg);
    } finally {
      setIsSubmitting(false);
    }
  };

  // Handle Room Joining
  const handleJoinRoom = async (roomCode: string, displayName: string, inviteToken?: string) => {
    if (isSubmitting) return;
    setIsSubmitting(true);
    setErrorMessage(null);
    try {
      const res = await apiJoinRoom(roomCode, displayName, inviteToken);
      saveRoomSession({
        roomCode: res.room.code,
        token: res.sessionToken,
        participantId: res.participant.id,
        displayName: res.participant.displayName,
      });
      // If user had stale car mode in memory/URL, reset to standard unless in remote mode
      if (currentMode === 'car') {
        setCurrentMode('standard');
        try {
          const url = new URL(window.location.href);
          url.searchParams.delete('mode');
          window.history.replaceState(null, '', url.pathname + (url.search ? url.search : ''));
        } catch {}
      }
      setRoom(res.room);
      setCurrentParticipant(res.participant);
      setSessionToken(res.sessionToken);
      if (res.participant.role === 'MODERATOR') {
        notify(`Joined room ${res.room.code} as Moderator! Remote control active.`, 'success');
      } else {
        notify(`Joined room ${res.room.code}!`, 'success');
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to join room';
      setErrorMessage(msg);
    } finally {
      setIsSubmitting(false);
    }
  };

  // Handle Leave Room
  const handleLeaveRoom = () => {
    clearRoomSession();
    setRoom(null);
    setCurrentParticipant(null);
    setSessionToken(null);
    setCurrentMode('standard');
    try {
      // Clean query parameters so landing page is pristine
      window.history.replaceState(null, '', window.location.pathname);
    } catch {}
    notify('You left the room.', 'info');
  };

  // Handle Role Update (Host action)
  const handleUpdateRole = async (participantId: string, role: Role) => {
    if (!room || !sessionToken) return;
    try {
      await apiUpdateRole(room.code, participantId, role, sessionToken);
      notify(`Participant role updated to ${role}`, 'success');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to update role';
      notify(msg, 'error');
    }
  };

  // Handle Participant Removal (Host action)
  const handleRemoveParticipant = async (participantId: string) => {
    if (!room || !sessionToken) return;
    try {
      await apiRemoveParticipant(room.code, participantId, sessionToken);
      notify('Participant removed from room', 'info');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to remove participant';
      notify(msg, 'error');
    }
  };

  // Handle Host Ownership Transfer (Host action)
  const handleTransferHost = async (participantId: string) => {
    if (!room || !sessionToken) return;
    const target = roster.find((p) => p.id === participantId);
    const targetName = target?.displayName || 'participant';
    if (!window.confirm(`Transfer Room Host ownership to ${targetName}? You will become a Moderator.`)) {
      return;
    }
    try {
      await apiTransferHost(room.code, participantId, sessionToken);
      notify(`Room ownership transferred to ${targetName}!`, 'success');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to transfer host ownership';
      notify(msg, 'error');
    }
  };

  // Role Request Handlers
  const handleApproveRoleRequest = async (requestId: string, participantId: string): Promise<boolean> => {
    const success = await resolveRoleRequest(requestId, participantId, 'APPROVE');
    if (success) {
      notify('Role request approved — participant is now Moderator', 'success');
    }
    return success;
  };

  const handleRejectRoleRequest = async (requestId: string, participantId: string): Promise<boolean> => {
    const success = await resolveRoleRequest(requestId, participantId, 'REJECT');
    if (success) {
      notify('Role request rejected', 'info');
    }
    return success;
  };

  const handleDismissRoleRequest = (requestId: string) => {
    setDismissedRoleRequestIds((prev) => new Set([...prev, requestId]));
  };

  const handleRequestModerator = async () => {
    const res = await requestRole('MODERATOR');
    if (res.success) {
      notify('Requested Moderator role from the Room Host', 'success');
    } else {
      notify(res.error || 'Failed to submit role request', 'error');
      throw new Error(res.error);
    }
  };

  // Synchronize current user's role from live roster updates
  const activeUserRole: Role =
    roster.find((p) => p.id === currentParticipant?.id)?.role ||
    currentParticipant?.role ||
    'PARTICIPANT';

  // Only the current Host sees and resolves role change requests
  const pendingRoleRequests = (activeUserRole === 'HOST' ? roleRequests : []).filter(
    (r) => !dismissedRoleRequestIds.has(r.requestId)
  );

  const pendingRequestsCount = controlRequests.filter((r) => r.status === 'PENDING').length;

  if (isInitializing) {
    return (
      <div className="loading-screen">
        <span className="mini-spinner" style={{ width: 32, height: 32 }} />
        <p style={{ marginTop: '1rem', color: 'var(--text-secondary)' }}>
          Restoring watch party session...
        </p>
      </div>
    );
  }

  return (
    <>
      {/* 1. Unauthenticated Landing Screen */}
      {!room ? (
        <LandingPage
          onCreateRoom={handleCreateRoom}
          onJoinRoom={handleJoinRoom}
          isLoading={isSubmitting}
          errorMessage={errorMessage}
          onClearError={() => setErrorMessage(null)}
        />
      ) : (
        <>
          {/* 2. Room Navbar (Visible in Standard Mode) */}
          {currentMode === 'standard' && (
            <Navbar
              roomCode={room.code}
              roomTitle={room.title}
              isConnected={isConnected}
              participantCount={roster.length}
              currentMode={currentMode}
              queueCount={queue.filter((i) => i.status === 'QUEUED').length}
              userRole={activeUserRole}
              onLeaveRoom={handleLeaveRoom}
              onToggleMode={handleToggleMode}
              onOpenQueue={() => setIsQueueDrawerOpen(true)}
              onOpenSearch={() => setIsSearchModalOpen(true)}
              onOpenRemoteQR={() => setIsRemoteQROpen(true)}
            />
          )}

          {/* Real-time Role Request Popup (Host viewport top) */}
          <RoleRequestPopup
            requests={pendingRoleRequests}
            onApprove={handleApproveRoleRequest}
            onReject={handleRejectRoleRequest}
            onDismiss={handleDismissRoleRequest}
          />

          {/* 3. MODE: CAR MODE */}
          {currentMode === 'car' && (
            <CarModeView
              roomCode={room.code}
              roomTitle={room.title}
              userRole={activeUserRole}
              playbackState={playbackState}
              queue={queue}
              roster={roster}
              currentUserId={currentParticipant?.id}
              sessionToken={sessionToken}
              onExitCarMode={() => handleToggleMode('standard')}
              onOpenSearch={() => setIsSearchModalOpen(true)}
              onOpenQueue={() => setIsQueueDrawerOpen(true)}
              onOpenRemoteQR={() => setIsRemoteQROpen(true)}
              onPlay={playVideo}
              onPause={pauseVideo}
              onSeek={seekVideo}
              onSetRate={setPlaybackRate}
              onPlayNext={playNextInQueue}
              onPlayRecommendation={async (videoId, meta) => {
                const success = await changeVideo(videoId, meta);
                if (success) {
                  notify('Now playing suggested track!', 'success');
                }
                return success;
              }}
              onAddToQueue={async (item) => {
                const res = await addToQueue(item);
                if (res.success) {
                  notify('Added song to shared queue!', 'success');
                }
                return res;
              }}
              onVideoEnded={notifyVideoEnded}
              onMetadataDiscovered={syncVideoMetadata}
              onUpdateRole={handleUpdateRole}
              onRemoveParticipant={handleRemoveParticipant}
              onTransferHost={handleTransferHost}
            />
          )}

          {/* 4. MODE: PHONE REMOTE (Zero video players mounted) */}
          {currentMode === 'remote' && (
            <PhoneRemoteView
              roomCode={room.code}
              roomTitle={room.title}
              userRole={activeUserRole}
              playbackState={playbackState}
              queue={queue}
              sessionToken={sessionToken}
              onExitRemoteMode={() => handleToggleMode('standard')}
              onOpenSearch={() => setIsSearchModalOpen(true)}
              onOpenQueue={() => setIsQueueDrawerOpen(true)}
              onPlay={playVideo}
              onPause={pauseVideo}
              onSeek={seekVideo}
              onSetRate={setPlaybackRate}
              onPlayNext={playNextInQueue}
              onPlayRecommendation={async (videoId, meta) => {
                const success = await changeVideo(videoId, meta);
                if (success) {
                  notify('Playing track on Car Screen!', 'success');
                }
                return success;
              }}
              onRemoveItem={removeFromQueue}
              onReorderItem={reorderQueue}
              onRequestModerator={activeUserRole === 'PARTICIPANT' ? handleRequestModerator : undefined}
            />
          )}

          {/* 5. MODE: STANDARD WATCH PARTY */}
          {currentMode === 'standard' && (
            <main className="main-content">
              <div className="watch-party-layout">
                {/* Left Area: Video Player & Controls */}
                <div className="player-column">
                  <CinematicPlayer
                    userRole={activeUserRole}
                    playbackState={playbackState}
                    pendingRequestsCount={pendingRequestsCount}
                    onPlay={playVideo}
                    onPause={pauseVideo}
                    onSeek={seekVideo}
                    onSetRate={setPlaybackRate}
                    onOpenChangeVideoModal={() => setIsSearchModalOpen(true)}
                    onOpenRequestsModal={() => setIsRequestsModalOpen(true)}
                    onVideoEnded={notifyVideoEnded}
                    onMetadataDiscovered={syncVideoMetadata}
                  />
                </div>

                {/* Right Area: Participant Roster */}
                <aside className="roster-column">
                  <ParticipantRoster
                    participants={roster}
                    currentUserId={currentParticipant?.id || ''}
                    currentUserRole={activeUserRole}
                    onUpdateRole={handleUpdateRole}
                    onRemoveParticipant={handleRemoveParticipant}
                    onTransferHost={handleTransferHost}
                    onRequestModerator={activeUserRole === 'PARTICIPANT' ? handleRequestModerator : undefined}
                  />
                </aside>
              </div>
            </main>
          )}

          {/* 6. YouTube Search Modal (Host / Moderator) */}
          <YouTubeSearchModal
            isOpen={isSearchModalOpen}
            onClose={() => setIsSearchModalOpen(false)}
            roomCode={room.code}
            sessionToken={sessionToken || ''}
            userRole={activeUserRole}
            onAddToQueue={addToQueue}
            onPlayNow={async (videoId) => {
              const success = await changeVideo(videoId);
              if (success) {
                notify('Video loaded for the room!', 'success');
              }
              return success;
            }}
          />

          {/* 7. Shared Queue Drawer */}
          <QueueDrawer
            isOpen={isQueueDrawerOpen}
            onClose={() => setIsQueueDrawerOpen(false)}
            queue={queue}
            currentVideoId={playbackState?.currentVideoId}
            userRole={activeUserRole}
            onOpenSearch={() => {
              setIsQueueDrawerOpen(false);
              setIsSearchModalOpen(true);
            }}
            onRemoveItem={removeFromQueue}
            onReorderItem={reorderQueue}
            onPlayNext={playNextInQueue}
            onClearQueue={clearQueue}
          />

          {/* 8. Connect Phone Remote QR Modal */}
          <RemoteQRModal
            isOpen={isRemoteQROpen}
            onClose={() => setIsRemoteQROpen(false)}
            roomCode={room.code}
            sessionToken={sessionToken}
            isHost={activeUserRole === 'HOST'}
            participantCount={roster.length}
            isConnected={isConnected}
          />

          {/* 9. Direct Link Change Video Modal (Fallback) */}
          <ChangeVideoModal
            isOpen={isChangeVideoModalOpen}
            onClose={() => setIsChangeVideoModalOpen(false)}
            onSubmitVideo={async (videoId) => {
              const success = await changeVideo(videoId);
              if (success) {
                notify('Video loaded for the room!', 'success');
              }
              return success;
            }}
          />

          {/* 10. Control Requests Modal */}
          <ControlRequestsModal
            isOpen={isRequestsModalOpen}
            onClose={() => setIsRequestsModalOpen(false)}
            userRole={activeUserRole}
            requests={controlRequests}
            hasVideoSelected={Boolean(playbackState?.currentVideoId)}
            currentTimestamp={playbackState?.currentTimestamp || 0}
            onSubmitRequest={async (type: RequestType, ts?: number, vid?: string) => {
              const res = await createControlRequest(type, ts, vid);
              if (res.success) {
                notify(`Playback request (${type}) submitted!`, 'success');
              }
              return res;
            }}
            onApproveRequest={async (id) => {
              const success = await approveControlRequest(id);
              if (success) {
                notify('Request approved and executed!', 'success');
              }
              return success;
            }}
            onRejectRequest={async (id) => {
              const success = await rejectControlRequest(id);
              if (success) {
                notify('Request rejected', 'info');
              }
              return success;
            }}
          />
        </>
      )}

      {/* Toast Notification */}
      <Toast
        message={toastMessage}
        type={toastType}
        onDismiss={() => setToastMessage(null)}
      />
    </>
  );
}

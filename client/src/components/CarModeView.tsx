import React, { useState, useEffect } from 'react';
import type { Role, SafePlaybackState, QueueItemData, ParticipantData, YouTubeSuggestion } from '../types/room';
import { CinematicPlayer } from './CinematicPlayer';
import { ThemeToggle } from './ThemeToggle';
import { getYouTubeRecommendations } from '../services/api';
import { formatTime } from '../utils/youtube';

interface CarModeViewProps {
  roomCode: string;
  roomTitle: string;
  userRole: Role;
  playbackState: SafePlaybackState | null;
  queue: QueueItemData[];
  roster?: ParticipantData[];
  currentUserId?: string;
  sessionToken?: string | null;
  onExitCarMode: () => void;
  onOpenSearch: () => void;
  onOpenQueue: () => void;
  onOpenRemoteQR: () => void;
  onPlay: (timestamp?: number) => Promise<boolean>;
  onPause: (timestamp?: number) => Promise<boolean>;
  onSeek: (timestamp: number) => Promise<boolean>;
  onSetRate: (rate: number) => Promise<boolean>;
  onPlayNext: (itemId?: string) => Promise<boolean>;
  onPlayRecommendation?: (
    videoId: string,
    meta?: {
      autoPlay?: boolean;
      title?: string;
      channelTitle?: string;
      thumbnailUrl?: string;
      durationSec?: number;
    }
  ) => Promise<boolean>;
  onAddToQueue?: (item: {
    videoId: string;
    title?: string;
    channelTitle?: string;
    thumbnailUrl?: string;
    durationSec?: number;
  }) => Promise<any>;
  onVideoEnded?: (videoId: string) => void;
  onMetadataDiscovered?: (meta: {
    videoId: string;
    durationSec: number;
    title: string;
    channelTitle: string;
    thumbnailUrl: string;
  }) => void;
  onUpdateRole?: (participantId: string, role: Role) => Promise<void>;
  onRemoveParticipant?: (participantId: string) => Promise<void>;
  onTransferHost?: (participantId: string) => Promise<void>;
}

export const CarModeView: React.FC<CarModeViewProps> = ({
  roomCode,
  roomTitle,
  userRole,
  playbackState,
  queue,
  roster = [],
  currentUserId,
  sessionToken,
  onExitCarMode,
  onOpenSearch,
  onOpenQueue,
  onOpenRemoteQR,
  onPlay,
  onPause,
  onSeek,
  onSetRate,
  onPlayNext,
  onPlayRecommendation,
  onAddToQueue,
  onVideoEnded,
  onMetadataDiscovered,
  onUpdateRole,
  onRemoveParticipant,
  onTransferHost,
}) => {
  const [isPassengersModalOpen, setIsPassengersModalOpen] = useState(false);
  const [busyParticipantId, setBusyParticipantId] = useState<string | null>(null);
  const [isDriverBusy, setIsDriverBusy] = useState(false);

  // Recommendations state
  const [recommendations, setRecommendations] = useState<YouTubeSuggestion[]>([]);
  const [isLoadingRecs, setIsLoadingRecs] = useState(false);
  const [recError, setRecError] = useState<string | null>(null);
  const [busyRecId, setBusyRecId] = useState<string | null>(null);

  const isHost = userRole === 'HOST';
  const isPrivileged = userRole === 'HOST' || userRole === 'MODERATOR';
  const isPlaying = Boolean(playbackState?.isPlaying);

  const handleDriverTogglePlayPause = async () => {
    if (!isPrivileged || isDriverBusy) return;
    setIsDriverBusy(true);
    try {
      if (isPlaying) {
        await onPause();
      } else {
        await onPlay();
      }
    } finally {
      setIsDriverBusy(false);
    }
  };

  const handleDriverJumpDelta = async (delta: number) => {
    if (!isPrivileged || isDriverBusy) return;
    const currentTime = playbackState?.currentTimestamp || 0;
    const target = Math.max(0, currentTime + delta);
    setIsDriverBusy(true);
    try {
      await onSeek(target);
    } finally {
      setIsDriverBusy(false);
    }
  };

  const handleDriverPlayNext = async () => {
    if (!isPrivileged || isDriverBusy || !onPlayNext) return;
    setIsDriverBusy(true);
    try {
      await onPlayNext();
    } finally {
      setIsDriverBusy(false);
    }
  };

  // Active playing item & queue calculation
  const currentVideoId = playbackState?.currentVideoId;
  const playingItem =
    queue.find((i) => i.status === 'PLAYING') ||
    (currentVideoId ? queue.find((i) => i.videoId === currentVideoId) : undefined);

  const activeTitle =
    playbackState?.videoTitle ||
    playingItem?.title ||
    (currentVideoId ? `YouTube Video (${currentVideoId})` : 'No Video Selected');
  const activeChannel = playbackState?.channelTitle || playingItem?.channelTitle || null;
  const activeDuration =
    (typeof playbackState?.durationSec === 'number' && playbackState.durationSec > 0)
      ? playbackState.durationSec
      : (playingItem?.durationSec || 0);

  const upcomingQueue = queue
    .filter((i) => i.status === 'QUEUED' && i.id !== playingItem?.id)
    .sort((a, b) => a.position - b.position);

  // Fetch YouTube suggestions whenever current video changes
  const fetchSuggestions = () => {
    if (!roomCode || !sessionToken) return;

    setIsLoadingRecs(true);
    setRecError(null);

    getYouTubeRecommendations(roomCode, sessionToken, {
      videoId: currentVideoId || undefined,
      title: playbackState?.videoTitle || playingItem?.title,
      channel: playbackState?.channelTitle || playingItem?.channelTitle || undefined,
      limit: 10,
    })
      .then((res) => {
        if (res.success && Array.isArray(res.recommendations)) {
          setRecommendations(res.recommendations);
        } else {
          setRecommendations([]);
        }
      })
      .catch((err) => {
        console.warn('[CarMode] Suggestions fetch failed:', err);
        setRecError('Could not load suggestions');
      })
      .finally(() => {
        setIsLoadingRecs(false);
      });
  };

  useEffect(() => {
    fetchSuggestions();
  }, [roomCode, sessionToken, currentVideoId, playbackState?.videoTitle]);

  // Handle recommendation selection (CRITICAL: Never redirects to external YouTube)
  const handleSelectRecommendation = async (rec: YouTubeSuggestion) => {
    if (!isPrivileged) return;
    setBusyRecId(rec.videoId);
    try {
      if (onPlayRecommendation) {
        await onPlayRecommendation(rec.videoId, {
          autoPlay: true,
          title: rec.title,
          channelTitle: rec.channelTitle,
          thumbnailUrl: rec.thumbnailUrl,
          durationSec: rec.durationSec,
        });
      }
    } finally {
      setBusyRecId(null);
    }
  };

  const handleAddRecToQueue = async (rec: YouTubeSuggestion, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!onAddToQueue) return;
    setBusyRecId(rec.videoId);
    try {
      await onAddToQueue({
        videoId: rec.videoId,
        title: rec.title,
        channelTitle: rec.channelTitle,
        thumbnailUrl: rec.thumbnailUrl,
        durationSec: rec.durationSec,
      });
    } finally {
      setBusyRecId(null);
    }
  };

  return (
    <div className="car-mode-container">
      {/* Top Bar: Minimal distraction header */}
      <header className="car-top-bar">
        <div className="car-brand-group">
          <div className="car-mode-badge" aria-label="Car Infotainment Mode">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M19 17h2c.6 0 1-.4 1-1v-3c0-.9-.7-1.7-1.5-1.9C18.7 10.6 16 10 16 10s-1.3-1.4-2.2-2.3c-.5-.4-1.1-.7-1.8-.7H5c-.6 0-1.1.4-1.4.9l-1.4 2.9C2.1 11.1 2 11.5 2 12v4c0 .6.4 1 1 1h2" />
              <circle cx="7" cy="17" r="2" />
              <path d="M9 17h6" />
              <circle cx="17" cy="17" r="2" />
            </svg>
            <span>CAR MODE</span>
          </div>

          <span className="car-room-code" title="Room Code">
            ROOM: <strong>{roomCode}</strong>
          </span>

          {roomTitle && <span className="car-room-title">{roomTitle}</span>}
        </div>

        <div className="car-top-actions">
          {/* Passengers & Roles Button */}
          <button
            type="button"
            className="car-action-btn car-passengers-pill"
            onClick={() => setIsPassengersModalOpen(true)}
            title="View passengers and manage roles"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
              <circle cx="9" cy="7" r="4" />
              <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
              <path d="M16 3.13a4 4 0 0 1 0 7.75" />
            </svg>
            <span>Passengers ({roster.length})</span>
          </button>

          {/* Phone Remote Connect Pill */}
          <button
            type="button"
            className="car-action-btn car-remote-pill"
            onClick={onOpenRemoteQR}
            title="Scan or share Phone Remote controller link"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <rect x="5" y="2" width="14" height="20" rx="2" ry="2" />
              <line x1="12" y1="18" x2="12.01" y2="18" />
            </svg>
            <span>Phone Remote</span>
          </button>

          {/* Full Queue Button */}
          <button
            type="button"
            className="car-action-btn car-queue-pill"
            onClick={onOpenQueue}
            title="Open Shared Queue"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="8" y1="6" x2="21" y2="6" />
              <line x1="8" y1="12" x2="21" y2="12" />
              <line x1="8" y1="18" x2="21" y2="18" />
              <line x1="3" y1="6" x2="3.01" y2="6" />
              <line x1="3" y1="12" x2="3.01" y2="12" />
              <line x1="3" y1="18" x2="3.01" y2="18" />
            </svg>
            <span>Queue ({upcomingQueue.length})</span>
          </button>

          {/* Theme Toggle (Day / Night mode) */}
          <ThemeToggle className="car-theme-toggle" />

          {/* Exit Car Mode */}
          <button
            type="button"
            className="car-action-btn car-exit-btn"
            onClick={onExitCarMode}
            title="Exit Car Mode back to standard layout"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
              <polyline points="16 17 21 12 16 7" />
              <line x1="21" y1="12" x2="9" y2="12" />
            </svg>
            <span>Exit Car Mode</span>
          </button>
        </div>
      </header>

      {/* Main Landscape Body */}
      <main className="car-main-grid">
        {/* Left Column: Authoritative Video Player with built-in controls */}
        <section className="car-player-column">
          <div className="car-player-frame">
            <CinematicPlayer
              userRole={userRole}
              playbackState={playbackState}
              pendingRequestsCount={0}
              onPlay={onPlay}
              onPause={onPause}
              onSeek={onSeek}
              onSetRate={onSetRate}
              onOpenChangeVideoModal={onOpenSearch}
              onOpenRequestsModal={onOpenQueue}
              onVideoEnded={onVideoEnded}
              onMetadataDiscovered={onMetadataDiscovered}
            />
          </div>

          {/* Driver Touch Quick Bar (infotainment friendly) */}
          {isPrivileged && (
            <div className="car-driver-bar" role="toolbar" aria-label="Driver playback controls">
              <button
                type="button"
                className="car-driver-btn"
                onClick={() => handleDriverJumpDelta(-10)}
                disabled={isDriverBusy || !currentVideoId}
                title="Rewind 10 seconds"
              >
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                  <polyline points="1 4 1 10 7 10" />
                  <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" />
                </svg>
                <span>-10s</span>
              </button>

              <button
                type="button"
                className={`car-driver-btn car-driver-btn-playpause ${isPlaying ? 'playing' : ''}`}
                onClick={handleDriverTogglePlayPause}
                disabled={isDriverBusy || !currentVideoId}
                title={isPlaying ? 'Pause Video' : 'Play Video'}
              >
                {isPlaying ? (
                  <>
                    <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor">
                      <rect x="6" y="4" width="4" height="16" rx="1" />
                      <rect x="14" y="4" width="4" height="16" rx="1" />
                    </svg>
                    <span>Pause</span>
                  </>
                ) : (
                  <>
                    <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor">
                      <path d="M8 5v14l11-7z" />
                    </svg>
                    <span>Play</span>
                  </>
                )}
              </button>

              <button
                type="button"
                className="car-driver-btn"
                onClick={() => handleDriverJumpDelta(10)}
                disabled={isDriverBusy || !currentVideoId}
                title="Forward 10 seconds"
              >
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                  <polyline points="23 4 23 10 17 10" />
                  <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
                </svg>
                <span>+10s</span>
              </button>

              <button
                type="button"
                className="car-driver-btn"
                onClick={handleDriverPlayNext}
                disabled={isDriverBusy || upcomingQueue.length === 0}
                title={upcomingQueue.length > 0 ? 'Skip to next song in queue' : 'No upcoming songs in queue'}
              >
                <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M5 4l10 8-10 8V4z" />
                  <rect x="17" y="4" width="3" height="16" rx="1" />
                </svg>
                <span>Next ({upcomingQueue.length})</span>
              </button>
            </div>
          )}
        </section>

        {/* Right Column: Redesigned YouTube-Style Recommendation & Passenger Dashboard */}
        <aside className="car-sidebar-column">
          {/* 1. Current Video Information at Top */}
          <div className="car-card car-now-playing-card">
            <div className="car-playing-header">
              <span className="car-card-label">NOW PLAYING</span>
              <span className={`car-live-badge ${isPlaying ? 'playing' : 'paused'}`}>
                <span className="car-pulse-dot" />
                {isPlaying ? 'PLAYING' : 'PAUSED'}
              </span>
            </div>
            <h2 className="car-playing-title" title={activeTitle}>
              {activeTitle}
            </h2>
            <div className="car-playing-meta-row">
              {activeChannel && <span className="car-playing-channel">{activeChannel}</span>}
              {activeDuration > 0 && (
                <span className="car-playing-duration">
                  {activeChannel ? ' • ' : ''}
                  {formatTime(activeDuration)}
                </span>
              )}
            </div>
          </div>

          {/* 2. YouTube Video Suggestions (Recommendations) */}
          <div className="car-card car-suggestions-card">
            <div className="car-suggestions-header">
              <div className="car-card-label-group">
                <span className="car-card-label">YOUTUBE SUGGESTIONS</span>
                <span className="car-suggestions-badge">
                  {recommendations.length > 0 ? `${recommendations.length} next` : 'Related'}
                </span>
              </div>
              <button
                type="button"
                className="car-refresh-suggestions-btn"
                onClick={fetchSuggestions}
                disabled={isLoadingRecs}
                title="Refresh video recommendations"
              >
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  className={isLoadingRecs ? 'car-spin' : ''}
                >
                  <polyline points="23 4 23 10 17 10" />
                  <polyline points="1 20 1 14 7 14" />
                  <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
                </svg>
              </button>
            </div>

            {/* Suggestions Body */}
            <div className="car-suggestions-list">
              {isLoadingRecs ? (
                <div className="car-suggestions-loading">
                  <div className="car-skeleton-item" />
                  <div className="car-skeleton-item" />
                  <div className="car-skeleton-item" />
                </div>
              ) : recError ? (
                <div className="car-suggestions-empty">
                  <p>{recError}</p>
                  <button type="button" className="car-retry-btn" onClick={fetchSuggestions}>
                    Retry Suggestions
                  </button>
                </div>
              ) : recommendations.length === 0 ? (
                <div className="car-suggestions-empty">
                  <p>No video suggestions available.</p>
                  {isPrivileged && (
                    <button type="button" className="car-retry-btn" onClick={onOpenSearch}>
                      Search Music
                    </button>
                  )}
                </div>
              ) : (
                recommendations.map((rec) => {
                  const isCurrent = rec.videoId === currentVideoId;
                  const isBusy = busyRecId === rec.videoId;
                  return (
                    <div
                      key={rec.videoId}
                      className={`car-suggestion-item ${isCurrent ? 'is-current' : ''}`}
                      onClick={() => isPrivileged && handleSelectRecommendation(rec)}
                      role={isPrivileged ? 'button' : undefined}
                      tabIndex={isPrivileged ? 0 : undefined}
                      title={isPrivileged ? `Play: ${rec.title}` : rec.title}
                    >
                      <div className="car-suggestion-thumb-wrap">
                        <img
                          src={rec.thumbnailUrl || `https://img.youtube.com/vi/${rec.videoId}/mqdefault.jpg`}
                          alt={rec.title}
                          className="car-suggestion-thumb"
                          loading="lazy"
                        />
                        <span className="car-suggestion-duration">{rec.durationFormatted}</span>
                      </div>

                      <div className="car-suggestion-info">
                        <h4 className="car-suggestion-title" title={rec.title}>
                          {rec.title}
                        </h4>
                        <p className="car-suggestion-channel">{rec.channelTitle}</p>
                      </div>

                      {/* Action buttons */}
                      <div className="car-suggestion-action-col">
                        {isPrivileged ? (
                          <button
                            type="button"
                            className="car-suggestion-play-btn"
                            disabled={isBusy || isCurrent}
                            onClick={(e) => {
                              e.stopPropagation();
                              handleSelectRecommendation(rec);
                            }}
                            title="Play this song now"
                          >
                            {isBusy ? (
                              <span className="car-mini-spinner" />
                            ) : (
                              <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                                <path d="M8 5v14l11-7z" />
                              </svg>
                            )}
                          </button>
                        ) : null}

                        {onAddToQueue && (
                          <button
                            type="button"
                            className="car-suggestion-queue-btn"
                            disabled={isBusy}
                            onClick={(e) => handleAddRecToQueue(rec, e)}
                            title="Add to shared queue"
                          >
                            +
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </div>

          {/* 3. Connected Passengers & Host Role Management */}
          <div className="car-card car-passengers-sidebar-card">
            <div className="car-passengers-sidebar-header">
              <div className="car-card-label-group">
                <span className="car-card-label">CONNECTED PASSENGERS</span>
                <span className="car-passengers-count-badge">{roster.length}</span>
              </div>
              <button
                type="button"
                className="car-passengers-manage-pill"
                onClick={() => setIsPassengersModalOpen(true)}
                title="Manage all passenger permissions"
              >
                {isHost ? 'Manage All' : 'View All'}
              </button>
            </div>

            <div className="car-passengers-inline-list">
              {roster.map((p) => {
                const isMe = p.id === currentUserId;
                const isItemBusy = busyParticipantId === p.id;
                return (
                  <div key={p.id} className="car-passenger-inline-item">
                    <div className="car-passenger-info-left">
                      <span className={`car-status-dot ${p.isConnected ? 'online' : 'offline'}`} />
                      <span className="car-passenger-inline-name" title={p.displayName}>
                        {p.displayName} {isMe && <span className="car-me-tag">(You)</span>}
                      </span>
                    </div>

                    <div className="car-passenger-info-right">
                      <span className={`car-role-badge role-${p.role.toLowerCase()}`}>
                        {p.role}
                      </span>

                      {/* Inline Host Actions */}
                      {isHost && !isMe && (
                        <div className="car-passenger-inline-actions">
                          {p.role === 'PARTICIPANT' && onUpdateRole && (
                            <button
                              type="button"
                              className="car-inline-role-btn btn-promote"
                              disabled={isItemBusy}
                              onClick={async () => {
                                setBusyParticipantId(p.id);
                                try {
                                  await onUpdateRole(p.id, 'MODERATOR');
                                } finally {
                                  setBusyParticipantId(null);
                                }
                              }}
                              title="Promote to Moderator (Grant playback controls)"
                            >
                              + Mod
                            </button>
                          )}

                          {p.role === 'MODERATOR' && onUpdateRole && (
                            <button
                              type="button"
                              className="car-inline-role-btn btn-demote"
                              disabled={isItemBusy}
                              onClick={async () => {
                                setBusyParticipantId(p.id);
                                try {
                                  await onUpdateRole(p.id, 'PARTICIPANT');
                                } finally {
                                  setBusyParticipantId(null);
                                }
                              }}
                              title="Demote to Passenger (Revoke playback controls)"
                            >
                              - Mod
                            </button>
                          )}

                          {onRemoveParticipant && (
                            <button
                              type="button"
                              className="car-inline-role-btn btn-kick"
                              disabled={isItemBusy}
                              onClick={async () => {
                                if (window.confirm(`Remove passenger ${p.displayName}?`)) {
                                  setBusyParticipantId(p.id);
                                  try {
                                    await onRemoveParticipant(p.id);
                                  } finally {
                                    setBusyParticipantId(null);
                                  }
                                }
                              }}
                              title="Remove passenger from room"
                            >
                              ✕
                            </button>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* 4. Quick Actions (Search, Remote QR, Queue) */}
          <div className="car-footer-actions">
            {isPrivileged && (
              <button type="button" className="car-footer-action-btn" onClick={onOpenSearch}>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <circle cx="11" cy="11" r="8" />
                  <line x1="21" y1="21" x2="16.65" y2="16.65" />
                </svg>
                <span>Search Music</span>
              </button>
            )}

            <button type="button" className="car-footer-action-btn" onClick={onOpenQueue}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <line x1="8" y1="6" x2="21" y2="6" />
                <line x1="8" y1="12" x2="21" y2="12" />
                <line x1="8" y1="18" x2="21" y2="18" />
                <line x1="3" y1="6" x2="3.01" y2="6" />
                <line x1="3" y1="12" x2="3.01" y2="12" />
                <line x1="3" y1="18" x2="3.01" y2="18" />
              </svg>
              <span>Queue ({upcomingQueue.length})</span>
            </button>

            <button type="button" className="car-footer-action-btn" onClick={onOpenRemoteQR}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <rect x="3" y="3" width="7" height="7" />
                <rect x="14" y="3" width="7" height="7" />
                <rect x="14" y="14" width="7" height="7" />
                <rect x="3" y="14" width="7" height="7" />
              </svg>
              <span>Remote QR</span>
            </button>
          </div>
        </aside>
      </main>

      {/* Passengers & Role Management Modal */}
      {isPassengersModalOpen && (
        <div className="car-modal-overlay" onClick={() => setIsPassengersModalOpen(false)}>
          <div className="car-modal-content car-passengers-modal" onClick={(e) => e.stopPropagation()}>
            <div className="car-modal-header">
              <div className="car-modal-header-info">
                <h3 className="car-modal-title">Connected Passengers</h3>
                <span className="car-modal-subtitle">
                  {roster.length} {roster.length === 1 ? 'device' : 'devices'} in room •{' '}
                  {isHost ? 'Manage roles & permissions' : 'Room passengers'}
                </span>
              </div>
              <button
                type="button"
                className="car-modal-close-btn"
                onClick={() => setIsPassengersModalOpen(false)}
                aria-label="Close"
              >
                ✕
              </button>
            </div>

            <div className="car-passengers-list">
              {roster.map((p) => {
                const isMe = p.id === currentUserId;
                const isItemBusy = busyParticipantId === p.id;
                return (
                  <div key={p.id} className="car-passenger-row">
                    <div className="car-passenger-info">
                      <span className={`car-status-dot ${p.isConnected ? 'online' : 'offline'}`} />
                      <div className="car-passenger-name-wrap">
                        <span className="car-passenger-name">
                          {p.displayName} {isMe && <span className="car-me-tag">(You)</span>}
                        </span>
                        <span className={`car-role-badge role-${p.role.toLowerCase()}`}>
                          {p.role}
                        </span>
                      </div>
                    </div>

                    {isHost && !isMe && (
                      <div className="car-passenger-actions">
                        {p.role === 'MODERATOR' && onUpdateRole && (
                          <button
                            type="button"
                            className="car-btn-role-demote"
                            disabled={isItemBusy}
                            onClick={async () => {
                              setBusyParticipantId(p.id);
                              try {
                                await onUpdateRole(p.id, 'PARTICIPANT');
                              } finally {
                                setBusyParticipantId(null);
                              }
                            }}
                            title="Demote to Participant"
                          >
                            Make Participant
                          </button>
                        )}

                        {p.role === 'PARTICIPANT' && onUpdateRole && (
                          <button
                            type="button"
                            className="car-btn-role-promote"
                            disabled={isItemBusy}
                            onClick={async () => {
                              setBusyParticipantId(p.id);
                              try {
                                await onUpdateRole(p.id, 'MODERATOR');
                              } finally {
                                setBusyParticipantId(null);
                              }
                            }}
                            title="Promote to Moderator"
                          >
                            Make Moderator
                          </button>
                        )}

                        {onTransferHost && (
                          <button
                            type="button"
                            className="car-btn-role-host"
                            disabled={isItemBusy}
                            onClick={async () => {
                              if (window.confirm(`Transfer Host role to ${p.displayName}? You will become a Moderator.`)) {
                                setBusyParticipantId(p.id);
                                try {
                                  await onTransferHost(p.id);
                                } finally {
                                  setBusyParticipantId(null);
                                }
                              }
                            }}
                            title="Transfer Room Host"
                          >
                            Make Host
                          </button>
                        )}

                        {onRemoveParticipant && (
                          <button
                            type="button"
                            className="car-btn-role-remove"
                            disabled={isItemBusy}
                            onClick={async () => {
                              if (window.confirm(`Remove ${p.displayName} from this room?`)) {
                                setBusyParticipantId(p.id);
                                try {
                                  await onRemoveParticipant(p.id);
                                } finally {
                                  setBusyParticipantId(null);
                                }
                              }
                            }}
                            title="Remove participant"
                          >
                            Remove
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

            <div className="car-modal-footer">
              <button
                type="button"
                className="car-btn-secondary"
                onClick={() => {
                  setIsPassengersModalOpen(false);
                  onOpenRemoteQR();
                }}
              >
                + Invite Passenger (Show QR)
              </button>
              <button
                type="button"
                className="car-btn-primary"
                onClick={() => setIsPassengersModalOpen(false)}
              >
                Done
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

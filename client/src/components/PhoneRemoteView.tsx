import React, { useState, useEffect, useRef } from 'react';
import type { Role, SafePlaybackState, QueueItemData, YouTubeSuggestion } from '../types/room';
import { formatTime, SUPPORTED_PLAYBACK_RATES } from '../utils/youtube';
import { getYouTubeRecommendations } from '../services/api';
import { ThemeToggle } from './ThemeToggle';

interface PhoneRemoteViewProps {
  roomCode: string;
  roomTitle: string;
  userRole: Role;
  playbackState: SafePlaybackState | null;
  queue: QueueItemData[];
  sessionToken?: string | null;
  onExitRemoteMode: () => void;
  onOpenSearch: () => void;
  onOpenQueue: () => void;
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
  onRemoveItem: (itemId: string) => Promise<boolean>;
  onReorderItem: (itemId: string, targetPosition: number) => Promise<boolean>;
  onRequestModerator?: () => void;
}

export const PhoneRemoteView: React.FC<PhoneRemoteViewProps> = ({
  roomCode,
  roomTitle,
  userRole,
  playbackState,
  queue,
  sessionToken,
  onExitRemoteMode,
  onOpenSearch,
  onOpenQueue,
  onPlay,
  onPause,
  onSeek,
  onSetRate,
  onPlayNext,
  onPlayRecommendation,
  onRemoveItem,
  onReorderItem,
  onRequestModerator,
}) => {
  const [isBusy, setIsBusy] = useState(false);
  const [scrubberValue, setScrubberValue] = useState<number | null>(null);
  const [activeSpeedMenu, setActiveSpeedMenu] = useState(false);

  // Recommendations state
  const [recommendations, setRecommendations] = useState<YouTubeSuggestion[]>([]);
  const [isLoadingRecs, setIsLoadingRecs] = useState(false);
  const [busyRecId, setBusyRecId] = useState<string | null>(null);

  const isPrivileged = userRole === 'HOST' || userRole === 'MODERATOR';
  const isPlaying = Boolean(playbackState?.isPlaying);
  const playbackRate = playbackState?.playbackRate || 1.0;

  // Track live estimated playback time without running an audio/video player
  const [estimatedTime, setEstimatedTime] = useState(playbackState?.currentTimestamp || 0);
  const lastSyncRef = useRef({
    timestamp: playbackState?.currentTimestamp || 0,
    serverTime: playbackState?.serverTime || Date.now(),
    isPlaying: Boolean(playbackState?.isPlaying),
    playbackRate: playbackState?.playbackRate || 1.0,
  });

  useEffect(() => {
    if (playbackState) {
      lastSyncRef.current = {
        timestamp: playbackState.currentTimestamp,
        serverTime: playbackState.serverTime || Date.now(),
        isPlaying: playbackState.isPlaying,
        playbackRate: playbackState.playbackRate,
      };
      setEstimatedTime(playbackState.currentTimestamp);
    }
  }, [playbackState]);

  // Tick estimated clock smoothly when room is playing
  useEffect(() => {
    if (!isPlaying) return;

    const interval = setInterval(() => {
      const now = Date.now();
      const ageSeconds = Math.max(0, (now - lastSyncRef.current.serverTime) / 1000);
      const computed = lastSyncRef.current.timestamp + ageSeconds * lastSyncRef.current.playbackRate;
      setEstimatedTime(computed);
    }, 500);

    return () => clearInterval(interval);
  }, [isPlaying]);

  // Active playing item & queue (Enriched from SafePlaybackState to eliminate cross-device mismatch)
  const currentVideoId = playbackState?.currentVideoId;
  const playingItem =
    queue.find((i) => i.status === 'PLAYING') ||
    (currentVideoId ? queue.find((i) => i.videoId === currentVideoId) : undefined);

  const activeTitle =
    playbackState?.videoTitle ||
    playingItem?.title ||
    (currentVideoId ? `YouTube Video` : 'No Video Loaded');
  const activeChannel =
    playbackState?.channelTitle ||
    playingItem?.channelTitle ||
    (roomTitle ? `${roomTitle}` : 'Watch Party Room');
  const activeThumbnail =
    playbackState?.thumbnailUrl ||
    playingItem?.thumbnailUrl ||
    (currentVideoId ? `https://img.youtube.com/vi/${currentVideoId}/mqdefault.jpg` : null);

  const durationSec =
    (typeof playbackState?.durationSec === 'number' && playbackState.durationSec > 0)
      ? playbackState.durationSec
      : (playingItem?.durationSec || 0);

  const upcomingQueue = queue
    .filter((i) => i.status === 'QUEUED' && i.id !== playingItem?.id)
    .sort((a, b) => a.position - b.position);

  const displayTime = scrubberValue !== null ? scrubberValue : estimatedTime;
  const progressPercent = durationSec > 0 ? Math.min(100, Math.max(0, (displayTime / durationSec) * 100)) : 0;

  // Load recommendations for remote view
  useEffect(() => {
    if (!roomCode || !sessionToken || !currentVideoId) return;

    let isMounted = true;
    setIsLoadingRecs(true);

    getYouTubeRecommendations(roomCode, sessionToken, {
      videoId: currentVideoId,
      title: activeTitle,
      channel: activeChannel !== 'Watch Party Room' ? activeChannel : undefined,
      limit: 6,
    })
      .then((res) => {
        if (!isMounted) return;
        if (res.success && Array.isArray(res.recommendations)) {
          setRecommendations(res.recommendations);
        }
      })
      .catch(() => {})
      .finally(() => {
        if (isMounted) setIsLoadingRecs(false);
      });

    return () => {
      isMounted = false;
    };
  }, [roomCode, sessionToken, currentVideoId, activeTitle]);

  const handleTogglePlayPause = async () => {
    if (!isPrivileged || isBusy) return;
    setIsBusy(true);
    try {
      if (isPlaying) {
        await onPause();
      } else {
        await onPlay();
      }
    } finally {
      setIsBusy(false);
    }
  };

  const handleSkipNext = async () => {
    if (!isPrivileged || isBusy) return;
    setIsBusy(true);
    try {
      await onPlayNext();
    } finally {
      setIsBusy(false);
    }
  };

  const handlePrevious = async () => {
    if (!isPrivileged || isBusy) return;
    setIsBusy(true);
    try {
      await onSeek(0);
    } finally {
      setIsBusy(false);
    }
  };

  const handleSeekCommit = async (val: number) => {
    if (!isPrivileged || isBusy) return;
    setScrubberValue(null);
    setIsBusy(true);
    try {
      await onSeek(val);
    } finally {
      setIsBusy(false);
    }
  };

  const handleJumpDelta = async (delta: number) => {
    if (!isPrivileged || isBusy) return;
    const target = Math.max(0, estimatedTime + delta);
    setIsBusy(true);
    try {
      await onSeek(target);
    } finally {
      setIsBusy(false);
    }
  };

  const handleSelectRate = async (rate: number) => {
    if (!isPrivileged || isBusy) return;
    setActiveSpeedMenu(false);
    setIsBusy(true);
    try {
      await onSetRate(rate);
    } finally {
      setIsBusy(false);
    }
  };

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

  return (
    <div className="phone-remote-layout">
      {/* Remote Header */}
      <header className="remote-header">
        <div className="remote-header-brand">
          <div className="remote-phone-icon" aria-hidden="true">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <rect x="5" y="2" width="14" height="20" rx="2" ry="2" />
              <line x1="12" y1="18" x2="12.01" y2="18" />
            </svg>
          </div>
          <div>
            <h1 className="remote-title">Phone Remote</h1>
            <span className="remote-connected-status">
              <span className="remote-status-dot" />
              Connected to Car Screen
            </span>
          </div>
        </div>

        <div className="remote-header-actions">
          <span className="remote-room-pill" title="Room Code">
            {roomCode}
          </span>
          <ThemeToggle className="remote-theme-toggle" />
          <button
            type="button"
            className="remote-exit-btn"
            onClick={onExitRemoteMode}
            title="Switch back to standard mode"
          >
            Exit
          </button>
        </div>
      </header>

      {/* Main Remote Controls Body */}
      <main className="remote-body">
        {/* Role Notice Banner (if not Host/Mod) */}
        {!isPrivileged && (
          <div className="remote-notice-banner">
            <span>You are joined as a passenger (view-only).</span>
            {onRequestModerator && (
              <button
                type="button"
                className="remote-request-role-btn"
                onClick={onRequestModerator}
              >
                Request Control Access
              </button>
            )}
          </div>
        )}

        {/* Now Playing Card with accurate metadata and synchronized duration */}
        <section className="remote-card remote-now-playing">
          <div className="remote-artwork-wrapper">
            <img
              src={activeThumbnail || (currentVideoId ? `https://img.youtube.com/vi/${currentVideoId}/hqdefault.jpg` : '')}
              alt={activeTitle}
              className="remote-artwork-img"
            />
            {isPlaying && (
              <div className="remote-playing-badge">
                <span className="remote-playing-wave" />
                PLAYING ON CAR SCREEN
              </div>
            )}
          </div>

          <div className="remote-track-info">
            <h2 className="remote-track-title" title={activeTitle}>
              {activeTitle}
            </h2>
            <p className="remote-track-channel">
              {activeChannel}
            </p>
          </div>

          {/* Progress & Live Seek Bar */}
          <div className="remote-progress-box">
            <div className="remote-slider-container">
              <div className="remote-progress-bar-bg">
                <div
                  className="remote-progress-bar-fill"
                  style={{ width: `${progressPercent}%` }}
                />
              </div>
              {durationSec > 0 && isPrivileged && (
                <input
                  type="range"
                  min={0}
                  max={durationSec}
                  step={1}
                  value={displayTime}
                  className="remote-seek-slider"
                  onChange={(e) => setScrubberValue(Number(e.target.value))}
                  onMouseUp={(e) => handleSeekCommit(Number((e.target as HTMLInputElement).value))}
                  onTouchEnd={(e) => handleSeekCommit(Number((e.target as HTMLInputElement).value))}
                />
              )}
            </div>

            <div className="remote-time-row">
              <span>{formatTime(displayTime)}</span>
              <span>{durationSec > 0 ? formatTime(durationSec) : '--:--'}</span>
            </div>
          </div>
        </section>

        {/* Primary Remote Controls */}
        {isPrivileged && (
          <section className="remote-card remote-controls-section">
            <div className="remote-primary-buttons-row">
              {/* Previous / Restart Song */}
              <button
                type="button"
                className="remote-btn remote-btn-sec"
                onClick={handlePrevious}
                disabled={isBusy || !currentVideoId}
                title="Restart track to beginning"
              >
                <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor">
                  <rect x="4" y="4" width="3" height="16" rx="1" />
                  <path d="M19 20L9 12l10-8v16z" />
                </svg>
                <span className="remote-btn-label">Prev</span>
              </button>

              {/* Rewind 10s */}
              <button
                type="button"
                className="remote-btn remote-btn-sec"
                onClick={() => handleJumpDelta(-10)}
                disabled={isBusy || !currentVideoId}
                title="Rewind 10 seconds"
              >
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <polyline points="1 4 1 10 7 10" />
                  <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" />
                </svg>
                <span className="remote-btn-label">-10s</span>
              </button>

              {/* Main Play/Pause Button */}
              <button
                type="button"
                className={`remote-btn remote-btn-playpause ${isPlaying ? 'active-playing' : ''}`}
                onClick={handleTogglePlayPause}
                disabled={isBusy || !currentVideoId}
                title={isPlaying ? 'Pause' : 'Play'}
              >
                {isPlaying ? (
                  <svg width="34" height="34" viewBox="0 0 24 24" fill="currentColor">
                    <rect x="6" y="4" width="4" height="16" rx="1" />
                    <rect x="14" y="4" width="4" height="16" rx="1" />
                  </svg>
                ) : (
                  <svg width="34" height="34" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M8 5v14l11-7z" />
                  </svg>
                )}
              </button>

              {/* Forward 10s */}
              <button
                type="button"
                className="remote-btn remote-btn-sec"
                onClick={() => handleJumpDelta(10)}
                disabled={isBusy || !currentVideoId}
                title="Forward 10 seconds"
              >
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <polyline points="23 4 23 10 17 10" />
                  <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
                </svg>
                <span className="remote-btn-label">+10s</span>
              </button>

              {/* Skip Next */}
              <button
                type="button"
                className="remote-btn remote-btn-sec"
                onClick={handleSkipNext}
                disabled={isBusy || upcomingQueue.length === 0}
                title={upcomingQueue.length > 0 ? 'Play next video in queue' : 'No upcoming videos in queue'}
              >
                <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M5 4l10 8-10 8V4z" />
                  <rect x="17" y="4" width="3" height="16" rx="1" />
                </svg>
                <span className="remote-btn-label">Next</span>
              </button>
            </div>

            {/* Playback Rate & Quick Tools */}
            <div className="remote-sub-controls-row">
              <div className="remote-speed-selector">
                <button
                  type="button"
                  className="remote-speed-pill"
                  onClick={() => setActiveSpeedMenu(!activeSpeedMenu)}
                >
                  Speed: {playbackRate}x
                </button>
                {activeSpeedMenu && (
                  <div className="remote-speed-popover">
                    {SUPPORTED_PLAYBACK_RATES.map((rate) => (
                      <button
                        key={rate}
                        type="button"
                        className={`remote-speed-opt ${playbackRate === rate ? 'selected' : ''}`}
                        onClick={() => handleSelectRate(rate)}
                      >
                        {rate}x
                      </button>
                    ))}
                  </div>
                )}
              </div>

              <button
                type="button"
                className="remote-search-quick-btn"
                onClick={onOpenSearch}
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <circle cx="11" cy="11" r="8" />
                  <line x1="21" y1="21" x2="16.65" y2="16.65" />
                </svg>
                <span>Search YouTube</span>
              </button>
            </div>
          </section>
        )}

        {/* Recommendations Section in Phone Remote */}
        {(recommendations.length > 0 || isLoadingRecs) && (
          <section className="remote-card remote-recommendations-section">
            <div className="remote-queue-header">
              <div>
                <h3 className="remote-queue-title">Suggestions</h3>
                <span className="remote-queue-subtitle">
                  {isLoadingRecs ? 'Finding related songs...' : 'Tap any song to play on Car Screen'}
                </span>
              </div>
            </div>

            <div className="remote-suggestions-list">
              {recommendations.map((rec) => {
                const isBusy = busyRecId === rec.videoId;
                return (
                  <div
                    key={rec.videoId}
                    className="remote-suggestion-item"
                    onClick={() => isPrivileged && handleSelectRecommendation(rec)}
                    role={isPrivileged ? 'button' : undefined}
                    tabIndex={isPrivileged ? 0 : undefined}
                  >
                    <img
                      src={rec.thumbnailUrl || `https://img.youtube.com/vi/${rec.videoId}/mqdefault.jpg`}
                      alt={rec.title}
                      className="remote-suggestion-thumb"
                    />
                    <div className="remote-suggestion-info">
                      <h4 className="remote-suggestion-title" title={rec.title}>
                        {rec.title}
                      </h4>
                      <span className="remote-suggestion-meta">
                        {rec.channelTitle} • {rec.durationFormatted}
                      </span>
                    </div>

                    {isPrivileged && (
                      <button
                        type="button"
                        className="remote-suggestion-play-btn"
                        disabled={isBusy}
                        onClick={(e) => {
                          e.stopPropagation();
                          handleSelectRecommendation(rec);
                        }}
                        title="Play on Car Screen"
                      >
                        {isBusy ? (
                          '...'
                        ) : (
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                            <path d="M8 5v14l11-7z" />
                          </svg>
                        )}
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          </section>
        )}

        {/* Embedded Queue Section */}
        <section className="remote-card remote-queue-section">
          <div className="remote-queue-header">
            <div>
              <h3 className="remote-queue-title">Up Next</h3>
              <span className="remote-queue-subtitle">
                {upcomingQueue.length} {upcomingQueue.length === 1 ? 'song' : 'songs'} queued
              </span>
            </div>

            <div className="remote-queue-header-btns">
              {isPrivileged && (
                <button
                  type="button"
                  className="btn-primary btn-sm"
                  onClick={onOpenSearch}
                >
                  + Add Song
                </button>
              )}
              <button
                type="button"
                className="btn-secondary btn-sm"
                onClick={onOpenQueue}
              >
                Full Queue
              </button>
            </div>
          </div>

          {upcomingQueue.length === 0 ? (
            <div className="remote-empty-queue">
              <p>Queue is empty.</p>
              {isPrivileged && (
                <button type="button" className="remote-add-first-btn" onClick={onOpenSearch}>
                  Search YouTube to add music
                </button>
              )}
            </div>
          ) : (
            <div className="remote-queue-list">
              {upcomingQueue.slice(0, 5).map((item, idx) => (
                <div key={item.id} className="remote-queue-item">
                  <span className="remote-queue-pos">{idx + 1}</span>
                  <img
                    src={item.thumbnailUrl || `https://img.youtube.com/vi/${item.videoId}/mqdefault.jpg`}
                    alt={item.title}
                    className="remote-queue-thumb"
                  />
                  <div className="remote-queue-info">
                    <h4 className="remote-queue-name" title={item.title}>
                      {item.title}
                    </h4>
                    <span className="remote-queue-meta">
                      {item.channelTitle && <span>{item.channelTitle} • </span>}
                      {item.durationFormatted}
                    </span>
                  </div>

                  {isPrivileged && (
                    <div className="remote-item-actions">
                      <button
                        type="button"
                        className="remote-item-ctrl"
                        title="Play now"
                        onClick={() => onPlayNext(item.id)}
                      >
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                          <path d="M8 5v14l11-7z" />
                        </svg>
                      </button>
                      {idx > 0 && (
                        <button
                          type="button"
                          className="remote-item-ctrl"
                          title="Move up"
                          onClick={() => onReorderItem(item.id, Math.max(1, item.position - 1))}
                        >
                          ▲
                        </button>
                      )}
                      {idx < upcomingQueue.length - 1 && (
                        <button
                          type="button"
                          className="remote-item-ctrl"
                          title="Move down"
                          onClick={() => onReorderItem(item.id, item.position + 1)}
                        >
                          ▼
                        </button>
                      )}
                      <button
                        type="button"
                        className="remote-item-ctrl delete"
                        title="Remove"
                        onClick={() => onRemoveItem(item.id)}
                      >
                        &times;
                      </button>
                    </div>
                  )}
                </div>
              ))}

              {upcomingQueue.length > 5 && (
                <button type="button" className="remote-view-all-queue-btn" onClick={onOpenQueue}>
                  View all {upcomingQueue.length} queued songs &rarr;
                </button>
              )}
            </div>
          )}
        </section>
      </main>
    </div>
  );
};

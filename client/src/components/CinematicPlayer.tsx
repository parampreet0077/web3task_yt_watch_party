import React, { useEffect, useState, useRef, useCallback } from 'react';
import type { Role, SafePlaybackState } from '../types/room';
import { useYouTubeIframe } from '../hooks/useYouTubeIframe';
import { formatTime, SUPPORTED_PLAYBACK_RATES } from '../utils/youtube';

interface CinematicPlayerProps {
  userRole: Role;
  playbackState: SafePlaybackState | null;
  pendingRequestsCount: number;
  onPlay: (timestamp?: number) => Promise<boolean>;
  onPause: (timestamp?: number) => Promise<boolean>;
  onSeek: (timestamp: number) => Promise<boolean>;
  onSetRate: (rate: number) => Promise<boolean>;
  onOpenChangeVideoModal: () => void;
  onOpenRequestsModal: () => void;
}

export const CinematicPlayer: React.FC<CinematicPlayerProps> = ({
  userRole,
  playbackState,
  pendingRequestsCount,
  onPlay,
  onPause,
  onSeek,
  onSetRate,
  onOpenChangeVideoModal,
  onOpenRequestsModal,
}) => {
  const isPrivileged = userRole === 'HOST' || userRole === 'MODERATOR';
  const containerId = 'youtube-iframe-container';

  const [localTime, setLocalTime] = useState<number>(0);
  const [duration, setDuration] = useState<number>(0);
  const [isScrubbing, setIsScrubbing] = useState(false);
  const [scrubValue, setScrubValue] = useState<number>(0);
  const [isFullscreen, setIsFullscreen] = useState(false);

  const activeVideoIdRef = useRef<string | null>(null);
  const playerWrapperRef = useRef<HTMLDivElement>(null);

  // Echo suppression: prevent programmatic updates from firing secondary socket events back to server
  const isProgrammaticUpdateRef = useRef<boolean>(false);
  const programmaticTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const toggleFullscreen = useCallback(async () => {
    const container = playerWrapperRef.current;
    if (!container) return;

    const fsDoc = document as any;
    const isCurrentlyFs = Boolean(
      document.fullscreenElement ||
      fsDoc.webkitFullscreenElement ||
      fsDoc.mozFullScreenElement ||
      fsDoc.msFullscreenElement
    );

    if (!isCurrentlyFs) {
      try {
        if (container.requestFullscreen) {
          await container.requestFullscreen();
        } else if ((container as any).webkitRequestFullscreen) {
          await (container as any).webkitRequestFullscreen();
        } else if ((container as any).msRequestFullscreen) {
          await (container as any).msRequestFullscreen();
        }
      } catch (err) {
        console.warn('Failed to enter fullscreen:', err);
      }
    } else {
      try {
        if (document.exitFullscreen) {
          await document.exitFullscreen();
        } else if (fsDoc.webkitExitFullscreen) {
          await fsDoc.webkitExitFullscreen();
        } else if (fsDoc.msExitFullscreen) {
          await fsDoc.msExitFullscreen();
        }
      } catch (err) {
        console.warn('Failed to exit fullscreen:', err);
      }
    }
  }, []);

  // Listen to fullscreen changes and Escape key
  useEffect(() => {
    const handleFullscreenChange = () => {
      const fsDoc = document as any;
      const activeEl =
        document.fullscreenElement ||
        fsDoc.webkitFullscreenElement ||
        fsDoc.mozFullScreenElement ||
        fsDoc.msFullscreenElement;
      setIsFullscreen(Boolean(activeEl && playerWrapperRef.current?.contains(activeEl as Node)));
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        const fsDoc = document as any;
        const isFs = Boolean(
          document.fullscreenElement ||
          fsDoc.webkitFullscreenElement ||
          fsDoc.mozFullScreenElement ||
          fsDoc.msFullscreenElement
        );
        if (isFs && document.exitFullscreen) {
          document.exitFullscreen().catch(() => {});
        }
      }
    };

    document.addEventListener('fullscreenchange', handleFullscreenChange);
    document.addEventListener('webkitfullscreenchange', handleFullscreenChange);
    document.addEventListener('mozfullscreenchange', handleFullscreenChange);
    document.addEventListener('MSFullscreenChange', handleFullscreenChange);
    document.addEventListener('keydown', handleKeyDown);

    return () => {
      document.removeEventListener('fullscreenchange', handleFullscreenChange);
      document.removeEventListener('webkitfullscreenchange', handleFullscreenChange);
      document.removeEventListener('mozfullscreenchange', handleFullscreenChange);
      document.removeEventListener('MSFullscreenChange', handleFullscreenChange);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, []);

  const setProgrammaticUpdate = useCallback((durationMs = 800) => {
    isProgrammaticUpdateRef.current = true;
    if (programmaticTimerRef.current) {
      clearTimeout(programmaticTimerRef.current);
    }
    programmaticTimerRef.current = setTimeout(() => {
      isProgrammaticUpdateRef.current = false;
    }, durationMs);
  }, []);

  const {
    isPlayerReady,
    playerError,
    loadVideoById,
    cueVideoById,
    playVideo,
    pauseVideo,
    seekTo,
    setPlaybackRate,
    getCurrentTime,
    getDuration,
    setPlayerError,
  } = useYouTubeIframe({
    containerId,
    videoId: playbackState?.currentVideoId || null,
    onPlayerReady: () => {
      // Sync immediately when player is ready
      if (playbackState?.currentVideoId) {
        activeVideoIdRef.current = playbackState.currentVideoId;
        let targetTime = playbackState.currentTimestamp;
        if (playbackState.isPlaying && playbackState.serverTime) {
          const serverAgeSeconds = (Date.now() - playbackState.serverTime) / 1000;
          targetTime += Math.max(0, serverAgeSeconds * playbackState.playbackRate);
        }

        setProgrammaticUpdate(1000);
        if (playbackState.isPlaying) {
          loadVideoById(playbackState.currentVideoId, targetTime);
          playVideo();
        } else {
          cueVideoById(playbackState.currentVideoId, targetTime);
          pauseVideo();
        }
      }
    },
    onStateChange: (state: number) => {
      // Echo suppression: ignore events triggered programmatically by incoming server state
      if (isProgrammaticUpdateRef.current) return;

      const currentTime = getCurrentTime();

      // State 1: PLAYING
      if (state === 1) {
        if (!playbackState?.isPlaying) {
          // If authoritative room state is PAUSED, prevent unwanted autoplay or buffer transition
          setProgrammaticUpdate(800);
          pauseVideo();
          return;
        }

        if (isPrivileged) {
          // Privileged user initiated play via YouTube player click/shortcut
          // Play state is already active in playbackState
        } else {
          // Participant: ensure we match authoritative host playback position (handles mobile late-join autoplay race)
          if (playbackState.isPlaying && playbackState.serverTime) {
            const serverAgeSeconds = (Date.now() - playbackState.serverTime) / 1000;
            const targetTime = playbackState.currentTimestamp + Math.max(0, serverAgeSeconds * playbackState.playbackRate);
            const drift = Math.abs(currentTime - targetTime);
            if (drift > 1.2) {
              setProgrammaticUpdate(800);
              seekTo(targetTime, true);
              setLocalTime(targetTime);
            }
          }
        }
      }

      // State 2: PAUSED
      else if (state === 2) {
        if (isPrivileged) {
          if (playbackState?.isPlaying) {
            // Privileged user initiated pause via YouTube player click/shortcut
            setProgrammaticUpdate(800);
            onPause(currentTime);
          }
        } else {
          // Participant cannot pause while room is actively playing
          if (playbackState?.isPlaying) {
            setProgrammaticUpdate(500);
            playVideo();
          }
        }
      }

      // State 3: BUFFERING while paused (prevent autoplay on buffer complete)
      else if (state === 3) {
        if (playbackState && !playbackState.isPlaying) {
          pauseVideo();
        }
      }

      // State 0: ENDED
      else if (state === 0 && isPrivileged && playbackState?.isPlaying) {
        setProgrammaticUpdate(800);
        onPause(getDuration() || currentTime);
      }
    },
    onError: (_code, message) => {
      console.warn('YouTube Player reported error:', message);
    },
  });

  // Track video duration and current time tick for smooth scrubber display
  useEffect(() => {
    if (!isPlayerReady || !playbackState?.currentVideoId) return;

    const interval = setInterval(() => {
      if (!isScrubbing) {
        const time = getCurrentTime();
        setLocalTime(time);
        const dur = getDuration();
        if (dur > 0 && dur !== duration) {
          setDuration(dur);
        }
      }
    }, 250);

    return () => clearInterval(interval);
  }, [isPlayerReady, playbackState?.currentVideoId, isScrubbing, getCurrentTime, getDuration, duration]);

  // Synchronize playback state changes from server (bounded drift correction & echo suppression)
  useEffect(() => {
    if (!isPlayerReady || !playbackState) return;

    const targetVideoId = playbackState.currentVideoId;

    // 1. Video Change
    if (targetVideoId !== activeVideoIdRef.current) {
      activeVideoIdRef.current = targetVideoId;
      if (targetVideoId) {
        setPlayerError(null);
        setProgrammaticUpdate(1000);
        if (playbackState.isPlaying) {
          loadVideoById(targetVideoId, playbackState.currentTimestamp);
          playVideo();
        } else {
          cueVideoById(targetVideoId, playbackState.currentTimestamp);
          pauseVideo();
        }
      }
      return;
    }

    if (!targetVideoId) return;

    // 2. Compute authoritative target time with network latency drift
    let targetTime = playbackState.currentTimestamp;
    if (playbackState.isPlaying && playbackState.serverTime) {
      const serverAgeSeconds = (Date.now() - playbackState.serverTime) / 1000;
      targetTime += Math.max(0, serverAgeSeconds * playbackState.playbackRate);
    }

    // 3. Play / Pause & Timestamp synchronization
    setPlaybackRate(playbackState.playbackRate);

    if (playbackState.isPlaying) {
      setProgrammaticUpdate(800);
      playVideo();
      if (!isScrubbing) {
        const currentTime = getCurrentTime();
        const drift = Math.abs(currentTime - targetTime);

        // Bounded drift correction: seek only if drift exceeds 1.2s to prevent audio stutter
        if (drift > 1.2) {
          seekTo(targetTime, true);
          setLocalTime(targetTime);
        }
      }
    } else {
      setProgrammaticUpdate(1200);
      pauseVideo();
      if (!isScrubbing) {
        const currentTime = getCurrentTime();
        const drift = Math.abs(currentTime - targetTime);

        // When paused: only seek if drift is noticeable (> 1.2s).
        // Seeking for tiny sub-second drift while pausing can cancel the YouTube pause transition
        if (drift > 1.2) {
          seekTo(targetTime, true);
          setLocalTime(targetTime);
          setTimeout(() => {
            pauseVideo();
          }, 50);
        }
      }
    }
  }, [
    playbackState,
    isPlayerReady,
    isScrubbing,
    loadVideoById,
    cueVideoById,
    playVideo,
    pauseVideo,
    seekTo,
    setPlaybackRate,
    getCurrentTime,
    setPlayerError,
    setProgrammaticUpdate,
  ]);

  // Scrubber events
  const handleScrubberChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = parseFloat(e.target.value);
    setScrubValue(val);
    setLocalTime(val);
  };

  const handleScrubberCommit = () => {
    setIsScrubbing(false);
    if (isPrivileged) {
      setProgrammaticUpdate(800);
      onSeek(scrubValue);
    }
  };

  const togglePlayPause = () => {
    if (!isPrivileged) return;
    const currentT = getCurrentTime() || localTime;
    setProgrammaticUpdate(800);
    if (playbackState?.isPlaying) {
      onPause(currentT);
    } else {
      onPlay(currentT);
    }
  };

  const handleCenterPlayPauseClick = () => {
    if (isPrivileged) {
      togglePlayPause();
    } else {
      // Participant handling:
      // If room is actively playing (e.g. mobile joining where autoplay was restricted),
      // tapping center starts playback locally and immediately syncs drift to authoritative host time
      if (playbackState?.isPlaying) {
        setProgrammaticUpdate(800);
        playVideo();
        if (playbackState.serverTime) {
          const serverAgeSeconds = (Date.now() - playbackState.serverTime) / 1000;
          const targetTime = playbackState.currentTimestamp + Math.max(0, serverAgeSeconds * playbackState.playbackRate);
          const currentTime = getCurrentTime();
          if (Math.abs(currentTime - targetTime) > 1.0) {
            seekTo(targetTime, true);
            setLocalTime(targetTime);
          }
        }
      } else {
        // If room is paused, tapping center opens control requests modal
        onOpenRequestsModal();
      }
    }
  };

  const hasVideo = Boolean(playbackState?.currentVideoId);
  const displayTime = isScrubbing ? scrubValue : localTime;

  return (
    <div
      className={`cinematic-wrapper ${isFullscreen ? 'is-fullscreen' : ''}`}
      ref={playerWrapperRef}
      id="cinematic-player-wrapper"
    >
      <div className="cinematic-screen">
        {/* If no video is selected yet: show clean empty state */}
        {!hasVideo ? (
          <div className="player-empty-state" id="player-empty-state">
            <div className="empty-symbol-disc">
              <svg width="36" height="36" viewBox="0 0 24 24" fill="currentColor">
                <path d="M8 5v14l11-7z" />
              </svg>
            </div>
            <h2 className="empty-state-title">No Video Selected</h2>
            <p className="empty-state-text">
              {isPrivileged
                ? 'Choose a YouTube video using a URL or video ID to start the watch party.'
                : 'Waiting for the Room Host or a Moderator to load a video...'}
            </p>

            {isPrivileged ? (
              <button
                onClick={onOpenChangeVideoModal}
                className="btn-primary btn-lg"
                id="load-video-primary-btn"
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                  <polyline points="17 8 12 3 7 8" />
                  <line x1="12" y1="3" x2="12" y2="15" />
                </svg>
                Load YouTube Video
              </button>
            ) : (
              <button
                onClick={onOpenRequestsModal}
                className="btn-secondary"
                id="request-video-btn"
              >
                Request a Video
              </button>
            )}
          </div>
        ) : (
          /* Active video player iframe wrapper */
          <div className="iframe-responsive-box">
            <div id={containerId} className="yt-iframe-element" />

            {/* Loading spinner overlay while player is preparing/loading video */}
            {!isPlayerReady && !playerError && (
              <div className="player-loading-overlay" id="player-loading-spinner" role="status">
                <span className="mini-spinner" style={{ width: 32, height: 32, borderWidth: 3 }} />
                <p style={{ marginTop: '0.85rem', color: 'rgba(255, 255, 255, 0.9)', fontSize: '0.9rem', fontWeight: 500 }}>
                  Loading video player...
                </p>
              </div>
            )}

            {/* Error banner if video failed or is restricted */}
            {playerError && (
              <div className="player-error-overlay" role="alert">
                <div className="error-card">
                  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#ef4444" strokeWidth="2">
                    <circle cx="12" cy="12" r="10" />
                    <line x1="12" y1="8" x2="12" y2="12" />
                    <line x1="12" y1="16" x2="12.01" y2="16" />
                  </svg>
                  <p className="error-card-msg">{playerError}</p>
                  <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.5rem' }}>
                    <button
                      onClick={() => {
                        setPlayerError(null);
                        if (playbackState?.currentVideoId) {
                          setProgrammaticUpdate(800);
                          cueVideoById(playbackState.currentVideoId, playbackState.currentTimestamp);
                        }
                      }}
                      className="btn-secondary btn-sm"
                      id="retry-video-btn"
                    >
                      Retry
                    </button>
                    {isPrivileged && (
                      <button onClick={onOpenChangeVideoModal} className="btn-primary btn-sm">
                        Choose Another Video
                      </button>
                    )}
                  </div>
                </div>
              </div>
            )}

            {/* Center Play/Pause Overlay Button */}
            {isPlayerReady && !playerError && (
              <button
                type="button"
                className={`center-play-pause-btn ${playbackState?.isPlaying ? 'is-playing' : 'is-paused'}`}
                onClick={handleCenterPlayPauseClick}
                aria-label={playbackState?.isPlaying ? 'Pause video' : 'Play video'}
                title={
                  isPrivileged
                    ? playbackState?.isPlaying
                      ? 'Pause'
                      : 'Play'
                    : playbackState?.isPlaying
                    ? 'Request Pause'
                    : 'Request Play / Start Playback'
                }
                id="center-play-pause-btn"
              >
                {playbackState?.isPlaying ? (
                  <svg width="32" height="32" viewBox="0 0 24 24" fill="currentColor">
                    <rect x="6" y="4" width="4" height="16" rx="1" />
                    <rect x="14" y="4" width="4" height="16" rx="1" />
                  </svg>
                ) : (
                  <svg width="34" height="34" viewBox="0 0 24 24" fill="currentColor" style={{ marginLeft: 3 }}>
                    <path d="M8 5v14l11-7z" />
                  </svg>
                )}
              </button>
            )}
          </div>
        )}
      </div>

      {/* Control bar */}
      {hasVideo && (
        <div className="player-control-bar" id="player-control-bar">
          {/* Scrubber slider */}
          <div className="scrubber-container">
            <input
              type="range"
              min="0"
              max={duration > 0 ? duration : 100}
              step="0.5"
              value={displayTime}
              disabled={!isPrivileged}
              onMouseDown={() => setIsScrubbing(true)}
              onTouchStart={() => setIsScrubbing(true)}
              onChange={handleScrubberChange}
              onMouseUp={handleScrubberCommit}
              onTouchEnd={handleScrubberCommit}
              className={`scrubber-input ${!isPrivileged ? 'scrubber-readonly' : ''}`}
              title={isPrivileged ? 'Seek to timestamp' : 'Playback position controlled by Host'}
              id="player-scrubber"
            />
          </div>

          <div className="controls-row">
            {/* Play/Pause Button */}
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
              {isPrivileged ? (
                <button
                  onClick={togglePlayPause}
                  className="control-btn"
                  title={playbackState?.isPlaying ? 'Pause video' : 'Play video'}
                  id="play-pause-btn"
                >
                  {playbackState?.isPlaying ? (
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
                      <rect x="6" y="4" width="4" height="16" />
                      <rect x="14" y="4" width="4" height="16" />
                    </svg>
                  ) : (
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
                      <path d="M8 5v14l11-7z" />
                    </svg>
                  )}
                </button>
              ) : (
                <span className={`participant-playback-status ${playbackState?.isPlaying ? 'playing' : 'paused'}`}>
                  {playbackState?.isPlaying ? 'Playing' : 'Paused'}
                </span>
              )}

              {/* Timestamp display */}
              <span className="timestamp-display">
                {formatTime(displayTime)} / {formatTime(duration)}
              </span>
            </div>

            {/* Right-aligned action buttons */}
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              {/* Playback rate selector */}
              {isPrivileged ? (
                <select
                  value={playbackState?.playbackRate || 1.0}
                  onChange={(e) => onSetRate(parseFloat(e.target.value))}
                  className="rate-select"
                  title="Playback Speed"
                  id="playback-rate-select"
                >
                  {SUPPORTED_PLAYBACK_RATES.map((rate) => (
                    <option key={rate} value={rate}>
                      {rate}x
                    </option>
                  ))}
                </select>
              ) : (
                <span className="rate-badge">{playbackState?.playbackRate || 1}x</span>
              )}

              {/* Change video button (Host/Mod only) */}
              {isPrivileged && (
                <button
                  onClick={onOpenChangeVideoModal}
                  className="btn-secondary btn-sm"
                  id="change-video-btn"
                >
                  Change Video
                </button>
              )}

              {/* Participant Request button */}
              {!isPrivileged && (
                <button
                  onClick={onOpenRequestsModal}
                  className="btn-primary btn-sm"
                  id="participant-request-control-btn"
                >
                  Request Control
                </button>
              )}

              {/* Pending Requests Badge button for Host/Mod */}
              {isPrivileged && (
                <button
                  onClick={onOpenRequestsModal}
                  className={`btn-secondary btn-sm ${pendingRequestsCount > 0 ? 'badge-highlight' : ''}`}
                  id="view-requests-btn"
                >
                  Requests
                  {pendingRequestsCount > 0 && (
                    <span className="mini-badge-count">{pendingRequestsCount}</span>
                  )}
                </button>
              )}

              {/* Fullscreen Toggle Button */}
              <button
                onClick={toggleFullscreen}
                className="control-btn"
                id="player-fullscreen-btn"
                title={isFullscreen ? 'Exit Fullscreen (Esc)' : 'Enter Fullscreen'}
                aria-label={isFullscreen ? 'Exit Fullscreen' : 'Enter Fullscreen'}
              >
                {isFullscreen ? (
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M8 3v3a2 2 0 0 1-2 2H3m18 0h-3a2 2 0 0 1-2-2V3m0 18v-3a2 2 0 0 1 2-2h3M3 16h3a2 2 0 0 1 2 2v3" />
                  </svg>
                ) : (
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3" />
                  </svg>
                )}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

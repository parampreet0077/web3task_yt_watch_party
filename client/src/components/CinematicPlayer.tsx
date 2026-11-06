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
  onVideoEnded?: (videoId: string) => void;
  onMetadataDiscovered?: (meta: {
    videoId: string;
    durationSec: number;
    title: string;
    channelTitle: string;
    thumbnailUrl: string;
  }) => void;
}

const calculateProgressPercent = (time: number, dur: number): number => {
  if (!Number.isFinite(dur) || dur <= 0) return 0;
  if (!Number.isFinite(time) || time <= 0) return 0;
  const pct = (time / dur) * 100;
  if (!Number.isFinite(pct)) return 0;
  return Math.min(100, Math.max(0, pct));
};

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
  onVideoEnded,
  onMetadataDiscovered,
}) => {
  const isPrivileged = userRole === 'HOST' || userRole === 'MODERATOR';
  const containerId = 'youtube-iframe-container';

  const [localTime, setLocalTime] = useState<number>(0);
  const [duration, setDuration] = useState<number>(0);
  const [isScrubbing, setIsScrubbing] = useState(false);
  const [scrubValue, setScrubValue] = useState<number>(0);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [needsUserGestureResume, setNeedsUserGestureResume] = useState(false);

  const reportedMetaRef = useRef<string>('');
  const hasReportedEndRef = useRef<string | null>(null);

  const activeVideoIdRef = useRef<string | null>(null);
  const playerWrapperRef = useRef<HTMLDivElement>(null);
  const scrubberInputRef = useRef<HTMLInputElement>(null);
  const progressFillRef = useRef<HTMLDivElement>(null);
  const isScrubbingRef = useRef<boolean>(false);
  const scrubValueRef = useRef<number>(0);
  const durationRef = useRef<number>(0);
  const lastSampledTimeRef = useRef<number>(0);
  const lastSampledWallTimeRef = useRef<number>(0);
  const lastDisplayedSecondRef = useRef<number>(-1);
  const playerStateRef = useRef<number>(-1);

  // Echo suppression: prevent programmatic updates from firing secondary socket events back to server
  const isProgrammaticUpdateRef = useRef<boolean>(false);
  const programmaticTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isUserInitiatedPauseRef = useRef<boolean>(false);
  const isSeekingRef = useRef<boolean>(false);
  const seekingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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
    getVideoData,
    setPlayerError,
  } = useYouTubeIframe({
    containerId,
    videoId: playbackState?.currentVideoId || null,
    onPlayerReady: () => {
      // Sync immediately when player is ready
      if (playbackState?.currentVideoId) {
        activeVideoIdRef.current = playbackState.currentVideoId;
        durationRef.current = 0;
        setDuration(0);
        let targetTime = playbackState.currentTimestamp;
        if (playbackState.isPlaying && playbackState.serverTime) {
          const serverAgeSeconds = (Date.now() - playbackState.serverTime) / 1000;
          targetTime += Math.max(0, serverAgeSeconds * playbackState.playbackRate);
        }
        lastSampledTimeRef.current = targetTime;
        lastSampledWallTimeRef.current = performance.now();
        lastDisplayedSecondRef.current = Math.floor(targetTime);
        setLocalTime(targetTime);

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
      playerStateRef.current = state;
      const currentTime = getCurrentTime();
      lastSampledTimeRef.current = currentTime;
      lastSampledWallTimeRef.current = performance.now();

      // State 1: PLAYING
      if (state === 1) {
        isSeekingRef.current = false;
        isUserInitiatedPauseRef.current = false;
        setNeedsUserGestureResume(false);
        console.log(`[CinematicPlayer:Diagnostic]: YouTube Player state: PLAYING (1) at ${currentTime.toFixed(2)}s`);

        if (!playbackState?.isPlaying) {
          // If authoritative room state is PAUSED, prevent unwanted autoplay or buffer transition
          setProgrammaticUpdate(800);
          pauseVideo();
          return;
        }

        if (!isPrivileged) {
          // Participant: ensure we match authoritative host playback position
          if (playbackState.isPlaying && playbackState.serverTime) {
            const targetTime = playbackState.currentTimestamp;
            const drift = Math.abs(currentTime - targetTime);
            if (drift > 2.0 && !isScrubbingRef.current) {
              setProgrammaticUpdate(1200);
              seekTo(targetTime, true);
              setLocalTime(targetTime);
              lastSampledTimeRef.current = targetTime;
              lastSampledWallTimeRef.current = performance.now();
              lastDisplayedSecondRef.current = Math.floor(targetTime);
              if (progressFillRef.current) {
                progressFillRef.current.style.width = `${calculateProgressPercent(targetTime, durationRef.current)}%`;
              }
              if (scrubberInputRef.current && !isScrubbingRef.current) {
                scrubberInputRef.current.value = String(targetTime);
              }
            }
          }
        }
      }

      // State 2: PAUSED
      else if (state === 2) {
        const isDocHidden = typeof document !== 'undefined' && document.hidden;
        const isProgrammatic = isProgrammaticUpdateRef.current || isSeekingRef.current;
        const isRoomPlaying = Boolean(playbackState?.isPlaying);

        console.log(
          `[CinematicPlayer:Diagnostic]: YouTube Player state: PAUSED (2) at ${currentTime.toFixed(2)}s | roomPlaying=${isRoomPlaying} | docHidden=${isDocHidden} | programmatic=${isProgrammatic}`
        );

        // Echo suppression: ignore programmatic pauses (e.g. from seek or initial cue)
        if (isProgrammatic) {
          return;
        }

        // Background throttle protection: Chromium pauses background tab iframes.
        // NEVER broadcast pause to the room or attempt infinite force-play loops while tab is hidden!
        if (isDocHidden) {
          return;
        }

        // If the room is actively playing, user paused gestures are already handled directly by UI buttons.
        // An unexpected state 2 from YouTube indicates buffering stall or focus drop: re-synchronize without pausing room.
        if (isRoomPlaying) {
          setProgrammaticUpdate(800);
          try {
            const res: any = playVideo();
            if (res && typeof res.catch === 'function') {
              res.catch(() => {
                setNeedsUserGestureResume(true);
              });
            }
          } catch {
            setNeedsUserGestureResume(true);
          }
        }
      }

      // State 3: BUFFERING (Never interpret as user pause)
      else if (state === 3) {
        console.log('[CinematicPlayer:Diagnostic]: YouTube Player state: BUFFERING (3)');
        if (playbackState && !playbackState.isPlaying) {
          pauseVideo();
        }
      }

      // State 0: ENDED (Auto-advance to next video in queue)
      else if (state === 0) {
        console.log(`[CinematicPlayer:Diagnostic]: YouTube Player state: ENDED (0) for ${playbackState?.currentVideoId}`);
        setProgrammaticUpdate(3000);
        if (playbackState?.currentVideoId && hasReportedEndRef.current !== playbackState.currentVideoId) {
          hasReportedEndRef.current = playbackState.currentVideoId;
          onVideoEnded?.(playbackState.currentVideoId);
        }
      }
    },
    onError: (_code, message) => {
      console.warn('YouTube Player reported error:', message);
    },
  });

  // Track video duration and continuously update smooth progress bar fill at 60fps
  useEffect(() => {
    if (!isPlayerReady || !playbackState?.currentVideoId) return;

    let animId: number;

    const tick = () => {
      // 1. Discover or update duration if newly available
      const dur = getDuration();
      if (dur > 0 && dur !== durationRef.current) {
        durationRef.current = dur;
        setDuration(dur);
      }

      if (dur > 0 && playbackState?.currentVideoId) {
        const metaKey = `${playbackState.currentVideoId}:${Math.floor(dur)}`;
        if (reportedMetaRef.current !== metaKey) {
          reportedMetaRef.current = metaKey;
          const vData = getVideoData();
          onMetadataDiscovered?.({
            videoId: playbackState.currentVideoId,
            durationSec: Math.floor(dur),
            title: vData?.title || playbackState.videoTitle || 'YouTube Video',
            channelTitle: vData?.author || playbackState.channelTitle || 'YouTube',
            thumbnailUrl:
              playbackState.thumbnailUrl ||
              `https://img.youtube.com/vi/${playbackState.currentVideoId}/mqdefault.jpg`,
          });
        }
      }

      const currentDur = durationRef.current;
      const isRoomPlaying = Boolean(playbackState?.isPlaying);
      const isPlayerPlaying =
        playerStateRef.current === 1 ||
        (playerStateRef.current !== 2 && playerStateRef.current !== 3 && isRoomPlaying);

      if (!isScrubbingRef.current) {
        let currentTime = lastSampledTimeRef.current;

        if (playerStateRef.current === 0 && currentDur > 0) {
          // Video ended: clamp to full duration
          currentTime = currentDur;
        } else if (isRoomPlaying && isPlayerPlaying) {
          // Video is playing: sample actual YouTube player time
          const ytTime = getCurrentTime();
          const now = performance.now();

          // When YouTube reports an updated clock tick, update our anchor
          if (Math.abs(ytTime - lastSampledTimeRef.current) > 0.05) {
            lastSampledTimeRef.current = ytTime;
            lastSampledWallTimeRef.current = now;
          }

          // Smoothly interpolate between YouTube ticks using display refresh rate
          const elapsedSec = (now - lastSampledWallTimeRef.current) / 1000;
          const currentRate = playbackState?.playbackRate || 1;
          const boundedElapsed = Math.min(1.2, Math.max(0, elapsedSec * currentRate));
          currentTime = lastSampledTimeRef.current + boundedElapsed;

          if (currentDur > 0) {
            currentTime = Math.min(currentDur, currentTime);
          }

          // Fallback auto-next detection: YouTube frequently stops within 0.4s of end without firing State 0
          if (
            currentDur > 5 &&
            currentTime >= currentDur - 0.4 &&
            isRoomPlaying &&
            playbackState?.currentVideoId &&
            hasReportedEndRef.current !== playbackState.currentVideoId
          ) {
            hasReportedEndRef.current = playbackState.currentVideoId;
            console.log(
              `[CinematicPlayer:Diagnostic]: Video reached end threshold (${currentTime.toFixed(2)}s / ${currentDur.toFixed(2)}s). Triggering auto-next.`
            );
            setProgrammaticUpdate(3000);
            onVideoEnded?.(playbackState.currentVideoId);
          }
        } else {
          // Paused, buffering, or idle: poll reported time without advancing
          const ytTime = getCurrentTime();
          if (ytTime > 0) {
            currentTime = ytTime;
            lastSampledTimeRef.current = ytTime;
            lastSampledWallTimeRef.current = performance.now();
          }
        }

        // Update progress bar fill directly on DOM (0 React re-renders)
        const pct = calculateProgressPercent(currentTime, currentDur);
        if (progressFillRef.current) {
          progressFillRef.current.style.width = `${pct}%`;
        }

        // Update range slider input value so the thumb moves in exact lockstep
        if (scrubberInputRef.current) {
          scrubberInputRef.current.value = String(currentTime);
        }

        // Update React timestamp text state once per second
        const currentSec = Math.floor(currentTime);
        if (currentSec !== lastDisplayedSecondRef.current) {
          lastDisplayedSecondRef.current = currentSec;
          setLocalTime(currentTime);
        }
      }

      animId = requestAnimationFrame(tick);
    };

    animId = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(animId);
    };
  }, [
    isPlayerReady,
    playbackState?.currentVideoId,
    playbackState?.isPlaying,
    playbackState?.playbackRate,
    getCurrentTime,
    getDuration,
  ]);

  // Synchronize playback state changes from server (bounded drift correction & echo suppression)
  useEffect(() => {
    if (!isPlayerReady || !playbackState) return;

    const targetVideoId = playbackState.currentVideoId;

    // 1. Video Change
    if (targetVideoId !== activeVideoIdRef.current) {
      activeVideoIdRef.current = targetVideoId;
      hasReportedEndRef.current = null;
      setNeedsUserGestureResume(false);
      durationRef.current = 0;
      setDuration(0);
      lastSampledTimeRef.current = playbackState.currentTimestamp || 0;
      lastSampledWallTimeRef.current = performance.now();
      lastDisplayedSecondRef.current = -1;
      setLocalTime(playbackState.currentTimestamp || 0);
      if (progressFillRef.current) {
        progressFillRef.current.style.width = '0%';
      }
      if (scrubberInputRef.current) {
        scrubberInputRef.current.value = '0';
      }

      if (targetVideoId) {
        setPlayerError(null);
        setProgrammaticUpdate(3000);
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

    // 2. Compute authoritative target time with bounded latency
    let targetTime = playbackState.currentTimestamp;
    if (playbackState.isPlaying && playbackState.serverTime) {
      const serverAgeSeconds = (Date.now() - playbackState.serverTime) / 1000;
      if (serverAgeSeconds > 0 && serverAgeSeconds < 2.5) {
        targetTime += serverAgeSeconds * playbackState.playbackRate;
      }
    }

    // 3. Play / Pause & Timestamp synchronization
    setPlaybackRate(playbackState.playbackRate);

    if (playbackState.isPlaying) {
      setProgrammaticUpdate(1200);
      playVideo();
      if (!isScrubbing) {
        const currentTime = getCurrentTime();
        const drift = Math.abs(currentTime - targetTime);

        // Bounded drift correction: seek only if drift exceeds 1.8s and video has started
        if (drift > 1.8 && currentTime > 0) {
          isSeekingRef.current = true;
          if (seekingTimerRef.current) clearTimeout(seekingTimerRef.current);
          seekingTimerRef.current = setTimeout(() => {
            isSeekingRef.current = false;
          }, 2000);
          setProgrammaticUpdate(1500);
          seekTo(targetTime, true);
          setLocalTime(targetTime);
          lastSampledTimeRef.current = targetTime;
          lastSampledWallTimeRef.current = performance.now();
          lastDisplayedSecondRef.current = Math.floor(targetTime);
          if (progressFillRef.current) {
            progressFillRef.current.style.width = `${calculateProgressPercent(targetTime, durationRef.current)}%`;
          }
          if (scrubberInputRef.current && !isScrubbingRef.current) {
            scrubberInputRef.current.value = String(targetTime);
          }
        }
      }
    } else {
      setProgrammaticUpdate(1200);
      pauseVideo();
      if (!isScrubbing) {
        const currentTime = getCurrentTime();
        const drift = Math.abs(currentTime - targetTime);

        // When paused: only seek if drift is noticeable (> 1.5s).
        if (drift > 1.5) {
          seekTo(targetTime, true);
          setLocalTime(targetTime);
          lastSampledTimeRef.current = targetTime;
          lastSampledWallTimeRef.current = performance.now();
          lastDisplayedSecondRef.current = Math.floor(targetTime);
          if (progressFillRef.current) {
            progressFillRef.current.style.width = `${calculateProgressPercent(targetTime, durationRef.current)}%`;
          }
          if (scrubberInputRef.current && !isScrubbingRef.current) {
            scrubberInputRef.current.value = String(targetTime);
          }
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
    if (!Number.isFinite(val)) return;
    scrubValueRef.current = val;
    setScrubValue(val);
    setLocalTime(val);

    const pct = calculateProgressPercent(val, durationRef.current);
    if (progressFillRef.current) {
      progressFillRef.current.style.width = `${pct}%`;
    }
  };

  const handleScrubberCommit = useCallback(() => {
    if (!isScrubbingRef.current) return;
    isScrubbingRef.current = false;
    setIsScrubbing(false);

    const seekTarget = scrubberInputRef.current ? parseFloat(scrubberInputRef.current.value) : scrubValueRef.current;
    if (Number.isFinite(seekTarget)) {
      lastSampledTimeRef.current = seekTarget;
      lastSampledWallTimeRef.current = performance.now();
      lastDisplayedSecondRef.current = Math.floor(seekTarget);
      setLocalTime(seekTarget);

      if (isPrivileged) {
        setProgrammaticUpdate(800);
        onSeek(seekTarget);
      }
    }
  }, [isPrivileged, onSeek, setProgrammaticUpdate]);

  // Global pointer up listener while scrubbing to commit even if released outside the input element
  useEffect(() => {
    if (!isScrubbing) return;

    const handleGlobalPointerUp = () => {
      handleScrubberCommit();
    };

    window.addEventListener('mouseup', handleGlobalPointerUp);
    window.addEventListener('touchend', handleGlobalPointerUp);
    return () => {
      window.removeEventListener('mouseup', handleGlobalPointerUp);
      window.removeEventListener('touchend', handleGlobalPointerUp);
    };
  }, [isScrubbing, handleScrubberCommit]);

  const handleScrubberKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (!isPrivileged) return;
    if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(e.key)) {
      isScrubbingRef.current = true;
      setIsScrubbing(true);
    }
  };

  const handleScrubberKeyUp = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (!isPrivileged) return;
    if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(e.key)) {
      handleScrubberCommit();
    }
  };

  // Resume local playback when tab returns to foreground if room is playing
  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible' && playbackState?.isPlaying && isPlayerReady) {
        console.log('[CinematicPlayer]: Tab returned to foreground. Ensuring playback active.');
        setProgrammaticUpdate(800);
        playVideo();
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    window.addEventListener('focus', handleVisibilityChange);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      window.removeEventListener('focus', handleVisibilityChange);
    };
  }, [playbackState?.isPlaying, isPlayerReady, playVideo, setProgrammaticUpdate]);

  const togglePlayPause = useCallback(() => {
    if (!isPrivileged) return;
    const currentT = getCurrentTime() || localTime;
    setProgrammaticUpdate(800);
    if (playbackState?.isPlaying) {
      isUserInitiatedPauseRef.current = true;
      onPause(currentT);
    } else {
      isUserInitiatedPauseRef.current = false;
      onPlay(currentT);
    }
  }, [isPrivileged, getCurrentTime, localTime, setProgrammaticUpdate, playbackState?.isPlaying, onPause, onPlay]);

  // Global keyboard shortcuts (Spacebar for Play/Pause)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.code !== 'Space' && e.key !== ' ') return;

      const activeEl = document.activeElement as HTMLElement | null;
      if (activeEl) {
        const tagName = activeEl.tagName.toLowerCase();
        if (
          tagName === 'input' ||
          tagName === 'textarea' ||
          tagName === 'select' ||
          activeEl.isContentEditable
        ) {
          return;
        }
      }

      if (!isPrivileged || !playbackState?.currentVideoId) return;

      e.preventDefault();
      togglePlayPause();
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [isPrivileged, playbackState?.currentVideoId, togglePlayPause]);

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
      className={`cinematic-wrapper player-wrapper ${isFullscreen ? 'is-fullscreen' : ''}`}
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

            {/* Autoplay / Background Suspension Resume Badge */}
            {needsUserGestureResume && isPlayerReady && !playerError && (
              <button
                type="button"
                className="player-gesture-resume-badge"
                onClick={() => {
                  setNeedsUserGestureResume(false);
                  setProgrammaticUpdate(1200);
                  playVideo();
                }}
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M8 5v14l11-7z" />
                </svg>
                <span>Tap to Resume Playback</span>
              </button>
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
            <div className="scrubber-track">
              <div
                ref={progressFillRef}
                className="scrubber-fill"
                style={{
                  width: `${calculateProgressPercent(displayTime, duration)}%`,
                }}
              />
            </div>
            <input
              ref={scrubberInputRef}
              type="range"
              min="0"
              max={duration > 0 ? duration : 100}
              step="any"
              defaultValue={displayTime}
              disabled={!isPrivileged}
              onMouseDown={() => {
                isScrubbingRef.current = true;
                setIsScrubbing(true);
              }}
              onTouchStart={() => {
                isScrubbingRef.current = true;
                setIsScrubbing(true);
              }}
              onKeyDown={handleScrubberKeyDown}
              onKeyUp={handleScrubberKeyUp}
              onChange={handleScrubberChange}
              onMouseUp={handleScrubberCommit}
              onTouchEnd={handleScrubberCommit}
              className={`scrubber-input ${!isPrivileged ? 'scrubber-readonly' : ''}`}
              title={isPrivileged ? 'Seek to timestamp' : 'Playback position controlled by Host'}
              aria-label="Video playback progress"
              aria-valuemin={0}
              aria-valuemax={duration > 0 ? duration : 100}
              aria-valuenow={displayTime}
              aria-valuetext={`${formatTime(displayTime)} of ${formatTime(duration)}`}
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

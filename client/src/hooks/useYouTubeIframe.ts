import { useEffect, useRef, useState, useCallback } from 'react';

declare global {
  interface Window {
    YT: any;
    onYouTubeIframeAPIReady: (() => void) | undefined;
  }
}

export interface UseYouTubePlayerOptions {
  containerId: string;
  videoId?: string | null;
  onPlayerReady?: () => void;
  onStateChange?: (state: number) => void;
  onError?: (errorCode: number, errorMessage: string) => void;
}

export function useYouTubeIframe(options: UseYouTubePlayerOptions) {
  const { containerId, videoId, onPlayerReady, onStateChange, onError } = options;
  const playerRef = useRef<any>(null);
  const [isApiReady, setIsApiReady] = useState(false);
  const [isPlayerReady, setIsPlayerReady] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [playerError, setPlayerError] = useState<string | null>(null);

  // Keep callbacks in refs to avoid stale closures inside YouTube API event handlers
  const onPlayerReadyRef = useRef(onPlayerReady);
  const onStateChangeRef = useRef(onStateChange);
  const onErrorRef = useRef(onError);
  useEffect(() => { onPlayerReadyRef.current = onPlayerReady; }, [onPlayerReady]);
  useEffect(() => { onStateChangeRef.current = onStateChange; }, [onStateChange]);
  useEffect(() => { onErrorRef.current = onError; }, [onError]);

  // 1. Safe YouTube API script loader (prevents duplicate injection)
  useEffect(() => {
    if (window.YT && window.YT.Player) {
      setIsApiReady(true);
      return;
    }

    const SCRIPT_ID = 'youtube-iframe-api-tag';
    let scriptTag = document.getElementById(SCRIPT_ID) as HTMLScriptElement | null;

    const previousReady = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      if (typeof previousReady === 'function') {
        previousReady();
      }
      setIsApiReady(true);
    };

    if (!scriptTag) {
      scriptTag = document.createElement('script');
      scriptTag.id = SCRIPT_ID;
      scriptTag.src = 'https://www.youtube.com/iframe_api';
      scriptTag.async = true;
      document.head.appendChild(scriptTag);
    }
  }, []);

  // 2. Initialize YouTube Player when API is ready, container element exists, and videoId is provided
  useEffect(() => {
    if (!isApiReady || !videoId) {
      if (!videoId && playerRef.current) {
        if (typeof playerRef.current.destroy === 'function') {
          try {
            playerRef.current.destroy();
          } catch {
            // Ignore
          }
        }
        playerRef.current = null;
        setIsPlayerReady(false);
        setIsLoading(false);
      }
      return;
    }

    // If player already exists, keep it active; video loading and playback state
    // are authoritatively orchestrated by CinematicPlayer (via cueVideoById / loadVideoById)
    if (playerRef.current) {
      return;
    }

    // Helper: create the YT.Player on a confirmed container element
    const createPlayer = (vid: string) => {
      setIsLoading(true);
      setPlayerError(null);
      try {
        playerRef.current = new window.YT.Player(containerId, {
          height: '100%',
          width: '100%',
          videoId: vid,
          playerVars: {
            autoplay: 0,
            controls: 0, // Custom controls to enforce role-based playback
            modestbranding: 1,
            rel: 0,
            fs: 1,
            playsinline: 1,
            origin: window.location.origin,
          },
          events: {
            onReady: () => {
              setIsPlayerReady(true);
              setIsLoading(false);
              setPlayerError(null);
              onPlayerReadyRef.current?.();
            },
            onStateChange: (event: any) => {
              onStateChangeRef.current?.(event.data);
            },
            onError: (event: any) => {
              const code = event.data;
              let msg = 'An error occurred while loading this YouTube video.';
              if (code === 2) {
                msg = 'Invalid YouTube video ID or parameter.';
              } else if (code === 5) {
                msg = 'HTML5 player playback error.';
              } else if (code === 100) {
                msg = 'Video not found or is marked private.';
              } else if (code === 101 || code === 150) {
                msg = 'Embedding restricted: The creator does not permit playback outside YouTube.';
              }
              setPlayerError(msg);
              setIsLoading(false);
              onErrorRef.current?.(code, msg);
            },
          },
        });
      } catch (err) {
        console.error('Error initializing YouTube Player:', err);
        setIsLoading(false);
        setPlayerError('Failed to initialize YouTube player.');
      }
    };

    // Container may not be in DOM yet if React just committed this render — use rAF as safety net
    const container = document.getElementById(containerId);
    if (container) {
      createPlayer(videoId);
    } else {
      requestAnimationFrame(() => {
        if (document.getElementById(containerId)) {
          createPlayer(videoId);
        } else {
          console.warn('[useYouTubeIframe] Container element not found:', containerId);
        }
      });
    }

    return () => {
      if (playerRef.current && typeof playerRef.current.destroy === 'function') {
        try {
          playerRef.current.destroy();
        } catch {
          // Ignore destruction errors
        }
        playerRef.current = null;
        setIsPlayerReady(false);
        setIsLoading(false);
      }
    };
  }, [isApiReady, containerId, videoId]);

  const loadVideoById = useCallback((videoId: string, startSeconds = 0) => {
    setPlayerError(null);
    if (playerRef.current && typeof playerRef.current.loadVideoById === 'function') {
      playerRef.current.loadVideoById({
        videoId,
        startSeconds,
      });
    }
  }, []);

  const cueVideoById = useCallback((videoId: string, startSeconds = 0) => {
    setPlayerError(null);
    if (playerRef.current && typeof playerRef.current.cueVideoById === 'function') {
      playerRef.current.cueVideoById({
        videoId,
        startSeconds,
      });
    }
  }, []);

  const playVideo = useCallback(() => {
    if (playerRef.current && typeof playerRef.current.playVideo === 'function') {
      playerRef.current.playVideo();
    }
  }, []);

  const pauseVideo = useCallback(() => {
    if (playerRef.current && typeof playerRef.current.pauseVideo === 'function') {
      playerRef.current.pauseVideo();
    }
  }, []);

  const seekTo = useCallback((seconds: number, allowSeekAhead = true) => {
    if (playerRef.current && typeof playerRef.current.seekTo === 'function') {
      playerRef.current.seekTo(seconds, allowSeekAhead);
    }
  }, []);

  const setPlaybackRate = useCallback((rate: number) => {
    if (playerRef.current && typeof playerRef.current.setPlaybackRate === 'function') {
      playerRef.current.setPlaybackRate(rate);
    }
  }, []);

  const getCurrentTime = useCallback((): number => {
    if (playerRef.current && typeof playerRef.current.getCurrentTime === 'function') {
      return playerRef.current.getCurrentTime() || 0;
    }
    return 0;
  }, []);

  const getDuration = useCallback((): number => {
    if (playerRef.current && typeof playerRef.current.getDuration === 'function') {
      return playerRef.current.getDuration() || 0;
    }
    return 0;
  }, []);

  const getPlayerState = useCallback((): number => {
    if (playerRef.current && typeof playerRef.current.getPlayerState === 'function') {
      return playerRef.current.getPlayerState();
    }
    return -1;
  }, []);

  return {
    isApiReady,
    isPlayerReady,
    isLoading,
    playerError,
    loadVideoById,
    cueVideoById,
    playVideo,
    pauseVideo,
    seekTo,
    setPlaybackRate,
    getCurrentTime,
    getDuration,
    getPlayerState,
    setPlayerError,
  };
}

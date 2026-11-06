import React, { useState, useEffect, useRef, useCallback } from 'react';
import type { Role } from '../types/room';
import { searchYouTubeVideos, type YouTubeSearchResult } from '../services/api';
import { extractYouTubeVideoId } from '../utils/youtube';

interface YouTubeSearchModalProps {
  isOpen: boolean;
  onClose: () => void;
  roomCode: string;
  sessionToken: string;
  userRole: Role;
  onAddToQueue: (item: {
    videoId: string;
    title: string;
    channelTitle: string;
    thumbnailUrl: string;
    durationSec: number;
    playNext?: boolean;
  }) => Promise<{ success: boolean; error?: string }>;
  onPlayNow?: (videoId: string) => Promise<boolean>;
}

export const YouTubeSearchModal: React.FC<YouTubeSearchModalProps> = ({
  isOpen,
  onClose,
  roomCode,
  sessionToken,
  userRole,
  onAddToQueue,
  onPlayNow,
}) => {
  const [activeTab, setActiveTab] = useState<'search' | 'direct'>('search');
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<YouTubeSearchResult[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [addedItemIds, setAddedItemIds] = useState<Record<string, string>>({}); // itemId -> feedback message
  const [directInput, setDirectInput] = useState('');
  const [directError, setDirectError] = useState<string | null>(null);
  const [isSubmittingDirect, setIsSubmittingDirect] = useState(false);

  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isPrivileged = userRole === 'HOST' || userRole === 'MODERATOR';

  // Perform backend search with debounce
  const executeSearch = useCallback(
    async (searchTerm: string) => {
      if (!searchTerm.trim()) {
        setResults([]);
        setIsLoading(false);
        setErrorMessage(null);
        return;
      }

      // Check if user pasted a YouTube link into the search box
      const directId = extractYouTubeVideoId(searchTerm.trim());
      if (directId && searchTerm.trim().includes('http')) {
        setActiveTab('direct');
        setDirectInput(searchTerm.trim());
        return;
      }

      setIsLoading(true);
      setErrorMessage(null);

      try {
        const response = await searchYouTubeVideos(roomCode, searchTerm.trim(), sessionToken);
        setResults(response.results || []);
      } catch (err: any) {
        setErrorMessage(err?.message || 'Failed to search YouTube videos. Please try again.');
        setResults([]);
      } finally {
        setIsLoading(false);
      }
    },
    [roomCode, sessionToken]
  );

  // Debounce search input
  useEffect(() => {
    if (!isOpen) return;

    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
    }

    if (!query.trim()) {
      setResults([]);
      setIsLoading(false);
      return;
    }

    setIsLoading(true);
    debounceTimerRef.current = setTimeout(() => {
      executeSearch(query);
    }, 380);

    return () => {
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
      }
    };
  }, [query, isOpen, executeSearch]);

  // Reset states on modal close/open
  useEffect(() => {
    if (isOpen) {
      setErrorMessage(null);
      setDirectError(null);
      setAddedItemIds({});
    } else {
      setQuery('');
      setResults([]);
      setDirectInput('');
    }
  }, [isOpen]);

  // Handle ESC key to close
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isOpen) {
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  const handleAdd = async (item: YouTubeSearchResult, playNext = false) => {
    if (!isPrivileged) return;

    try {
      const res = await onAddToQueue({
        videoId: item.videoId,
        title: item.title,
        channelTitle: item.channelTitle,
        thumbnailUrl: item.thumbnailUrl,
        durationSec: item.durationSec,
        playNext,
      });

      if (res.success) {
        setAddedItemIds((prev) => ({
          ...prev,
          [item.videoId]: playNext ? 'Playing Next!' : 'Added to Queue!',
        }));
        setTimeout(() => {
          setAddedItemIds((prev) => {
            const copy = { ...prev };
            delete copy[item.videoId];
            return copy;
          });
        }, 2200);
      } else {
        setErrorMessage(res.error || 'Failed to add item to queue');
      }
    } catch (err: any) {
      setErrorMessage(err?.message || 'An error occurred adding to queue');
    }
  };

  const handlePlayNow = async (videoId: string) => {
    if (!isPrivileged || !onPlayNow) return;
    try {
      const success = await onPlayNow(videoId);
      if (success) {
        onClose();
      }
    } catch (err: any) {
      setErrorMessage(err?.message || 'Failed to start playback');
    }
  };

  const handleDirectSubmit = async (action: 'play' | 'queue' | 'playNext') => {
    if (!isPrivileged) return;
    setDirectError(null);

    const videoId = extractYouTubeVideoId(directInput.trim());
    if (!videoId) {
      setDirectError('Please enter a valid 11-character YouTube video ID or full YouTube URL.');
      return;
    }

    setIsSubmittingDirect(true);
    try {
      if (action === 'play' && onPlayNow) {
        const success = await onPlayNow(videoId);
        if (success) onClose();
      } else {
        const res = await onAddToQueue({
          videoId,
          title: `YouTube Video (${videoId})`,
          channelTitle: '',
          thumbnailUrl: `https://img.youtube.com/vi/${videoId}/mqdefault.jpg`,
          durationSec: 0,
          playNext: action === 'playNext',
        });
        if (res.success) {
          setDirectInput('');
          onClose();
        } else {
          setDirectError(res.error || 'Failed to add to queue');
        }
      }
    } catch (err: any) {
      setDirectError(err?.message || 'An error occurred');
    } finally {
      setIsSubmittingDirect(false);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="modal-backdrop" onClick={onClose} role="dialog" aria-modal="true">
      <div className="modal-card search-modal-card" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="modal-header search-modal-header">
          <div className="search-modal-title-row">
            <div className="search-title-icon" aria-hidden="true">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="11" cy="11" r="8" />
                <line x1="21" y1="21" x2="16.65" y2="16.65" />
              </svg>
            </div>
            <div>
              <h2 className="modal-title">YouTube Search</h2>
              <p className="modal-subtitle">Find videos to add to the shared party queue</p>
            </div>
          </div>
          <button className="modal-close-btn" onClick={onClose} aria-label="Close modal">
            &times;
          </button>
        </div>

        {/* Tab Navigation */}
        <div className="search-tabs-row">
          <button
            type="button"
            className={`search-tab-btn ${activeTab === 'search' ? 'active' : ''}`}
            onClick={() => setActiveTab('search')}
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="11" cy="11" r="8" />
              <line x1="21" y1="21" x2="16.65" y2="16.65" />
            </svg>
            Search YouTube
          </button>
          <button
            type="button"
            className={`search-tab-btn ${activeTab === 'direct' ? 'active' : ''}`}
            onClick={() => setActiveTab('direct')}
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
              <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
            </svg>
            <span className="search-tab-label-full">Paste Link / ID (Always Works)</span>
            <span className="search-tab-label-short">Paste Link / ID</span>
          </button>
        </div>

        {/* Permission warning for non-privileged participants */}
        {!isPrivileged && (
          <div className="search-permission-banner">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="12" cy="12" r="10" />
              <line x1="12" y1="8" x2="12" y2="12" />
              <line x1="12" y1="16" x2="12.01" y2="16" />
            </svg>
            <span>You are a Participant. Only Room Hosts and Moderators can search and queue videos. Request Moderator access from the roster to add songs.</span>
          </div>
        )}

        {/* TAB 1: Search */}
        {activeTab === 'search' && (
          <div className="search-tab-content">
            {/* Search Input Bar */}
            <div className="search-input-wrapper">
              <svg className="search-input-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="11" cy="11" r="8" />
                <line x1="21" y1="21" x2="16.65" y2="16.65" />
              </svg>
              <input
                type="text"
                className="search-input-field"
                placeholder="Search songs, artists, playlists, or keywords..."
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                autoFocus
                disabled={!isPrivileged}
              />
              {query && (
                <button
                  type="button"
                  className="search-clear-btn"
                  onClick={() => setQuery('')}
                  aria-label="Clear search"
                >
                  &times;
                </button>
              )}
            </div>

            {/* Quick Suggestion Pills */}
            {!query && results.length === 0 && (
              <div className="search-suggestions-container">
                <span className="search-suggestions-label">Popular Party Vibes:</span>
                <div className="search-pills-row">
                  {['Lo-Fi Beats', 'Chillhop', 'Synthwave', 'Billboard Hits', 'Indie Rock', 'Coffee Shop Jazz'].map(
                    (vibe) => (
                      <button
                        key={vibe}
                        type="button"
                        className="search-suggestion-pill"
                        disabled={!isPrivileged}
                        onClick={() => {
                          setQuery(vibe);
                          executeSearch(vibe);
                        }}
                      >
                        {vibe}
                      </button>
                    )
                  )}
                </div>
              </div>
            )}

            {/* Error Banner */}
            {errorMessage && (
              <div className="search-error-banner" role="alert">
                <div className="search-error-header">
                  <div className="search-error-icon" aria-hidden="true">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <circle cx="12" cy="12" r="10" />
                      <line x1="12" y1="8" x2="12" y2="12" />
                      <line x1="12" y1="16" x2="12.01" y2="16" />
                    </svg>
                  </div>
                  <div className="search-error-text">
                    <h4 className="search-error-title">
                      {errorMessage.toLowerCase().includes('not configured') || errorMessage.toLowerCase().includes('api_key')
                        ? 'YouTube Search API Not Configured'
                        : errorMessage.toLowerCase().includes('quota')
                        ? 'YouTube API Quota Exceeded'
                        : errorMessage.toLowerCase().includes('invalid')
                        ? 'Invalid YouTube API Key'
                        : 'YouTube Search Error'}
                    </h4>
                    <p className="search-error-desc">{errorMessage}</p>
                    {(errorMessage.toLowerCase().includes('not configured') || errorMessage.toLowerCase().includes('api_key')) && (
                      <p className="search-error-hint">
                        <strong>For Host / Admin:</strong> Add <code>YouTube Data API Key</code> to <code>server/.env</code> or your Render dashboard. You can still paste any YouTube video link or ID directly!
                      </p>
                    )}
                  </div>
                </div>

                <div className="search-error-actions">
                  <button
                    type="button"
                    className="btn-primary btn-sm search-fallback-switch-btn"
                    onClick={() => {
                      setActiveTab('direct');
                      if (query.trim()) {
                        setDirectInput(query.trim());
                      }
                    }}
                  >
                    Paste Link / ID Instead &rarr;
                  </button>
                  <button
                    type="button"
                    className="btn-secondary btn-sm search-retry-btn"
                    onClick={() => executeSearch(query)}
                  >
                    Retry
                  </button>
                </div>
              </div>
            )}

            {/* Loading State */}
            {isLoading && (
              <div className="search-loading-container">
                <span className="mini-spinner search-spinner" />
                <p>Searching YouTube for "{query}"...</p>
              </div>
            )}

            {/* Empty State */}
            {!isLoading && query.trim() && results.length === 0 && !errorMessage && (
              <div className="search-empty-container">
                <div className="search-empty-icon" aria-hidden="true">
                  <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                    <circle cx="11" cy="11" r="8" />
                    <line x1="21" y1="21" x2="16.65" y2="16.65" />
                    <line x1="8" y1="11" x2="14" y2="11" />
                  </svg>
                </div>
                <h3>No videos found</h3>
                <p>Try searching with different keywords or paste a direct YouTube link.</p>
              </div>
            )}

            {/* Results List */}
            {!isLoading && results.length > 0 && (
              <div className="search-results-list">
                {results.map((item) => {
                  const feedback = addedItemIds[item.videoId];
                  return (
                    <div key={item.videoId} className="search-result-card">
                      {/* Thumbnail with duration badge */}
                      <div className="search-thumbnail-container">
                        <img
                          src={item.thumbnailUrl}
                          alt={item.title}
                          className="search-thumbnail-img"
                          loading="lazy"
                        />
                        <span className="search-duration-pill">{item.durationFormatted}</span>
                      </div>

                      {/* Video Info */}
                      <div className="search-video-info">
                        <h4 className="search-video-title" title={item.title}>
                          {item.title}
                        </h4>
                        <p className="search-video-channel">{item.channelTitle}</p>
                      </div>

                      {/* Action Buttons */}
                      <div className="search-actions-group">
                        {feedback ? (
                          <span className="search-success-feedback">{feedback}</span>
                        ) : (
                          <>
                            {onPlayNow && (
                              <button
                                type="button"
                                className="search-action-btn search-btn-play"
                                title="Play immediately"
                                disabled={!isPrivileged}
                                onClick={() => handlePlayNow(item.videoId)}
                              >
                                Play Now
                              </button>
                            )}
                            <button
                              type="button"
                              className="search-action-btn search-btn-next"
                              title="Play next in queue"
                              disabled={!isPrivileged}
                              onClick={() => handleAdd(item, true)}
                            >
                              Play Next
                            </button>
                            <button
                              type="button"
                              className="search-action-btn search-btn-queue"
                              title="Add to end of queue"
                              disabled={!isPrivileged}
                              onClick={() => handleAdd(item, false)}
                            >
                              + Queue
                            </button>
                          </>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {/* TAB 2: Direct Link / ID */}
        {activeTab === 'direct' && (
          <div className="search-tab-content direct-tab-content">
            <p className="direct-instructions">
              Enter any YouTube video link (e.g., <code>https://youtube.com/watch?v=...</code> or <code>https://youtu.be/...</code>) or standard 11-character video ID.
            </p>

            <div className="form-group">
              <label htmlFor="direct-video-input" className="form-label">
                YouTube URL or Video ID
              </label>
              <input
                id="direct-video-input"
                type="text"
                className="input-field"
                placeholder="e.g. https://www.youtube.com/watch?v=dQw4w9WgXcQ"
                value={directInput}
                onChange={(e) => {
                  setDirectInput(e.target.value);
                  setDirectError(null);
                }}
                disabled={!isPrivileged || isSubmittingDirect}
                autoFocus
              />
            </div>

            {directError && <p className="form-error">{directError}</p>}

            {/* Direct action buttons */}
            <div className="direct-actions-row">
              {onPlayNow && (
                <button
                  type="button"
                  className="btn-primary"
                  disabled={!isPrivileged || !directInput.trim() || isSubmittingDirect}
                  onClick={() => handleDirectSubmit('play')}
                >
                  Play Immediately
                </button>
              )}
              <button
                type="button"
                className="btn-secondary"
                disabled={!isPrivileged || !directInput.trim() || isSubmittingDirect}
                onClick={() => handleDirectSubmit('playNext')}
              >
                Play Next
              </button>
              <button
                type="button"
                className="btn-secondary"
                disabled={!isPrivileged || !directInput.trim() || isSubmittingDirect}
                onClick={() => handleDirectSubmit('queue')}
              >
                Add to Queue
              </button>
            </div>
          </div>
        )}

        {/* Footer */}
        <div className="modal-footer search-modal-footer">
          <span className="search-powered-by">Powered by YouTube Data API & Server Search Proxy</span>
          <button type="button" className="btn-secondary btn-sm" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
};

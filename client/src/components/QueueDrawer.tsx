import React, { useState } from 'react';
import type { QueueItemData, Role } from '../types/room';

interface QueueDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  queue: QueueItemData[];
  currentVideoId?: string | null;
  userRole: Role;
  onOpenSearch: () => void;
  onRemoveItem: (itemId: string) => Promise<boolean>;
  onReorderItem: (itemId: string, targetPosition: number) => Promise<boolean>;
  onPlayNext: (itemId?: string) => Promise<boolean>;
  onClearQueue: () => Promise<boolean>;
}

export const QueueDrawer: React.FC<QueueDrawerProps> = ({
  isOpen,
  onClose,
  queue,
  currentVideoId,
  userRole,
  onOpenSearch,
  onRemoveItem,
  onReorderItem,
  onPlayNext,
  onClearQueue,
}) => {
  const [isClearing, setIsClearing] = useState(false);
  const [activeActionId, setActiveActionId] = useState<string | null>(null);

  const isPrivileged = userRole === 'HOST' || userRole === 'MODERATOR';

  // Identify currently playing item (either marked PLAYING or matching current room video)
  const playingItem = queue.find((i) => i.status === 'PLAYING') ||
    (currentVideoId ? queue.find((i) => i.videoId === currentVideoId) : undefined);

  // Remaining queued items, ordered by position
  const upcomingItems = queue
    .filter((i) => i.status === 'QUEUED' && i.id !== playingItem?.id)
    .sort((a, b) => a.position - b.position);

  const handleMoveUp = async (item: QueueItemData, index: number) => {
    if (!isPrivileged || index <= 0) return;
    const targetPosition = Math.max(1, item.position - 1);
    setActiveActionId(item.id);
    try {
      await onReorderItem(item.id, targetPosition);
    } finally {
      setActiveActionId(null);
    }
  };

  const handleMoveDown = async (item: QueueItemData, index: number) => {
    if (!isPrivileged || index >= upcomingItems.length - 1) return;
    const targetPosition = item.position + 1;
    setActiveActionId(item.id);
    try {
      await onReorderItem(item.id, targetPosition);
    } finally {
      setActiveActionId(null);
    }
  };

  const handleRemove = async (itemId: string) => {
    if (!isPrivileged) return;
    setActiveActionId(itemId);
    try {
      await onRemoveItem(itemId);
    } finally {
      setActiveActionId(null);
    }
  };

  const handlePlayNow = async (itemId: string) => {
    if (!isPrivileged) return;
    setActiveActionId(itemId);
    try {
      await onPlayNext(itemId);
    } finally {
      setActiveActionId(null);
    }
  };

  const handleClear = async () => {
    if (!isPrivileged) return;
    if (!window.confirm('Clear all pending videos from the queue?')) return;
    setIsClearing(true);
    try {
      await onClearQueue();
    } finally {
      setIsClearing(false);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="drawer-backdrop" onClick={onClose} role="dialog" aria-modal="true">
      <aside className="drawer-panel queue-drawer-panel" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="drawer-header queue-drawer-header">
          <div className="queue-header-title-group">
            <div className="queue-header-icon" aria-hidden="true">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <line x1="8" y1="6" x2="21" y2="6" />
                <line x1="8" y1="12" x2="21" y2="12" />
                <line x1="8" y1="18" x2="21" y2="18" />
                <line x1="3" y1="6" x2="3.01" y2="6" />
                <line x1="3" y1="12" x2="3.01" y2="12" />
                <line x1="3" y1="18" x2="3.01" y2="18" />
              </svg>
            </div>
            <div>
              <h2 className="drawer-title">Party Queue</h2>
              <span className="queue-count-sub">
                {upcomingItems.length} {upcomingItems.length === 1 ? 'track' : 'tracks'} upcoming
              </span>
            </div>
          </div>

          <div className="queue-header-actions">
            {isPrivileged && (
              <button
                type="button"
                className="btn-primary btn-sm queue-add-header-btn"
                onClick={onOpenSearch}
                title="Search and add videos to queue"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <line x1="12" y1="5" x2="12" y2="19" />
                  <line x1="5" y1="12" x2="19" y2="12" />
                </svg>
                Add Video
              </button>
            )}
            <button className="drawer-close-btn" onClick={onClose} aria-label="Close Queue">
              &times;
            </button>
          </div>
        </div>

        {/* Content Body */}
        <div className="queue-drawer-body">
          {/* Section: NOW PLAYING */}
          {playingItem && (
            <div className="queue-section queue-now-playing-section">
              <div className="queue-section-header">
                <span className="queue-section-title">
                  <span className="queue-live-dot" />
                  Now Playing
                </span>
              </div>

              <div className="queue-item-card queue-item-active">
                <div className="queue-item-thumb-wrapper">
                  <img
                    src={playingItem.thumbnailUrl || `https://img.youtube.com/vi/${playingItem.videoId}/mqdefault.jpg`}
                    alt={playingItem.title}
                    className="queue-item-thumb"
                  />
                  <div className="queue-playing-equalizer" aria-hidden="true">
                    <span className="eq-bar eq-bar-1" />
                    <span className="eq-bar eq-bar-2" />
                    <span className="eq-bar eq-bar-3" />
                  </div>
                </div>

                <div className="queue-item-details">
                  <h4 className="queue-item-title" title={playingItem.title}>
                    {playingItem.title}
                  </h4>
                  <div className="queue-item-meta">
                    {playingItem.channelTitle && (
                      <span className="queue-item-channel">{playingItem.channelTitle}</span>
                    )}
                    <span className="queue-meta-bullet">•</span>
                    <span className="queue-item-duration">{playingItem.durationFormatted}</span>
                  </div>
                  <div className="queue-item-addedby">
                    Added by <span className="addedby-name">{playingItem.addedBy.displayName}</span>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* Section: UP NEXT */}
          <div className="queue-section queue-upcoming-section">
            <div className="queue-section-header">
              <span className="queue-section-title">Up Next</span>

              {isPrivileged && upcomingItems.length > 0 && (
                <div className="queue-section-header-btns">
                  <button
                    type="button"
                    className="queue-text-btn"
                    onClick={() => onPlayNext()}
                    title="Skip immediately to next queued item"
                  >
                    Skip to Next
                  </button>
                  <span className="queue-header-divider">|</span>
                  <button
                    type="button"
                    className="queue-text-btn queue-text-danger"
                    disabled={isClearing}
                    onClick={handleClear}
                    title="Clear all upcoming queued songs"
                  >
                    Clear Queue
                  </button>
                </div>
              )}
            </div>

            {/* Empty State */}
            {upcomingItems.length === 0 && (
              <div className="queue-empty-box">
                <div className="queue-empty-icon" aria-hidden="true">
                  <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                    <path d="M9 18V5l12-2v13" />
                    <circle cx="6" cy="18" r="3" />
                    <circle cx="18" cy="16" r="3" />
                  </svg>
                </div>
                <h3>The queue is empty</h3>
                <p>
                  {isPrivileged
                    ? 'Search YouTube or paste a video link to queue upcoming songs for everyone.'
                    : 'No upcoming tracks in the queue. Ask the Host or Moderator to add music!'}
                </p>
                {isPrivileged && (
                  <button type="button" className="btn-primary btn-sm queue-empty-add-btn" onClick={onOpenSearch}>
                    Search & Add Tracks
                  </button>
                )}
              </div>
            )}

            {/* List of Upcoming Items */}
            {upcomingItems.length > 0 && (
              <div className="queue-items-list">
                {upcomingItems.map((item, index) => {
                  const isProcessing = activeActionId === item.id;
                  return (
                    <div
                      key={item.id}
                      className={`queue-item-card ${isProcessing ? 'queue-item-processing' : ''}`}
                    >
                      {/* Position Badge */}
                      <span className="queue-pos-badge" title={`Queue Position ${index + 1}`}>
                        {index + 1}
                      </span>

                      {/* Thumbnail with duration */}
                      <div className="queue-item-thumb-wrapper">
                        <img
                          src={item.thumbnailUrl || `https://img.youtube.com/vi/${item.videoId}/mqdefault.jpg`}
                          alt={item.title}
                          className="queue-item-thumb"
                          loading="lazy"
                        />
                        <span className="queue-item-duration-badge">{item.durationFormatted}</span>
                      </div>

                      {/* Details */}
                      <div className="queue-item-details">
                        <h4 className="queue-item-title" title={item.title}>
                          {item.title}
                        </h4>
                        <div className="queue-item-meta">
                          {item.channelTitle && (
                            <span className="queue-item-channel">{item.channelTitle}</span>
                          )}
                          <span className="queue-meta-bullet">•</span>
                          <span className="queue-item-addedby">
                            Added by {item.addedBy.displayName}
                          </span>
                        </div>
                      </div>

                      {/* Privileged Controls */}
                      {isPrivileged && (
                        <div className="queue-item-controls">
                          {/* Play Immediately */}
                          <button
                            type="button"
                            className="queue-ctrl-btn queue-ctrl-play"
                            title="Play this track now"
                            disabled={isProcessing}
                            onClick={() => handlePlayNow(item.id)}
                          >
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                              <path d="M8 5v14l11-7z" />
                            </svg>
                          </button>

                          {/* Reorder Up */}
                          <button
                            type="button"
                            className="queue-ctrl-btn"
                            title="Move up in queue"
                            disabled={index === 0 || isProcessing}
                            onClick={() => handleMoveUp(item, index)}
                          >
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                              <polyline points="18 15 12 9 6 15" />
                            </svg>
                          </button>

                          {/* Reorder Down */}
                          <button
                            type="button"
                            className="queue-ctrl-btn"
                            title="Move down in queue"
                            disabled={index === upcomingItems.length - 1 || isProcessing}
                            onClick={() => handleMoveDown(item, index)}
                          >
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                              <polyline points="6 9 12 15 18 9" />
                            </svg>
                          </button>

                          {/* Remove */}
                          <button
                            type="button"
                            className="queue-ctrl-btn queue-ctrl-delete"
                            title="Remove from queue"
                            disabled={isProcessing}
                            onClick={() => handleRemove(item.id)}
                          >
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                              <line x1="18" y1="6" x2="6" y2="18" />
                              <line x1="6" y1="6" x2="18" y2="18" />
                            </svg>
                          </button>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="drawer-footer queue-drawer-footer">
          <span className="queue-footer-info">
            {isPrivileged
              ? 'Real-Time Sync: Queue updates automatically advance playback.'
              : 'View-Only Mode: Host & Moderators manage playback.'}
          </span>
          <button type="button" className="btn-secondary btn-sm" onClick={onClose}>
            Close
          </button>
        </div>
      </aside>
    </div>
  );
};

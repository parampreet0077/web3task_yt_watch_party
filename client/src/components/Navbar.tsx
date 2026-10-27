import React, { useState } from 'react';

interface NavbarProps {
  roomCode: string | null;
  roomTitle: string | null;
  isConnected: boolean;
  participantCount: number;
  onLeaveRoom: () => void;
}

export const Navbar: React.FC<NavbarProps> = ({
  roomCode,
  roomTitle,
  isConnected,
  participantCount,
  onLeaveRoom,
}) => {
  const [copied, setCopied] = useState(false);

  const copyRoomCode = () => {
    if (!roomCode) return;
    navigator.clipboard.writeText(roomCode);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <header className="navbar">
      <div className="navbar-container">
        {/* Brand */}
        <div className="brand">
          <div className="brand-icon" aria-hidden="true">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
              <path d="M8 5v14l11-7z" />
            </svg>
          </div>
          <div>
            <span className="brand-title">WatchParty</span>
            {roomTitle && <span className="room-title-sub"> — {roomTitle}</span>}
          </div>
        </div>

        {/* Room Info & Controls */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
          {roomCode && (
            <button
              onClick={copyRoomCode}
              className="room-code-badge"
              title="Click to copy Room Code"
              id="copy-room-code-btn"
            >
              <span style={{ color: 'var(--text-muted)', fontSize: '0.75rem' }}>ROOM:</span>
              <span className="code-text">{roomCode}</span>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
              </svg>
              {copied && <span className="copied-tooltip">Copied!</span>}
            </button>
          )}

          {/* Connection Status Indicator */}
          {roomCode && (
            <span className={`status-pill ${isConnected ? 'success' : 'warning'}`}>
              <span className={`dot ${isConnected ? 'success' : 'warning'}`} />
              {isConnected ? 'Real-Time Sync' : 'Connecting...'}
            </span>
          )}

          {roomCode && (
            <>
              <span className="participants-count-pill" title={`${participantCount} participant(s) in room`}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
                  <circle cx="9" cy="7" r="4" />
                  <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
                  <path d="M16 3.13a4 4 0 0 1 0 7.75" />
                </svg>
                {participantCount}
              </span>

              <button onClick={onLeaveRoom} className="btn-secondary btn-sm" id="leave-room-btn">
                Leave
              </button>
            </>
          )}
        </div>
      </div>
    </header>
  );
};

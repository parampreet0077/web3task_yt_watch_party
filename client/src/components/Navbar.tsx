import React, { useState } from 'react';
import type { Role } from '../types/room';
import { ThemeToggle } from './ThemeToggle';

interface NavbarProps {
  roomCode: string | null;
  roomTitle: string | null;
  isConnected: boolean;
  participantCount: number;
  currentMode: 'standard' | 'car' | 'remote';
  queueCount: number;
  userRole?: Role;
  onLeaveRoom: () => void;
  onToggleMode: (mode: 'standard' | 'car' | 'remote') => void;
  onOpenQueue: () => void;
  onOpenSearch: () => void;
  onOpenRemoteQR: () => void;
}

export const Navbar: React.FC<NavbarProps> = ({
  roomCode,
  roomTitle,
  isConnected,
  participantCount,
  currentMode,
  queueCount,
  userRole,
  onLeaveRoom,
  onToggleMode,
  onOpenQueue,
  onOpenSearch,
  onOpenRemoteQR,
}) => {
  const [copied, setCopied] = useState(false);
  const isPrivileged = userRole === 'HOST' || userRole === 'MODERATOR';

  const copyRoomCode = () => {
    if (!roomCode) return;
    navigator.clipboard.writeText(roomCode);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <header className="navbar room-navbar">
      <div className="navbar-container room-navbar-container">
        {/* Brand */}
        <div className="brand room-brand">
          <div className="brand-icon" aria-hidden="true">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
              <path d="M8 5v14l11-7z" />
            </svg>
          </div>
          <div className="brand-text-container">
            <span className="brand-title">WatchParty</span>
            {roomTitle && <span className="room-title-sub" title={roomTitle}> — {roomTitle}</span>}
          </div>
        </div>

        {/* Room Info, Mode Selectors & Controls */}
        <div className="room-header-controls">
          <div className="room-badges-row">
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
              <span className="participants-count-pill" title={`${participantCount} participant(s) in room`}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
                  <circle cx="9" cy="7" r="4" />
                  <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
                  <path d="M16 3.13a4 4 0 0 1 0 7.75" />
                </svg>
                <span>{participantCount}</span>
              </span>
            )}
          </div>

          {/* V2.0 Feature Buttons */}
          {roomCode && (
            <div className="navbar-v2-actions">
              {/* YouTube Search (Host / Mod) */}
              {isPrivileged && (
                <button
                  type="button"
                  className="nav-action-pill nav-search-pill"
                  onClick={onOpenSearch}
                  title="Search YouTube & Add to Queue"
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <circle cx="11" cy="11" r="8" />
                    <line x1="21" y1="21" x2="16.65" y2="16.65" />
                  </svg>
                  <span>Search</span>
                </button>
              )}

              {/* Shared Queue Drawer */}
              <button
                type="button"
                className={`nav-action-pill nav-queue-pill ${queueCount > 0 ? 'has-items' : ''}`}
                onClick={onOpenQueue}
                title="View shared music/video queue"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <line x1="8" y1="6" x2="21" y2="6" />
                  <line x1="8" y1="12" x2="21" y2="12" />
                  <line x1="8" y1="18" x2="21" y2="18" />
                  <line x1="3" y1="6" x2="3.01" y2="6" />
                  <line x1="3" y1="12" x2="3.01" y2="12" />
                  <line x1="3" y1="18" x2="3.01" y2="18" />
                </svg>
                <span>Queue {queueCount > 0 ? `(${queueCount})` : ''}</span>
              </button>

              {/* Mode Toggle Group */}
              <div className="nav-mode-selector">
                <button
                  type="button"
                  className={`nav-mode-btn ${currentMode === 'standard' ? 'active' : ''}`}
                  onClick={() => onToggleMode('standard')}
                  title="Standard Watch Party view"
                >
                  Standard
                </button>
                <button
                  type="button"
                  className={`nav-mode-btn ${currentMode === 'car' ? 'active' : ''}`}
                  onClick={() => onToggleMode('car')}
                  title="Car Infotainment / Landscape mode"
                >
                  Car Mode
                </button>
                <button
                  type="button"
                  className={`nav-mode-btn ${currentMode === 'remote' ? 'active' : ''}`}
                  onClick={() => onToggleMode('remote')}
                  title="Phone Remote controller mode"
                >
                  Remote
                </button>
              </div>

              {/* Connect Remote QR Pill */}
              <button
                type="button"
                className="nav-action-pill nav-qr-pill"
                onClick={onOpenRemoteQR}
                title="Connect Smartphone Remote Controller"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <rect x="5" y="2" width="14" height="20" rx="2" ry="2" />
                  <line x1="12" y1="18" x2="12.01" y2="18" />
                </svg>
                <span>Phone Remote</span>
              </button>
            </div>
          )}

          <ThemeToggle className="nav-theme-toggle" />

          {roomCode && (
            <div className="room-leave-wrapper">
              <button onClick={onLeaveRoom} className="btn-secondary btn-sm leave-room-btn" id="leave-room-btn" type="button">
                Leave
              </button>
            </div>
          )}
        </div>
      </div>
    </header>
  );
};

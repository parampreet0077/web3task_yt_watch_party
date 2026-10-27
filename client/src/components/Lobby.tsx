import React, { useState } from 'react';
import { motion } from 'motion/react';

interface LobbyProps {
  onCreateRoom: (displayName: string, title?: string) => Promise<void>;
  onJoinRoom: (roomCode: string, displayName: string) => Promise<void>;
  isLoading: boolean;
  errorMessage: string | null;
  onClearError: () => void;
}

export const Lobby: React.FC<LobbyProps> = ({
  onCreateRoom,
  onJoinRoom,
  isLoading,
  errorMessage,
  onClearError,
}) => {
  const [activeTab, setActiveTab] = useState<'create' | 'join'>('create');
  const [displayName, setDisplayName] = useState('');
  const [roomTitle, setRoomTitle] = useState('');
  const [roomCode, setRoomCode] = useState('');
  const [validationError, setValidationError] = useState<string | null>(null);

  React.useEffect(() => {
    try {
      const params = new URLSearchParams(window.location.search);
      const urlCode = params.get('room') || params.get('code');
      if (urlCode && urlCode.trim().length > 0) {
        setRoomCode(urlCode.trim().toUpperCase());
        setActiveTab('join');
      }
    } catch {
      // Ignore
    }
  }, []);

  const handleTabChange = (tab: 'create' | 'join') => {
    setActiveTab(tab);
    setValidationError(null);
    onClearError();
  };

  const handleCreateSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setValidationError(null);
    const trimmedName = displayName.trim();
    if (!trimmedName) {
      setValidationError('Please enter a display name (1–40 characters)');
      return;
    }
    if (trimmedName.length > 40) {
      setValidationError('Display name must be 40 characters or less');
      return;
    }

    await onCreateRoom(trimmedName, roomTitle.trim() || undefined);
  };

  const handleJoinSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setValidationError(null);
    const trimmedName = displayName.trim();
    const trimmedCode = roomCode.trim().toUpperCase();

    if (!trimmedCode) {
      setValidationError('Please enter a 6-character room code');
      return;
    }
    if (trimmedCode.length !== 6) {
      setValidationError('Room code must be exactly 6 characters');
      return;
    }
    if (!trimmedName) {
      setValidationError('Please enter your display name');
      return;
    }

    await onJoinRoom(trimmedCode, trimmedName);
  };

  return (
    <div className="lobby-wrapper">
      <motion.div
        className="lobby-card"
        initial={{ opacity: 0, y: 16 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.3 }}
      >
        <div className="lobby-header">
          <div className="lobby-badge">Synchronized YouTube Experience</div>
          <h1 className="lobby-title">Welcome to WatchParty</h1>
          <p className="lobby-subtitle">
            Create a private synchronized room or join your friends with a room code.
          </p>
        </div>

        {/* Tab navigation */}
        <div className="tab-pill-container">
          <button
            type="button"
            className={`tab-pill ${activeTab === 'create' ? 'active' : ''}`}
            onClick={() => handleTabChange('create')}
            id="tab-create-room"
          >
            Create New Room
          </button>
          <button
            type="button"
            className={`tab-pill ${activeTab === 'join' ? 'active' : ''}`}
            onClick={() => handleTabChange('join')}
            id="tab-join-room"
          >
            Join Existing Room
          </button>
        </div>

        {/* Error message */}
        {(validationError || errorMessage) && (
          <div className="alert alert-error" role="alert">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="12" cy="12" r="10" />
              <line x1="12" y1="8" x2="12" y2="12" />
              <line x1="12" y1="16" x2="12.01" y2="16" />
            </svg>
            <span>{validationError || errorMessage}</span>
          </div>
        )}

        {/* Tab 1: Create Room */}
        {activeTab === 'create' && (
          <form onSubmit={handleCreateSubmit} className="lobby-form" id="create-room-form">
            <div className="form-group">
              <label htmlFor="create-display-name" className="form-label">
                Your Display Name <span className="required">*</span>
              </label>
              <input
                id="create-display-name"
                type="text"
                className="form-input"
                placeholder="e.g. Alex"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                maxLength={40}
                required
                autoFocus
              />
              <span className="input-hint">This name will be visible to other room participants.</span>
            </div>

            <div className="form-group">
              <label htmlFor="create-room-title" className="form-label">
                Room Title <span className="optional">(optional)</span>
              </label>
              <input
                id="create-room-title"
                type="text"
                className="form-input"
                placeholder="e.g. Weekend Movie Night"
                value={roomTitle}
                onChange={(e) => setRoomTitle(e.target.value)}
                maxLength={100}
              />
            </div>

            <button
              type="submit"
              className="btn-primary btn-block"
              disabled={isLoading}
              id="submit-create-room-btn"
            >
              {isLoading ? (
                <span className="spinner-text">
                  <span className="mini-spinner" /> Creating Room...
                </span>
              ) : (
                'Create Watch Room'
              )}
            </button>
          </form>
        )}

        {/* Tab 2: Join Room */}
        {activeTab === 'join' && (
          <form onSubmit={handleJoinSubmit} className="lobby-form" id="join-room-form">
            <div className="form-group">
              <label htmlFor="join-room-code" className="form-label">
                6-Character Room Code <span className="required">*</span>
              </label>
              <input
                id="join-room-code"
                type="text"
                className="form-input code-input"
                placeholder="e.g. ABCDEF"
                value={roomCode}
                onChange={(e) => setRoomCode(e.target.value.toUpperCase().slice(0, 6))}
                maxLength={6}
                required
                autoFocus
              />
              <span className="input-hint">Ask the room Host for their 6-character room code.</span>
            </div>

            <div className="form-group">
              <label htmlFor="join-display-name" className="form-label">
                Your Display Name <span className="required">*</span>
              </label>
              <input
                id="join-display-name"
                type="text"
                className="form-input"
                placeholder="e.g. Jordan"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                maxLength={40}
                required
              />
            </div>

            <button
              type="submit"
              className="btn-primary btn-block"
              disabled={isLoading}
              id="submit-join-room-btn"
            >
              {isLoading ? (
                <span className="spinner-text">
                  <span className="mini-spinner" /> Joining Room...
                </span>
              ) : (
                'Join Watch Room'
              )}
            </button>
          </form>
        )}
      </motion.div>
    </div>
  );
};

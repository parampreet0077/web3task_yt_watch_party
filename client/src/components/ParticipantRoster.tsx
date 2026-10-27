import React, { useState, useRef, useEffect, useCallback } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import type { ParticipantData, Role } from '../types/room';

interface ParticipantRosterProps {
  participants: ParticipantData[];
  currentUserId: string;
  currentUserRole: Role;
  onUpdateRole: (participantId: string, role: Role) => Promise<void>;
  onRemoveParticipant: (participantId: string) => Promise<void>;
  onTransferHost?: (participantId: string) => Promise<void>;
  onRequestModerator?: () => Promise<void>;
}

export const ParticipantRoster: React.FC<ParticipantRosterProps> = ({
  participants,
  currentUserId,
  currentUserRole,
  onUpdateRole,
  onRemoveParticipant,
  onTransferHost,
  onRequestModerator,
}) => {
  const isHost = currentUserRole === 'HOST';
  const isParticipant = currentUserRole === 'PARTICIPANT';

  // Active open dropdown
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);
  const [loadingParticipantId, setLoadingParticipantId] = useState<string | null>(null);
  const [loadingAction, setLoadingAction] = useState<string | null>(null);
  const [hasRequestedMod, setHasRequestedMod] = useState(false);
  const [isRequestingMod, setIsRequestingMod] = useState(false);

  const menuRef = useRef<HTMLDivElement | null>(null);
  const triggerRefs = useRef<Map<string, HTMLButtonElement>>(new Map());

  // Close menu on outside click or escape key
  useEffect(() => {
    const handleOutsideClick = (e: MouseEvent | TouchEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        // Also check if click was on the trigger button
        const isTrigger = Array.from(triggerRefs.current.values()).some((btn) =>
          btn?.contains(e.target as Node)
        );
        if (!isTrigger) {
          setOpenMenuId(null);
        }
      }
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && openMenuId) {
        const trigger = triggerRefs.current.get(openMenuId);
        setOpenMenuId(null);
        trigger?.focus();
      }
    };

    document.addEventListener('mousedown', handleOutsideClick);
    document.addEventListener('touchstart', handleOutsideClick);
    document.addEventListener('keydown', handleKeyDown);

    return () => {
      document.removeEventListener('mousedown', handleOutsideClick);
      document.removeEventListener('touchstart', handleOutsideClick);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [openMenuId]);

  const toggleMenu = useCallback((participantId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setOpenMenuId((prev) => (prev === participantId ? null : participantId));
  }, []);

  const handleAction = async (
    participantId: string,
    action: string,
    actionFn: () => Promise<void>
  ) => {
    setLoadingParticipantId(participantId);
    setLoadingAction(action);
    setOpenMenuId(null);
    try {
      await actionFn();
    } finally {
      setLoadingParticipantId(null);
      setLoadingAction(null);
    }
  };

  const handleRequestModeratorClick = async () => {
    if (!onRequestModerator || hasRequestedMod || isRequestingMod) return;
    setIsRequestingMod(true);
    try {
      await onRequestModerator();
      setHasRequestedMod(true);
    } catch {
      setHasRequestedMod(false);
    } finally {
      setIsRequestingMod(false);
    }
  };

  const getRoleBadgeClass = (role: Role) => {
    switch (role) {
      case 'HOST':
        return 'role-badge-host';
      case 'MODERATOR':
        return 'role-badge-mod';
      default:
        return 'role-badge-participant';
    }
  };

  return (
    <div className="roster-card">
      <div className="roster-header">
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%' }}>
          <h3 className="roster-title">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
              <circle cx="9" cy="7" r="4" />
              <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
              <path d="M16 3.13a4 4 0 0 1 0 7.75" />
            </svg>
            Room Members ({participants.length})
          </h3>

          {/* Self-action for regular participants: Request Moderator role */}
          {isParticipant && onRequestModerator && (
            <button
              onClick={handleRequestModeratorClick}
              disabled={hasRequestedMod || isRequestingMod}
              className="btn-ghost-sm"
              style={{ fontSize: '0.72rem', padding: '0.2rem 0.5rem', display: 'flex', alignItems: 'center', gap: '0.35rem' }}
              title="Request Moderator role from Host"
              id="request-moderator-btn"
            >
              {isRequestingMod ? (
                <>
                  <span className="mini-spinner" style={{ width: 10, height: 10 }} />
                  Requesting...
                </>
              ) : hasRequestedMod ? (
                '✓ Requested'
              ) : (
                'Request Mod'
              )}
            </button>
          )}
        </div>
      </div>

      <div className="roster-list" id="participant-roster-list" role="list">
        {participants.map((p) => {
          const isSelf = p.id === currentUserId;
          const initials = p.displayName.slice(0, 2).toUpperCase();
          const isMenuOpen = openMenuId === p.id;
          const isLoadingThis = loadingParticipantId === p.id;

          // Three-dot menu eligibility: Host can manage other participants/moderators, NEVER themselves
          const canManage = isHost && !isSelf;

          return (
            <div
              key={p.id}
              className={`roster-item ${isMenuOpen ? 'menu-active' : ''}`}
              id={`participant-row-${p.id}`}
              role="listitem"
            >
              <div className="roster-avatar" aria-hidden="true">
                {initials}
                <span
                  className={`avatar-status-dot ${p.isConnected ? 'online' : 'offline'}`}
                  title={p.isConnected ? 'Connected' : 'Disconnected'}
                />
              </div>

              <div className="roster-info">
                <div className="roster-name-row">
                  <span className="roster-name" title={p.displayName}>{p.displayName}</span>
                  {isSelf && <span className="you-pill">You</span>}
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.35rem' }}>
                  <span className={`role-badge ${getRoleBadgeClass(p.role)}`}>
                    {p.role}
                  </span>
                  {isLoadingThis && (
                    <span className="roster-inline-loading" title={`${loadingAction}...`}>
                      <span className="mini-spinner" style={{ width: 10, height: 10 }} />
                    </span>
                  )}
                </div>
              </div>

              {/* Three-Dot Overflow Menu for eligible participants */}
              {canManage && (
                <div className="roster-menu-container">
                  <button
                    ref={(el) => {
                      if (el) triggerRefs.current.set(p.id, el);
                      else triggerRefs.current.delete(p.id);
                    }}
                    onClick={(e) => toggleMenu(p.id, e)}
                    disabled={isLoadingThis}
                    className={`roster-menu-btn ${isMenuOpen ? 'active' : ''}`}
                    aria-label={`Manage ${p.displayName}`}
                    aria-haspopup="true"
                    aria-expanded={isMenuOpen}
                    id={`participant-menu-btn-${p.id}`}
                    title={`Actions for ${p.displayName}`}
                  >
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                      <circle cx="12" cy="5" r="2.2" />
                      <circle cx="12" cy="12" r="2.2" />
                      <circle cx="12" cy="19" r="2.2" />
                    </svg>
                  </button>

                  <AnimatePresence>
                    {isMenuOpen && (
                      <motion.div
                        ref={menuRef}
                        className="roster-dropdown-menu"
                        initial={{ opacity: 0, scale: 0.94, y: -4 }}
                        animate={{ opacity: 1, scale: 1, y: 0 }}
                        exit={{ opacity: 0, scale: 0.94, y: -4 }}
                        transition={{ duration: 0.15, ease: 'easeOut' }}
                        role="menu"
                        aria-labelledby={`participant-menu-btn-${p.id}`}
                      >
                        {/* 1. Make Moderator (only if currently PARTICIPANT) */}
                        {p.role === 'PARTICIPANT' && (
                          <button
                            onClick={() =>
                              handleAction(p.id, 'Promoting', () => onUpdateRole(p.id, 'MODERATOR'))
                            }
                            className="roster-dropdown-item"
                            role="menuitem"
                            id={`menu-make-mod-${p.id}`}
                          >
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                              <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
                            </svg>
                            <span>Make Moderator</span>
                          </button>
                        )}

                        {/* 2. Dismiss Moderator (only if currently MODERATOR) */}
                        {p.role === 'MODERATOR' && (
                          <button
                            onClick={() =>
                              handleAction(p.id, 'Demoting', () => onUpdateRole(p.id, 'PARTICIPANT'))
                            }
                            className="roster-dropdown-item"
                            role="menuitem"
                            id={`menu-dismiss-mod-${p.id}`}
                          >
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                              <path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
                              <circle cx="8.5" cy="7" r="4" />
                              <line x1="23" y1="11" x2="17" y2="11" />
                            </svg>
                            <span>Dismiss Moderator</span>
                          </button>
                        )}

                        {/* 3. Transfer Host (applicable to both Participants and Moderators) */}
                        {onTransferHost && (
                          <button
                            onClick={() =>
                              handleAction(p.id, 'Transferring Host', () => onTransferHost(p.id))
                            }
                            className="roster-dropdown-item"
                            role="menuitem"
                            id={`menu-transfer-host-${p.id}`}
                          >
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                              <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
                            </svg>
                            <span>Transfer Host</span>
                          </button>
                        )}

                        <div className="roster-dropdown-divider" />

                        {/* 4. Remove Participant */}
                        <button
                          onClick={() => {
                            if (window.confirm(`Remove ${p.displayName} from this watch party room?`)) {
                              handleAction(p.id, 'Removing', () => onRemoveParticipant(p.id));
                            }
                          }}
                          className="roster-dropdown-item danger"
                          role="menuitem"
                          id={`menu-remove-${p.id}`}
                        >
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <polyline points="3 6 5 6 21 6" />
                            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                          </svg>
                          <span>Remove Participant</span>
                        </button>
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
};

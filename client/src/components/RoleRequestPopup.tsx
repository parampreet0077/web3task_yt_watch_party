import React, { useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import type { RoleRequest } from '../types/room';

interface RoleRequestPopupProps {
  requests: RoleRequest[];
  onApprove: (requestId: string, participantId: string) => Promise<boolean>;
  onReject: (requestId: string, participantId: string) => Promise<boolean>;
  onDismiss: (requestId: string) => void;
}

export const RoleRequestPopup: React.FC<RoleRequestPopupProps> = ({
  requests,
  onApprove,
  onReject,
  onDismiss,
}) => {
  const [currentIndex, setCurrentIndex] = useState(0);
  const [processingAction, setProcessingAction] = useState<'APPROVE' | 'REJECT' | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [confirmationResult, setConfirmationResult] = useState<{
    requestId: string;
    status: 'APPROVED' | 'REJECTED';
    message: string;
  } | null>(null);

  if (!requests || requests.length === 0) return null;

  // Bound index safely
  const activeIndex = Math.min(currentIndex, requests.length - 1);
  const currentRequest = requests[activeIndex];
  if (!currentRequest) return null;

  const initials = currentRequest.participant.displayName.slice(0, 2).toUpperCase();

  const handleApprove = async () => {
    if (processingAction) return; // Prevent duplicate clicks
    setProcessingAction('APPROVE');
    setActionError(null);
    try {
      const success = await onApprove(currentRequest.requestId, currentRequest.participant.id);
      if (success) {
        setConfirmationResult({
          requestId: currentRequest.requestId,
          status: 'APPROVED',
          message: `${currentRequest.participant.displayName} is now a Moderator!`,
        });
        setTimeout(() => {
          onDismiss(currentRequest.requestId);
          setConfirmationResult(null);
        }, 1400);
      } else {
        setActionError('Failed to approve request. Please retry.');
      }
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to approve request.');
    } finally {
      setProcessingAction(null);
    }
  };

  const handleReject = async () => {
    if (processingAction) return; // Prevent duplicate clicks
    setProcessingAction('REJECT');
    setActionError(null);
    try {
      const success = await onReject(currentRequest.requestId, currentRequest.participant.id);
      if (success) {
        setConfirmationResult({
          requestId: currentRequest.requestId,
          status: 'REJECTED',
          message: `Role request from ${currentRequest.participant.displayName} was rejected.`,
        });
        setTimeout(() => {
          onDismiss(currentRequest.requestId);
          setConfirmationResult(null);
        }, 1400);
      } else {
        setActionError('Failed to reject request. Please retry.');
      }
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to reject request.');
    } finally {
      setProcessingAction(null);
    }
  };

  return (
    <AnimatePresence mode="wait">
      <motion.div
        key={currentRequest.requestId}
        className="role-request-popup-container"
        initial={{ opacity: 0, y: -24, scale: 0.96 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: -20, scale: 0.96 }}
        transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
        role="region"
        aria-live="polite"
        aria-label="Role change request notification"
      >
        <div className="role-request-popup-card">
          {/* Top header row with badge and dismiss */}
          <div className="role-request-top-bar">
            <div className="role-request-badge">
              <span className="role-request-pulse-dot" />
              Role Change Request
            </div>
            {requests.length > 1 && (
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.25rem' }}>
                <button
                  type="button"
                  onClick={() => setCurrentIndex((prev) => (prev > 0 ? prev - 1 : requests.length - 1))}
                  className="role-request-close-btn"
                  aria-label="Previous request"
                  title="Previous request"
                >
                  ‹
                </button>
                <span className="role-request-counter">
                  {activeIndex + 1} of {requests.length}
                </span>
                <button
                  type="button"
                  onClick={() => setCurrentIndex((prev) => (prev < requests.length - 1 ? prev + 1 : 0))}
                  className="role-request-close-btn"
                  aria-label="Next request"
                  title="Next request"
                >
                  ›
                </button>
              </div>
            )}
            <button
              onClick={() => onDismiss(currentRequest.requestId)}
              className="role-request-close-btn"
              aria-label="Dismiss notification"
              title="Dismiss notification without resolving"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </div>

          {/* If request has been confirmed on server, display confirmed status */}
          {confirmationResult && confirmationResult.requestId === currentRequest.requestId ? (
            <div
              className={`role-request-result-banner ${confirmationResult.status === 'APPROVED' ? 'success' : 'info'}`}
              role="status"
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '0.6rem',
                padding: '0.85rem 1rem',
                backgroundColor: confirmationResult.status === 'APPROVED' ? 'rgba(34, 197, 94, 0.15)' : 'rgba(148, 163, 184, 0.15)',
                border: `1px solid ${confirmationResult.status === 'APPROVED' ? 'rgba(34, 197, 94, 0.4)' : 'rgba(148, 163, 184, 0.4)'}`,
                borderRadius: '8px',
                color: confirmationResult.status === 'APPROVED' ? '#4ade80' : '#cbd5e1',
                fontSize: '0.875rem',
                fontWeight: 500,
              }}
            >
              {confirmationResult.status === 'APPROVED' ? (
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                  <polyline points="20 6 9 17 4 12" />
                </svg>
              ) : (
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <circle cx="12" cy="12" r="10" />
                  <line x1="12" y1="8" x2="12" y2="12" />
                  <line x1="12" y1="16" x2="12.01" y2="16" />
                </svg>
              )}
              <span>{confirmationResult.message}</span>
            </div>
          ) : (
            <>
              {/* Participant information row */}
              <div className="role-request-body">
                <div className="role-request-avatar" aria-hidden="true">
                  {initials}
                </div>
                <div className="role-request-details">
                  <span className="role-request-name" title={currentRequest.participant.displayName}>
                    {currentRequest.participant.displayName}
                  </span>
                  <span className="role-request-subtitle">
                    Requests to become <strong>{currentRequest.requestedRole}</strong>
                  </span>
                </div>
              </div>

              {/* Action error banner with quick retry */}
              {actionError && (
                <div
                  className="alert alert-error"
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    margin: '0.5rem 0',
                    fontSize: '0.8rem',
                  }}
                >
                  <span>{actionError}</span>
                  <button
                    type="button"
                    onClick={() => setActionError(null)}
                    className="btn-secondary btn-sm"
                    style={{ padding: '0.2rem 0.5rem', fontSize: '0.75rem' }}
                  >
                    Dismiss
                  </button>
                </div>
              )}

              {/* Explicit action buttons */}
              <div className="role-request-actions">
                <button
                  onClick={handleApprove}
                  disabled={Boolean(processingAction)}
                  className="btn-primary role-request-btn"
                  id="approve-role-request-btn"
                  title="Promote participant to Moderator"
                >
                  {processingAction === 'APPROVE' ? (
                    <>
                      <span className="mini-spinner" style={{ width: 14, height: 14 }} />
                      Approving...
                    </>
                  ) : (
                    <>
                      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                        <polyline points="20 6 9 17 4 12" />
                      </svg>
                      Approve / Make Moderator
                    </>
                  )}
                </button>

                <button
                  onClick={handleReject}
                  disabled={Boolean(processingAction)}
                  className="btn-secondary role-request-btn btn-danger-hover"
                  id="reject-role-request-btn"
                  title="Reject role change request"
                >
                  {processingAction === 'REJECT' ? (
                    <>
                      <span className="mini-spinner" style={{ width: 14, height: 14 }} />
                      Rejecting...
                    </>
                  ) : (
                    <>
                      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <line x1="18" y1="6" x2="6" y2="18" />
                        <line x1="6" y1="6" x2="18" y2="18" />
                      </svg>
                      Reject Request
                    </>
                  )}
                </button>
              </div>
            </>
          )}
        </div>
      </motion.div>
    </AnimatePresence>
  );
};

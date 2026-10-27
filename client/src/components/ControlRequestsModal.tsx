import React, { useState } from 'react';
import type { Role, SafeControlRequest, RequestType } from '../types/room';
import { extractYouTubeVideoId, formatTime } from '../utils/youtube';

interface ControlRequestsModalProps {
  isOpen: boolean;
  onClose: () => void;
  userRole: Role;
  requests: SafeControlRequest[];
  hasVideoSelected: boolean;
  currentTimestamp: number;
  onSubmitRequest: (type: RequestType, targetTimestamp?: number, targetVideoId?: string) => Promise<{ success: boolean; error?: string }>;
  onApproveRequest: (requestId: string) => Promise<boolean>;
  onRejectRequest: (requestId: string) => Promise<boolean>;
}

export const ControlRequestsModal: React.FC<ControlRequestsModalProps> = ({
  isOpen,
  onClose,
  userRole,
  requests,
  hasVideoSelected,
  currentTimestamp,
  onSubmitRequest,
  onApproveRequest,
  onRejectRequest,
}) => {
  const [requestType, setRequestType] = useState<RequestType>('PLAY');
  const [seekSeconds, setSeekSeconds] = useState<string>(Math.floor(currentTimestamp).toString());
  const [videoUrl, setVideoUrl] = useState('');
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitSuccess, setSubmitSuccess] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);

  if (!isOpen) return null;

  const isPrivileged = userRole === 'HOST' || userRole === 'MODERATOR';
  const pendingRequests = requests.filter((r) => r.status === 'PENDING');

  const handleSubmitRequest = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitError(null);
    setSubmitSuccess(false);

    let targetTs: number | undefined;
    let targetVid: string | undefined;

    if (requestType === 'SEEK') {
      const parsed = parseFloat(seekSeconds);
      if (!Number.isFinite(parsed) || parsed < 0) {
        setSubmitError('Please enter a valid, non-negative timestamp in seconds.');
        return;
      }
      targetTs = parsed;
    } else if (requestType === 'CHANGE_VIDEO') {
      const parsed = extractYouTubeVideoId(videoUrl);
      if (!parsed) {
        setSubmitError('Please enter a valid YouTube video URL or 11-character video ID.');
        return;
      }
      targetVid = parsed;
    }

    setIsSubmitting(true);
    const res = await onSubmitRequest(requestType, targetTs, targetVid);
    setIsSubmitting(false);

    if (res.success) {
      setSubmitSuccess(true);
      setTimeout(() => setSubmitSuccess(false), 3000);
    } else {
      setSubmitError(res.error || 'Failed to submit request');
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal-card modal-wide"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="requests-modal-title"
      >
        <div className="modal-header">
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <h2 id="requests-modal-title" className="modal-title">
              {isPrivileged ? 'Playback Control Requests' : 'Request Playback Control'}
            </h2>
            {isPrivileged && (
              <span className="badge-count">{pendingRequests.length} Pending</span>
            )}
          </div>
          <button onClick={onClose} className="btn-icon" aria-label="Close modal">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        <div className="modal-body">
          {/* Host / Moderator View: List of incoming requests */}
          {isPrivileged ? (
            <div>
              <p className="modal-description">
                Participants in this room cannot alter playback directly. Approve or reject incoming action requests below.
              </p>

              {pendingRequests.length === 0 ? (
                <div className="empty-state-box">
                  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <circle cx="12" cy="12" r="10" />
                    <path d="m9 12 2 2 4-4" />
                  </svg>
                  <p>No pending control requests at this time.</p>
                </div>
              ) : (
                <div className="request-items-list">
                  {pendingRequests.map((req) => (
                    <div key={req.id} className="request-item-card" id={`request-card-${req.id}`}>
                      <div className="request-item-info">
                        <div className="request-item-author">
                          <strong>{req.participant.displayName}</strong>
                          <span className="role-tag">{req.participant.role}</span>
                        </div>
                        <div className="request-item-action">
                          <span className={`action-badge action-${req.type.toLowerCase()}`}>
                            {req.type}
                          </span>
                          {req.type === 'SEEK' && req.targetTimestamp !== null && (
                            <span className="action-details">Target: {formatTime(req.targetTimestamp)} ({req.targetTimestamp}s)</span>
                          )}
                          {req.type === 'CHANGE_VIDEO' && req.targetVideoId && (
                            <span className="action-details">Video: {req.targetVideoId}</span>
                          )}
                        </div>
                      </div>

                      <div className="request-item-actions">
                        <button
                          onClick={() => onRejectRequest(req.id)}
                          className="btn-danger btn-sm"
                          id={`reject-req-${req.id}`}
                        >
                          Reject
                        </button>
                        <button
                          onClick={() => onApproveRequest(req.id)}
                          className="btn-success btn-sm"
                          id={`approve-req-${req.id}`}
                        >
                          Approve
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ) : (
            /* Participant View: Submit request form */
            <form onSubmit={handleSubmitRequest} id="participant-request-form">
              <p className="modal-description">
                As a Participant, your playback action will be submitted to the Host or Moderator for approval.
              </p>

              <div className="form-group">
                <label className="form-label">Action to Request</label>
                <div className="action-type-selector">
                  {(['PLAY', 'PAUSE', 'SEEK', 'CHANGE_VIDEO'] as RequestType[]).map((type) => {
                    const isDisabled = !hasVideoSelected && type !== 'CHANGE_VIDEO';
                    return (
                      <button
                        key={type}
                        type="button"
                        disabled={isDisabled}
                        className={`action-selector-btn ${requestType === type ? 'selected' : ''}`}
                        onClick={() => setRequestType(type)}
                      >
                        {type.replace('_', ' ')}
                      </button>
                    );
                  })}
                </div>
              </div>

              {requestType === 'SEEK' && (
                <div className="form-group">
                  <label htmlFor="seek-seconds-input" className="form-label">
                    Target Timestamp (in seconds)
                  </label>
                  <input
                    id="seek-seconds-input"
                    type="number"
                    step="0.5"
                    min="0"
                    className="form-input"
                    value={seekSeconds}
                    onChange={(e) => setSeekSeconds(e.target.value)}
                    required
                  />
                  <span className="input-hint">
                    Formatted: {formatTime(parseFloat(seekSeconds) || 0)}
                  </span>
                </div>
              )}

              {requestType === 'CHANGE_VIDEO' && (
                <div className="form-group">
                  <label htmlFor="change-video-request-input" className="form-label">
                    YouTube URL or 11-char Video ID
                  </label>
                  <input
                    id="change-video-request-input"
                    type="text"
                    className="form-input"
                    placeholder="https://www.youtube.com/watch?v=..."
                    value={videoUrl}
                    onChange={(e) => setVideoUrl(e.target.value)}
                    required
                  />
                </div>
              )}

              {submitError && <div className="alert alert-error">{submitError}</div>}
              {submitSuccess && (
                <div className="alert alert-success">
                  Request submitted! Waiting for Host or Moderator approval.
                </div>
              )}

              <div className="modal-footer">
                <button type="button" onClick={onClose} className="btn-secondary">
                  Close
                </button>
                <button
                  type="submit"
                  className="btn-primary"
                  disabled={isSubmitting}
                  id="submit-control-request-btn"
                >
                  {isSubmitting ? 'Submitting...' : 'Submit Request'}
                </button>
              </div>
            </form>
          )}
        </div>
      </div>
    </div>
  );
};

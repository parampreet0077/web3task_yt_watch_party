import React, { useState } from 'react';
import { extractYouTubeVideoId } from '../utils/youtube';

interface ChangeVideoModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSubmitVideo: (videoId: string) => Promise<boolean>;
}

export const ChangeVideoModal: React.FC<ChangeVideoModalProps> = ({
  isOpen,
  onClose,
  onSubmitVideo,
}) => {
  const [videoInput, setVideoInput] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  if (!isOpen) return null;

  const detectedId = extractYouTubeVideoId(videoInput);

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError(null);

    const formData = new FormData(e.currentTarget);
    const formVal = (formData.get('youtubeVideoInput') as string) || videoInput;
    const videoId = extractYouTubeVideoId(formVal.trim());
    if (!videoId) {
      setError('Invalid YouTube video link or 11-character video ID.');
      return;
    }

    setIsSubmitting(true);
    const success = await onSubmitVideo(videoId);
    setIsSubmitting(false);

    if (success) {
      setVideoInput('');
      onClose();
    } else {
      setError('Failed to change video. Please try again.');
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal-card"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="modal-title"
      >
        <div className="modal-header">
          <h2 id="modal-title" className="modal-title">
            Load YouTube Video
          </h2>
          <button onClick={onClose} className="btn-icon" aria-label="Close modal">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        <form onSubmit={handleSubmit} className="modal-body" id="change-video-form">
          <p className="modal-description">
            Paste a full YouTube URL, shortened youtu.be link, or direct 11-character video ID.
          </p>

          <div className="form-group">
            <label htmlFor="youtube-video-input" className="form-label">
              YouTube URL or Video ID
            </label>
            <input
              id="youtube-video-input"
              name="youtubeVideoInput"
              type="text"
              className="form-input"
              placeholder="e.g. https://www.youtube.com/watch?v=dQw4w9WgXcQ"
              value={videoInput}
              onChange={(e) => {
                setVideoInput(e.target.value);
                setError(null);
              }}
              autoFocus
              required
            />
          </div>

          {/* Video preview hint */}
          {detectedId && (
            <div className="video-detected-badge">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                <path d="M8 5v14l11-7z" />
              </svg>
              <span>Detected YouTube ID: <strong>{detectedId}</strong></span>
            </div>
          )}

          {error && (
            <div className="alert alert-error" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span>{error}</span>
              <button
                type="button"
                onClick={() => {
                  setError(null);
                  if (detectedId) {
                    setIsSubmitting(true);
                    onSubmitVideo(detectedId).then((success) => {
                      setIsSubmitting(false);
                      if (success) {
                        setVideoInput('');
                        onClose();
                      } else {
                        setError('Failed to change video. Please try again.');
                      }
                    });
                  }
                }}
                className="btn-secondary btn-sm"
                disabled={isSubmitting}
                style={{ marginLeft: '0.75rem', padding: '0.25rem 0.6rem', fontSize: '0.75rem' }}
                id="retry-change-video-btn"
              >
                Retry
              </button>
            </div>
          )}

          <div className="modal-footer">
            <button type="button" onClick={onClose} className="btn-secondary">
              Cancel
            </button>
            <button
              type="submit"
              className="btn-primary"
              disabled={isSubmitting}
              id="confirm-change-video-btn"
            >
              {isSubmitting ? 'Loading...' : 'Load Video for Room'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};

import React, { useState, useEffect, useCallback } from 'react';
import QRCode from 'qrcode';
import { getModInviteToken } from '../services/api';
import {
  resolveQrTargetOrigin,
  isProductionEnvironment,
  LOCAL_DEFAULT_LAN_IP,
  type QrTargetPreference,
} from '../utils/env';

interface RemoteQRModalProps {
  isOpen: boolean;
  onClose: () => void;
  roomCode: string;
  sessionToken?: string | null;
  isHost?: boolean;
  participantCount?: number;
  isConnected?: boolean;
}

export const RemoteQRModal: React.FC<RemoteQRModalProps> = ({
  isOpen,
  onClose,
  roomCode,
  sessionToken,
  isHost = false,
  participantCount = 1,
  isConnected = true,
}) => {
  const [copiedLink, setCopiedLink] = useState(false);
  const [copiedCode, setCopiedCode] = useState(false);
  const [qrSvg, setQrSvg] = useState<string>('');
  const [genError, setGenError] = useState(false);
  const [inviteToken, setInviteToken] = useState<string | null>(null);
  const [isRefreshingInvite, setIsRefreshingInvite] = useState(false);
  const [targetPref, setTargetPref] = useState<QrTargetPreference>('auto');

  // Fetch or regenerate moderator invite token if user is Host
  const loadInviteToken = useCallback(
    async (revoke = false) => {
      if (!isHost || !sessionToken || !roomCode) return;
      setIsRefreshingInvite(true);
      try {
        const res = await getModInviteToken(roomCode, sessionToken, revoke);
        setInviteToken(res.inviteToken);
      } catch (err) {
        console.warn('[RemoteQRModal]: Could not fetch moderator invite token, falling back to standard join link', err);
      } finally {
        setIsRefreshingInvite(false);
      }
    },
    [isHost, sessionToken, roomCode]
  );

  useEffect(() => {
    if (isOpen && isHost && sessionToken) {
      loadInviteToken(false);
    }
  }, [isOpen, isHost, sessionToken, loadInviteToken]);

  const resolvedOrigin = resolveQrTargetOrigin(targetPref);
  const inviteParam = inviteToken ? `&invite=${encodeURIComponent(inviteToken)}` : '';
  const remoteUrl = `${resolvedOrigin}/?room=${encodeURIComponent(roomCode)}&mode=remote${inviteParam}`;

  useEffect(() => {
    if (!isOpen || !roomCode) return;
    let isMounted = true;

    QRCode.toString(remoteUrl, {
      type: 'svg',
      margin: 1.5,
      errorCorrectionLevel: 'M',
      color: {
        dark: '#0f172a',
        light: '#ffffff',
      },
    })
      .then((svg) => {
        if (isMounted) {
          setQrSvg(svg);
          setGenError(false);
        }
      })
      .catch((err) => {
        console.error('Failed to generate standard QR code', err);
        if (isMounted) setGenError(true);
      });

    return () => {
      isMounted = false;
    };
  }, [isOpen, roomCode, remoteUrl]);

  if (!isOpen) return null;

  const handleCopyLink = () => {
    navigator.clipboard.writeText(remoteUrl);
    setCopiedLink(true);
    setTimeout(() => setCopiedLink(false), 2200);
  };

  const handleCopyCode = () => {
    navigator.clipboard.writeText(roomCode);
    setCopiedCode(true);
    setTimeout(() => setCopiedCode(false), 2200);
  };

  const isProd = isProductionEnvironment();

  return (
    <div className="modal-backdrop" onClick={onClose} role="dialog" aria-modal="true">
      <div className="modal-card remote-qr-card" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <div className="remote-qr-title-row">
            <div className="remote-qr-header-icon" aria-hidden="true">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <rect x="5" y="2" width="14" height="20" rx="2" ry="2" />
                <line x1="12" y1="18" x2="12.01" y2="18" />
              </svg>
            </div>
            <div>
              <h2 className="modal-title">Connect Your Phone</h2>
              <p className="modal-subtitle">Control music & queue from any passenger seat</p>
            </div>
          </div>
          <button className="modal-close-btn" onClick={onClose} aria-label="Close modal">
            &times;
          </button>
        </div>

        <div className="remote-qr-body">
          {/* Top Status & Role Badges */}
          <div className="remote-qr-status-row">
            <span className={`remote-live-status-pill ${isConnected ? 'online' : 'offline'}`}>
              <span className="remote-live-dot" />
              {isConnected ? `${participantCount} Device${participantCount === 1 ? '' : 's'} Connected` : 'Reconnecting...'}
            </span>

            {inviteToken && (
              <span className="remote-mod-sparkle-pill">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                  <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" />
                </svg>
                Moderator Access Enabled
              </span>
            )}
          </div>

          {/* Network Target Selector (Dev vs Prod) */}
          <div className="remote-network-selector-box">
            <span className="remote-network-label">Network Route:</span>
            <div className="remote-network-pills">
              <button
                type="button"
                className={`remote-network-pill ${targetPref === 'auto' ? 'active' : ''}`}
                onClick={() => setTargetPref('auto')}
                title="Automatically select Wi-Fi LAN for local dev or Vercel for production"
              >
                Auto ({isProd ? 'Cloud' : 'Wi-Fi LAN'})
              </button>
              <button
                type="button"
                className={`remote-network-pill ${targetPref === 'lan' ? 'active' : ''}`}
                onClick={() => setTargetPref('lan')}
                title={`Route to local Wi-Fi IP http://${LOCAL_DEFAULT_LAN_IP}:5173`}
              >
                Wi-Fi LAN
              </button>
              <button
                type="button"
                className={`remote-network-pill ${targetPref === 'production' ? 'active' : ''}`}
                onClick={() => setTargetPref('production')}
                title="Route to live production https://web3task-watch-party.vercel.app"
              >
                Production (Cloud)
              </button>
            </div>
          </div>

          {/* Authentic Standard Scannable QR Code with HUD Corner Brackets */}
          <div className="remote-qr-display-wrapper">
            <div className="qr-scan-frame">
              <span className="qr-corner-bracket top-left" />
              <span className="qr-corner-bracket top-right" />
              <span className="qr-corner-bracket bottom-left" />
              <span className="qr-corner-bracket bottom-right" />

              {qrSvg ? (
                <div
                  className="remote-qr-svg-container"
                  dangerouslySetInnerHTML={{ __html: qrSvg }}
                />
              ) : genError ? (
                <div className="remote-qr-fallback">
                  <p>Could not render QR code.</p>
                  <p>Use direct copy link below.</p>
                </div>
              ) : (
                <div className="remote-qr-loading">Generating standard QR...</div>
              )}
            </div>
          </div>

          {/* Room Code Quick-Copy Pill */}
          <div className="remote-code-copy-row">
            <div className="remote-code-display">
              <span className="remote-code-label">ROOM CODE</span>
              <span className="remote-code-value">{roomCode}</span>
            </div>
            <button
              type="button"
              className={`remote-copy-code-btn ${copiedCode ? 'copied' : ''}`}
              onClick={handleCopyCode}
              title="Copy 6-letter room code"
            >
              {copiedCode ? (
                <>
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                  <span>Copied!</span>
                </>
              ) : (
                <>
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                  </svg>
                  <span>Copy Code</span>
                </>
              )}
            </button>
          </div>

          <div className="remote-qr-instructions">
            <div className="remote-step">
              <span className="remote-step-num">1</span>
              <span>Open the Camera app on your smartphone</span>
            </div>
            <div className="remote-step">
              <span className="remote-step-num">2</span>
              <span>Point at the screen to open Phone Remote mode</span>
            </div>
            <div className="remote-step">
              <span className="remote-step-num">3</span>
              <span>Search YouTube, manage queue, and control playback directly</span>
            </div>
          </div>

          {/* Copy Direct URL */}
          <div className="remote-url-copy-box">
            <input
              type="text"
              readOnly
              value={remoteUrl}
              className="remote-url-input"
              onClick={(e) => (e.target as HTMLInputElement).select()}
            />
            <button
              type="button"
              className={`btn-primary btn-sm remote-copy-btn ${copiedLink ? 'copied' : ''}`}
              onClick={handleCopyLink}
            >
              {copiedLink ? 'Copied Link!' : 'Copy Link'}
            </button>
          </div>

          {/* Host Revoke/Regenerate Action */}
          {isHost && (
            <div className="remote-qr-footer-actions">
              <button
                type="button"
                className="remote-regenerate-btn"
                disabled={isRefreshingInvite}
                onClick={() => loadInviteToken(true)}
                title="Revoke existing invite tokens and generate a fresh one"
              >
                {isRefreshingInvite ? 'Rotating invite...' : '↺ Revoke & Regenerate QR'}
              </button>
            </div>
          )}
        </div>

        <div className="modal-footer">
          <span className="remote-qr-hint">No app install required. Works instantly in mobile Safari & Chrome.</span>
          <button type="button" className="btn-secondary btn-sm" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
};

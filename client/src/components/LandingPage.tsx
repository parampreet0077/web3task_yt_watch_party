import React, { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { ThemeToggle } from './ThemeToggle';

interface LandingPageProps {
  onCreateRoom: (displayName: string, title?: string, initialMode?: 'standard' | 'car') => Promise<void>;
  onJoinRoom: (roomCode: string, displayName: string, inviteToken?: string) => Promise<void>;
  isLoading: boolean;
  errorMessage: string | null;
  onClearError: () => void;
}

export const LandingPage: React.FC<LandingPageProps> = ({
  onCreateRoom,
  onJoinRoom,
  isLoading,
  errorMessage,
  onClearError,
}) => {
  // Modal state for Create / Join
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [modalTab, setModalTab] = useState<'create' | 'join'>('create');
  const [displayName, setDisplayName] = useState('');
  const [roomTitle, setRoomTitle] = useState('');
  const [roomCode, setRoomCode] = useState('');
  const [inviteToken, setInviteToken] = useState<string>('');
  const [launchInCarMode, setLaunchInCarMode] = useState(false);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  // Preserve query parameter behaviour (?room=CODE or ?code=CODE, and ?invite=TOKEN)
  useEffect(() => {
    try {
      const params = new URLSearchParams(window.location.search);
      const urlCode = params.get('room') || params.get('code');
      const urlInvite = params.get('invite') || params.get('inviteToken');
      if (urlInvite && urlInvite.trim().length > 0) {
        setInviteToken(urlInvite.trim());
      }
      if (urlCode && urlCode.trim().length > 0) {
        setRoomCode(urlCode.trim().toUpperCase());
        setModalTab('join');
        setIsModalOpen(true);
      }
    } catch {
      // Ignore URL parsing errors
    }
  }, []);

  const openCreateModal = () => {
    setModalTab('create');
    setLaunchInCarMode(false);
    setValidationError(null);
    onClearError();
    setIsModalOpen(true);
    setMobileMenuOpen(false);
  };

  const openCreateModalWithMode = (mode: 'standard' | 'car') => {
    setModalTab('create');
    setLaunchInCarMode(mode === 'car');
    setValidationError(null);
    onClearError();
    setIsModalOpen(true);
    setMobileMenuOpen(false);
  };

  const openJoinModal = (initialCode?: string) => {
    setModalTab('join');
    if (initialCode) setRoomCode(initialCode);
    setValidationError(null);
    onClearError();
    setIsModalOpen(true);
    setMobileMenuOpen(false);
  };

  const closeModal = () => {
    if (isLoading) return;
    setIsModalOpen(false);
    setValidationError(null);
    onClearError();
  };

  const handleCreateSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isLoading) return;
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
    await onCreateRoom(trimmedName, roomTitle.trim() || undefined, launchInCarMode ? 'car' : 'standard');
  };

  const handleJoinSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isLoading) return;
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

    await onJoinRoom(trimmedCode, trimmedName, inviteToken || undefined);
  };

  const scrollToSection = (id: string) => {
    setMobileMenuOpen(false);
    const el = document.getElementById(id);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth' });
    }
  };

  return (
    <div className="landing-wrapper">
      {/* 1. Responsive Navbar */}
      <header className="landing-navbar">
        <div className="landing-navbar-container">
          {/* Brand Logo */}
          <a href="#" className="landing-brand" onClick={(e) => { e.preventDefault(); window.scrollTo({ top: 0, behavior: 'smooth' }); }}>
            <div className="landing-brand-icon">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
                <path d="M8 5v14l11-7z" />
              </svg>
            </div>
            <span className="landing-brand-title">WatchParty</span>
          </a>

          {/* Desktop Navigation Links */}
          <nav className="landing-nav-links">
            <button
              onClick={() => scrollToSection('how-it-works')}
              className="landing-nav-link"
              id="nav-how-it-works-btn"
            >
              How It Works
            </button>
            <button
              onClick={() => scrollToSection('car-mode')}
              className="landing-nav-link"
              id="nav-car-mode-btn"
            >
              Car Mode
            </button>
            <button
              onClick={() => scrollToSection('features')}
              className="landing-nav-link"
              id="nav-features-btn"
            >
              Features
            </button>
          </nav>

          {/* Desktop Action CTAs */}
          <div className="landing-nav-actions">
            <ThemeToggle className="landing-theme-toggle" />
            <button
              onClick={() => openJoinModal()}
              className="btn-secondary"
              id="nav-join-room-btn"
            >
              Join Room
            </button>
            <button
              onClick={openCreateModal}
              className="btn-primary"
              id="nav-start-party-btn"
            >
              Start a Watch Party
            </button>
          </div>

          {/* Mobile Hamburger Toggle */}
          <button
            className="landing-mobile-toggle"
            onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
            aria-label="Toggle navigation menu"
            aria-expanded={mobileMenuOpen}
            id="mobile-menu-toggle-btn"
          >
            {mobileMenuOpen ? (
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            ) : (
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <line x1="3" y1="12" x2="21" y2="12" />
                <line x1="3" y1="6" x2="21" y2="6" />
                <line x1="3" y1="18" x2="21" y2="18" />
              </svg>
            )}
          </button>
        </div>

        {/* Mobile Dropdown Menu */}
        {mobileMenuOpen && (
          <div className="landing-mobile-menu">
            <button onClick={() => scrollToSection('how-it-works')} className="landing-mobile-link">
              How It Works
            </button>
            <button onClick={() => scrollToSection('car-mode')} className="landing-mobile-link">
              Car Mode
            </button>
            <button onClick={() => scrollToSection('features')} className="landing-mobile-link">
              Features
            </button>
            <div className="landing-mobile-actions">
              <button onClick={() => openJoinModal()} className="btn-secondary btn-block">
                Join Room
              </button>
              <button onClick={openCreateModal} className="btn-primary btn-block">
                Start a Watch Party
              </button>
            </div>
          </div>
        )}
      </header>

      {/* 2. Hero Section */}
      <section className="landing-hero-section">
        <div className="landing-hero-glow" aria-hidden="true" />
        <div className="landing-hero-container">
          {/* Left Column: Hero Copy & Actions */}
          <div className="landing-hero-content">
            {/* Eyebrow badge */}
            <motion.div
              className="landing-hero-eyebrow"
              initial={{ opacity: 0, y: -12 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.4 }}
            >
              <span className="eyebrow-dot" />
              <span>YOUR PEOPLE. YOUR MOVIE NIGHT.</span>
            </motion.div>

            {/* Headline */}
            <motion.h1
              className="landing-hero-headline"
              initial={{ opacity: 0, y: 16 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.5, delay: 0.1 }}
            >
              <span className="hero-headline-line1">Movies hit different</span>
              <span className="hero-headline-line2">when you're together.</span>
            </motion.h1>

            {/* Description */}
            <motion.p
              className="landing-hero-description"
              initial={{ opacity: 0, y: 16 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.5, delay: 0.2 }}
            >
              Your friends. Your favourite videos. One perfectly synced watch party. No matter how far apart you are.
            </motion.p>

            {/* Hero CTAs */}
            <motion.div
              className="landing-hero-ctas"
              initial={{ opacity: 0, y: 16 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.5, delay: 0.3 }}
            >
              <button
                onClick={openCreateModal}
                className="btn-primary btn-lg hero-cta-btn"
                id="hero-start-party-btn"
              >
                <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M8 5v14l11-7z" />
                </svg>
                Start Your Watch Party
              </button>
              <button
                onClick={() => openJoinModal()}
                className="btn-secondary btn-lg hero-cta-btn"
                id="hero-join-room-btn"
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4" />
                  <polyline points="10 17 15 12 10 7" />
                  <line x1="15" y1="12" x2="3" y2="12" />
                </svg>
                Join a Room
              </button>
            </motion.div>
          </div>

          {/* Right Column: Hero Visual Asset (herosection2.png) */}
          <motion.div
            className="landing-hero-media"
            initial={{ opacity: 0, scale: 0.96, y: 24 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            transition={{ duration: 0.6, delay: 0.35 }}
          >
            <div className="hero-image-frame">
              <div className="hero-image-ambient-glow" />
              <img
                src="/herosection2.png"
                alt="Friends watching movies together in real-time sync"
                className="hero-image-asset"
                id="hero-section-image"
                loading="eager"
              />
              <div className="hero-image-overlay-badge">
                <span className="live-dot" />
                <span>Live Socket.IO Sync Active</span>
              </div>
            </div>
          </motion.div>
        </div>
      </section>

      {/* 3. How It Works Section */}
      <section className="landing-section" id="how-it-works">
        <div className="landing-section-container">
          <div className="section-header">
            <div className="section-badge">SIMPLE & FAST</div>
            <h2 className="section-title">How It Works</h2>
            <p className="section-subtitle">
              Three effortless steps to start streaming YouTube with your crew in lockstep.
            </p>
          </div>

          <div className="steps-grid">
            {/* Step 1 */}
            <motion.div
              className="step-card"
              whileHover={{ y: -4 }}
              transition={{ duration: 0.2 }}
            >
              <div className="step-number">01</div>
              <div className="step-icon-wrapper">
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M12 20h9" />
                  <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" />
                </svg>
              </div>
              <h3 className="step-heading">Create a room</h3>
              <p className="step-description">
                Pick your display name and launch a private, synchronized watch party room in seconds. No sign-up required.
              </p>
            </motion.div>

            {/* Step 2 */}
            <motion.div
              className="step-card"
              whileHover={{ y: -4 }}
              transition={{ duration: 0.2 }}
            >
              <div className="step-number">02</div>
              <div className="step-icon-wrapper">
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <circle cx="18" cy="5" r="3" />
                  <circle cx="6" cy="12" r="3" />
                  <circle cx="18" cy="19" r="3" />
                  <line x1="8.59" y1="13.51" x2="15.42" y2="17.49" />
                  <line x1="15.41" y1="6.51" x2="8.59" y2="10.49" />
                </svg>
              </div>
              <h3 className="step-heading">Invite your friends</h3>
              <p className="step-description">
                Share your unique 6-character room code or instant URL. Friends join seamlessly from any browser tab or device.
              </p>
            </motion.div>

            {/* Step 3 */}
            <motion.div
              className="step-card"
              whileHover={{ y: -4 }}
              transition={{ duration: 0.2 }}
            >
              <div className="step-number">03</div>
              <div className="step-icon-wrapper">
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <polygon points="5 3 19 12 5 21 5 3" />
                </svg>
              </div>
              <h3 className="step-heading">Press play together</h3>
              <p className="step-description">
                Load any YouTube URL. Play, pause, scrub, and change speed together with authoritative sub-second synchronization.
              </p>
            </motion.div>
          </div>
        </div>
      </section>

      {/* 4. Features Section (Only Real, Implemented Features) */}
      <section className="landing-section dark-alt" id="features">
        <div className="landing-section-container">
          <div className="section-header">
            <div className="section-badge">REAL-TIME ARCHITECTURE</div>
            <h2 className="section-title">Engineered for Seamless Group Watching</h2>
            <p className="section-subtitle">
              Every feature is built and verified on our low-latency Socket.IO and PostgreSQL platform.
            </p>
          </div>

          <div className="features-grid">
            {/* Official Feature: Car Mode & Phone Remote */}
            <div className="feature-card feature-card-highlighted">
              <div className="feature-card-top">
                <div className="feature-icon feature-icon-car">
                  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M19 17h2c.6 0 1-.4 1-1v-3c0-.9-.7-1.7-1.5-1.9C18.7 10.6 16 10 16 10s-1.3-1.4-2.2-2.3c-.5-.4-1.1-.7-1.8-.7H5c-.6 0-1.1.4-1.4.9l-1.4 2.9C2.1 11.1 2 11.5 2 12v4c0 .6.4 1 1 1h2" />
                    <circle cx="7" cy="17" r="2" />
                    <path d="M9 17h6" />
                    <circle cx="17" cy="17" r="2" />
                  </svg>
                </div>
                <span className="feature-card-badge">CAR INFOTAINMENT &amp; REMOTE</span>
              </div>
              <h3 className="feature-heading">Car Mode — Smart In-Car Watch Party</h3>
              <p className="feature-description">
                Turn your car screen into a shared entertainment dashboard. Connect your phone through QR and control YouTube playback remotely while passengers manage songs, recommendations and the shared queue.
              </p>
              <ul className="feature-highlights-list">
                <li>
                  <span className="feature-check-icon">✓</span>
                  <span><strong>Car Screen Host:</strong> Main screen acts as room Host; only the Car Screen plays actual video/audio.</span>
                </li>
                <li>
                  <span className="feature-check-icon">✓</span>
                  <span><strong>Phone Remote Control:</strong> Connect phones using QR; control playback without repeatedly touching the car display.</span>
                </li>
                <li>
                  <span className="feature-check-icon">✓</span>
                  <span><strong>YouTube Music Search:</strong> Search videos, songs, and browse live recommendations.</span>
                </li>
                <li>
                  <span className="feature-check-icon">✓</span>
                  <span><strong>Shared Queue &amp; Auto-Next:</strong> Add, remove, and reorder upcoming videos with automatic playback progression.</span>
                </li>
                <li>
                  <span className="feature-check-icon">✓</span>
                  <span><strong>Multi-Phone Support:</strong> Multiple passenger phones can control the queue as Moderators simultaneously.</span>
                </li>
                <li>
                  <span className="feature-check-icon">✓</span>
                  <span><strong>Passenger Permissions:</strong> Host retains ultimate authority and manages Moderator and Participant roles.</span>
                </li>
                <li>
                  <span className="feature-check-icon">✓</span>
                  <span><strong>Day/Night Theme:</strong> Optimized high-contrast daytime and glare-free dark night interfaces.</span>
                </li>
              </ul>
              <div className="feature-card-action">
                <button
                  type="button"
                  className="btn-primary btn-sm feature-cta-btn"
                  onClick={() => openCreateModalWithMode('car')}
                  id="feature-try-car-mode-btn"
                >
                  <span>Try Car Mode</span>
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <line x1="5" y1="12" x2="19" y2="12" />
                    <polyline points="12 5 19 12 12 19" />
                  </svg>
                </button>
              </div>
            </div>

            {/* Feature 1 */}
            <div className="feature-card">
              <div className="feature-icon">
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <polyline points="23 4 23 10 17 10" />
                  <polyline points="1 20 1 14 7 14" />
                  <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
                </svg>
              </div>
              <h3 className="feature-heading">Authoritative Playback Sync</h3>
              <p className="feature-description">
                Host actions (play, pause, seek) broadcast deterministically across all clients with automated timestamp drift correction.
              </p>
            </div>

            {/* Feature 2 */}
            <div className="feature-card">
              <div className="feature-icon">
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <rect x="2" y="4" width="20" height="16" rx="2.18" ry="2.18" />
                  <line x1="7" y1="2" x2="7" y2="4" />
                  <line x1="17" y1="2" x2="17" y2="4" />
                </svg>
              </div>
              <h3 className="feature-heading">YouTube IFrame Integration</h3>
              <p className="feature-description">
                Direct integration with the official YouTube IFrame Player API. Supports standard links, youtu.be, and raw 11-char IDs.
              </p>
            </div>

            {/* Feature 3 */}
            <div className="feature-card">
              <div className="feature-icon">
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
                  <circle cx="9" cy="7" r="4" />
                  <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
                  <path d="M16 3.13a4 4 0 0 1 0 7.75" />
                </svg>
              </div>
              <h3 className="feature-heading">Host & Moderator Hierarchy</h3>
              <p className="feature-description">
                Granular permissions with distinct Host, Moderator, and Participant roles. Support for host transfer and moderation.
              </p>
            </div>

            {/* Feature 4 */}
            <div className="feature-card">
              <div className="feature-icon">
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <circle cx="12" cy="12" r="10" />
                  <line x1="12" y1="8" x2="12" y2="12" />
                  <line x1="12" y1="16" x2="12.01" y2="16" />
                </svg>
              </div>
              <h3 className="feature-heading">Role & Playback Requests</h3>
              <p className="feature-description">
                Participants can submit seek/pause or moderator promotion requests with real-time popup approval dialogs for the Host.
              </p>
            </div>

            {/* Feature 5 */}
            <div className="feature-card">
              <div className="feature-icon">
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3" />
                </svg>
              </div>
              <h3 className="feature-heading">Cinematic Player & Fullscreen</h3>
              <p className="feature-description">
                Immersive player with video loading spinners, instant retry, interactive scrubber, speed selectors (0.5x–2x), and fullscreen.
              </p>
            </div>

            {/* Feature 6 */}
            <div className="feature-card">
              <div className="feature-icon">
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <rect x="2" y="2" width="20" height="8" rx="2" ry="2" />
                  <rect x="2" y="14" width="20" height="8" rx="2" ry="2" />
                  <line x1="6" y1="6" x2="6.01" y2="6" />
                  <line x1="6" y1="18" x2="6.01" y2="18" />
                </svg>
              </div>
              <h3 className="feature-heading">Session Resilience & Reconnect</h3>
              <p className="feature-description">
                Persistent cryptographic session tokens in browser storage. Refreshing the page immediately restores room and playback state.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* 4.5. Dedicated Car Mode & Phone Remote Showcase Section */}
      <section className="landing-section car-mode-showcase-section" id="car-mode">
        <div className="landing-section-container">
          <div className="section-header">
            <div className="section-badge car-mode-section-badge">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M19 17h2c.6 0 1-.4 1-1v-3c0-.9-.7-1.7-1.5-1.9C18.7 10.6 16 10 16 10s-1.3-1.4-2.2-2.3c-.5-.4-1.1-.7-1.8-.7H5c-.6 0-1.1.4-1.4.9l-1.4 2.9C2.1 11.1 2 11.5 2 12v4c0 .6.4 1 1 1h2" />
                <circle cx="7" cy="17" r="2" />
                <path d="M9 17h6" />
                <circle cx="17" cy="17" r="2" />
              </svg>
              <span>IN-CAR ENTERTAINMENT ARCHITECTURE</span>
            </div>
            <h2 className="section-title">How Car Mode &amp; Phone Remote Work</h2>
            <p className="section-subtitle">
              A driver-safe architecture designed for road trips. The vehicle screen streams audio and video while passenger phones manage the shared music queue.
            </p>
          </div>

          {/* 5-Step Workflow Cards */}
          <div className="car-workflow-grid">
            <div className="car-workflow-card">
              <div className="workflow-step-num">01</div>
              <h3 className="workflow-step-title">Host Creates Car Room</h3>
              <p className="workflow-step-desc">
                The driver or passenger creates a Watch Party on the vehicle browser and enters Car Mode.
              </p>
            </div>

            <div className="car-workflow-card">
              <div className="workflow-step-num">02</div>
              <h3 className="workflow-step-title">Open Remote QR Code</h3>
              <p className="workflow-step-desc">
                Host taps &ldquo;Phone Remote&rdquo; on the car dashboard to present a high-contrast scannable QR invitation.
              </p>
            </div>

            <div className="car-workflow-card">
              <div className="workflow-step-num">03</div>
              <h3 className="workflow-step-title">Passengers Scan &amp; Join</h3>
              <p className="workflow-step-desc">
                Passengers point their smartphone camera at the car screen and join immediately with Moderator rights.
              </p>
            </div>

            <div className="car-workflow-card">
              <div className="workflow-step-num">04</div>
              <h3 className="workflow-step-title">Remote Queue &amp; Control</h3>
              <p className="workflow-step-desc">
                Authorized phones search YouTube, browse suggestions, and manage the queue without touching the dash.
              </p>
            </div>

            <div className="car-workflow-card">
              <div className="workflow-step-num">05</div>
              <h3 className="workflow-step-title">Single Authoritative Player</h3>
              <p className="workflow-step-desc">
                The car screen is the only device that plays video/audio, guaranteeing zero echo and zero double playback.
              </p>
            </div>
          </div>

          {/* Architecture & Driver Safety Notice Card */}
          <div className="car-safety-notice-card">
            <div className="car-safety-header">
              <div className="safety-icon-wrapper">
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
                </svg>
              </div>
              <div>
                <h4 className="safety-card-title">Driver Safety &amp; Multi-Device Principles</h4>
                <p className="safety-card-subtitle">Designed specifically for passenger collaboration and reduced driver distraction.</p>
              </div>
            </div>

            <div className="car-safety-points-grid">
              <div className="safety-point">
                <strong>Controller, Not a Player:</strong>
                <span>The Phone Remote interface contains zero video or audio players. It acts purely as a low-latency controller.</span>
              </div>
              <div className="safety-point">
                <strong>Car Screen Remains Host:</strong>
                <span>The vehicle screen retains ultimate room authority. The Host can promote, demote, or remove participants at any time.</span>
              </div>
              <div className="safety-point">
                <strong>Multi-Phone Collaboration:</strong>
                <span>Multiple passengers can scan the QR code and collaborate on the queue simultaneously.</span>
              </div>
              <div className="safety-point">
                <strong>Driver Distraction Warning:</strong>
                <span>Driver interaction should be minimized while driving. Video search and song queueing should be handled by passengers or while safely parked.</span>
              </div>
              <div className="safety-point safety-point-full">
                <strong>Browser-Based Web App:</strong>
                <span>Operates directly inside any standard modern vehicle or mobile browser with internet connectivity. Does not require or claim native Android Auto or Apple CarPlay application installation.</span>
              </div>
            </div>

            <div className="car-showcase-actions">
              <button
                type="button"
                className="btn-primary btn-lg car-showcase-cta"
                onClick={() => openCreateModalWithMode('car')}
                id="car-showcase-start-btn"
              >
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M19 17h2c.6 0 1-.4 1-1v-3c0-.9-.7-1.7-1.5-1.9C18.7 10.6 16 10 16 10s-1.3-1.4-2.2-2.3c-.5-.4-1.1-.7-1.8-.7H5c-.6 0-1.1.4-1.4.9l-1.4 2.9C2.1 11.1 2 11.5 2 12v4c0 .6.4 1 1 1h2" />
                  <circle cx="7" cy="17" r="2" />
                  <path d="M9 17h6" />
                  <circle cx="17" cy="17" r="2" />
                </svg>
                <span>Launch Watch Party in Car Mode</span>
              </button>
            </div>
          </div>
        </div>
      </section>

      {/* 5. Final CTA Section */}
      <section className="landing-final-cta-section">
        <div className="landing-section-container">
          <div className="final-cta-card">
            <div className="final-cta-glow" aria-hidden="true" />
            <h2 className="final-cta-title">Ready for Movie Night?</h2>
            <p className="final-cta-description">
              Gather your friends and start watching YouTube together in perfect harmony.
            </p>
            <div className="final-cta-buttons">
              <button
                onClick={openCreateModal}
                className="btn-primary btn-lg"
                id="final-cta-create-btn"
              >
                Start a Watch Party Now
              </button>
              <button
                onClick={() => openJoinModal()}
                className="btn-secondary btn-lg"
                id="final-cta-join-btn"
              >
                Join an Existing Room
              </button>
            </div>
          </div>
        </div>
      </section>

      {/* 6. Footer */}
      <footer className="landing-footer">
        <div className="landing-footer-container">
          <div className="footer-left">
            <div className="landing-brand">
              <div className="landing-brand-icon">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M8 5v14l11-7z" />
                </svg>
              </div>
              <span className="landing-brand-title">WatchParty</span>
            </div>
            <p className="footer-tagline">
              Real-time synchronized YouTube streaming for groups everywhere.
            </p>
          </div>

          <div className="footer-right">
            <div className="footer-status-pill">
              <span className="footer-status-dot" />
              <span>Real-Time Engine Active</span>
            </div>
            <p className="footer-copy">
              © 2026 WEB3TASK Watch Party. Powered by React, TypeScript, and Socket.IO.
            </p>
          </div>
        </div>
      </footer>

      {/* Interactive Room Creation & Joining Modal */}
      <AnimatePresence>
        {isModalOpen && (
          <div className="modal-backdrop" onClick={closeModal}>
            <motion.div
              className="modal-card landing-action-modal"
              onClick={(e) => e.stopPropagation()}
              initial={{ opacity: 0, scale: 0.95, y: 16 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 16 }}
              transition={{ duration: 0.2 }}
              role="dialog"
              aria-modal="true"
              aria-labelledby="modal-action-title"
            >
              {/* Modal Header */}
              <div className="modal-header">
                <div>
                  <h2 id="modal-action-title" className="modal-title">
                    {modalTab === 'create' ? 'Start a Watch Party' : 'Join a Watch Party'}
                  </h2>
                  <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem', marginTop: '0.2rem' }}>
                    {modalTab === 'create'
                      ? 'Create a private synchronized room in seconds.'
                      : 'Enter your 6-character room code to join.'}
                  </p>
                </div>
                <button onClick={closeModal} className="btn-icon" aria-label="Close modal" disabled={isLoading}>
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <line x1="18" y1="6" x2="6" y2="18" />
                    <line x1="6" y1="6" x2="18" y2="18" />
                  </svg>
                </button>
              </div>

              {/* Tab Selector */}
              <div className="tab-pill-container" style={{ margin: '1rem 0' }}>
                <button
                  type="button"
                  className={`tab-pill ${modalTab === 'create' ? 'active' : ''}`}
                  onClick={() => {
                    if (isLoading) return;
                    setModalTab('create');
                    setValidationError(null);
                    onClearError();
                  }}
                  id="modal-tab-create"
                  disabled={isLoading}
                >
                  Create New Room
                </button>
                <button
                  type="button"
                  className={`tab-pill ${modalTab === 'join' ? 'active' : ''}`}
                  onClick={() => {
                    if (isLoading) return;
                    setModalTab('join');
                    setValidationError(null);
                    onClearError();
                  }}
                  id="modal-tab-join"
                  disabled={isLoading}
                >
                  Join with Code
                </button>
              </div>

              {/* Error Alert */}
              {(validationError || errorMessage) && (
                <div className="alert alert-error" role="alert" style={{ marginBottom: '1rem' }}>
                  <span>{validationError || errorMessage}</span>
                  <button
                    type="button"
                    onClick={() => {
                      setValidationError(null);
                      onClearError();
                    }}
                    style={{ background: 'none', border: 'none', color: 'inherit', cursor: 'pointer', opacity: 0.7 }}
                  >
                    ✕
                  </button>
                </div>
              )}

              {/* Create Form */}
              {modalTab === 'create' && (
                <form onSubmit={handleCreateSubmit} className="modal-body" id="landing-create-room-form">
                  <div className="form-group">
                    <label htmlFor="create-display-name-input" className="form-label">
                      Your Display Name
                    </label>
                    <input
                      id="create-display-name-input"
                      type="text"
                      className="form-input"
                      placeholder="e.g. Alex"
                      value={displayName}
                      onChange={(e) => {
                        setDisplayName(e.target.value);
                        setValidationError(null);
                        onClearError();
                      }}
                      maxLength={40}
                      autoFocus
                      required
                      disabled={isLoading}
                    />
                  </div>

                  <div className="form-group">
                    <label htmlFor="create-room-title-input" className="form-label">
                      Room Title <span style={{ color: 'var(--text-muted)' }}>(Optional)</span>
                    </label>
                    <input
                      id="create-room-title-input"
                      type="text"
                      className="form-input"
                      placeholder="e.g. Friday Anime Night"
                      value={roomTitle}
                      onChange={(e) => setRoomTitle(e.target.value)}
                      maxLength={100}
                      disabled={isLoading}
                    />
                  </div>

                  {/* Optional Car Mode Toggle Checkbox */}
                  <div className="form-group car-mode-choice-group">
                    <label className="car-mode-checkbox-label">
                      <input
                        type="checkbox"
                        checked={launchInCarMode}
                        onChange={(e) => setLaunchInCarMode(e.target.checked)}
                        className="car-mode-checkbox"
                        id="launch-in-car-mode-checkbox"
                        disabled={isLoading}
                      />
                      <span className="car-mode-checkbox-content">
                        <span className="car-mode-checkbox-title">
                          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <path d="M19 17h2c.6 0 1-.4 1-1v-3c0-.9-.7-1.7-1.5-1.9C18.7 10.6 16 10 16 10s-1.3-1.4-2.2-2.3c-.5-.4-1.1-.7-1.8-.7H5c-.6 0-1.1.4-1.4.9l-1.4 2.9C2.1 11.1 2 11.5 2 12v4c0 .6.4 1 1 1h2" />
                            <circle cx="7" cy="17" r="2" />
                            <path d="M9 17h6" />
                            <circle cx="17" cy="17" r="2" />
                          </svg>
                          Launch directly in Car Mode
                        </span>
                        <span className="car-mode-checkbox-sub">
                          Infotainment-optimized view. Video plays only on this screen; passengers control via Phone Remote QR.
                        </span>
                      </span>
                    </label>
                  </div>

                  <div className="modal-footer" style={{ marginTop: '1.25rem' }}>
                    <button type="button" onClick={closeModal} className="btn-secondary" disabled={isLoading}>
                      Cancel
                    </button>
                    <button
                      type="submit"
                      className="btn-primary"
                      disabled={isLoading}
                      id="confirm-create-room-btn"
                    >
                      {isLoading ? (
                        <>
                          <span className="mini-spinner" style={{ width: 14, height: 14 }} />
                          Creating Room...
                        </>
                      ) : (
                        'Create Watch Party'
                      )}
                    </button>
                  </div>

                  {/* Room Creation UX Progress Message */}
                  {isLoading && (
                    <div className="create-room-progress-notice" role="status" aria-live="polite">
                      <div className="progress-notice-header">
                        <span
                          className="mini-spinner"
                          style={{
                            width: 14,
                            height: 14,
                            borderColor: 'rgba(167, 139, 250, 0.3)',
                            borderTopColor: '#A78BFA',
                          }}
                          aria-hidden="true"
                        />
                        <span className="progress-notice-title">Creating your watch room...</span>
                      </div>
                      <p className="progress-notice-desc">
                        This may take a few seconds. Please keep this page open while we set things up.
                      </p>
                    </div>
                  )}
                </form>
              )}

              {/* Join Form */}
              {modalTab === 'join' && (
                <form onSubmit={handleJoinSubmit} className="modal-body" id="landing-join-room-form">
                  {inviteToken && (
                    <div className="landing-mod-invite-banner">
                      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                        <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" />
                      </svg>
                      <span>Joining as Room Moderator via Car Screen QR</span>
                    </div>
                  )}

                  <div className="form-group">
                    <label htmlFor="join-room-code-input" className="form-label">
                      6-Character Room Code
                    </label>
                    <input
                      id="join-room-code-input"
                      type="text"
                      className="form-input code-input"
                      placeholder="ABCXYZ"
                      value={roomCode}
                      onChange={(e) => {
                        setRoomCode(e.target.value.toUpperCase().slice(0, 6));
                        setValidationError(null);
                        onClearError();
                      }}
                      maxLength={6}
                      autoFocus
                      required
                      disabled={isLoading}
                    />
                  </div>

                  <div className="form-group">
                    <label htmlFor="join-display-name-input" className="form-label">
                      Your Display Name
                    </label>
                    <input
                      id="join-display-name-input"
                      type="text"
                      className="form-input"
                      placeholder="e.g. Taylor"
                      value={displayName}
                      onChange={(e) => {
                        setDisplayName(e.target.value);
                        setValidationError(null);
                        onClearError();
                      }}
                      maxLength={40}
                      required
                      disabled={isLoading}
                    />
                  </div>

                  <div className="modal-footer" style={{ marginTop: '1.25rem' }}>
                    <button type="button" onClick={closeModal} className="btn-secondary" disabled={isLoading}>
                      Cancel
                    </button>
                    <button
                      type="submit"
                      className="btn-primary"
                      disabled={isLoading}
                      id="confirm-join-room-btn"
                    >
                      {isLoading ? (
                        <>
                          <span className="mini-spinner" style={{ width: 14, height: 14 }} />
                          Joining Room...
                        </>
                      ) : (
                        'Join Watch Party'
                      )}
                    </button>
                  </div>
                </form>
              )}
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </div>
  );
};

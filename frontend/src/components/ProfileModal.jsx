import React, { useState, useEffect, useRef, memo } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { direct as directApi } from '../api';
import { getProfile, getCachedProfile } from '../utils/profileCache';
import { useAuth } from '../context/AuthContext';
import { useLanguage } from '../context/LanguageContext';
import { useOnlineUsers } from '../context/SocketContext';
import { getStaticUrl } from '../utils/staticUrl';
import { getStoredCustomStatus, getStoredOnlineStatus } from '../utils/presenceStorage';
import { harmonizeGradientColors, lightenHex, isLightGradient, isHighContrastGradient, areMatchingBannerColors } from '../utils/gradientColors';
import Avatar from './Avatar';
import './ProfileModal.css';

const NOTE_KEY = 'slide_profile_notes';
function loadNote(uid) {
  try { return JSON.parse(localStorage.getItem(NOTE_KEY) || '{}')[uid] ?? ''; } catch { return ''; }
}
function saveNote(uid, note) {
  try {
    const d = JSON.parse(localStorage.getItem(NOTE_KEY) || '{}');
    if (note) d[uid] = note; else delete d[uid];
    localStorage.setItem(NOTE_KEY, JSON.stringify(d));
  } catch {}
}

const STATUS_COLORS = {
  online:    '#23a55a',
  idle:      '#f0b232',
  dnd:       '#f23f43',
  invisible: '#80848e',
  offline:   '#80848e',
};

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function stripInvisible(value) {
  return String(value || '').replace(/[\u200B-\u200D\uFEFF]/g, '');
}

function normalizeHandle(value) {
  return stripInvisible(value)
    .replace(/(\s+|#)0*\s*$/, '')
    .replace(/(?<![0-9])0\s*$/, '')
    .replace(/([^\d])0+\s*$/, '$1')
    .trim();
}

function normalizeDisplayName(value, username) {
  const base = stripInvisible(value)
    .trim()
    .replace(/\s*#\s*0+\s*$/i, '')
    .replace(/([^\d])0+\s*$/, '$1');
  const normalizedHandle = normalizeHandle(username);
  if (normalizedHandle && new RegExp(`^${escapeRegExp(normalizedHandle)}\\s*0+$`, 'i').test(base)) {
    return normalizedHandle;
  }
  // Legacy bug cleanup: display_name is often saved with trailing "0"
  // in profile payloads (e.g. "Bunk00", "ddd0", "mrrox3330").
  return base.replace(/0+\s*$/, '').trim();
}

function stripTrailingLegacyZero(value) {
  const normalized = stripInvisible(value).normalize('NFKC').trim();
  return normalized.replace(/([^\d])0+$/, '$1').trim();
}

function isGifUrl(url) {
  if (!url || typeof url !== 'string') return false;
  return /\.gif(?:$|[?#])/i.test(url) || /format=gif/i.test(url);
}

const ProfileModal = memo(function ProfileModal({ userId, onClose }) {
  const navigate = useNavigate();
  const { user: currentUser } = useAuth();
  const { t } = useLanguage();
  const { isUserOnline } = useOnlineUsers();

  const [profile, setProfile]         = useState(null);
  const [loading, setLoading]         = useState(true);
  const [error, setError]             = useState(null);
  const [note, setNote]               = useState('');
  const [noteEditing, setNoteEditing] = useState(false);
  const [menuOpen, setMenuOpen]       = useState(false);
  const [copied, setCopied]           = useState(false);

  const modalRef = useRef(null);
  const menuRef  = useRef(null);

  const isOwnProfile = currentUser?.id === parseInt(userId, 10);

  // Load note
  useEffect(() => {
    if (userId && !isOwnProfile) setNote(loadNote(userId));
  }, [userId, isOwnProfile]);

  // Fetch profile (uses cache — instant when prefetched)
  useEffect(() => {
    if (!userId) return;
    const cached = getCachedProfile(userId);
    if (cached) {
      setProfile(cached);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    getProfile(userId)
      .then(d  => setProfile(d))
      .catch(() => setError(t('errors.loadProfile')))
      .finally(() => setLoading(false));
  }, [userId]);

  // Lock scroll + Escape to close
  useEffect(() => {
    document.body.style.overflow = 'hidden';
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => {
      document.body.style.overflow = '';
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  // Close on backdrop click
  useEffect(() => {
    const onDown = (e) => {
      if (modalRef.current && !modalRef.current.contains(e.target)) onClose();
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [onClose]);

  // Close 3-dot menu on outside click
  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e) => {
      if (menuRef.current && !menuRef.current.contains(e.target)) setMenuOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [menuOpen]);

  const handleMessage = async () => {
    try {
      const conv = await directApi.createConversation(parseInt(userId, 10));
      onClose();
      navigate(`/channels/@me/${conv.conversation_id ?? conv.id}`);
    } catch {}
  };

  const handleNoteChange = (val) => {
    setNote(val);
    saveNote(userId, val);
  };

  const handleCopyId = async () => {
    await navigator.clipboard.writeText(String(userId)).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
    setMenuOpen(false);
  };

  if (!userId) return null;

  // ── Derived display data ──────────────────────────────────
  const bannerColor  = profile?.banner_color  || '#4f6ef7';
  const bannerColor2 = profile?.banner_color_2;
  const bannerUrl    = profile?.banner_url ? getStaticUrl(profile.banner_url) : null;
  const hasGifBanner = isGifUrl(profile?.banner_url || bannerUrl);
  /* Harmonize colors when both selected so any pair produces a pleasing gradient */
  const hasDualBanner = !!bannerColor2;
  const [c1, c2]      = hasDualBanner ? harmonizeGradientColors(bannerColor, bannerColor2 || '#000') : [bannerColor, '#000'];
  /* Banner: 1st color (harmonized when dual) OR image — never gradient */
  const verticalGrad = (a, b) => `linear-gradient(180deg, ${a} 0%, ${a} 12%, ${b} 88%, ${b} 100%)`;
  const bannerStyle  = bannerUrl
    ? (hasGifBanner
        ? { backgroundColor: c1 }
        : { backgroundImage: `url(${bannerUrl})`, backgroundSize: 'cover', backgroundPosition: `center ${profile?.banner_position || 'center'}` })
    : hasDualBanner
      ? { backgroundImage: verticalGrad(c1, c2) }
      : { backgroundColor: c1 };
  /* Whole modal gradient when both colors enabled */
  const innerGrad    = hasDualBanner
    ? verticalGrad(lightenHex(c1), lightenHex(c2))
    : null;
  const modalStyle       = hasDualBanner ? { background: innerGrad } : undefined;
  const isHighContrast   = hasDualBanner && isHighContrastGradient(bannerColor, bannerColor2 || '#000');
  const isLight          = hasDualBanner && !isHighContrast && isLightGradient(bannerColor, bannerColor2 || '#000');
  const noOverlayBand    = hasDualBanner && areMatchingBannerColors(bannerColor, bannerColor2);

  const hasRealHandle = !!(profile?.username || profile?.email?.split('@')[0]);
  const username = hasRealHandle
    ? normalizeHandle(profile?.username || profile?.email?.split('@')[0])
    : null;
  const rawDisplayName = normalizeDisplayName(profile?.display_name, profile?.username || profile?.email?.split('@')[0]);
  const looksLikeLegacyTaggedName = !!(rawDisplayName && username)
    && new RegExp(`^${escapeRegExp(username)}(?:\\s*#?\\s*0+)?$`, 'i').test(rawDisplayName);
  const displayName = looksLikeLegacyTaggedName
    ? username
    : (rawDisplayName || username || '');
  const finalUsername = username ? stripTrailingLegacyZero(username) : null;
  const finalDisplayName = stripTrailingLegacyZero(displayName || '') || finalUsername || t('chat.user');
  const aboutMe       = profile?.about_me || profile?.bio;
  const statusMessage = profile?.status_message
    || (isOwnProfile ? getStoredCustomStatus(currentUser?.id) : null)
    || null;
  const joinDate = profile?.created_at
    ? new Date(profile.created_at).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' })
    : null;

  const presenceStatus = (() => {
    if (isOwnProfile) return getStoredOnlineStatus(currentUser?.id);
    if (userId && isUserOnline(parseInt(userId, 10))) return 'online';
    return 'offline';
  })();
  const statusColor = STATUS_COLORS[presenceStatus] || STATUS_COLORS.offline;

  return createPortal(
    <div className="profile-modal-overlay">
      <div className="profile-modal-backdrop" aria-hidden="true" />
      <div className={`profile-modal${hasDualBanner ? ' profile-modal--dual-banner' : ''}${isHighContrast && !noOverlayBand ? ' profile-modal--high-contrast-gradient' : ''}${isLight ? ' profile-modal--light-gradient' : ''}${noOverlayBand ? ' profile-modal--no-overlay-band' : ''}`} ref={modalRef} role="dialog" aria-label={finalDisplayName ? `${finalDisplayName} profile` : 'Profile'} style={modalStyle}>

        {/* ── Loading ───────────────────────────────── */}
        {loading && (
          <>
            <button onClick={onClose} className="profile-modal-close" title={t('common.close')}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
            <div className="profile-modal-skeleton">
              <div className="profile-modal-skeleton-banner" />
              <div className="profile-modal-skeleton-avatar" />
              <div className="profile-modal-skeleton-name" />
              <div className="profile-modal-skeleton-tag" />
            </div>
          </>
        )}

        {/* ── Error ────────────────────────────────── */}
        {error && !loading && (
          <>
            <button onClick={onClose} className="profile-modal-close" title={t('common.close')}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
            <div className="profile-modal-error">
              <p>{error}</p>
              <button onClick={onClose} className="profile-modal-btn secondary">{t('common.close')}</button>
            </div>
          </>
        )}

        {/* ── Profile loaded ───────────────────────── */}
        {!loading && !error && profile && (
          <>
            {/* Banner with action buttons */}
            <div className={`profile-modal-banner${bannerUrl ? ' profile-modal-banner--image' : ''}`} style={bannerStyle}>
              {bannerUrl && hasGifBanner && (
                <img
                  className="profile-modal-banner-img"
                  src={bannerUrl}
                  alt=""
                  draggable={false}
                />
              )}
              <div className="profile-modal-banner-actions">
                <button onClick={onClose} className="profile-modal-banner-icon" title={t('common.close')}>
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                    <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                  </svg>
                </button>

                {!isOwnProfile && (
                  <button onClick={handleMessage} className="profile-modal-banner-icon" title={t('friends.message')}>
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                    </svg>
                  </button>
                )}
                {isOwnProfile && (
                  <button onClick={() => { onClose(); navigate('/settings'); }} className="profile-modal-banner-icon" title={t('profile.editProfile')}>
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                      <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
                    </svg>
                  </button>
                )}

                {/* 3-dot menu */}
                <div className="profile-modal-menu-wrap" ref={menuRef}>
                  <button
                    onClick={() => setMenuOpen(v => !v)}
                    className="profile-modal-banner-icon"
                    title={t('profile.moreActions')}
                    aria-expanded={menuOpen}
                  >
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                      <circle cx="12" cy="5"  r="1.5" />
                      <circle cx="12" cy="12" r="1.5" />
                      <circle cx="12" cy="19" r="1.5" />
                    </svg>
                  </button>
                  {menuOpen && (
                    <div className="profile-modal-dropdown" role="menu">
                      <button className="profile-modal-dropdown-item" role="menuitem" onClick={handleCopyId}>
                        {copied ? t('common.copied') : t('common.copyUserId')}
                      </button>
                    </div>
                  )}
                </div>
              </div>
            </div>

            {/* Avatar overlapping banner */}
            <div className="profile-modal-avatar-wrap">
              <div className={`profile-modal-avatar-wrapper${hasDualBanner ? ' profile-modal-avatar-wrapper--gradient' : ''}`}>
                <Avatar user={profile} size="xlarge" />
                <div
                  className="profile-modal-status-badge"
                  style={{ background: statusColor }}
                  title={presenceStatus}
                />
              </div>
            </div>

            {/* Scrollable body */}
            <div className="profile-modal-body">

              {/* Identity */}
              <div className="profile-modal-identity">
                <h1 className="profile-modal-displayname">
                  {finalDisplayName}
                  {Boolean(profile.is_webhook) && <span className="profile-modal-bot-badge">BOT</span>}
                  {Boolean(profile.has_nitro) && <span className="profile-modal-nitro-badge">Nitro</span>}
                </h1>
                <div className="profile-modal-tag-row">
                  {finalUsername ? (
                    <span className="profile-modal-username">@{finalUsername}</span>
                  ) : (
                    <span className="profile-modal-username profile-modal-username--muted">{t('profile.noHandleSet')}</span>
                  )}
                </div>
              </div>

              {/* Custom status */}
              {statusMessage && (
                <div className="profile-modal-status-msg">{statusMessage}</div>
              )}

              {/* Divider */}
              <hr className="profile-modal-divider" />

              {/* About Me */}
              <div className="profile-modal-section">
                <h3 className="profile-modal-section-title">{t('profile.aboutMe')}</h3>
                <p className={`profile-modal-section-content${!(aboutMe) ? ' profile-modal-about-empty' : ''}`}>
                  {aboutMe || t('profile.aboutMeEmpty')}
                </p>
              </div>

              {/* Member Since */}
              {joinDate && (
                <div className="profile-modal-section">
                  <h3 className="profile-modal-section-title">{t('profile.memberSince')}</h3>
                  <p className="profile-modal-section-content">{joinDate}</p>
                </div>
              )}

              {/* Teams in common */}
              {(profile.common_teams > 0) && (
                <div className="profile-modal-mutuals">
                  <span className="profile-modal-mutuals-text">
                    {profile.common_teams} {t('profile.teamsInCommon')}
                  </span>
                </div>
              )}

              {/* Note */}
              {!isOwnProfile && (
                <div className="profile-modal-section">
                  <h3 className="profile-modal-section-title">{t('profile.note')}</h3>
                  {noteEditing ? (
                    <textarea
                      className="profile-modal-note-input"
                      value={note}
                      onChange={e => handleNoteChange(e.target.value)}
                      onBlur={() => setNoteEditing(false)}
                      placeholder={t('profile.notePlaceholder')}
                      rows={2}
                      autoFocus
                    />
                  ) : (
                    <div
                      className={`profile-modal-note-content${!note ? ' empty' : ''}`}
                      onClick={() => setNoteEditing(true)}
                      role="button"
                      tabIndex={0}
                      onKeyDown={e => e.key === 'Enter' && setNoteEditing(true)}
                    >
                      {note || t('profile.notePlaceholder')}
                    </div>
                  )}
                </div>
              )}

              {/* Message input */}
              {!isOwnProfile && (
                <div
                  className="profile-modal-message-wrap"
                  onClick={handleMessage}
                  role="button"
                  tabIndex={0}
                  onKeyDown={e => e.key === 'Enter' && handleMessage()}
                >
                  <input
                    type="text"
                    className="profile-modal-message-input"
                    placeholder={finalUsername ? `${t('friends.message')} @${finalUsername}` : `${t('friends.message')} ${finalDisplayName}`}
                    readOnly
                    tabIndex={-1}
                    aria-hidden="true"
                  />
                  <span className="profile-modal-message-emoji" aria-hidden="true">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <circle cx="12" cy="12" r="10" />
                      <path d="M8 14s1.5 2 4 2 4-2 4-2" />
                      <line x1="9"  y1="9"  x2="9.01"  y2="9"  />
                      <line x1="15" y1="9"  x2="15.01" y2="9"  />
                    </svg>
                  </span>
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </div>,
    document.body
  );
});

export default ProfileModal;

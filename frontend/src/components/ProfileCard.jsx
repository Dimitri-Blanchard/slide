import React, { useState, useEffect, useRef, memo, useCallback } from 'react';

function useIsMobile(breakpoint = 768) {
  const [isMobile, setIsMobile] = useState(() => typeof window !== 'undefined' && window.innerWidth <= breakpoint);
  useEffect(() => {
    const mq = window.matchMedia(`(max-width: ${breakpoint}px)`);
    const onChange = () => setIsMobile(mq.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [breakpoint]);
  return isMobile;
}
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
import UserDetailModal from './UserDetailModal';
import './ProfileCard.css';

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

const ProfileCard = memo(function ProfileCard({
  userId,
  user: providedUser,
  isOpen,
  onClose,
  anchorEl,
  clickPos,
  position = 'right',
  serverRoleBadges = null,
  serverTeamRole = null,
}) {
  const navigate   = useNavigate();
  const { user: currentUser } = useAuth();
  const { t }      = useLanguage();
  const { isUserOnline } = useOnlineUsers();

  const resolvedId = userId || providedUser?.id;
  const cached = resolvedId ? getCachedProfile(resolvedId) : null;
  const [user, setUser]             = useState(providedUser || cached || null);
  const [loading, setLoading]       = useState(!providedUser && !cached);
  const [note, setNote]             = useState('');
  const [noteEditing, setNoteEditing] = useState(false);
  const [menuOpen, setMenuOpen]     = useState(false);
  const [copied, setCopied]         = useState(false);
  const [copiedUsername, setCopiedUsername] = useState(false);
  const [cardPos, setCardPos]       = useState({ top: -9999, left: -9999 });
  const [detailOpen, setDetailOpen] = useState(false);

  const cardRef  = useRef(null);
  const menuRef  = useRef(null);
  const detailModalRef = useRef(null);
  const isMobile = useIsMobile();
  const isOwnProfile = currentUser?.id === resolvedId || currentUser?.id === providedUser?.id;

  // Load note
  useEffect(() => {
    if (resolvedId && !isOwnProfile) setNote(loadNote(resolvedId));
  }, [resolvedId, isOwnProfile]);

  // Fetch full profile (uses cache — instant when prefetched)
  useEffect(() => {
    if (!isOpen) return;
    if (providedUser) setUser(providedUser);
    if (userId) {
      const cachedNow = getCachedProfile(userId);
      if (cachedNow) {
        setUser(cachedNow);
        setLoading(false);
        return;
      }
      setLoading(true);
      getProfile(userId)
        .then(d => { setUser(d); setLoading(false); })
        .catch(() => setLoading(false));
    } else if (providedUser) {
      setLoading(false);
    }
  }, [userId, providedUser, isOpen]);

  // Position card near click / anchor element
  useEffect(() => {
    if (!isOpen) return;
    if (!clickPos && !anchorEl) return;

    const place = () => {
      const W = 320, H = 500, P = 12;
      let top, left, ax;

      if (clickPos) {
        top = clickPos.y; left = clickPos.x + P; ax = clickPos.x;
      } else {
        const r = anchorEl.getBoundingClientRect();
        ax = r.left; top = r.top;
        if (position === 'left')        left = r.left - W - P;
        else if (position === 'bottom') { top = r.bottom + P; left = r.left + r.width / 2 - W / 2; }
        else                            left = r.right + P;
      }

      if (left + W > window.innerWidth  - P) left = ax - W - P;
      if (left < P)                          left = P;
      if (top  + H > window.innerHeight - P) top  = window.innerHeight - H - P;
      if (top  < P)                          top  = P;

      setCardPos({ top, left });
    };

    place();
    if (!clickPos) {
      window.addEventListener('resize', place);
      window.addEventListener('scroll', place, true);
      return () => {
        window.removeEventListener('resize', place);
        window.removeEventListener('scroll', place, true);
      };
    }
  }, [isOpen, anchorEl, clickPos, position]);

  // Close on outside click / Escape (don't close when clicking expanded UserDetailModal)
  useEffect(() => {
    if (!isOpen) return;
    const onDown = (e) => {
      const inCard = cardRef.current?.contains(e.target);
      const inDetailModal = detailOpen && detailModalRef.current?.contains(e.target);
      if (!inCard && !inDetailModal) onClose();
    };
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    const t = setTimeout(() => {
      document.addEventListener('mousedown', onDown);
      document.addEventListener('keydown', onKey);
    }, 50);
    return () => {
      clearTimeout(t);
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [isOpen, onClose, detailOpen]);

  // Close menu on outside click
  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e) => { if (!menuRef.current?.contains(e.target)) setMenuOpen(false); };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [menuOpen]);

  const handleMessage = useCallback(async () => {
    if (!user?.id) return;
    try {
      const conv = await directApi.createConversation(parseInt(user.id, 10));
      onClose();
      navigate(`/channels/@me/${conv.conversation_id ?? conv.id}`);
    } catch {}
  }, [user?.id, navigate, onClose]);

  const handleNoteChange = useCallback((val) => {
    setNote(val);
    saveNote(resolvedId, val);
  }, [resolvedId]);

  const handleCopyId = async () => {
    await navigator.clipboard.writeText(String(resolvedId)).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
    setMenuOpen(false);
  };

  // ── Derived display data (must be before early return for consistent hooks) ──
  const hasRealHandle = !!(user?.username || user?.email?.split('@')[0]);
  const username = hasRealHandle
    ? normalizeHandle(user?.username || user?.email?.split('@')[0])
    : null;
  const rawDisplayName = normalizeDisplayName(user?.display_name, user?.username || user?.email?.split('@')[0]);
  const looksLikeLegacyTaggedName = !!(rawDisplayName && username)
    && new RegExp(`^${escapeRegExp(username)}(?:\\s*#?\\s*0+)?$`, 'i').test(rawDisplayName);
  const displayName = looksLikeLegacyTaggedName
    ? username
    : (rawDisplayName || username || t('chat.user'));
  const finalUsername = username ? stripTrailingLegacyZero(username) : null;
  const finalDisplayName = stripTrailingLegacyZero(displayName || '') || finalUsername || t('chat.user');

  const handleCopyUsername = useCallback(async () => {
    const toCopy = finalUsername ? `@${finalUsername}` : finalDisplayName;
    await navigator.clipboard.writeText(toCopy).catch(() => {});
    setCopiedUsername(true);
    setTimeout(() => setCopiedUsername(false), 1500);
  }, [finalUsername, finalDisplayName]);

  if (!isOpen) return null;

  // ── More derived data (after early return is ok — no hooks below) ────────────
  const bannerColor  = user?.banner_color  || '#4f6ef7';
  const rawBannerColor2 = typeof user?.banner_color_2 === 'string'
    ? user.banner_color_2.trim()
    : user?.banner_color_2;
  const bannerColor2 = (
    rawBannerColor2 &&
    rawBannerColor2 !== 'null' &&
    rawBannerColor2 !== 'undefined'
  ) ? rawBannerColor2 : null;
  const bannerUrl    = user?.banner_url ? getStaticUrl(user.banner_url) : null;
  const hasGifBanner = isGifUrl(user?.banner_url || bannerUrl);
  const hasDualBanner = !!bannerColor2;
  // Keep banner-color card styling whenever dual colors are enabled.
  const useBannerColorCard = hasDualBanner;
  // Only auto-switch text contrast when there is no banner image.
  const useAdaptiveContrastText = hasDualBanner && !bannerUrl;
  const [c1, c2]      = hasDualBanner ? harmonizeGradientColors(bannerColor, bannerColor2 || '#000') : [bannerColor, '#000'];
  const verticalGrad = (a, b) => `linear-gradient(180deg, ${a} 0%, ${a} 12%, ${b} 88%, ${b} 100%)`;
  const bannerStyle  = bannerUrl
    ? (hasGifBanner
        ? { backgroundColor: c1 }
        : { backgroundImage: `url(${bannerUrl})`, backgroundSize: 'cover', backgroundPosition: `center ${profile?.banner_position || 'center'}` })
    : hasDualBanner
      ? { backgroundImage: verticalGrad(c1, c2) }
      : { backgroundColor: c1 };
  const borderGrad   = verticalGrad(c1, c2);
  const innerGrad    = verticalGrad(lightenHex(c1), lightenHex(c2));
  const cardStyle    = useBannerColorCard
    ? {
        backgroundImage: `${innerGrad}, ${borderGrad}`,
        backgroundOrigin: 'padding-box, border-box',
        backgroundClip: 'padding-box, border-box',
        border: '5px solid transparent',
        borderRadius: '8px',
      }
    : undefined;

  const aboutMe       = user?.about_me || user?.bio;
  const statusMessage = user?.status_message
    || (isOwnProfile ? getStoredCustomStatus(currentUser?.id) : null)
    || null;
  const joinDate = user?.created_at
    ? new Date(user.created_at).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
    : null;

  const presenceStatus = (() => {
    if (isOwnProfile) return getStoredOnlineStatus(currentUser?.id);
    if (isUserOnline(user?.id)) return 'online';
    return 'offline';
  })();
  const statusColor = STATUS_COLORS[presenceStatus] || STATUS_COLORS.offline;

  // ── Card inner content ────────────────────────────────────
  const inner = (
    <>
      {/* Banner */}
      <div
        className={`profile-card-banner${bannerUrl ? ' profile-card-banner--tall' : !hasDualBanner ? ' profile-card-banner--single-color' : ''}`}
        style={bannerStyle}
        aria-hidden="true"
      >
        {bannerUrl && hasGifBanner && (
          <img
            className="profile-card-banner-img"
            src={bannerUrl}
            alt=""
            draggable={false}
          />
        )}
      </div>

      {/* Avatar row — sibling of banner so overlap isn't clipped by scroll */}
      <div className="profile-card-avatar-row">
        <div className={`profile-card-avatar-wrapper${hasDualBanner ? ' profile-card-avatar-wrapper--gradient' : ''}`}>
          {loading ? (
            <div className="profile-card-skeleton-avatar" />
          ) : (
            <>
              <Avatar user={user} size="xlarge" gifAnimate />
              <div
                className="profile-card-status-badge-wrap"
                style={{ background: statusColor }}
                title={presenceStatus}
              />
            </>
          )}
        </div>

        {/* Action buttons */}
        {!loading && user && (
          <div className="profile-card-actions">
            {!isOwnProfile ? (
              <button
                className="profile-card-action-btn"
                onClick={handleMessage}
                title={t('friends.message')}
                aria-label={t('friends.message')}
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                </svg>
              </button>
            ) : (
              <button
                className="profile-card-action-btn"
                onClick={() => { onClose(); navigate('/settings'); }}
                title={t('profile.editProfile')}
                aria-label={t('profile.editProfile')}
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                  <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
                </svg>
              </button>
            )}

            {/* More (3-dot) menu */}
            <div className="profile-card-menu-wrap" ref={menuRef}>
              <button
                className="profile-card-action-btn"
                onClick={() => setMenuOpen(v => !v)}
                title={t('profile.moreActions')}
                aria-label={t('profile.moreActions')}
                aria-expanded={menuOpen}
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                  <circle cx="12" cy="5"  r="1.5" />
                  <circle cx="12" cy="12" r="1.5" />
                  <circle cx="12" cy="19" r="1.5" />
                </svg>
              </button>
              {menuOpen && (
                <div className="profile-card-dropdown" role="menu">
                  <button className="profile-card-dropdown-item" role="menuitem" onClick={handleCopyId}>
                    {copied ? t('common.copied') : t('common.copyUserId')}
                  </button>
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Scrollable body */}
      <div className="profile-card-scroll">
        <div className="profile-card-content">
          {/* Body text */}
          <div className={`profile-card-body${isOwnProfile && user ? ' profile-card-body--own' : ''}`}>
            {loading ? (
              <div className="profile-card-loading">
                <div className="profile-card-skeleton-line profile-card-skeleton-line--name" />
                <div className="profile-card-skeleton-line profile-card-skeleton-line--tag"  />
              </div>
            ) : user ? (
              <>
                {/* Identity */}
                <div className="profile-card-identity">
                  <h2 className="profile-card-displayname">
                    {finalDisplayName}
                    {!isOwnProfile && (
                      <button
                        type="button"
                        className="profile-card-note-btn"
                        onClick={() => setNoteEditing(true)}
                        title={note ? t('profile.editNote') : t('profile.addNote')}
                        aria-label={note ? t('profile.editNote') : t('profile.addNote')}
                      >
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                          <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                          <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
                        </svg>
                      </button>
                    )}
                  </h2>
                  <div className="profile-card-tag-row">
                    {finalUsername ? (
                      <span className="profile-card-username">@{finalUsername}</span>
                    ) : (
                      <span className="profile-card-username profile-card-username--muted">{t('profile.noHandleSet')}</span>
                    )}
                    <button
                      type="button"
                      className="profile-card-copy-username-btn"
                      onClick={(e) => { e.stopPropagation(); handleCopyUsername(); }}
                      title={copiedUsername ? (t('common.copied') || 'Copied!') : (t('profile.copyUsername') || 'Copy username')}
                      aria-label={copiedUsername ? (t('common.copied') || 'Copied!') : (t('profile.copyUsername') || 'Copy username')}
                    >
                      {copiedUsername ? (
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>
                      ) : (
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
                      )}
                    </button>
                  </div>
                  {/* Note inline — shown when editing or when note exists */}
                  {!isOwnProfile && (noteEditing || note) && (
                    <div className="profile-card-note-inline">
                      {noteEditing ? (
                        <textarea
                          className="profile-card-note-input"
                          value={note}
                          onChange={e => handleNoteChange(e.target.value)}
                          onBlur={() => setNoteEditing(false)}
                          placeholder={t('profile.notePlaceholder')}
                          rows={2}
                          autoFocus
                        />
                      ) : (
                        <p className="profile-card-note-preview" onClick={() => setNoteEditing(true)} role="button" tabIndex={0} onKeyDown={e => e.key === 'Enter' && setNoteEditing(true)}>
                          {note}
                        </p>
                      )}
                    </div>
                  )}
                </div>

                {/* Custom status */}
                {statusMessage && (
                  <div className="profile-card-status-msg">{statusMessage}</div>
                )}

                {/* Spotify now playing */}
                {user.spotify_now_playing && (
                  <div className="profile-card-spotify">
                    <div className="profile-card-spotify-icon" aria-hidden="true">
                      <svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 0C5.4 0 0 5.4 0 12s5.4 12 12 12 12-5.4 12-12S18.66 0 12 0zm5.521 17.34c-.24.359-.66.48-1.021.24-2.82-1.74-6.36-2.101-10.561-1.141-.418.122-.779-.179-.899-.539-.12-.421.18-.78.54-.9 4.56-1.021 8.52-.6 11.64 1.32.42.18.479.659.301 1.02zm1.44-3.3c-.301.42-.841.6-1.262.3-3.239-1.98-8.159-2.58-11.939-1.38-.479.12-1.02-.12-1.14-.6-.12-.48.12-1.021.6-1.141C9.6 9.9 15 10.561 18.72 12.84c.361.181.54.78.241 1.2zm.12-3.36C15.24 8.4 8.82 8.16 5.16 9.301c-.6.179-1.2-.181-1.38-.721-.18-.601.18-1.2.72-1.381 4.26-1.26 11.28-1.02 15.721 1.621.539.3.719 1.02.419 1.56-.299.421-1.02.599-1.559.3z"/></svg>
                    </div>
                    <div className="profile-card-spotify-content">
                      <span className="profile-card-spotify-label">{t('profile.listeningTo') || 'Listening to'}</span>
                      <a
                        href={user.spotify_now_playing.external_url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="profile-card-spotify-track"
                        title={user.spotify_now_playing.name}
                      >
                        {user.spotify_now_playing.name}
                        {user.spotify_now_playing.artists && ` — ${user.spotify_now_playing.artists}`}
                      </a>
                    </div>
                    {user.spotify_now_playing.album_art && (
                      <img src={user.spotify_now_playing.album_art} alt="" className="profile-card-spotify-art" />
                    )}
                  </div>
                )}

                {/* Connect Spotify hint (own profile, not connected) */}
                {isOwnProfile && !user.spotify_connected && (
                  <div className="profile-card-spotify-hint">
                    <div className="profile-card-spotify-icon" aria-hidden="true">
                      <svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 0C5.4 0 0 5.4 0 12s5.4 12 12 12 12-5.4 12-12S18.66 0 12 0zm5.521 17.34c-.24.359-.66.48-1.021.24-2.82-1.74-6.36-2.101-10.561-1.141-.418.122-.779-.179-.899-.539-.12-.421.18-.78.54-.9 4.56-1.021 8.52-.6 11.64 1.32.42.18.479.659.301 1.02zm1.44-3.3c-.301.42-.841.6-1.262.3-3.239-1.98-8.159-2.58-11.939-1.38-.479.12-1.02-.12-1.14-.6-.12-.48.12-1.021.6-1.141C9.6 9.9 15 10.561 18.72 12.84c.361.181.54.78.241 1.2zm.12-3.36C15.24 8.4 8.82 8.16 5.16 9.301c-.6.179-1.2-.181-1.38-.721-.18-.601.18-1.2.72-1.381 4.26-1.26 11.28-1.02 15.721 1.621.539.3.719 1.02.419 1.56-.299.421-1.02.599-1.559.3z"/></svg>
                    </div>
                    <button
                      type="button"
                      className="profile-card-spotify-connect-btn"
                      onClick={() => { onClose(); navigate('/settings?section=connections'); }}
                    >
                      {t('profile.connectSpotifyHint') || 'Connect Spotify to show what you\'re listening to'}
                    </button>
                  </div>
                )}

                {/* Divider */}
                <hr className="profile-card-divider" />

                {/* About Me */}
                {aboutMe && (
                  <div className="profile-card-section">
                    <h3 className="profile-card-section-title">{t('profile.aboutMe')}</h3>
                    <p className="profile-card-section-content">{aboutMe}</p>
                  </div>
                )}

                {/* Member Since */}
                {joinDate && (
                  <div className="profile-card-section">
                    <h3 className="profile-card-section-title">{t('profile.memberSince')}</h3>
                    <p className="profile-card-section-content">{joinDate}</p>
                  </div>
                )}

                {/* Serveurs et groupes en commun — clickable */}
                {!isOwnProfile && (user.common_teams > 0) && (
                  <button
                    type="button"
                    className="profile-card-mutuals-btn"
                    onClick={() => setDetailOpen(true)}
                  >
                    <span className="profile-card-mutuals-icon" aria-hidden="true">
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/>
                        <circle cx="9" cy="7" r="4"/>
                        <path d="M23 21v-2a4 4 0 0 0-3-3.87"/>
                        <path d="M16 3.13a4 4 0 0 1 0 7.75"/>
                      </svg>
                    </span>
                    <span className="profile-card-mutuals-text">
                      Serveurs et groupes
                    </span>
                    <span className="profile-card-mutuals-count">{user.common_teams}</span>
                    <svg className="profile-card-mutuals-chevron" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                      <polyline points="9 18 15 12 9 6"/>
                    </svg>
                  </button>
                )}

                {/* Badges — above message for others, at bottom for own profile */}
                {(Boolean(user.is_webhook) || Boolean(user.has_nitro) || serverTeamRole === 'owner' || (serverRoleBadges?.length > 0)) && (
                  <div className={`profile-card-badges-row${isOwnProfile ? ' profile-card-badges-row--bottom' : ''}`}>
                    {Boolean(user.is_webhook) && <span className="profile-card-badge profile-card-badge--bot">BOT</span>}
                    {Boolean(user.has_nitro) && <span className="profile-card-badge profile-card-badge--nitro">Nitro</span>}
                    {serverTeamRole === 'owner' && <span className="profile-card-badge profile-card-badge--owner" title={t('owner') || 'Owner'}>{t('owner') || 'Owner'}</span>}
                    {serverRoleBadges?.map((r, i) => (
                      <span key={i} className="profile-card-badge profile-card-badge--role" style={{ borderColor: r.color || 'var(--border-default)', color: r.color || 'var(--text-secondary)' }} title={r.name}>
                        {r.name}
                      </span>
                    ))}
                  </div>
                )}

                {/* Message input (click to open DM) */}
                {!isOwnProfile && (
                  <div
                    className="profile-card-message-wrap"
                    onClick={handleMessage}
                    role="button"
                    tabIndex={0}
                    onKeyDown={e => e.key === 'Enter' && handleMessage()}
                  >
                    <input
                      type="text"
                      className="profile-card-message-input"
                      placeholder={finalUsername ? `${t('friends.message')} @${finalUsername}` : `${t('friends.message')} ${finalDisplayName}`}
                      readOnly
                      tabIndex={-1}
                      aria-hidden="true"
                    />
                    <span className="profile-card-message-emoji" aria-hidden="true">
                      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <circle cx="12" cy="12" r="10" />
                        <path d="M8 14s1.5 2 4 2 4-2 4-2" />
                        <line x1="9"  y1="9"  x2="9.01"  y2="9"  />
                        <line x1="15" y1="9"  x2="15.01" y2="9"  />
                      </svg>
                    </span>
                  </div>
                )}

                {/* Expand to full detail modal */}
                {!isOwnProfile && (
                  <button
                    type="button"
                    className="profile-card-expand-btn"
                    onClick={() => setDetailOpen(true)}
                    title="Voir le profil complet"
                  >
                    Voir le profil complet
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                      <polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/>
                      <line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/>
                    </svg>
                  </button>
                )}
              </>
            ) : (
              <div className="profile-card-error">
                <p>{t('errors.loadProfile')}</p>
              </div>
            )}
          </div>
        </div>
      </div>
    </>
  );

  // ── Render: popup (default) or centered card overlay ─────
  const hasPositionData = clickPos || anchorEl;
  const isCardVariant   = false; // card variant removed — always use popup positioning

  const isHighContrast = useAdaptiveContrastText && isHighContrastGradient(bannerColor, bannerColor2 || '#000');
  const isLight = useAdaptiveContrastText && !isHighContrast && isLightGradient(bannerColor, bannerColor2 || '#000');
  const noOverlayBand = useAdaptiveContrastText && areMatchingBannerColors(bannerColor, bannerColor2 || '#000');
  const effectClass = user?.equipped_profile_effect_id ? ` profile-card-effect-${user.equipped_profile_effect_id}` : '';
  const popupClasses = `profile-card-popup${hasDualBanner ? ' profile-card-popup--dual-banner' : ''}${isHighContrast && !noOverlayBand ? ' profile-card-popup--high-contrast-gradient' : ''}${isLight ? ' profile-card-popup--light-gradient' : ''}${noOverlayBand ? ' profile-card-popup--no-overlay-band' : ''}${effectClass}`;

  const cardContent = (
    <>
      {user?.equipped_profile_effect_id && (
        <div className={`profile-effect-overlay profile-effect-${user.equipped_profile_effect_id}`} aria-hidden />
      )}
      {inner}
    </>
  );

  const content = isMobile ? null : hasPositionData || !isCardVariant ? (
    <div
      className={popupClasses}
      ref={cardRef}
      style={{ top: cardPos.top, left: cardPos.left, ...(cardStyle || {}) }}
      role="dialog"
      aria-label={`${finalDisplayName} profile`}
    >
      {cardContent}
    </div>
  ) : (
    /* Fallback: centered overlay when no position data */
    <div className="profile-card-overlay">
      <div className="profile-card-backdrop" onClick={onClose} aria-hidden="true" />
      <div className={`${popupClasses} profile-card-popup--card`} ref={cardRef} role="dialog" style={cardStyle || undefined}>
        {cardContent}
      </div>
    </div>
  );

  return (
    <>
      {isMobile ? (
        <UserDetailModal
          userId={resolvedId}
          user={user}
          isOpen={isOpen}
          onClose={onClose}
          containerRef={detailModalRef}
        />
      ) : (
        <>
          {createPortal(content, document.body)}
          {detailOpen && (
            <UserDetailModal
              userId={resolvedId}
              user={user}
              isOpen={detailOpen}
              onClose={() => setDetailOpen(false)}
              containerRef={detailModalRef}
            />
          )}
        </>
      )}
    </>
  );
});

// ── Hook for managing profile card state ──────────────────
export function useProfileCard() {
  const [state, setState] = useState({
    isOpen: false, userId: null, user: null, anchorEl: null, clickPos: null, position: 'right',
  });

  const openProfileCard = (userId, anchorElOrEvent, user = null, position = 'right') => {
    let anchorEl = null, clickPos = null;
    if (anchorElOrEvent?.clientX !== undefined) {
      clickPos = { x: anchorElOrEvent.clientX, y: anchorElOrEvent.clientY };
    } else {
      anchorEl = anchorElOrEvent;
    }
    setState({ isOpen: true, userId, user, anchorEl, clickPos, position });
  };

  const closeProfileCard = () => setState(p => ({ ...p, isOpen: false }));

  return {
    profileCard: state,
    openProfileCard,
    closeProfileCard,
    ProfileCardComponent: (
      <ProfileCard
        userId={state.userId}
        user={state.user}
        isOpen={state.isOpen}
        onClose={closeProfileCard}
        anchorEl={state.anchorEl}
        clickPos={state.clickPos}
        position={state.position}
      />
    ),
  };
}

export default ProfileCard;

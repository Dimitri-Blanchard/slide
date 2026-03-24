import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useNotification } from '../context/NotificationContext';
import { useSettings } from '../context/SettingsContext';
import { useSounds } from '../context/SoundContext';
import { useLanguage } from '../context/LanguageContext';
import { auth, avatars as avatarsApi, settings as settingsApi, stickers as stickersApi, teams as teamsApi, friends as friendsApi, invalidateCache, BACKEND_ORIGIN } from '../api';
import { validatePassword } from '../utils/security';
import { getStoredOnlineStatus } from '../utils/presenceStorage';
import { invalidateProfile } from '../utils/profileCache';
import { harmonizeGradientColors, lightenHex, isLightGradient, isHighContrastGradient } from '../utils/gradientColors';
import QRCode from 'qrcode';
import { useAudioDevices } from '../hooks/useAudioDevices';
import { usePushNotifications } from '../hooks/usePushNotifications';
import Avatar, { StatusBadgeIcon } from '../components/Avatar';
import { PHONE_COUNTRIES } from '../constants/phoneCountries';
import { AsYouType } from 'libphonenumber-js';
import './Settings.css';
import '../components/ProfileCard.css';
import ColorPicker from '../components/ColorPicker';
import ConfirmModal from '../components/ConfirmModal';
import MfaCodeInput from '../components/MfaCodeInput';

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function sanitizeLegacyDisplayName(displayName, username) {
  const raw = String(displayName || '').trim();
  if (!raw) return '';
  const cleanUsername = String(username || '')
    .replace(/(\s+|#)0*\s*$/, '')
    .replace(/(?<![0-9])0\s*$/, '')
    .trim();
  if (cleanUsername && new RegExp(`^${escapeRegExp(cleanUsername)}(?:\\s*#?\\s*0+)?$`, 'i').test(raw)) {
    return cleanUsername;
  }
  return raw;
}

function stripTrailingLegacyZero(value) {
  const normalized = String(value || '').normalize('NFKC').trim();
  return normalized.replace(/([^\d])0+$/, '$1').trim();
}

function normalizeOptionalColor(value) {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  if (!trimmed) return '';
  const lowered = trimmed.toLowerCase();
  if (lowered === 'null' || lowered === 'undefined') return '';
  return trimmed;
}

const SHOP_ITEM_NAMES = {
  1: 'Gold Ring', 2: 'Platinum Ring', 3: 'Warm Glow', 4: 'Soft Highlight', 5: 'Gold Badge',
  6: 'Violet Ring', 7: 'Frost Glow', 8: 'Frost Ring', 9: 'Silver Badge', 10: 'Frost Edge',
};

const DEFAULT_PHONE_COUNTRY = PHONE_COUNTRIES.find((country) => country.iso2 === 'US') || PHONE_COUNTRIES[0];
const PHONE_COUNTRIES_BY_LONGEST_CODE = [...PHONE_COUNTRIES].sort((a, b) => {
  const aLength = a.dialCode.replace(/\D/g, '').length;
  const bLength = b.dialCode.replace(/\D/g, '').length;
  return bLength - aLength;
});

function splitPhoneByCountry(rawPhone) {
  const compactPhone = String(rawPhone || '').trim().replace(/\s+/g, '');
  const normalizedPhone = compactPhone.replace(/[^\d+]/g, '');
  if (!normalizedPhone.startsWith('+')) {
    return { country: DEFAULT_PHONE_COUNTRY, localNumber: compactPhone };
  }

  const matchedCountry = PHONE_COUNTRIES_BY_LONGEST_CODE.find((country) => {
    const dialCode = `+${country.dialCode.replace(/\D/g, '')}`;
    return normalizedPhone.startsWith(dialCode);
  });

  if (!matchedCountry) {
    return { country: DEFAULT_PHONE_COUNTRY, localNumber: normalizedPhone.replace(/^\+\d+/, '').trim() };
  }

  const normalizedDialCode = `+${matchedCountry.dialCode.replace(/\D/g, '')}`;
  const localNumber = normalizedPhone.slice(normalizedDialCode.length).trim();
  return { country: matchedCountry, localNumber };
}

function formatPhoneLocalInput(value, iso2) {
  const digits = String(value || '').replace(/\D/g, '').slice(0, 15);
  if (!digits) return '';

  try {
    const formatter = new AsYouType(iso2 || DEFAULT_PHONE_COUNTRY.iso2);
    const formatted = formatter.input(digits);
    if (formatted) {
      return formatted
        .replace(/[().-]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    }
  } catch {
    // Fallback below if the country code is unknown.
  }

  const fallbackGroups = [];
  for (let i = 0; i < digits.length; i += 3) {
    fallbackGroups.push(digits.slice(i, i + 3));
  }
  return fallbackGroups.join(' ');
}

function AvatarCropModal({ file, onConfirm, onCancel }) {
  const imgRef = useRef(null);
  const containerRef = useRef(null);
  const [loaded, setLoaded] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [minZoom, setMinZoom] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const dragging = useRef(false);
  const dragStart = useRef({ x: 0, y: 0 });
  const offsetStart = useRef({ x: 0, y: 0 });

  const isGif = file.type === 'image/gif';
  const imgUrl = useMemo(() => URL.createObjectURL(file), [file]);

  useEffect(() => () => URL.revokeObjectURL(imgUrl), [imgUrl]);

  const [isWideImage, setIsWideImage] = useState(false);
  const handleLoad = useCallback(() => {
    setLoaded(true);
    const img = imgRef.current;
    if (!img) return;
    const w = img.naturalWidth;
    const h = img.naturalHeight;
    const minDim = Math.min(w, h);
    const fillZoom = 256 / minDim; // zoom at which image fills the crop circle
    setMinZoom(fillZoom);
    setZoom(Math.max(fillZoom, 1));
    setOffset({ x: 0, y: 0 });
    setIsWideImage(w > 2.5 * h || h > 2.5 * w); // Banner-like aspect ratio
  }, []);

  const handlePointerDown = useCallback((e) => {
    dragging.current = true;
    dragStart.current = { x: e.clientX, y: e.clientY };
    offsetStart.current = { ...offset };
    e.currentTarget.setPointerCapture(e.pointerId);
  }, [offset]);

  const handlePointerMove = useCallback((e) => {
    if (!dragging.current) return;
    setOffset({
      x: offsetStart.current.x + (e.clientX - dragStart.current.x),
      y: offsetStart.current.y + (e.clientY - dragStart.current.y),
    });
  }, []);

  const handlePointerUp = useCallback(() => {
    dragging.current = false;
  }, []);

  const handleWheel = useCallback((e) => {
    e.preventDefault();
    setZoom(z => Math.max(minZoom, Math.min(5, z - e.deltaY * 0.001)));
  }, [minZoom]);

  const getCropParams = useCallback(() => {
    const img = imgRef.current;
    if (!img) return null;
    const natW = img.naturalWidth;
    const natH = img.naturalHeight;
    const previewSize = 256;
    const cropSizeInOriginal = previewSize / zoom;
    const cx = natW / 2 - offset.x / zoom;
    const cy = natH / 2 - offset.y / zoom;
    let cropX = cx - cropSizeInOriginal / 2;
    let cropY = cy - cropSizeInOriginal / 2;
    cropX = Math.max(0, Math.min(cropX, natW - cropSizeInOriginal));
    cropY = Math.max(0, Math.min(cropY, natH - cropSizeInOriginal));
    const size = Math.min(cropSizeInOriginal, natW, natH);
    return { x: cropX, y: cropY, size, sourceWidth: natW, sourceHeight: natH };
  }, [zoom, offset]);

  const handleConfirm = useCallback(() => {
    const img = imgRef.current;
    if (!img) return;

    if (isGif) {
      const crop = getCropParams();
      onConfirm(file, crop);
      return;
    }

    const size = 256;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');

    const dispW = img.naturalWidth * zoom;
    const dispH = img.naturalHeight * zoom;
    const drawX = (size - dispW) / 2 + offset.x;
    const drawY = (size - dispH) / 2 + offset.y;

    ctx.beginPath();
    ctx.arc(size / 2, size / 2, size / 2, 0, Math.PI * 2);
    ctx.closePath();
    ctx.clip();
    ctx.drawImage(img, drawX, drawY, dispW, dispH);

    canvas.toBlob((blob) => {
      if (blob) onConfirm(blob, null);
    }, 'image/png');
  }, [file, isGif, zoom, offset, onConfirm, getCropParams]);

  const previewSize = 256;

  return (
    <div className="avatar-crop-overlay" onClick={onCancel}>
      <div className="avatar-crop-modal" onClick={e => e.stopPropagation()}>
        <h3>Crop Avatar</h3>
        {isWideImage && (
          <p className="avatar-crop-warning">
            This image looks like a banner. Avatars work best with square images.
          </p>
        )}
        <div
          ref={containerRef}
          className="avatar-crop-area"
          style={{ width: previewSize, height: previewSize }}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onWheel={handleWheel}
        >
          <div className="avatar-crop-circle" />
          <img
            ref={imgRef}
            src={imgUrl}
            alt="crop preview"
            className="avatar-crop-img"
            draggable={false}
            onLoad={handleLoad}
            style={loaded && imgRef.current ? {
              width: imgRef.current.naturalWidth * zoom,
              height: imgRef.current.naturalHeight * zoom,
              left: (previewSize - imgRef.current.naturalWidth * zoom) / 2 + offset.x,
              top: (previewSize - imgRef.current.naturalHeight * zoom) / 2 + offset.y,
            } : { opacity: 0 }}
          />
        </div>

        <div className="avatar-crop-zoom">
          <span style={{ fontSize: '0.75rem' }}>−</span>
          <input
            type="range"
            min={minZoom}
            max="5"
            step="0.01"
            value={Math.max(minZoom, Math.min(5, zoom))}
            onChange={e => setZoom(Math.max(minZoom, Math.min(5, parseFloat(e.target.value))))}
          />
          <span style={{ fontSize: '0.75rem' }}>+</span>
        </div>

        <div className="avatar-crop-actions">
          <button type="button" className="btn-cancel" onClick={onCancel}>Cancel</button>
          <button type="button" className="btn-confirm" onClick={handleConfirm}>Apply</button>
        </div>
      </div>
    </div>
  );
}

// Custom debounce hook
function useDebounce(value, delay) {
  const [debouncedValue, setDebouncedValue] = useState(value);
  
  useEffect(() => {
    const handler = setTimeout(() => {
      setDebouncedValue(value);
    }, delay);
    
    return () => clearTimeout(handler);
  }, [value, delay]);
  
  return debouncedValue;
}

function ConnectedDevicesSection() {
  const { t } = useLanguage();
  const { notify } = useNotification();
  const [devices, setDevices] = useState([]);
  const [loading, setLoading] = useState(true);
  const [revoking, setRevoking] = useState(null);
  const [confirmRevoke, setConfirmRevoke] = useState(null);

  const loadDevices = useCallback(() => {
    setLoading(true);
    auth.devices.list()
      .then(({ devices: list }) => setDevices(list || []))
      .catch(() => setDevices([]))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { loadDevices(); }, [loadDevices]);

  const handleRevoke = useCallback(async (device) => {
    if (revoking) return;
    const ids = Array.from(new Set([
      device?.deviceId,
      ...((Array.isArray(device?.mergedDeviceIds) ? device.mergedDeviceIds : [])),
    ].filter(Boolean)));
    if (ids.length === 0) return;
    setRevoking(device.deviceId);
    try {
      const results = await Promise.allSettled(ids.map((id) => auth.devices.revoke(id)));
      const hasSuccess = results.some((r) => r.status === 'fulfilled');
      if (!hasSuccess) {
        const firstError = results.find((r) => r.status === 'rejected');
        throw firstError?.reason || new Error(t('common.error'));
      }
      notify.success(t('account.deviceDisconnected'));
      await loadDevices();
      setConfirmRevoke(null);
    } catch (err) {
      notify.error(err.message || t('common.error'));
    } finally {
      setRevoking(null);
    }
  }, [revoking, notify, t, loadDevices]);

  const formatDate = (d) => {
    if (!d) return '-';
    const dt = new Date(d);
    const now = new Date();
    const diffMs = now - dt;
    if (diffMs < 60000) return t('account.justNow') || 'Just now';
    if (diffMs < 3600000) return `${Math.floor(diffMs / 60000)} min ago`;
    if (diffMs < 86400000) return `${Math.floor(diffMs / 3600000)}h ago`;
    return dt.toLocaleDateString();
  };

  if (loading) {
    return (
      <div className="devices-section">
        <p className="devices-description">{t('account.devicesDescription')}</p>
        <div className="settings-skeleton">
          {[1, 2, 3].map((i) => <div key={i} className="settings-skeleton-row" />)}
        </div>
      </div>
    );
  }

  return (
    <div className="devices-section">
      <p className="devices-description">{t('account.devicesDescription')}</p>
      {devices.length === 0 ? (
        <p className="settings-muted">{t('account.noDevices')}</p>
      ) : (
        <ul className="devices-list">
          {devices.map((d) => (
            <li key={d.deviceId} className={`device-item ${d.isCurrent ? 'current' : ''}`}>
              <div className="device-info">
                <span className="device-name">{d.deviceName}</span>
                {d.isCurrent && <span className="device-badge">{t('account.thisDevice')}</span>}
                <span className="device-last">{formatDate(d.lastActiveAt)}</span>
                {(d.ipAddress || d.location) && (
                  <div className="device-meta">
                    {d.ipAddress && <span className="device-ip">{t('account.connectionIP')}: {d.ipAddress}</span>}
                    {d.location && <span className="device-location">{t('account.connectionLocation')}: {d.location}</span>}
                  </div>
                )}
              </div>
              {!d.isCurrent && (
                <button
                  type="button"
                  className="btn-secondary btn-sm btn-outline-danger"
                  onClick={() => setConfirmRevoke(d)}
                  disabled={revoking === d.deviceId}
                  title={t('account.disconnectDevice')}
                >
                  {revoking === d.deviceId ? t('common.loading') : t('account.disconnectDevice')}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {confirmRevoke && (
        <ConfirmModal
          isOpen={!!confirmRevoke}
          title={t('account.disconnectDevice')}
          message={(t('account.disconnectDeviceConfirm') || 'Disconnect "{name}"? This will require 2FA on next login.').replace('{name}', confirmRevoke.deviceName)}
          confirmText={t('account.disconnectDevice')}
          cancelText={t('common.cancel')}
          onConfirm={() => handleRevoke(confirmRevoke)}
          onCancel={() => setConfirmRevoke(null)}
          type="danger"
        />
      )}
    </div>
  );
}

// Settings categories configuration (using translation function)
const getSettingsCategories = (t) => [
  {
    id: 'user-settings',
    label: t('settings.userSettings'),
    items: [
      { id: 'account', label: t('settings.account'), icon: 'user' },
      { id: 'profile', label: t('settings.profile'), icon: 'profile' },
      { id: 'privacy', label: t('settings.privacy'), icon: 'shield' },
      { id: 'connections', label: t('connections.title'), icon: 'link' },
      { id: 'blocked', label: t('friends.blocked'), icon: 'blocked' },
    ]
  },
  {
    id: 'app-settings',
    label: t('settings.appSettings'),
    items: [
      { id: 'appearance', label: t('settings.appearance'), icon: 'palette' },
      { id: 'accessibility', label: t('settings.accessibility'), icon: 'accessibility' },
      { id: 'voice', label: t('settings.voice'), icon: 'mic' },
      { id: 'notifications', label: t('settings.notifications'), icon: 'bell' },
      { id: 'keybinds', label: t('settings.keybinds'), icon: 'keyboard' },
      { id: 'language', label: t('settings.language'), icon: 'globe' },
      { id: 'stickers', label: t('settings.stickers'), icon: 'sticker' },
    ]
  },
  {
    id: 'advanced',
    label: t('settings.advanced'),
    items: [
      { id: 'advanced', label: t('settings.advancedSettings'), icon: 'code' },
      { id: 'activity', label: t('settings.activityLog'), icon: 'activity' },
    ]
  },
];

// Icon components
const SettingsIcon = ({ name }) => {
  const icons = {
    user: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/>
        <circle cx="12" cy="7" r="4"/>
      </svg>
    ),
    profile: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <rect x="3" y="3" width="18" height="18" rx="2" ry="2"/>
        <circle cx="8.5" cy="8.5" r="1.5"/>
        <polyline points="21 15 16 10 5 21"/>
      </svg>
    ),
    shield: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
      </svg>
    ),
    link: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/>
        <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>
      </svg>
    ),
    palette: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="13.5" cy="6.5" r="0.5" fill="currentColor"/>
        <circle cx="17.5" cy="10.5" r="0.5" fill="currentColor"/>
        <circle cx="8.5" cy="7.5" r="0.5" fill="currentColor"/>
        <circle cx="6.5" cy="12.5" r="0.5" fill="currentColor"/>
        <path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.926 0 1.648-.746 1.648-1.688 0-.437-.18-.835-.437-1.125-.29-.289-.438-.652-.438-1.125a1.64 1.64 0 0 1 1.668-1.668h1.996c3.051 0 5.555-2.503 5.555-5.555C21.965 6.012 17.461 2 12 2z"/>
      </svg>
    ),
    accessibility: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="4" r="2"/>
        <path d="M12 6v2"/>
        <path d="m8 11 4 4 4-4"/>
        <path d="M6 9h12"/>
        <path d="m10 15-2 6"/>
        <path d="m14 15 2 6"/>
      </svg>
    ),
    mic: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/>
        <path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
        <line x1="12" y1="19" x2="12" y2="23"/>
        <line x1="8" y1="23" x2="16" y2="23"/>
      </svg>
    ),
    bell: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/>
        <path d="M13.73 21a2 2 0 0 1-3.46 0"/>
      </svg>
    ),
    keyboard: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <rect x="2" y="4" width="20" height="16" rx="2" ry="2"/>
        <path d="M6 8h.001"/>
        <path d="M10 8h.001"/>
        <path d="M14 8h.001"/>
        <path d="M18 8h.001"/>
        <path d="M8 12h.001"/>
        <path d="M12 12h.001"/>
        <path d="M16 12h.001"/>
        <path d="M7 16h10"/>
      </svg>
    ),
    globe: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="10"/>
        <line x1="2" y1="12" x2="22" y2="12"/>
        <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>
      </svg>
    ),
    code: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <polyline points="16 18 22 12 16 6"/>
        <polyline points="8 6 2 12 8 18"/>
      </svg>
    ),
    activity: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>
      </svg>
    ),
    sticker: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M15.5 3H5a2 2 0 0 0-2 2v14c0 1.1.9 2 2 2h14a2 2 0 0 0 2-2V8.5L15.5 3Z"/>
        <path d="M15 3v6h6"/>
        <circle cx="10" cy="14" r="2"/>
        <path d="M8 14v.5"/>
        <path d="M12 14v.5"/>
      </svg>
    ),
    blocked: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="10"/>
        <line x1="4.93" y1="4.93" x2="19.07" y2="19.07"/>
      </svg>
    ),
  };
  return <span className="settings-nav-icon">{icons[name]}</span>;
};

// Toggle Switch Component
const ToggleSwitch = ({ checked, onChange, disabled = false }) => (
  <button
    type="button"
    className={`toggle-switch ${checked ? 'active' : ''} ${disabled ? 'disabled' : ''}`}
    onClick={() => !disabled && onChange(!checked)}
    disabled={disabled}
  >
    <span className="toggle-slider" />
  </button>
);

// Range Slider Component
const RangeSlider = ({ value, onChange, min = 0, max = 100, label, unit = '' }) => (
  <div className="range-slider-container">
    <div className="range-slider-header">
      <span className="range-slider-label">{label}</span>
      <span className="range-slider-value">{value}{unit}</span>
    </div>
    <input
      type="range"
      min={min}
      max={max}
      value={value}
      onChange={(e) => onChange(parseInt(e.target.value))}
      className="range-slider"
    />
  </div>
);

// Select Dropdown Component
const SelectDropdown = ({ value, onChange, options, label }) => (
  <div className="select-container">
    {label && <label className="select-label">{label}</label>}
    <div className="select-wrapper">
      <select value={value} onChange={(e) => onChange(e.target.value)} className="select-input">
        {options.map(opt => (
          <option key={opt.value} value={opt.value}>{opt.label}</option>
        ))}
      </select>
      <svg className="select-arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <polyline points="6 9 12 15 18 9"/>
      </svg>
    </div>
  </div>
);

// Select Row with Arrow (Discord-style: label, value, > indicator)
function SelectRowWithArrow({ value, onChange, options, label }) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef(null);

  const selectedOption = options.find(o => o.value === value) || options[0];
  const displayLabel = selectedOption?.label ?? value;

  useEffect(() => {
    if (!open) return;
    const handleClickOutside = (e) => {
      if (containerRef.current && !containerRef.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [open]);

  return (
    <div className="select-row-with-arrow" ref={containerRef}>
      <button
        type="button"
        className="select-row-with-arrow-trigger"
        onClick={() => setOpen(!open)}
      >
        <div className="select-row-with-arrow-info">
          <span className="select-row-with-arrow-label">{label}</span>
          <span className="select-row-with-arrow-value">{displayLabel}</span>
        </div>
        <svg className="select-row-with-arrow-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <polyline points="9 18 15 12 9 6"/>
        </svg>
      </button>
      {open && (
        <div className="select-row-with-arrow-dropdown">
          {options.map(opt => (
            <button
              key={opt.value}
              type="button"
              className={`select-row-with-arrow-option ${opt.value === value ? 'selected' : ''}`}
              onClick={() => { onChange(opt.value); setOpen(false); }}
            >
              {opt.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// Settings Item Row
const SettingsRow = ({ label, description, children }) => (
  <div className="settings-row">
    <div className="settings-row-info">
      <span className="settings-row-label">{label}</span>
      {description && <span className="settings-row-description">{description}</span>}
    </div>
    <div className="settings-row-control">
      {children}
    </div>
  </div>
);

// Settings Divider
const SettingsDivider = ({ title }) => (
  <div className="settings-divider">
    {title && <span className="settings-divider-title">{title}</span>}
    <div className="settings-divider-line" />
  </div>
);

export default function Settings() {
  const { user, logout, updateUser } = useAuth();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { notify } = useNotification();
  const { settings: globalSettings, updateSetting: updateGlobalSetting, updateSettings: updateGlobalSettings, loading: loadingGlobalSettings } = useSettings();
  const { playNotification } = useSounds();
  const { t, languages: availableLanguages, changeLanguage, formatDate } = useLanguage();
  
  // Get translated categories
  const SETTINGS_CATEGORIES = useMemo(() => getSettingsCategories(t), [t]);
  
  // Active section state
  const [activeSection, setActiveSection] = useState('account');
  
  // Loading states
  const [loadingProfile, setLoadingProfile] = useState(true);
  const [savingSettings, setSavingSettings] = useState(false);
  
  // Profile states
  const [profile, setProfile] = useState(null);
  const [displayName, setDisplayName] = useState('');
  const [statusMessage, setStatusMessage] = useState('');
  const [aboutMe, setAboutMe] = useState('');
  const [phone, setPhone] = useState('');
  const [username, setUsername] = useState('');
  const [bannerColor, setBannerColor] = useState('#ffffff');
  const [bannerColor2, setBannerColor2] = useState('');
  const [bannerUrl, setBannerUrl] = useState('');
  const [bannerPosition, setBannerPosition] = useState('center');
  const [hasNitro, setHasNitro] = useState(false);
  const [uploadingBanner, setUploadingBanner] = useState(false);
  const bannerInputRef = useRef(null);
  const [originalProfile, setOriginalProfile] = useState(null);
  const [unsavedBarShake, setUnsavedBarShake] = useState(false);
  const [saveBarExiting, setSaveBarExiting] = useState(false);
  const [saveBarExitReason, setSaveBarExitReason] = useState(null); // 'saved' | 'reverted'
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [passwordChangeMfaCode, setPasswordChangeMfaCode] = useState('');
  const [mfaSetupData, setMfaSetupData] = useState(null);
  const [mfaEnableCode, setMfaEnableCode] = useState('');
  const [mfaEnabling, setMfaEnabling] = useState(false);
  const [showMfaDisableModal, setShowMfaDisableModal] = useState(false);
  const [mfaDisableCode, setMfaDisableCode] = useState('');
  const [mfaDisabling, setMfaDisabling] = useState(false);
  const [backupCodesInfo, setBackupCodesInfo] = useState(null); // { total, remaining }
  const [shownBackupCodes, setShownBackupCodes] = useState(null); // array of plaintext codes
  const [showRegenModal, setShowRegenModal] = useState(false);
  const [regenCode, setRegenCode] = useState('');
  const [regenLoading, setRegenLoading] = useState(false);
  
  // Email/Username/Password change modals
  const [showEmailModal, setShowEmailModal] = useState(false);
  const [showUsernameModal, setShowUsernameModal] = useState(false);
  const [showPhoneModal, setShowPhoneModal] = useState(false);
  const [showPasswordModal, setShowPasswordModal] = useState(false);
  const [emailChangeStep, setEmailChangeStep] = useState('form'); // 'form' | 'mfa' when 2FA enabled - form first, then mfa
  const [passwordChangeStep, setPasswordChangeStep] = useState('form'); // same
  const [newEmail, setNewEmail] = useState('');
  const [emailPassword, setEmailPassword] = useState('');
  const [emailChangeMfaCode, setEmailChangeMfaCode] = useState('');
  const [newUsername, setNewUsername] = useState('');
  const [selectedPhoneCountry, setSelectedPhoneCountry] = useState(DEFAULT_PHONE_COUNTRY);
  const [localPhoneNumber, setLocalPhoneNumber] = useState('');
  const [countryPickerOpen, setCountryPickerOpen] = useState(false);
  const [countryPickerQuery, setCountryPickerQuery] = useState('');
  
  // Profile photo
  const [selectedAvatar, setSelectedAvatar] = useState(null);
  const [uploadingAvatar, setUploadingAvatar] = useState(false);
  const [cropFile, setCropFile] = useState(null);
  const avatarInputRef = useRef(null);
  
  // Use global settings from context (settings are managed globally now)
  const allSettings = globalSettings;
  
  // Audio devices hook
  const {
    inputDevices,
    outputDevices,
    permissionGranted: audioPermissionGranted,
    micLevel,
    requestPermission: requestAudioPermission,
    startMicTest,
    stopMicTest,
    playTestSound,
  } = useAudioDevices(allSettings);

  const [micTesting, setMicTesting] = useState(false);

  const { supported: pushSupported, permission: pushPermission, subscribed: pushSubscribed, subscribe: subscribePush, unsubscribe: unsubscribePush } = usePushNotifications(allSettings?.enable_notifications);
  const [pushLoading, setPushLoading] = useState(false);
  
  // Activity log
  const [activityLog, setActivityLog] = useState([]);
  const [loadingActivity, setLoadingActivity] = useState(false);
  
  // Connections (Spotify, etc.)
  const [connections, setConnections] = useState([]);
  const [loadingConnections, setLoadingConnections] = useState(false);
  const [connectingSpotify, setConnectingSpotify] = useState(false);
  
  // Blocked users
  const [blockedList, setBlockedList] = useState([]);
  const [loadingBlocked, setLoadingBlocked] = useState(false);
  
  // Sticker packs
  const [stickerPacks, setStickerPacks] = useState([]);
  const [loadingStickerPacks, setLoadingStickerPacks] = useState(false);
  const [userTeams, setUserTeams] = useState([]);
  const [selectedPack, setSelectedPack] = useState(null);
  const [showCreatePackModal, setShowCreatePackModal] = useState(false);
  const [showAddStickerModal, setShowAddStickerModal] = useState(false);
  const [newPackName, setNewPackName] = useState('');
  const [newPackDescription, setNewPackDescription] = useState('');
  const [newPackTeam, setNewPackTeam] = useState('');
  const [newPackCover, setNewPackCover] = useState(null);
  const [newStickerName, setNewStickerName] = useState('');
  const [newStickerFile, setNewStickerFile] = useState(null);
  const [newStickerPreview, setNewStickerPreview] = useState(null);
  const [deletePackConfirm, setDeletePackConfirm] = useState(null);
  const [deleteStickerConfirm, setDeleteStickerConfirm] = useState(null);
  const stickerFileInputRef = useRef(null);
  const coverFileInputRef = useRef(null);
  
  // UI states
  const [saving, setSaving] = useState(false);
  const savingInProgressRef = useRef(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [deleteAccountPassword, setDeleteAccountPassword] = useState('');
  const [deleteAccountLoading, setDeleteAccountLoading] = useState(false);
  const [pendingToPersist, setPendingToPersist] = useState({});
  const [exportingData, setExportingData] = useState(false);
  const phoneCountryPickerRef = useRef(null);
  
  // Search state
  const [searchQuery, setSearchQuery] = useState('');
  
  // Electron: launch at startup
  const [launchAtStartup, setLaunchAtStartup] = useState(false);
  // Electron: minimize to system tray on close
  const [minimizeToTray, setMinimizeToTray] = useState(false);
  
  // Debounced settings for auto-save
  const debouncedSettings = useDebounce(allSettings, 300);
  
  // Debounced password comparison (only show mismatch after 2s without typing)
  const debouncedNewPassword = useDebounce(newPassword, 2000);
  const debouncedConfirmPassword = useDebounce(confirmPassword, 2000);
  const hasSettled = newPassword === debouncedNewPassword && confirmPassword === debouncedConfirmPassword;
  const passwordsMatchError = hasSettled && debouncedConfirmPassword && newPassword !== confirmPassword;
  const settingsInitialized = useRef(false);
  
  // Settings are now loaded from SettingsContext
  useEffect(() => {
    if (!loadingGlobalSettings) {
      settingsInitialized.current = true;
    }
  }, [loadingGlobalSettings]);
  
  // Electron: load launch at startup setting
  useEffect(() => {
    if (typeof window !== 'undefined' && window.electron?.getLaunchAtStartup) {
      window.electron.getLaunchAtStartup().then(setLaunchAtStartup);
    }
  }, []);

  // Electron: load minimize to tray setting
  useEffect(() => {
    if (typeof window !== 'undefined' && window.electron?.getMinimizeToTray) {
      window.electron.getMinimizeToTray().then(setMinimizeToTray);
    }
  }, []);
  
  // Seed from AuthContext user immediately so we show something without waiting for profile API
  useEffect(() => {
    if (!user?.id) return;
    const u = user;
    setDisplayName(prev => prev || sanitizeLegacyDisplayName(u.display_name, u.username || u.email?.split('@')[0]));
    setUsername(prev => prev || u.username || u.email?.split('@')[0] || '');
    setPhone(prev => prev || u.phone || '');
    setSelectedAvatar(prev => prev ?? u.avatar_url);
    setProfile(prev => prev || {
      display_name: u.display_name,
      username: u.username || u.email?.split('@')[0],
      email: u.email,
      phone: u.phone,
      avatar_url: u.avatar_url,
    });
    setLoadingProfile(false); // Show content immediately when we have user data
  }, [user?.id]);

  // Load profile from backend – only when user id changes (login/switch), not on profile field updates.
  // We intentionally exclude `user` from deps so edits stay visible until save; re-fetching on `user` change
  // would overwrite in-progress edits with stale backend data.
  useEffect(() => {
    if (!user?.id) {
      setLoadingProfile(false);
      return;
    }
    let cancelled = false;
    const currentUser = user;
    const loadProfile = async () => {
      try {
        const data = await settingsApi.getProfile();
        if (cancelled) return;
        setProfile(data);
        setDisplayName(sanitizeLegacyDisplayName(data.display_name, data.username || data.email?.split('@')[0]));
        setStatusMessage(data.status_message || '');
        setAboutMe(data.about_me || '');
        setPhone(data.phone || '');
        setUsername(data.username || data.email?.split('@')[0] || '');
        setBannerColor(data.banner_color || '#ffffff');
        const normalizedSecondary = normalizeOptionalColor(data.banner_color_2);
        setBannerColor2(normalizedSecondary);
        setBannerUrl(data.banner_url || '');
        setBannerPosition(data.banner_position || 'center');
        setHasNitro(!!data.has_nitro);
        setSelectedAvatar(data.avatar_url);
        setOriginalProfile({
          displayName: sanitizeLegacyDisplayName(data.display_name, data.username || data.email?.split('@')[0]),
          statusMessage: data.status_message || '',
          aboutMe: data.about_me || '',
          bannerColor: data.banner_color || '#ffffff',
          bannerColor2: normalizedSecondary,
          bannerUrl: data.banner_url || '',
          bannerPosition: data.banner_position || 'center',
          avatarUrl: data.avatar_url,
          username: data.username || data.email?.split('@')[0] || '',
          phone: data.phone || '',
          email: data.email,
        });
      } catch (err) {
        if (cancelled) return;
        console.error('Error loading profile:', err);
        // Fallback to user context so username, email, etc. still show
        if (currentUser) {
          setDisplayName(u => u || sanitizeLegacyDisplayName(currentUser.display_name, currentUser.username || currentUser.email?.split('@')[0]));
          setStatusMessage(u => u || currentUser.status_message || '');
          setUsername(u => u || currentUser.username || currentUser.email?.split('@')[0] || '');
          setPhone(u => u || currentUser.phone || '');
          setSelectedAvatar(a => a ?? currentUser.avatar_url);
          setProfile(p => p || {
            display_name: currentUser.display_name,
            username: currentUser.username || currentUser.email?.split('@')[0],
            email: currentUser.email,
            phone: currentUser.phone,
            avatar_url: currentUser.avatar_url,
          });
          setOriginalProfile(prev => prev || {
            displayName: sanitizeLegacyDisplayName(currentUser.display_name, currentUser.username || currentUser.email?.split('@')[0]),
            statusMessage: currentUser.status_message || '',
            aboutMe: '',
            bannerColor: '#ffffff',
            bannerColor2: '',
            bannerUrl: '',
            bannerPosition: 'center',
            avatarUrl: currentUser.avatar_url,
            username: currentUser.username || currentUser.email?.split('@')[0] || '',
            phone: currentUser.phone || '',
            email: currentUser.email,
          });
        }
      } finally {
        if (!cancelled) setLoadingProfile(false);
      }
    };
    loadProfile();
    return () => { cancelled = true; };
  }, [user?.id]); // eslint-disable-line react-hooks/exhaustive-deps -- only load on user id change to preserve in-progress edits
  
  // Auto-save settings when they change (after initial load)
  useEffect(() => {
    if (!settingsInitialized.current || loadingGlobalSettings) return;
    
    const saveSettings = async () => {
      try {
        setSavingSettings(true);
        await settingsApi.update(debouncedSettings);
      } catch (err) {
        console.error('Error saving settings:', err);
        notify.error(err?.message || t('errors.generic') || 'Failed to save settings');
      } finally {
        setSavingSettings(false);
      }
    };
    
    saveSettings();
  }, [debouncedSettings, loadingGlobalSettings, notify, t]);
  
  // Helper function to update a single setting (updates context + triggers save)
  const updateSetting = useCallback((key, value) => {
    updateGlobalSetting(key, value);
  }, [updateGlobalSetting]);
  
  // Load activity log when viewing that section
  useEffect(() => {
    if (activeSection === 'activity' && activityLog.length === 0 && !loadingActivity) {
      setLoadingActivity(true);
      settingsApi.getActivity()
        .then(setActivityLog)
        .catch(console.error)
        .finally(() => setLoadingActivity(false));
    }
  }, [activeSection, activityLog.length, loadingActivity]);
  
  // Open section from URL (?section=connections etc.)
  useEffect(() => {
    const section = searchParams.get('section');
    if (section && SETTINGS_CATEGORIES.some(cat => cat.items?.some(i => i.id === section))) {
      setActiveSection(section);
    }
  }, [searchParams.get('section')]); // eslint-disable-line react-hooks/exhaustive-deps

  // Handle Spotify OAuth callback from URL (?spotify=connected or ?spotify=error)
  useEffect(() => {
    const spotify = searchParams.get('spotify');
    if (!spotify) return;
    setActiveSection('connections');
    const next = new URLSearchParams(searchParams);
    next.delete('spotify');
    next.delete('reason');
    setSearchParams(next, { replace: true });
    if (spotify === 'connected') {
      notify.success(t('connections.spotifyConnected') || 'Spotify connected!');
      settingsApi.getConnections().then(list => setConnections(list || []));
    } else if (spotify === 'error') {
      const reason = searchParams.get('reason') || 'unknown';
      notify.error(reason === 'not_configured' ? 'Spotify is not configured on this server.' : `Spotify connection failed: ${reason}`);
    }
  }, [searchParams]); // eslint-disable-line react-hooks/exhaustive-deps

  // Load connections when viewing that section
  useEffect(() => {
    if (activeSection === 'connections') {
      setLoadingConnections(true);
      settingsApi.getConnections()
        .then(list => setConnections(list || []))
        .catch(() => setConnections([]))
        .finally(() => setLoadingConnections(false));
    }
  }, [activeSection]);

  // Load blocked users when viewing that section
  useEffect(() => {
    if (activeSection === 'blocked' && !loadingBlocked) {
      setLoadingBlocked(true);
      friendsApi.blocked()
        .then(list => setBlockedList(list || []))
        .catch(() => setBlockedList([]))
        .finally(() => setLoadingBlocked(false));
    }
  }, [activeSection]);
  
  // Load sticker packs and teams when viewing that section
  useEffect(() => {
    if (activeSection === 'stickers' && !loadingStickerPacks) {
      setLoadingStickerPacks(true);
      Promise.all([
        stickersApi.getPacks(),
        teamsApi.list()
      ])
        .then(([packs, teams]) => {
          setStickerPacks(packs);
          setUserTeams(teams);
          if (teams.length > 0 && !newPackTeam) {
            setNewPackTeam(teams[0].id.toString());
          }
        })
        .catch(console.error)
        .finally(() => setLoadingStickerPacks(false));
    }
  }, [activeSection]);
  

  /* Harmonize colors when both selected so any pair produces a pleasing gradient */
  const normalizedBannerColor2 = normalizeOptionalColor(bannerColor2);
  const hasDualBanner = !!normalizedBannerColor2;
  const hasBannerImage = !!bannerUrl;
  const useAdaptiveContrastText = hasDualBanner && !hasBannerImage;
  const [c1, c2]      = hasDualBanner ? harmonizeGradientColors(bannerColor, normalizedBannerColor2 || '#000') : [bannerColor, '#000'];
  /* Banner: image when present, otherwise single color or dual-color gradient */
  const verticalGrad = (a, b) => `linear-gradient(180deg, ${a} 0%, ${a} 12%, ${b} 88%, ${b} 100%)`;
  const getBannerStyle = () => {
    if (bannerUrl) {
      const url = bannerUrl.startsWith('http') || bannerUrl.startsWith('blob:') || bannerUrl.startsWith('data:')
        ? bannerUrl
        : (BACKEND_ORIGIN + bannerUrl);
      const posMap = { top: 'center top', center: 'center center', bottom: 'center bottom' };
      return {
        backgroundImage: `url(${url})`,
        backgroundSize: 'cover',
        backgroundPosition: posMap[bannerPosition] || 'center center',
        backgroundRepeat: 'no-repeat',
      };
    }
    if (hasDualBanner) return { backgroundImage: verticalGrad(c1, c2) };
    return { backgroundColor: c1 };
  };
  /* Whole card gradient + gradient border when both colors enabled */
  const borderGrad   = verticalGrad(c1, c2);
  const innerGrad    = verticalGrad(lightenHex(c1), lightenHex(c2));
  const isHighContrast = useAdaptiveContrastText && isHighContrastGradient(bannerColor, normalizedBannerColor2 || '#000');
  const isLight = useAdaptiveContrastText && !isHighContrast && isLightGradient(bannerColor, normalizedBannerColor2 || '#000');
  const previewCardStyle = hasDualBanner
    ? {
        backgroundImage: `${innerGrad}, ${borderGrad}`,
        backgroundOrigin: 'padding-box, border-box',
        backgroundClip: 'padding-box, border-box',
        border: '5px solid transparent',
        borderRadius: '8px',
      }
    : undefined;
  const previewBannerStyle = getBannerStyle();
  const hasRealHandle = !!(username || user?.email?.split('@')[0]);
  const previewUsername = hasRealHandle
    ? stripTrailingLegacyZero(String(username || user?.email?.split('@')[0]).replace(/(\s+|#)0*\s*$/, '').replace(/(?<![0-9])0\s*$/, '').trim())
    : null;
  const previewJoinDate = user?.created_at
    ? new Date(user.created_at).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' })
    : t('common.unknown');
  const previewPresence = getStoredOnlineStatus(user?.id);
  const previewStatusColor = { online: '#23a55a', idle: '#f0b232', dnd: '#f23f43', invisible: '#80848e', offline: '#80848e' }[previewPresence] || '#80848e';

  const renderProfilePreviewCard = (extraClassName = '') => (
    <div className={`profile-card-popup profile-card-preview-inline${hasDualBanner ? ' profile-card-popup--dual-banner' : ''}${isHighContrast ? ' profile-card-popup--high-contrast-gradient' : ''}${isLight ? ' profile-card-popup--light-gradient' : ''}${extraClassName ? ` ${extraClassName}` : ''}`} style={previewCardStyle}>
      <div className={`profile-card-banner${previewBannerStyle.backgroundImage ? ' profile-card-banner--tall' : ''}`} style={previewBannerStyle} />
      <div className="profile-card-avatar-row">
        <div className={`profile-card-avatar-wrapper${hasDualBanner ? ' profile-card-avatar-wrapper--gradient' : ''}`}>
          <Avatar user={{ ...user, avatar_url: selectedAvatar }} size="xlarge" />
          <div className="profile-card-status-badge-wrap" style={{ background: previewStatusColor }} />
        </div>
      </div>
      <div className="profile-card-scroll">
        <div className="profile-card-content">
          <div className="profile-card-body">
            <div className="profile-card-identity">
              <h2 className="profile-card-displayname">
                {displayName || t('chat.user')}
                {Boolean(profile?.has_nitro) && <span className="profile-card-nitro-badge">Nitro</span>}
              </h2>
              <div className="profile-card-tag-row">
                {previewUsername ? (
                  <span className="profile-card-username">@{previewUsername}</span>
                ) : (
                  <span className="profile-card-username profile-card-username--muted">{t('profile.noHandleSet')}</span>
                )}
              </div>
            </div>
            {statusMessage && (
              <div className="profile-card-status-msg">{statusMessage}</div>
            )}
            <hr className="profile-card-divider" />
            {aboutMe && (
              <div className="profile-card-section">
                <h3 className="profile-card-section-title">{t('profile.aboutMe')}</h3>
                <p className="profile-card-section-content">{aboutMe}</p>
              </div>
            )}
            <div className="profile-card-section">
              <h3 className="profile-card-section-title">{t('profile.memberSince')}</h3>
              <p className="profile-card-section-content">{previewJoinDate}</p>
            </div>
            <div className="profile-card-message-wrap" aria-hidden="true" style={{ pointerEvents: 'none' }}>
              <input
                type="text"
                className="profile-card-message-input"
                placeholder={previewUsername ? `${t('friends.message')} @${previewUsername}` : `${t('friends.message')} ${displayName || t('chat.user')}`}
                readOnly
                tabIndex={-1}
              />
              <span className="profile-card-message-emoji" aria-hidden="true">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <circle cx="12" cy="12" r="10"/>
                  <path d="M8 14s1.5 2 4 2 4-2 4-2"/>
                  <line x1="9" y1="9" x2="9.01" y2="9"/>
                  <line x1="15" y1="9" x2="15.01" y2="9"/>
                </svg>
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );

  const handleUploadBanner = (e) => {
    const file = e?.target?.files?.[0];
    if (!file) return;
    const previewUrl = URL.createObjectURL(file);
    setBannerUrl(previewUrl);
    setProfile(p => (p ? { ...p, banner_url: previewUrl } : null));
    setPendingToPersist(p => ({ ...p, banner: { file, previewUrl } }));
    if (bannerInputRef.current) bannerInputRef.current.value = '';
  };

  const handleRemoveBanner = () => {
    setPendingToPersist(p => {
      if (p.banner?.previewUrl) URL.revokeObjectURL(p.banner.previewUrl);
      const { banner, ...rest } = p;
      return { ...rest, bannerRemove: true };
    });
    setBannerUrl('');
    setProfile(p => (p ? { ...p, banner_url: null } : null));
  };
  
  // Email change – applique visuellement, barre du bas force la sauvegarde
  const stageEmailChange = () => {
    const has2FA = profile?.totp_enabled ?? user?.totp_enabled;
    if (!newEmail) {
      notify.error(t('errors.fillAllFields'));
      return;
    }
    if (has2FA && emailChangeMfaCode.replace(/\D/g, '').length < 6) {
      notify.error(t('account.mfaCodeRequired'));
      return;
    }
    if (!has2FA && !emailPassword) {
      notify.error(t('errors.fillAllFields'));
      return;
    }
    setProfile(prev => (prev ? { ...prev, email: newEmail } : null));
    updateUser?.({ ...user, email: newEmail });
    setPendingToPersist(p => ({
      ...p,
      email: { newEmail, emailPassword, emailChangeMfaCode: has2FA ? emailChangeMfaCode.replace(/\s/g, '') : undefined },
    }));
    setShowEmailModal(false);
    setNewEmail('');
    setEmailPassword('');
    setEmailChangeMfaCode('');
    setEmailChangeStep('form');
  };
  
  // Username change – applique visuellement, barre du bas force la sauvegarde
  const stageUsernameChange = (e) => {
    e.preventDefault();
    if (!newUsername || newUsername.length < 3) {
      notify.error(t('errors.usernameMinLength'));
      return;
    }
    const un = newUsername.trim().toLowerCase();
    setUsername(un);
    updateUser?.({ username: un });
    setPendingToPersist(p => ({ ...p, username: un }));
    setShowUsernameModal(false);
    setNewUsername('');
  };
  
  // Phone change – applique visuellement, barre du bas force la sauvegarde
  const stagePhoneChange = () => {
    const sanitizedLocalNumber = localPhoneNumber.trim().replace(/\s+/g, ' ');
    const ph = sanitizedLocalNumber ? `${selectedPhoneCountry.dialCode} ${sanitizedLocalNumber}` : '';
    setPhone(ph || '');
    setProfile(prev => (prev ? { ...prev, phone: ph || null } : null));
    setPendingToPersist(p => ({ ...p, phone: ph || null }));
    setShowPhoneModal(false);
    setLocalPhoneNumber('');
    setCountryPickerOpen(false);
    setCountryPickerQuery('');
  };

  const openPhoneModal = useCallback(() => {
    const { country, localNumber } = splitPhoneByCountry(phone);
    setSelectedPhoneCountry(country);
    setLocalPhoneNumber(formatPhoneLocalInput(localNumber, country.iso2));
    setCountryPickerOpen(false);
    setCountryPickerQuery('');
    setShowPhoneModal(true);
  }, [phone]);

  const filteredPhoneCountries = useMemo(() => {
    const query = countryPickerQuery.trim().toLowerCase();
    if (!query) return PHONE_COUNTRIES;
    return PHONE_COUNTRIES.filter((country) => (
      country.name.toLowerCase().includes(query)
      || country.dialCode.includes(query)
      || country.iso2.toLowerCase().includes(query)
    ));
  }, [countryPickerQuery]);

  useEffect(() => {
    if (!countryPickerOpen) return undefined;
    const closePickerOnOutsideClick = (event) => {
      if (phoneCountryPickerRef.current && !phoneCountryPickerRef.current.contains(event.target)) {
        setCountryPickerOpen(false);
      }
    };
    document.addEventListener('mousedown', closePickerOnOutsideClick);
    return () => document.removeEventListener('mousedown', closePickerOnOutsideClick);
  }, [countryPickerOpen]);

  // Sauvegarde tout depuis la barre du bas (profil + pendingToPersist)
  const hasUnsavedChanges = useMemo(() => {
    if (!originalProfile) return false;
    return (
      displayName !== originalProfile.displayName ||
      statusMessage !== originalProfile.statusMessage ||
      aboutMe !== originalProfile.aboutMe ||
      bannerColor !== originalProfile.bannerColor ||
      normalizeOptionalColor(bannerColor2) !== normalizeOptionalColor(originalProfile.bannerColor2 || '') ||
      bannerPosition !== (originalProfile.bannerPosition || 'center')
    );
  }, [displayName, statusMessage, aboutMe, bannerColor, bannerColor2, bannerPosition, originalProfile]);

  const hasAnyUnsavedChanges = hasUnsavedChanges || Object.keys(pendingToPersist).length > 0;
  const previousHasAnyUnsavedChangesRef = useRef(false);

  useEffect(() => {
    const hadUnsavedChanges = previousHasAnyUnsavedChangesRef.current;

    // User manually reverted changes: animate the bar out as well.
    if (hadUnsavedChanges && !hasAnyUnsavedChanges && !saveBarExiting && !saving) {
      setSaveBarExitReason('reverted');
      setSaveBarExiting(true);
    }

    previousHasAnyUnsavedChangesRef.current = hasAnyUnsavedChanges;
  }, [hasAnyUnsavedChanges, saveBarExiting, saving]);

  const handleSaveAll = useCallback(async () => {
    if (!hasAnyUnsavedChanges) return;
    if (savingInProgressRef.current) return;
    savingInProgressRef.current = true;
    setSaving(true);
    try {
      const ptp = { ...pendingToPersist };

      const emailData = ptp.email;
      if (emailData && typeof emailData === 'object' && emailData.newEmail) {
        const has2FA = profile?.totp_enabled ?? user?.totp_enabled;
        await settingsApi.changeEmail(emailData.newEmail, has2FA ? undefined : emailData.emailPassword, emailData.emailChangeMfaCode);
        setOriginalProfile(prev => ({ ...prev, email: emailData.newEmail }));
        delete ptp.email;
      }
      if (ptp.password) {
        const has2FA = profile?.totp_enabled ?? user?.totp_enabled;
        const payload = has2FA ? { newPassword: ptp.password.newPassword, mfaCode: ptp.password.mfaCode } : { currentPassword: ptp.password.currentPassword, newPassword: ptp.password.newPassword };
        await auth.updateMe(payload);
        setCurrentPassword('');
        setNewPassword('');
        setConfirmPassword('');
        setPasswordChangeMfaCode('');
        setPasswordChangeStep('form');
        delete ptp.password;
      }
      if (ptp.username !== undefined) {
        const updated = await settingsApi.updateProfile({ username: ptp.username });
        setProfile(updated);
        setOriginalProfile(prev => ({ ...prev, username: ptp.username }));
        delete ptp.username;
      }
      if ('phone' in ptp) {
        const updated = await settingsApi.updateProfile({ phone: ptp.phone });
        setProfile(updated);
        setPhone(updated.phone || '');
        setOriginalProfile(prev => ({ ...prev, phone: updated.phone || '' }));
        delete ptp.phone;
      }
      if (hasUnsavedChanges) {
        const payload = {
          displayName: displayName.trim(),
          statusMessage: statusMessage.trim() || null,
          aboutMe: aboutMe.trim() || null,
          bannerColor,
          bannerColor2: normalizeOptionalColor(bannerColor2) || null,
          bannerPosition,
        };
        const updated = await settingsApi.updateProfile(payload);
        setProfile(updated);
        const normalizedUpdatedSecondary = normalizeOptionalColor(updated.banner_color_2);
        setBannerColor2(normalizedUpdatedSecondary);
        const authUpdate = {
          display_name: updated.display_name,
          status_message: updated.status_message ?? null,
          // Keep auth context in sync so banner gradients render immediately.
          banner_color_2: normalizedUpdatedSecondary || null,
          banner_position: updated.banner_position || 'center',
        };
        if (updated.username != null) authUpdate.username = updated.username;
        if (updated.avatar_url != null) authUpdate.avatar_url = updated.avatar_url;
        if (updated.banner_color != null) authUpdate.banner_color = updated.banner_color;
        if (updated.banner_url != null) authUpdate.banner_url = updated.banner_url;
        updateUser?.(authUpdate);
        if (user?.id) invalidateProfile(user.id);
        setOriginalProfile(prev => ({
          ...prev,
          displayName,
          statusMessage,
          aboutMe,
          bannerColor,
          bannerColor2: normalizedUpdatedSecondary,
          bannerPosition,
        }));
      }
      if (ptp.avatar) {
        const { avatars } = await import('../api');
        const result = await avatars.upload(ptp.avatar.blob, ptp.avatar.cropParams);
        if (ptp.avatar.previewUrl) URL.revokeObjectURL(ptp.avatar.previewUrl);
        setSelectedAvatar(result.avatar_url);
        updateUser?.({ avatar_url: result.avatar_url });
        setOriginalProfile(prev => ({ ...prev, avatarUrl: result.avatar_url }));
        if (user?.id) invalidateProfile(user.id);
        delete ptp.avatar;
      }
      if (ptp.bannerRemove) {
        const { avatars } = await import('../api');
        await avatars.deleteBanner();
        setBannerUrl('');
        setProfile(p => (p ? { ...p, banner_url: null } : null));
        updateUser?.({ banner_url: null });
        setOriginalProfile(prev => ({ ...prev, bannerUrl: '' }));
        if (user?.id) invalidateProfile(user.id);
        delete ptp.bannerRemove;
        delete ptp.banner;
      } else if (ptp.banner) {
        const { avatars } = await import('../api');
        const file = ptp.banner.file || ptp.banner;
        const { banner_url } = await avatars.uploadBanner(file);
        if (ptp.banner.previewUrl) URL.revokeObjectURL(ptp.banner.previewUrl);
        setBannerUrl(banner_url);
        setProfile(p => (p ? { ...p, banner_url } : null));
        updateUser?.({ banner_url });
        setOriginalProfile(prev => ({ ...prev, bannerUrl: banner_url }));
        if (user?.id) invalidateProfile(user.id);
        if (bannerInputRef.current) bannerInputRef.current.value = '';
        delete ptp.banner;
      }

      setPendingToPersist(ptp);
      notify.success(t('success.profileUpdated'));
      setSaveBarExitReason('saved');
      setSaveBarExiting(true);
    } catch (err) {
      notify.error(err.message || t('errors.generic'));
    } finally {
      savingInProgressRef.current = false;
      setSaving(false);
    }
  }, [hasAnyUnsavedChanges, hasUnsavedChanges, pendingToPersist, displayName, statusMessage, aboutMe, bannerColor, bannerColor2, bannerPosition, originalProfile, profile?.totp_enabled, user, updateUser, notify, t]);
  
  // Reset settings handler
  const handleResetSettings = async () => {
    try {
      const defaults = await settingsApi.reset();
      updateGlobalSettings(defaults);
      notify.success(t('success.settingsReset'));
    } catch (err) {
      notify.error(err.message || t('errors.generic'));
    }
  };
  
  // Clear cache handler
  const handleClearCache = async () => {
    try {
      await settingsApi.clearCache();
      notify.success(t('success.cacheCleared'));
    } catch (err) {
      notify.error(err.message || t('errors.generic'));
    }
  };
  
  const handleUploadAvatar = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!/^image\/(jpeg|png|gif|webp)$/.test(file.type)) {
      notify.error(t('errors.invalidImageType') || 'Format invalide (JPG, PNG, GIF ou WebP)');
      return;
    }
    if (file.size > 8 * 1024 * 1024) {
      notify.error(t('errors.imageTooBig') || 'Image trop volumineuse (max 8 Mo)');
      return;
    }
    setCropFile(file);
    e.target.value = '';
  };

  const handleResetAvatar = async () => {
    const defaultUrl = '/avatars/default.png';
    const previousAvatar = selectedAvatar;
    setSelectedAvatar(defaultUrl);
    try {
      const result = await avatarsApi.reset();
      updateUser?.({ ...user, avatar_url: result.avatar_url });
      notify.success(t('success.avatarReset'));
    } catch (err) {
      setSelectedAvatar(previousAvatar);
      notify.error(err.message || t('errors.generic'));
    }
  };

  const handleCropConfirm = (blob, cropParams) => {
    setCropFile(null);
    let uploadFile;
    if (blob instanceof File) {
      uploadFile = blob;
    } else {
      const ext = blob.type === 'image/gif' ? '.gif' : blob.type === 'image/png' ? '.png' : blob.type === 'image/webp' ? '.webp' : '.jpg';
      uploadFile = new File([blob], `avatar${ext}`, { type: blob.type });
    }
    const previewUrl = URL.createObjectURL(uploadFile);
    setSelectedAvatar(previewUrl);
    setPendingToPersist(p => ({ ...p, avatar: { blob: uploadFile, cropParams, previewUrl } }));
  };

  // Password validation
  const passwordValidation = useMemo(() => {
    if (!newPassword) return null;
    return validatePassword(newPassword);
  }, [newPassword]);

  // Password change – barre du bas force la sauvegarde
  const stagePasswordChange = () => {
    if (!passwordValidation?.valid) {
      notify.error(passwordValidation?.message || t('errors.invalidPassword'));
      return;
    }
    if (newPassword !== confirmPassword) {
      notify.error(t('account.passwordsNotMatch'));
      return;
    }
    const has2FA = profile?.totp_enabled ?? user?.totp_enabled;
    if (has2FA && passwordChangeMfaCode.replace(/\D/g, '').length < 6) {
      notify.error(t('account.mfaCodeRequired'));
      return;
    }
    setPendingToPersist(p => ({
      ...p,
      password: { newPassword, currentPassword, mfaCode: has2FA ? passwordChangeMfaCode.replace(/\s/g, '') : undefined },
    }));
    setShowPasswordModal(false);
    setCurrentPassword('');
    setNewPassword('');
    setConfirmPassword('');
    setPasswordChangeMfaCode('');
    setPasswordChangeStep('form');
  };
  
  const handleLogout = () => {
    logout();
    navigate('/login');
  };
  
  const handleDeleteAccount = () => {
    setShowDeleteConfirm(true);
  };

  const confirmDeleteAccount = async (e) => {
    e?.preventDefault();
    if (!deleteAccountPassword) {
      notify.error(t('account.passwordRequired') || 'Mot de passe requis');
      return;
    }
    setDeleteAccountLoading(true);
    try {
      await auth.deleteAccount(deleteAccountPassword);
      setShowDeleteConfirm(false);
      notify.success(t('success.accountDeleted') || 'Compte supprimé');
      logout();
      navigate('/login');
    } catch (err) {
      notify.error(err.message || t('errors.generic'));
    } finally {
      setDeleteAccountLoading(false);
    }
  };

  const handleExportData = async () => {
    setExportingData(true);
    try {
      const data = await settingsApi.exportData();
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `slide-export-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
      notify.success(t('account.exportSuccess'));
    } catch (err) {
      notify.error(err.message || t('account.exportError'));
    } finally {
      setExportingData(false);
    }
  };

  const handleMfaSetup = async () => {
    try {
      const { secret, otpauthUrl } = await auth.twoFactor.setup();
      const qrDataUrl = await QRCode.toDataURL(otpauthUrl, { width: 200, margin: 2 });
      setMfaSetupData({ secret, otpauthUrl, qrDataUrl });
      setMfaEnableCode('');
    } catch (err) {
      notify.error(err.message || t('errors.generic'));
    }
  };

  const handleMfaEnable = async (e) => {
    e?.preventDefault();
    if (!mfaEnableCode || mfaEnableCode.replace(/\D/g, '').length < 6) {
      notify.error(t('account.mfaCodeRequired'));
      return;
    }
    setMfaEnabling(true);
    try {
      const result = await auth.twoFactor.enable(mfaEnableCode.replace(/\s/g, ''));
      setMfaSetupData(null);
      setMfaEnableCode('');
      setProfile(p => p ? { ...p, totp_enabled: true } : null);
      updateUser?.({ totp_enabled: true });
      if (result?.backupCodes) {
        setShownBackupCodes(result.backupCodes);
        setBackupCodesInfo({ total: result.backupCodes.length, remaining: result.backupCodes.length });
      }
      notify.success(t('account.mfaEnabled'));
    } catch (err) {
      notify.error(err.message || t('account.mfaInvalidCode'));
    } finally {
      setMfaEnabling(false);
    }
  };

  // Auto-verify when 6 digits entered during 2FA setup (only on transition to 6, not on retry)
  const mfaCodeLenRef = useRef(0);
  useEffect(() => {
    if (!mfaSetupData || mfaEnabling) return;
    const code = mfaEnableCode.replace(/\D/g, '');
    const len = code.length;
    if (len === 6 && mfaCodeLenRef.current < 6) {
      mfaCodeLenRef.current = 6;
      handleMfaEnable();
    } else if (len < 6) {
      mfaCodeLenRef.current = len;
    }
  }, [mfaEnableCode, mfaSetupData, mfaEnabling]);

  const emailChangeMfaLenRef = useRef(0);
  const passwordChangeMfaLenRef = useRef(0);
  const mfaDisableCodeLenRef = useRef(0);

  // Auto-submit when 6 digits entered in email change MFA step
  useEffect(() => {
    if (!showEmailModal || emailChangeStep !== 'mfa' || !(profile?.totp_enabled ?? user?.totp_enabled) || saving) return;
    const code = emailChangeMfaCode.replace(/\D/g, '');
    const len = code.length;
    if (len === 6 && emailChangeMfaLenRef.current < 6) {
      emailChangeMfaLenRef.current = 6;
      stageEmailChange();
    } else if (len < 6) {
      emailChangeMfaLenRef.current = len;
    }
  }, [showEmailModal, emailChangeStep, emailChangeMfaCode, saving, profile?.totp_enabled, user?.totp_enabled]);

  // Auto-submit when 6 digits entered in password change MFA step
  useEffect(() => {
    if (!showPasswordModal || passwordChangeStep !== 'mfa' || !(profile?.totp_enabled ?? user?.totp_enabled) || saving) return;
    const code = passwordChangeMfaCode.replace(/\D/g, '');
    const len = code.length;
    if (len === 6 && passwordChangeMfaLenRef.current < 6) {
      passwordChangeMfaLenRef.current = 6;
      stagePasswordChange();
    } else if (len < 6) {
      passwordChangeMfaLenRef.current = len;
    }
  }, [showPasswordModal, passwordChangeStep, passwordChangeMfaCode, saving, profile?.totp_enabled, user?.totp_enabled]);

  // Auto-submit when 6 digits entered in disable 2FA modal
  useEffect(() => {
    if (!showMfaDisableModal || mfaDisabling) return;
    const code = mfaDisableCode.replace(/\D/g, '');
    const len = code.length;
    if (len === 6 && mfaDisableCodeLenRef.current < 6) {
      mfaDisableCodeLenRef.current = 6;
      handleMfaDisable();
    } else if (len < 6) {
      mfaDisableCodeLenRef.current = len;
    }
  }, [showMfaDisableModal, mfaDisableCode, mfaDisabling]);

  // Load backup codes info when 2FA is active
  useEffect(() => {
    const has2FA = profile?.totp_enabled ?? user?.totp_enabled;
    if (!has2FA || shownBackupCodes) return;
    auth.twoFactor.backupCodesInfo()
      .then(info => setBackupCodesInfo(info))
      .catch(() => {});
  }, [profile?.totp_enabled, user?.totp_enabled, shownBackupCodes]);

  const handleRegenBackupCodes = async (e) => {
    e?.preventDefault();
    if (!regenCode || regenCode.replace(/\D/g, '').length < 6) return;
    setRegenLoading(true);
    try {
      const result = await auth.twoFactor.regenerateBackupCodes(regenCode.replace(/\s/g, ''));
      setShownBackupCodes(result.backupCodes);
      setBackupCodesInfo({ total: result.backupCodes.length, remaining: result.backupCodes.length });
      setShowRegenModal(false);
      setRegenCode('');
      notify.success('Codes de récupération régénérés. Sauvegardez-les maintenant !');
    } catch (err) {
      notify.error(err.message || t('errors.generic'));
    } finally {
      setRegenLoading(false);
    }
  };

  const handleMfaDisable = async (e) => {
    e?.preventDefault();
    if (!mfaDisableCode || mfaDisableCode.replace(/\D/g, '').length < 6) {
      notify.error(t('account.mfaCodeRequired'));
      return;
    }
    setMfaDisabling(true);
    try {
      await auth.twoFactor.disable(mfaDisableCode.replace(/\s/g, ''));
      setShowMfaDisableModal(false);
      setMfaDisableCode('');
      setProfile(p => p ? { ...p, totp_enabled: false } : null);
      updateUser?.({ totp_enabled: false });
      setBackupCodesInfo(null);
      setShownBackupCodes(null);
      notify.success(t('account.mfaDisabled'));
    } catch (err) {
      notify.error(err.message || t('errors.generic'));
    } finally {
      setMfaDisabling(false);
    }
  };

  const handleClose = useCallback(() => {
    if (hasAnyUnsavedChanges) {
      setUnsavedBarShake(true);
      return;
    }
    navigate(-1);
  }, [navigate, hasAnyUnsavedChanges]);

  // Keyboard shortcut to close (Escape closes modals first, then settings)
  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.key === 'Escape') {
        // Close modals first before leaving settings
        if (showMfaDisableModal) {
          setShowMfaDisableModal(false);
          setMfaDisableCode('');
          return;
        }
        if (mfaSetupData) {
          setMfaSetupData(null);
          setMfaEnableCode('');
          return;
        }
        if (showCreatePackModal) {
          setShowCreatePackModal(false);
          return;
        }
        if (showAddStickerModal) {
          setShowAddStickerModal(false);
          return;
        }
        if (showEmailModal) {
          setShowEmailModal(false);
          setEmailChangeStep('form');
          setEmailPassword('');
          setEmailChangeMfaCode('');
          return;
        }
        if (showPasswordModal) {
          setShowPasswordModal(false);
          setPasswordChangeStep('form');
          setCurrentPassword('');
          setNewPassword('');
          setConfirmPassword('');
          setPasswordChangeMfaCode('');
          return;
        }
        if (showUsernameModal) {
          setShowUsernameModal(false);
          return;
        }
        if (showPhoneModal) {
          setShowPhoneModal(false);
          return;
        }
        if (showDeleteConfirm) {
          setShowDeleteConfirm(false);
          setDeleteAccountPassword('');
          return;
        }
        handleClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleClose, showMfaDisableModal, mfaSetupData, showCreatePackModal, showAddStickerModal, showEmailModal, showPasswordModal, showUsernameModal, showPhoneModal, showDeleteConfirm]);

  useEffect(() => {
    const handleBeforeUnload = (e) => {
      if (hasAnyUnsavedChanges) {
        e.preventDefault();
        e.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [hasAnyUnsavedChanges]);
  
  // Sticker pack handlers
  const handleCreatePack = async (e) => {
    e.preventDefault();
    if (!newPackName.trim() || !newPackTeam) {
      notify.error(t('stickers.nameAndGroupRequired'));
      return;
    }
    setSaving(true);
    try {
      const pack = await stickersApi.createPack(
        newPackTeam,
        newPackName.trim(),
        newPackDescription.trim() || null,
        newPackCover
      );
      setStickerPacks(prev => [pack, ...prev]);
      setShowCreatePackModal(false);
      setNewPackName('');
      setNewPackDescription('');
      setNewPackCover(null);
      notify.success(t('stickers.packCreated'));
    } catch (err) {
      notify.error(err.message || t('stickers.createError'));
    } finally {
      setSaving(false);
    }
  };
  
  const handleDeletePack = (packId) => {
    setDeletePackConfirm(packId);
  };
  const handleConfirmDeletePack = async () => {
    const packId = deletePackConfirm;
    setDeletePackConfirm(null);
    if (!packId) return;
    try {
      await stickersApi.deletePack(packId);
      setStickerPacks(prev => prev.filter(p => p.id !== packId));
      if (selectedPack?.id === packId) setSelectedPack(null);
      notify.success(t('stickers.packDeleted'));
    } catch (err) {
      notify.error(err.message || t('stickers.deleteError'));
    }
  };
  
  const handleViewPack = async (packId) => {
    try {
      const pack = await stickersApi.getPack(packId);
      setSelectedPack(pack);
    } catch (err) {
      notify.error(err.message || t('stickers.loadError'));
    }
  };
  
  const handleAddSticker = async (e) => {
    e.preventDefault();
    if (!newStickerFile || !selectedPack) {
      notify.error(t('stickers.imageRequired'));
      return;
    }
    setSaving(true);
    try {
      const sticker = await stickersApi.addSticker(
        selectedPack.id,
        newStickerName.trim() || null,
        newStickerFile
      );
      setSelectedPack(prev => ({
        ...prev,
        stickers: [...(prev.stickers || []), sticker]
      }));
      // Update sticker count in packs list
      setStickerPacks(prev => prev.map(p => 
        p.id === selectedPack.id 
          ? { ...p, sticker_count: (p.sticker_count || 0) + 1 }
          : p
      ));
      setShowAddStickerModal(false);
      setNewStickerName('');
      setNewStickerFile(null);
      setNewStickerPreview(null);
      notify.success('Sticker ajouté');
    } catch (err) {
      notify.error(err.message || 'Erreur lors de l\'ajout');
    } finally {
      setSaving(false);
    }
  };
  
  const handleDeleteSticker = (stickerId) => {
    setDeleteStickerConfirm(stickerId);
  };
  const handleConfirmDeleteSticker = async () => {
    const stickerId = deleteStickerConfirm;
    setDeleteStickerConfirm(null);
    if (!stickerId) return;
    try {
      await stickersApi.deleteSticker(stickerId);
      setSelectedPack(prev => ({
        ...prev,
        stickers: prev.stickers.filter(s => s.id !== stickerId)
      }));
      setStickerPacks(prev => prev.map(p => 
        p.id === selectedPack?.id 
          ? { ...p, sticker_count: Math.max(0, (p.sticker_count || 1) - 1) }
          : p
      ));
      notify.success(t('stickers.stickerDeleted'));
    } catch (err) {
      notify.error(err.message || t('stickers.deleteError'));
    }
  };
  
  const handleStickerFileChange = (e) => {
    const file = e.target.files[0];
    if (file) {
      setNewStickerFile(file);
      const reader = new FileReader();
      reader.onload = (ev) => setNewStickerPreview(ev.target.result);
      reader.readAsDataURL(file);
    }
  };

  // Render section content
  const renderSectionContent = () => {
    switch (activeSection) {
      case 'account':
        return (
          <div className="settings-content-section">
            <h2 className="settings-content-title">{t('account.title')}</h2>
            
            {loadingProfile ? (
              <div className="settings-skeleton">
                {[1, 2, 3, 4].map((i) => <div key={i} className="settings-skeleton-row" />)}
              </div>
            ) : (
              <>
                <div className="account-info-card">
                  <div className={`account-info-card-banner${bannerUrl ? ' account-info-card-banner--image' : ''}`} style={getBannerStyle()} />
                  <div className="account-info-card-header">
                    <div className="account-info-card-identity">
                      <div className="account-info-card-avatar">
                        <Avatar user={{ ...user, avatar_url: selectedAvatar }} size="xlarge" />
                        <div className="user-account-status-badge online" />
                      </div>
                      <div className="account-info-card-user">
                        <h3 className="account-info-card-name">{displayName || profile?.display_name || t('chat.user')}</h3>
                        <div className="account-info-card-tag">@{username || profile?.email?.split('@')[0]}</div>
                      </div>
                    </div>
                    <button className="btn-edit-profile" onClick={() => setActiveSection('profile')}>
                      {t('account.editProfile')}
                    </button>
                  </div>
                  <div className="account-info-card-body">
                    <div className="account-info-row">
                      <div className="account-info-row-main">
                        <label>{t('profile.displayName')}</label>
                        <span>{displayName || profile?.display_name || t('chat.user')}</span>
                      </div>
                      <button className="btn-field-edit" type="button" onClick={() => setActiveSection('profile')}>
                        {t('common.edit')}
                      </button>
                    </div>
                    <div className="account-info-row">
                      <div className="account-info-row-main">
                        <label>{t('account.username')}</label>
                        <span>@{username || profile?.email?.split('@')[0]}</span>
                      </div>
                      <button className="btn-field-edit" type="button" onClick={() => { setNewUsername(username); setShowUsernameModal(true); }}>
                        {t('common.edit')}
                      </button>
                    </div>
                    <div className="account-info-row">
                      <div className="account-info-row-main">
                        <label>{t('account.email')}</label>
                        <span>{profile?.email || user?.email}</span>
                      </div>
                      <button className="btn-field-edit" type="button" onClick={() => {
                        setNewEmail('');
                        setEmailPassword('');
                        setEmailChangeMfaCode('');
                        setEmailChangeStep('form');
                        setShowEmailModal(true);
                      }}>
                        {t('common.edit')}
                      </button>
                    </div>
                    <div className="account-info-row">
                      <div className="account-info-row-main">
                        <label>{t('account.phone')}</label>
                        <span className={phone ? '' : 'text-muted'}>{phone || t('account.notSet')}</span>
                      </div>
                      <button className="btn-field-edit" type="button" onClick={openPhoneModal}>
                        {phone ? t('common.edit') : t('common.add')}
                      </button>
                    </div>
                  </div>
                </div>
                
              </>
            )}
            
            <SettingsDivider title={t('account.passwordSecurity')} />
            
            <div className="settings-field">
              <label>{t('auth.password')}</label>
              <div className="settings-field-value">
                <span>••••••••</span>
                <button type="button" className="btn-field-edit" onClick={() => {
                  setCurrentPassword('');
                  setNewPassword('');
                  setConfirmPassword('');
                  setPasswordChangeMfaCode('');
                  setPasswordChangeStep('form');
                  setShowPasswordModal(true);
                }}>
                  {t('account.changePassword')}
                </button>
              </div>
            </div>
            
            <SettingsDivider title={t('account.twoFactor')} />
            
            <div className="two-factor-section">
              <div className="two-factor-info">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
                  <path d="M9 12l2 2 4-4"/>
                </svg>
                <div>
                  <h4>{t('account.twoFactorTitle')}</h4>
                  <p>{t('account.twoFactorDescription')}</p>
                </div>
              </div>
              {(profile?.totp_enabled ?? user?.totp_enabled) ? (
                <div className="two-factor-enabled">
                  <span className="two-factor-badge">{t('account.mfaActive')}</span>
                  <button className="btn-secondary btn-outline-danger" onClick={() => setShowMfaDisableModal(true)}>
                    {t('account.disable2FA')}
                  </button>
                </div>
              ) : mfaSetupData ? (
                <form onSubmit={handleMfaEnable} className="mfa-setup-form">
                  <p className="mfa-setup-step">{t('account.mfaStep1')}</p>
                  <div className="mfa-qr-container">
                    <img src={mfaSetupData.qrDataUrl} alt="QR Code" className="mfa-qr-code" />
                  </div>
                  <p className="mfa-setup-step">{t('account.mfaStep2')}</p>
                  <div className="mfa-secret-fallback">
                    <code>{mfaSetupData.secret}</code>
                  </div>
                  <div className="settings-field">
                    <label>{t('account.mfaVerifyLabel')}</label>
                    <MfaCodeInput
                      value={mfaEnableCode}
                      onChange={setMfaEnableCode}
                      autoFocus
                    />
                  </div>
                  <div className="mfa-setup-actions">
                    <button type="button" className="btn-cancel" onClick={() => setMfaSetupData(null)}>
                      {t('common.cancel')}
                    </button>
                    <button type="submit" className="btn-primary" disabled={mfaEnabling || mfaEnableCode.length < 6}>
                      {mfaEnabling ? t('common.loading') : t('account.enable2FA')}
                    </button>
                  </div>
                </form>
              ) : (
                <button className="btn-secondary" onClick={handleMfaSetup}>{t('account.enable2FA')}</button>
              )}
            </div>
            
            {showMfaDisableModal && (
              <div className="mfa-disable-modal-overlay" onClick={() => { setShowMfaDisableModal(false); setMfaDisableCode(''); }}>
                <div className="mfa-disable-modal" onClick={e => e.stopPropagation()}>
                  <div className="mfa-disable-modal__icon">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
                      <line x1="9" y1="12" x2="15" y2="12"/>
                    </svg>
                  </div>
                  <h3 className="mfa-disable-modal__title">{t('account.disable2FATitle')}</h3>
                  <p className="mfa-disable-modal__desc">{t('account.disable2FAMessage')}</p>
                  <form onSubmit={handleMfaDisable} className="mfa-disable-form">
                    <div className="settings-field">
                      <label>{t('account.mfaVerifyLabel')}</label>
                      <MfaCodeInput
                        value={mfaDisableCode}
                        onChange={setMfaDisableCode}
                        autoFocus
                      />
                    </div>
                    <div className="mfa-disable-modal__actions">
                      <button type="button" className="mfa-disable-modal__cancel" onClick={() => { setShowMfaDisableModal(false); setMfaDisableCode(''); }}>
                        {t('common.cancel')}
                      </button>
                      <button type="submit" className="mfa-disable-modal__confirm" disabled={mfaDisabling || mfaDisableCode.replace(/\D/g, '').length < 6}>
                        {mfaDisabling ? t('common.loading') : t('account.disable2FA')}
                      </button>
                    </div>
                  </form>
                </div>
              </div>
            )}
            
            {/* Backup codes section — shown when 2FA is active */}
            {!!(profile?.totp_enabled ?? user?.totp_enabled) && (
              <>
                <SettingsDivider title="Codes de récupération 2FA" />
                <div className="backup-codes-section">
                  {shownBackupCodes ? (
                    <>
                      <p className="backup-codes-warning">⚠️ Sauvegardez ces codes maintenant. Ils ne seront plus affichés.</p>
                      <div className="backup-codes-grid">
                        {shownBackupCodes.map((code, i) => (
                          <code key={i} className="backup-code">{code}</code>
                        ))}
                      </div>
                      <button className="btn-secondary" onClick={() => setShownBackupCodes(null)}>
                        J'ai sauvegardé mes codes
                      </button>
                    </>
                  ) : (
                    <>
                      <p className="backup-codes-info">
                        {backupCodesInfo
                          ? `${backupCodesInfo.remaining} / ${backupCodesInfo.total} codes disponibles.`
                          : 'Chargement...'}
                        {' '}Utilisez-les si vous perdez accès à votre application d'authentification.
                      </p>
                      <button className="btn-secondary btn-sm" onClick={() => setShowRegenModal(true)}>
                        Régénérer les codes
                      </button>
                    </>
                  )}
                </div>

                {showRegenModal && (
                  <div className="mfa-disable-modal-overlay" onClick={() => { setShowRegenModal(false); setRegenCode(''); }}>
                    <div className="mfa-disable-modal" onClick={e => e.stopPropagation()}>
                      <h3 className="mfa-disable-modal__title">Régénérer les codes de récupération</h3>
                      <p className="mfa-disable-modal__desc">Entrez votre code 2FA pour confirmer. Les anciens codes seront invalidés.</p>
                      <form onSubmit={handleRegenBackupCodes} className="mfa-disable-form">
                        <div className="settings-field">
                          <label>Code 2FA</label>
                          <MfaCodeInput value={regenCode} onChange={setRegenCode} autoFocus />
                        </div>
                        <div className="mfa-disable-modal__actions">
                          <button type="button" className="mfa-disable-modal__cancel" onClick={() => { setShowRegenModal(false); setRegenCode(''); }}>
                            {t('common.cancel')}
                          </button>
                          <button type="submit" className="mfa-disable-modal__confirm" disabled={regenLoading || regenCode.replace(/\D/g, '').length < 6}>
                            {regenLoading ? t('common.loading') : 'Régénérer'}
                          </button>
                        </div>
                      </form>
                    </div>
                  </div>
                )}
              </>
            )}

            <SettingsDivider title={t('account.connectedDevices')} />
            <ConnectedDevicesSection />
            
            <SettingsDivider title={t('account.dataExport')} />
            
            <div className="data-export-section">
              <p>{t('account.dataExportDescription')}</p>
              <button
                type="button"
                className="btn-secondary"
                onClick={handleExportData}
                disabled={exportingData}
              >
                {exportingData ? t('common.loading') : t('account.exportData')}
              </button>
            </div>
            
            <SettingsDivider title={t('account.deleteAccount')} />
            
            <div className="danger-zone">
              <p>{t('account.deleteWarning')}</p>
              <button className="btn-danger" onClick={handleDeleteAccount}>
                {t('account.deleteButton')}
              </button>
            </div>
          </div>
        );
        
      case 'profile':
        return (
          <div className="settings-content-section profile-settings-discord">
            <div className="profile-settings-discord-layout">
              {/* Left: scrollable settings */}
              <div className="profile-settings-body">
              {/* Avatar section - Discord card style */}
              <div className="profile-section-card">
                <div className="profile-section-header">
                  <h3>{t('profile.avatar')}</h3>
                  <p className="profile-section-desc">{t('profile.avatarDesc')}</p>
                </div>
                <div className="profile-section-content">
                  <div className="profile-avatar-edit">
                    <input
                      ref={avatarInputRef}
                      type="file"
                      accept="image/jpeg,image/png,image/gif,image/webp"
                      onChange={handleUploadAvatar}
                      style={{ display: 'none' }}
                    />
                    <div className="profile-avatar-preview">
                      <Avatar user={{ ...user, avatar_url: selectedAvatar }} size="xlarge" />
                    </div>
                    <div className="profile-avatar-actions">
                      <button
                        type="button"
                        className="btn-discord-primary"
                        onClick={() => avatarInputRef.current?.click()}
                        disabled={uploadingAvatar}
                      >
                        {uploadingAvatar ? t('common.uploading') : t('profile.changeAvatar')}
                      </button>
                      <button type="button" className="btn-discord-ghost" onClick={handleResetAvatar}>
                        {t('profile.resetAvatar')}
                      </button>
                    </div>
                  </div>
                </div>
              </div>

              {cropFile && (
                <AvatarCropModal
                  file={cropFile}
                  onConfirm={handleCropConfirm}
                  onCancel={() => setCropFile(null)}
                />
              )}

              {/* Equipped shop items */}
              <div className="profile-section-card">
                <div className="profile-section-header">
                  <h3>{t('shop.equippedItems')}</h3>
                  <p className="profile-section-desc">{t('shop.equippedItemsDesc')}</p>
                </div>
                <div className="profile-section-content">
                  <div className="profile-equipped-row">
                    <span className="profile-equipped-label">{t('shop.avatarDecorations')}</span>
                    <span className="profile-equipped-value">
                      {SHOP_ITEM_NAMES[user?.equipped_avatar_decoration_id] || t('common.none')}
                    </span>
                  </div>
                  <div className="profile-equipped-row">
                    <span className="profile-equipped-label">{t('shop.profileEffects')}</span>
                    <span className="profile-equipped-value">
                      {SHOP_ITEM_NAMES[user?.equipped_profile_effect_id] || t('common.none')}
                    </span>
                  </div>
                  <div className="profile-equipped-row">
                    <span className="profile-equipped-label">{t('shop.nameplates')}</span>
                    <span className="profile-equipped-value">
                      {SHOP_ITEM_NAMES[user?.equipped_nameplate_id] || t('common.none')}
                    </span>
                  </div>
                  <button
                    type="button"
                    className="btn-discord-primary profile-equipped-shop-btn"
                    onClick={() => navigate('/shop')}
                  >
                    {t('shop.manageInShop')}
                  </button>
                </div>
              </div>
              
              {/* Banner color - Discord card style */}
              <div className="profile-section-card">
                <div className="profile-section-header">
                  <h3>{t('profile.bannerColor')}</h3>
                  <p className="profile-section-desc">{t('profile.bannerColorDesc')}</p>
                </div>
                <div className="profile-section-content">
                  <div className="profile-banner-editor">
                    <div className={`profile-banner-preview-large${bannerUrl ? ' profile-banner-preview-large--image' : ''}`} style={getBannerStyle()}>
                      <div className="profile-banner-preview-shine" />
                    </div>
                    <div className="profile-banner-colors">
                      <div className="profile-banner-presets">
                        {[
                          { id: 'white', value: '#ffffff', label: 'Blanc' },
                          { id: 'blue', value: '#4f6ef7', label: 'Bleu' },
                          { id: 'green', value: '#3BA55C', label: 'Vert' },
                          { id: 'yellow', value: '#FAA61A', label: 'Jaune' },
                          { id: 'pink', value: '#EB459E', label: 'Rose' },
                          { id: 'red', value: '#ED4245', label: 'Rouge' },
                          { id: 'purple', value: '#9B59B6', label: 'Violet' },
                          { id: 'orange', value: '#E67E22', label: 'Orange' },
                          { id: 'teal', value: '#1ABC9C', label: 'Turquoise' },
                          { id: 'indigo', value: '#3498DB', label: 'Indigo' },
                        ].map(color => (
                          <button
                            key={color.id}
                            type="button"
                            className={`profile-color-btn ${bannerColor === color.value ? 'active' : ''}`}
                            style={{ background: color.value }}
                            onClick={() => setBannerColor(color.value)}
                            title={color.label}
                          >
                            {bannerColor === color.value && (
                              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3">
                                <polyline points="20 6 9 17 4 12"/>
                              </svg>
                            )}
                          </button>
                        ))}
                      </div>
                      <div className="profile-banner-custom">
                        <ColorPicker
                          value={bannerColor}
                          onChange={setBannerColor}
                          className="profile-color-picker"
                        />
                        <span className="profile-color-custom-text">{t('profile.customColor')}</span>
                      </div>
                    </div>
                    <div className="profile-banner-nitro">
                      <h4 className="profile-banner-nitro-title">{t('profile.customBanner')}</h4>
                      <div className="profile-banner-nitro-row">
                        <label className="profile-banner-gif-upload">
                          <input
                            ref={bannerInputRef}
                            type="file"
                            accept="image/gif,image/webp"
                            onChange={handleUploadBanner}
                            style={{ display: 'none' }}
                          />
                          <span className="profile-banner-gif-btn">{uploadingBanner ? t('common.uploading') : (bannerUrl ? t('profile.changeBannerGif') : t('profile.uploadBannerGif'))}</span>
                        </label>
                        {bannerUrl && (
                          <button type="button" className="profile-banner-remove-gif" onClick={handleRemoveBanner}>
                            {t('profile.removeBannerGif')}
                          </button>
                        )}
                      </div>
                      {bannerUrl && (
                        <div className="profile-banner-position-row">
                          <span className="profile-banner-position-label">Position</span>
                          <div className="profile-banner-position-btns">
                            {[
                              { value: 'top', label: 'Haut' },
                              { value: 'center', label: 'Centre' },
                              { value: 'bottom', label: 'Bas' },
                            ].map(pos => (
                              <button
                                key={pos.value}
                                type="button"
                                className={`profile-banner-position-btn${bannerPosition === pos.value ? ' active' : ''}`}
                                onClick={() => setBannerPosition(pos.value)}
                              >
                                {pos.label}
                              </button>
                            ))}
                          </div>
                        </div>
                      )}
                      <div className="profile-banner-gradient-row">
                        <span className="profile-banner-gradient-label">{t('profile.gradientColor')}</span>
                        <ColorPicker value={bannerColor2 || '#4f6ef7'} onChange={setBannerColor2} className="profile-color-picker" />
                        {bannerColor2 && (
                          <button type="button" className="profile-banner-clear-gradient" onClick={() => setBannerColor2('')} title={t('profile.clearGradient')}>
                            ✕
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              </div>
              
              {/* Profile info - Discord form style */}
              <div className="profile-section-card">
                <div className="profile-section-header">
                  <h3>{t('profile.profileInfo')}</h3>
                  <p className="profile-section-desc">{t('profile.profileInfoDesc')}</p>
                </div>
                <form onSubmit={(e) => { e.preventDefault(); handleSaveAll(); }} className="profile-form-discord">
                  <div className="profile-form-field">
                    <label>{t('profile.displayName')}</label>
                    <input
                      type="text"
                      value={displayName}
                      onChange={(e) => setDisplayName(e.target.value)}
                      placeholder={t('profile.displayNamePlaceholder')}
                      className="profile-input-discord"
                      maxLength={32}
                    />
                    <span className="profile-field-count">{displayName.length}/32</span>
                  </div>
                  
                  <div className="profile-form-field">
                    <label>{t('profile.statusMessage')}</label>
                    <input
                      type="text"
                      value={statusMessage}
                      onChange={(e) => setStatusMessage(e.target.value)}
                      placeholder={t('profile.statusPlaceholder')}
                      className="profile-input-discord"
                      maxLength={128}
                    />
                    <span className="profile-field-count">{statusMessage.length}/128</span>
                  </div>
                  
                  <div className="profile-form-field">
                    <label>{t('profile.aboutMe')}</label>
                    <textarea
                      value={aboutMe}
                      onChange={(e) => setAboutMe(e.target.value)}
                      placeholder={t('profile.aboutMePlaceholder')}
                      className="profile-textarea-discord"
                      maxLength={190}
                      rows={4}
                    />
                    <span className="profile-field-count">{aboutMe.length}/190</span>
                  </div>
                  
                  <div className="profile-form-actions">
                    {hasUnsavedChanges && (
                      <span className="profile-unsaved-hint">{t('profile.unsavedHint')}</span>
                    )}
                  </div>
                </form>
              </div>
            </div>

              {/* Right: preview - exact ProfileCard as others see it */}
              <div className="profile-preview-wrap">
                <span className="profile-preview-label">{t('profile.preview')}</span>
                {renderProfilePreviewCard()}
              </div>
            </div>
          </div>
        );
        
      case 'privacy':
        return (
          <div className="settings-content-section">
            <h2 className="settings-content-title">{t('privacy.title')}</h2>
            
            {loadingGlobalSettings ? (
              <div className="settings-skeleton">
                {[1, 2, 3, 4].map((i) => <div key={i} className="settings-skeleton-row" />)}
              </div>
            ) : (
              <>
                <SettingsDivider title={t('privacy.directMessages')} />
                
                <SettingsRow 
                  label={t('privacy.allowDMServers')}
                  description={t('privacy.allowDMServersDesc')}
                >
                  <ToggleSwitch 
                    checked={allSettings.allow_dm_from_servers} 
                    onChange={(v) => updateSetting('allow_dm_from_servers', v)} 
                  />
                </SettingsRow>
                
                <SettingsRow 
                  label={t('privacy.filterDM')}
                  description={t('privacy.filterDMDesc')}
                >
                  <ToggleSwitch 
                    checked={allSettings.filter_dm_content} 
                    onChange={(v) => updateSetting('filter_dm_content', v)} 
                  />
                </SettingsRow>
                
                <SettingsDivider title={t('privacy.serverPrivacy')} />
                
                <SettingsRow 
                  label={t('privacy.showActivity')}
                  description={t('privacy.showActivityDesc')}
                >
                  <ToggleSwitch 
                    checked={allSettings.show_activity_status} 
                    onChange={(v) => updateSetting('show_activity_status', v)} 
                  />
                </SettingsRow>
                
                <SettingsRow 
                  label={t('privacy.allowFriendRequests')}
                  description={t('privacy.allowFriendRequestsDesc')}
                >
                  <ToggleSwitch 
                    checked={allSettings.allow_friend_requests} 
                    onChange={(v) => updateSetting('allow_friend_requests', v)} 
                  />
                </SettingsRow>
                
                <SettingsRow 
                  label={t('privacy.showOnline')}
                  description={t('privacy.showOnlineDesc')}
                >
                  <ToggleSwitch 
                    checked={allSettings.show_online_status} 
                    onChange={(v) => updateSetting('show_online_status', v)} 
                  />
                </SettingsRow>
                
                <SettingsDivider title={t('privacy.dataPrivacy')} />

                <div className="data-transparency-card">
                  <h3 className="data-transparency-title">Ce que Slide stocke — et ne stocke pas</h3>
                  <div className="data-transparency-grid">
                    <div className="data-transparency-col data-transparency-col--stored">
                      <div className="data-transparency-col-header">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="16" height="16"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
                        Stocké
                      </div>
                      <ul>
                        <li>Nom d'affichage, pseudo, e-mail (haché)</li>
                        <li>Photo de profil &amp; bannière</li>
                        <li>Messages &amp; fichiers partagés</li>
                        <li>Membres de serveurs &amp; rôles</li>
                        <li>Identifiant d'appareil &amp; nom convivial</li>
                        <li>Horodatage de connexion &amp; activité</li>
                        <li>Paramètres &amp; préférences</li>
                      </ul>
                    </div>
                    <div className="data-transparency-col data-transparency-col--not-stored">
                      <div className="data-transparency-col-header">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="16" height="16"><circle cx="12" cy="12" r="10"/><line x1="4.93" y1="4.93" x2="19.07" y2="19.07"/></svg>
                        Jamais stocké
                      </div>
                      <ul>
                        <li>Adresse IP</li>
                        <li>Localisation géographique</li>
                        <li>User-Agent / empreinte d'appareil</li>
                        <li>Données de navigation ou de tracking</li>
                        <li>Profils publicitaires</li>
                        <li>Données biométriques ou de santé</li>
                        <li>Contenu vocal ou vidéo des appels</li>
                      </ul>
                    </div>
                  </div>
                </div>

                <div className="data-privacy-actions">
                  <button
                    className="btn-secondary"
                    onClick={async () => {
                      try {
                        const data = await auth.exportData();
                        const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
                        const url = URL.createObjectURL(blob);
                        const a = document.createElement('a');
                        a.href = url;
                        a.download = `slide-data-export-${new Date().toISOString().slice(0, 10)}.json`;
                        a.click();
                        URL.revokeObjectURL(url);
                        notify.success(t('privacy.dataExportSuccess'));
                      } catch (err) {
                        notify.error(err.message || t('privacy.dataExportError'));
                      }
                    }}
                  >
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                      <polyline points="7 10 12 15 17 10"/>
                      <line x1="12" y1="15" x2="12" y2="3"/>
                    </svg>
                    {t('privacy.requestData')}
                  </button>
                </div>
              </>
            )}
          </div>
        );

      case 'connections':
        const handleConnectSpotify = async () => {
          try {
            setConnectingSpotify(true);
            const url = await settingsApi.connectSpotify();
            window.location.href = url;
          } catch (err) {
            const msg = err.status === 503
              ? (t('connections.spotifyNotConfigured') || 'Spotify is not configured. Add SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET to the backend .env file, then restart the server.')
              : (err.message || 'Failed to start Spotify connection');
            notify.error(msg);
            setConnectingSpotify(false);
          }
        };
        const handleDisconnect = async (provider) => {
          try {
            await settingsApi.disconnect(provider);
            setConnections(prev => prev.filter(c => c.provider !== provider));
            notify.success(t('connections.disconnect'));
          } catch (err) {
            notify.error(err.message);
          }
        };
        const hasSpotify = connections.some(c => c.provider === 'spotify');
        return (
          <div className="settings-content-section">
            <h2 className="settings-content-title">{t('connections.title')}</h2>
            <p className="settings-description">{t('connections.description')}</p>
            {loadingConnections ? (
              <div className="settings-skeleton">
                {[1, 2, 3].map((i) => <div key={i} className="settings-skeleton-row" />)}
              </div>
            ) : (
              <>
                <SettingsDivider title={t('connections.connected')} />
                <div className="connections-list">
                  {hasSpotify && (
                    <div className="connection-connected">
                      <div className="connection-icon connection-icon-spotify">
                        <svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 0C5.4 0 0 5.4 0 12s5.4 12 12 12 12-5.4 12-12S18.66 0 12 0zm5.521 17.34c-.24.359-.66.48-1.021.24-2.82-1.74-6.36-2.101-10.561-1.141-.418.122-.779-.179-.899-.539-.12-.421.18-.78.54-.9 4.56-1.021 8.52-.6 11.64 1.32.42.18.479.659.301 1.02zm1.44-3.3c-.301.42-.841.6-1.262.3-3.239-1.98-8.159-2.58-11.939-1.38-.479.12-1.02-.12-1.14-.6-.12-.48.12-1.021.6-1.141C9.6 9.9 15 10.561 18.72 12.84c.361.181.54.78.241 1.2zm.12-3.36C15.24 8.4 8.82 8.16 5.16 9.301c-.6.179-1.2-.181-1.38-.721-.18-.601.18-1.2.72-1.381 4.26-1.26 11.28-1.02 15.721 1.621.539.3.719 1.02.419 1.56-.299.421-1.02.599-1.559.3z"/></svg>
                      </div>
                      <div className="connection-info">
                        <span className="connection-name">Spotify</span>
                        {connections.find(c => c.provider === 'spotify')?.provider_username && (
                          <span className="connection-username">{t('connections.spotifyConnected')} {connections.find(c => c.provider === 'spotify').provider_username}</span>
                        )}
                      </div>
                      <button type="button" className="btn-secondary btn-sm" onClick={() => handleDisconnect('spotify')}>{t('connections.disconnect')}</button>
                    </div>
                  )}
                  {!hasSpotify && (
                    <div className="connection-connected">
                      <div className="connection-icon connection-icon-spotify">
                        <svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 0C5.4 0 0 5.4 0 12s5.4 12 12 12 12-5.4 12-12S18.66 0 12 0zm5.521 17.34c-.24.359-.66.48-1.021.24-2.82-1.74-6.36-2.101-10.561-1.141-.418.122-.779-.179-.899-.539-.12-.421.18-.78.54-.9 4.56-1.021 8.52-.6 11.64 1.32.42.18.479.659.301 1.02zm1.44-3.3c-.301.42-.841.6-1.262.3-3.239-1.98-8.159-2.58-11.939-1.38-.479.12-1.02-.12-1.14-.6-.12-.48.12-1.021.6-1.141C9.6 9.9 15 10.561 18.72 12.84c.361.181.54.78.241 1.2zm.12-3.36C15.24 8.4 8.82 8.16 5.16 9.301c-.6.179-1.2-.181-1.38-.721-.18-.601.18-1.2.72-1.381 4.26-1.26 11.28-1.02 15.721 1.621.539.3.719 1.02.419 1.56-.299.421-1.02.599-1.559.3z"/></svg>
                      </div>
                      <div className="connection-info">
                        <span className="connection-name">Spotify</span>
                        <span className="connection-desc">{t('connections.spotifyDesc')}</span>
                      </div>
                      <button type="button" className="btn-primary btn-sm" onClick={handleConnectSpotify} disabled={connectingSpotify}>
                        {connectingSpotify ? t('common.loading') : t('connections.connectSpotify')}
                      </button>
                    </div>
                  )}
                </div>
                {hasSpotify && (
                  <>
                    <SettingsDivider title={t('privacy.serverPrivacy')} />
                    <SettingsRow
                      label={t('connections.showOnProfile')}
                      description={t('connections.spotifyDesc')}
                    >
                      <ToggleSwitch
                        checked={allSettings.show_spotify_listening !== false}
                        onChange={(v) => updateSetting('show_spotify_listening', v)}
                      />
                    </SettingsRow>
                  </>
                )}
              </>
            )}
          </div>
        );

      case 'blocked':
        const handleUnblock = async (userId) => {
          try {
            await friendsApi.unblock(userId);
            invalidateCache('/friends');
            setBlockedList(prev => prev.filter(b => b.id !== userId));
            notify.success(t('friends.unblocked') || t('friends.unblock'));
          } catch (err) {
            notify.error(err.message);
          }
        };
        return (
          <div className="settings-content-section">
            <h2 className="settings-content-title">{t('friends.blocked')}</h2>
            <p className="settings-description">{t('friends.blockedSettingsDesc') || t('friends.noBlocked')}</p>
            {loadingBlocked ? (
              <div className="settings-skeleton">
                {[1, 2, 3].map((i) => <div key={i} className="settings-skeleton-row" />)}
              </div>
            ) : blockedList.length === 0 ? (
              <div className="activity-empty">
                <p>{t('friends.noBlocked')}</p>
              </div>
            ) : (
              <div className="blocked-users-list">
                {blockedList.map(user => (
                  <div key={user.id} className="blocked-user-row">
                    <Avatar user={user} size="small" />
                    <div className="blocked-user-info">
                      <span className="blocked-user-name">{user.display_name || user.username}</span>
                      {user.username && user.display_name && (
                        <span className="blocked-user-username">@{user.username}</span>
                      )}
                    </div>
                    <button
                      className="btn-secondary"
                      onClick={() => handleUnblock(user.id)}
                    >
                      {t('friends.unblock')}
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        );

      case 'appearance':
        return (
          <div className="settings-content-section">
            <h2 className="settings-content-title">{t('appearance.title')}</h2>
            {savingSettings && <span className="settings-saving-indicator">{t('profile.saving')}</span>}
            
            {loadingGlobalSettings ? (
              <div className="settings-skeleton">
                {[1, 2, 3, 4].map((i) => <div key={i} className="settings-skeleton-row" />)}
              </div>
            ) : (
              <>
                <SettingsDivider title={t('appearance.theme')} />
                
                <div className="theme-selector" role="radiogroup" aria-label={t('appearance.theme')}>
                  {[
                    { id: 'dark', label: t('appearance.dark'), icon: (
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>
                      </svg>
                    ) },
                    { id: 'light', label: t('appearance.light'), icon: (
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <circle cx="12" cy="12" r="5"/>
                        <line x1="12" y1="1" x2="12" y2="3"/>
                        <line x1="12" y1="21" x2="12" y2="23"/>
                        <line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/>
                        <line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/>
                        <line x1="1" y1="12" x2="3" y2="12"/>
                        <line x1="21" y1="12" x2="23" y2="12"/>
                        <line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/>
                        <line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/>
                      </svg>
                    ) },
                    { id: 'auto', label: t('appearance.auto'), icon: (
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <circle cx="12" cy="12" r="10"/>
                        <path d="M12 2v20"/>
                        <path d="M12 2 A10 10 0 0 1 12 22" fill="currentColor" fillOpacity="0.2" stroke="none"/>
                      </svg>
                    ) },
                  ].map(themeItem => (
                    <button
                      key={themeItem.id}
                      type="button"
                      role="radio"
                      aria-checked={allSettings.theme === themeItem.id}
                      aria-label={themeItem.label}
                      className={`theme-option ${allSettings.theme === themeItem.id ? 'active' : ''}`}
                      onClick={() => updateSetting('theme', themeItem.id)}
                    >
                      <span className="theme-icon">{themeItem.icon}</span>
                      <span className="theme-label">{themeItem.label}</span>
                    </button>
                  ))}
                </div>
                
                <SettingsDivider title={t('appearance.profileStyle')} />
                <div className="theme-selector" role="radiogroup" aria-label={t('appearance.profileStyle')}>
                  {[
                    { id: 'card', label: t('appearance.profileStyleCard'), icon: (
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <rect x="4" y="4" width="16" height="16" rx="3"/>
                      </svg>
                    ) },
                    { id: 'popup', label: t('appearance.profileStylePopup'), icon: (
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <rect x="2" y="6" width="14" height="14" rx="2"/>
                        <path d="M16 10h4v10H8"/>
                      </svg>
                    ) },
                  ].map(opt => (
                    <button
                      key={opt.id}
                      type="button"
                      role="radio"
                      aria-checked={(allSettings.profile_style || 'card') === opt.id}
                      aria-label={opt.label}
                      className={`theme-option ${(allSettings.profile_style || 'card') === opt.id ? 'active' : ''}`}
                      onClick={() => updateSetting('profile_style', opt.id)}
                    >
                      <span className="theme-icon">{opt.icon}</span>
                      <span className="theme-label">{opt.label}</span>
                    </button>
                  ))}
                </div>
                
                <SettingsDivider title={t('appearance.messageDisplay')} />
                
                <div className="message-display-options">
                  <button
                    type="button"
                    className={`display-option ${allSettings.message_display === 'cozy' ? 'active' : ''}`}
                    onClick={() => updateSetting('message_display', 'cozy')}
                  >
                    <div className="display-preview cozy">
                      <div className="preview-avatar" />
                      <div className="preview-lines">
                        <div className="preview-line name" />
                        <div className="preview-line msg" />
                        <div className="preview-line msg short" />
                      </div>
                    </div>
                    <span>{t('appearance.cozy')}</span>
                  </button>
                  <button
                    type="button"
                    className={`display-option ${allSettings.message_display === 'compact' ? 'active' : ''}`}
                    onClick={() => updateSetting('message_display', 'compact')}
                  >
                    <div className="display-preview compact">
                      <div className="preview-line compact-line" />
                      <div className="preview-line compact-line" />
                      <div className="preview-line compact-line" />
                    </div>
                    <span>{t('appearance.compact')}</span>
                  </button>
                </div>
                
                <SettingsDivider title={t('appearance.fontSize')} />
                
                <RangeSlider
                  value={allSettings.font_size}
                  onChange={(v) => updateSetting('font_size', v)}
                  min={12}
                  max={24}
                  label={t('appearance.chatFontSize')}
                  unit="px"
                />
                
                <RangeSlider
                  value={allSettings.chat_spacing}
                  onChange={(v) => updateSetting('chat_spacing', v)}
                  min={0}
                  max={32}
                  label={t('appearance.chatSpacing')}
                  unit="px"
                />
                
                <SettingsDivider title={t('appearance.advancedOptions')} />
                
                <SettingsRow label={t('appearance.showAvatars')} description={t('appearance.showAvatarsDesc')}>
                  <ToggleSwitch checked={allSettings.show_avatars} onChange={(v) => updateSetting('show_avatars', v)} />
                </SettingsRow>
                
                <SettingsRow label={t('appearance.animateEmoji')} description={t('appearance.animateEmojiDesc')}>
                  <ToggleSwitch checked={allSettings.animate_emoji} onChange={(v) => updateSetting('animate_emoji', v)} />
                </SettingsRow>
                
                <SettingsRow label={t('appearance.showEmbeds')} description={t('appearance.showEmbedsDesc')}>
                  <ToggleSwitch checked={allSettings.show_embeds} onChange={(v) => updateSetting('show_embeds', v)} />
                </SettingsRow>
              </>
            )}
          </div>
        );
        
      case 'accessibility':
        return (
          <div className="settings-content-section">
            <h2 className="settings-content-title">{t('accessibility.title')}</h2>
            
            {loadingGlobalSettings ? (
              <div className="settings-skeleton">
                {[1, 2, 3, 4].map((i) => <div key={i} className="settings-skeleton-row" />)}
              </div>
            ) : (
              <>
                <SettingsDivider title={t('accessibility.motion')} />
                
                <SettingsRow 
                  label={t('accessibility.reduceMotion')}
                  description={t('accessibility.reduceMotionDesc')}
                >
                  <ToggleSwitch checked={allSettings.reduce_motion} onChange={(v) => updateSetting('reduce_motion', v)} />
                </SettingsRow>

                <SettingsRow
                  label={t('accessibility.motionSignature')}
                  description={t('accessibility.motionSignatureDesc')}
                >
                  <SelectDropdown
                    value={allSettings.motion_signature || 'pure'}
                    onChange={(v) => updateSetting('motion_signature', v)}
                    options={[
                      { value: 'pure', label: t('accessibility.motionPure') },
                      { value: 'cinematic', label: t('accessibility.motionCinematic') },
                      { value: 'minimal', label: t('accessibility.motionMinimal') },
                    ]}
                  />
                </SettingsRow>
                
                <SettingsDivider title={t('accessibility.contrast')} />
                
                <SettingsRow 
                  label={t('accessibility.highContrast')}
                  description={t('accessibility.highContrastDesc')}
                >
                  <ToggleSwitch checked={allSettings.high_contrast} onChange={(v) => updateSetting('high_contrast', v)} />
                </SettingsRow>
                
                <RangeSlider
                  value={allSettings.saturation}
                  onChange={(v) => updateSetting('saturation', v)}
                  min={0}
                  max={200}
                  label={t('accessibility.saturation')}
                  unit="%"
                />
                
                <SettingsDivider title={t('accessibility.text')} />
                
                <SettingsRow 
                  label={t('accessibility.underlineLinks')}
                  description={t('accessibility.underlineLinksDesc')}
                >
                  <ToggleSwitch checked={allSettings.link_underline} onChange={(v) => updateSetting('link_underline', v)} />
                </SettingsRow>
                
                <SettingsRow 
                  label={t('accessibility.roleColors')}
                  description={t('accessibility.roleColorsDesc')}
                >
                  <ToggleSwitch checked={allSettings.role_colors} onChange={(v) => updateSetting('role_colors', v)} />
                </SettingsRow>
              </>
            )}
          </div>
        );
        
      case 'voice':
        const handleMicTest = async () => {
          if (micTesting) {
            stopMicTest();
            setMicTesting(false);
          } else {
            if (!audioPermissionGranted) {
              await requestAudioPermission();
            }
            const success = await startMicTest();
            if (success) {
              setMicTesting(true);
            } else {
              notify.error(t('voice.micAccessError'));
            }
          }
        };
        
        return (
          <div className="settings-content-section">
            <h2 className="settings-content-title">{t('voice.title')}</h2>
            
            {loadingGlobalSettings ? (
              <div className="settings-skeleton">
                {[1, 2, 3, 4].map((i) => <div key={i} className="settings-skeleton-row" />)}
              </div>
            ) : (
              <>
                <SettingsDivider title={t('voice.inputOutput')} />
                
                {!audioPermissionGranted && (inputDevices.length === 0 || outputDevices.length === 0) && (
                  <SettingsRow label={t('voice.deviceAccess')} description={t('voice.deviceAccessDesc', 'Grant microphone access to see and select your devices.')}>
                    <button type="button" className="btn-secondary btn-sm" onClick={() => requestAudioPermission()}>
                      {t('voice.allowAccess', 'Allow access')}
                    </button>
                  </SettingsRow>
                )}
                <SelectRowWithArrow
                  label={t('voice.inputDevice')}
                  value={allSettings.input_device}
                  onChange={(v) => updateSetting('input_device', v)}
                  options={inputDevices.length > 0 ? inputDevices : [{ value: 'default', label: t('voice.default') }]}
                />
                
                <RangeSlider
                  value={allSettings.input_volume}
                  onChange={(v) => updateSetting('input_volume', v)}
                  min={0}
                  max={200}
                  label={t('voice.inputVolume')}
                  unit="%"
                />
                
                <SelectRowWithArrow
                  label={t('voice.outputDevice')}
                  value={allSettings.output_device}
                  onChange={(v) => updateSetting('output_device', v)}
                  options={outputDevices.length > 0 ? outputDevices : [{ value: 'default', label: t('voice.default') }]}
                />
                
                <RangeSlider
                  value={allSettings.output_volume}
                  onChange={(v) => updateSetting('output_volume', v)}
                  min={0}
                  max={200}
                  label={t('voice.outputVolume')}
                  unit="%"
                />
                
                <SettingsDivider title={t('voice.audioProcessing')} />
                
                <SettingsRow label={t('voice.echoCancellation')} description={t('voice.echoCancellationDesc')}>
                  <ToggleSwitch checked={allSettings.echo_cancellation} onChange={(v) => updateSetting('echo_cancellation', v)} />
                </SettingsRow>
                
                <SettingsRow label={t('voice.noiseSuppression')} description={t('voice.noiseSuppressionDesc')}>
                  <ToggleSwitch checked={allSettings.noise_suppression} onChange={(v) => updateSetting('noise_suppression', v)} />
                </SettingsRow>
                
                <SettingsRow label={t('voice.autoGain')} description={t('voice.autoGainDesc')}>
                  <ToggleSwitch checked={allSettings.auto_gain_control} onChange={(v) => updateSetting('auto_gain_control', v)} />
                </SettingsRow>
                
                <SettingsDivider title={t('voice.sensitivity')} />
                
                <RangeSlider
                  value={allSettings.input_sensitivity}
                  onChange={(v) => updateSetting('input_sensitivity', v)}
                  min={0}
                  max={100}
                  label={t('voice.inputSensitivity')}
                  unit="%"
                />
                
                {micTesting && (
                  <div className="mic-level-container">
                    <div className="mic-level-bar-container">
                      <div 
                        className="mic-level-bar"
                        style={{ width: `${micLevel}%` }}
                      />
                      <div 
                        className="mic-level-threshold"
                        style={{ left: `${100 - allSettings.input_sensitivity}%` }}
                      />
                    </div>
                    <span className="mic-level-value">{Math.round(micLevel)}%</span>
                  </div>
                )}
                
                <div className="voice-test-section">
                  <button 
                    className={`btn-secondary ${micTesting ? 'active' : ''}`} 
                    onClick={handleMicTest}
                  >
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/>
                      <path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
                    </svg>
                    {micTesting ? t('voice.stopTest') : t('voice.testMic')}
                  </button>
                  <button 
                    className="btn-secondary" 
                    onClick={playTestSound}
                  >
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/>
                      <path d="M19.07 4.93a10 10 0 0 1 0 14.14"/>
                      <path d="M15.54 8.46a5 5 0 0 1 0 7.07"/>
                    </svg>
                    {t('voice.testSound')}
                  </button>
                </div>
              </>
            )}
          </div>
        );
        
      case 'notifications':
        return (
          <div className="settings-content-section">
            <h2 className="settings-content-title">{t('notifications.title')}</h2>
            
            {loadingGlobalSettings ? (
              <div className="settings-skeleton">
                {[1, 2, 3, 4].map((i) => <div key={i} className="settings-skeleton-row" />)}
              </div>
            ) : (
              <>
                <SettingsDivider title={t('notifications.general')} />
                
                <SettingsRow 
                  label={t('notifications.enable')}
                  description={t('notifications.enableDesc')}
                >
                  <ToggleSwitch checked={allSettings.enable_notifications} onChange={(v) => updateSetting('enable_notifications', v)} />
                </SettingsRow>
                
                <SettingsRow 
                  label={t('notifications.desktop')}
                  description={t('notifications.desktopDesc')}
                >
                  <ToggleSwitch 
                    checked={allSettings.desktop_notifications} 
                    onChange={(v) => updateSetting('desktop_notifications', v)} 
                    disabled={!allSettings.enable_notifications} 
                  />
                </SettingsRow>
                
                <SettingsRow 
                  label={t('notifications.preview')}
                  description={t('notifications.previewDesc')}
                >
                  <ToggleSwitch 
                    checked={allSettings.message_previews} 
                    onChange={(v) => updateSetting('message_previews', v)} 
                    disabled={!allSettings.enable_notifications} 
                  />
                </SettingsRow>
                
                <SettingsDivider title={t('notifications.sounds')} />
                
                <SettingsRow 
                  label={t('notifications.soundEnabled')}
                  description={t('notifications.soundEnabledDesc')}
                >
                  <div className="settings-row-actions">
                    <button type="button" className="settings-test-sound-btn" onClick={() => playNotification({ force: true })} title={t('voice.testSound')}>
                      {t('voice.testSound')}
                    </button>
                    <ToggleSwitch checked={allSettings.notification_sound} onChange={(v) => updateSetting('notification_sound', v)} />
                  </div>
                </SettingsRow>
                
                <SettingsDivider title={t('notifications.messages')} />
                
                <SettingsRow 
                  label={t('notifications.mentions')}
                  description={t('notifications.mentionsDesc')}
                >
                  <ToggleSwitch 
                    checked={allSettings.mention_notifications} 
                    onChange={(v) => updateSetting('mention_notifications', v)} 
                    disabled={!allSettings.enable_notifications} 
                  />
                </SettingsRow>
                
                <SettingsRow
                  label={t('notifications.directMessages')}
                  description={t('notifications.directMessagesDesc')}
                >
                  <ToggleSwitch
                    checked={allSettings.dm_notifications}
                    onChange={(v) => updateSetting('dm_notifications', v)}
                    disabled={!allSettings.enable_notifications}
                  />
                </SettingsRow>

                {pushSupported && (
                  <>
                    <SettingsDivider title={t('notifications.push', 'Notifications push')} />
                    <SettingsRow
                      label={t('notifications.pushEnable', 'Notifications push (hors ligne)')}
                      description={
                        pushPermission === 'denied'
                          ? t('notifications.pushDenied', 'Notifications bloquées par le navigateur. Veuillez les autoriser dans les paramètres.')
                          : t('notifications.pushDesc', 'Recevez des notifications même lorsque l\'application est fermée.')
                      }
                    >
                      <ToggleSwitch
                        checked={pushSubscribed}
                        disabled={pushLoading || pushPermission === 'denied' || !allSettings.enable_notifications}
                        onChange={async (v) => {
                          setPushLoading(true);
                          if (v) {
                            const result = await subscribePush();
                            if (!result.ok) notify.error(t('notifications.pushFailed', 'Impossible d\'activer les notifications push.'));
                            else notify.success(t('notifications.pushEnabled', 'Notifications push activées.'));
                          } else {
                            await unsubscribePush();
                            notify.success(t('notifications.pushDisabled', 'Notifications push désactivées.'));
                          }
                          setPushLoading(false);
                        }}
                      />
                    </SettingsRow>
                  </>
                )}
              </>
            )}
          </div>
        );

      case 'keybinds':
        const keybindLabels = {
          toggleMute: t('keybinds.toggleMute'),
          toggleDeafen: t('keybinds.toggleDeafen'),
          pushToTalk: t('keybinds.pushToTalk'),
          search: t('keybinds.search'),
          markAsRead: t('keybinds.markAsRead'),
        };
        return (
          <div className="settings-content-section">
            <h2 className="settings-content-title">{t('keybinds.title')}</h2>
            
            <p className="settings-description">
              {t('keybinds.description')}
            </p>
            
            {loadingGlobalSettings ? (
              <div className="settings-skeleton">
                {[1, 2, 3, 4].map((i) => <div key={i} className="settings-skeleton-row" />)}
              </div>
            ) : (
              <>
                <div className="keybinds-list">
                  {Object.entries(allSettings.keybinds || {}).map(([key, value]) => (
                    <div key={key} className="keybind-item">
                      <span className="keybind-action">
                        {keybindLabels[key] || key}
                      </span>
                      <button 
                        className="keybind-value"
                        onClick={() => {
                          const newValue = prompt(`${t('keybinds.enterNewKeybind')} "${keybindLabels[key] || key}":`, value);
                          if (newValue !== null) {
                            updateSetting('keybinds', { ...allSettings.keybinds, [key]: newValue });
                          }
                        }}
                      >
                        {value || <span className="keybind-empty">{t('keybinds.notSet')}</span>}
                      </button>
                    </div>
                  ))}
                </div>
                
                <button 
                  className="btn-secondary" 
                  style={{ marginTop: '1rem' }}
                  onClick={() => {
                    const name = prompt(t('keybinds.addKeybind') + ':');
                    if (name) {
                      const shortcut = prompt(t('keybinds.enterNewKeybind') + ' (ex: Ctrl + X):');
                      if (shortcut) {
                        updateSetting('keybinds', { ...allSettings.keybinds, [name]: shortcut });
                      }
                    }
                  }}
                >
                  {t('keybinds.addKeybind')}
                </button>
              </>
            )}
          </div>
        );
        
      case 'language':
        const handleLanguageChange = (langCode) => {
          updateSetting('language', langCode);
          changeLanguage(langCode);
        };
        
        return (
          <div className="settings-content-section">
            <h2 className="settings-content-title">{t('languageSettings.title')}</h2>
            
            <p className="settings-description">
              {t('languageSettings.description')}
            </p>
            
            {loadingGlobalSettings ? (
              <div className="settings-skeleton">
                {[1, 2, 3, 4].map((i) => <div key={i} className="settings-skeleton-row" />)}
              </div>
            ) : (
              <div className="language-grid">
                {availableLanguages.map(lang => (
                  <button
                    key={lang.code}
                    className={`language-option ${allSettings.language === lang.code ? 'active' : ''}`}
                    onClick={() => handleLanguageChange(lang.code)}
                  >
                    <span className="language-flag">{lang.flag}</span>
                    <span className="language-name">{lang.name}</span>
                    {allSettings.language === lang.code && (
                      <svg className="language-check" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3">
                        <polyline points="20 6 9 17 4 12"/>
                      </svg>
                    )}
                  </button>
                ))}
              </div>
            )}
          </div>
        );
        
      case 'advanced':
        return (
          <div className="settings-content-section">
            <h2 className="settings-content-title">{t('advancedSettings.title')}</h2>
            
            {loadingGlobalSettings ? (
              <div className="settings-skeleton">
                {[1, 2, 3, 4].map((i) => <div key={i} className="settings-skeleton-row" />)}
              </div>
            ) : (
              <>
                {typeof window !== 'undefined' && window.electron && (
                  <>
                    <SettingsDivider title={t('advancedSettings.app')} />
                    <SettingsRow
                      label={t('advancedSettings.launchAtStartup')}
                      description={t('advancedSettings.launchAtStartupDesc')}
                    >
                      <ToggleSwitch
                        checked={launchAtStartup}
                        onChange={async (v) => {
                          if (window.electron?.setLaunchAtStartup) {
                            const result = await window.electron.setLaunchAtStartup(v);
                            setLaunchAtStartup(result);
                          }
                        }}
                      />
                    </SettingsRow>
                    <SettingsRow
                      label="Minimiser dans la barre système"
                      description="Le bouton Fermer masque Slide dans la barre système plutôt que de quitter"
                    >
                      <ToggleSwitch
                        checked={minimizeToTray}
                        onChange={async (v) => {
                          if (window.electron?.setMinimizeToTray) {
                            const result = await window.electron.setMinimizeToTray(v);
                            setMinimizeToTray(result);
                          }
                        }}
                      />
                    </SettingsRow>
                  </>
                )}
                <SettingsDivider title={t('advancedSettings.developer')} />
                
                <SettingsRow 
                  label={t('advancedSettings.devMode')}
                  description={t('advancedSettings.devModeDesc')}
                >
                  <ToggleSwitch checked={allSettings.developer_mode} onChange={(v) => updateSetting('developer_mode', v)} />
                </SettingsRow>
                
                <SettingsDivider title={t('advancedSettings.performance')} />
                
                <SettingsRow 
                  label={t('advancedSettings.hardwareAcceleration')}
                  description={t('advancedSettings.hardwareAccelerationDesc')}
                >
                  <ToggleSwitch checked={allSettings.hardware_acceleration} onChange={(v) => updateSetting('hardware_acceleration', v)} />
                </SettingsRow>
                
                <SettingsDivider title={t('advancedSettings.debugging')} />
                
                <SettingsRow 
                  label={t('advancedSettings.debugMode')}
                  description={t('advancedSettings.debugModeDesc')}
                >
                  <ToggleSwitch checked={allSettings.debug_mode} onChange={(v) => updateSetting('debug_mode', v)} />
                </SettingsRow>
                
                <div className="debug-actions">
                  <button className="btn-secondary" onClick={handleClearCache}>
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M3 6h18"/>
                      <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/>
                      <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/>
                    </svg>
                    {t('advancedSettings.clearCache')}
                  </button>
                  <button className="btn-secondary" onClick={handleResetSettings}>
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4"/>
                    </svg>
                    {t('advancedSettings.resetSettings')}
                  </button>
                </div>
              </>
            )}
          </div>
        );
        
      case 'activity':
        const getActivityIcon = (actionType) => {
          const iconMap = {
            login: { type: 'success', icon: (
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/>
                <polyline points="22 4 12 14.01 9 11.01"/>
              </svg>
            )},
            profile_update: { type: 'info', icon: (
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="12" cy="12" r="10"/>
                <line x1="12" y1="16" x2="12" y2="12"/>
                <line x1="12" y1="8" x2="12.01" y2="8"/>
              </svg>
            )},
            email_change: { type: 'warning', icon: (
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
                <line x1="12" y1="9" x2="12" y2="13"/>
                <line x1="12" y1="17" x2="12.01" y2="17"/>
              </svg>
            )},
            cache_clear: { type: 'info', icon: (
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M3 6h18"/>
                <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/>
              </svg>
            )},
          };
          return iconMap[actionType] || iconMap.profile_update;
        };
        
        const formatActivityTime = (dateString) => {
          const date = new Date(dateString);
          const now = new Date();
          const diffDays = Math.floor((now - date) / (1000 * 60 * 60 * 24));
          
          if (diffDays === 0) {
            return `${t('activity.today')} ${date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}`;
          } else if (diffDays === 1) {
            return `${t('activity.yesterday')} ${date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}`;
          } else {
            return t('activity.daysAgo', { days: diffDays });
          }
        };
        
        return (
          <div className="settings-content-section">
            <h2 className="settings-content-title">{t('activity.title')}</h2>
            
            <p className="settings-description">
              {t('activity.description')}
            </p>
            
            {loadingActivity ? (
              <div className="settings-skeleton">
                {[1, 2, 3, 4, 5].map((i) => <div key={i} className="settings-skeleton-row" />)}
              </div>
            ) : activityLog.length === 0 ? (
              <div className="activity-empty">
                <p>{t('activity.noActivity')}</p>
              </div>
            ) : (
              <div className="activity-log">
                {activityLog.map((activity, index) => {
                  const iconInfo = getActivityIcon(activity.action_type);
                  return (
                    <div key={index} className="activity-item">
                      <div className={`activity-icon ${iconInfo.type}`}>
                        {iconInfo.icon}
                      </div>
                      <div className="activity-info">
                        <span className="activity-title">{activity.description || activity.action_type}</span>
                        <span className="activity-time">{formatActivityTime(activity.created_at)}</span>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        );
        
      case 'stickers':
        return (
          <div className="settings-content-section">
            <h2 className="settings-content-title">{t('settings.stickers')}</h2>
            
            <p className="settings-description">
              {t('stickers.description')}
            </p>
            
            {loadingStickerPacks ? (
              <div className="settings-skeleton">
                {[1, 2, 3].map((i) => <div key={i} className="settings-skeleton-row" />)}
              </div>
            ) : userTeams.length === 0 ? (
              <div className="sticker-empty-state">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                  <path d="M15.5 3H5a2 2 0 0 0-2 2v14c0 1.1.9 2 2 2h14a2 2 0 0 0 2-2V8.5L15.5 3Z"/>
                  <path d="M15 3v6h6"/>
                </svg>
                <h3>{t('stickers.noGroup')}</h3>
                <p>{t('stickers.joinGroup')}</p>
              </div>
            ) : selectedPack ? (
              // Pack detail view
              <div className="sticker-pack-detail">
                <button className="btn-back" onClick={() => setSelectedPack(null)}>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M19 12H5M12 19l-7-7 7-7"/>
                  </svg>
                  {t('stickers.backToPacks')}
                </button>
                
                <div className="sticker-pack-header">
                  {selectedPack.cover_url && (
                    <img src={selectedPack.cover_url} alt={selectedPack.name} className="sticker-pack-cover" />
                  )}
                  <div className="sticker-pack-info">
                    <h3>{selectedPack.name}</h3>
                    {selectedPack.description && <p>{selectedPack.description}</p>}
                    <span className="sticker-pack-meta">
                      {selectedPack.team_name} • {selectedPack.stickers?.length || 0} stickers • par {selectedPack.creator_name}
                    </span>
                  </div>
                  <button className="btn-danger-sm" onClick={() => handleDeletePack(selectedPack.id)}>
                    {t('stickers.deletePack')}
                  </button>
                </div>
                
                <SettingsDivider title="Stickers" />
                
                <div className="stickers-grid">
                  {selectedPack.stickers?.map(sticker => (
                    <div key={sticker.id} className="sticker-item">
                      <img src={sticker.image_url} alt={sticker.name} />
                      <span className="sticker-name">{sticker.name}</span>
                      <button 
                        className="sticker-delete-btn" 
                        onClick={() => handleDeleteSticker(sticker.id)}
                        title={t('common.delete')}
                      >
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                          <line x1="18" y1="6" x2="6" y2="18"/>
                          <line x1="6" y1="6" x2="18" y2="18"/>
                        </svg>
                      </button>
                    </div>
                  ))}
                  <button className="sticker-add-btn" onClick={() => setShowAddStickerModal(true)}>
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <line x1="12" y1="5" x2="12" y2="19"/>
                      <line x1="5" y1="12" x2="19" y2="12"/>
                    </svg>
                    <span>{t('stickers.addSticker')}</span>
                  </button>
                </div>
              </div>
            ) : (
              // Packs list view
              <>
                <SettingsDivider title={t('stickers.myPacks')} />
                
                <div className="sticker-packs-grid">
                  {stickerPacks.map(pack => (
                    <div key={pack.id} className="sticker-pack-card" onClick={() => handleViewPack(pack.id)}>
                      <div className="sticker-pack-card-cover">
                        {pack.cover_url ? (
                          <img src={pack.cover_url} alt={pack.name} />
                        ) : (
                          <div className="sticker-pack-card-placeholder">
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                              <path d="M15.5 3H5a2 2 0 0 0-2 2v14c0 1.1.9 2 2 2h14a2 2 0 0 0 2-2V8.5L15.5 3Z"/>
                              <path d="M15 3v6h6"/>
                            </svg>
                          </div>
                        )}
                      </div>
                      <div className="sticker-pack-card-info">
                        <h4>{pack.name}</h4>
                        <span className="sticker-pack-card-meta">
                          {pack.team_name} • {pack.sticker_count || 0} stickers
                        </span>
                      </div>
                    </div>
                  ))}
                  <button className="sticker-pack-add-card" onClick={() => setShowCreatePackModal(true)}>
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <line x1="12" y1="5" x2="12" y2="19"/>
                      <line x1="5" y1="12" x2="19" y2="12"/>
                    </svg>
                    <span>{t('stickers.createPack')}</span>
                  </button>
                </div>
              </>
            )}
          </div>
        );
        
      default:
        return (
          <div className="settings-content-section">
            <h2 className="settings-content-title">{t('errors.notFound')}</h2>
            <p>{t('errors.sectionNotFound')}</p>
          </div>
        );
    }
  };

  const settingsOverlay = (
    <div className="settings-page" onClick={(e) => e.target.classList.contains('settings-page') && handleClose()}>
      {/* Modal container */}
      <div className="settings-modal-container">
        {/* Sidebar Navigation */}
        <nav className="settings-nav">
        <div className="settings-nav-header">
          <input
            type="text"
            placeholder={t('common.search')}
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="settings-search"
          />
        </div>
        
        <div className="settings-nav-content">
          {SETTINGS_CATEGORIES.map(category => (
            <div key={category.id} className="settings-nav-category">
              <h3 className="settings-nav-category-title">{category.label}</h3>
              {category.items
                .filter(item => 
                  item.label.toLowerCase().includes(searchQuery.toLowerCase())
                )
                .map(item => (
                  <button
                    key={item.id}
                    className={`settings-nav-item ${activeSection === item.id ? 'active' : ''}`}
                    onClick={() => setActiveSection(item.id)}
                  >
                    <SettingsIcon name={item.icon} />
                    <span>{item.label}</span>
                  </button>
                ))}
            </div>
          ))}
          
          <div className="settings-nav-footer">
            <button className="settings-nav-item logout" onClick={handleLogout}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/>
                <polyline points="16 17 21 12 16 7"/>
                <line x1="21" y1="12" x2="9" y2="12"/>
              </svg>
              <span>{t('auth.logout')}</span>
            </button>
            
            <div className="settings-version">
              <span>{t('settings.version')}</span>
            </div>
          </div>
        </div>
      </nav>
      
        {/* Main Content */}
        <main className={`settings-content ${activeSection === 'profile' ? 'settings-content--profile' : ''}`}>
          <div className={`settings-content-wrapper ${activeSection === 'profile' ? 'settings-content-wrapper--profile' : ''}`}>
            {renderSectionContent()}
          </div>
        </main>
        
        {/* Barre du bas – sauvegardez avant de quitter */}
        {(hasAnyUnsavedChanges || saveBarExiting) && (
          <div
            className={`settings-unsaved-bar ${unsavedBarShake ? 'settings-unsaved-bar--shake' : ''} ${saveBarExiting ? 'settings-unsaved-bar--exiting' : ''}`}
            onAnimationEnd={() => {
              setUnsavedBarShake(false);
              if (saveBarExiting) {
                setSaveBarExiting(false);
                setSaveBarExitReason(null);
              }
            }}
          >
            <span>
              {saveBarExiting && saveBarExitReason === 'saved'
                ? (t('common.saved') || 'Saved!')
                : (t('settings.saveBeforeLeaving') || t('settings.unsavedChanges'))}
            </span>
            {!saveBarExiting && (
            <div className="settings-unsaved-actions">
              <button className="btn-reset-changes" onClick={() => {
                setDisplayName(originalProfile?.displayName || '');
                setStatusMessage(originalProfile?.statusMessage || '');
                setAboutMe(originalProfile?.aboutMe || '');
                setBannerColor(originalProfile?.bannerColor || '#ffffff');
                setBannerColor2(originalProfile?.bannerColor2 || '');
                setBannerPosition(originalProfile?.bannerPosition || 'center');
                setUsername(originalProfile?.username ?? profile?.username ?? profile?.email?.split('@')[0] ?? '');
                setPhone(originalProfile?.phone ?? profile?.phone ?? '');
                if (pendingToPersist.avatar?.previewUrl) URL.revokeObjectURL(pendingToPersist.avatar.previewUrl);
                if (pendingToPersist.banner?.previewUrl) URL.revokeObjectURL(pendingToPersist.banner.previewUrl);
                setSelectedAvatar(originalProfile?.avatarUrl ?? profile?.avatar_url);
                setBannerUrl(originalProfile?.bannerUrl ?? profile?.banner_url ?? '');
                setProfile(p => (p ? { ...p, username: originalProfile?.username ?? p.username, phone: originalProfile?.phone ?? p.phone, avatar_url: originalProfile?.avatarUrl ?? p.avatar_url, banner_url: originalProfile?.bannerUrl ?? p.banner_url, email: originalProfile?.email ?? p.email } : null));
                updateUser?.({ ...user, username: originalProfile?.username ?? user?.username, phone: originalProfile?.phone ?? user?.phone, avatar_url: originalProfile?.avatarUrl ?? user?.avatar_url, banner_url: originalProfile?.bannerUrl ?? user?.banner_url, email: originalProfile?.email ?? user?.email });
                setPendingToPersist({});
              }}>
                {t('common.reset') || 'Reset'}
              </button>
              <button className={`btn-save-changes ${saving ? 'btn-save-changes--saving' : ''}`} onClick={handleSaveAll} disabled={saving}>
                {saving ? t('profile.saving') : t('profile.saveChanges')}
              </button>
            </div>
            )}
          </div>
        )}

        {/* Close Button */}
        <button className="settings-close" onClick={handleClose} title={`${t('common.close')} (ESC)`} aria-label={t('common.close')}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="18" y1="6" x2="6" y2="18"/>
            <line x1="6" y1="6" x2="18" y2="18"/>
          </svg>
        </button>
      </div>

      {showDeleteConfirm && (
        <div className="mfa-disable-modal-overlay" onClick={() => { setShowDeleteConfirm(false); setDeleteAccountPassword(''); }}>
          <div className="mfa-disable-modal" onClick={e => e.stopPropagation()}>
            <div className="mfa-disable-modal__icon" style={{ background: 'rgba(237,66,69,0.15)', color: '#ed4245' }}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="3 6 5 6 21 6"/>
                <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>
                <path d="M10 11v6M14 11v6"/>
                <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/>
              </svg>
            </div>
            <h3 className="mfa-disable-modal__title">{t('account.deleteConfirmTitle') || 'Supprimer le compte'}</h3>
            <p className="mfa-disable-modal__desc">{t('account.deleteConfirmMessage') || 'Cette action est irréversible. Toutes vos données seront définitivement supprimées.'}</p>
            <form onSubmit={confirmDeleteAccount} className="mfa-disable-form">
              <div className="settings-field">
                <label>{t('account.confirmPassword') || 'Confirmez votre mot de passe'}</label>
                <input
                  type="password"
                  className="settings-input"
                  value={deleteAccountPassword}
                  onChange={e => setDeleteAccountPassword(e.target.value)}
                  placeholder={t('account.passwordPlaceholder') || 'Mot de passe'}
                  autoFocus
                  autoComplete="current-password"
                />
              </div>
              <div className="mfa-disable-modal__actions">
                <button
                  type="button"
                  className="mfa-disable-modal__cancel"
                  onClick={() => { setShowDeleteConfirm(false); setDeleteAccountPassword(''); }}
                >
                  {t('common.cancel')}
                </button>
                <button
                  type="submit"
                  className="mfa-disable-modal__confirm"
                  style={{ background: '#ed4245' }}
                  disabled={deleteAccountLoading || !deleteAccountPassword}
                >
                  {deleteAccountLoading ? t('common.loading') : (t('account.deleteConfirmButton') || 'Supprimer définitivement')}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      <ConfirmModal
        isOpen={!!deletePackConfirm}
        title={t('stickers.deletePack')}
        message={t('stickers.deletePackConfirm')}
        confirmText={t('common.delete')}
        cancelText={t('common.cancel')}
        type="danger"
        onConfirm={handleConfirmDeletePack}
        onCancel={() => setDeletePackConfirm(null)}
      />

      <ConfirmModal
        isOpen={!!deleteStickerConfirm}
        title={t('stickers.deleteSticker') || 'Delete sticker'}
        message={t('stickers.deleteStickerConfirm')}
        confirmText={t('common.delete')}
        cancelText={t('common.cancel')}
        type="danger"
        onConfirm={handleConfirmDeleteSticker}
        onCancel={() => setDeleteStickerConfirm(null)}
      />

      {/* Email Change Modal */}
      {showEmailModal && (
        <div className={`settings-modal-overlay ${(profile?.totp_enabled ?? user?.totp_enabled) && emailChangeStep === 'mfa' ? 'settings-modal-overlay--mfa' : 'settings-modal-overlay--form'}`} onClick={() => { setShowEmailModal(false); setEmailPassword(''); setEmailChangeMfaCode(''); setEmailChangeStep('form'); }}>
          <div className={`settings-modal ${(profile?.totp_enabled ?? user?.totp_enabled) && emailChangeStep === 'mfa' ? 'settings-modal--mfa' : 'settings-modal--form'}`} onClick={e => e.stopPropagation()}>
            {(profile?.totp_enabled ?? user?.totp_enabled) && emailChangeStep === 'mfa' ? (
              <>
                <div className="mfa-verify-modal__icon">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/>
                    <path d="M7 11V7a5 5 0 0 1 10 0v4"/>
                  </svg>
                </div>
                <h3>{t('account.mfaVerifyToContinue')}</h3>
                <p className="settings-modal-desc">{t('auth.mfaHint')}</p>
                <div className="settings-field">
                  <label>{t('account.mfaVerifyLabel')}</label>
                  <MfaCodeInput
                    value={emailChangeMfaCode}
                    onChange={setEmailChangeMfaCode}
                    autoFocus
                  />
                </div>
                <div className="settings-modal-actions">
                  <button type="button" className="btn-secondary" onClick={() => setEmailChangeStep('form')}>
                    {t('common.back')}
                  </button>
                  <button
                    type="button"
                    className="btn-primary"
                    disabled={saving || emailChangeMfaCode.replace(/\D/g, '').length < 6}
                    onClick={stageEmailChange}
                  >
                    {saving ? t('common.loading') : t('common.edit')}
                  </button>
                </div>
              </>
            ) : (
              <form onSubmit={(e) => { e.preventDefault(); (profile?.totp_enabled ?? user?.totp_enabled) ? setEmailChangeStep('mfa') : stageEmailChange(); }}>
                <div className="settings-modal-form__icon">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/>
                    <polyline points="22,6 12,13 2,6"/>
                  </svg>
                </div>
                <h3>{t('modals.changeEmail')}</h3>
                <div className="settings-field">
                  <label>{t('modals.newEmail')}</label>
                  <div className="settings-input-wrap">
                    <input
                      type="email"
                      value={newEmail}
                      onChange={e => setNewEmail(e.target.value)}
                      placeholder="email@example.com"
                      className="settings-input"
                      required
                    />
                  </div>
                </div>
                {!(profile?.totp_enabled ?? user?.totp_enabled) && (
                  <div className="settings-field">
                    <label>{t('account.currentPassword')}</label>
                    <div className="settings-input-wrap">
                      <input
                        type="password"
                        value={emailPassword}
                        onChange={e => setEmailPassword(e.target.value)}
                        placeholder="••••••••"
                        className="settings-input"
                        required
                      />
                    </div>
                  </div>
                )}
                <div className="settings-modal-actions">
                  <button type="button" className="btn-secondary" onClick={() => { setShowEmailModal(false); setEmailPassword(''); setEmailChangeMfaCode(''); setEmailChangeStep('form'); }}>
                    {t('common.cancel')}
                  </button>
                  <button
                    type="submit"
                    className="btn-primary"
                    disabled={saving || !newEmail || (!(profile?.totp_enabled ?? user?.totp_enabled) && !emailPassword)}
                  >
                    {(profile?.totp_enabled ?? user?.totp_enabled) ? t('account.mfaContinue') : t('common.edit')}
                  </button>
                </div>
              </form>
            )}
          </div>
        </div>
      )}

      {/* Password Change Modal */}
      {showPasswordModal && (
        <div
          className={`settings-modal-overlay ${(profile?.totp_enabled ?? user?.totp_enabled) && passwordChangeStep === 'mfa' ? 'settings-modal-overlay--mfa' : 'settings-modal-overlay--form'}`}
          onClick={() => {
            setShowPasswordModal(false);
            setCurrentPassword('');
            setNewPassword('');
            setConfirmPassword('');
            setPasswordChangeMfaCode('');
            setPasswordChangeStep('form');
          }}
        >
          <div className={`settings-modal ${(profile?.totp_enabled ?? user?.totp_enabled) && passwordChangeStep === 'mfa' ? 'settings-modal--mfa' : 'settings-modal--form'}`} onClick={e => e.stopPropagation()}>
            {(profile?.totp_enabled ?? user?.totp_enabled) && passwordChangeStep === 'mfa' ? (
              <>
                <div className="mfa-verify-modal__icon">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/>
                    <path d="M7 11V7a5 5 0 0 1 10 0v4"/>
                  </svg>
                </div>
                <h3>{t('account.mfaVerifyToContinue')}</h3>
                <p className="settings-modal-desc">{t('auth.mfaHint')}</p>
                <div className="settings-field">
                  <label>{t('account.mfaVerifyLabel')}</label>
                  <MfaCodeInput
                    value={passwordChangeMfaCode}
                    onChange={setPasswordChangeMfaCode}
                    autoFocus
                  />
                </div>
                <div className="settings-modal-actions">
                  <button type="button" className="btn-secondary" onClick={() => setPasswordChangeStep('form')}>
                    {t('common.back')}
                  </button>
                  <button
                    type="button"
                    className="btn-primary"
                    disabled={saving || passwordChangeMfaCode.replace(/\D/g, '').length < 6}
                    onClick={stagePasswordChange}
                  >
                    {saving ? t('common.loading') : t('account.changePassword')}
                  </button>
                </div>
              </>
            ) : (
              <form onSubmit={(e) => { e.preventDefault(); (profile?.totp_enabled ?? user?.totp_enabled) ? setPasswordChangeStep('mfa') : stagePasswordChange(); }}>
                <div className="settings-modal-form__icon">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/>
                    <path d="M7 11V7a5 5 0 0 1 10 0v4"/>
                  </svg>
                </div>
                <h3>{t('account.changePassword')}</h3>
                {!(profile?.totp_enabled ?? user?.totp_enabled) && (
                  <div className="settings-field">
                    <label>{t('account.currentPassword')}</label>
                    <input
                      type="password"
                      value={currentPassword}
                      onChange={(e) => setCurrentPassword(e.target.value)}
                      placeholder="••••••••"
                      className="settings-input"
                      autoComplete="current-password"
                    />
                  </div>
                )}
                <div className="settings-field">
                  <label>{t('account.newPassword')}</label>
                <input
                  type="password"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  placeholder="••••••••"
                  className="settings-input"
                  minLength={8}
                  autoComplete="new-password"
                />
                {newPassword && passwordValidation && (
                  <div className="password-strength">
                    <div className="password-strength-bar-container">
                      <div
                        className={`password-strength-bar ${passwordValidation.strength}`}
                        style={{
                          width:
                            passwordValidation.strength === 'weak' ? '33%' :
                            passwordValidation.strength === 'medium' ? '66%' : '100%',
                        }}
                      />
                    </div>
                    <span className={`password-strength-text ${passwordValidation.strength}`}>
                      {t(`account.passwordStrength.${passwordValidation.strength === 'very-strong' ? 'veryStrong' : passwordValidation.strength}`)}
                    </span>
                  </div>
                )}
              </div>
              <div className="settings-field">
                <label>{t('account.confirmNewPassword')}</label>
                <input
                  type="password"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  placeholder="••••••••"
                  className="settings-input"
                  minLength={8}
                  autoComplete="new-password"
                />
                {passwordsMatchError && (
                  <span className="field-error">{t('account.passwordsNotMatch')}</span>
                )}
              </div>
              <div className="settings-modal-actions">
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={() => {
                    setShowPasswordModal(false);
                    setCurrentPassword('');
                    setNewPassword('');
                    setConfirmPassword('');
                    setPasswordChangeMfaCode('');
                    setPasswordChangeStep('form');
                  }}
                >
                  {t('common.cancel')}
                </button>
                <button
                  type="submit"
                  className="btn-primary"
                  disabled={
                    saving ||
                    !newPassword ||
                    newPassword !== confirmPassword ||
                    (!(profile?.totp_enabled ?? user?.totp_enabled) && !currentPassword)
                  }
                >
                  {saving ? t('common.loading') : ((profile?.totp_enabled ?? user?.totp_enabled) ? t('account.mfaContinue') : t('account.changePassword'))}
                </button>
              </div>
            </form>
            )}
          </div>
        </div>
      )}

      {/* Username Change Modal */}
      {showUsernameModal && (
        <div className="settings-modal-overlay settings-modal-overlay--form" onClick={() => setShowUsernameModal(false)}>
          <div className="settings-modal settings-modal--form" onClick={e => e.stopPropagation()}>
            <div className="settings-modal-form__icon">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/>
                <circle cx="12" cy="7" r="4"/>
              </svg>
            </div>
            <h3>{t('modals.changeUsername')}</h3>
            <form onSubmit={stageUsernameChange}>
              <div className="settings-field">
                <label>{t('modals.newUsername')}</label>
                <div className="settings-input-prefix">
                  <span>@</span>
                  <input
                    type="text"
                    value={newUsername}
                    onChange={e => setNewUsername(e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, ''))}
                    placeholder="username"
                    className="settings-input"
                    minLength={3}
                    maxLength={32}
                    required
                  />
                </div>
                <span className="field-hint">{t('modals.usernameHint')}</span>
              </div>
              <div className="settings-modal-actions">
                <button type="button" className="btn-secondary" onClick={() => setShowUsernameModal(false)}>
                  {t('common.cancel')}
                </button>
                <button type="submit" className="btn-primary" disabled={saving}>
                  {saving ? t('common.loading') : t('common.edit')}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Phone Change Modal */}
      {showPhoneModal && (
        <div className="settings-modal-overlay settings-modal-overlay--form" onClick={() => setShowPhoneModal(false)}>
          <div className="settings-modal settings-modal--form settings-modal--phone" onClick={e => e.stopPropagation()}>
            <div className="settings-modal-form__icon">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/>
              </svg>
            </div>
            <h3>{phone ? t('modals.changePhone') : t('modals.addPhone')}</h3>
            <form onSubmit={(e) => { e.preventDefault(); stagePhoneChange(); }}>
              <div className="settings-field">
                <label>{t('modals.phoneNumber')}</label>
                <div className="settings-phone-field" ref={phoneCountryPickerRef}>
                  <button
                    type="button"
                    className="settings-phone-country-trigger"
                    onClick={() => setCountryPickerOpen(v => !v)}
                    aria-expanded={countryPickerOpen}
                  >
                    <span className="settings-phone-country-code">{selectedPhoneCountry.dialCode}</span>
                    <svg className={`settings-phone-country-caret${countryPickerOpen ? ' is-open' : ''}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <polyline points="6 9 12 15 18 9" />
                    </svg>
                  </button>
                  {countryPickerOpen && (
                    <div className="settings-phone-country-dropdown">
                      <input
                        type="text"
                        value={countryPickerQuery}
                        onChange={(e) => setCountryPickerQuery(e.target.value)}
                        placeholder="Search country..."
                        className="settings-phone-country-search"
                      />
                      <div className="settings-phone-country-list">
                        {filteredPhoneCountries.map((country) => (
                          <button
                            key={`${country.iso2}-${country.dialCode}`}
                            type="button"
                            className={`settings-phone-country-option${country.iso2 === selectedPhoneCountry.iso2 && country.dialCode === selectedPhoneCountry.dialCode ? ' is-active' : ''}`}
                            onClick={() => {
                              setSelectedPhoneCountry(country);
                              setLocalPhoneNumber((current) => formatPhoneLocalInput(current, country.iso2));
                              setCountryPickerOpen(false);
                            }}
                          >
                            <span className="settings-phone-country-option-name">{country.name}</span>
                            <span className="settings-phone-country-option-code">{country.dialCode}</span>
                          </button>
                        ))}
                        {!filteredPhoneCountries.length && (
                          <div className="settings-phone-country-empty">No country found.</div>
                        )}
                      </div>
                    </div>
                  )}
                  <div className="settings-input-wrap settings-phone-input-wrap">
                    <input
                      type="tel"
                      value={localPhoneNumber}
                      onChange={(e) => setLocalPhoneNumber(formatPhoneLocalInput(e.target.value, selectedPhoneCountry.iso2))}
                      placeholder="234 567 8900"
                      className="settings-input settings-phone-number-input"
                    />
                  </div>
                </div>
                <span className="field-hint">{t('modals.leaveEmpty')}</span>
              </div>
              <div className="settings-modal-actions">
                <button type="button" className="btn-secondary" onClick={() => setShowPhoneModal(false)}>
                  {t('common.cancel')}
                </button>
                <button type="submit" className="btn-primary" disabled={saving}>
                  {saving ? t('common.loading') : phone ? t('common.edit') : t('common.add')}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
      
      {/* Create Sticker Pack Modal */}
      {showCreatePackModal && (
        <div className="settings-modal-overlay" onClick={() => setShowCreatePackModal(false)}>
          <div className="settings-modal sticker-pack-modal" onClick={e => e.stopPropagation()}>
            <h3>{t('stickers.createPackTitle')}</h3>
            <form onSubmit={handleCreatePack}>
              <div className="settings-field">
                <label>{t('stickers.group')} *</label>
                <select
                  value={newPackTeam}
                  onChange={e => setNewPackTeam(e.target.value)}
                  className="settings-input"
                  required
                >
                  {userTeams.map(team => (
                    <option key={team.id} value={team.id}>{team.name}</option>
                  ))}
                </select>
                <span className="field-hint">{t('stickers.groupHint')}</span>
              </div>
              <div className="settings-field">
                <label>{t('stickers.packName')} *</label>
                <input
                  type="text"
                  value={newPackName}
                  onChange={e => setNewPackName(e.target.value)}
                  placeholder={t('stickers.packNamePlaceholder')}
                  className="settings-input"
                  maxLength={100}
                  required
                />
              </div>
              <div className="settings-field">
                <label>{t('stickers.packDescription')}</label>
                <input
                  type="text"
                  value={newPackDescription}
                  onChange={e => setNewPackDescription(e.target.value)}
                  placeholder={t('stickers.packDescPlaceholder')}
                  className="settings-input"
                  maxLength={255}
                />
              </div>
              <div className="settings-field">
                <label>{t('stickers.coverImage')}</label>
                <div className="sticker-cover-upload">
                  <input
                    type="file"
                    ref={coverFileInputRef}
                    accept="image/png,image/gif,image/webp,image/jpeg"
                    onChange={e => setNewPackCover(e.target.files[0])}
                    style={{ display: 'none' }}
                  />
                  <button type="button" className="btn-secondary" onClick={() => coverFileInputRef.current?.click()}>
                    {newPackCover ? newPackCover.name : t('stickers.chooseImage')}
                  </button>
                </div>
              </div>
              <div className="settings-modal-actions">
                <button type="button" className="btn-secondary" onClick={() => setShowCreatePackModal(false)}>
                  {t('common.cancel')}
                </button>
                <button type="submit" className="btn-primary" disabled={saving || !newPackName.trim()}>
                  {saving ? t('stickers.creating') : t('stickers.createPack')}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
      
      {/* Add Sticker Modal */}
      {showAddStickerModal && (
        <div className="settings-modal-overlay" onClick={() => setShowAddStickerModal(false)}>
          <div className="settings-modal sticker-add-modal" onClick={e => e.stopPropagation()}>
            <h3>{t('stickers.addSticker')}</h3>
            <form onSubmit={handleAddSticker}>
              <div className="settings-field">
                <label>{t('stickers.stickerImage')} *</label>
                <div className="sticker-upload-area">
                  <input
                    type="file"
                    ref={stickerFileInputRef}
                    accept="image/png,image/gif,image/webp,image/jpeg"
                    onChange={handleStickerFileChange}
                    style={{ display: 'none' }}
                  />
                  {newStickerPreview ? (
                    <div className="sticker-preview">
                      <img src={newStickerPreview} alt={t('chat.preview')} />
                      <button 
                        type="button" 
                        className="sticker-preview-remove"
                        onClick={() => { setNewStickerFile(null); setNewStickerPreview(null); }}
                      >
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                          <line x1="18" y1="6" x2="6" y2="18"/>
                          <line x1="6" y1="6" x2="18" y2="18"/>
                        </svg>
                      </button>
                    </div>
                  ) : (
                    <button 
                      type="button" 
                      className="sticker-upload-btn"
                      onClick={() => stickerFileInputRef.current?.click()}
                    >
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                        <polyline points="17 8 12 3 7 8"/>
                        <line x1="12" y1="3" x2="12" y2="15"/>
                      </svg>
                      <span>{t('stickers.clickToChoose')}</span>
                      <span className="sticker-upload-hint">{t('stickers.uploadHint')}</span>
                    </button>
                  )}
                </div>
              </div>
              <div className="settings-field">
                <label>{t('stickers.stickerName')}</label>
                <input
                  type="text"
                  value={newStickerName}
                  onChange={e => setNewStickerName(e.target.value)}
                  placeholder={t('stickers.stickerNamePlaceholder')}
                  className="settings-input"
                  maxLength={100}
                />
              </div>
              <div className="settings-modal-actions">
                <button type="button" className="btn-secondary" onClick={() => {
                  setShowAddStickerModal(false);
                  setNewStickerFile(null);
                  setNewStickerPreview(null);
                  setNewStickerName('');
                }}>
                  {t('common.cancel')}
                </button>
                <button type="submit" className="btn-primary" disabled={saving || !newStickerFile}>
                  {saving ? t('stickers.adding') : t('common.add')}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );

  if (typeof document === 'undefined') {
    return settingsOverlay;
  }

  return createPortal(settingsOverlay, document.body);
}

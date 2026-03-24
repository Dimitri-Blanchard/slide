import React, { useState, useEffect, useRef } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { Lock, ShieldCheck, Fingerprint, QrCode, Copy, Bug, CheckCircle2, Circle, Smartphone, Zap, ChevronRight, Lightbulb, Check } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { useLanguage } from '../context/LanguageContext';
import { useNotification } from '../context/NotificationContext';
import { useSettings } from '../context/SettingsContext';
import { getOrCreateDeviceId } from '../utils/tokenStorage';
import { auth, API_BASE } from '../api';

const SECURITY_SCROLL_KEY = 'slide_security_dashboard_scroll';

// Inlined fingerprint utilities to avoid dynamic-import failures when accessing via IP/HTTPS
const SALT = 'slide-e2ee-fingerprint-v1';
async function sha256Hex(text) {
  const encoder = new TextEncoder();
  const data = encoder.encode(text);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}
function formatFingerprint(hex) {
  const upper = hex.toUpperCase();
  const groups = [];
  for (let i = 0; i < upper.length; i += 4) groups.push(upper.slice(i, i + 4));
  return groups.join(' ');
}
async function generateFingerprint(user, options = {}) {
  if (!user?.id) return { formatted: '', rawHex: '', input: '' };
  const username = (user.username || user.display_name || String(user.id)).toLowerCase();
  const input = `${SALT}:${user.id}:${username}`;
  const hex = await sha256Hex(input);
  const formatted = formatFingerprint(hex.slice(0, 60));
  return {
    formatted,
    rawHex: options.includeRaw ? hex : '',
    input: options.includeRaw ? input : '',
  };
}
function buildVerificationPayload(user, fingerprint) {
  return `slide://verify?data=${encodeURIComponent(JSON.stringify({
    v: 1,
    type: 'slide-verify',
    id: String(user.id),
    username: user.username || '',
    displayName: user.display_name || '',
    fp: fingerprint.replace(/\s/g, ''),
    ts: Math.floor(Date.now() / 1000),
  }))}`;
}

export default function SecurityDashboard() {
  const { user, updateUser } = useAuth();
  const { t } = useLanguage();
  const { notify } = useNotification();
  const { developerMode } = useSettings();
  const navigate = useNavigate();
  const [fingerprint, setFingerprint] = useState('');
  const [fingerprintRaw, setFingerprintRaw] = useState({ rawHex: '', input: '' });
  const [verificationPayload, setVerificationPayload] = useState('');
  const [fingerprintCopied, setFingerprintCopied] = useState(false);
  const [payloadCopied, setPayloadCopied] = useState(false);
  const [devices, setDevices] = useState([]);
  const scrollRef = useRef(null);
  const location = useLocation();

  useEffect(() => {
    if (!user?.id) return;
    let cancelled = false;
    generateFingerprint(user, { includeRaw: developerMode }).then((res) => {
        if (!cancelled) {
        setFingerprint(res.formatted);
        if (res.rawHex) setFingerprintRaw({ rawHex: res.rawHex, input: res.input });
        else setFingerprintRaw({ rawHex: '', input: '' });
      }
    });
    return () => { cancelled = true; };
  }, [user, developerMode]);

  useEffect(() => {
    if (!fingerprint || !user?.id || !developerMode) return;
    setVerificationPayload(buildVerificationPayload(user, fingerprint));
  }, [fingerprint, user, developerMode]);

  useEffect(() => {
    auth.devices.list()
      .then(({ devices: list }) => setDevices(list || []))
      .catch(() => setDevices([]));
  }, []);

  // Refetch user on mount to ensure fresh 2FA status (auth/me returns totp_enabled)
  useEffect(() => {
    auth.me().then((data) => updateUser(data)).catch(() => {});
  }, [updateUser]);

  // Restore scroll position when returning from Settings
  useEffect(() => {
    const saved = sessionStorage.getItem(SECURITY_SCROLL_KEY);
    if (saved) {
      const y = parseInt(saved, 10);
      if (!isNaN(y) && y > 0) {
        sessionStorage.removeItem(SECURITY_SCROLL_KEY);
        const restore = () => {
          if (scrollRef.current) {
            scrollRef.current.scrollTop = y;
          }
        };
        requestAnimationFrame(() => requestAnimationFrame(restore));
      }
    }
  }, [location.pathname]);

  const handleGoToAccount = () => {
    if (scrollRef.current) {
      sessionStorage.setItem(SECURITY_SCROLL_KEY, String(scrollRef.current.scrollTop));
    }
    navigate('/settings?section=account');
  };

  // Security health metrics (2FA: use truthy check—backend may return 0/1 for boolean)
  const isHttps = typeof window !== 'undefined' && window.location?.protocol === 'https:';
  const webCryptoOk = typeof crypto !== 'undefined' && crypto.subtle != null;
  const has2FA = !!user?.totp_enabled;
  const hasFingerprint = !!fingerprint;
  const healthScore = Math.round(
    (hasFingerprint ? 25 : 0) +
    (has2FA ? 25 : 0) +
    (isHttps ? 25 : 0) +
    (webCryptoOk ? 25 : 0)
  );
  const healthLabel = healthScore >= 90 ? 'healthExcellent' : healthScore >= 70 ? 'healthGood' : healthScore >= 50 ? 'healthFair' : 'healthWeak';

  const handleCopyFingerprint = () => {
    if (!fingerprint) return;
    navigator.clipboard?.writeText(fingerprint).then(() => {
      setFingerprintCopied(true);
      notify.success(t('common.copied'));
      setTimeout(() => setFingerprintCopied(false), 2000);
    }).catch(() => {
      notify.error('Copy failed');
    });
  };

  // Developer mode debug info
  const devInfo = developerMode ? (() => {
    const deviceId = getOrCreateDeviceId();
    const apiBase = API_BASE;
    const cryptoAvailable = typeof crypto !== 'undefined' && crypto.subtle != null;
    return {
      deviceId: deviceId ? `${deviceId.slice(0, 12)}...` : '—',
      apiBase,
      cryptoAvailable,
      userId: user?.id ?? '—',
    };
  })() : null;

  return (
    <div ref={scrollRef} className="security-dashboard-scroll">
      <div className="security-dashboard">
      {/* Hero trust banner - always visible at top */}
      <div className="security-dashboard-header">
        <h1 className="security-dashboard-title">{t('securityDashboard.title')}</h1>
        <p className="security-dashboard-subtitle">{t('securityDashboard.subtitle')}</p>
      </div>

      <div className="security-dashboard-content">
        {/* Security Health Score */}
        <section className="security-card security-health-card">
          <div className="security-card-header">
            <Zap size={24} strokeWidth={1.5} />
            <h2>{t('securityDashboard.healthScore')}</h2>
          </div>
          <p className="security-card-desc">{t('securityDashboard.healthScoreDesc')}</p>
          <div className="security-health-gauge-wrap">
            <div className="security-health-gauge" role="meter" aria-valuenow={healthScore} aria-valuemin={0} aria-valuemax={100}>
              <svg viewBox="0 0 120 120" className="security-health-svg">
                <circle className="security-health-bg" cx="60" cy="60" r="52" />
                <circle
                  className="security-health-fill"
                  cx="60"
                  cy="60"
                  r="52"
                  style={{ strokeDasharray: `${(healthScore / 100) * 327} 327` }}
                />
              </svg>
              <span className="security-health-value">{healthScore}</span>
            </div>
            <span className={`security-health-label security-health-label--${healthScore >= 90 ? 'excellent' : healthScore >= 70 ? 'good' : healthScore >= 50 ? 'fair' : 'weak'}`}>
              {t(`securityDashboard.${healthLabel}`)}
            </span>
          </div>
        </section>

        {/* Security Checklist */}
        <section className="security-card security-checklist-card">
          <div className="security-card-header">
            <ShieldCheck size={24} strokeWidth={1.5} />
            <h2>{t('securityDashboard.securityChecklist')}</h2>
          </div>
          <ul className="security-checklist-list">
            <li className={hasFingerprint ? 'done' : ''}>
              {hasFingerprint ? <CheckCircle2 size={18} /> : <Circle size={18} />}
              <span>{t('securityDashboard.checklistFingerprint')}</span>
            </li>
            <li className={has2FA ? 'done' : ''}>
              {has2FA ? <CheckCircle2 size={18} /> : <Circle size={18} />}
              <span>{t('securityDashboard.checklist2FA')}</span>
            </li>
            <li className={isHttps ? 'done' : ''}>
              {isHttps ? <CheckCircle2 size={18} /> : <Circle size={18} />}
              <span>{t('securityDashboard.checklistSecureConnection')}</span>
            </li>
          </ul>
        </section>

        {/* Connection Security & Trusted Devices - two-column on wider screens */}
        <div className="security-dashboard-row">
          <section className="security-card security-connection-card">
            <div className="security-card-header">
              <Lock size={24} strokeWidth={1.5} />
              <h2>{t('securityDashboard.connectionSecurity')}</h2>
            </div>
            <dl className="security-connection-dl">
              <div className={isHttps ? 'ok' : 'warn'}>
                <dt>{isHttps ? t('securityDashboard.protocolHttps') : t('securityDashboard.protocolHttp')}</dt>
                <dd>{isHttps ? t('securityDashboard.connectionSecure') : t('securityDashboard.connectionInsecure')}</dd>
              </div>
              <div className={webCryptoOk ? 'ok' : 'warn'}>
                <dt>{t('securityDashboard.webCryptoAvailable')}</dt>
                <dd>{webCryptoOk ? '✓' : '✗'}</dd>
              </div>
            </dl>
          </section>
          <section className="security-card security-devices-card">
            <div className="security-card-header">
              <Smartphone size={24} strokeWidth={1.5} />
              <h2>{t('securityDashboard.trustedDevices')}</h2>
            </div>
            <p className="security-devices-count">
              {(t('securityDashboard.devicesCount') || '{count} device(s) connected').replace('{count}', String(devices.length))}
            </p>
            <button type="button" className="security-manage-btn" onClick={handleGoToAccount}>
              <span>{t('securityDashboard.manageDevices')}</span>
              <ChevronRight size={16} />
            </button>
          </section>
        </div>

        {/* Encryption Specs */}
        <section className="security-card security-specs-card">
          <div className="security-card-header">
            <Lock size={24} strokeWidth={1.5} />
            <h2>{t('securityDashboard.encryptionSpecs')}</h2>
          </div>
          <dl className="security-specs-dl">
            <dt>{t('securityDashboard.encryptionAlgorithm')}</dt>
            <dd>XChaCha20-Poly1305 (E2EE default)</dd>
            <dt>{t('securityDashboard.encryptionKeyExchange')}</dt>
            <dd>Signal Protocol (X3DH)</dd>
            <dt>{t('securityDashboard.encryptionIntegrity')}</dt>
            <dd>SHA-256 fingerprint</dd>
          </dl>
        </section>

        <section className="security-card">
          <div className="security-card-header">
            <Fingerprint size={24} strokeWidth={1.5} />
            <h2>{t('securityDashboard.keyFingerprint')}</h2>
          </div>
          <p className="security-card-desc">{t('securityDashboard.keyFingerprintDesc')}</p>
          {fingerprint ? (
            <div className="security-fingerprint-value">
              <code className="security-fingerprint-code">{fingerprint}</code>
              <button
                type="button"
                className={`security-copy-btn ${fingerprintCopied ? 'copied' : ''}`}
                onClick={handleCopyFingerprint}
                title={t('common.copy') || 'Copy'}
              >
                {fingerprintCopied ? (
                  <>
                    <Check size={16} className="security-copy-icon-check" />
                    <span>{t('common.copied') || 'Copied!'}</span>
                  </>
                ) : (
                  <>
                    <Copy size={16} className="security-copy-icon-copy" />
                    <span>{t('common.copy') || 'Copy'}</span>
                  </>
                )}
              </button>
            </div>
          ) : (
            <div className="security-fingerprint-loading">{t('common.loading')}</div>
          )}
        </section>

        <section className="security-card security-recommendations-card">
          <div className="security-card-header">
            <Lightbulb size={24} strokeWidth={1.5} />
            <h2>{t('securityDashboard.securityRecommendations')}</h2>
          </div>
          <p className="security-card-desc">{t('securityDashboard.securityRecommendationsDesc')}</p>
          <ul className="security-recommendations-list">
            <li>{t('securityDashboard.recommendationChangePassword')}</li>
            <li>{t('securityDashboard.recommendationRevokeDevices')}</li>
            <li>{t('securityDashboard.recommendationShareFingerprint')}</li>
            <li>{t('securityDashboard.recommendationStrongPassword')}</li>
          </ul>
          <button type="button" className="security-manage-btn" onClick={handleGoToAccount}>
            <span>{t('securityDashboard.goToAccount')}</span>
            <ChevronRight size={16} />
          </button>
        </section>

        <section className="security-card security-badge-card">
          <div className="security-card-header">
            <ShieldCheck size={24} strokeWidth={1.5} />
            <h2>{t('securityDashboard.verifiedSecureBadge')}</h2>
          </div>
          <p className="security-card-desc">{t('securityDashboard.verifiedSecureDesc')}</p>
          <div className="security-badge-banner">
            <Lock size={18} />
            <span>{t('securityDashboard.allChatsLocked')}</span>
          </div>
        </section>

        {developerMode && devInfo ? (
          <>
            <section className="security-card security-dev-card">
              <div className="security-card-header">
                <Bug size={24} strokeWidth={1.5} />
                <h2>{t('securityDashboard.devTitle')}</h2>
              </div>
              <p className="security-card-desc">{t('securityDashboard.devDesc')}</p>
              <dl className="security-dev-dl">
                <dt>{t('securityDashboard.devUserId')}</dt>
                <dd><code>{devInfo.userId === 0 || devInfo.userId == null || devInfo.userId === '' ? '—' : String(devInfo.userId)}</code></dd>
                <dt>{t('securityDashboard.devDeviceId')}</dt>
                <dd><code>{devInfo.deviceId}</code></dd>
                <dt>{t('securityDashboard.devApiBase')}</dt>
                <dd><code className="security-dev-code-wrap">{devInfo.apiBase}</code></dd>
                <dt>{t('securityDashboard.devCrypto')}</dt>
                <dd><code>{devInfo.cryptoAvailable ? 'Web Crypto API ✓' : '✗'}</code></dd>
                <dt>{t('securityDashboard.devAlgorithm')}</dt>
                <dd><code>SHA-256, Salt: {SALT}</code></dd>
              </dl>
            </section>

            {fingerprintRaw.rawHex ? (
              <section className="security-card security-dev-card">
                <div className="security-card-header">
                  <Fingerprint size={24} strokeWidth={1.5} />
                  <h2>{t('securityDashboard.devFingerprintDerivation')}</h2>
                </div>
                <p className="security-card-desc">{t('securityDashboard.devFingerprintDesc')}</p>
                <dl className="security-dev-dl">
                  <dt>{t('securityDashboard.devInput')}</dt>
                  <dd><code className="security-dev-code-wrap">{fingerprintRaw.input}</code></dd>
                  <dt>{t('securityDashboard.devRawHex')}</dt>
                  <dd><code className="security-dev-code-wrap">{fingerprintRaw.rawHex}</code></dd>
                </dl>
              </section>
            ) : null}

            {verificationPayload ? (
              <section className="security-card security-dev-card">
                <div className="security-card-header">
                  <QrCode size={24} strokeWidth={1.5} />
                  <h2>{t('securityDashboard.devVerificationPayload')}</h2>
                </div>
                <p className="security-card-desc">{t('securityDashboard.devVerificationDesc')}</p>
                <div className="security-fingerprint-value">
                  <code className="security-fingerprint-code security-dev-payload">{verificationPayload}</code>
                  <button
                    type="button"
                    className={`security-copy-btn ${payloadCopied ? 'copied' : ''}`}
                    onClick={() => {
                      navigator.clipboard?.writeText(verificationPayload).then(() => {
                        setPayloadCopied(true);
                        notify.success(t('common.copied'));
                        setTimeout(() => setPayloadCopied(false), 2000);
                      }).catch(() => notify.error('Copy failed'));
                    }}
                    title={t('common.copy')}
                  >
                    {payloadCopied ? (
                      <>
                        <Check size={16} className="security-copy-icon-check" />
                        <span>{t('common.copied')}</span>
                      </>
                    ) : (
                      <>
                        <Copy size={16} className="security-copy-icon-copy" />
                        <span>{t('common.copy')}</span>
                      </>
                    )}
                  </button>
                </div>
              </section>
            ) : null}
          </>
        ) : null}
      </div>
      </div>
    </div>
  );
}

import React, { useState, useMemo, useEffect } from 'react';
import { Zap, Video, Volume2, Upload, Monitor, Mic2, ChevronRight, ShieldCheck, X, Sparkles, Crown } from 'lucide-react';
import confetti from 'canvas-confetti';
import { useAuth } from '../context/AuthContext';
import { useLanguage } from '../context/LanguageContext';
import { useNotification } from '../context/NotificationContext';
import { nitro as nitroApi } from '../api';
import { formatNitroPriceMonthly } from '../utils/currency';

function fireNitroConfetti() {
  const defaults = { origin: { y: 0.6 }, disableForReducedMotion: true, zIndex: 10000 };
  const colors = ['#8b5cf6', '#a78bfa', '#818cf8', '#6366f1', '#FEE75C', '#EB459E', '#57F287', '#c4b5fd'];
  confetti({ ...defaults, particleCount: 150, spread: 90, colors });
  confetti({ ...defaults, particleCount: 60, spread: 100, scalar: 1.4, shapes: ['circle'], colors: ['#a78bfa', '#c4b5fd', '#FEE75C'] });
  setTimeout(() => {
    confetti({ ...defaults, particleCount: 80, angle: 60, spread: 75, origin: { x: 0 }, colors });
    confetti({ ...defaults, particleCount: 80, angle: 120, spread: 75, origin: { x: 1 }, colors });
  }, 100);
  setTimeout(() => {
    confetti({ ...defaults, particleCount: 60, startVelocity: 35, spread: 360, origin: { y: 0.2 }, colors });
  }, 250);
  setTimeout(() => {
    confetti({ ...defaults, particleCount: 50, angle: 90, spread: 100, origin: { y: 0.8 }, colors, startVelocity: 45 });
  }, 500);
}

const QUALITY_BENEFITS = [
  { icon: Video, labelKey: 'nitro.hdVideo', descKey: 'nitro.hdVideoDesc', specKey: 'nitro.hdVideoSpec' },
  { icon: Volume2, labelKey: 'nitro.highFidelity', descKey: 'nitro.highFidelityDesc', specKey: 'nitro.highFidelitySpec' },
  { icon: Upload, labelKey: 'nitro.largerUploads', descKey: 'nitro.largerUploadsDesc', specKey: 'nitro.largerUploadsSpec' },
  { icon: Monitor, labelKey: 'nitro.hdScreenShare', descKey: 'nitro.hdScreenShareDesc', specKey: 'nitro.hdScreenShareSpec' },
  { icon: Mic2, labelKey: 'nitro.voiceQuality', descKey: 'nitro.voiceQualityDesc', specKey: 'nitro.voiceQualitySpec' },
];

const QUALITY_COMPARISON = [
  { featureKey: 'nitro.specVideo', basic: '720p', nitro: '1080p @ 60fps', basicPct: 42, nitroPct: 100 },
  { featureKey: 'nitro.specAudio', basic: '48 kHz', nitro: '96 kHz stereo', basicPct: 50, nitroPct: 100 },
  { featureKey: 'nitro.specUploads', basic: '50 MB', nitro: '500 MB', basicPct: 10, nitroPct: 100 },
  { featureKey: 'nitro.specScreenShare', basic: '720p', nitro: '1080p @ 60fps', basicPct: 42, nitroPct: 100 },
  { featureKey: 'nitro.specVoice', basic: 'Standard', nitro: 'Enhanced HQ', basicPct: 60, nitroPct: 100 },
];

const PLAN_FEATURES = {
  basic: ['720p video calls', 'Standard audio', '50 MB uploads', '720p screen share', 'Basic voice quality'],
  nitro: ['1080p 60fps video', 'High-fidelity audio', '500 MB uploads', '1080p screen share', 'Enhanced voice'],
};

const STRIPE_CHECKOUT_URL = import.meta.env.VITE_STRIPE_CHECKOUT_URL || '';

export default function NitroPage() {
  const { user } = useAuth();
  const { t, language } = useLanguage();
  const { notify } = useNotification();
  const [showCheckout, setShowCheckout] = useState(false);
  const [waitlistSubmitting, setWaitlistSubmitting] = useState(false);
  const [waitlistDone, setWaitlistDone] = useState(false);
  const [launchPhase, setLaunchPhase] = useState(false);
  const [onWaitlist, setOnWaitlist] = useState(false);
  const [waitlistLoading, setWaitlistLoading] = useState(true);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    const id = setTimeout(() => setMounted(true), 50);
    return () => clearTimeout(id);
  }, []);

  useEffect(() => {
    if (!launchPhase) return;
    const t = setTimeout(() => {
      setLaunchPhase(false);
      fireNitroConfetti();
    }, 2800);
    return () => clearTimeout(t);
  }, [launchPhase]);

  useEffect(() => {
    if (!user?.id) {
      setWaitlistLoading(false);
      return;
    }
    nitroApi.getWaitlistStatus()
      .then(({ onWaitlist: ok }) => setOnWaitlist(!!ok))
      .catch(() => setOnWaitlist(false))
      .finally(() => setWaitlistLoading(false));
  }, [user?.id]);

  const nitroPriceFormatted = useMemo(
    () => formatNitroPriceMonthly(navigator.language, t('nitro.perMonth'), language),
    [t, language]
  );

  const handleUpgrade = async () => {
    if (onWaitlist) return;
    if (STRIPE_CHECKOUT_URL) {
      window.open(STRIPE_CHECKOUT_URL, '_blank', 'noopener');
      return;
    }
    if (!user?.email) {
      notify.error(t('nitro.signInToJoin'));
      return;
    }
    setShowCheckout(true);
    setWaitlistSubmitting(true);
    try {
      await nitroApi.joinWaitlist(user.email);
      setOnWaitlist(true);
      setWaitlistDone(true);
      setLaunchPhase(true);
      notify.success(t('nitro.waitlistSuccess'));
    } catch (err) {
      setShowCheckout(false);
      notify.error(err.message || t('nitro.waitlistError'));
    } finally {
      setWaitlistSubmitting(false);
    }
  };

  return (
    <div className={`nitro-page ${mounted ? 'nitro-page--mounted' : ''}`}>
      {/* Hero */}
      <div className="nitro-hero">
        <div className="nitro-hero-bg">
          <div className="nitro-hero-mesh" />
          <div className="nitro-hero-glow nitro-hero-glow-1" />
          <div className="nitro-hero-glow nitro-hero-glow-2" />
          <div className="nitro-hero-glow nitro-hero-glow-3" />
          <div className="nitro-hero-grid" aria-hidden="true" />
          <div className="nitro-hero-particles" aria-hidden="true">
            {[...Array(12)].map((_, i) => <span key={i} className="nitro-hero-particle" style={{ '--i': i }} />)}
          </div>
        </div>
        <div className="nitro-hero-content">
          {onWaitlist ? (
            <div className="nitro-hero-joined">
              <div className="nitro-hero-joined-badge">
                <Crown size={20} strokeWidth={2} />
                <span>{t('nitro.youreIn')}</span>
              </div>
              <h1 className="nitro-hero-title">
                <span className="nitro-hero-title-main nitro-hero-title-gradient">{t('nitro.youreOnTheList')}</span>
                <span className="nitro-hero-title-sub">{t('nitro.youreOnTheListSub')}</span>
              </h1>
              <p className="nitro-hero-tagline">{t('nitro.waitlistExclusive')}</p>
            </div>
          ) : (
            <>
              <div className="nitro-hero-badge">
                <Sparkles size={12} strokeWidth={2.5} className="nitro-hero-badge-icon" />
                <span>{t('nitro.premiumQuality')}</span>
              </div>
              <h1 className="nitro-hero-title">
                <span className="nitro-hero-title-main nitro-hero-title-gradient">{t('nitro.title')}</span>
                <span className="nitro-hero-title-sub">{t('nitro.titleSub')}</span>
              </h1>
              <p className="nitro-hero-tagline">{t('nitro.tagline')}</p>
              <div className="nitro-hero-cta-hint">
                <Zap size={16} strokeWidth={2} />
                <span>{t('nitro.seeQuality')}</span>
              </div>
            </>
          )}
        </div>
      </div>
      <div className="nitro-section-divider" aria-hidden="true" />

      <div className="nitro-content">
        {/* Security banner */}
        <section className="nitro-security-card nitro-reveal" style={{ '--reveal-delay': 0 }}>
          <div className="nitro-security-icon">
            <ShieldCheck size={24} strokeWidth={1.8} />
          </div>
          <div className="nitro-security-text">
            <h2>{t('nitro.securityFreeBanner')}</h2>
            <p>{t('nitro.securityFreeDesc')}</p>
            <p className="nitro-security-note">
              <strong>{t('nitro.nitroAdds')}</strong> {t('nitro.nitroAddsDesc')}
            </p>
          </div>
        </section>

        {/* Quality comparison with visual bars */}
        <section className="nitro-comparison-section nitro-reveal" style={{ '--reveal-delay': 1 }}>
          <h2 className="nitro-section-heading">{t('nitro.qualityComparison')}</h2>
          <div className="nitro-comparison-cards">
            {QUALITY_COMPARISON.map((row, i) => (
              <div key={i} className="nitro-comparison-card">
                <div className="nitro-comparison-card-label">{t(row.featureKey)}</div>
                <div className="nitro-quality-bars">
                  <div className="nitro-quality-bar-wrap">
                    <span className="nitro-quality-bar-label">{row.basic}</span>
                    <div className="nitro-quality-bar nitro-quality-bar-basic">
                      <div className="nitro-quality-bar-fill" style={{ width: `${row.basicPct}%` }} />
                    </div>
                  </div>
                  <div className="nitro-quality-bar-wrap">
                    <span className="nitro-quality-bar-label nitro-quality-bar-label-nitro">{row.nitro}</span>
                    <div className="nitro-quality-bar nitro-quality-bar-nitro">
                      <div className="nitro-quality-bar-fill nitro-quality-bar-fill-nitro" style={{ width: `${row.nitroPct}%` }} />
                    </div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </section>

        {/* Plans */}
        <section className="nitro-plans nitro-reveal" style={{ '--reveal-delay': 2 }}>
          <div className="nitro-plan-card nitro-plan-basic">
            <div className="nitro-plan-header">
              <h3>{t('nitro.basic')}</h3>
              <p className="nitro-plan-price">Free</p>
            </div>
            <ul className="nitro-plan-features">
              {PLAN_FEATURES.basic.map((f, i) => (
                <li key={i}><span className="nitro-check" aria-hidden>✓</span>{f}</li>
              ))}
            </ul>
          </div>
          <div className="nitro-plan-card nitro-plan-highlight">
            {onWaitlist ? (
              <div className="nitro-plan-joined">
                <div className="nitro-plan-joined-icon"><Crown size={32} strokeWidth={1.8} /></div>
                <h3>{t('nitro.youreIn')}</h3>
                <p>{t('nitro.alreadyOnList')}</p>
              </div>
            ) : (
              <>
                <div className="nitro-plan-ribbon">{t('nitro.bestValue')}</div>
                <div className="nitro-plan-header">
                  <h3>{t('nitro.nitroPlan')}</h3>
                  <p className="nitro-plan-price nitro-plan-price-accent">{nitroPriceFormatted}</p>
                </div>
                <ul className="nitro-plan-features">
                  {PLAN_FEATURES.nitro.map((f, i) => (
                    <li key={i}><span className="nitro-check" aria-hidden>✓</span>{f}</li>
                  ))}
                </ul>
                <button className="nitro-upgrade-btn" onClick={handleUpgrade} disabled={waitlistLoading}>
                  {t('nitro.upgrade')}
                  <ChevronRight size={18} strokeWidth={2.5} />
                </button>
              </>
            )}
          </div>
        </section>

        {/* Quality benefits grid */}
        <section className="nitro-benefits-section nitro-reveal" style={{ '--reveal-delay': 3 }}>
          <h2 className="nitro-section-heading">{t('nitro.qualityBenefits')}</h2>
          <div className="nitro-benefits-grid">
            {QUALITY_BENEFITS.map(({ icon: Icon, labelKey, descKey, specKey }, i) => (
              <div key={i} className="nitro-benefit-card" style={{ '--stagger': i }}>
                <div className="nitro-benefit-icon-wrap">
                  <Icon size={28} strokeWidth={1.5} className="nitro-benefit-icon" />
                </div>
                <h4>{t(labelKey)}</h4>
                <p>{t(descKey)}</p>
                <span className="nitro-benefit-spec">{t(specKey)}</span>
              </div>
            ))}
          </div>
        </section>

        {/* Final CTA */}
        <section className="nitro-cta-section nitro-reveal" style={{ '--reveal-delay': 4 }}>
          <div className="nitro-cta-card">
            <div className="nitro-cta-glow" aria-hidden="true" />
            {onWaitlist ? (
              <>
                <div className="nitro-cta-joined">
                  <Crown size={40} strokeWidth={1.5} />
                  <h3 className="nitro-cta-title">{t('nitro.waitlistCtaJoined')}</h3>
                  <p className="nitro-cta-desc">{t('nitro.waitlistCtaJoinedDesc')}</p>
                </div>
              </>
            ) : (
              <>
                <h3 className="nitro-cta-title">{t('nitro.ctaTitle')}</h3>
                <p className="nitro-cta-desc">{t('nitro.ctaDesc')}</p>
                <button className="nitro-upgrade-btn nitro-cta-btn" onClick={handleUpgrade} disabled={waitlistLoading}>
                  {t('nitro.upgrade')}
                  <ChevronRight size={20} strokeWidth={2.5} />
                </button>
              </>
            )}
          </div>
        </section>
      </div>

      {/* Success celebration modal */}
      {showCheckout && (
        <div className="nitro-checkout-overlay" onClick={() => waitlistDone && !launchPhase && setShowCheckout(false)}>
          <div className={`nitro-checkout-modal ${launchPhase ? 'nitro-checkout-modal-launch' : ''} ${waitlistDone && !launchPhase ? 'nitro-checkout-modal-celebration' : ''}`} onClick={e => e.stopPropagation()}>
            {launchPhase ? (
              <div className="nitro-launch-screen">
                <div className="nitro-launch-core">
                  <div className="nitro-launch-ring" />
                  <Zap size={36} strokeWidth={1.8} className="nitro-launch-icon" />
                </div>
                <p className="nitro-launch-text">{t('nitro.launching')}</p>
              </div>
            ) : waitlistDone ? (
              <>
                <div className="nitro-checkout-success nitro-checkout-success-memorable">
                  <div className="nitro-checkout-success-icon nitro-checkout-celebration">
                    <Crown size={64} strokeWidth={1.5} />
                  </div>
                  <h2 className="nitro-checkout-success-headline">{t('nitro.youreIn')}</h2>
                  <h3 className="nitro-checkout-success-title">{t('nitro.waitlistMemorable')}</h3>
                  <p className="nitro-checkout-success-desc">{t('nitro.waitlistMemorableDesc')}</p>
                  <p className="nitro-checkout-success-hint">{t('nitro.waitlistMemorableHint')}</p>
                  <button type="button" className="nitro-checkout-done nitro-checkout-done-delayed" onClick={() => setShowCheckout(false)} aria-label="Close">
                    {t('common.close')}
                  </button>
                </div>
              </>
            ) : (
              <div className="nitro-checkout-loading">
                <div className="nitro-checkout-loading-spinner" />
                <h3>{t('nitro.joiningWaitlist')}</h3>
                <p>{t('nitro.joiningWaitlistDesc')}</p>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

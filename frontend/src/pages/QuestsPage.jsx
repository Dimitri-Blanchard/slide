import React, { useState, useEffect, useCallback } from 'react';
import { Target, Trophy, Gift, CheckCircle2 } from 'lucide-react';
import confetti from 'canvas-confetti';
import { useLanguage } from '../context/LanguageContext';
import { useNotification } from '../context/NotificationContext';
import { quests as questsApi } from '../api';

const TAB_ICONS = { daily: Target, weekly: Trophy, seasonal: Gift };

function fireConfetti(orbsCount) {
  const count = Math.min(100, 50 + orbsCount);
  const defaults = { origin: { y: 0.6 } };
  confetti({
    ...defaults,
    particleCount: count,
    spread: 70,
    colors: ['#4f6ef7', '#22c55e', '#f59e0b', '#ec4899', '#ef4444'],
  });
  confetti({
    ...defaults,
    particleCount: Math.floor(count * 0.25),
    spread: 100,
    scalar: 1.2,
    shapes: ['circle'],
  });
  setTimeout(() => {
    confetti({
      ...defaults,
      particleCount: Math.floor(count * 0.3),
      angle: 60,
      spread: 55,
      origin: { x: 0 },
    });
    confetti({
      ...defaults,
      particleCount: Math.floor(count * 0.3),
      angle: 120,
      spread: 55,
      origin: { x: 1 },
    });
  }, 200);
}

export default function QuestsPage() {
  const [activeTab, setActiveTab] = useState('daily');
  const [quests, setQuests] = useState([]);
  const [loading, setLoading] = useState(true);
  const [claiming, setClaiming] = useState(null);
  const { t } = useLanguage();
  const { notify } = useNotification();

  useEffect(() => {
    setLoading(true);
    questsApi
      .list(activeTab)
      .then(({ quests: data }) => setQuests(data || []))
      .catch(() => {
        setQuests([]);
        notify.error('Failed to load quests');
      })
      .finally(() => setLoading(false));
  }, [activeTab]);

  const handleClaim = useCallback(async (quest) => {
    if (!quest.canClaim) return;
    setClaiming(quest.id);
    try {
      const { orbsEarned } = await questsApi.claim(quest.id);
      setQuests((prev) =>
        prev.map((q) =>
          q.id === quest.id ? { ...q, completed: true, canClaim: false } : q
        )
      );
      fireConfetti(orbsEarned || quest.rewardOrbs);
      notify.success(`${t('quests.claim')}! +${orbsEarned || quest.rewardOrbs} ${t('shop.orbs')}`);
    } catch (err) {
      notify.error(err?.message || 'Failed to claim');
    } finally {
      setClaiming(null);
    }
  }, [t, notify]);

  return (
    <div className="quests-page">
      <header className="quests-header">
        <h1 className="quests-title">{t('quests.title')}</h1>
        <p className="quests-description">{t('quests.description')}</p>
      </header>

      <div className="quests-tabs">
        {['daily', 'weekly', 'seasonal'].map((tab) => {
          const Icon = TAB_ICONS[tab];
          return (
            <button
              key={tab}
              className={`quests-tab ${activeTab === tab ? 'active' : ''}`}
              onClick={() => setActiveTab(tab)}
            >
              {Icon && <Icon size={18} />}
              <span>{t(`quests.${tab}`)}</span>
            </button>
          );
        })}
      </div>

      <div className="quests-content">
        {loading ? (
          <div className="quests-list">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="quest-card quest-card-skeleton">
                <div className="quest-skeleton-info">
                  <div className="quest-skeleton-title" />
                  <div className="quest-skeleton-desc" />
                  <div className="quest-skeleton-bar" />
                </div>
              </div>
            ))}
          </div>
        ) : quests.length === 0 ? (
          <div className="quests-empty">
            <Target size={48} strokeWidth={1.5} />
            <p>{t('quests.noQuests')}</p>
          </div>
        ) : (
          <div className="quests-list">
            {quests.map((quest) => {
              const canClaim = quest.canClaim && !quest.completed;
              const isClaiming = claiming === quest.id;
              const showCompleteBtn = !canClaim && !quest.completed;
              return (
                <div key={quest.id} className="quest-card">
                  <div className="quest-info">
                    <h3 className="quest-title">{t(quest.title)}</h3>
                    <p className="quest-desc">{t(quest.desc)}</p>
                    <div className="quest-progress-bar">
                      <div
                        className="quest-progress-fill"
                        style={{
                          width: `${Math.min(
                            (quest.progress / quest.totalSteps) * 100,
                            100
                          )}%`,
                        }}
                      />
                    </div>
                    <span className="quest-progress-text">
                      {quest.progress} / {quest.totalSteps}
                    </span>
                  </div>
                  <div className="quest-reward-section">
                    <span className="quest-reward">
                      {quest.rewardOrbs} {t('shop.orbs')}
                    </span>
                    {showCompleteBtn ? (
                      <span
                        className="quest-action-btn complete"
                        aria-disabled="true"
                      >
                        {t('quests.complete')}
                      </span>
                    ) : canClaim ? (
                      <button
                        type="button"
                        className="quest-action-btn claim"
                        disabled={isClaiming}
                        onClick={() => handleClaim(quest)}
                      >
                        {isClaiming ? '...' : t('quests.claim')}
                      </button>
                    ) : (
                      <span
                        className="quest-action-btn claimed"
                        aria-disabled="true"
                      >
                        <CheckCircle2 size={18} strokeWidth={2} className="quest-claimed-icon" />
                        {t('quests.claimed')}
                      </span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

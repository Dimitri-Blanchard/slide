import React, { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { useVoice } from '../context/VoiceContext';
import { useLanguage } from '../context/LanguageContext';
import { useSettings } from '../context/SettingsContext';
import { useSounds } from '../context/SoundContext';
import Avatar from './Avatar';
import './IncomingCallModal.css';

export default function IncomingCallModal() {
  const navigate = useNavigate();
  const { incomingCall, rejectIncomingCall, joinVoiceDM } = useVoice();
  const { t } = useLanguage();
  const { sendNotification } = useSettings();
  const { startRingtone, stopRingtone } = useSounds();

  useEffect(() => {
    if (!incomingCall) return;
    const callerName = incomingCall.caller?.display_name || 'Someone';
    // Request permission if needed so notification can show
    if ('Notification' in window && Notification.permission === 'default') {
      Notification.requestPermission().catch(() => {});
    }
    sendNotification(`${callerName} is calling you`, { body: 'Tap to answer', isCall: true });
    startRingtone({ force: true });
    return stopRingtone;
  }, [incomingCall, sendNotification, startRingtone, stopRingtone]);

  if (!incomingCall) return null;

  const { conversationId, caller } = incomingCall;

  const handleAccept = () => {
    stopRingtone();
    navigate(`/channels/@me/${conversationId}`);
    joinVoiceDM(conversationId, caller?.display_name);
  };

  const handleDecline = () => {
    stopRingtone();
    rejectIncomingCall(conversationId);
  };

  const modal = (
    <div className="incoming-call-overlay incoming-call-discord">
      <div className="incoming-call-modal">
        <div className="incoming-call-avatar-wrap">
          <div className="incoming-call-avatar-ring" />
          <Avatar user={caller} size="xlarge" showPresence={false} />
        </div>
        <h2 className="incoming-call-name">{caller?.display_name || t('chat.someone')}</h2>
        <p className="incoming-call-label">{t('friends.incomingCall', 'Incoming Call')}</p>
        <div className="incoming-call-actions">
          <button className="incoming-call-btn decline" onClick={handleDecline} title={t('friends.decline')}>
            <svg width="28" height="28" viewBox="0 0 24 24" fill="currentColor">
              <path d="M12 9c-1.6 0-3.15.25-4.6.72v3.1c0 .39-.23.74-.56.9-.98.49-1.87 1.12-2.66 1.85-.18.18-.43.28-.7.28-.28 0-.53-.11-.71-.29L.29 13.08c-.18-.17-.29-.42-.29-.7 0-.28.11-.53.29-.71C3.34 8.78 7.46 7 12 7s8.66 1.78 11.71 4.67c.18.18.29.43.29.71 0 .28-.11.53-.29.71l-2.48 2.48c-.18.18-.43.29-.71.29-.27 0-.52-.11-.7-.28-.79-.74-1.69-1.36-2.67-1.85-.33-.16-.56-.5-.56-.9v-3.1C15.15 9.25 13.6 9 12 9z"/>
            </svg>
            <span>{t('friends.decline')}</span>
          </button>
          <button className="incoming-call-btn accept" onClick={handleAccept} title={t('friends.accept')}>
            <svg width="28" height="28" viewBox="0 0 24 24" fill="currentColor">
              <path d="M12 9c-1.6 0-3.15.25-4.6.72v3.1c0 .39-.23.74-.56.9-.98.49-1.87 1.12-2.66 1.85-.18.18-.43.28-.7.28-.28 0-.53-.11-.71-.29L.29 13.08c-.18-.17-.29-.42-.29-.7 0-.28.11-.53.29-.71C3.34 8.78 7.46 7 12 7s8.66 1.78 11.71 4.67c.18.18.29.43.29.71 0 .28-.11.53-.29.71l-2.48 2.48c-.18.18-.43.29-.71.29-.27 0-.52-.11-.7-.28-.79-.74-1.69-1.36-2.67-1.85-.33-.16-.56-.5-.56-.9v-3.1C15.15 9.25 13.6 9 12 9z"/>
            </svg>
            <span>{t('friends.accept')}</span>
          </button>
        </div>
      </div>
    </div>
  );

  return createPortal(modal, document.body);
}

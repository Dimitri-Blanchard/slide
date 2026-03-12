import React, { memo, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { Mic, MicOff, PhoneOff, PhoneCall } from 'lucide-react';
import { useVoice } from '../context/VoiceContext';
import { useAuth } from '../context/AuthContext';
import { AvatarImg } from './Avatar';
import './DMCallPiP.css';

const DMCallPiP = memo(function DMCallPiP({ conversationId, conversationName, avatarUrl }) {
  const navigate = useNavigate();
  const { user } = useAuth();
  const {
    voiceUsers,
    connectionState,
    speakingUsers,
    isMuted,
    toggleMute,
    leaveVoiceDM,
  } = useVoice();

  const dmKey = `dm_${conversationId}`;
  const participants = voiceUsers[dmKey] || [];
  const others = participants.filter((p) => p.id !== user?.id);
  const activeSpeaker = others.find((p) => speakingUsers.has(p.id));
  const isConnecting = connectionState === 'connecting';
  const statusText = isConnecting
    ? 'Connecting...'
    : others.length > 0
      ? `In call with ${others.length > 1 ? `${others.length} people` : (others[0]?.display_name || 'someone')}`
      : 'Calling...';

  const title = conversationName || others[0]?.display_name || 'Call';
  const pictureUrl = activeSpeaker?.avatar_url || others[0]?.avatar_url || avatarUrl || null;
  const isSpeaking = useMemo(
    () => others.some((p) => speakingUsers.has(p.id)),
    [others, speakingUsers]
  );

  return (
    <div className={`dm-call-pip ${isSpeaking ? 'speaking' : ''}`}>
      <button
        type="button"
        className="dm-call-pip-main"
        onClick={() => navigate(`/channels/@me/${conversationId}`)}
        title="Open call"
      >
        <span className="dm-call-pip-avatar-wrap">
          {pictureUrl ? (
            <AvatarImg src={pictureUrl} alt={title} />
          ) : (
            <span className="dm-call-pip-avatar-fallback">
              {title.charAt(0).toUpperCase()}
            </span>
          )}
        </span>
        <span className="dm-call-pip-meta">
          <span className="dm-call-pip-title">{title}</span>
          <span className="dm-call-pip-status">{statusText}</span>
        </span>
      </button>
      <div className="dm-call-pip-actions">
        <button
          type="button"
          className={`dm-call-pip-btn ${isMuted ? 'danger' : ''}`}
          onClick={toggleMute}
          title={isMuted ? 'Unmute' : 'Mute'}
        >
          {isMuted ? <MicOff size={16} /> : <Mic size={16} />}
        </button>
        <button
          type="button"
          className="dm-call-pip-btn"
          onClick={() => navigate(`/channels/@me/${conversationId}`)}
          title="Open call"
        >
          <PhoneCall size={16} />
        </button>
        <button
          type="button"
          className="dm-call-pip-btn leave"
          onClick={leaveVoiceDM}
          title="Leave call"
        >
          <PhoneOff size={16} />
        </button>
      </div>
    </div>
  );
});

export default DMCallPiP;

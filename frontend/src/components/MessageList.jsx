import React, { useEffect, useLayoutEffect, useRef, useMemo, memo, useCallback, useState, forwardRef, useImperativeHandle } from 'react';
import { createPortal } from 'react-dom';
import { useVirtualizer } from '@tanstack/react-virtual';
import { Link } from 'react-router-dom';
import { Bot, Camera, Check, ChevronRight, Download, Eye, EyeOff, Lock, Maximize2, Minimize2, Palette, Paperclip, Pause, Phone, Play, Send, UserPlus, Volume2, VolumeX } from 'lucide-react';
import ClickableAvatar from './ClickableAvatar';
import ProfileCard from './ProfileCard';
import ReactionPicker, { MessageReactions } from './ReactionPicker';
import InviteLinkPreview, { containsInviteLink } from './InviteLinkPreview';
import LinkEmbed, { getEmbeddableUrls } from './LinkEmbed';
import { useSettings } from '../context/SettingsContext';
import { useLanguage } from '../context/LanguageContext';
import { stickers as stickersApi, users as usersApi, friends as friendsApi } from '../api';
import ReportModal from './ReportModal';
import { useBlockedUsers } from '../hooks/useBlockedUsers';
import { usePrefetchOnHover } from '../context/PrefetchContext';
import { getRecentEmojis, saveRecentEmoji } from './StickerPicker';
import { shortcodeToEmoji, emojiToShortcode, emojifyText } from '../utils/emojiShortcodes';
import { emojiToAranjaUrl } from '../utils/emojiAranja';
import { Spoiler, parseInlineMarkdown, parseMessageContent as _parseMarkdown, HAS_MARKDOWN_RE } from '../utils/markdownParser';
import { getStaticUrl } from '../utils/staticUrl';
import TextWithAranjaEmojis from './TextWithAranjaEmojis';
import ContextMenu from './ContextMenu';
import './MessageList.css';
import './MentionSuggestions.css';

const EMPTY_REACTIONS = [];
const VIRTUALIZATION_THRESHOLD = 80; // Activer la virtualisation à partir de 80 messages
const ESTIMATED_MESSAGE_HEIGHT = 56;

// ── Blocked message placeholder (Discord-style) ────────────
const BlockedMessage = memo(function BlockedMessage({ onReveal, t }) {
  return (
    <button
      type="button"
      className="message-blocked"
      onClick={(e) => { e.stopPropagation(); onReveal?.(); }}
      title={t('chat.clickToRevealBlocked')}
    >
      <span className="message-blocked-icon">
        <EyeOff size={16} strokeWidth={2} />
      </span>
      <span className="message-blocked-text">{t('chat.blockedMessageTitle')}</span>
      <span className="message-blocked-reveal">{t('chat.clickToRevealBlocked')}</span>
    </button>
  );
});

// ── Image URL extractor ────────────────────────────────────
const IMAGE_URL_RE = /https?:\/\/\S+\.(?:jpg|jpeg|png|gif|webp|svg)(?:\?\S*)?/gi;
const PLAIN_URL_RE = /https?:\/\/[^\s<>'"]+/g;

function extractImageUrls(text) {
  IMAGE_URL_RE.lastIndex = 0;
  const matches = text.match(IMAGE_URL_RE);
  return matches ? [...new Set(matches)] : [];
}

// ── Single emoji detection: true only if the message is exactly one emoji, nothing else ──
// Converts shortcodes like :smile: to real emoji chars before checking.
function isEmojiOnlyMessage(text) {
  if (!text) return false;
  const trimmed = emojifyText(text).trim();
  if (!trimmed) return false;
  try {
    const segs = [...new Intl.Segmenter().segment(trimmed)];
    const emojiSegs = segs.filter(s => /\p{Emoji}/u.test(s.segment));
    return emojiSegs.length === 1 && segs.every(s => /\p{Emoji}/u.test(s.segment) || /^\s+$/.test(s.segment));
  } catch {
    return /^\p{Emoji_Presentation}$/u.test(trimmed);
  }
}

// ── Full message content parser (delegates to util, adds image embeds) ──
function parseMessageContent(text, currentUserName, mentionUsers = [], onMentionClick = null) {
  if (!text) return text;
  const parsed = _parseMarkdown(text, currentUserName, mentionUsers, onMentionClick);
  const result = Array.isArray(parsed) ? [...parsed] : [parsed];

  // Image embeds below message text
  const imageUrls = extractImageUrls(text);
  if (imageUrls.length > 0) {
    result.push(
      <div key="embeds" className="md-embeds">
        {imageUrls.map((url, idx) => (
          <img key={idx} src={url} alt="" className="md-embed-image" loading="lazy" />
        ))}
      </div>
    );
  }
  return result.length > 0 ? result : text;
}

// Clickable sender name that opens profile card popup
const ClickableSenderName = memo(function ClickableSenderName({ user, t, serverRoleBadges, serverTeamRole }) {
  const [showProfile, setShowProfile] = useState(false);
  const [clickPos, setClickPos] = useState(null);
  const { onMouseEnter, onMouseLeave } = usePrefetchOnHover();

  const handleClick = useCallback((e) => {
    e.stopPropagation();
    setClickPos({ x: e.clientX, y: e.clientY });
    setShowProfile(true);
  }, []);

  // Role color: only apply if the role has show_separately=true (signified by role_color being set)
  const roleColor = user?.role_color || null;

  return (
    <>
      <span
        className={`message-sender message-sender-clickable${roleColor ? ' message-sender-role-color' : ''}`}
        style={roleColor ? { color: roleColor } : undefined}
        title={roleColor && user?.role_name ? user.role_name : undefined}
        onClick={handleClick}
        onMouseEnter={() => onMouseEnter(user?.id, user)}
        onMouseLeave={onMouseLeave}
      >
        {user?.display_name || t('chat.user')}
        {user?.equipped_nameplate_id && (
          <span className={`message-nameplate message-nameplate-${user.equipped_nameplate_id}`} title={user.equipped_nameplate_id === 5 ? 'Gold Badge' : user.equipped_nameplate_id === 9 ? 'Silver Badge' : ''}>
            {user.equipped_nameplate_id === 5 ? '★' : user.equipped_nameplate_id === 9 ? '◆' : ''}
          </span>
        )}
      </span>
      <ProfileCard
        userId={user?.id}
        user={user}
        isOpen={showProfile}
        onClose={() => setShowProfile(false)}
        clickPos={clickPos}
        position="right"
        serverRoleBadges={serverRoleBadges}
        serverTeamRole={serverTeamRole}
      />
    </>
  );
});

// Format file size
function formatFileSize(bytes) {
  if (!bytes) return '';
  if (bytes < 1024) return bytes + ' o';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' Ko';
  return (bytes / (1024 * 1024)).toFixed(1) + ' Mo';
}

// Format duration as MM:SS
function formatDuration(seconds) {
  if (!seconds || isNaN(seconds) || !isFinite(seconds)) return '0:00';
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

// Electron: simple HTML5 Audio player — Web Audio API can crash the renderer
const VoiceMessagePlayerSimple = memo(function VoiceMessagePlayerSimple({ src, pending, failed }) {
  const audioRef = useRef(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const togglePlay = useCallback(() => {
    const a = audioRef.current;
    if (!a || pending || failed) return;
    if (a.paused) {
      a.play().catch(() => {});
      setIsPlaying(true);
    } else {
      a.pause();
      setIsPlaying(false);
    }
  }, [pending, failed]);
  useEffect(() => {
    const a = audioRef.current;
    if (!a) return;
    const onEnd = () => setIsPlaying(false);
    const onPlay = () => setIsPlaying(true);
    const onPause = () => setIsPlaying(false);
    a.addEventListener('ended', onEnd);
    a.addEventListener('play', onPlay);
    a.addEventListener('pause', onPause);
    return () => {
      a.removeEventListener('ended', onEnd);
      a.removeEventListener('play', onPlay);
      a.removeEventListener('pause', onPause);
    };
  }, [src]);
  if (pending) {
    return (
      <div className="voice-message pending">
        <button className="voice-message-play" disabled><span className="voice-message-spinner" /></button>
        <div className="voice-message-body"><div className="voice-message-waveform" /></div>
      </div>
    );
  }
  if (failed) {
    return (
      <div className="voice-message failed">
        <button className="voice-message-play" disabled>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
        </button>
        <div className="voice-message-body"><span className="voice-message-time">0:00</span></div>
      </div>
    );
  }
  return (
    <div className={`voice-message ${isPlaying ? 'playing' : ''}`}>
      <audio ref={audioRef} src={src} preload="metadata" />
      <button className="voice-message-play" onClick={togglePlay}>
        {isPlaying ? (
          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16" rx="1.5" /><rect x="14" y="4" width="4" height="16" rx="1.5" /></svg>
        ) : (
          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M7 4.5v15l13-7.5z" /></svg>
        )}
      </button>
      <div className="voice-message-body">
        <div className="voice-message-waveform" style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
          {Array.from({ length: 24 }, (_, i) => <div key={i} className="voice-message-bar" style={{ height: `${20 + (i % 5) * 15}%` }} />)}
        </div>
        <div className="voice-message-info"><span className="voice-message-time">Voice message</span></div>
      </div>
    </div>
  );
});

// Voice message player — uses Web Audio API for reliable seeking on WebM
// In Electron, use simple HTML5 Audio to avoid renderer crashes
const VoiceMessagePlayer = memo(function VoiceMessagePlayer({ src, fileName, pending, failed, initialDuration }) {
  const isElectron = typeof window !== 'undefined' && window.electron?.isElectron;
  if (isElectron) {
    return <VoiceMessagePlayerSimple src={src} pending={pending} failed={failed} />;
  }
  return <VoiceMessagePlayerFull src={src} fileName={fileName} pending={pending} failed={failed} initialDuration={initialDuration} />;
});

const VoiceMessagePlayerFull = memo(function VoiceMessagePlayerFull({ src, fileName, pending, failed, initialDuration }) {
  const { settings } = useSettings();
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(initialDuration || 0);
  const [waveformBars, setWaveformBars] = useState([]);
  const [isDragging, setIsDragging] = useState(false);
  const [playbackRate, setPlaybackRate] = useState(1);
  const [loaded, setLoaded] = useState(false);

  const waveformRef = useRef(null);
  const dragRef = useRef(false);

  // Web Audio API refs
  const ctxRef = useRef(null);
  const bufferRef = useRef(null);
  const sourceRef = useRef(null);
  const startCtxTimeRef = useRef(0);
  const offsetRef = useRef(0);
  const rafRef = useRef(null);
  const playingRef = useRef(false);
  const rateRef = useRef(1);
  const durationRef = useRef(0);
  const streamDestRef = useRef(null);
  const routedAudioRef = useRef(null);

  // Fetch, decode audio, and extract real waveform
  useEffect(() => {
    if (!src) return;
    const controller = new AbortController();
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    ctxRef.current = ctx;

    fetch(src, { signal: controller.signal })
      .then(r => r.arrayBuffer())
      .then(buf => ctx.decodeAudioData(buf))
      .then(audioBuffer => {
        bufferRef.current = audioBuffer;
        const dur = audioBuffer.duration;
        durationRef.current = dur;
        setDuration(dur);
        setLoaded(true);

        // Extract real waveform from audio data
        const BAR_COUNT = 48;
        const rawData = audioBuffer.getChannelData(0);
        const samplesPerBar = Math.floor(rawData.length / BAR_COUNT);
        const peaks = [];
        for (let i = 0; i < BAR_COUNT; i++) {
          let sum = 0;
          const start = i * samplesPerBar;
          const end = Math.min(start + samplesPerBar, rawData.length);
          for (let j = start; j < end; j++) {
            sum += Math.abs(rawData[j]);
          }
          peaks.push(sum / (end - start));
        }
        const maxPeak = Math.max(...peaks, 0.001);
        setWaveformBars(peaks.map(p => {
          const normalized = p / maxPeak;
          return Math.max(10, Math.min(98, normalized * 95 + 5));
        }));
      })
      .catch(() => {});

    return () => {
      controller.abort();
      if (sourceRef.current) {
        try { sourceRef.current.stop(); } catch (_) {}
      }
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      if (routedAudioRef.current) {
        routedAudioRef.current.srcObject = null;
        routedAudioRef.current.pause();
        routedAudioRef.current = null;
      }
      streamDestRef.current = null;
      ctx.close().catch(() => {});
    };
  }, [src]);

  // Progress tracking loop — only runs while playing
  const tickProgress = useCallback(() => {
    const ctx = ctxRef.current;
    if (!ctx || !playingRef.current) return;
    const elapsed = (ctx.currentTime - startCtxTimeRef.current) * rateRef.current;
    const pos = Math.min(offsetRef.current + elapsed, durationRef.current);
    setCurrentTime(pos);
    if (pos >= durationRef.current) {
      // Playback reached end
      playingRef.current = false;
      setIsPlaying(false);
      offsetRef.current = 0;
      setCurrentTime(0);
      return;
    }
    rafRef.current = requestAnimationFrame(tickProgress);
  }, []);

  const startPlayback = useCallback((fromOffset) => {
    const ctx = ctxRef.current;
    const buffer = bufferRef.current;
    if (!ctx || !buffer) return;
    if (ctx.state === 'suspended') ctx.resume();

    const outputDevice = settings?.output_device;
    const outputVolume = (settings?.output_volume ?? 100) / 100;
    const useDeviceRouting = outputDevice && outputDevice !== 'default';

    let destination = ctx.destination;
    if (useDeviceRouting && ctx.createMediaStreamDestination) {
      if (!streamDestRef.current) {
        streamDestRef.current = ctx.createMediaStreamDestination();
        const audio = new Audio();
        audio.autoplay = true;
        audio.playsInline = true;
        audio.volume = outputVolume;
        audio.srcObject = streamDestRef.current.stream;
        if (audio.setSinkId) {
          audio.setSinkId(outputDevice).catch(() => {});
        }
        audio.play().catch(() => {});
        routedAudioRef.current = audio;
      } else if (routedAudioRef.current) {
        routedAudioRef.current.volume = outputVolume;
        if (routedAudioRef.current.setSinkId) {
          routedAudioRef.current.setSinkId(outputDevice).catch(() => {});
        }
      }
      destination = streamDestRef.current;
    }

    // Stop previous source if any
    if (sourceRef.current) {
      sourceRef.current.onended = null;
      try { sourceRef.current.stop(); } catch (_) {}
    }

    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.playbackRate.value = rateRef.current;
    source.connect(destination);
    source.onended = () => {
      if (!playingRef.current) return;
      playingRef.current = false;
      setIsPlaying(false);
      offsetRef.current = 0;
      setCurrentTime(0);
    };
    sourceRef.current = source;
    startCtxTimeRef.current = ctx.currentTime;
    offsetRef.current = fromOffset;
    source.start(0, fromOffset);

    playingRef.current = true;
    setIsPlaying(true);
    rafRef.current = requestAnimationFrame(tickProgress);
  }, [tickProgress, settings?.output_device, settings?.output_volume]);

  const stopPlayback = useCallback(() => {
    const ctx = ctxRef.current;
    if (ctx && sourceRef.current) {
      const elapsed = (ctx.currentTime - startCtxTimeRef.current) * rateRef.current;
      offsetRef.current = Math.min(offsetRef.current + elapsed, durationRef.current);
      sourceRef.current.onended = null;
      try { sourceRef.current.stop(); } catch (_) {}
      sourceRef.current = null;
    }
    playingRef.current = false;
    setIsPlaying(false);
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    setCurrentTime(offsetRef.current);
  }, []);

  const togglePlay = useCallback(() => {
    if (!bufferRef.current) return;
    if (playingRef.current) {
      stopPlayback();
    } else {
      startPlayback(offsetRef.current);
    }
  }, [startPlayback, stopPlayback]);

  const seekTo = useCallback((time) => {
    const clamped = Math.max(0, Math.min(time, durationRef.current));
    offsetRef.current = clamped;
    setCurrentTime(clamped);
    if (playingRef.current) {
      startPlayback(clamped);
    }
  }, [startPlayback]);

  const seekFromMouse = useCallback((clientX) => {
    const waveform = waveformRef.current;
    const dur = durationRef.current;
    if (!waveform || !dur) return;
    const rect = waveform.getBoundingClientRect();
    const x = Math.max(0, Math.min(clientX - rect.left, rect.width));
    seekTo((x / rect.width) * dur);
  }, [seekTo]);

  const handleMouseDown = useCallback((e) => {
    if (!durationRef.current || !loaded) return;
    e.preventDefault();
    dragRef.current = true;
    setIsDragging(true);
    seekFromMouse(e.clientX);

    const onMove = (ev) => seekFromMouse(ev.clientX);
    const onUp = () => {
      dragRef.current = false;
      setIsDragging(false);
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }, [loaded, seekFromMouse]);

  const cycleSpeed = useCallback(() => {
    const speeds = [1, 1.5, 2];
    const idx = speeds.indexOf(rateRef.current);
    const next = speeds[(idx + 1) % speeds.length];
    rateRef.current = next;
    setPlaybackRate(next);
    if (playingRef.current && sourceRef.current) {
      sourceRef.current.playbackRate.value = next;
      // Recalculate timing base so progress stays accurate
      const ctx = ctxRef.current;
      const elapsed = (ctx.currentTime - startCtxTimeRef.current) * (speeds[idx] || 1);
      offsetRef.current = Math.min(offsetRef.current + elapsed, durationRef.current);
      startCtxTimeRef.current = ctx.currentTime;
    }
  }, []);

  const effectiveDuration = duration || initialDuration || 0;
  const progress = effectiveDuration > 0 ? Math.min((currentTime / effectiveDuration) * 100, 100) : 0;
  const elapsed = formatDuration(currentTime);
  const total = effectiveDuration > 0 ? formatDuration(effectiveDuration) : '0:00';
  
  return (
    <div className={`voice-message ${pending ? 'pending' : ''} ${failed ? 'failed' : ''} ${isDragging ? 'dragging' : ''} ${isPlaying ? 'playing' : ''}`}>
      <button className="voice-message-play" onClick={togglePlay} disabled={pending || !loaded}>
        {(pending || !loaded) ? (
          <span className="voice-message-spinner" />
        ) : failed ? (
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        ) : isPlaying ? (
          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
            <rect x="6" y="4" width="4" height="16" rx="1.5" />
            <rect x="14" y="4" width="4" height="16" rx="1.5" />
          </svg>
        ) : (
          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
            <path d="M7 4.5v15l13-7.5z" />
          </svg>
        )}
      </button>
      <div className="voice-message-body">
        <div 
          className="voice-message-waveform" 
          ref={waveformRef}
          onMouseDown={handleMouseDown}
        >
          {waveformBars.map((height, i) => {
            const barProgress = ((i + 0.5) / waveformBars.length) * 100;
            const isPlayed = barProgress <= progress;
            return (
              <div 
                key={i} 
                className={`voice-message-bar ${isPlayed ? 'played' : ''}`}
                style={{ height: `${height}%` }}
              />
            );
          })}
          <div 
            className="voice-message-scrubber" 
            style={{ left: `${progress}%` }}
          />
        </div>
        <div className="voice-message-info">
          <span className="voice-message-time">
            {elapsed}<span className="voice-message-time-sep">/</span>{total}
          </span>
          <button 
            className="voice-message-speed" 
            onClick={cycleSpeed}
            title="Playback speed"
          >
            {playbackRate}x
          </button>
        </div>
      </div>
    </div>
  );
});

// Error boundary for voice messages — prevents one bad message from crashing the chat
class VoiceMessageBoundary extends React.Component {
  state = { hasError: false };
  static getDerivedStateFromError() { return { hasError: true }; }
  render() {
    if (this.state.hasError) {
      return (
        <div className="voice-message failed">
          <button className="voice-message-play" disabled>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
          </button>
          <div className="voice-message-body"><span className="voice-message-time">Audio unavailable</span></div>
        </div>
      );
    }
    return this.props.children;
  }
}

// Reply quote component - displays the message being replied to
const ReplyQuote = memo(function ReplyQuote({ replyToMessage, onScrollToMessage, t }) {
  if (!replyToMessage) return null;
  const replyAuthorName = replyToMessage.sender?.display_name || t('chat.user');
  
  const handleClick = () => {
    if (onScrollToMessage && replyToMessage.id) {
      onScrollToMessage(replyToMessage.id);
    }
  };
  
  return (
    <div className="message-reply-quote" onClick={handleClick}>
      <div className="reply-quote-bar" />
      <span className="reply-quote-author">@{replyAuthorName}</span>
      <span className="reply-quote-text">
        {replyToMessage.type === 'text'
          ? <TextWithAranjaEmojis text={replyToMessage.content?.length > 80 ? replyToMessage.content.substring(0, 80) + '...' : replyToMessage.content} />
          : replyToMessage.type === 'image'
            ? <><Camera size={13} /> {t('chat.image')}</>
            : replyToMessage.type === 'sticker'
              ? <><Palette size={13} /> {t('chat.sticker')}</>
              : <><Paperclip size={13} /> {t('chat.file')}</>
        }
      </span>
    </div>
  );
});

// Image lightbox component with zoom at cursor + drag to pan
const ImageLightbox = memo(function ImageLightbox({ src, alt, onClose }) {
  const [zoom, setZoom] = useState(1);
  const [transform, setTransform] = useState({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState(false);
  const dragRef = useRef({ active: false, didDrag: false, startX: 0, startY: 0, startTx: 0, startTy: 0 });

  useEffect(() => {
    const handleEscape = (e) => {
      if (e.key === 'Escape') {
        if (zoom > 1) setZoom(1);
        else onClose();
      }
    };
    document.body.style.overflow = 'hidden';
    document.addEventListener('keydown', handleEscape);
    return () => {
      document.body.style.overflow = '';
      document.removeEventListener('keydown', handleEscape);
    };
  }, [onClose, zoom]);

  useEffect(() => {
    if (zoom <= 1) return;
    const onMove = (e) => {
      if (!dragRef.current.active) return;
      dragRef.current.didDrag = true;
      setIsDragging(true);
      const dx = e.clientX - dragRef.current.startX;
      const dy = e.clientY - dragRef.current.startY;
      setTransform({
        x: dragRef.current.startTx + dx,
        y: dragRef.current.startTy + dy,
      });
    };
    const onUp = () => {
      dragRef.current.active = false;
      setIsDragging(false);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    return () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
  }, [zoom]);

  const handleImageMouseDown = useCallback((e) => {
    if (e.button !== 0) return;
    if (zoom > 1) {
      e.preventDefault();
      dragRef.current = { active: true, didDrag: false, startX: e.clientX, startY: e.clientY, startTx: transform.x, startTy: transform.y };
    }
  }, [zoom, transform]);

  const handleImageClick = useCallback((e) => {
    e.stopPropagation();
    if (dragRef.current.didDrag) return; // was a drag, not a click
    const wrap = e.currentTarget;
    if (!wrap) return;
    const rect = wrap.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    if (zoom > 1) {
      setZoom(1);
      setTransform({ x: 0, y: 0 });
    } else {
      setZoom(2.5);
      const scale = 2.5;
      setTransform({
        x: x * (1 - scale),
        y: y * (1 - scale),
      });
    }
  }, [zoom]);

  const handleOverlayClick = useCallback((e) => {
    if (e.target === e.currentTarget) {
      if (zoom > 1) {
        setZoom(1);
        setTransform({ x: 0, y: 0 });
      } else {
        onClose();
      }
    }
  }, [zoom, onClose]);

  return createPortal(
    <div className="lightbox-overlay" onClick={handleOverlayClick}>
      <div className="lightbox-content" onClick={(e) => e.stopPropagation()}>
        <div
          className="lightbox-image-wrap"
          onClick={handleImageClick}
          onMouseDown={handleImageMouseDown}
          style={{
            transform: `translate(${transform.x}px, ${transform.y}px) scale(${zoom})`,
            transformOrigin: '0 0',
            cursor: zoom > 1 ? (isDragging ? 'grabbing' : 'grab') : 'zoom-in',
          }}
        >
          <img src={src} alt={alt} className="lightbox-image" draggable={false} />
        </div>
        <button className="lightbox-close" onClick={onClose}>
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <line x1="18" y1="6" x2="6" y2="18"></line>
            <line x1="6" y1="6" x2="18" y2="18"></line>
          </svg>
        </button>
      </div>
    </div>,
    document.body
  );
});

// Parse text with mentions and return React elements
function parseTextWithMentions(text, currentUserName) {
  if (!text) return text;
  
  // Regex to match @mentions (alphanumeric, underscores, spaces in names)
  const mentionRegex = /@(everyone|channel|[\w\s]+?)(?=\s|$|[.,!?])/g;
  const parts = [];
  let lastIndex = 0;
  let match;
  
  while ((match = mentionRegex.exec(text)) !== null) {
    // Add text before the mention
    if (match.index > lastIndex) {
      parts.push(text.substring(lastIndex, match.index));
    }
    
    const mentionName = match[1];
    const isSpecial = mentionName === 'everyone' || mentionName === 'channel';
    const isMe = currentUserName && mentionName.toLowerCase() === currentUserName.toLowerCase();
    
    parts.push(
      <span 
        key={match.index} 
        className={`mention ${isMe || isSpecial ? 'mention-me' : ''}`}
        title={isSpecial ? (mentionName === 'everyone' ? 'Notifier tout le monde' : 'Notifier le channel') : `@${mentionName}`}
        onClick={(e) => e.stopPropagation()}
      >
        @{mentionName}
      </span>
    );
    
    lastIndex = match.index + match[0].length;
  }
  
  // Add remaining text
  if (lastIndex < text.length) {
    parts.push(text.substring(lastIndex));
  }
  
  return parts.length > 0 ? parts : text;
}

const MessageVideoPlayer = memo(function MessageVideoPlayer({ fileUrl, mimeType, fileName, t }) {
  const videoRef = useRef(null);
  const wrapRef = useRef(null);
  const [hasStarted, setHasStarted] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [duration, setDuration] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [volume, setVolume] = useState(1);

  const syncFromVideo = useCallback(() => {
    const el = videoRef.current;
    if (!el) return;
    const nextDuration = Number.isFinite(el.duration) ? el.duration : 0;
    const nextTime = Number.isFinite(el.currentTime) ? el.currentTime : 0;
    setDuration(nextDuration);
    setCurrentTime(nextTime);
    setIsPlaying(!el.paused && !el.ended);
  }, []);

  const startPlayback = useCallback(() => {
    const el = videoRef.current;
    if (!el) return;
    setHasStarted(true);
    el.play().then(() => {
      setIsPlaying(true);
    }).catch(() => {});
  }, []);

  useEffect(() => {
    if (typeof navigator === 'undefined' || !('mediaSession' in navigator)) return;
    const actions = ['play', 'pause', 'stop', 'previoustrack', 'nexttrack', 'seekbackward', 'seekforward', 'seekto'];
    actions.forEach((action) => {
      try {
        navigator.mediaSession.setActionHandler(action, () => {});
      } catch {
        // Some actions are not supported on all browsers.
      }
    });
    try {
      navigator.mediaSession.metadata = null;
      navigator.mediaSession.playbackState = 'none';
    } catch {
      // Ignore unsupported media session fields.
    }
    return () => {
      actions.forEach((action) => {
        try {
          navigator.mediaSession.setActionHandler(action, null);
        } catch {
          // Ignore unsupported actions on cleanup.
        }
      });
    };
  }, []);

  useEffect(() => {
    const el = videoRef.current;
    if (!el) return;
    el.volume = volume;
  }, [volume]);

  useEffect(() => {
    const onFullscreenChange = () => {
      const root = wrapRef.current;
      const video = videoRef.current;
      const fsEl = document.fullscreenElement;
      setIsFullscreen(!!fsEl && (fsEl === root || fsEl === video));
    };
    document.addEventListener('fullscreenchange', onFullscreenChange);
    const video = videoRef.current;
    const onWebkitBegin = () => setIsFullscreen(true);
    const onWebkitEnd = () => setIsFullscreen(false);
    if (video) {
      video.addEventListener('webkitbeginfullscreen', onWebkitBegin);
      video.addEventListener('webkitendfullscreen', onWebkitEnd);
    }
    return () => {
      document.removeEventListener('fullscreenchange', onFullscreenChange);
      if (video) {
        video.removeEventListener('webkitbeginfullscreen', onWebkitBegin);
        video.removeEventListener('webkitendfullscreen', onWebkitEnd);
      }
    };
  }, []);

  const togglePlayback = useCallback(() => {
    const el = videoRef.current;
    if (!el) return;
    if (el.paused || el.ended) {
      setHasStarted(true);
      el.play().then(() => setIsPlaying(true)).catch(() => {});
      return;
    }
    el.pause();
    setIsPlaying(false);
  }, []);

  const toggleFullscreen = useCallback(() => {
    const video = videoRef.current;
    const root = wrapRef.current;
    if (!video && !root) return;
    if (document.fullscreenElement) {
      const exiting = document.exitFullscreen?.();
      if (exiting && typeof exiting.catch === 'function') exiting.catch(() => {});
      return;
    }
    // Mobile-safe order: prefer fullscreening the video element itself.
    if (video && typeof video.requestFullscreen === 'function') {
      const req = video.requestFullscreen();
      if (req && typeof req.catch === 'function') req.catch(() => {});
      return;
    }
    // iOS Safari fallback
    if (video && typeof video.webkitEnterFullscreen === 'function') {
      try { video.webkitEnterFullscreen(); } catch {}
      return;
    }
    if (root && typeof root.requestFullscreen === 'function') {
      const req = root.requestFullscreen();
      if (req && typeof req.catch === 'function') req.catch(() => {});
    }
  }, []);

  const progressPercent = duration > 0 ? Math.max(0, Math.min(100, (currentTime / duration) * 100)) : 0;
  const volumePercent = Math.max(0, Math.min(100, volume * 100));

  return (
    <div
      ref={wrapRef}
      className={`message-video-wrap ${hasStarted ? 'started' : 'idle'}`}
      onClick={() => {
        if (!hasStarted) {
          startPlayback();
          return;
        }
        togglePlayback();
      }}
    >
      <video
        ref={videoRef}
        controls={false}
        className="message-video"
        preload="metadata"
        playsInline
        loop
        disablePictureInPicture
        disableRemotePlayback
        onPlay={() => {
          setHasStarted(true);
          setIsPlaying(true);
          syncFromVideo();
        }}
        onPause={() => {
          setIsPlaying(false);
          syncFromVideo();
        }}
        onLoadedMetadata={syncFromVideo}
        onDurationChange={syncFromVideo}
        onTimeUpdate={syncFromVideo}
        onEnded={() => {
          setIsPlaying(false);
          syncFromVideo();
        }}
      >
        <source src={fileUrl} type={mimeType} />
      </video>

      {!hasStarted && (
        <button
          type="button"
          className="message-video-center-play"
          onClick={(e) => {
            e.stopPropagation();
            startPlayback();
          }}
          aria-label={t('chat.play') || 'Play video'}
          title={t('chat.play') || 'Play'}
        >
          <Play size={20} fill="currentColor" />
        </button>
      )}

      {hasStarted && (
        <div className="message-video-controls" onClick={(e) => e.stopPropagation()}>
          <button
            type="button"
            className="message-video-control-btn"
            onClick={togglePlayback}
            aria-label={isPlaying ? (t('chat.pause') || 'Pause') : (t('chat.play') || 'Play')}
            title={isPlaying ? (t('chat.pause') || 'Pause') : (t('chat.play') || 'Play')}
          >
            {isPlaying ? <Pause size={15} /> : <Play size={15} fill="currentColor" />}
          </button>

          <input
            type="range"
            className="message-video-progress"
            min={0}
            max={duration || 0}
            step={0.1}
            value={Math.min(currentTime, duration || 0)}
            onChange={(e) => {
              const el = videoRef.current;
              if (!el) return;
              const next = Number(e.target.value);
              el.currentTime = Number.isFinite(next) ? next : 0;
              setCurrentTime(Number.isFinite(next) ? next : 0);
            }}
            style={{ '--progress': `${progressPercent}%` }}
            aria-label={t('chat.seek') || 'Seek'}
          />

          <span className="message-video-time">
            {formatDuration(currentTime)} / {formatDuration(duration)}
          </span>

          <button
            type="button"
            className="message-video-control-btn"
            onClick={() => setVolume((v) => (v > 0 ? 0 : 1))}
            aria-label={volume > 0 ? (t('chat.mute') || 'Mute') : (t('chat.unmute') || 'Unmute')}
            title={volume > 0 ? (t('chat.mute') || 'Mute') : (t('chat.unmute') || 'Unmute')}
          >
            {volume > 0 ? <Volume2 size={15} /> : <VolumeX size={15} />}
          </button>

          <input
            type="range"
            className="message-video-volume"
            min={0}
            max={1}
            step={0.01}
            value={volume}
            onChange={(e) => {
              const next = Number(e.target.value);
              setVolume(Number.isFinite(next) ? next : 1);
            }}
            style={{ '--progress': `${volumePercent}%` }}
            aria-label={t('chat.volume') || 'Volume'}
          />

          <button
            type="button"
            className="message-video-control-btn"
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              toggleFullscreen();
            }}
            aria-label={isFullscreen ? (t('chat.collapse') || 'Exit fullscreen') : (t('chat.expand') || 'Fullscreen')}
            title={isFullscreen ? (t('chat.collapse') || 'Reduce') : (t('chat.expand') || 'Enlarge')}
          >
            {isFullscreen ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
          </button>
        </div>
      )}

      <a
        href={fileUrl}
        download={fileName}
        className="message-video-download"
        title={t('chat.download') || 'Download'}
        aria-label={t('chat.download') || 'Download video'}
        onClick={(e) => e.stopPropagation()}
      >
        <Download size={16} />
      </a>
    </div>
  );
});

// Auto-resizing edit textarea for message editing
const EditTextarea = memo(function EditTextarea({ editContent, setEditContent, onSaveEdit, onCancelEdit, t }) {
  const textareaRef = useRef(null);
  const [previewDismissed, setPreviewDismissed] = useState(false);

  const hasMarkdown = useMemo(() => editContent.trim().length > 0 && HAS_MARKDOWN_RE.test(editContent), [editContent]);
  const showMdPreview = hasMarkdown && !previewDismissed;

  useEffect(() => { if (!editContent.trim()) setPreviewDismissed(false); }, [editContent]);

  const autoResize = useCallback(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = ta.scrollHeight + 'px';
  }, []);

  useEffect(() => {
    autoResize();
  }, [editContent, autoResize]);

  useEffect(() => {
    const ta = textareaRef.current;
    if (ta) {
      ta.focus();
      ta.setSelectionRange(ta.value.length, ta.value.length);
    }
  }, []);

  return (
    <div className="message-edit-inline">
      {showMdPreview && (
        <div className="md-live-preview md-live-preview--edit">
          <div className="md-live-preview-header">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
            <span>Aperçu</span>
            <button type="button" className="md-live-preview-close" onClick={() => setPreviewDismissed(true)}>×</button>
          </div>
          <div className="md-live-preview-body message-content message-content-text">
            {_parseMarkdown(editContent, '')}
          </div>
        </div>
      )}
      <div className="message-edit-inline__row">
        <textarea
          ref={textareaRef}
          className="message-edit-inline__input"
          value={editContent}
          onChange={(e) => { setEditContent(e.target.value); }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); onSaveEdit(); }
            if (e.key === 'Escape') onCancelEdit();
          }}
          rows={1}
        />
        <button type="button" className="message-edit-inline__ok" onClick={onSaveEdit}>
          {t('chat.ok')}
        </button>
      </div>
    </div>
  );
});

// Message content renderer based on type
const MessageContent = memo(function MessageContent({ msg, isEditing, editContent, setEditContent, onSaveEdit, onCancelEdit, onStickerClick, currentUserName, mentionUsers, onMentionClick, t }) {
  const [lightboxOpen, setLightboxOpen] = useState(false);
  
  // If editing text message, show edit textarea only
  if (isEditing && msg.type === 'text') {
    return (
      <EditTextarea
        editContent={editContent}
        setEditContent={setEditContent}
        onSaveEdit={onSaveEdit}
        onCancelEdit={onCancelEdit}
        t={t}
      />
    );
  }
  
  // Image message
  if (msg.type === 'image') {
    const imageUrl = getStaticUrl(msg.content);
    const embeddableUrls = msg.caption ? getEmbeddableUrls(msg.caption) : [];
    if (isEditing) {
      return (
        <>
          <EditTextarea
            editContent={editContent}
            setEditContent={setEditContent}
            onSaveEdit={onSaveEdit}
            onCancelEdit={onCancelEdit}
            t={t}
          />
          <div
            className="message-image-wrap"
            role="button"
            tabIndex={0}
            onClick={() => setLightboxOpen(true)}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setLightboxOpen(true); } }}
            aria-label={t('chat.openImage') || 'Open image'}
          >
            <img src={imageUrl} alt={msg.attachment?.file_name || 'Image'} className="message-image" loading="lazy" />
          </div>
          {lightboxOpen && (
            <ImageLightbox src={imageUrl} alt={msg.attachment?.file_name || 'Image'} onClose={() => setLightboxOpen(false)} />
          )}
        </>
      );
    }
    return (
      <>
        {msg.caption && (
          <div className="message-caption">
            <div className="message-content message-content-text">
              {parseMessageContent(msg.caption, currentUserName, mentionUsers, onMentionClick)}
              {embeddableUrls.map((url, index) => (
                <LinkEmbed key={`embed-${index}`} url={url} />
              ))}
            </div>
          </div>
        )}
        <div
          className="message-image-wrap"
          role="button"
          tabIndex={0}
          onClick={() => setLightboxOpen(true)}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setLightboxOpen(true); } }}
          aria-label={t('chat.openImage') || 'Open image'}
        >
          <img 
            src={imageUrl} 
            alt={msg.attachment?.file_name || 'Image'} 
            className="message-image"
            loading="lazy"
          />
        </div>
        {lightboxOpen && (
          <ImageLightbox 
            src={imageUrl} 
            alt={msg.attachment?.file_name || 'Image'} 
            onClose={() => setLightboxOpen(false)} 
          />
        )}
      </>
    );
  }
  
  // Sticker message
  if (msg.type === 'sticker') {
    const stickerUrl = getStaticUrl(msg.content);
    return (
      <div className="message-sticker-wrap">
        <img 
          src={stickerUrl} 
          alt="Sticker" 
          className="message-sticker"
          loading="lazy"
          onClick={() => onStickerClick && onStickerClick(stickerUrl)}
          style={{ cursor: 'pointer' }}
        />
      </div>
    );
  }
  
  // GIF message
  if (msg.type === 'gif') {
    const gifUrl = getStaticUrl(msg.content);
    return (
      <div className="message-gif-wrap">
        <img 
          src={gifUrl} 
          alt="GIF" 
          className="message-gif"
          loading="lazy"
        />
      </div>
    );
  }
  
  // Emoji message (custom emoji image)
  if (msg.type === 'emoji') {
    const emojiUrl = getStaticUrl(msg.content);
    return (
      <div className="message-emoji-wrap">
        <img 
          src={emojiUrl} 
          alt="Emoji" 
          className="message-emoji"
          loading="lazy"
        />
      </div>
    );
  }
  
  // File message
  if (msg.type === 'file') {
    // Use attachment if available, otherwise create fallback from content
    let file_name, file_url, file_size, mime_type;
    
    if (msg.attachment) {
      file_name = msg.attachment.file_name;
      file_url = getStaticUrl(msg.attachment.file_url);
      file_size = msg.attachment.file_size;
      mime_type = msg.attachment.mime_type;
    } else if (msg.content) {
      // Fallback: parse from content (can be "URL||originalname" or just "URL")
      let contentUrl = msg.content;
      let originalName = null;
      
      if (msg.content.includes('||')) {
        const parts = msg.content.split('||');
        contentUrl = parts[0];
        originalName = parts[1];
      }
      
      const storedFilename = contentUrl.split('/').pop();
      const ext = storedFilename.split('.').pop()?.toLowerCase() || '';
      
      // Try to extract original name from stored filename
      // Format: timestamp-random-originalname.ext (e.g., 1234567890-123456789-cat.txt)
      if (!originalName && storedFilename) {
        const nameWithoutExt = storedFilename.replace(/\.[^.]+$/, '');
        // Match: timestamp-random-originalname (at least 2 dashes)
        const match = nameWithoutExt.match(/^\d+-\d+-(.+)$/);
        if (match && match[1]) {
          // Restore original name with extension
          originalName = match[1].replace(/_/g, ' ') + (ext ? `.${ext}` : '');
        }
      }
      
      file_url = getStaticUrl(contentUrl);
      file_name = originalName || storedFilename;
      file_size = null;
      mime_type = ext ? `application/${ext}` : 'application/octet-stream';
    } else {
      // No valid file info, show as text
      return <div className="message-content">{msg.content}</div>;
    }
    const isAudio = mime_type?.startsWith('audio/');
    const isVideo = mime_type?.startsWith('video/');
    
    if (isAudio) {
      return (
        <VoiceMessageBoundary>
          <VoiceMessagePlayer 
            src={file_url} 
            fileName={file_name} 
            pending={msg._pending}
            failed={msg._failed}
            initialDuration={msg._voiceDuration}
          />
        </VoiceMessageBoundary>
      );
    }
    
    if (isVideo) {
      return (
        <MessageVideoPlayer
          fileUrl={file_url}
          mimeType={mime_type}
          fileName={file_name}
          t={t}
        />
      );
    }
    
    const FileIcon = () => (
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
        <polyline points="14 2 14 8 20 8"></polyline>
      </svg>
    );
    
    if (isEditing) {
      return (
        <>
          <EditTextarea
            editContent={editContent}
            setEditContent={setEditContent}
            onSaveEdit={onSaveEdit}
            onCancelEdit={onCancelEdit}
            t={t}
          />
          <a href={file_url} download={file_name} className="message-file-wrap" target="_blank" rel="noopener noreferrer">
            <span className="message-file-icon"><FileIcon /></span>
            <div className="message-file-details">
              <span className="message-file-name">{file_name}</span>
              <span className="message-file-size">{formatFileSize(file_size)}</span>
            </div>
          </a>
        </>
      );
    }
    
    const embeddableUrls = msg.caption ? getEmbeddableUrls(msg.caption) : [];
    return (
      <>
        {msg.caption && (
          <div className="message-caption">
            <div className="message-content message-content-text">
              {parseMessageContent(msg.caption, currentUserName, mentionUsers, onMentionClick)}
              {embeddableUrls.map((url, index) => (
                <LinkEmbed key={`embed-${index}`} url={url} />
              ))}
            </div>
          </div>
        )}
        <a href={file_url} download={file_name} className="message-file-wrap" target="_blank" rel="noopener noreferrer">
          <span className="message-file-icon"><FileIcon /></span>
          <div className="message-file-details">
            <span className="message-file-name">{file_name}</span>
            <span className="message-file-size">{formatFileSize(file_size)}</span>
          </div>
        </a>
      </>
    );
  }
  
  // Default text message - check for invite links
  const content = msg.content || '';
  
  // Regex to detect invite links in the message
  const inviteLinkRegex = /(https?:\/\/[^\s]+\/invite\/[A-Za-z0-9]{6,20}|\/invite\/[A-Za-z0-9]{6,20})/g;
  const inviteMatches = content.match(inviteLinkRegex);
  
  const embeddableUrls = getEmbeddableUrls(content);
  
  if (inviteMatches && inviteMatches.length > 0) {
    // Split content by invite links and get remaining text
    const parts = content.split(inviteLinkRegex);
    const uniqueInvites = [...new Set(inviteMatches)];
    
    // Filter out invite links and empty parts, keep only real text
    const textParts = parts.filter(part => part && !inviteMatches.includes(part) && part.trim());
    const hasOtherText = textParts.length > 0;
    
    return (
      <div className={`message-content message-content-with-invite${hasOtherText ? ' message-content-text' : ''}`}>
        {/* Only show text if there's content other than the invite link */}
        {hasOtherText && (
          <div className="message-text">
            {textParts.map((part, index) => (
              <React.Fragment key={index}>{parseMessageContent(part, currentUserName, mentionUsers, onMentionClick)}</React.Fragment>
            ))}
          </div>
        )}
        {/* Render invite previews for each unique invite link */}
        {uniqueInvites.map((inviteUrl, index) => (
          <InviteLinkPreview key={`invite-${index}`} url={inviteUrl} />
        ))}
        {/* Embeds pour les autres liens (Spotify, YouTube, etc.) */}
        {embeddableUrls.map((url, index) => (
          <LinkEmbed key={`embed-${index}`} url={url} />
        ))}
      </div>
    );
  }
  
  // Parse markdown + mentions in the content
  const parsedContent = parseMessageContent(content, currentUserName, mentionUsers, onMentionClick);
  const singleEmoji = embeddableUrls.length === 0 && isEmojiOnlyMessage(content);

  return (
    <div className={`message-content message-content-text${singleEmoji ? ' message-emoji-only' : ''}`}>
      {parsedContent}
      {embeddableUrls.map((url, index) => (
        <LinkEmbed key={`embed-${index}`} url={url} />
      ))}
    </div>
  );
});

// Message context menu
const MessageMenu = memo(function MessageMenu({ x, y, msg, isOwn, isDM, reactions, onViewReactions, onClose, onEdit, onCopy, onDeleteForMe, onDeleteForAll, onReply, onReact, onPin, onUnpin, isPinned, onReport, t }) {
  const tx = (key, fallback) => {
    const value = t(key);
    return value === key ? fallback : value;
  };
  const items = [];

  if (onReply) {
    items.push({
      label: t('chat.reply'),
      icon: (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <polyline points="9 17 4 12 9 7"></polyline>
          <path d="M20 18v-2a4 4 0 0 0-4-4H4"></path>
        </svg>
      ),
      onClick: () => onReply(msg),
    });
  }
  if (onReact) {
    items.push({
      label: t('chat.react'),
      icon: (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <circle cx="12" cy="12" r="10"></circle>
          <path d="M8 14s1.5 2 4 2 4-2 4-2"></path>
          <line x1="9" y1="9" x2="9.01" y2="9"></line>
          <line x1="15" y1="9" x2="15.01" y2="9"></line>
        </svg>
      ),
      onClick: () => onReact(msg),
    });
  }
  if (Array.isArray(reactions) && reactions.length > 0 && onViewReactions) {
    items.push({
      label: tx('chat.viewAllReactions', 'Voir toutes les reactions'),
      icon: (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <circle cx="12" cy="12" r="10"></circle>
          <path d="M8 14s1.5 2 4 2 4-2 4-2"></path>
          <line x1="9" y1="9" x2="9.01" y2="9"></line>
          <line x1="15" y1="9" x2="15.01" y2="9"></line>
        </svg>
      ),
      onClick: () => onViewReactions(msg),
    });
  }
  if ((msg.type === 'text' || msg.type === 'image' || msg.type === 'file') && isOwn && !msg.is_webhook && !msg.sender?.is_webhook) {
    items.push({
      label: t('chat.edit'),
      icon: (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path>
          <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path>
        </svg>
      ),
      onClick: () => onEdit(msg),
    });
  }
  items.push({
    label: t('chat.copy'),
    icon: (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
        <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
      </svg>
    ),
    onClick: () => onCopy(msg),
  });
  if (onPin || onUnpin) {
    if (isPinned) {
      items.push({
        label: t('chat.unpin'),
        icon: (
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M16 12V4h1V2H7v2h1v8l-2 2v2h5.2v6h1.6v-6H18v-2l-2-2z"/>
            <line x1="3" y1="3" x2="21" y2="21" strokeWidth="2"/>
          </svg>
        ),
        onClick: () => onUnpin?.(msg),
      });
    } else {
      items.push({
        label: t('chat.pin'),
        icon: (
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M16 12V4h1V2H7v2h1v8l-2 2v2h5.2v6h1.6v-6H18v-2l-2-2z"/>
          </svg>
        ),
        onClick: () => onPin?.(msg),
      });
    }
  }
  if (!isOwn && onReport && !msg.is_webhook && !msg.sender?.is_webhook) {
    items.push(
      { separator: true },
      {
        label: t('chat.report', 'Signaler'),
        danger: true,
        icon: (
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"/>
            <line x1="4" y1="22" x2="4" y2="15"/>
          </svg>
        ),
        onClick: () => onReport(msg),
      }
    );
  }
  if (isOwn || isDM) {
    items.push(
      { separator: true },
      {
        label: t('chat.delete'),
        danger: true,
        icon: (
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <polyline points="3 6 5 6 21 6"></polyline>
            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
          </svg>
        ),
        onClick: (e) => onDeleteForAll(msg, !!e?.shiftKey),
      }
    );
  }

  return <ContextMenu x={x} y={y} items={items} onClose={onClose} />;
});

const ReactionsViewerModal = memo(function ReactionsViewerModal({
  message,
  reactions,
  canModerateReactions,
  currentUserId,
  onRemoveReaction,
  onClose,
  t,
}) {
  const modalRef = useRef(null);
  const tx = (key, fallback) => {
    const value = t(key);
    return value === key ? fallback : value;
  };

  useEffect(() => {
    const onKeyDown = (e) => {
      if (e.key === 'Escape') onClose();
    };
    const onMouseDown = (e) => {
      if (modalRef.current && !modalRef.current.contains(e.target)) onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('mousedown', onMouseDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('mousedown', onMouseDown);
    };
  }, [onClose]);

  const rows = useMemo(() => {
    const flat = [];
    for (const reaction of (reactions || [])) {
      const ids = Array.isArray(reaction.userIds) ? reaction.userIds : [];
      const names = Array.isArray(reaction.users) ? reaction.users : [];
      for (let i = 0; i < ids.length; i++) {
        flat.push({
          emoji: reaction.emoji,
          userId: ids[i],
          displayName: names[i] || `User ${ids[i]}`,
        });
      }
    }
    return flat;
  }, [reactions]);

  return createPortal(
    <div className="message-reactions-modal-overlay">
      <div className="message-reactions-modal" ref={modalRef}>
        <div className="message-reactions-modal-header">
          <h3>{tx('chat.viewAllReactions', 'Voir toutes les reactions')}</h3>
          <button className="message-reactions-modal-close" onClick={onClose} aria-label={tx('common.close', 'Fermer')}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="18" y1="6" x2="6" y2="18"></line>
              <line x1="6" y1="6" x2="18" y2="18"></line>
            </svg>
          </button>
        </div>
        <div className="message-reactions-modal-list">
          {rows.length === 0 ? (
            <div className="message-reactions-modal-empty">{tx('chat.noReactions', 'Aucune reaction')}</div>
          ) : (
            rows.map((row, idx) => {
              const emojiChar = shortcodeToEmoji(row.emoji) || row.emoji;
              const aranjaUrl = emojiToAranjaUrl(emojiChar);
              const canRemoveThis = canModerateReactions;
              return (
                <div key={`${row.emoji}-${row.userId}-${idx}`} className="message-reactions-modal-row">
                  <span className="message-reactions-modal-emoji">
                    {aranjaUrl ? <img src={aranjaUrl} alt={emojiChar} /> : emojiChar}
                  </span>
                  <span className="message-reactions-modal-user">{row.displayName}</span>
                  {canModerateReactions ? (
                    <button
                      className="message-reactions-modal-remove"
                      onClick={() => onRemoveReaction?.(message.id, row.emoji, row.userId)}
                      disabled={!canRemoveThis}
                      title={
                        canRemoveThis
                          ? tx('chat.removeReaction', 'Supprimer la reaction')
                          : tx('chat.cannotRemoveOwnReactionHere', 'Action non disponible')
                      }
                    >
                      {tx('chat.remove', 'Supprimer')}
                    </button>
                  ) : (
                    <span />
                  )}
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>,
    document.body
  );
});


// Minimal app avatar for system messages
const SystemAppAvatar = memo(function SystemAppAvatar() {
  return (
    <div className="message-system-app-avatar" aria-hidden>
      <Bot size={20} strokeWidth={2} />
    </div>
  );
});

// Command result row: who ran the command + result
const CommandResultRow = memo(function CommandResultRow({ msg, t }) {
  const executorName = msg.sender?.display_name || msg.sender?.username || t('chat.user', 'User');
  const formattedTime = msg.created_at
    ? new Date(msg.created_at).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
    : '';
  const content = msg.content || '';
  const isError = msg.commandType === 'error' || msg.commandSuccess === false;
  const isSuccess = msg.commandType === 'success' && msg.commandSuccess === true;

  return (
    <div className={`message-command-result ${isError ? 'error' : ''} ${isSuccess ? 'success' : ''}`} data-message-id={msg.id}>
      <div className="message-command-result-header">
        <ClickableAvatar user={msg.sender} size="small" position="right" />
        <div className="message-command-result-meta">
          <span className="message-command-result-executor">{executorName}</span>
          <span className="message-command-result-command">{msg.commandInput || '/help'}</span>
          {formattedTime && <time className="message-command-result-time">{formattedTime}</time>}
        </div>
      </div>
      <div className="message-command-result-body">
        <pre className="message-command-result-output">{content}</pre>
      </div>
    </div>
  );
});

// System message row (call ended, etc.)
const SystemMessageRow = memo(function SystemMessageRow({ msg, currentUserId, onDismissSystemMessage, t }) {
  if ((msg.subtype === 'call_ended' || msg.subtype === 'call_started') && msg.call_ended) {
    const { startedByName, durationText, reason, disconnectedUserIds = [] } = msg.call_ended;
    const isCallStarted = msg.subtype === 'call_started' || !durationText;
    const formattedTime = msg.created_at
      ? new Date(msg.created_at).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
      : '';

    // Clyde-style message when call ended due to 3-min alone timeout
    if (reason === 'time_limit' && !isCallStarted) {
      const isOnlyYou = disconnectedUserIds.includes(currentUserId);
      const dismissMsg = t('chat.dismissMessage', 'Dismiss message');
      const onlyYouText = t('chat.onlyYouCanSee', 'Only you can see this');
      const bandwidthText = t('chat.callEndedBandwidth', "It appears you've been by yourself in this call for more than 3 minutes. The bandwidth patrol has asked me to disconnect you to save bandwidth. That stuff doesn't grow on trees!");
      const appName = t('chat.systemAppName', 'Slide');

      return (
        <div className="message-system-row message-system-row--clyde" data-message-id={msg.id}>
          <SystemAppAvatar />
          <div className="message-system-clyde-body">
            <div className="message-system-clyde-header">
              <span className="message-system-clyde-name">{appName}</span>
              <span className="message-system-clyde-badge">
                <Check size={12} strokeWidth={3} />
                {t('chat.appBadge', 'APP')}
              </span>
              {formattedTime && <span className="message-system-clyde-time">{formattedTime}</span>}
            </div>
            <p className="message-system-clyde-text">{bandwidthText}</p>
            <div className="message-system-clyde-footer">
              {isOnlyYou && (
                <span className="message-system-clyde-only-you">
                  <Eye size={14} strokeWidth={2} />
                  {onlyYouText}
                </span>
              )}
              {onDismissSystemMessage && (
                <button
                  type="button"
                  className="message-system-clyde-dismiss"
                  onClick={() => onDismissSystemMessage(msg.id)}
                >
                  {dismissMsg}
                </button>
              )}
            </div>
          </div>
        </div>
      );
    }

    // Regular call message: "X started a call" (in progress) or "X started a call that lasted Y" (ended)
    return (
      <div className={`message-system-row message-system-row--call ${isCallStarted ? 'call-in-progress' : ''}`} data-message-id={msg.id}>
        <Phone className="message-system-call-icon" size={14} strokeWidth={2} />
        <span className="message-system-call-name">{startedByName}</span>
        <span className="message-system-call-text">
          {isCallStarted ? ' started a call.' : ` started a call that lasted ${durationText}.`}
        </span>
        {formattedTime && (
          <span className="message-system-call-time">{formattedTime}</span>
        )}
      </div>
    );
  }
  return (
    <div className="message-system-row" data-message-id={msg.id}>
      <span className="message-system-content">{msg.content}</span>
    </div>
  );
});

// Memoized message item component
const MessageItem = memo(function MessageItem({ 
  msg, isOwn, sender, showTime, formattedTime, isFirst, isLast,
  onContextMenu,
  isEditing, editContent, setEditContent, onSaveEdit, onCancelEdit,
  readByUsers, onUserClick, replyToMessage, onScrollToMessage,
  reactions, currentUserId, currentUserName, onToggleReaction, isPinned, onStickerClick,
  onReply, onReact, onEdit,
  isShiftHeld, onDeleteForMe, onDeleteForAll, isDM, t,
  recentEmojis,
  isBlocked = false, isRevealed = false, onReveal,
  onRetryFailedMessage = null,
  isSelected = false,
  mentionUsers = [], onMentionClick = null,
  serverRoleBadges = null,
  serverTeamRole = null,
  reduceMotion = false,
  animateMaterialize = false,
}) {
  const [isMessageHovered, setIsMessageHovered] = useState(false);
  const isDeleting = !!msg?._deleting;
  const deletingText = typeof msg?.content === 'string' ? msg.content : '';
  const canFumeText = isDeleting && !reduceMotion && deletingText.trim().length > 0;
  const isReplyToCurrentUser = !!(
    !isOwn &&
    replyToMessage?.sender?.id != null &&
    currentUserId != null &&
    String(replyToMessage.sender.id) === String(currentUserId)
  );

  const handleContextMenu = useCallback((e) => {
    e.preventDefault();
    e.stopPropagation();
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX || rect.right;
    const y = e.clientY || rect.bottom;
    onContextMenu({ clientX: x, clientY: y, preventDefault: () => {} }, msg);
  }, [msg, onContextMenu]);
  
  return (
    <div 
      className={`message-item ${isFirst ? 'first' : ''} ${isLast ? 'last' : ''} ${isSelected ? 'selected' : ''} ${isDeleting ? 'deleting' : ''} ${reduceMotion ? 'reduce-motion' : ''} ${isReplyToCurrentUser ? 'reply-to-me' : ''}`}
      onContextMenu={handleContextMenu}
      onMouseEnter={() => setIsMessageHovered(true)}
      onMouseLeave={() => setIsMessageHovered(false)}
      data-message-id={msg.id}
      data-animate-materialize={animateMaterialize ? 'true' : undefined}
    >
      <div className="message-hover-actions" onClick={(e) => e.stopPropagation()}>
              {onReact && (
                <>
                  {recentEmojis.map(shortcode => {
                    const norm = (e) => emojiToShortcode(e || '');
                    const existing = reactions?.find(r => norm(r.emoji) === norm(shortcode));
                    const hasReacted = existing?.userIds?.includes(currentUserId) || false;
                    const emojiChar = shortcodeToEmoji(shortcode);
                    const aranjaUrl = emojiToAranjaUrl(emojiChar);
                    return (
                      <button
                        key={shortcode}
                        className={`hover-action-btn hover-action-quick-emoji ${hasReacted ? 'reacted' : ''}`}
                        title={emojiChar}
                        onClick={() => { saveRecentEmoji(shortcode); onToggleReaction(msg.id, existing?.emoji ?? shortcode, hasReacted); }}
                      >
                        {aranjaUrl ? <img src={aranjaUrl} alt={emojiChar} /> : emojiChar}
                      </button>
                    );
                  })}
                  <div className="hover-actions-separator" />
                  <button className="hover-action-btn" title={t('chat.react')} onClick={() => onReact(msg)}>
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><path d="M8 14s1.5 2 4 2 4-2 4-2"/><line x1="9" y1="9" x2="9.01" y2="9"/><line x1="15" y1="9" x2="15.01" y2="9"/></svg>
                  </button>
                </>
              )}
              {onReply && (
                <button className="hover-action-btn" title={t('chat.reply')} onClick={() => onReply(msg)}>
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="9 17 4 12 9 7"/><path d="M20 18v-2a4 4 0 0 0-4-4H4"/></svg>
                </button>
              )}
              {isOwn && !msg.is_webhook && !msg.sender?.is_webhook && (msg.type === 'text' || msg.type === 'image' || msg.type === 'file') && onEdit && (
                <button className="hover-action-btn" title={t('chat.edit')} onClick={() => onEdit(msg)}>
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
                </button>
              )}
              {isShiftHeld && (isOwn || isDM) && (
                <button className="hover-action-btn hover-action-delete-all" title={t('chat.delete')} onClick={() => onDeleteForAll(msg, true)}>
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
                </button>
              )}
              <button className="hover-action-btn hover-action-more" title={t('chat.moreOptions')} onClick={handleContextMenu}>
                <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="5" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="12" cy="19" r="2"/></svg>
              </button>
        </div>
      <div className="message-avatar-col">
        {isFirst ? (
          <ClickableAvatar user={sender} size="medium" position="right" gifAnimate={isMessageHovered} serverRoleBadges={serverRoleBadges} serverTeamRole={serverTeamRole} />
        ) : (
          showTime && <time className="message-time-left">{formattedTime}</time>
        )}
      </div>
      <div className="message-body">
        {isFirst && (
          <div className="message-header">
            <ClickableSenderName user={sender} t={t} serverRoleBadges={serverRoleBadges} serverTeamRole={serverTeamRole} />
            {(sender?.is_webhook || msg.is_webhook) && (
              <span className="message-bot-badge" title={t('chat.bot')}>BOT</span>
            )}
            <span className="message-e2ee-indicator" title={t('securityDashboard.e2eeTooltip')} aria-label={t('securityDashboard.e2eeTooltip')}>
              <Lock size={10} strokeWidth={2.5} />
            </span>
            <time className="message-time">{formattedTime}</time>
            {isPinned && (
              <span className="message-pinned-indicator" title={t('chat.pinned')}>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M16 12V4h1V2H7v2h1v8l-2 2v2h5.2v6h1.6v-6H18v-2l-2-2z"/>
                </svg>
              </span>
            )}
          </div>
        )}
        {replyToMessage && (isRevealed || !isBlocked) && (
          <ReplyQuote replyToMessage={replyToMessage} onScrollToMessage={onScrollToMessage} t={t} />
        )}
        {isBlocked && !isRevealed ? (
          <BlockedMessage onReveal={onReveal} t={t} />
        ) : (
          <>
            {canFumeText ? (
              <div className="message-delete-fume" aria-label={deletingText}>
                {Array.from(deletingText).map((char, index, chars) => (
                  <span
                    key={`${char}-${index}`}
                    className="message-delete-fume-char"
                    style={{ '--char-delay': `${(chars.length - 1 - index) * 22}ms` }}
                  >
                    {char === ' ' ? '\u00A0' : char}
                  </span>
                ))}
              </div>
            ) : (
              <MessageContent 
                msg={msg} 
                isEditing={isEditing}
                editContent={editContent}
                setEditContent={setEditContent}
                onSaveEdit={onSaveEdit}
                onCancelEdit={onCancelEdit}
                onStickerClick={onStickerClick}
                currentUserName={currentUserName}
                mentionUsers={mentionUsers}
                onMentionClick={onMentionClick}
                t={t}
              />
            )}
            <MessageReactions 
              reactions={reactions} 
              currentUserId={currentUserId}
              onToggleReaction={(emoji, hasReacted) => onToggleReaction(msg.id, emoji, hasReacted)}
            />
            {msg.edited_at && <span className="message-edited">({t('chat.edited')})</span>}
            {isOwn && msg._failed && (
              <span className="message-send-status">
                {msg._failed && onRetryFailedMessage && (
                  <button type="button" className="message-status-retry" onClick={() => onRetryFailedMessage(msg)} title={t('chat.retrySend')}>
                    {t('chat.retrySend')}
                  </button>
                )}
              </span>
            )}
          </>
        )}
      </div>
    </div>
  );
});

const MessageList = memo(forwardRef(function MessageList({
  messages,
  currentUserId,
  currentUserName,
  onEdit,
  onDeleteForMe,
  onDeleteForAll,
  onRequestDeleteCaption = null,
  onDismissSystemMessage = null,
  readReceipts = {},
  otherUsers = [],
  onUserClick,
  onReply,
  onAddReaction,
  onRemoveReaction,
  onPin,
  onUnpin,
  messageReactions = {},
  pinnedMessageIds = [],
  onRetryFailedMessage = null,
  isDM = false,
  topBanner = null,
  loading = false,
  lastReadMessageId = null,
  onMarkRead = null,
  serverName = null,
  onInviteClick = null,
  onFocusInput = null,
  roles = null,
  memberRolesMap = null,
  members = null,
  canModerateReactions = false,
}, ref) {
  const containerRef = useRef(null);
  const isAtBottomRef = useRef(true);
  const prevMessagesLengthRef = useRef(0);
  const lastMessageIdRef = useRef(null);
  const firstMessageIdRef = useRef(null);
  const isInitialMount = useRef(true);
  const scrollRestoreRef = useRef(null);
  const lastScrollTopRef = useRef(0);
  const prevLengthForMaterializeRef = useRef(0);
  
  const [contextMenu, setContextMenu] = useState(null);
  const [selectedMessageId, setSelectedMessageId] = useState(null);
  const [editingId, setEditingId] = useState(null);
  const [editContent, setEditContent] = useState('');
  const [reactionPicker, setReactionPicker] = useState(null);
  const [reactionsViewer, setReactionsViewer] = useState(null);
  const [stickerPackModal, setStickerPackModal] = useState(null);
  const [reportModal, setReportModal] = useState(null);
  const [showJumpToBottom, setShowJumpToBottom] = useState(false);
  const [newMessagesBelow, setNewMessagesBelow] = useState(0);
  const [mentionProfileUser, setMentionProfileUser] = useState(null);
  const [mentionProfilePos, setMentionProfilePos] = useState(null);
  
  const { settings, isCompactMode, showAvatars, showEmbeds, animateEmoji } = useSettings();
  const { t } = useLanguage();
  const { blockedIds } = useBlockedUsers();
  const [revealedBlockedIds, setRevealedBlockedIds] = useState(() => new Set());

  const pinnedIdsSet = useMemo(() => new Set(pinnedMessageIds), [pinnedMessageIds]);
  const cachedRecentEmojis = useMemo(() => getRecentEmojis().slice(0, 3), []);

  // Enrich otherUsers with message senders so mentions resolve without API call
  const mentionUsers = useMemo(() => {
    const byId = new Map();
    otherUsers.forEach((u) => u?.id != null && byId.set(u.id, u));
    messages.forEach((m) => {
      const s = m.sender;
      if (s?.id != null && !byId.has(s.id)) byId.set(s.id, s);
    });
    return Array.from(byId.values());
  }, [otherUsers, messages]);

  // Track Shift key for quick-delete hover actions
  const [isShiftHeld, setIsShiftHeld] = useState(false);
  useEffect(() => {
    const down = (e) => { if (e.key === 'Shift') setIsShiftHeld(true); };
    const up = (e) => { if (e.key === 'Shift') setIsShiftHeld(false); };
    const blur = () => setIsShiftHeld(false);
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('blur', blur);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      window.removeEventListener('blur', blur);
    };
  }, []);

  // Detect conversation change and reset scroll state (useLayoutEffect so it runs before scroll effect)
  const firstMsgId = messages[0]?.id;
  useLayoutEffect(() => {
    if (firstMsgId && firstMsgId !== firstMessageIdRef.current) {
      // New conversation detected - reset scroll state
      isInitialMount.current = true;
      isAtBottomRef.current = true;
      prevMessagesLengthRef.current = 0;
      lastMessageIdRef.current = null;
      firstMessageIdRef.current = firstMsgId;
    }
  }, [firstMsgId]);

  const scrollToBottom = useCallback((instant = false) => {
    if (!containerRef.current) return;
    const behavior = instant ? 'auto' : 'smooth';
    const v = virtualizerRef.current;
    if (v?.useVirtualization && v?.virtualizer) {
      v.virtualizer.scrollToIndex(v.itemCount - 1, { align: 'end', behavior });
    } else {
      containerRef.current.scrollTo({ top: containerRef.current.scrollHeight, behavior });
    }
  }, []);

  // Expose methods to parent via ref
  useImperativeHandle(ref, () => ({
    startEdit: (msg) => {
      if (!msg) return;
      if (msg.type === 'text') {
        setEditingId(msg.id);
        setEditContent(msg.content || '');
      } else if (msg.type === 'image' || msg.type === 'file') {
        setEditingId(msg.id);
        setEditContent(msg.caption || '');
      }
    },
    preserveScroll: () => {
      if (containerRef.current) {
        const top = containerRef.current.scrollTop;
        lastScrollTopRef.current = top;
        if (scrollRestoreRef.current == null) scrollRestoreRef.current = top;
      }
    },
    scrollToBottom,
  }), [scrollToBottom]);

  const virtualizerRef = useRef(null);

  const checkIfAtBottom = useCallback(() => {
    if (!containerRef.current) return true;
    const { scrollTop, scrollHeight, clientHeight } = containerRef.current;
    return scrollHeight - scrollTop - clientHeight < 50;
  }, []);

  // Scroll to bottom on initial load and when switching conversations
  useLayoutEffect(() => {
    if (isInitialMount.current && messages.length > 0) {
      // Defer scroll to next frame so virtualizer/DOM layout is ready
      const id = requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          scrollToBottom();
        });
      });
      isInitialMount.current = false;
      prevMessagesLengthRef.current = messages.length;
      lastMessageIdRef.current = messages[messages.length - 1]?.id;
      return () => cancelAnimationFrame(id);
    }
  }, [messages.length, firstMsgId, scrollToBottom]);

  // Restore scroll position after edit or system message (prevents scroll jump)
  // Use multiple restore passes to override virtualizer's internal scroll adjustments
  useLayoutEffect(() => {
    const saved = scrollRestoreRef.current;
    if (saved != null && containerRef.current) {
      scrollRestoreRef.current = null;
      const restore = () => {
        if (containerRef.current) {
          const maxScroll = containerRef.current.scrollHeight - containerRef.current.clientHeight;
          containerRef.current.scrollTop = Math.min(saved, Math.max(0, maxScroll));
        }
      };
      restore();
      const id1 = requestAnimationFrame(() => { restore(); });
      const id2 = setTimeout(restore, 50);
      const id3 = setTimeout(restore, 150);
      return () => {
        cancelAnimationFrame(id1);
        clearTimeout(id2);
        clearTimeout(id3);
      };
    }
  }, [messages]);

  // Restore scroll when container resizes (e.g. DMCallView appears)
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const target = scrollRestoreRef.current ?? lastScrollTopRef.current;
      if (target != null && containerRef.current) {
        const maxScroll = containerRef.current.scrollHeight - containerRef.current.clientHeight;
        containerRef.current.scrollTop = Math.min(target, Math.max(0, maxScroll));
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Scroll to bottom when new messages arrive (only if user was at bottom)
  // Never auto-scroll for system messages (call started/ended) - preserve user's position
  useLayoutEffect(() => {
    if (isInitialMount.current || messages.length === 0) return;

    const lastMessage = messages[messages.length - 1];
    const lastMessageId = lastMessage?.id;
    const isSystemMessage = lastMessage?.type === 'system';

    // Only scroll if there's a genuinely new message (different ID)
    const isNewMessage = lastMessageId && lastMessageId !== lastMessageIdRef.current &&
                         messages.length >= prevMessagesLengthRef.current;
    const isOwnMessage = lastMessage?.sender_id === currentUserId;

    if (isNewMessage && !isSystemMessage) {
      // Always scroll when we send a message (GIF, sticker, etc.) so we see it
      if (isOwnMessage || isAtBottomRef.current) {
        scrollToBottom(isOwnMessage || isAtBottomRef.current);
      } else {
        setShowJumpToBottom(true);
        setNewMessagesBelow(prev => prev + 1);
      }
    }

    prevMessagesLengthRef.current = messages.length;
    lastMessageIdRef.current = lastMessageId;
  }, [messages, scrollToBottom, currentUserId]);

  const handleScroll = useCallback(() => {
    if (containerRef.current) {
      lastScrollTopRef.current = containerRef.current.scrollTop;
    }
    const atBottom = checkIfAtBottom();
    isAtBottomRef.current = atBottom;
    if (atBottom) {
      setShowJumpToBottom(false);
      setNewMessagesBelow(0);
      if (onMarkRead) onMarkRead();
    }
    setContextMenu(prev => (prev ? null : prev));
    setSelectedMessageId(null);
  }, [checkIfAtBottom, onMarkRead]);

  // Context menu handlers — right-click selects message (hover effects stay on it only)
  const handleContextMenu = useCallback((e, msg) => {
    e.preventDefault();
    setSelectedMessageId(msg.id);
    setContextMenu({ x: e.clientX, y: e.clientY, msg });
  }, []);

  const closeContextMenu = useCallback(() => setContextMenu(null), []);

  const handleReport = useCallback((msg) => {
    setReportModal({
      userId: msg.sender_id,
      username: msg.sender?.username || msg.sender?.display_name || 'utilisateur',
      messageId: msg.id,
    });
  }, []);

  // Clear selection when clicking outside selected message and context menu
  useEffect(() => {
    if (!selectedMessageId) return;
    const handleClickAway = (e) => {
      if (e.target.closest('.message-context-menu') || e.target.closest('.context-menu')) return;
      if (e.target.closest(`[data-message-id="${selectedMessageId}"]`)) return;
      setSelectedMessageId(null);
    };
    document.addEventListener('mousedown', handleClickAway);
    return () => document.removeEventListener('mousedown', handleClickAway);
  }, [selectedMessageId]);
  
  // Edit handlers
  const handleStartEdit = useCallback((msg) => {
    if (!msg) return;
    setEditingId(msg.id);
    setEditContent(msg.type === 'text' ? (msg.content || '') : (msg.caption || ''));
  }, []);
  
  const handleSaveEdit = useCallback(() => {
    if (!editingId) {
      setEditingId(null);
      setEditContent('');
      return;
    }
    // Preserve scroll position before edit triggers re-render
    if (containerRef.current) {
      scrollRestoreRef.current = containerRef.current.scrollTop;
    }
    const trimmed = editContent.trim();
    const msg = messages.find(m => m.id === editingId);
    const originalContent = msg?.type === 'text' ? (msg.content || '').trim() : (msg?.caption || '').trim();
    if (trimmed && onEdit && trimmed !== originalContent) {
      onEdit(editingId, trimmed);
    } else if (!trimmed && msg) {
      if ((msg.type === 'image' || msg.type === 'file') && onRequestDeleteCaption) {
        onRequestDeleteCaption(msg);
      } else if (onDeleteForAll) {
        onDeleteForAll(msg, true);
      }
    }
    setEditingId(null);
    setEditContent('');
  }, [editingId, editContent, onEdit, onDeleteForAll, onRequestDeleteCaption, messages]);
  
  const handleCancelEdit = useCallback(() => {
    setEditingId(null);
    setEditContent('');
  }, []);

  // Global Escape to cancel edit (window capture so we run before other handlers)
  useEffect(() => {
    if (!editingId) return;
    const handleEscape = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        handleCancelEdit();
      }
    };
    window.addEventListener('keydown', handleEscape, true);
    return () => window.removeEventListener('keydown', handleEscape, true);
  }, [editingId, handleCancelEdit]);
  
  // Copy handler
  const handleCopy = useCallback((msg) => {
    const text = msg.type === 'text' ? msg.content : (msg.attachment?.file_url || msg.content);
    navigator.clipboard.writeText(text).catch(console.error);
  }, []);

  const handleMentionClick = useCallback((userOrUsername, e) => {
    const pos = { x: e.clientX, y: e.clientY };
    setMentionProfilePos(pos);
    if (userOrUsername?.id) {
      setMentionProfileUser(userOrUsername);
    } else {
      const username = typeof userOrUsername === 'string' ? userOrUsername : userOrUsername?.username;
      if (username) {
        usersApi.getByUsername(username)
          .then((u) => { setMentionProfileUser(u); setMentionProfilePos(pos); })
          .catch(() => {});
      }
    }
  }, []);
  
  // Sticker pack modal handlers
  const handleStickerClick = useCallback(async (stickerUrl) => {
    setStickerPackModal({ pack: null, loading: true, saving: false });
    try {
      const pack = await stickersApi.getPackBySticker(stickerUrl);
      setStickerPackModal({ pack, loading: false, saving: false });
    } catch (err) {
      console.error('Error fetching sticker pack:', err);
      setStickerPackModal(null);
    }
  }, []);

  const handleSavePack = useCallback(async () => {
    if (!stickerPackModal?.pack) return;
    setStickerPackModal(prev => ({ ...prev, saving: true }));
    try {
      await stickersApi.savePack(stickerPackModal.pack.id);
      setStickerPackModal(prev => ({ 
        ...prev, 
        pack: { ...prev.pack, is_saved: true, can_save: false },
        saving: false 
      }));
    } catch (err) {
      console.error('Error saving pack:', err);
      setStickerPackModal(prev => ({ ...prev, saving: false }));
    }
  }, [stickerPackModal?.pack]);

  const handleUnsavePack = useCallback(async () => {
    if (!stickerPackModal?.pack) return;
    setStickerPackModal(prev => ({ ...prev, saving: true }));
    try {
      await stickersApi.unsavePack(stickerPackModal.pack.id);
      setStickerPackModal(prev => ({ 
        ...prev, 
        pack: { ...prev.pack, is_saved: false, can_add: true },
        saving: false 
      }));
    } catch (err) {
      console.error('Error unsaving pack:', err);
      setStickerPackModal(prev => ({ ...prev, saving: false }));
    }
  }, [stickerPackModal?.pack]);

  const handleRevealBlockedMessage = useCallback((messageId) => {
    setRevealedBlockedIds((prev) => new Set(prev).add(messageId));
  }, []);

  const handleUnhidePack = useCallback(async () => {
    if (!stickerPackModal?.pack) return;
    setStickerPackModal(prev => ({ ...prev, saving: true }));
    try {
      await stickersApi.unhidePack(stickerPackModal.pack.id);
      setStickerPackModal(prev => ({ 
        ...prev, 
        pack: { ...prev.pack, is_hidden: false, can_add: false },
        saving: false 
      }));
    } catch (err) {
      console.error('Error unhiding pack:', err);
      setStickerPackModal(prev => ({ ...prev, saving: false }));
    }
  }, [stickerPackModal?.pack]);

  const handleCloseStickerPackModal = useCallback(() => {
    setStickerPackModal(null);
  }, []);

  // Reaction handlers
  const handleCloseReactionPicker = useCallback(() => {
    setReactionPicker(null);
  }, []);

  const handleOpenReactionPicker = useCallback((m) => {
    const el = containerRef.current?.querySelector(`[data-message-id="${m.id}"]`);
    const rect = el?.getBoundingClientRect();
    if (rect) setReactionPicker({ x: rect.right - 200, y: rect.top, msg: m });
  }, []);


  const handleSelectReaction = useCallback((emoji) => {
    if (reactionPicker && onAddReaction) {
      const msgId = reactionPicker.messageId || reactionPicker.msg?.id;
      if (msgId) {
        saveRecentEmoji(emoji);
        onAddReaction(msgId, emoji);
      }
    }
  }, [reactionPicker, onAddReaction]);

  const handleToggleReaction = useCallback((messageId, emoji, hasReacted) => {
    if (hasReacted && onRemoveReaction) {
      onRemoveReaction(messageId, emoji);
    } else if (!hasReacted && onAddReaction) {
      saveRecentEmoji(emoji);
      onAddReaction(messageId, emoji);
    }
  }, [onAddReaction, onRemoveReaction]);

  const handleViewReactions = useCallback((msg) => {
    setReactionsViewer(msg);
  }, []);

  const handleCloseReactionsViewer = useCallback(() => {
    setReactionsViewer(null);
  }, []);

  const handleRemoveReactionFromViewer = useCallback((messageId, emoji, targetUserId) => {
    if (!onRemoveReaction) return;
    onRemoveReaction(messageId, emoji, targetUserId);
  }, [onRemoveReaction]);

  // Create a map of messages by ID for quick lookup (for replies)
  const messagesById = useMemo(() => {
    const map = {};
    messages.forEach(msg => { map[msg.id] = msg; });
    return map;
  }, [messages]);

  // Process messages
  const processedMessages = useMemo(() => {
    // Find the ID of the last message sent by current user
    let lastOwnMessageId = null;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].sender_id === currentUserId) {
        lastOwnMessageId = messages[i].id;
        break;
      }
    }
    
    let lastDateStr = null;
    return messages.map((msg, index) => {
      const prev = messages[index - 1];
      const next = messages[index + 1];
      const isSystem = msg.type === 'system';
      const isOwn = !isSystem && msg.sender_id === currentUserId;
      const isLastOwnMessage = !isSystem && msg.id === lastOwnMessageId;
      
      const msgDate = msg.created_at ? new Date(msg.created_at) : new Date();
      const dateStr = isNaN(msgDate.getTime()) ? '' : msgDate.toLocaleDateString('fr-FR', { year: 'numeric', month: 'long', day: 'numeric' });
      const showDateSeparator = dateStr !== lastDateStr;
      lastDateStr = dateStr;

      const TIME_GAP_MINUTES = 5;

      const prevDate = prev?.created_at ? new Date(prev.created_at) : null;
      const prevGapMinutes = prevDate && !isNaN(prevDate.getTime()) ? (msgDate.getTime() - prevDate.getTime()) / (1000 * 60) : Infinity;
      const tooFarFromPrev = prevGapMinutes >= TIME_GAP_MINUTES;

      // Don't group webhook with non-webhook: webhooks use creator's sender_id, so your messages
      // could incorrectly appear under the bot's header (e.g. "test BOT") if we only check sender_id
      const sameWebhookKind = !!prev?.is_webhook === !!msg.is_webhook;
      const sameSenderAsPrev = !isSystem && prev && prev.sender_id === msg.sender_id && prev.type !== 'system' && !tooFarFromPrev && sameWebhookKind;
      const nextDate = next?.created_at ? new Date(next.created_at) : null;
      const nextGapMinutes = nextDate && !isNaN(nextDate.getTime()) ? (nextDate.getTime() - msgDate.getTime()) / (1000 * 60) : Infinity;
      const tooFarFromNext = nextGapMinutes >= TIME_GAP_MINUTES;

      const sameWebhookKindNext = !!next?.is_webhook === !!msg.is_webhook;
      const sameSenderAsNext = !isSystem && next && next.sender_id === msg.sender_id && next.type !== 'system' && !tooFarFromNext && sameWebhookKindNext;
      
      const formattedTime = isNaN(msgDate.getTime()) ? '' : msgDate.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
      
      const showTime = nextGapMinutes >= 3;
      
      // Find users who have read up to this message
      // Only show on the LAST message sent by current user
      const readByUsers = [];
      if (isOwn && isLastOwnMessage) {
        for (const [userId, lastReadId] of Object.entries(readReceipts)) {
          if (parseInt(userId) !== currentUserId && lastReadId >= msg.id) {
            const user = otherUsers.find(u => u.id === parseInt(userId));
            if (user) readByUsers.push(user.display_name);
          }
        }
      }
      
      // Find the message being replied to
      const replyToMessage = msg.reply_to_id ? messagesById[msg.reply_to_id] : null;
      
      return {
        ...msg,
        renderKey: msg._clientKey || msg.id,
        isSystem,
        isOwn,
        sender: msg.sender || {},
        formattedTime,
        showTime,
        isFirst: !sameSenderAsPrev || showDateSeparator,
        isLast: !sameSenderAsNext,
        readByUsers,
        replyToMessage,
        showDateSeparator,
        dateLabel: dateStr,
      };
    });
  }, [messages, currentUserId, readReceipts, otherUsers, messagesById]);

  // Liste des items virtuels (banner optionnel + messages)
  const virtualItems = useMemo(() => {
    const items = [];
    if (topBanner) items.push({ rowType: 'banner', id: '__banner__' });
    processedMessages.forEach((msg, i) => items.push({ rowType: 'message', ...msg, virtualIndex: i }));
    return items;
  }, [processedMessages, topBanner]);

  const useVirtualization = virtualItems.length >= VIRTUALIZATION_THRESHOLD;

  const rowVirtualizer = useVirtualizer({
    count: virtualItems.length,
    getScrollElement: () => containerRef.current,
    estimateSize: (index) => {
      const item = virtualItems[index];
      if (item?.rowType === 'banner') return 120;
      if (!item || item.rowType !== 'message') return ESTIMATED_MESSAGE_HEIGHT;
      let est = ESTIMATED_MESSAGE_HEIGHT;
      if (item.isSystem) return 48;
      if (item.showDateSeparator) est += 36;
      if (item.type === 'image' || item.type === 'file') est += 80;
      return est;
    },
    overscan: 10,
  });

  virtualizerRef.current = useVirtualization
    ? { useVirtualization: true, virtualizer: rowVirtualizer, itemCount: virtualItems.length }
    : null;

  // Only run materialize animation when the last message was newly added (not when it became last after a delete)
  const shouldAnimateLastMaterialize = messages.length > prevLengthForMaterializeRef.current;
  useLayoutEffect(() => {
    prevLengthForMaterializeRef.current = messages.length;
  }, [messages.length]);

  // Scroll to a specific message by ID
  const scrollToMessage = useCallback((messageId) => {
    if (useVirtualization) {
      const idx = virtualItems.findIndex((it) => it.rowType === 'message' && it.id === messageId);
      if (idx >= 0) {
        rowVirtualizer.scrollToIndex(idx, { align: 'center', behavior: 'smooth' });
        setTimeout(() => {
          const el = containerRef.current?.querySelector(`[data-message-id="${messageId}"]`);
          el?.classList.add('message-highlight');
          setTimeout(() => el?.classList.remove('message-highlight'), 2000);
        }, 300);
      }
    } else {
      const messageElement = containerRef.current?.querySelector(`[data-message-id="${messageId}"]`);
      if (messageElement) {
        messageElement.scrollIntoView({ behavior: 'smooth', block: 'center' });
        messageElement.classList.add('message-highlight');
        setTimeout(() => messageElement.classList.remove('message-highlight'), 2000);
      }
    }
  }, [useVirtualization, virtualItems, rowVirtualizer]);

  const handleJumpToBottom = useCallback(() => {
    scrollToBottom();
    setShowJumpToBottom(false);
    setNewMessagesBelow(0);
    if (onMarkRead) onMarkRead();
  }, [scrollToBottom, onMarkRead]);

  return (
    <div className="message-list-container">
      <div
        className="message-list"
        ref={containerRef}
        onScroll={handleScroll}
        data-display={isCompactMode ? 'compact' : 'cozy'}
        data-hide-avatars={!showAvatars}
        data-hide-embeds={!showEmbeds}
        data-animate-emoji={animateEmoji}
        data-has-selected={selectedMessageId ? '' : undefined}
      >
        {!useVirtualization && topBanner}
        {loading ? (
          <div className="message-skeleton-list">
            {Array.from({ length: 8 }).map((_, i) => (
              <div key={i} className="message-skeleton-item">
                <div className="skeleton-avatar" />
                <div className="skeleton-lines">
                  <div className="skeleton-line skeleton-line-name" style={{ width: `${60 + (i % 3) * 20}px` }} />
                  <div className="skeleton-line" style={{ width: `${120 + (i % 5) * 40}px` }} />
                  {i % 2 === 0 && <div className="skeleton-line" style={{ width: `${80 + (i % 4) * 30}px` }} />}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <>
            {messages.length === 0 && (
              !isDM && serverName && (onInviteClick || onFocusInput) ? (
                <div className="channel-welcome">
                  <h2 className="channel-welcome-title">{t('chat.welcomeTitle', { name: serverName })}</h2>
                  <p className="channel-welcome-desc">
                    {t('chat.welcomeDescription')}{' '}
                    <Link to="/nitro" className="channel-welcome-link">{t('chat.welcomeGettingStarted')}</Link>
                  </p>
                  <div className="channel-welcome-actions">
                    {onInviteClick && (
                      <button type="button" className="channel-welcome-btn" onClick={onInviteClick}>
                        <UserPlus size={20} strokeWidth={2} />
                        <span>{t('chat.inviteFriends')}</span>
                        <ChevronRight size={18} strokeWidth={2} />
                      </button>
                    )}
                    {onFocusInput && (
                      <button type="button" className="channel-welcome-btn" onClick={onFocusInput}>
                        <Send size={20} strokeWidth={2} />
                        <span>{t('chat.sendFirstMessage')}</span>
                        <ChevronRight size={18} strokeWidth={2} />
                      </button>
                    )}
                  </div>
                </div>
              ) : (
                <div className="message-list-empty">
                  {t('chat.sendFirst')}
                </div>
              )
            )}
            {useVirtualization ? (
              <div
                style={{
                  height: `${rowVirtualizer.getTotalSize()}px`,
                  width: '100%',
                  position: 'relative',
                }}
              >
                {rowVirtualizer.getVirtualItems().map((virtualRow) => {
                  const item = virtualItems[virtualRow.index];
                  if (!item) return null;
                  if (item.rowType === 'banner') {
                    return (
                      <div
                        key="__banner__"
                        ref={rowVirtualizer.measureElement}
                        data-index={virtualRow.index}
                        style={{
                          position: 'absolute',
                          top: 0,
                          left: 0,
                          width: '100%',
                          transform: `translateY(${virtualRow.start}px)`,
                        }}
                      >
                        {topBanner}
                      </div>
                    );
                  }
                  const msg = item;
                  const showUnreadDivider = lastReadMessageId && msg.id === lastReadMessageId;
                  const isLastRow = virtualRow.index === virtualItems.length - 1;
                  return (
                    <div
                      key={msg.renderKey}
                      ref={rowVirtualizer.measureElement}
                      data-index={virtualRow.index}
                      style={{
                        position: 'absolute',
                        top: 0,
                        left: 0,
                        width: '100%',
                        transform: `translateY(${virtualRow.start}px)`,
                      }}
                    >
                      {msg.showDateSeparator && (
                        <div className="date-separator">
                          <span className="date-separator-label">{msg.dateLabel}</span>
                        </div>
                      )}
                      {showUnreadDivider && (
                        <div className="unread-divider">
                          <span className="unread-divider-label">NEW MESSAGES</span>
                        </div>
                      )}
                      {(msg.isCommand || msg.subtype === 'command_result') ? (
                        <CommandResultRow msg={msg} t={t} />
                      ) : msg.isSystem ? (
                        <SystemMessageRow
                          msg={msg}
                          currentUserId={currentUserId}
                          onDismissSystemMessage={onDismissSystemMessage}
                          t={t}
                        />
                      ) : (
                      <MessageItem
                        msg={msg}
                        isOwn={msg.isOwn}
                        sender={msg.sender}
                        showTime={msg.showTime}
                        formattedTime={msg.formattedTime}
                        isFirst={msg.isFirst}
                        isLast={msg.isLast}
                        onContextMenu={handleContextMenu}
                        isEditing={editingId === msg.id}
                        editContent={editContent}
                        setEditContent={setEditContent}
                        onSaveEdit={handleSaveEdit}
                        onCancelEdit={handleCancelEdit}
                        readByUsers={msg.readByUsers}
                        onUserClick={onUserClick}
                        replyToMessage={msg.replyToMessage}
                        onScrollToMessage={scrollToMessage}
                        reactions={messageReactions[msg.id] || EMPTY_REACTIONS}
                        currentUserId={currentUserId}
                        currentUserName={currentUserName}
                        onToggleReaction={handleToggleReaction}
                        isPinned={pinnedIdsSet.has(msg.id)}
                        onStickerClick={handleStickerClick}
                        onReply={onReply}
                        onReact={onAddReaction ? handleOpenReactionPicker : null}
                        onEdit={handleStartEdit}
                        isShiftHeld={isShiftHeld}
                        mentionUsers={mentionUsers}
                        onMentionClick={handleMentionClick}
                        onDeleteForMe={onDeleteForMe}
                        onDeleteForAll={onDeleteForAll}
                        isDM={isDM}
                        t={t}
                        recentEmojis={cachedRecentEmojis}
                        isBlocked={!msg.isOwn && blockedIds.has(Number(msg.sender_id) || msg.sender_id)}
                        isRevealed={revealedBlockedIds.has(msg.id)}
                        onReveal={() => handleRevealBlockedMessage(msg.id)}
                        onRetryFailedMessage={onRetryFailedMessage}
                        isSelected={selectedMessageId === msg.id}
                        serverRoleBadges={roles && memberRolesMap && msg.sender?.id ? (roles.filter(r => (memberRolesMap[msg.sender.id] || []).includes(r.id)).map(r => ({ name: r.name, color: r.color }))) : null}
                        serverTeamRole={members && msg.sender?.id ? (members.find(m => m.id == msg.sender.id))?.role : null}
                        reduceMotion={!!settings?.reduce_motion}
                        animateMaterialize={isLastRow && shouldAnimateLastMaterialize}
                      />
                      )}
                    </div>
                  );
                })}
              </div>
            ) : (
              (() => {
                let passedLastRead = false;
                return processedMessages.map((msg, msgIndex) => {
                  const showDivider = lastReadMessageId && !passedLastRead && msg.id === lastReadMessageId;
                  if (showDivider) passedLastRead = true;
                  const isLastRow = msgIndex === processedMessages.length - 1;
                  return (
                    <React.Fragment key={msg.renderKey}>
                      {msg.showDateSeparator && (
                        <div className="date-separator">
                          <span className="date-separator-label">{msg.dateLabel}</span>
                        </div>
                      )}
                      {showDivider && (
                        <div className="unread-divider">
                          <span className="unread-divider-label">NEW MESSAGES</span>
                        </div>
                      )}
                      {(msg.isCommand || msg.subtype === 'command_result') ? (
                        <CommandResultRow msg={msg} t={t} />
                      ) : msg.isSystem ? (
                        <SystemMessageRow
                          msg={msg}
                          currentUserId={currentUserId}
                          onDismissSystemMessage={onDismissSystemMessage}
                          t={t}
                        />
                      ) : (
                      <MessageItem
                        msg={msg}
                        isOwn={msg.isOwn}
                        sender={msg.sender}
                        showTime={msg.showTime}
                        formattedTime={msg.formattedTime}
                        isFirst={msg.isFirst}
                        isLast={msg.isLast}
                        onContextMenu={handleContextMenu}
                        isEditing={editingId === msg.id}
                        editContent={editContent}
                        setEditContent={setEditContent}
                        onSaveEdit={handleSaveEdit}
                        onCancelEdit={handleCancelEdit}
                        readByUsers={msg.readByUsers}
                        onUserClick={onUserClick}
                        replyToMessage={msg.replyToMessage}
                        onScrollToMessage={scrollToMessage}
                        reactions={messageReactions[msg.id] || EMPTY_REACTIONS}
                        currentUserId={currentUserId}
                        currentUserName={currentUserName}
                        onToggleReaction={handleToggleReaction}
                        isPinned={pinnedIdsSet.has(msg.id)}
                        onStickerClick={handleStickerClick}
                        onReply={onReply}
                        onReact={onAddReaction ? handleOpenReactionPicker : null}
                        onEdit={handleStartEdit}
                        isShiftHeld={isShiftHeld}
                        mentionUsers={mentionUsers}
                        onMentionClick={handleMentionClick}
                        onDeleteForMe={onDeleteForMe}
                        onDeleteForAll={onDeleteForAll}
                        isDM={isDM}
                        t={t}
                        recentEmojis={cachedRecentEmojis}
                        isBlocked={!msg.isOwn && blockedIds.has(Number(msg.sender_id) || msg.sender_id)}
                        isRevealed={revealedBlockedIds.has(msg.id)}
                        onReveal={() => handleRevealBlockedMessage(msg.id)}
                        onRetryFailedMessage={onRetryFailedMessage}
                        isSelected={selectedMessageId === msg.id}
                        serverRoleBadges={roles && memberRolesMap && msg.sender?.id ? (roles.filter(r => (memberRolesMap[msg.sender.id] || []).includes(r.id)).map(r => ({ name: r.name, color: r.color }))) : null}
                        serverTeamRole={members && msg.sender?.id ? (members.find(m => m.id == msg.sender.id))?.role : null}
                        reduceMotion={!!settings?.reduce_motion}
                        animateMaterialize={isLastRow && shouldAnimateLastMaterialize}
                      />
                      )}
                    </React.Fragment>
                  );
                });
              })()
            )}
          </>
        )}
      </div>
      {showJumpToBottom && (
        <button className="jump-to-bottom" onClick={handleJumpToBottom} title="Jump to bottom">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
            <path d="M7 10l5 5 5-5z"/>
          </svg>
          {newMessagesBelow > 0 && (
            <span className="jump-to-bottom-badge">{newMessagesBelow > 99 ? '99+' : newMessagesBelow}</span>
          )}
        </button>
      )}
      {contextMenu && (
        <MessageMenu
          x={contextMenu.x}
          y={contextMenu.y}
          msg={contextMenu.msg}
          isOwn={contextMenu.msg.sender_id === currentUserId}
          isDM={isDM}
          reactions={messageReactions[contextMenu.msg.id] || EMPTY_REACTIONS}
          onViewReactions={handleViewReactions}
          onClose={closeContextMenu}
          onEdit={handleStartEdit}
          onCopy={handleCopy}
          onDeleteForMe={onDeleteForMe}
          onDeleteForAll={onDeleteForAll}
          onReply={onReply}
          onReact={onAddReaction ? (msg) => {
            setReactionPicker({ x: contextMenu.x, y: contextMenu.y, msg });
          } : null}
          onPin={onPin}
          onUnpin={onUnpin}
          isPinned={pinnedIdsSet.has(contextMenu.msg.id)}
          onReport={handleReport}
          t={t}
        />
      )}
      {reactionsViewer && (
        <ReactionsViewerModal
          message={reactionsViewer}
          reactions={messageReactions[reactionsViewer.id] || EMPTY_REACTIONS}
          canModerateReactions={canModerateReactions}
          currentUserId={currentUserId}
          onRemoveReaction={handleRemoveReactionFromViewer}
          onClose={handleCloseReactionsViewer}
          t={t}
        />
      )}
      {reactionPicker && (
        <ReactionPicker
          x={reactionPicker.x}
          y={reactionPicker.y}
          onSelect={handleSelectReaction}
          onClose={handleCloseReactionPicker}
        />
      )}
      {reportModal && (
        <ReportModal
          reportedUserId={reportModal.userId}
          reportedUsername={reportModal.username}
          messageId={reportModal.messageId}
          onClose={() => setReportModal(null)}
          onBlock={(userId) => {
            // Optimistically update blocked state if hook supports it
          }}
        />
      )}
      {stickerPackModal && createPortal(
        <div className="sticker-pack-modal-overlay" onClick={handleCloseStickerPackModal}>
          <div className="sticker-pack-modal" onClick={e => e.stopPropagation()}>
            {stickerPackModal.loading ? (
              <div className="sticker-pack-modal-skeleton">
                <div className="sticker-pack-modal-skeleton-header" />
                <div className="sticker-pack-modal-skeleton-info">
                  <div className="sticker-pack-modal-skeleton-line" />
                  <div className="sticker-pack-modal-skeleton-line short" />
                </div>
              </div>
            ) : stickerPackModal.pack ? (
              <>
                <div className="sticker-pack-modal-header">
                  <h3>{stickerPackModal.pack.name}</h3>
                  <button className="sticker-pack-modal-close" onClick={handleCloseStickerPackModal}>
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <line x1="18" y1="6" x2="6" y2="18"/>
                      <line x1="6" y1="6" x2="18" y2="18"/>
                    </svg>
                  </button>
                </div>
                <div className="sticker-pack-modal-info">
                  <span className="sticker-pack-modal-team">{stickerPackModal.pack.team_name}</span>
                  <span className="sticker-pack-modal-count">{stickerPackModal.pack.sticker_count} {t('chat.stickerPack.stickers')}</span>
                  <span className="sticker-pack-modal-creator">{t('chat.stickerPack.by')} {stickerPackModal.pack.creator_name}</span>
                </div>
                <div className="sticker-pack-modal-actions">
                  {stickerPackModal.pack.is_hidden ? (
                    <button 
                      className="sticker-pack-modal-btn sticker-pack-modal-btn-primary"
                      onClick={handleUnhidePack}
                      disabled={stickerPackModal.saving}
                    >
                      {stickerPackModal.saving ? t('chat.stickerPack.recovering') : t('chat.stickerPack.recoverPack')}
                    </button>
                  ) : stickerPackModal.pack.is_team_member && !stickerPackModal.pack.is_saved ? (
                    <p className="sticker-pack-modal-status">{t('chat.stickerPack.havePack')}</p>
                  ) : stickerPackModal.pack.is_saved ? (
                    <button 
                      className="sticker-pack-modal-btn sticker-pack-modal-btn-danger"
                      onClick={handleUnsavePack}
                      disabled={stickerPackModal.saving}
                    >
                      {stickerPackModal.saving ? t('chat.stickerPack.removing') : t('chat.stickerPack.removePack')}
                    </button>
                  ) : (
                    <button 
                      className="sticker-pack-modal-btn sticker-pack-modal-btn-primary"
                      onClick={handleSavePack}
                      disabled={stickerPackModal.saving}
                    >
                      {stickerPackModal.saving ? t('chat.stickerPack.adding') : t('chat.stickerPack.addPack')}
                    </button>
                  )}
                  <button 
                    className="sticker-pack-modal-btn"
                    onClick={handleCloseStickerPackModal}
                  >
                    {t('chat.stickerPack.close')}
                  </button>
                </div>
              </>
            ) : (
              <div className="sticker-pack-modal-error">
                <p>{t('chat.stickerPack.notFound')}</p>
                <button className="sticker-pack-modal-btn" onClick={handleCloseStickerPackModal}>{t('chat.stickerPack.close')}</button>
              </div>
            )}
          </div>
        </div>,
        document.body
      )}
      {mentionProfileUser && (
        <ProfileCard
          userId={mentionProfileUser.id}
          user={mentionProfileUser}
          isOpen={!!mentionProfileUser}
          onClose={() => setMentionProfileUser(null)}
          clickPos={mentionProfilePos}
          position="right"
        />
      )}
    </div>
  );
}));

export default MessageList;

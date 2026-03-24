import React, { useState, useEffect, useRef, useCallback, memo, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { CircleDot, Lock } from 'lucide-react';
import { direct as directApi, reactions as reactionsApi, pinned as pinnedApi, friends as friendsApi, invalidateCache } from '../api';
import { useSocket, useOnlineUsers } from '../context/SocketContext';
import { useOffline, OFFLINE_SENT_EVENT } from '../context/OfflineContext';
import { useAuth } from '../context/AuthContext';
import { useVoice } from '../context/VoiceContext';
import { useNotification } from '../context/NotificationContext';
import { useSettings } from '../context/SettingsContext';
import { useLanguage } from '../context/LanguageContext';
import { usePrefetchOnHover } from '../context/PrefetchContext';
import { useSwipeBack } from '../hooks/useSwipeBack';
import { prefetchProfile } from '../utils/profileCache';
import MessageList from './MessageList';
import MessageInput from './MessageInput';
import PinnedMessages from './PinnedMessages';
import Avatar from './Avatar';
import ClickableAvatar from './ClickableAvatar';
import ProfileCard from './ProfileCard';
import StickerPicker from './StickerPicker';
import FileDropOverlay from './FileDropOverlay';
import ConfirmModal from './ConfirmModal';
import DMCallView from './DMCallView';
import { undoToast } from './UndoToast';
import './Chat.css';



const DirectChat = memo(function DirectChat({ conversationId, onConversationsChange, conversations, isMobile }) {
  const DELETE_FUME_MS = 760;
  const { onMouseEnter, onMouseLeave } = usePrefetchOnHover();
  const [conversation, setConversation] = useState(null);
  const [messages, setMessages] = useState([]);
  const [loading, setLoading] = useState(true);
  const [typingUser, setTypingUser] = useState(null);
  const [readReceipts, setReadReceipts] = useState({});
  const [replyTo, setReplyTo] = useState(null);
  const [messageReactions, setMessageReactions] = useState({});
  const [pinnedMessageIds, setPinnedMessageIds] = useState([]);
  const [pinnedMessages, setPinnedMessages] = useState([]);
  const [showProfileCard, setShowProfileCard] = useState(false);
  const [profileClickPos, setProfileClickPos] = useState(null);
  const headerInfoRef = useRef(null);
  const [showPinnedPanel, setShowPinnedPanel] = useState(false);
  const [showStickerPanel, setShowStickerPanel] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState(null);
  const [deleteCaptionConfirm, setDeleteCaptionConfirm] = useState(null);
  const [showGroupMembers, setShowGroupMembers] = useState(false);
  const socket = useSocket();
  const { isUserOnline } = useOnlineUsers();
  const { isOnline, addToQueue: addToOfflineQueue } = useOffline();
  const { voiceConversationId, voiceUsers, joinVoiceDM, leaveVoiceDM } = useVoice();
  const { user } = useAuth();
  const { notify } = useNotification();
  const { sendNotification, shouldNotify } = useSettings();
  const { t } = useLanguage();
  const navigate = useNavigate();
  const typingTimeoutRef = useRef(null);
  const lastReadRef = useRef(null);
  const messageListRef = useRef(null);
  const messageInputRef = useRef(null);
  
  // Use a ref to access conversations without triggering re-renders
  const conversationsRef = useRef(conversations);
  useEffect(() => {
    conversationsRef.current = conversations;
  }, [conversations]);

  const extractReactions = useCallback((msgs) => {
    const rxMap = {};
    for (const m of msgs) {
      if (m.reactions && m.reactions.length > 0) {
        rxMap[m.id] = m.reactions;
      }
    }
    setMessageReactions(rxMap);
  }, []);

  useEffect(() => {
    if (!conversationId) return;
    let cancelled = false;
    setLoading(true);
    setMessages([]);
    setMessageReactions({});
    setReplyTo(null);
    setShowPinnedPanel(false);
    setShowStickerPanel(false);
    setShowGroupMembers(false);
    setTypingUser(null);
    setPinnedMessageIds([]);
    setPinnedMessages([]);
    setReadReceipts({});

    // Optimization: Try to find conversation from parent's state first (avoids extra API call)
    // Use ref to avoid re-running effect when conversations list updates
    const cachedConv = conversationsRef.current?.find((x) => String(x.conversation_id) === conversationId);

    if (cachedConv) {
      setConversation(cachedConv);
      const hasResolvedTitle = cachedConv?.is_group
        ? !!(cachedConv?.group_name || (cachedConv?.participants || []).length > 0)
        : !!cachedConv?.participants?.[0]?.display_name;
      if (!hasResolvedTitle) {
        directApi.getConversationInfo(conversationId)
          .then((info) => {
            if (cancelled || !info) return;
            setConversation((prev) => ({ ...(prev || {}), ...info }));
          })
          .catch(() => {});
      }
      // Only fetch messages
      directApi.messages(conversationId)
        .then((msgs) => {
          if (cancelled) return;
          const safeMsgs = Array.isArray(msgs) ? msgs : [];
          setMessages(safeMsgs);
          extractReactions(safeMsgs);
        })
        .catch((err) => {
          if (!cancelled) { console.error('Erreur DM messages:', err); setMessages([]); }
        })
        .finally(() => { if (!cancelled) setLoading(false); });
    } else {
      // Fallback: fetch both messages and conversation info.
      Promise.all([
        directApi.messages(conversationId),
        directApi.getConversationInfo(conversationId).catch(() => null),
      ])
        .then(([msgs, info]) => {
          if (cancelled) return;
          const safeMsgs = Array.isArray(msgs) ? msgs : [];
          setMessages(safeMsgs);
          extractReactions(safeMsgs);
          setConversation(info || { conversation_id: parseInt(conversationId, 10), participants: [] });
        })
        .catch((err) => {
          if (!cancelled) { console.error('Erreur DM:', err); setConversation(null); setMessages([]); }
        })
        .finally(() => { if (!cancelled) setLoading(false); });
    }
    return () => { cancelled = true; };
  }, [conversationId, extractReactions]); // Only reload when conversationId changes, not when conversations updates

  useEffect(() => {
    if (!conversationId) return;
    const latestConv = conversations?.find((x) => String(x.conversation_id) === String(conversationId));
    if (!latestConv) return;
    setConversation((prev) => ({ ...(prev || {}), ...latestConv }));
  }, [conversationId, conversations]);

  useEffect(() => {
    if (!socket || !conversationId) return;
    const convId = parseInt(conversationId, 10);
    const rejoin = () => socket.emit('join_conversation', convId);
    rejoin();
    socket.on('connect', rejoin);
    return () => {
      socket.off('connect', rejoin);
      socket.emit('leave_conversation', convId);
    };
  }, [socket, conversationId]);

  useEffect(() => {
    if (!socket) return;
    const onMessage = (payload) => {
      if (payload.conversationId === parseInt(conversationId, 10)) {
        const senderId = payload.message?.sender_id || payload.message?.sender?.id;
        if (senderId && senderId !== user?.id) {
          setTypingUser(prev => (prev && prev.userId === senderId) ? null : prev);
        }
        // Ignore only messages echoed back to the same socket (keeps multi-device sync for same account).
        const isOwnUser = payload.message?.sender_id === user?.id || payload.message?.sender?.id === user?.id;
        const sameSocket = payload.sourceSocketId && socket?.id && payload.sourceSocketId === socket.id;
        if (isOwnUser && sameSocket) {
          return;
        }
        setMessages((prev) => {
          if (prev.some((m) => m.id === payload.message?.id)) return prev;
          return [...prev, payload.message];
        });
        
        // Send desktop notification for new messages from others
        const msg = payload.message;
        if (msg && msg.sender_id !== user?.id && shouldNotify('dm')) {
          // Only notify if window is not focused
          if (!document.hasFocus()) {
            const senderName = msg.sender?.display_name || t('chat.someone');
            const messagePreview = msg.type === 'text' 
              ? msg.content?.substring(0, 100) 
              : (msg.type === 'image' ? t('chat.image') : t('chat.file'));
            
            sendNotification(senderName, {
              body: messagePreview,
              tag: `dm-${payload.conversationId}`,
              onClick: () => {
                window.focus();
              }
            });
          }
        }
      }
    };
    
    // Message edited
    const onMessageEdited = ({ conversationId: cId, message }) => {
      if (cId === parseInt(conversationId, 10)) {
        setMessages((prev) => prev.map((m) => (m.id === message.id ? { ...m, ...message } : m)));
      }
    };
    
    // Message deleted
    const onMessageDeleted = ({ conversationId: cId, messageId }) => {
      if (cId === parseInt(conversationId, 10)) {
        setMessages((prev) => prev.filter((m) => m.id !== messageId));
      }
    };
    
    const onCallTimeLimitSystemMessage = ({ conversationId: cId, content }) => {
      if (cId !== parseInt(conversationId, 10)) return;
      messageListRef.current?.preserveScroll?.();
      const systemMsg = {
        id: `system_call_ended_${Date.now()}`,
        conversation_id: parseInt(conversationId, 10),
        sender_id: null,
        content,
        type: 'system',
        created_at: new Date().toISOString(),
        sender: null,
      };
      setMessages((prev) => [...prev, systemMsg]);
    };

    const onCallStarted = ({ conversationId: cId, callerDisplayName }) => {
      if (cId !== parseInt(conversationId, 10)) return;
      messageListRef.current?.preserveScroll?.();
      const inProgressId = `call_in_progress_${conversationId}`;
      const systemMsg = {
        id: inProgressId,
        conversation_id: parseInt(conversationId, 10),
        sender_id: null,
        content: null,
        type: 'system',
        subtype: 'call_started',
        call_ended: {
          startedByName: callerDisplayName,
          durationSeconds: null,
          durationText: null,
        },
        created_at: new Date().toISOString(),
        sender: null,
      };
      setMessages((prev) => {
        if (prev.some((m) => m.id === inProgressId)) return prev;
        return [...prev, systemMsg];
      });
    };

    const onCallEnded = ({ conversationId: cId, callerDisplayName, durationSeconds, reason, disconnectedUserIds = [] }) => {
      if (cId !== parseInt(conversationId, 10)) return;
      messageListRef.current?.preserveScroll?.();
      const durationText = durationSeconds < 60
        ? 'less than a minute'
        : durationSeconds < 120
          ? 'a minute'
          : `${Math.floor(durationSeconds / 60)} minutes`;
      const inProgressId = `call_in_progress_${conversationId}`;
      setMessages((prev) => {
        const idx = prev.findIndex((m) => m.id === inProgressId);
        const callEndedData = { startedByName: callerDisplayName, durationSeconds, durationText, reason, disconnectedUserIds };
        if (idx >= 0) {
          return prev.map((m, i) =>
            i === idx
              ? { ...m, subtype: 'call_ended', call_ended: callEndedData }
              : m
          );
        }
        return [...prev, {
          id: `system_call_ended_${Date.now()}`,
          conversation_id: parseInt(conversationId, 10),
          sender_id: null,
          content: null,
          type: 'system',
          subtype: 'call_ended',
          call_ended: callEndedData,
          created_at: new Date().toISOString(),
          sender: null,
        }];
      });
    };

    socket.on('dm_message', onMessage);
    socket.on('dm_message_edited', onMessageEdited);
    socket.on('dm_message_deleted', onMessageDeleted);
    socket.on('dm_call_time_limit_system_message', onCallTimeLimitSystemMessage);
    socket.on('dm_call_started', onCallStarted);
    socket.on('dm_call_ended', onCallEnded);

    return () => {
      socket.off('dm_message', onMessage);
      socket.off('dm_message_edited', onMessageEdited);
      socket.off('dm_message_deleted', onMessageDeleted);
      socket.off('dm_call_time_limit_system_message', onCallTimeLimitSystemMessage);
      socket.off('dm_call_started', onCallStarted);
      socket.off('dm_call_ended', onCallEnded);
    };
  }, [socket, conversationId, user?.id]);

  useEffect(() => {
    if (!socket) return;
    const onTyping = ({ conversationId: cId, userId: uid, displayName }) => {
      if (cId !== parseInt(conversationId, 10) || uid === user?.id) return;
      setTypingUser({ userId: uid, displayName });
      if (typingTimeoutRef.current) clearTimeout(typingTimeoutRef.current);
      typingTimeoutRef.current = setTimeout(() => setTypingUser(null), 3000);
    };
    const onStopTyping = ({ conversationId: cId, userId: uid }) => {
      if (cId !== parseInt(conversationId, 10)) return;
      setTypingUser(prev => (prev && prev.userId === uid) ? null : prev);
    };
    socket.on('user_typing_dm', onTyping);
    socket.on('user_stop_typing_dm', onStopTyping);
    return () => {
      socket.off('user_typing_dm', onTyping);
      socket.off('user_stop_typing_dm', onStopTyping);
      if (typingTimeoutRef.current) clearTimeout(typingTimeoutRef.current);
    };
  }, [socket, conversationId, user?.id]);

  // Écouter quand un message en file d'attente est envoyé
  useEffect(() => {
    const handler = (e) => {
      const { tempId, message, context, targetId } = e.detail || {};
      if (context !== 'dm' || String(targetId) !== String(conversationId) || !message) return;
      setMessages((prev) => prev.map((m) => (
        m.id === tempId
          ? { ...message, _clientKey: m._clientKey || m.id }
          : m
      )));
    };
    window.addEventListener(OFFLINE_SENT_EVENT, handler);
    return () => window.removeEventListener(OFFLINE_SENT_EVENT, handler);
  }, [conversationId]);

  // Presence is now handled globally by SocketContext via useOnlineUsers hook
  // No need to track presence_status in local conversation state

  const sendMessage = useCallback(async (content, type, replyToId) => {
    if (socket) socket.emit('stop_typing_dm', { conversationId: parseInt(conversationId, 10) });
    const tempId = `temp_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
    const optimisticMsg = {
      id: tempId,
      _clientKey: tempId,
      conversation_id: parseInt(conversationId, 10),
      sender_id: user?.id,
      content,
      type: type || 'text',
      reply_to_id: replyToId,
      created_at: new Date().toISOString(),
      sender: { id: user?.id, display_name: user?.display_name, avatar_url: user?.avatar_url },
      _pending: true,
    };
    setMessages((prev) => [...prev, optimisticMsg]);

    // Mode hors ligne : mettre en file d'attente
    if (!isOnline) {
      try {
        await addToOfflineQueue({
          context: 'dm',
          targetId: conversationId,
          payload: { content, type, replyToId },
          tempId,
        });
        return optimisticMsg;
      } catch (e) {
        setMessages((prev) => prev.map((m) =>
          m.id === tempId ? { ...m, _pending: false, _failed: true, _retryPayload: { content, type, replyToId } } : m
        ));
        throw e;
      }
    }

    try {
      const msg = await directApi.sendMessage(conversationId, content, type, replyToId);
      if (msg?.isCommand) {
        const commandMsg = {
          id: tempId,
          conversation_id: parseInt(conversationId, 10),
          sender_id: user?.id,
          content: msg.message,
          type: 'system',
          subtype: 'command_result',
          created_at: new Date().toISOString(),
          sender: { id: user?.id, display_name: user?.display_name, avatar_url: user?.avatar_url },
          isCommand: true,
          commandSuccess: msg.success,
          commandType: msg.type,
          commandInput: content.trim(),
        };
        setMessages((prev) => prev.map((m) => (
          m.id === tempId
            ? { ...commandMsg, _clientKey: m._clientKey || m.id }
            : m
        )));
        return commandMsg;
      }
      setMessages((prev) => prev.map((m) => (
        m.id === tempId
          ? { ...msg, _clientKey: m._clientKey || m.id }
          : m
      )));
      return msg;
    } catch (err) {
      const { isNetworkError } = await import('../utils/offlineMessageQueue');
      if (isNetworkError(err)) {
        try {
          await addToOfflineQueue({
            context: 'dm',
            targetId: conversationId,
            payload: { content, type, replyToId },
            tempId,
          });
          return optimisticMsg;
        } catch (e) {
          setMessages((prev) => prev.map((m) =>
            m.id === tempId ? { ...m, _pending: false, _failed: true, _retryPayload: { content, type, replyToId } } : m
          ));
          throw err;
        }
      }
      setMessages((prev) => prev.map((m) =>
        m.id === tempId ? { ...m, _pending: false, _failed: true, _retryPayload: { content, type, replyToId } } : m
      ));
      throw err;
    }
  }, [conversationId, socket, user, isOnline, addToOfflineQueue]);

  const retryFailedMessage = useCallback((msg) => {
    const payload = msg._retryPayload;
    if (!payload) return;
    setMessages((prev) => prev.filter((m) => m.id !== msg.id));
    sendMessage(payload.content, payload.type, payload.replyToId);
  }, [sendMessage]);
  
  // Send sticker/gif/emoji as a message
  const sendMedia = useCallback((item, type = 'sticker') => {
    const messageType = type === 'gif' ? 'gif' : type === 'emoji' ? 'emoji' : 'sticker';
    const content = item.image_url || item.url;
    
    return directApi.sendMessage(conversationId, content, messageType, null).then((msg) => {
      // Message is broadcast by backend via Socket.io
      setMessages((prev) => [...prev, msg]);
      return msg;
    }).catch((err) => {
      console.error(`Erreur envoi ${messageType}:`, err);
      throw err;
    });
  }, [conversationId]);
  
  // Toggle sticker panel
  const handleToggleStickerPanel = useCallback(() => {
    setShowStickerPanel(prev => !prev);
  }, []);
  
  // Handle sticker/gif/emoji selection from panel
  const handleStickerSelect = useCallback((item) => {
    sendMedia(item, item.type || 'sticker');
    // Don't close panel - let user send multiple items like Telegram
  }, [sendMedia]);

  // Handle emoji selection from panel
  const handleEmojiSelect = useCallback((emoji) => {
    messageInputRef.current?.insertText(emoji);
  }, []);

  // Optimistic file upload with loading state
  const uploadFile = useCallback((file, voiceDuration = null, caption = null) => {
    const isVoice = file.type.startsWith('audio/');
    const isImage = file.type.startsWith('image/');
    
    const tempId = `temp_${Date.now()}`;
    const optimisticMessage = {
      id: tempId,
      _clientKey: tempId,
      conversation_id: parseInt(conversationId, 10),
      sender_id: user?.id,
      content: URL.createObjectURL(file),
      type: isImage ? 'image' : 'file',
      created_at: new Date().toISOString(),
      sender: {
        id: user?.id,
        display_name: user?.display_name,
        avatar_url: user?.avatar_url,
      },
      attachment: {
        file_name: file.name,
        file_url: URL.createObjectURL(file),
        file_size: file.size,
        mime_type: file.type,
      },
      caption: caption || null,
      _pending: true,
      _voiceDuration: voiceDuration,
    };
    
    setMessages((prev) => [...prev, optimisticMessage]);
    
    return directApi.uploadFile(conversationId, file, caption).then((msg) => {
      // Replace optimistic message with real one
      // Backend broadcasts via Socket.io, so other users will receive the message
      setMessages((prev) => prev.map((m) => 
        m.id === tempId
          ? { ...msg, _pending: false, _clientKey: m._clientKey || m.id }
          : m
      ));
      return msg;
    }).catch((err) => {
      console.error('Erreur upload:', err);
      // Mark as failed
      setMessages((prev) => prev.map((m) => 
        m.id === tempId ? { ...m, _pending: false, _failed: true } : m
      ));
      throw err;
    });
  }, [conversationId, user]);

  const onTyping = useCallback(() => {
    if (socket && conversationId)
      socket.emit('typing_dm', { conversationId: parseInt(conversationId, 10) });
  }, [socket, conversationId]);

  // Edit message handler
  const handleEdit = useCallback((messageId, newContent) => {
    directApi.editMessage(conversationId, messageId, newContent)
      .then((updatedMsg) => {
        setMessages((prev) => prev.map((m) => (m.id === messageId ? { ...m, ...updatedMsg } : m)));
      })
      .catch((err) => {
        notify.error(err.message || t('errors.edit'));
      });
  }, [conversationId, notify]);

  // Dismiss system message (e.g. call-ended bandwidth notice) - remove from local view only
  const handleDismissSystemMessage = useCallback((messageId) => {
    setMessages((prev) => prev.filter((m) => m.id !== messageId));
  }, []);

  // Delete for me (hide) - with undo
  const handleDeleteForMe = useCallback((msg) => {
    // Show dissolve state first, then remove to keep the "melt into air" effect visible.
    setMessages((prev) => prev.map((m) => (m.id === msg.id ? { ...m, _deleting: true } : m)));
    window.setTimeout(() => {
      setMessages((prev) => prev.filter((m) => m.id !== msg.id));
      undoToast.show(
        t('chat.messageHidden'),
        () => {
          directApi.hideMessage(conversationId, msg.id).catch((err) => {
            notify.error(err.message || t('errors.delete'));
            setMessages((prev) => [...prev, msg].sort((a, b) => a.id - b.id));
          });
        },
        () => {
          setMessages((prev) => [...prev, msg].sort((a, b) => a.id - b.id));
        }
      );
    }, DELETE_FUME_MS);
  }, [conversationId, notify, t, DELETE_FUME_MS]);

  const doDeleteForAll = useCallback((msg) => {
    setMessages((prev) => prev.map((m) => (m.id === msg.id ? { ...m, _deleting: true } : m)));
    window.setTimeout(() => {
      setMessages((prev) => prev.filter((m) => m.id !== msg.id));
      directApi.deleteMessage(conversationId, msg.id).catch((err) => {
        notify.error(err.message || t('errors.delete'));
        setMessages((prev) => [...prev, msg].sort((a, b) => a.id - b.id));
      });
    }, DELETE_FUME_MS);
  }, [conversationId, notify, t, DELETE_FUME_MS]);

  const handleDeleteForAll = useCallback((msg, instant) => {
    if (instant) {
      doDeleteForAll(msg);
      setDeleteCaptionConfirm(null);
    } else {
      setDeleteConfirm(msg);
    }
  }, [doDeleteForAll]);

  const handleRequestDeleteCaption = useCallback((msg) => {
    setDeleteCaptionConfirm(msg);
  }, []);

  const handleConfirmDeleteCaption = useCallback(() => {
    if (deleteCaptionConfirm) {
      doDeleteForAll(deleteCaptionConfirm);
    }
    setDeleteCaptionConfirm(null);
  }, [deleteCaptionConfirm, doDeleteForAll]);

  const handleConfirmDelete = useCallback(() => {
    if (deleteConfirm) doDeleteForAll(deleteConfirm);
    setDeleteConfirm(null);
  }, [deleteConfirm, doDeleteForAll]);

  // Fetch read receipts on load
  useEffect(() => {
    if (!conversationId) return;
    directApi.getReads(conversationId)
      .then((reads) => {
        const receipts = {};
        reads.forEach((r) => { receipts[r.user_id] = r.last_read_message_id; });
        setReadReceipts(receipts);
      })
      .catch(() => {});
  }, [conversationId]);

  const lastMessageId = messages.length ? messages[messages.length - 1]?.id : null;
  const lastMessageSenderId = messages.length ? messages[messages.length - 1]?.sender_id : null;
  const numericLastMessageId = typeof lastMessageId === 'number'
    ? lastMessageId
    : (typeof lastMessageId === 'string' && /^\d+$/.test(lastMessageId)
      ? Number.parseInt(lastMessageId, 10)
      : null);

  useEffect(() => {
    if (!numericLastMessageId || !conversationId) return;
    
    const markAsRead = () => {
      if (document.hidden || !document.hasFocus()) return;
      if (numericLastMessageId !== lastReadRef.current && lastMessageSenderId !== user?.id) {
        lastReadRef.current = numericLastMessageId;
        directApi.markRead(conversationId, numericLastMessageId).catch(() => {});
      }
    };
    
    markAsRead();
    
    const handleVisibilityChange = () => { if (!document.hidden) markAsRead(); };
    const handleFocus = () => markAsRead();
    
    document.addEventListener('visibilitychange', handleVisibilityChange);
    window.addEventListener('focus', handleFocus);
    
    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      window.removeEventListener('focus', handleFocus);
    };
  }, [numericLastMessageId, lastMessageSenderId, conversationId, user?.id]);

  // Listen for read receipts from socket
  useEffect(() => {
    if (!socket) return;
    const onMessageRead = ({ conversationId: cId, userId, lastReadMessageId }) => {
      if (cId === parseInt(conversationId, 10)) {
        setReadReceipts((prev) => ({ ...prev, [userId]: lastReadMessageId }));
      }
    };
    socket.on('message_read', onMessageRead);
    return () => socket.off('message_read', onMessageRead);
  }, [socket, conversationId]);

  const isGroup = conversation?.is_group;
  const other = isGroup ? null : conversation?.participants?.[0];
  const otherUsers = useMemo(() => conversation?.participants || [], [conversation?.participants]);

  // Prefetch DM partner profile on load so profile card opens instantly
  useEffect(() => {
    if (other?.id && !isGroup) prefetchProfile(other.id, other);
  }, [other?.id, isGroup]);
  const title = isGroup 
    ? (conversation?.group_name || otherUsers.map(u => u.display_name).join(', ') || 'Group')
    : (other?.display_name || 'Conversation');
  
  // Get last own message if it's the last message in the conversation (for arrow up edit)
  const lastOwnMessage = useMemo(() => {
    if (messages.length === 0) return null;
    const lastMsg = messages[messages.length - 1];
    if (lastMsg.sender_id === user?.id && lastMsg.type === 'text') {
      return lastMsg;
    }
    return null;
  }, [messages, user?.id]);
  
  // Handler for arrow up to edit last message
  const handleEditLastMessage = useCallback((msg) => {
    messageListRef.current?.startEdit(msg);
  }, []);

  // Reply handlers
  const handleReply = useCallback((msg) => {
    setReplyTo(msg);
  }, []);

  const handleCancelReply = useCallback(() => {
    setReplyTo(null);
  }, []);

  // Reaction handlers
  const handleAddReaction = useCallback(async (messageId, emoji) => {
    try {
      await reactionsApi.addDirect(conversationId, messageId, emoji);
      // Optimistic update
      setMessageReactions(prev => {
        const msgReactions = prev[messageId] || [];
        const existing = msgReactions.find(r => r.emoji === emoji);
        if (existing) {
          if (!existing.userIds.some(id => String(id) === String(user?.id))) {
            return {
              ...prev,
              [messageId]: msgReactions.map(r => 
                r.emoji === emoji 
                  ? { ...r, count: r.count + 1, userIds: [...r.userIds, user?.id], users: [...r.users, user?.display_name] }
                  : r
              )
            };
          }
          return prev;
        }
        return {
          ...prev,
          [messageId]: [...msgReactions, { emoji, count: 1, userIds: [user?.id], users: [user?.display_name] }]
        };
      });
    } catch (err) {
      notify.error(err.message || t('errors.addReaction'));
    }
  }, [conversationId, user, notify, t]);

  const handleRemoveReaction = useCallback(async (messageId, emoji) => {
    try {
      await reactionsApi.removeDirect(conversationId, messageId, emoji);
      // Optimistic update
      setMessageReactions(prev => {
        const msgReactions = prev[messageId] || [];
        return {
          ...prev,
          [messageId]: msgReactions
            .map(r => {
              if (r.emoji !== emoji) return r;
              const removeIdx = r.userIds.findIndex(id => String(id) === String(user?.id));
              if (removeIdx === -1) return r; // already removed locally; avoid double decrement
              const nextUserIds = r.userIds.filter((_, i) => i !== removeIdx);
              const nextUsers = r.users.filter((_, i) => i !== removeIdx);
              return { ...r, count: Math.max(0, r.count - 1), userIds: nextUserIds, users: nextUsers };
            })
            .filter(r => r.count > 0)
        };
      });
    } catch (err) {
      notify.error(err.message || t('errors.removeReaction'));
    }
  }, [conversationId, user, notify, t]);

  // Pin handlers
  const handlePin = useCallback(async (msg) => {
    try {
      await pinnedApi.pinDirect(conversationId, msg.id);
      setPinnedMessageIds(prev => [...prev, msg.id]);
      // Add to pinned messages list
      setPinnedMessages(prev => [...prev, {
        ...msg,
        pinned_by: user?.id,
        pinned_by_name: user?.display_name,
        pinned_at: new Date().toISOString()
      }]);
      notify.success(t('pinned.pinned'));
    } catch (err) {
      notify.error(err.message || t('pinned.pinError'));
    }
  }, [conversationId, notify, user, t]);

  const handleUnpin = useCallback(async (msg) => {
    try {
      await pinnedApi.unpinDirect(conversationId, msg.id);
      setPinnedMessageIds(prev => prev.filter(id => id !== msg.id));
      setPinnedMessages(prev => prev.filter(p => p.id !== msg.id));
      notify.success(t('pinned.unpinned'));
    } catch (err) {
      notify.error(err.message || t('pinned.unpinError'));
    }
  }, [conversationId, notify, t]);

  // Scroll to message handler for pinned panel
  const handleScrollToMessage = useCallback((messageId) => {
    const messageElement = document.querySelector(`[data-message-id="${messageId}"]`);
    if (messageElement) {
      messageElement.scrollIntoView({ behavior: 'smooth', block: 'center' });
      messageElement.classList.add('message-highlight');
      setTimeout(() => messageElement.classList.remove('message-highlight'), 2000);
    }
  }, []);

  // Load pinned messages on mount
  useEffect(() => {
    if (!conversationId) return;
    pinnedApi.getDirect(conversationId)
      .then(pinned => {
        setPinnedMessages(pinned);
        setPinnedMessageIds(pinned.map(p => p.id));
      })
      .catch(() => {});
  }, [conversationId]);

  // Listen to reaction socket events
  useEffect(() => {
    if (!socket) return;
    
    const onReactionAdded = ({ conversationId: cId, messageId, emoji, userId, displayName }) => {
      if (cId === parseInt(conversationId, 10)) {
        setMessageReactions(prev => {
          const msgReactions = prev[messageId] || [];
          const existing = msgReactions.find(r => r.emoji === emoji);
          if (existing) {
            if (!existing.userIds.some(id => String(id) === String(userId))) {
              return {
                ...prev,
                [messageId]: msgReactions.map(r => 
                  r.emoji === emoji 
                    ? { ...r, count: r.count + 1, userIds: [...r.userIds, userId], users: [...r.users, displayName] }
                    : r
                )
              };
            }
            return prev;
          }
          return {
            ...prev,
            [messageId]: [...msgReactions, { emoji, count: 1, userIds: [userId], users: [displayName] }]
          };
        });
      }
    };
    
    const onReactionRemoved = ({ conversationId: cId, messageId, emoji, userId }) => {
      if (cId === parseInt(conversationId, 10)) {
        setMessageReactions(prev => {
          const msgReactions = prev[messageId] || [];
          return {
            ...prev,
            [messageId]: msgReactions
              .map(r => {
                if (r.emoji !== emoji) return r;
                const removeIdx = r.userIds.findIndex(id => String(id) === String(userId));
                if (removeIdx === -1) return r; // already removed locally; avoid double decrement
                const nextUserIds = r.userIds.filter((_, i) => i !== removeIdx);
                const nextUsers = r.users.filter((_, i) => i !== removeIdx);
                return { ...r, count: Math.max(0, r.count - 1), userIds: nextUserIds, users: nextUsers };
              })
              .filter(r => r.count > 0)
          };
        });
      }
    };
    
    const onMessagePinned = ({ conversationId: cId, messageId }) => {
      if (cId === parseInt(conversationId, 10)) {
        setPinnedMessageIds(prev => prev.includes(messageId) ? prev : [...prev, messageId]);
      }
    };
    
    const onMessageUnpinned = ({ conversationId: cId, messageId }) => {
      if (cId === parseInt(conversationId, 10)) {
        setPinnedMessageIds(prev => prev.filter(id => id !== messageId));
      }
    };
    
    socket.on('dm_reaction_added', onReactionAdded);
    socket.on('dm_reaction_removed', onReactionRemoved);
    socket.on('dm_message_pinned', onMessagePinned);
    socket.on('dm_message_unpinned', onMessageUnpinned);
    
    return () => {
      socket.off('dm_reaction_added', onReactionAdded);
      socket.off('dm_reaction_removed', onReactionRemoved);
      socket.off('dm_message_pinned', onMessagePinned);
      socket.off('dm_message_unpinned', onMessageUnpinned);
    };
  }, [socket, conversationId]);

  const handleHeaderClick = useCallback((e) => {
    if (isGroup) {
      setShowGroupMembers(prev => !prev);
    } else if (other?.id) {
      setProfileClickPos({ x: e.clientX, y: e.clientY });
      setShowProfileCard(prev => !prev);
    }
  }, [isGroup, other?.id]);

  // Not found: API returned no conversation and we're done loading
  if (!conversation && !loading) {
    return (
      <div className="direct-chat chat-container dm-chat">
        <div className="chat-header-placeholder" />
        <div className="chat-loading">{t('errors.notFound')}</div>
      </div>
    );
  }

  const isOtherOnline = other?.id ? isUserOnline(other.id) : false;
  const onlineGroupCount = isGroup ? otherUsers.filter(u => isUserOnline(u.id)).length : 0;
  
  const hasMessages = messages.length > 0;

  const isInCall = voiceConversationId === parseInt(conversationId, 10);
  const dmCallKey = `dm_${conversationId}`;
  const dmCallUsers = voiceUsers[dmCallKey] || [];
  const othersInCall = dmCallUsers.filter(u => u.id !== user?.id);
  const hasActiveCall = dmCallUsers.length > 0;
  const canJoinCall = hasActiveCall && !isInCall;

  const showPlaceholderHeader = !conversation;

  const swipeBack = useSwipeBack(
    isMobile ? () => navigate('/channels/@me') : undefined
  );

  const swipeHandlers = isMobile
    ? {
        onTouchStart: swipeBack.onTouchStart,
        onTouchMove: swipeBack.onTouchMove,
        onTouchEnd: swipeBack.onTouchEnd,
        onTouchCancel: swipeBack.onTouchCancel,
      }
    : {};

  return (
    <div
      className={`direct-chat chat-container dm-chat ${showStickerPanel ? 'sticker-panel-open' : ''} ${isInCall ? 'in-call' : ''}`}
      style={{
        transform: isMobile ? `translateX(${swipeBack.dragOffsetX}px)` : undefined,
        transition: isMobile && !swipeBack.isDragging ? 'transform 260ms cubic-bezier(0.22, 1, 0.36, 1)' : 'none',
      }}
      {...swipeHandlers}
    >
      {swipeBack.swipeProgress > 0 && (
        <div
          className="swipe-back-indicator"
          style={{ opacity: Math.min(1, swipeBack.swipeProgress * 1.2), transform: `translateY(-50%) translateX(${swipeBack.swipeProgress * 12}px)` }}
          aria-hidden
        >
          <div className="swipe-back-chevron" />
        </div>
      )}
      <header className="chat-header chat-header-dm">
        {isMobile && (
          <button className="dc-mobile-back" onClick={() => navigate('/channels/@me')} aria-label="Retour">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
              <path d="M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2z" />
            </svg>
          </button>
        )}
        {showPlaceholderHeader ? (
          <>
            <div className="chat-header-skeleton-avatar" />
            <div className="chat-header-info">
              <div className="chat-header-skeleton-title" />
            </div>
          </>
        ) : isGroup ? (
          <div className="group-header-icon" onClick={handleHeaderClick}>
            <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
              <path d="M16 11c1.66 0 2.99-1.34 2.99-3S17.66 5 16 5c-1.66 0-3 1.34-3 3s1.34 3 3 3zm-8 0c1.66 0 2.99-1.34 2.99-3S9.66 5 8 5C6.34 5 5 6.34 5 8s1.34 3 3 3zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5c0-2.33-4.67-3.5-7-3.5zm8 0c-.29 0-.62.02-.97.05 1.16.84 1.97 1.97 1.97 3.45V19h6v-2.5c0-2.33-4.67-3.5-7-3.5z"/>
            </svg>
          </div>
        ) : (
          <ClickableAvatar
            user={other}
            size="medium"
            showPresence
            position="bottom"
            contextMenuContext={{
              conversationId,
              lastMessageId: messages.length ? messages[messages.length - 1]?.id : null,
              hasUnread: false,
              isInCallWaiting: isInCall && othersInCall.length === 0,
            }}
          />
        )}
        {!showPlaceholderHeader && (
          <>
            <div
              ref={headerInfoRef}
              className="chat-header-info chat-header-clickable"
              onClick={handleHeaderClick}
              onMouseEnter={!isGroup && other?.id ? () => onMouseEnter(other.id, other) : undefined}
              onMouseLeave={!isGroup ? onMouseLeave : undefined}
            >
              <h1 className="chat-header-title">{title}</h1>
              {isGroup ? (
                <p className={`dm-header-status ${canJoinCall ? 'in-call' : 'online'}`}>
                  {canJoinCall
                    ? `${dmCallUsers.length} in call · ${otherUsers.length} members`
                    : `${otherUsers.length} members · ${onlineGroupCount} online`}
                </p>
              ) : (
                <p className={`dm-header-status ${canJoinCall ? 'in-call' : isOtherOnline ? 'online' : 'offline'}`}>
                  {canJoinCall
                    ? (othersInCall.length > 0
                        ? `${othersInCall.map(u => u.display_name || 'Someone').join(', ')} ${othersInCall.length === 1 ? 'is' : 'are'} in a call`
                        : t('friends.inCall', 'In a call'))
                    : isOtherOnline
                      ? t('common.online')
                      : 'Offline'}
                </p>
              )}
            </div>
            <div className="dm-header-actions">
          <button
            className={`dm-action-btn ${isInCall ? 'active' : ''} ${canJoinCall ? 'join-call' : ''}`}
            onClick={() => {
              const convId = parseInt(conversationId, 10);
              if (voiceConversationId === convId) {
                leaveVoiceDM();
              } else {
                messageListRef.current?.preserveScroll?.();
                joinVoiceDM(convId, title);
              }
            }}
            title={isInCall ? t('call.endCall', 'End Call') : canJoinCall ? t('call.joinCall', 'Join Call') : t('call.startCall', 'Start Voice Call')}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
              <path d="M12 9c-1.6 0-3.15.25-4.6.72v3.1c0 .39-.23.74-.56.9-.98.49-1.87 1.12-2.66 1.85-.18.18-.43.28-.7.28-.28 0-.53-.11-.71-.29L.29 13.08c-.18-.17-.29-.42-.29-.7 0-.28.11-.53.29-.71C3.34 8.78 7.46 7 12 7s8.66 1.78 11.71 4.67c.18.18.29.43.29.71 0 .28-.11.53-.29.71l-2.48 2.48c-.18.18-.43.29-.71.29-.27 0-.52-.11-.7-.28-.79-.74-1.69-1.36-2.67-1.85-.33-.16-.56-.5-.56-.9v-3.1C15.15 9.25 13.6 9 12 9z"/>
            </svg>
          </button>
          <button 
            className={`dm-action-btn ${showPinnedPanel ? 'active' : ''}`}
            onClick={() => setShowPinnedPanel(!showPinnedPanel)}
            title={t('pinned.viewPinned')}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
              <path d="M16 12V4h1V2H7v2h1v8l-2 2v2h5.2v6h1.6v-6H18v-2l-2-2z"/>
            </svg>
            {pinnedMessageIds.length > 0 && (
              <span className="dm-action-badge">{pinnedMessageIds.length}</span>
            )}
          </button>
          {isGroup && (
            <button 
              className={`dm-action-btn ${showGroupMembers ? 'active' : ''}`}
              onClick={() => setShowGroupMembers(!showGroupMembers)}
              title="Members"
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
                <path d="M16 11c1.66 0 2.99-1.34 2.99-3S17.66 5 16 5c-1.66 0-3 1.34-3 3s1.34 3 3 3zm-8 0c1.66 0 2.99-1.34 2.99-3S9.66 5 8 5C6.34 5 5 6.34 5 8s1.34 3 3 3zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5c0-2.33-4.67-3.5-7-3.5zm8 0c-.29 0-.62.02-.97.05 1.16.84 1.97 1.97 1.97 3.45V19h6v-2.5c0-2.33-4.67-3.5-7-3.5z"/>
              </svg>
            </button>
          )}
          <button 
            className="dm-action-btn"
            onClick={handleHeaderClick}
            title={isGroup ? 'Group info' : t('friends.message')}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="10"/>
              <path d="M12 16v-4M12 8h.01"/>
            </svg>
          </button>
        </div>
          </>
        )}
      </header>

      {!showPlaceholderHeader && isInCall && !isMobile && (
        <DMCallView otherUserName={title} otherUser={other} isGroup={isGroup} />
      )}

      {!showPlaceholderHeader && showGroupMembers && isGroup && (
        <div className="group-members-panel">
          <div className="group-members-header">
            <h3>Members — {otherUsers.length}</h3>
            <button className="group-members-close" onClick={() => setShowGroupMembers(false)}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                <path d="M18.4 4L12 10.4L5.6 4L4 5.6L10.4 12L4 18.4L5.6 20L12 13.6L18.4 20L20 18.4L13.6 12L20 5.6L18.4 4Z"/>
              </svg>
            </button>
          </div>
          <div className="group-members-list">
            {otherUsers.map(u => (
              <div key={u.id} className="group-member-item">
                <Avatar user={u} size="small" showPresence />
                <div className="group-member-info">
                  <span className="group-member-name">
                    {u.display_name}
                    {u.id === conversation?.owner_id && <span className="group-owner-badge">Owner</span>}
                    {u.id === user?.id && <span className="group-you-badge">(you)</span>}
                  </span>
                </div>
                <span className={`group-member-status ${isUserOnline(u.id) ? 'online' : ''}`}>
                  {isUserOnline(u.id) ? 'Online' : 'Offline'}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {showPinnedPanel && (
        <PinnedMessages
          pinnedMessages={pinnedMessages}
          onClose={() => setShowPinnedPanel(false)}
          onScrollToMessage={handleScrollToMessage}
          onUnpin={handleUnpin}
        />
      )}
      
      <div className="chat-main">
        <FileDropOverlay
          uploadTarget={`@${title}`}
          canWrite={!!uploadFile}
          onDrop={(file) => messageInputRef.current?.attachFile?.(file)}
          onUploadDirect={(file) => uploadFile(file)}
        >
          <div className="chat-main-content">
            <MessageList
              ref={messageListRef}
              messages={messages}
              loading={loading}
              currentUserId={user?.id}
              currentUserName={user?.display_name}
              onEdit={handleEdit}
              onDeleteForMe={handleDeleteForMe}
              onDeleteForAll={handleDeleteForAll}
              onRequestDeleteCaption={handleRequestDeleteCaption}
              onDismissSystemMessage={handleDismissSystemMessage}
              readReceipts={readReceipts}
              otherUsers={otherUsers}
              onReply={handleReply}
              onAddReaction={handleAddReaction}
              onRemoveReaction={handleRemoveReaction}
              onPin={handlePin}
              onUnpin={handleUnpin}
              messageReactions={messageReactions}
              pinnedMessageIds={pinnedMessageIds}
              onRetryFailedMessage={retryFailedMessage}
              isDM={true}
              topBanner={!loading && (
                <div className="dm-empty-conversation">
                  <div className="dm-empty-avatar-section">
                    {isGroup ? (
                      <div className="group-empty-icon">
                        <svg width="48" height="48" viewBox="0 0 24 24" fill="currentColor" opacity="0.6">
                          <path d="M16 11c1.66 0 2.99-1.34 2.99-3S17.66 5 16 5c-1.66 0-3 1.34-3 3s1.34 3 3 3zm-8 0c1.66 0 2.99-1.34 2.99-3S9.66 5 8 5C6.34 5 5 6.34 5 8s1.34 3 3 3zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5c0-2.33-4.67-3.5-7-3.5zm8 0c-.29 0-.62.02-.97.05 1.16.84 1.97 1.97 1.97 3.45V19h6v-2.5c0-2.33-4.67-3.5-7-3.5z"/>
                        </svg>
                      </div>
                    ) : (
                      <Avatar user={other} size="xlarge" showPresence />
                    )}
                  </div>
                  <h1 className="dm-empty-name">{title}</h1>
                  {!isGroup && other?.username && (
                    <p className="dm-empty-username">{other.username}</p>
                  )}
                  <p className="dm-empty-hint">
                    {(() => {
                      if (isGroup) return `Start chatting with your group! ${otherUsers.length} members.`;
                      const name = other?.display_name || t('chat.someone');
                      const full = t('chat.beginningDm', { name });
                      const parts = full.split(name);
                      return <>{parts[0]}<strong>{name}</strong>{parts[1]}</>;
                    })()}
                  </p>
                  {!isGroup && (
                    <div className="dm-empty-action-row">
                      <button
                        className="dm-add-friend-btn"
                        onClick={async () => {
                          const username = other?.username || other?.display_name;
                          if (!username) return;
                          try {
                            await friendsApi.sendRequest(username);
                            invalidateCache('/friends');
                            window.dispatchEvent(new CustomEvent('slide:friends-changed'));
                            notify.success((t('friends.requestSent') || 'Friend request sent to {name}').replace('{name}', username));
                          } catch (err) {
                            notify.error(err.message);
                          }
                        }}
                      >
                        {t('friends.addFriend')}
                      </button>
                      <button
                        className="dm-block-btn"
                        onClick={async () => {
                          if (!other?.id) return;
                          try {
                            await friendsApi.block(other.id);
                            invalidateCache('/friends');
                            window.dispatchEvent(new CustomEvent('slide:friends-changed'));
                            notify.success(t('friends.userBlocked') || 'User blocked');
                          } catch (err) {
                            notify.error(err.message);
                          }
                        }}
                      >
                        {t('friends.block')}
                      </button>
                    </div>
                  )}
                </div>
              )}
            />
            {typingUser && (
              <div className="chat-typing">
                <div className="chat-typing-dots">
                  <span></span><span></span><span></span>
                </div>
                {typingUser.displayName} {t('chat.typing')}...
              </div>
            )}
            {!hasMessages && !loading && (
              <div className="dm-wave-prompt">
                <div className="dm-wave-prompt-emoji">👋</div>
                <button
                  className="dm-wave-btn"
                  onClick={() => sendMessage('👋', 'text')}
                >
                  {isGroup ? t('chat.sayHello') : t('chat.waveTo', { name: title })}
                </button>
              </div>
            )}
            <MessageInput
              ref={messageInputRef}
              onSend={sendMessage}
              onUpload={uploadFile}
              onTyping={onTyping}
              placeholder={`${t('chat.messageTo')} ${title}`}
              lastOwnMessage={lastOwnMessage}
              onEditLastMessage={handleEditLastMessage}
              draftKey={`dm_${conversationId}`}
              replyTo={replyTo}
              onCancelReply={handleCancelReply}
              mentionUsers={otherUsers}
              onToggleStickerPanel={handleToggleStickerPanel}
              stickerPanelOpen={showStickerPanel}
              isAdmin={user?.role === 'admin'}
              onInputFocus={isMobile ? () => messageListRef.current?.scrollToBottom?.() : undefined}
            />
          </div>
        </FileDropOverlay>
        <StickerPicker
          isOpen={showStickerPanel}
          onClose={() => setShowStickerPanel(false)}
          onSelect={handleStickerSelect}
          onEmojiSelect={handleEmojiSelect}
        />
      </div>
      <ProfileCard
        userId={other?.id}
        user={other}
        isOpen={showProfileCard}
        onClose={() => setShowProfileCard(false)}
        clickPos={profileClickPos}
        position="bottom"
      />
      <ConfirmModal
        isOpen={!!deleteConfirm}
        message={t('chat.deleteMessageConfirm')}
        confirmText={t('chat.delete')}
        cancelText={t('common.cancel')}
        type="danger"
        onConfirm={handleConfirmDelete}
        onCancel={() => setDeleteConfirm(null)}
      />
      <ConfirmModal
        isOpen={!!deleteCaptionConfirm}
        message={t('chat.deleteCaptionConfirm')}
        confirmText={t('chat.delete')}
        cancelText={t('common.cancel')}
        type="danger"
        onConfirm={handleConfirmDeleteCaption}
        onCancel={() => setDeleteCaptionConfirm(null)}
      />
    </div>
  );
});

export default DirectChat;

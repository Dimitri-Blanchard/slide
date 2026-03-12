import React, { useState, useEffect, useMemo, useCallback, useRef, lazy } from 'react';
import { Routes, Route, Navigate, useNavigate, useLocation } from 'react-router-dom';
import { teams as teamsApi, direct as directApi, invalidateCache } from '../api';
import { useAuth } from '../context/AuthContext';
import { useSocket } from '../context/SocketContext';
import { useSettings } from '../context/SettingsContext';
import ServerBar from '../components/ServerBar';
import Sidebar from '../components/Sidebar';
import TeamChat from '../components/TeamChat';
import DirectChat from '../components/DirectChat';
import FriendsPage from '../components/FriendsPage';
import ActiveNow from '../components/ActiveNow';
import MobileBottomNav from '../components/MobileBottomNav';
import MobileMessagesView from '../components/MobileMessagesView';
import MobileNotificationsView from '../components/MobileNotificationsView';
import MobileYouView from '../components/MobileYouView';
import CreateServerModal from '../components/CreateServerModal';
const NitroPage = lazy(() => import('../pages/NitroPage'));
const ShopPage = lazy(() => import('../pages/ShopPage'));
const QuestsPage = lazy(() => import('../pages/QuestsPage'));
const SecurityDashboard = lazy(() => import('../pages/SecurityDashboard'));
const CommunityServersPage = lazy(() => import('../pages/CommunityServersPage'));
import SearchModal from '../components/SearchModal';
import ActiveCallsPanel from '../components/ActiveCallsPanel';
import VoiceFullscreenOverlay from '../components/VoiceFullscreenOverlay';
import DMCallPiP from '../components/DMCallPiP';
import ServerErrorBoundary from '../components/ServerErrorBoundary';
import ErrorBoundary from '../components/ErrorBoundary';
import { useOnlineStatus } from '../hooks/useOnlineStatus';
import { useOffline } from '../context/OfflineContext';
import { useScene } from '../context/SceneContext';
import { useNotification } from '../context/NotificationContext';
import { useVoice } from '../context/VoiceContext';
import Settings from '../pages/Settings';
import './AppLayout.css';

function useIsMobile(breakpoint = 768) {
  const [isMobile, setIsMobile] = useState(() => window.innerWidth <= breakpoint);
  useEffect(() => {
    const mq = window.matchMedia(`(max-width: ${breakpoint}px)`);
    const onChange = (e) => setIsMobile(e.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [breakpoint]);
  return isMobile;
}

// ═══════════════════════════════════════════════════════════
// CACHE SYSTEM - Silent background sync
// ═══════════════════════════════════════════════════════════
const CACHE_KEY_CONVERSATIONS = 'slide_conversations_cache';
const CACHE_KEY_TEAMS = 'slide_teams_cache';
const SYNC_INTERVAL_MS = 10000; // 10s - cache + socket keep data fresh, no refresh needed

function getCachedConversations() {
  try {
    const cached = localStorage.getItem(CACHE_KEY_CONVERSATIONS);
    if (cached) {
      const { data, timestamp } = JSON.parse(cached);
      // Cache valid for 24 hours max
      if (Date.now() - timestamp < 24 * 60 * 60 * 1000) {
        return data;
      }
    }
  } catch (e) {
    console.warn('Cache read error:', e);
  }
  return null;
}

function setCachedConversations(conversations) {
  try {
    localStorage.setItem(CACHE_KEY_CONVERSATIONS, JSON.stringify({
      data: conversations,
      timestamp: Date.now()
    }));
  } catch (e) {
    console.warn('Cache write error:', e);
  }
}

function getCachedTeams() {
  try {
    const cached = localStorage.getItem(CACHE_KEY_TEAMS);
    if (cached) {
      const { data, timestamp } = JSON.parse(cached);
      if (Date.now() - timestamp < 24 * 60 * 60 * 1000) {
        return data;
      }
    }
  } catch (e) {
    console.warn('Cache read error:', e);
  }
  return null;
}

function setCachedTeams(teams) {
  try {
    localStorage.setItem(CACHE_KEY_TEAMS, JSON.stringify({
      data: teams,
      timestamp: Date.now()
    }));
  } catch (e) {
    console.warn('Cache write error:', e);
  }
}

function useAppParams() {
  const { pathname } = useLocation();
  return useMemo(() => {
    const teamMatch = pathname.match(/\/team\/(\d+)/);
    const channelMatch = pathname.match(/\/team\/\d+\/channel\/(\d+)/);
    const dmMatch = pathname.match(/\/channels\/@me\/(\d+)/);
    const isSettings = pathname === '/settings';
    return {
      teamId: teamMatch?.[1] || null,
      channelId: channelMatch?.[1] || null,
      conversationId: dmMatch?.[1] || null,
      isSettings,
    };
  }, [pathname]);
}

function AppLayout() {
  const initialTeamsCache = useMemo(() => getCachedTeams(), []);
  const initialConversationsCache = useMemo(() => getCachedConversations(), []);
  const hasInitialConversationsCache = initialConversationsCache != null;

  // Initialize from cache for instant display
  const [teams, setTeams] = useState(() => {
    return Array.isArray(initialTeamsCache) ? initialTeamsCache : [];
  });
  const [conversations, setConversations] = useState(() => (Array.isArray(initialConversationsCache) ? initialConversationsCache : []));
  const [conversationsLoaded, setConversationsLoaded] = useState(() => hasInitialConversationsCache);
  const [loading, setLoading] = useState(() => !hasInitialConversationsCache);
  const [showSearch, setShowSearch] = useState(false);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [showCreateServer, setShowCreateServer] = useState(false);
  // Mobile bottom nav tab: home (DMs + servers) | notifications | profile
  const [mobileTab, setMobileTab] = useState('home');
  const { user } = useAuth();
  const { voiceConversationId } = useVoice();
  const { inboxItems } = useNotification();
  const socket = useSocket();
  const { registerKeybindHandler } = useSettings();
  const navigate = useNavigate();
  const params = useAppParams();
  const isMobile = useIsMobile();
  const syncIntervalRef = useRef(null);
  const mutationSyncTimeoutRef = useRef(null);
  const swipeRef = useRef({ startX: 0, tracking: false });
  const isWindowFocusedRef = useRef(true);

  // Swipe from left edge to open server list (mobile) - low threshold for easy trigger
  const handleTouchStart = useCallback((e) => {
    if (!isMobile) return;
    const x = e.touches[0]?.clientX ?? 0;
    swipeRef.current = { startX: x, tracking: true };
  }, [isMobile]);

  const handleTouchMove = useCallback((e) => {
    if (!isMobile || !swipeRef.current.tracking) return;
    const x = e.touches[0]?.clientX ?? 0;
    const delta = x - swipeRef.current.startX;
    if (delta > 25) {
      setMobileNavOpen(true);
      swipeRef.current.tracking = false;
    } else if (delta < -15) {
      swipeRef.current.tracking = false;
    }
  }, [isMobile]);

  const handleTouchEnd = useCallback((e) => {
    if (!isMobile || !swipeRef.current.tracking) return;
    const touch = e.changedTouches?.[0];
    if (touch) {
      const delta = touch.clientX - swipeRef.current.startX;
      if (delta > 20) setMobileNavOpen(true);
    }
    swipeRef.current.tracking = false;
  }, [isMobile]);

  // Swipe left on overlay to close (mobile)
  const overlaySwipeRef = useRef({ startX: 0 });
  const handleOverlayTouchStart = useCallback((e) => {
    if (!isMobile || !mobileNavOpen) return;
    overlaySwipeRef.current.startX = e.touches[0]?.clientX ?? 0;
  }, [isMobile, mobileNavOpen]);
  const handleOverlayTouchMove = useCallback((e) => {
    if (!isMobile || !mobileNavOpen) return;
    const x = e.touches[0]?.clientX ?? 0;
    if (overlaySwipeRef.current.startX - x > 50) {
      setMobileNavOpen(false);
    }
  }, [isMobile, mobileNavOpen]);
  
  // ═══════════════════════════════════════════════════════════
  // REGISTER KEYBOARD SHORTCUTS
  // ═══════════════════════════════════════════════════════════
  useEffect(() => {
    // Register search shortcut
    const unregisterSearch = registerKeybindHandler('search', () => {
      setShowSearch(prev => !prev);
    });

    // Register mark as read shortcut (close modals/menus with Escape)
    const unregisterMarkAsRead = registerKeybindHandler('markAsRead', () => {
      setShowSearch(false);
    });

    // Extra shortcuts not in settings keybinds
    const handleExtraKeys = (e) => {
      // Escape → close search (handle first so it never triggers settings)
      if (e.key === 'Escape') {
        setShowSearch(false);
        return;
      }

      const ctrlOrMeta = e.ctrlKey || e.metaKey;

      // Ctrl+, → Settings (only on explicit comma key, never on Escape)
      if (ctrlOrMeta && e.key === ',') {
        e.preventDefault();
        navigate('/settings');
        return;
      }

      // Alt+ArrowUp / Alt+ArrowDown → cycle servers
      if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
        e.preventDefault();
        window.dispatchEvent(new CustomEvent('slide:cycle-server', { detail: { direction: e.key === 'ArrowUp' ? -1 : 1 } }));
      }
    };

    window.addEventListener('keydown', handleExtraKeys);

    return () => {
      unregisterSearch();
      unregisterMarkAsRead();
      window.removeEventListener('keydown', handleExtraKeys);
    };
  }, [registerKeybindHandler, navigate]);

  // Silent background sync — fetch teams and conversations in parallel.
  // Set loading false as soon as conversations arrive so sidebar appears progressively.
  const silentSync = useCallback((onConversationsReady) => {
    const teamsPromise = teamsApi.list()
      .then((teamsList) => {
        if (Array.isArray(teamsList)) setTeams(teamsList);
      })
      .catch((err) => { console.warn('Teams sync failed:', err); });

    const convosPromise = directApi.conversations()
      .then((convos) => {
        if (Array.isArray(convos)) {
          setConversations(convos);
          setConversationsLoaded(true);
        }
        setLoading(false);
        onConversationsReady?.();
      })
      .catch((err) => {
        console.warn('Conversations sync failed:', err);
        setLoading(false);
        onConversationsReady?.();
      });

    return Promise.allSettled([teamsPromise, convosPromise]);
  }, []);

  // Initial load + start background sync
  useEffect(() => {
    const safetyTimeout = setTimeout(() => setLoading(false), 20000);

    silentSync(() => clearTimeout(safetyTimeout));

    const intervalId = setInterval(() => silentSync(), SYNC_INTERVAL_MS);

    return () => {
      clearTimeout(safetyTimeout);
      clearInterval(intervalId);
    };
  }, [silentSync]);

  // Save to cache whenever conversations change
  useEffect(() => {
    if (conversations.length > 0) {
      setCachedConversations(conversations);
    }
  }, [conversations]);

  // Save to cache whenever teams change
  useEffect(() => {
    if (teams.length > 0) {
      setCachedTeams(teams);
    }
  }, [teams]);

  // Electron: sync OS taskbar badge + dock badge with total unread count
  useEffect(() => {
    if (!window.electron?.setBadgeCount) return;
    const dmTotal = (Array.isArray(conversations) ? conversations : [])
      .reduce((n, c) => n + (c.unread_count || 0), 0);
    const serverTotal = (Array.isArray(teams) ? teams : [])
      .reduce((n, t) => n + (t.unread_count || 0), 0);
    window.electron.setBadgeCount(dmTotal + serverTotal);
  }, [conversations, teams]);

  // Electron: track window focus so we know when to fire native notifications
  useEffect(() => {
    if (!window.electron?.onFocusChange) return;
    return window.electron.onFocusChange((focused) => {
      isWindowFocusedRef.current = focused;
    });
  }, []);

  // Join all team rooms to receive server_updated (icon, name, etc.) for sidebar
  useEffect(() => {
    if (!socket || teams.length === 0) return;
    teams.forEach((t) => socket.emit('join_team', t.id));
    return () => teams.forEach((t) => socket.emit('leave_team', t.id));
  }, [socket, teams]);

  // Listen to real-time team events
  useEffect(() => {
    if (!socket) return;

    // Team created (when current user creates a team)
    const onTeamCreated = ({ team }) => {
      setTeams((prev) => {
        if (prev.some((t) => t.id === team.id)) return prev;
        return [...prev, { ...team, unread_count: 0, mention_count: 0, has_unread: false }];
      });
    };

    // Team updated (name/description changed) or server_updated (icon, settings)
    const onTeamUpdated = ({ team }) => {
      setTeams((prev) => prev.map((t) => (t.id === team.id ? { ...t, ...team } : t)));
    };
    const onServerUpdated = ({ team }) => {
      setTeams((prev) => prev.map((t) => (t.id === team.id ? { ...t, ...team } : t)));
    };

    // Added to a team by someone else
    const onAddedToTeam = ({ team }) => {
      setTeams((prev) => {
        if (prev.some((t) => t.id === team.id)) return prev;
        return [...prev, { ...team, unread_count: 0, mention_count: 0, has_unread: false }];
      });
    };

    // Joined a team via invite link (we initiated the join)
    const onJoinedTeam = ({ team }) => {
      setTeams((prev) => {
        if (prev.some((t) => t.id === team.id)) return prev;
        return [...prev, { ...team, unread_count: 0, mention_count: 0, has_unread: false }];
      });
    };

    // Removed from a team
    const onRemovedFromTeam = ({ teamId }) => {
      setTeams((prev) => prev.filter((t) => t.id !== teamId));
      // If we were viewing this team, navigate away
      if (params.teamId === String(teamId)) {
        navigate('/channels/@me');
      }
    };

    // Team unread update (new message in a team channel)
    const onTeamUnreadUpdate = ({ teamId, hasUnread }) => {
      // Don't increment if we're currently viewing this team
      if (params.teamId === String(teamId)) return;

      setTeams((prev) => prev.map((t) => {
        if (t.id === teamId) {
          return {
            ...t,
            has_unread: hasUnread,
            unread_count: (t.unread_count || 0) + 1
          };
        }
        return t;
      }));

      // Native notification when window is not focused
      if (!isWindowFocusedRef.current) {
        window.electron?.showNotification?.({ title: 'Slide', body: 'Nouveau message dans un serveur' });
        window.electron?.flashFrame?.();
      }
    };

    // Team mention update (user was mentioned in a team channel)
    const onTeamMentionUpdate = ({ teamId, hasMention }) => {
      // Don't increment if we're currently viewing this team
      if (params.teamId === String(teamId)) return;
      
      setTeams((prev) => prev.map((t) => {
        if (t.id === teamId) {
          return {
            ...t,
            has_unread: true,
            mention_count: (t.mention_count || 0) + 1
          };
        }
        return t;
      }));
    };

    socket.on('team_created', onTeamCreated);
    socket.on('team_updated', onTeamUpdated);
    socket.on('server_updated', onServerUpdated);
    socket.on('added_to_team', onAddedToTeam);
    socket.on('joined_team', onJoinedTeam);
    socket.on('removed_from_team', onRemovedFromTeam);
    socket.on('team_unread_update', onTeamUnreadUpdate);
    socket.on('team_mention_update', onTeamMentionUpdate);

    return () => {
      socket.off('team_created', onTeamCreated);
      socket.off('team_updated', onTeamUpdated);
      socket.off('server_updated', onServerUpdated);
      socket.off('added_to_team', onAddedToTeam);
      socket.off('joined_team', onJoinedTeam);
      socket.off('removed_from_team', onRemovedFromTeam);
      socket.off('team_unread_update', onTeamUnreadUpdate);
      socket.off('team_mention_update', onTeamMentionUpdate);
    };
  }, [socket, params.teamId, navigate]);

  // Listen to real-time conversation events
  useEffect(() => {
    if (!socket) return;

    // New conversation created (someone started a DM with us)
    const onConversationCreated = ({ conversation }) => {
      setConversations((prev) => {
        if (prev.some((c) => c.conversation_id === conversation.conversation_id)) return prev;
        return [conversation, ...prev];
      });
    };

    const onConversationUpdated = ({ conversationId, lastMessagePreview, lastMessageAt, updatedAt, senderId }) => {
      const isCurrentlyViewing = params.conversationId === String(conversationId);
      const isOwnMessage = senderId != null && user?.id != null && Number(senderId) === Number(user.id);
      const shouldIncrementUnread = !isCurrentlyViewing && !isOwnMessage;

      setConversations((prev) => {
        const idx = prev.findIndex((c) => c.conversation_id === conversationId);
        if (idx === -1) return prev;
        const conv = prev[idx];
        const updated = {
          ...conv,
          last_message_preview: lastMessagePreview,
          last_message_at: lastMessageAt,
          updated_at: updatedAt,
          unread_count: shouldIncrementUnread ? (conv.unread_count || 0) + 1 : (conv.unread_count || 0)
        };
        const rest = prev.filter((_, i) => i !== idx);
        return [updated, ...rest];
      });

      // Native notification when window is not focused
      if (shouldIncrementUnread && !isWindowFocusedRef.current) {
        window.electron?.showNotification?.({
          title: 'Slide',
          body: lastMessagePreview || 'Nouveau message',
        });
        window.electron?.flashFrame?.();
      }
    };

    const onGroupMemberAdded = ({ conversationId, participants }) => {
      setConversations((prev) =>
        prev.map((c) =>
          c.conversation_id === conversationId ? { ...c, participants } : c
        )
      );
    };

    const onGroupMemberRemoved = ({ conversationId, userId, participants }) => {
      setConversations((prev) =>
        prev.map((c) =>
          c.conversation_id === conversationId ? { ...c, participants } : c
        )
      );
    };

    const onGroupRemoved = ({ conversationId }) => {
      setConversations((prev) => prev.filter((c) => c.conversation_id !== conversationId));
      if (params.conversationId === String(conversationId)) {
        navigate('/channels/@me');
      }
    };

    socket.on('conversation_created', onConversationCreated);
    socket.on('conversation_updated', onConversationUpdated);
    socket.on('group_member_added', onGroupMemberAdded);
    socket.on('group_member_removed', onGroupMemberRemoved);
    socket.on('group_removed', onGroupRemoved);

    return () => {
      socket.off('conversation_created', onConversationCreated);
      socket.off('conversation_updated', onConversationUpdated);
      socket.off('group_member_added', onGroupMemberAdded);
      socket.off('group_member_removed', onGroupMemberRemoved);
      socket.off('group_removed', onGroupRemoved);
    };
  }, [socket, params.conversationId, user?.id]);

  // Close mobile nav when route changes
  const { pathname, state: locationState } = useLocation();
  useEffect(() => {
    setMobileNavOpen(false);
  }, [pathname]);

  // Sync mobileTab: from navigation state, or when returning from chat
  const prevParamsRef = useRef(params);
  useEffect(() => {
    const targetTab = locationState?.mobileTab;
    if (targetTab && ['home', 'notifications', 'profile'].includes(targetTab)) {
      setMobileTab(targetTab);
      return;
    }
    const wasInConv = !!prevParamsRef.current.conversationId;
    const wasInTeam = !!prevParamsRef.current.teamId;
    const nowHome = !params.conversationId && !params.teamId && pathname !== '/community';
    if (nowHome && (wasInConv || wasInTeam)) {
      setMobileTab('home');
    }
    prevParamsRef.current = params;
  }, [pathname, params.conversationId, params.teamId, locationState?.mobileTab]);

  useEffect(() => {
    if (params.conversationId) {
      const cid = parseInt(params.conversationId, 10);
      setConversations((prev) => {
        const target = prev.find((c) => c.conversation_id === cid);
        if (!target || !target.unread_count) return prev;
        return prev.map((c) => c.conversation_id === cid ? { ...c, unread_count: 0 } : c);
      });
    }
  }, [params.conversationId]);

  useEffect(() => {
    if (params.teamId) {
      const tid = parseInt(params.teamId, 10);
      setTeams((prev) => {
        const target = prev.find((t) => t.id === tid);
        if (!target || (!target.unread_count && !target.mention_count && !target.has_unread)) return prev;
        return prev.map((t) => t.id === tid ? { ...t, unread_count: 0, mention_count: 0, has_unread: false } : t);
      });
    }
  }, [params.teamId]);

  const refreshConversations = useCallback(() => {
    directApi.conversations()
      .then((convos) => {
        if (Array.isArray(convos)) {
          setConversations(convos);
          setCachedConversations(convos);
          setConversationsLoaded(true);
        }
      })
      .catch((err) => {
        console.error('Erreur refresh conversations:', err);
      });
  }, []);

  const refreshTeams = useCallback(() => {
    teamsApi.list()
      .then((teamsList) => {
        if (Array.isArray(teamsList)) {
          setTeams(teamsList);
          setCachedTeams(teamsList);
        }
      })
      .catch((err) => {
        console.error('Erreur refresh teams:', err);
      });
  }, []);

  // Keep DM participant names synced when friend relations change.
  useEffect(() => {
    const handleFriendsChanged = () => {
      refreshConversations();
    };
    window.addEventListener('slide:friends-changed', handleFriendsChanged);
    return () => window.removeEventListener('slide:friends-changed', handleFriendsChanged);
  }, [refreshConversations]);

  // Always-on friend cache invalidation — runs even when FriendsPage is unmounted.
  // This ensures navigating to /channels/@me always shows fresh data.
  useEffect(() => {
    if (!socket) return;
    const invalidateFriends = () => {
      invalidateCache('/friends');
    };
    socket.on('friend_request', invalidateFriends);
    socket.on('friend_request_sent', invalidateFriends);
    socket.on('friend_accepted', invalidateFriends);
    socket.on('friend_removed', invalidateFriends);
    socket.on('friend_request_cancelled', invalidateFriends);
    return () => {
      socket.off('friend_request', invalidateFriends);
      socket.off('friend_request_sent', invalidateFriends);
      socket.off('friend_accepted', invalidateFriends);
      socket.off('friend_removed', invalidateFriends);
      socket.off('friend_request_cancelled', invalidateFriends);
    };
  }, [socket]);

  // Global revalidation after any mutation API call.
  useEffect(() => {
    const handleDataMutated = (event) => {
      const endpoint = String(event?.detail?.endpoint || '');
      if (mutationSyncTimeoutRef.current) {
        clearTimeout(mutationSyncTimeoutRef.current);
      }
      mutationSyncTimeoutRef.current = setTimeout(() => {
        if (endpoint.includes('/direct') || endpoint.includes('/friends')) {
          refreshConversations();
        }
        if (endpoint.includes('/teams') || endpoint.includes('/servers') || endpoint.includes('/channels')) {
          refreshTeams();
        }
      }, 120);
    };
    window.addEventListener('slide:data-mutated', handleDataMutated);
    return () => {
      window.removeEventListener('slide:data-mutated', handleDataMutated);
      if (mutationSyncTimeoutRef.current) {
        clearTimeout(mutationSyncTimeoutRef.current);
      }
    };
  }, [refreshConversations, refreshTeams]);

  // Stale-while-revalidate: when background fetch completes, sync state (no refresh needed)
  useEffect(() => {
    const handleCacheUpdated = () => {
      silentSync();
    };
    window.addEventListener('slide:cache-updated', handleCacheUpdated);
    return () => window.removeEventListener('slide:cache-updated', handleCacheUpdated);
  }, [silentSync]);

  // Re-sync when app becomes active again.
  useEffect(() => {
    const handleVisibility = () => {
      if (document.visibilityState === 'visible') {
        silentSync();
      }
    };
    const handleFocus = () => {
      silentSync();
    };
    const handleOnline = () => {
      silentSync();
    };
    document.addEventListener('visibilitychange', handleVisibility);
    window.addEventListener('focus', handleFocus);
    window.addEventListener('online', handleOnline);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibility);
      window.removeEventListener('focus', handleFocus);
      window.removeEventListener('online', handleOnline);
    };
  }, [silentSync]);

  const addConversation = useCallback((newConv) => {
    setConversations((prev) => {
      if (prev.some((c) => c.conversation_id === newConv.conversation_id)) {
        return prev;
      }
      return [newConv, ...prev];
    });
  }, []);

  const removeConversationLocal = useCallback((conversationId) => {
    if (!conversationId) return;
    setConversations((prev) => prev.filter((c) => c.conversation_id !== conversationId));
  }, []);

  const restoreConversationLocal = useCallback((conversation) => {
    if (!conversation?.conversation_id) return;
    setConversations((prev) => {
      if (prev.some((c) => c.conversation_id === conversation.conversation_id)) {
        return prev;
      }
      const next = [conversation, ...prev];
      return next.sort((a, b) => new Date(b.last_message_at || b.created_at) - new Date(a.last_message_at || a.created_at));
    });
  }, []);

  // Remove team from list when user leaves (and update cache) - avoids stale server in bar
  const onLeaveServer = useCallback((teamId) => {
    setTeams((prev) => {
      const next = prev.filter((t) => t.id !== parseInt(teamId, 10));
      setCachedTeams(next);
      return next;
    });
    navigate('/channels/@me');
  }, [navigate]);

  // Hooks must run on every render - never after a conditional return
  const isOnline = useOnlineStatus();
  const { queuedCount, processing } = useOffline();
  const scene = useScene();


  // ── Mobile layout (Discord-style 4-tab bottom nav) ─────────────────────────
  if (isMobile) {
    const isCommunityPage = pathname === '/community';
    const inSpecificRoute = !!(params.teamId || params.conversationId || isCommunityPage);

    // Content to show when no chat open: home (DMs) | notifications | profile
    const contentTab = params.isSettings ? 'profile' : mobileTab;

    // activeTab: home when in DMs/servers, notifications, or profile
    const activeTab = params.conversationId || params.teamId ? 'home'
      : params.isSettings ? 'profile'
      : mobileTab;

    // Unread badge counts for the bottom nav
    const dmUnreadTotal = (Array.isArray(conversations) ? conversations : []).reduce((n, c) => n + (c.unread_count || 0), 0);
    const serverUnreadTotal = (Array.isArray(teams) ? teams : []).reduce((n, t) => n + (t.unread_count || 0), 0);

    const handleMobileTabChange = (tab) => {
      setMobileTab(tab);
      if (inSpecificRoute) {
        navigate('/channels/@me');
      }
    };

    return (
      <div className={`mobile-app-layout scene-${scene}`}>
        {!isOnline && (
          <div className="offline-banner" role="alert">
            <span className="offline-banner-icon">⚠</span>
            <span>
              Pas de connexion.
              {queuedCount > 0
                ? ` ${queuedCount} message${queuedCount > 1 ? 's' : ''} en attente.`
                : ''}
              {processing && ' Envoi en cours…'}
            </span>
          </div>
        )}

        <div className={`mobile-content ${!isCommunityPage ? 'mobile-split-layout' : ''}`}>
          {!isCommunityPage && !(params.conversationId || (params.teamId && params.channelId)) && (
            <aside className="mobile-server-bar">
              <ServerBar
                teams={teams}
                currentTeamId={params.teamId}
                currentConversationId={params.conversationId}
                onTeamsChange={setTeams}
                onLeaveServer={onLeaveServer}
                isMobile={true}
              />
            </aside>
          )}
          <div className="mobile-content-main">
          {!inSpecificRoute ? (
            // ── Tab content: Home = DMs (Slide icon in bar), Notifications, You ──
            contentTab === 'home' ? (
              <ErrorBoundary fallback={<div className="mobile-messages-view" style={{ padding: '1rem', color: 'var(--text-muted)' }}>Messages unavailable</div>}>
                <MobileMessagesView
                  conversations={conversations}
                  currentConversationId={params.conversationId}
                  loading={loading}
                  onOpenSearch={() => setShowSearch(true)}
                />
              </ErrorBoundary>
            ) : contentTab === 'notifications' ? (
              <MobileNotificationsView />
            ) : contentTab === 'profile' ? (
              <MobileYouView onOpenSettings={() => navigate('/settings')} />
            ) : null
          ) : (
            // ── Specific route: show TeamChat, DirectChat, or Community full-screen ──
            <main className="app-main">
              <div className="content-phase-in">
              <Routes>
                <Route path="/community" element={<CommunityServersPage />} />
                <Route
                  path="/team/:teamId/*"
                  element={
                    <ServerErrorBoundary>
                      <TeamChat
                        teamId={params.teamId}
                        initialChannelId={params.channelId}
                        isMobile={true}
                        onLeaveServer={onLeaveServer}
                        onOpenSearch={() => setShowSearch(true)}
                      />
                    </ServerErrorBoundary>
                  }
                />
                <Route
                  path="/channels/@me/:conversationId"
                  element={
                    <DirectChat
                      conversationId={params.conversationId}
                      onConversationsChange={setConversations}
                      conversations={conversations}
                      isMobile={true}
                    />
                  }
                />
                <Route path="/*" element={null} />
              </Routes>
              </div>
            </main>
          )}
          </div>
        </div>

        <ActiveCallsPanel />

        <VoiceFullscreenOverlay isMobile={true} conversations={conversations} />

        {!(params.channelId || params.conversationId) && (
          <MobileBottomNav
            activeTab={activeTab}
            onTabChange={handleMobileTabChange}
            unreadCounts={{
              home: dmUnreadTotal + serverUnreadTotal,
              notifications: (inboxItems || []).length,
            }}
            userAvatar={user?.avatar_url}
          />
        )}

        <SearchModal
          isOpen={showSearch}
          onClose={() => setShowSearch(false)}
          conversations={conversations}
          teams={teams}
        />

        {params.isSettings && <Settings />}

        <CreateServerModal
          isOpen={showCreateServer}
          onClose={() => setShowCreateServer(false)}
          onServerCreated={(newTeam) => {
            setTeams(prev => [...prev, { ...newTeam, unread_count: 0, mention_count: 0, has_unread: false }]);
            setShowCreateServer(false);
            navigate(`/team/${newTeam.id}`);
          }}
        />

      </div>
    );
  }
  // ── End mobile layout ────────────────────────────────────────────────────────

  // Hide sidebar when viewing a team (server) or community page (full-screen)
  const showSidebar = !params.teamId && pathname !== '/community';
  const shouldShowDmPiP = !!voiceConversationId && String(voiceConversationId) !== String(params.conversationId);
  const pipConversation = shouldShowDmPiP
    ? conversations.find((c) => Number(c.conversation_id) === Number(voiceConversationId))
    : null;
  const pipName = pipConversation?.is_group
    ? (pipConversation?.group_name || 'Group call')
    : pipConversation?.participants?.find((p) => p.id !== user?.id)?.display_name || 'Call';
  const pipAvatar = pipConversation?.is_group
    ? null
    : pipConversation?.participants?.find((p) => p.id !== user?.id)?.avatar_url || null;

  return (
    <div className={`app-layout scene-${scene} ${mobileNavOpen ? 'mobile-nav-open' : ''}`}>
      {!isOnline && (
        <div className="offline-banner" role="alert">
          <span className="offline-banner-icon">⚠</span>
          <span>
            Pas de connexion.
            {queuedCount > 0
              ? ` ${queuedCount} message${queuedCount > 1 ? 's' : ''} en attente — envoi dès la reconnexion.`
              : ' Les messages seront mis en file et envoyés à la reconnexion.'}
            {processing && ' Envoi en cours…'}
          </span>
        </div>
      )}
      {isMobile && mobileNavOpen && (
        <div
          className="mobile-nav-overlay"
          onClick={() => setMobileNavOpen(false)}
          onTouchStart={handleOverlayTouchStart}
          onTouchMove={handleOverlayTouchMove}
        />
      )}
      <ServerBar
        teams={teams}
        currentTeamId={params.teamId}
        currentConversationId={params.conversationId}
        onTeamsChange={setTeams}
        onLeaveServer={onLeaveServer}
      />
      {showSidebar && (
        <ErrorBoundary fallback={<aside className="sidebar" style={{ padding: '1rem', color: 'var(--text-muted)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>DMs unavailable</aside>}>
        <Sidebar
          user={user}
          conversations={conversations}
          currentConversationId={params.conversationId}
          onRefreshConversations={refreshConversations}
          onAddConversation={addConversation}
          onRemoveConversation={removeConversationLocal}
          onRestoreConversation={restoreConversationLocal}
          loading={loading}
          conversationsLoaded={conversationsLoaded}
          onOpenSearch={() => setShowSearch(true)}
        />
        </ErrorBoundary>
      )}
      <main className="app-main">
        {/* Edge swipe zone - captures touch from left edge on mobile, above scrollable content */}
        {isMobile && (
          <div
            className="mobile-edge-swipe-zone"
            onTouchStart={handleTouchStart}
            onTouchMove={handleTouchMove}
            onTouchEnd={handleTouchEnd}
          />
        )}
        <div className="content-phase-in">
        <Routes>
          <Route
            path="/team/:teamId/*"
            element={
              <ServerErrorBoundary>
                <TeamChat teamId={params.teamId} initialChannelId={params.channelId} isMobile={isMobile} onLeaveServer={onLeaveServer} onOpenSearch={() => setShowSearch(true)} />
              </ServerErrorBoundary>
            }
          />
          <Route
            path="/channels/@me/:conversationId"
            element={
              <DirectChat
                conversationId={params.conversationId}
                onConversationsChange={setConversations}
                conversations={conversations}
              />
            }
          />
          <Route path="/community" element={<CommunityServersPage />} />
          <Route path="/nitro" element={<NitroPage />} />
          <Route path="/security" element={<SecurityDashboard />} />
          <Route path="/shop" element={<ShopPage />} />
          <Route path="/quests" element={<QuestsPage />} />
          <Route path="/channels/@me" element={<FriendsPage />} />
          <Route path="/settings" element={<FriendsPage />} />
          <Route path="/" element={<Navigate to="/channels/@me" replace />} />
          <Route path="/home" element={<Navigate to="/channels/@me" replace />} />
          <Route path="/profile/*" element={<Navigate to="/channels/@me" replace />} />
        </Routes>
        </div>
      </main>
      {!params.teamId && !params.conversationId && <ActiveNow />}

      <ActiveCallsPanel />
      
      {params.isSettings && <Settings />}
      
      <SearchModal
        isOpen={showSearch}
        onClose={() => setShowSearch(false)}
        conversations={conversations}
        teams={teams}
      />

      {shouldShowDmPiP && (
        <DMCallPiP
          conversationId={voiceConversationId}
          conversationName={pipName}
          avatarUrl={pipAvatar}
        />
      )}

    </div>
  );
}

export default AppLayout;

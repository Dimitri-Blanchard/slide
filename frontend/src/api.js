const FIXED_BACKEND_ORIGIN = 'http://192.168.1.176:3000';
const SL1DE_WEB_BACKEND_ORIGIN = 'https://api.sl1de.xyz';
const IS_WEB_ON_SL1DE_DOMAIN = typeof window !== 'undefined'
  && /(^|\.)sl1de\.xyz$/i.test(window.location.hostname);
const IS_NATIVE_RUNTIME = typeof window !== 'undefined'
  && (!!window.electron?.isElectron || !!window.Capacitor?.isNativePlatform?.());
const WEB_BACKEND_ORIGIN = import.meta.env.VITE_BACKEND_ORIGIN
  || (IS_WEB_ON_SL1DE_DOMAIN
    ? SL1DE_WEB_BACKEND_ORIGIN
    : (typeof window !== 'undefined' ? window.location.origin : FIXED_BACKEND_ORIGIN));
const WEB_API_BASE = import.meta.env.VITE_API_BASE_URL
  || (IS_WEB_ON_SL1DE_DOMAIN ? `${SL1DE_WEB_BACKEND_ORIGIN}/api` : '/api');
const BACKEND_ORIGIN = IS_NATIVE_RUNTIME
  ? FIXED_BACKEND_ORIGIN
  : WEB_BACKEND_ORIGIN;
const API_BASE = IS_NATIVE_RUNTIME ? `${FIXED_BACKEND_ORIGIN}/api` : WEB_API_BASE;

export { API_BASE, BACKEND_ORIGIN };

// ═══════════════════════════════════════════════════════════
// CONSOLE LOGGING FOR USER SYSTEM (developer debugging - no sensitive data)
// ═══════════════════════════════════════════════════════════
const API_LOG_PREFIX = '[Auth:API]';
function apiAuthLog(level, action, details = {}) {
  const msg = `${API_LOG_PREFIX} ${action}`;
  if (level === 'info') console.info(msg, details);
  else if (level === 'warn') console.warn(msg, details);
  else console.error(msg, details);
}

// ═══════════════════════════════════════════════════════════
// SECURITY: Token management with validation (persistent storage)
// ═══════════════════════════════════════════════════════════
import { getToken, clearToken as clearTokenFromStorage, clearDeviceId } from './utils/tokenStorage';

function clearToken() {
  clearTokenFromStorage();
}

// Callback pour gérer la déconnexion automatique
let onAuthError = null;

/**
 * Configure le callback appelé lors d'une erreur d'authentification
 * @param {Function} callback - Fonction appelée lors d'une erreur 401/403
 */
export function setAuthErrorHandler(callback) {
  onAuthError = callback;
}

// ═══════════════════════════════════════════════════════════
// PERFORMANCE: Request cache, stale-while-revalidate, deduplication
// ═══════════════════════════════════════════════════════════
const requestCache = new Map();
const pendingRequests = new Map();
const STALE_MAX_AGE_MS = 120000; // 2 min max - serve stale up to this age

function getCacheKey(endpoint, options) {
  return `${options.method || 'GET'}:${endpoint}`;
}

function getCacheTtl(endpoint) {
  if (endpoint.includes('/messages/channel') || (endpoint.includes('/direct/conversations/') && endpoint.includes('/messages'))) return 5000;
  if (endpoint === '/teams' || endpoint === '/direct/conversations' || endpoint.startsWith('/friends') || endpoint.includes('/channels/team/')) return 30000;
  return 10000;
}

function clearCache(pattern) {
  for (const key of requestCache.keys()) {
    if (key.includes(pattern)) {
      requestCache.delete(key);
    }
  }
}

function dispatchCacheUpdated(endpoint, data) {
  try {
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('slide:cache-updated', { detail: { endpoint, data } }));
    }
  } catch (_) {}
}

// UX: Messages d'erreur explicites pour guider l'utilisateur
function getUserFriendlyError(status, serverMsg, code) {
  if (serverMsg && !serverMsg.startsWith('Erreur ') && serverMsg.length < 100) return serverMsg;
  const map = {
    400: 'Requête invalide. Vérifiez les données envoyées.',
    401: 'Session expirée. Veuillez vous reconnecter.',
    403: 'Accès refusé. Vous n\'avez pas les droits nécessaires.',
    404: 'Élément introuvable. Il a peut-être été supprimé.',
    409: 'Conflit : cette action entre en conflit avec l\'état actuel.',
    413: 'Fichier trop volumineux. Limite : 25 Mo.',
    422: 'Données invalides. Vérifiez le format.',
    429: 'Trop de requêtes. Patientez quelques instants avant de réessayer.',
    500: 'Erreur serveur. Notre équipe a été notifiée. Réessayez dans un instant.',
    502: 'Serveur indisponible. Vérifiez votre connexion et réessayez.',
    503: 'Service temporairement indisponible. Réessayez dans quelques minutes.',
  };
  return map[status] || (serverMsg || `Erreur ${status}`);
}

function sanitizeLegacyNickname(value) {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (!trimmed) return trimmed;

  // Legacy format occasionally returns names like "User#0000".
  let next = trimmed.replace(/\s*#\s*0+\s*$/i, '').trim();

  // Another legacy bug appends a single trailing "0" to nick/display names.
  // Remove only when it looks like a text suffix, not a numeric identifier.
  if (/[^\d]0$/.test(next)) {
    next = next.slice(0, -1).trimEnd();
  }

  return next || trimmed;
}

function shouldSanitizeNameKey(key) {
  if (!key) return false;
  const k = String(key);
  if (k === 'display_name' || k === 'displayName' || k === 'nickname') return true;
  if (k.endsWith('_display_name') || k.endsWith('_nickname')) return true;
  if (k.toLowerCase().includes('displayname')) return true;
  return false;
}

function sanitizeLegacyDisplayName(value, maybeUsername) {
  const cleaned = sanitizeLegacyNickname(value);
  if (typeof cleaned !== 'string') return cleaned;
  const displayName = cleaned.trim();
  const username = sanitizeLegacyNickname(maybeUsername);
  if (typeof username === 'string' && username) {
    if (displayName.toLowerCase() === `${username}0`.toLowerCase()) {
      return displayName.slice(0, -1).trimEnd();
    }
    if (displayName.toLowerCase() === `${username}#0000`.toLowerCase()) {
      return displayName.slice(0, -5).trimEnd();
    }
  }
  return displayName;
}

function shouldSanitizeResponsePayload(endpoint, payload) {
  if (!payload || typeof payload !== 'object') return false;
  // Restrict expensive traversal to endpoints that frequently embed user identity fields.
  return (
    endpoint.includes('/auth') ||
    endpoint.includes('/users') ||
    endpoint.includes('/friends') ||
    endpoint.includes('/teams') ||
    endpoint.includes('/servers') ||
    endpoint.includes('/direct') ||
    endpoint.includes('/messages')
  );
}

function sanitizeLegacyNicknamePayloadInPlace(payload) {
  if (!payload || typeof payload !== 'object') {
    return payload;
  }

  const stack = [payload];
  while (stack.length > 0) {
    const node = stack.pop();
    if (!node || typeof node !== 'object') continue;

    if (Array.isArray(node)) {
      for (const item of node) {
        if (item && typeof item === 'object') {
          stack.push(item);
        }
      }
      continue;
    }

    const siblingUsername = node.username ?? node.user_name ?? node.handle;
    for (const [key, value] of Object.entries(node)) {
      if (shouldSanitizeNameKey(key)) {
        node[key] = key.toLowerCase().includes('display')
          ? sanitizeLegacyDisplayName(value, siblingUsername)
          : sanitizeLegacyNickname(value);
        continue;
      }

      if (value && typeof value === 'object') {
        stack.push(value);
      }
    }
  }

  return payload;
}

export async function api(endpoint, options = {}) {
  const token = getToken();
  const socketId = typeof window !== 'undefined' ? window.__SLIDE_SOCKET_ID : null;
  const headers = {
    'Content-Type': 'application/json',
    ...(token && { Authorization: `Bearer ${token}` }),
    ...(socketId && { 'X-Socket-ID': socketId }),
    ...options.headers,
  };
  
  const method = options.method || 'GET';
  const cacheKey = getCacheKey(endpoint, options);
  
  // Only cache GET requests
  if (method === 'GET' && !options._background) {
    const cached = requestCache.get(cacheKey);
    const ttl = getCacheTtl(endpoint);
    const age = cached ? Date.now() - cached.timestamp : Infinity;
    const isFresh = age < ttl;
    const isStale = age >= ttl && age < STALE_MAX_AGE_MS;

    if (isFresh) return cached.data;

    if (isStale) {
      api(endpoint, { ...options, _background: true }).then((data) => {
        if (data != null) dispatchCacheUpdated(endpoint, data);
      }).catch(() => {});
      return cached.data;
    }

    if (pendingRequests.has(cacheKey)) return pendingRequests.get(cacheKey);
  }
  
  const requestPromise = (async () => {
    const maxRetries = 2;
    let lastErr = null;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 12000); // 12s timeout
        let res;
        try {
          res = await fetch(`${API_BASE}${endpoint}`, { ...options, headers, signal: controller.signal });
        } catch (fetchErr) {
          if (fetchErr.name === 'AbortError') {
            apiAuthLog('warn', `request timeout/aborted: ${endpoint}`, {
              endpoint,
              attempt: attempt + 1,
              fixHint: 'Server not reachable or slow. Check API_BASE, CORS, network, backend health.',
            });
            const err = new Error('Impossible de joindre le serveur. Vérifiez votre connexion.');
            err.isNetworkError = true;
            throw err;
          }
          apiAuthLog('warn', `fetch error: ${endpoint}`, {
            endpoint,
            error: fetchErr?.message || String(fetchErr),
            fixHint: 'Network error, CORS, or server down. Check browser console Network tab.',
          });
          throw fetchErr;
        } finally {
          clearTimeout(timeoutId);
        }
        const rawData = await res.json().catch(() => ({}));
        const data = shouldSanitizeResponsePayload(endpoint, rawData)
          ? sanitizeLegacyNicknamePayloadInPlace(rawData)
          : rawData;
    
    // ═══════════════════════════════════════════════════════════
    // SECURITY: Handle authentication errors
    // ═══════════════════════════════════════════════════════════
    if (res.status === 401 || res.status === 403) {
      // Token expired or invalid - clear and notify
      const errorCode = data.code || 'AUTH_ERROR';
      apiAuthLog('warn', `${res.status} on ${endpoint}`, {
        status: res.status,
        endpoint,
        code: errorCode,
        message: data.error || 'Session expirée',
        fixHint: 'Check backend auth middleware, JWT validity. For DEVICE_REVOKED: device was revoked. For USER_NOT_FOUND: user deleted. For ACCOUNT_BANNED: user banned.',
      });

      // Skip auth error handling for login/register/2fa-verify endpoints
      if (!endpoint.includes('/auth/login') && !endpoint.includes('/auth/register') && !endpoint.includes('/auth/2fa/verify') && !endpoint.includes('/auth/forgot-password') && !endpoint.includes('/auth/reset-password') && !endpoint.includes('/auth/forgot-password/verify-2fa')) {
        clearToken();
        if (errorCode === 'DEVICE_REVOKED') {
          clearDeviceId();  // So next 2FA login gets a fresh device
        }
        if (onAuthError) {
          onAuthError(errorCode, data.error || 'Session expirée');
        }
      }

      const err = new Error(data.error || 'Session expirée');
      err.status = res.status;
      throw err;
    }

    // Handle rate limiting (include retryAfter for cooldown display)
    if (res.status === 429) {
      apiAuthLog('warn', `429 rate limit on ${endpoint}`, {
        endpoint,
        retryAfter: typeof data.retryAfter === 'number' ? data.retryAfter : null,
        fixHint: 'Too many requests. Check backend rate limits. User should wait retryAfter seconds.',
      });
      const err = new Error(data.error || 'Trop de requêtes, veuillez patienter');
      err.retryAfter = typeof data.retryAfter === 'number' ? data.retryAfter : null;
      err.status = res.status;
      throw err;
    }

    if (!res.ok) {
      const isAuthEndpoint = endpoint.includes('/auth/');
      if (isAuthEndpoint) {
        apiAuthLog('warn', `${res.status} on auth endpoint ${endpoint}`, {
          status: res.status,
          endpoint,
          code: data?.code,
          message: data?.error,
          fixHint: 'Check backend auth route. Common: 400=validation, 401=bad credentials, 409=duplicate email/username, 500=server error.',
        });
      }
      // UX: Messages d'erreur explicites selon le code et le contenu
      const userMsg = getUserFriendlyError(res.status, data?.error, data?.code);
      const err = new Error(userMsg);
      err.status = res.status;
      err.code = data?.code;
      err.retryAfter = data?.retryAfter;
      throw err;
    }
    
    // Cache successful GET responses
    if (method === 'GET') {
      requestCache.set(cacheKey, { data, timestamp: Date.now() });
    }
    
    // Invalidate related caches on mutations
    if (method === 'POST' || method === 'PATCH' || method === 'DELETE') {
      if (endpoint.includes('/messages')) clearCache('/messages');
      if (endpoint.includes('/conversations')) clearCache('/conversations');
      if (endpoint.includes('/teams')) clearCache('/teams');
      if (endpoint.includes('/channels')) clearCache('/channels');
      if (endpoint.includes('/friends') || endpoint.includes('/servers')) {
        clearCache('/friends');
        clearCache('/teams');
      }
      if (endpoint.includes('/quests') || endpoint.includes('/shop')) {
        clearCache('/quests');
        clearCache('/shop');
      }
      try {
        if (typeof window !== 'undefined') {
          window.dispatchEvent(new CustomEvent('slide:data-mutated', {
            detail: {
              endpoint,
              method,
              at: Date.now(),
            },
          }));
        }
      } catch (_) {}
    }
    
    return data;
      } catch (err) {
        lastErr = err;
        const isRetryable = !err.isNetworkError && err.name === 'TypeError' && (
          err.message?.includes('fetch') ||
          err.message?.includes('Failed to fetch') ||
          err.message?.includes('NetworkError')
        );
        if (isRetryable && attempt < maxRetries) {
          await new Promise(r => setTimeout(r, 800 * (attempt + 1)));
          continue;
        }
        throw lastErr;
      }
    }
    throw lastErr;
  })();
  
  if (method === 'GET') {
    pendingRequests.set(cacheKey, requestPromise);
    try {
      return await requestPromise;
    } finally {
      pendingRequests.delete(cacheKey);
    }
  }
  
  return requestPromise;
}

// Export cache control for manual invalidation
export function invalidateCache(pattern = '') {
  if (pattern) {
    clearCache(pattern);
  } else {
    requestCache.clear();
  }
}

export const nitro = {
  getWaitlistStatus: () => api('/nitro/waitlist-status'),
  joinWaitlist: (email) =>
    api('/auth/nitro-waitlist', { method: 'POST', body: JSON.stringify({ email }) }),
};

export const auth = {
  register: (email, password, displayName, username) =>
    api('/auth/register', { method: 'POST', body: JSON.stringify({ email, password, displayName, username }) }),
  login: (email, password, deviceId, deviceName) =>
    api('/auth/login', { method: 'POST', body: JSON.stringify({ email, password, deviceId, deviceName }) }),
  verify2FA: (tempToken, code, deviceId, deviceName) =>
    api('/auth/2fa/verify', { method: 'POST', body: JSON.stringify({ tempToken, code, deviceId, deviceName }) }),
  forgotPassword: (email) =>
    api('/auth/forgot-password', { method: 'POST', body: JSON.stringify({ email }) }),
  forgotPasswordVerify2FA: (tempToken, code) =>
    api('/auth/forgot-password/verify-2fa', { method: 'POST', body: JSON.stringify({ tempToken, code }) }),
  resetPassword: (token, newPassword) =>
    api('/auth/reset-password', { method: 'POST', body: JSON.stringify({ token, newPassword }) }),
  devices: {
    list: () => api('/auth/devices'),
    revoke: (deviceId) => api(`/auth/devices/${deviceId}`, { method: 'DELETE' }),
  },
  me: () => api('/auth/me'),
  updateMe: (data) => api('/auth/me', { method: 'PATCH', body: JSON.stringify(data) }),
  refresh: (refreshToken) => api('/auth/refresh', { method: 'POST', body: JSON.stringify({ refreshToken }) }),
  setFlags: (flags) => api('/auth/me/flags', { method: 'POST', body: JSON.stringify(flags) }),
  deleteAccount: (password) => api('/gdpr/account', {
    method: 'DELETE',
    body: JSON.stringify({ password, confirmation: 'DELETE MY ACCOUNT' }),
  }),
  exportData: () => api('/gdpr/export', { method: 'POST' }),
  verifyEmail: (token) => api('/auth/verify-email', { method: 'POST', body: JSON.stringify({ token }) }),
  resendVerification: () => api('/auth/resend-verification', { method: 'POST' }),
  twoFactor: {
    setup: () => api('/auth/2fa/setup', { method: 'POST' }),
    enable: (code) => api('/auth/2fa/enable', { method: 'POST', body: JSON.stringify({ code }) }),
    disable: (code) =>
      api('/auth/2fa/disable', { method: 'POST', body: JSON.stringify({ code }) }),
    backupCodesInfo: () => api('/auth/2fa/backup-codes'),
    regenerateBackupCodes: (code) =>
      api('/auth/2fa/backup-codes/regenerate', { method: 'POST', body: JSON.stringify({ code }) }),
  },
  qrLogin: {
    start: () => api('/auth/qr-login/start', { method: 'POST' }),
    check: (token) => api(`/auth/qr-login/check/${token}`),
    approve: (token, deviceId, deviceName) =>
      api('/auth/qr-login/approve', {
        method: 'POST',
        body: JSON.stringify({ token, deviceId, deviceName }),
      }),
  },
};

export const teams = {
  list: () => api('/teams'),
  create: (name, description) =>
    api('/teams', { method: 'POST', body: JSON.stringify({ name, description }) }),
  get: (id) => api(`/teams/${id}`),
  update: (id, data) => api(`/teams/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  members: (id) => api(`/teams/${id}/members`),
  addMember: (teamId, userId) =>
    api(`/teams/${teamId}/members`, { method: 'POST', body: JSON.stringify({ userId }) }),
  removeMember: (teamId, userId) =>
    api(`/teams/${teamId}/members/${userId}`, { method: 'DELETE' }),
  // Mark a channel as read (for notification badges)
  markChannelRead: (teamId, channelId) =>
    api(`/teams/${teamId}/channels/${channelId}/read`, { method: 'POST' }),
  // Get unread counts for a team
  getUnread: (teamId) => api(`/teams/${teamId}/unread`),
};

export const channels = {
  list: (teamId) => api(`/channels/team/${teamId}`),
  create: (teamId, data) =>
    api(`/channels/team/${teamId}`, {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  get: (id) => api(`/channels/${id}`),
  update: (id, data) => api(`/channels/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  delete: (id) => api(`/channels/${id}`, { method: 'DELETE' }),
  move: (id, categoryId, position) =>
    api(`/channels/${id}/move`, { method: 'PATCH', body: JSON.stringify({ categoryId, position }) }),
};

// ═══════════════════════════════════════════════════════════
// SERVER MANAGEMENT API (Discord-like features)
// ═══════════════════════════════════════════════════════════
export const servers = {
  // Categories
  getCategories: (teamId) => api(`/servers/${teamId}/categories`),
  createCategory: (teamId, name) =>
    api(`/servers/${teamId}/categories`, { method: 'POST', body: JSON.stringify({ name }) }),
  updateCategory: (teamId, categoryId, data) =>
    api(`/servers/${teamId}/categories/${categoryId}`, { method: 'PATCH', body: JSON.stringify(data) }),
  deleteCategory: (teamId, categoryId) =>
    api(`/servers/${teamId}/categories/${categoryId}`, { method: 'DELETE' }),
  
  // Roles
  getRoles: (teamId) => api(`/servers/${teamId}/roles`),
  createRole: (teamId, data) =>
    api(`/servers/${teamId}/roles`, { method: 'POST', body: JSON.stringify(data) }),
  updateRole: (teamId, roleId, data) =>
    api(`/servers/${teamId}/roles/${roleId}`, { method: 'PATCH', body: JSON.stringify(data) }),
  deleteRole: (teamId, roleId) =>
    api(`/servers/${teamId}/roles/${roleId}`, { method: 'DELETE' }),
  
  // Member roles
  getRoleMembers: (teamId, roleId) => api(`/servers/${teamId}/roles/${roleId}/members`),
  getMemberRoles: (teamId, userId) => api(`/servers/${teamId}/members/${userId}/roles`),
  addMemberRole: (teamId, userId, roleId) =>
    api(`/servers/${teamId}/members/${userId}/roles/${roleId}`, { method: 'POST' }),
  removeMemberRole: (teamId, userId, roleId) =>
    api(`/servers/${teamId}/members/${userId}/roles/${roleId}`, { method: 'DELETE' }),
  kickMember: (teamId, userId, reason) =>
    api(`/servers/${teamId}/members/${userId}`, { method: 'DELETE', body: JSON.stringify({ reason }) }),
  
  // Invites
  getInvites: (teamId) => api(`/servers/${teamId}/invites`),
  createInvite: (teamId, data) =>
    api(`/servers/${teamId}/invites`, { method: 'POST', body: JSON.stringify(data) }),
  deleteInvite: (teamId, inviteId) =>
    api(`/servers/${teamId}/invites/${inviteId}`, { method: 'DELETE' }),
  getInviteInfo: (code) => api(`/servers/invite/${code}`),
  joinWithInvite: (code) => api(`/servers/join/${code}`, { method: 'POST' }),
  getDiscoverable: (tag) => api(tag ? `/servers/discover?tag=${encodeURIComponent(tag)}` : '/servers/discover'),
  joinPublic: (teamId) => api(`/servers/${teamId}/join-public`, { method: 'POST' }),
  
  // Bans
  getBans: (teamId) => api(`/servers/${teamId}/bans`),
  banMember: (teamId, userId, data) =>
    api(`/servers/${teamId}/bans/${userId}`, { method: 'POST', body: JSON.stringify(data) }),
  unbanMember: (teamId, userId) =>
    api(`/servers/${teamId}/bans/${userId}`, { method: 'DELETE' }),
  
  // Audit log
  getAuditLog: (teamId, params) => {
    const q = new URLSearchParams(params).toString();
    return api(`/servers/${teamId}/audit-log${q ? `?${q}` : ''}`);
  },
  
  // Settings
  updateSettings: (teamId, data) =>
    api(`/servers/${teamId}/settings`, { method: 'PATCH', body: JSON.stringify(data) }),

  // Server avatar upload
  uploadAvatar: async (teamId, file) => {
    const token = getToken();
    const formData = new FormData();
    formData.append('icon', file);
    const res = await fetch(`${API_BASE}/servers/${teamId}/avatar`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: formData,
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || 'Upload failed');
    }
    invalidateCache('/teams');
    return res.json();
  },

  // Emoji file upload (returns image_url for createEmoji)
  uploadEmojiImage: async (teamId, file) => {
    const token = getToken();
    const formData = new FormData();
    formData.append('emoji', file);
    const res = await fetch(`${API_BASE}/servers/${teamId}/emojis/upload`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: formData,
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || 'Upload failed');
    }
    const data = await res.json();
    return data.image_url;
  },
  
  // Nicknames
  setNickname: (teamId, userId, nickname) =>
    api(`/servers/${teamId}/members/${userId}/nickname`, { method: 'PATCH', body: JSON.stringify({ nickname }) }),
  
  // Emojis
  getEmojis: (teamId) => api(`/servers/${teamId}/emojis`),
  createEmoji: (teamId, data) =>
    api(`/servers/${teamId}/emojis`, { method: 'POST', body: JSON.stringify(data) }),
  deleteEmoji: (teamId, emojiId) =>
    api(`/servers/${teamId}/emojis/${emojiId}`, { method: 'DELETE' }),
};

export const messages = {
  search: (q, limit = 20) => {
    const params = new URLSearchParams({ q: q.trim(), limit });
    return api(`/messages/search?${params}`);
  },
  channel: (channelId, params) => {
    const q = new URLSearchParams(params).toString();
    return api(`/messages/channel/${channelId}${q ? `?${q}` : ''}`);
  },
  sendChannel: (channelId, content, type, replyToId) =>
    api(`/messages/channel/${channelId}`, {
      method: 'POST',
      body: JSON.stringify({ content, type: type || 'text', replyToId: replyToId || null }),
    }),
  uploadChannel: async (channelId, file, caption) => {
    const token = getToken();
    const formData = new FormData();
    formData.append('file', file);
    if (caption) formData.append('caption', caption);
    
    try {
      const res = await fetch(`${API_BASE}/messages/channel/${channelId}/upload`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: formData,
      });
      
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        console.error('[Upload Channel] Erreur serveur:', err?.error || 'Erreur upload');
        throw new Error(err.error || 'Erreur upload');
      }
      
      const result = await res.json();
      return result;
    } catch (err) {
      console.error('[Upload Channel] Exception:', err?.message || 'Unknown error');
      throw err;
    }
  },
  editChannel: (channelId, messageId, content) =>
    api(`/messages/channel/${channelId}/${messageId}`, {
      method: 'PATCH',
      body: JSON.stringify({ content }),
    }),
  deleteChannel: (channelId, messageId) =>
    api(`/messages/channel/${channelId}/${messageId}`, { method: 'DELETE' }),
  hideChannel: (channelId, messageId) =>
    api(`/messages/channel/${channelId}/${messageId}/hide`, { method: 'POST' }),
  massDeleteChannel: (channelId, messageIds) =>
    api(`/messages/channel/${channelId}/mass-delete`, {
      method: 'POST',
      body: JSON.stringify({ messageIds }),
    }),
  massHideChannel: (channelId, messageIds) =>
    api(`/messages/channel/${channelId}/mass-hide`, {
      method: 'POST',
      body: JSON.stringify({ messageIds }),
    }),
};

export const direct = {
  conversations: () => api('/direct/conversations'),
  createConversation: (userId) =>
    api('/direct/conversations', { method: 'POST', body: JSON.stringify({ userId }) }),
  createGroup: (userIds, groupName) =>
    api('/direct/conversations', { method: 'POST', body: JSON.stringify({ userIds, groupName }) }),
  getConversationInfo: (conversationId) =>
    api(`/direct/conversations/${conversationId}/info`),
  updateGroup: (conversationId, data) =>
    api(`/direct/conversations/${conversationId}`, { method: 'PATCH', body: JSON.stringify(data) }),
  addGroupMember: (conversationId, userId) =>
    api(`/direct/conversations/${conversationId}/members`, { method: 'POST', body: JSON.stringify({ userId }) }),
  removeGroupMember: (conversationId, userId) =>
    api(`/direct/conversations/${conversationId}/members/${userId}`, { method: 'DELETE' }),
  leaveGroup: (conversationId) =>
    api(`/direct/conversations/${conversationId}/leave`, { method: 'POST' }),
  messages: (conversationId, params) => {
    const q = new URLSearchParams(params).toString();
    return api(`/direct/conversations/${conversationId}/messages${q ? `?${q}` : ''}`);
  },
  sendMessage: (conversationId, content, type, replyToId) =>
    api(`/direct/conversations/${conversationId}/messages`, {
      method: 'POST',
      body: JSON.stringify({ content, type: type || 'text', replyToId: replyToId || null }),
    }),
  uploadFile: async (conversationId, file, caption) => {
    const token = getToken();
    const formData = new FormData();
    formData.append('file', file);
    if (caption) formData.append('caption', caption);
    
    try {
      const res = await fetch(`${API_BASE}/direct/conversations/${conversationId}/upload`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: formData,
      });
      
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        console.error('[Upload] Erreur serveur:', err?.error || 'Erreur upload');
        throw new Error(err.error || 'Erreur upload');
      }
      
      const result = await res.json();
      return result;
    } catch (err) {
      console.error('[Upload] Exception:', err?.message || 'Unknown error');
      throw err;
    }
  },
  editMessage: (conversationId, messageId, content) =>
    api(`/direct/conversations/${conversationId}/messages/${messageId}`, {
      method: 'PATCH',
      body: JSON.stringify({ content }),
    }),
  deleteMessage: (conversationId, messageId) =>
    api(`/direct/conversations/${conversationId}/messages/${messageId}`, { method: 'DELETE' }),
  hideMessage: (conversationId, messageId) =>
    api(`/direct/conversations/${conversationId}/messages/${messageId}/hide`, { method: 'POST' }),
  massDelete: (conversationId, messageIds) =>
    api(`/direct/conversations/${conversationId}/mass-delete`, {
      method: 'POST',
      body: JSON.stringify({ messageIds }),
    }),
  massHide: (conversationId, messageIds) =>
    api(`/direct/conversations/${conversationId}/mass-hide`, {
      method: 'POST',
      body: JSON.stringify({ messageIds }),
    }),
  markRead: (conversationId, lastMessageId) =>
    api(`/direct/conversations/${conversationId}/read`, {
      method: 'POST',
      body: JSON.stringify({ lastMessageId }),
    }),
  getReads: (conversationId) =>
    api(`/direct/conversations/${conversationId}/reads`),
};

export const users = {
  search: (q) => api(`/users/search?q=${encodeURIComponent(q)}`),
  suggestions: () => api('/users/suggestions'),
  getProfile: (userId) => api(`/users/${userId}/profile`),
  getCommonTeams: (userId) => api(`/users/${userId}/common-teams`),
  getByUsername: (username) => api(`/users/by-username/${encodeURIComponent(username)}`),
};

export const conversations = {
  delete: (conversationId) => api(`/direct/conversations/${conversationId}`, { method: 'DELETE' }),
  pin: (conversationId) => api(`/direct/conversations/${conversationId}/pin`, { method: 'POST' }),
  unpin: (conversationId) => api(`/direct/conversations/${conversationId}/pin`, { method: 'DELETE' }),
};

export const avatars = {
  upload: async (file, cropParams) => {
    const formData = new FormData();
    formData.append('photo', file);
    if (cropParams) {
      formData.append('cropX', cropParams.x.toString());
      formData.append('cropY', cropParams.y.toString());
      formData.append('cropSize', cropParams.size.toString());
      if (cropParams.sourceWidth != null) formData.append('sourceWidth', cropParams.sourceWidth.toString());
      if (cropParams.sourceHeight != null) formData.append('sourceHeight', cropParams.sourceHeight.toString());
    }
    const token = getToken();
    const r = await fetch(`${API_BASE}/avatars/upload`, {
      method: 'POST',
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      body: formData,
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || 'Erreur upload');
    return data;
  },
  reset: () => api('/avatars/me', { method: 'PATCH', body: JSON.stringify({ reset: true }) }),
  uploadBanner: async (file) => {
    const formData = new FormData();
    formData.append('banner', file);
    const token = getToken();
    const r = await fetch(`${API_BASE}/avatars/banner`, {
      method: 'POST',
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      body: formData,
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || 'Erreur upload');
    return data;
  },
  deleteBanner: () => api('/avatars/banner', { method: 'DELETE' }),
};

// ═══════════════════════════════════════════════════════════
// REACTIONS API
// ═══════════════════════════════════════════════════════════
export const reactions = {
  // Channel reactions
  getChannel: (channelId, messageId) =>
    api(`/messages/channel/${channelId}/${messageId}/reactions`),
  addChannel: (channelId, messageId, emoji) =>
    api(`/messages/channel/${channelId}/${messageId}/reactions`, {
      method: 'POST',
      body: JSON.stringify({ emoji }),
    }),
  removeChannel: (channelId, messageId, emoji, targetUserId = null) =>
    api(`/messages/channel/${channelId}/${messageId}/reactions/${encodeURIComponent(emoji)}${targetUserId != null ? `?userId=${encodeURIComponent(targetUserId)}` : ''}`, {
      method: 'DELETE',
    }),
  
  // Direct message reactions
  getDirect: (conversationId, messageId) =>
    api(`/direct/conversations/${conversationId}/messages/${messageId}/reactions`),
  addDirect: (conversationId, messageId, emoji) =>
    api(`/direct/conversations/${conversationId}/messages/${messageId}/reactions`, {
      method: 'POST',
      body: JSON.stringify({ emoji }),
    }),
  removeDirect: (conversationId, messageId, emoji) =>
    api(`/direct/conversations/${conversationId}/messages/${messageId}/reactions/${encodeURIComponent(emoji)}`, {
      method: 'DELETE',
    }),
};

// ═══════════════════════════════════════════════════════════
// PINNED MESSAGES API
// ═══════════════════════════════════════════════════════════
export const pinned = {
  // Channel pinned messages
  getChannel: (channelId) =>
    api(`/messages/channel/${channelId}/pinned`),
  pinChannel: (channelId, messageId) =>
    api(`/messages/channel/${channelId}/${messageId}/pin`, { method: 'POST' }),
  unpinChannel: (channelId, messageId) =>
    api(`/messages/channel/${channelId}/${messageId}/pin`, { method: 'DELETE' }),
  
  // Direct message pinned
  getDirect: (conversationId) =>
    api(`/direct/conversations/${conversationId}/pinned`),
  pinDirect: (conversationId, messageId) =>
    api(`/direct/conversations/${conversationId}/messages/${messageId}/pin`, { method: 'POST' }),
  unpinDirect: (conversationId, messageId) =>
    api(`/direct/conversations/${conversationId}/messages/${messageId}/pin`, { method: 'DELETE' }),
};

// ═══════════════════════════════════════════════════════════
// USER SETTINGS API
// ═══════════════════════════════════════════════════════════
export const settings = {
  // Get all settings
  get: () => api('/settings'),
  
  // Update settings (partial)
  update: (data) => api('/settings', { method: 'PATCH', body: JSON.stringify(data) }),
  
  // Reset all settings to defaults
  reset: () => api('/settings/reset', { method: 'POST' }),
  
  // Profile
  getProfile: () => api('/settings/profile'),
  updateProfile: (data) => api('/settings/profile', { method: 'PATCH', body: JSON.stringify(data) }),
  
  // Email change (mfaCode required when 2FA is enabled)
  changeEmail: (newEmail, password, mfaCode) =>
    api('/settings/email', { method: 'PATCH', body: JSON.stringify({ newEmail, password, ...(mfaCode && { mfaCode }) }) }),
  
  // Connections
  getConnections: () => api('/settings/connections'),
  disconnect: (provider) => api(`/settings/connections/${provider}`, { method: 'DELETE' }),

  // Spotify (OAuth - returns URL to redirect to; then window.location = url)
  connectSpotify: () => api('/settings/spotify/connect-init', { method: 'POST', body: JSON.stringify({}) }).then(d => d.url),
  
  // Activity log
  getActivity: () => api('/settings/activity'),
  
  // Export data (RGPD/GDPR - portabilité des données)
  exportData: () => api('/gdpr/export', { method: 'POST' }),
  
  // Clear cache
  clearCache: () => api('/settings/clear-cache', { method: 'POST' }),
};

// ═══════════════════════════════════════════════════════════
// STICKER PACKS API
// ═══════════════════════════════════════════════════════════
export const stickers = {
  // Get all sticker packs for user's teams
  getPacks: () => api('/stickers/packs'),
  
  // Get sticker packs for a specific team
  getTeamPacks: (teamId) => api(`/stickers/packs/team/${teamId}`),
  
  // Get a single pack with its stickers
  getPack: (packId) => api(`/stickers/packs/${packId}`),
  
  // Create a new sticker pack
  createPack: async (teamId, name, description, coverFile) => {
    const token = getToken();
    const formData = new FormData();
    formData.append('teamId', teamId);
    formData.append('name', name);
    if (description) formData.append('description', description);
    if (coverFile) formData.append('cover', coverFile);
    
    const res = await fetch(`${API_BASE}/stickers/packs`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: formData,
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Erreur lors de la création');
    return data;
  },
  
  // Update a sticker pack
  updatePack: async (packId, name, description, coverFile) => {
    const token = getToken();
    const formData = new FormData();
    if (name) formData.append('name', name);
    if (description !== undefined) formData.append('description', description || '');
    if (coverFile) formData.append('cover', coverFile);
    
    const res = await fetch(`${API_BASE}/stickers/packs/${packId}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${token}` },
      body: formData,
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Erreur lors de la mise à jour');
    return data;
  },
  
  // Delete a sticker pack
  deletePack: (packId) => api(`/stickers/packs/${packId}`, { method: 'DELETE' }),
  
  // Add sticker to a pack
  addSticker: async (packId, name, stickerFile) => {
    const token = getToken();
    const formData = new FormData();
    if (name) formData.append('name', name);
    formData.append('sticker', stickerFile);
    
    const res = await fetch(`${API_BASE}/stickers/packs/${packId}/stickers`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: formData,
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Erreur lors de l\'ajout');
    return data;
  },
  
  // Delete a sticker
  deleteSticker: (stickerId) => api(`/stickers/${stickerId}`, { method: 'DELETE' }),
  
  // Get all stickers for picker (grouped by pack)
  getAll: () => api('/stickers/all'),
  
  // Save a pack to your collection (steal from others)
  savePack: (packId) => api(`/stickers/packs/${packId}/save`, { method: 'POST' }),
  
  // Remove a saved pack
  unsavePack: (packId) => api(`/stickers/packs/${packId}/save`, { method: 'DELETE' }),
  
  // Hide a pack (won't show in picker)
  hidePack: (packId) => api(`/stickers/packs/${packId}/hide`, { method: 'POST' }),
  
  // Unhide a pack
  unhidePack: (packId) => api(`/stickers/packs/${packId}/hide`, { method: 'DELETE' }),
  
  // Get pack info by sticker URL (for saving from chat)
  getPackBySticker: (stickerUrl) => api(`/stickers/pack-by-sticker?url=${encodeURIComponent(stickerUrl)}`),
};

// ═══════════════════════════════════════════════════════════
// FRIENDS API
// ═══════════════════════════════════════════════════════════
export const friends = {
  list: () => api('/friends'),
  online: () => api('/friends/online'),
  pending: () => api('/friends/pending'),
  blocked: () => api('/friends/blocked'),
  sendRequest: (username) =>
    api('/friends/requests', { method: 'POST', body: JSON.stringify({ username }) }),
  acceptRequest: (requestId) =>
    api(`/friends/requests/${requestId}/accept`, { method: 'POST' }),
  declineRequest: (requestId) =>
    api(`/friends/requests/${requestId}/decline`, { method: 'POST' }),
  removeFriend: (userId) =>
    api(`/friends/${userId}`, { method: 'DELETE' }),
  block: (userId) =>
    api(`/friends/block/${userId}`, { method: 'POST' }),
  unblock: (userId) =>
    api(`/friends/block/${userId}`, { method: 'DELETE' }),
};

// ═══════════════════════════════════════════════════════════
// MEDIA API - GIFs (Tenor) and Emojis
// ═══════════════════════════════════════════════════════════
export const media = {
  // Search GIFs via Tenor
  searchGifs: (query, limit = 20, pos = null) => {
    const params = new URLSearchParams({ q: query, limit });
    if (pos) params.append('pos', pos);
    return api(`/media/gifs/search?${params}`);
  },
  
  // Get trending GIFs
  trendingGifs: (limit = 20, pos = null) => {
    const params = new URLSearchParams({ limit });
    if (pos) params.append('pos', pos);
    return api(`/media/gifs/trending?${params}`);
  },
  
  // Get GIF categories
  gifCategories: () => api('/media/gifs/categories'),
  
  // Get all custom emojis
  getEmojis: () => api('/media/emojis'),
};

// ═══════════════════════════════════════════════════════════
// QUESTS & SHOP API
// ═══════════════════════════════════════════════════════════
export const quests = {
  list: (category) =>
    api(`/quests?category=${category || 'daily'}`),
  claim: (questId) =>
    api(`/quests/${questId}/claim`, { method: 'POST', body: JSON.stringify({}) }),
};

export const shop = {
  getOrbs: () => api('/shop/orbs'),
  getItems: () => api('/shop/items'),
  purchase: (itemId) =>
    api('/shop/purchase', { method: 'POST', body: JSON.stringify({ itemId }) }),
  equip: (itemId) =>
    api('/shop/equip', { method: 'POST', body: JSON.stringify({ itemId }) }),
  unequip: (category) =>
    api('/shop/unequip', { method: 'POST', body: JSON.stringify({ category }) }),
};

// ═══════════════════════════════════════════════════════════
// WEBHOOKS API
// ═══════════════════════════════════════════════════════════
export const webhooks = {
  list: (teamId, channelId) => api(`/webhooks/${teamId}${channelId ? `?channelId=${channelId}` : ''}`),
  uploadAvatar: async (teamId, webhookId, file) => {
    const token = getToken();
    const formData = new FormData();
    formData.append('avatar', file);
    const res = await fetch(`${API_BASE}/webhooks/${teamId}/${webhookId}/avatar`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: formData,
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || 'Upload failed');
    }
    return res.json();
  },
  create: (teamId, data) =>
    api(`/webhooks/${teamId}`, { method: 'POST', body: JSON.stringify(data) }),
  update: (teamId, webhookId, data) =>
    api(`/webhooks/${teamId}/${webhookId}`, { method: 'PATCH', body: JSON.stringify(data) }),
  delete: (teamId, webhookId) =>
    api(`/webhooks/${teamId}/${webhookId}`, { method: 'DELETE' }),
  regenerateToken: (teamId, webhookId) =>
    api(`/webhooks/${teamId}/${webhookId}/regenerate`, { method: 'POST' }),
};

// ═══════════════════════════════════════════════════════════
// CHANNEL PERMISSION OVERRIDES API
// ═══════════════════════════════════════════════════════════
export const channelOverrides = {
  list: (channelId) => api(`/channels/${channelId}/overrides`),
  upsert: (channelId, data) =>
    api(`/channels/${channelId}/overrides`, { method: 'PUT', body: JSON.stringify(data) }),
  remove: (channelId, targetType, targetId) =>
    api(`/channels/${channelId}/overrides/${targetType}/${targetId}`, { method: 'DELETE' }),
};

export const reports = {
  submit: (data) => api('/reports', { method: 'POST', body: JSON.stringify(data) }),
  list: (params) => {
    const q = new URLSearchParams(params).toString();
    return api(`/reports${q ? `?${q}` : ''}`);
  },
  updateStatus: (id, status) =>
    api(`/reports/${id}`, { method: 'PATCH', body: JSON.stringify({ status }) }),
};

/**
 * Profile cache — in-memory + sessionStorage for instant profile card loading.
 * Prefetches profiles and images on hover so clicks feel instant.
 */

import { users as usersApi } from '../api';
import { getStaticUrl } from './staticUrl';
import { prefetchImage, prefetchImages } from './imagePreloader';

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 min
const MAX_MEMORY = 80;
const STORAGE_KEY = 'slide_profile_cache';
const STORAGE_MAX = 50;

const memory = new Map();
const pending = new Map();
let lru = [];

function getStorage() {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw);
  } catch (_) {}
  return {};
}

function setStorage(data) {
  try {
    const keys = Object.keys(data);
    if (keys.length > STORAGE_MAX) {
      const sorted = keys.sort((a, b) => (data[b]?.t ?? 0) - (data[a]?.t ?? 0));
      const toKeep = sorted.slice(0, STORAGE_MAX);
      const next = {};
      toKeep.forEach((k) => { next[k] = data[k]; });
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } else {
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    }
  } catch (_) {}
}

function getFromStorage(userId) {
  const data = getStorage();
  const entry = data[String(userId)];
  if (!entry?.d) return null;
  const age = Date.now() - (entry.t || 0);
  if (age > CACHE_TTL_MS) return null;
  return entry.d;
}

function saveToStorage(userId, profile) {
  const data = getStorage();
  data[String(userId)] = { d: profile, t: Date.now() };
  setStorage(data);
}

function evictLru() {
  while (lru.length >= MAX_MEMORY && lru.length > 0) {
    const id = lru.shift();
    memory.delete(id);
  }
}

function touchLru(userId) {
  const id = String(userId);
  lru = lru.filter((x) => x !== id);
  lru.push(id);
  if (lru.length > MAX_MEMORY) evictLru();
}

function getFromMemory(userId) {
  const entry = memory.get(String(userId));
  if (!entry) return null;
  const age = Date.now() - entry.t;
  if (age > CACHE_TTL_MS) {
    memory.delete(String(userId));
    return null;
  }
  touchLru(userId);
  return entry.d;
}

function saveToMemory(userId, profile) {
  const id = String(userId);
  memory.set(id, { d: profile, t: Date.now() });
  touchLru(userId);
  saveToStorage(userId, profile);
}

function getImageUrls(profile) {
  const urls = [];
  if (profile?.avatar_url && !profile.avatar_url.includes('/default/')) {
    urls.push(getStaticUrl(profile.avatar_url));
  }
  if (profile?.banner_url) {
    urls.push(getStaticUrl(profile.banner_url));
  }
  if (profile?.spotify_now_playing?.album_art) {
    urls.push(profile.spotify_now_playing.album_art);
  }
  return urls;
}

export function getCachedProfile(userId) {
  return getFromMemory(userId) ?? getFromStorage(userId);
}

/** Invalidate cached profile so next fetch returns fresh data */
export function invalidateProfile(userId) {
  const id = String(userId);
  memory.delete(id);
  lru = lru.filter((x) => x !== id);
  try {
    const data = getStorage();
    delete data[id];
    setStorage(data);
  } catch (_) {}
}

export async function getProfile(userId) {
  const id = String(userId);
  const cached = getFromMemory(userId) ?? getFromStorage(userId);
  if (cached) return cached;

  if (pending.has(id)) return pending.get(id);

  const p = usersApi.getProfile(userId).then((data) => {
    saveToMemory(userId, data);
    pending.delete(id);
    prefetchImages(getImageUrls(data)).catch(() => {});
    return data;
  }).catch((err) => {
    pending.delete(id);
    throw err;
  });
  pending.set(id, p);
  return p;
}

export function prefetchProfile(userId, partialUser = null) {
  const id = String(userId);
  if (getFromMemory(userId) || getFromStorage(userId)) {
    if (partialUser) {
      const urls = [];
      if (partialUser?.avatar_url && !String(partialUser.avatar_url).includes('/default/')) {
        urls.push(getStaticUrl(partialUser.avatar_url));
      }
      if (partialUser?.banner_url) urls.push(getStaticUrl(partialUser.banner_url));
      if (urls.length) prefetchImages(urls).catch(() => {});
    }
    return Promise.resolve();
  }
  if (pending.has(id)) return pending.get(id);

  if (partialUser) {
    const urls = getImageUrls(partialUser);
    if (urls.length) prefetchImages(urls).catch(() => {});
  }

  const p = usersApi.getProfile(userId).then((data) => {
    saveToMemory(userId, data);
    pending.delete(id);
    prefetchImages(getImageUrls(data)).catch(() => {});
    return data;
  }).catch(() => {
    pending.delete(id);
  });
  pending.set(id, p);
  return p;
}

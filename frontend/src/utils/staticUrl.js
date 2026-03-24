/**
 * Resolves static file URLs for /uploads/* and /avatars/*
 * - If CDN is configured (VITE_CDN_BASE_URL or electron.cdnBaseUrl), uses CDN
 * - Otherwise uses the fixed backend origin
 * - Absolute URLs (http/https) are returned as-is
 */

const FIXED_BACKEND_ORIGIN = 'http://192.168.1.176:3000';
const SL1DE_WEB_BACKEND_ORIGIN = 'https://api.sl1de.xyz';
/** Electron app MUST always use this backend for static assets */
const ELECTRON_BACKEND_ORIGIN = 'https://api.sl1de.xyz';

function getStaticBase() {
  const isElectron = typeof window !== 'undefined' && !!window.electron?.isElectron;
  const isCapacitor = typeof window !== 'undefined' && !!window.Capacitor?.isNativePlatform?.();
  const isNativeRuntime = isElectron || isCapacitor;
  const isWebOnSl1deDomain = typeof window !== 'undefined'
    && /(^|\.)sl1de\.xyz$/i.test(window.location.hostname);
  // CDN takes priority when configured
  const cdn = import.meta.env.VITE_CDN_BASE_URL || (typeof window !== 'undefined' && window.electron?.cdnBaseUrl) || '';
  if (cdn) return cdn.replace(/\/$/, '');
  const webBackendOrigin = import.meta.env.VITE_BACKEND_ORIGIN || '';
  if (!isNativeRuntime && webBackendOrigin) return webBackendOrigin.replace(/\/$/, '');
  if (!isNativeRuntime && isWebOnSl1deDomain) return SL1DE_WEB_BACKEND_ORIGIN;
  // Web over HTTPS must stay same-origin to avoid Mixed Content + PNA blocks.
  if (!isNativeRuntime && typeof window !== 'undefined') return window.location.origin;
  // Electron always uses production API; Capacitor uses FIXED_BACKEND_ORIGIN.
  return isElectron ? ELECTRON_BACKEND_ORIGIN : FIXED_BACKEND_ORIGIN;
}

/**
 * Returns the full URL for a static asset.
 * @param {string} path - Path like /uploads/avatars/x.png or /avatars/default.png
 * @returns {string} Full URL (CDN or origin + path)
 */
export function getStaticUrl(path) {
  if (!path || typeof path !== 'string') return path || '';
  if (path.startsWith('http://') || path.startsWith('https://')) return path;
  if (path.startsWith('blob:') || path.startsWith('data:')) return path;
  const base = getStaticBase();
  const p = path.startsWith('/') ? path : `/${path}`;
  return base ? `${base}${p}` : p;
}

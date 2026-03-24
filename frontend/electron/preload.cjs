const { contextBridge, ipcRenderer } = require('electron');

/** Electron app MUST always use this backend (no override) */
const ELECTRON_BACKEND_ORIGIN = 'https://api.sl1de.xyz';
const cdnBaseUrl = process.env.SLIDE_CDN_BASE_URL || '';

contextBridge.exposeInMainWorld('electron', {
  isElectron: true,
  platform: process.platform,

  // ── Backend URLs ────────────────────────────────────────────────────────────
  apiBaseUrl: ELECTRON_BACKEND_ORIGIN,
  cdnBaseUrl: cdnBaseUrl || undefined,

  // ── Startup ─────────────────────────────────────────────────────────────────
  setLaunchAtStartup: (enabled) => ipcRenderer.invoke('set-launch-at-startup', enabled),
  getLaunchAtStartup: () => ipcRenderer.invoke('get-launch-at-startup'),

  // ── Window controls ──────────────────────────────────────────────────────────
  minimize: () => ipcRenderer.send('window-minimize'),
  maximize: () => ipcRenderer.send('window-maximize'),
  close: () => ipcRenderer.send('window-close'),
  isMaximized: () => ipcRenderer.invoke('window-is-maximized'),
  setAlwaysOnTop: (flag) => ipcRenderer.invoke('set-always-on-top', flag),
  flashFrame: () => ipcRenderer.send('flash-frame'),

  onMaximizeChange: (callback) => {
    const fn = (_, v) => callback(v);
    ipcRenderer.on('window-maximize-change', fn);
    return () => ipcRenderer.removeListener('window-maximize-change', fn);
  },
  onVisibilityChange: (callback) => {
    const fn = (_, v) => callback(v);
    ipcRenderer.on('window-visibility-change', fn);
    return () => ipcRenderer.removeListener('window-visibility-change', fn);
  },
  onFocusChange: (callback) => {
    const fn = (_, v) => callback(v);
    ipcRenderer.on('window-focus-change', fn);
    return () => ipcRenderer.removeListener('window-focus-change', fn);
  },

  // ── Tray / minimize-to-tray ──────────────────────────────────────────────────
  setMinimizeToTray: (enabled) => ipcRenderer.invoke('set-minimize-to-tray', enabled),
  getMinimizeToTray: () => ipcRenderer.invoke('get-minimize-to-tray'),

  // ── Notifications ────────────────────────────────────────────────────────────
  // options: { title, body, icon? }
  showNotification: (options) => ipcRenderer.invoke('show-notification', options),

  // ── Badge / unread count ─────────────────────────────────────────────────────
  // Updates taskbar overlay icon (Windows), dock badge (macOS), tray tooltip
  setBadgeCount: (count) => ipcRenderer.invoke('set-badge-count', count),

  // ── Power save blocker ───────────────────────────────────────────────────────
  // Prevent the display from sleeping (e.g. during calls/screenshare)
  blockPowerSave: () => ipcRenderer.invoke('power-save-block'),
  unblockPowerSave: () => ipcRenderer.invoke('power-save-unblock'),
  getPowerSaveStatus: () => ipcRenderer.invoke('get-power-save-status'),

  // ── File dialogs ─────────────────────────────────────────────────────────────
  // opts: { properties?, filters?, title? }
  // Returns: array of file paths, or null if cancelled
  openFileDialog: (opts) => ipcRenderer.invoke('open-file-dialog', opts),
  // Returns: file path string, or null if cancelled
  saveFileDialog: (opts) => ipcRenderer.invoke('save-file-dialog', opts),

  // ── Screen share picker ──────────────────────────────────────────────────────
  // Returns array of { id, name, thumbnail (dataURL), appIcon, display_id }
  getDesktopSources: () => ipcRenderer.invoke('get-desktop-sources'),
  // Call this with the chosen source id BEFORE calling getDisplayMedia()
  setDesktopSource: (id) => ipcRenderer.invoke('set-desktop-source', id),

  // ── System power ─────────────────────────────────────────────────────────────
  systemReboot:   () => ipcRenderer.invoke('system-reboot'),
  systemShutdown: () => ipcRenderer.invoke('system-shutdown'),
  systemSleep:    () => ipcRenderer.invoke('system-sleep'),
  // Restart the Electron app itself (not the OS)
  appRestart: () => ipcRenderer.invoke('app-restart'),

  // ── Shell ────────────────────────────────────────────────────────────────────
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  showItemInFolder: (filePath) => ipcRenderer.invoke('show-item-in-folder', filePath),

  // ── App info ─────────────────────────────────────────────────────────────────
  getVersion: () => ipcRenderer.invoke('get-app-version'),
  // name: 'home' | 'appData' | 'userData' | 'downloads' | 'desktop' | etc.
  getPath: (name) => ipcRenderer.invoke('get-app-path', name),

  // ── Protocol URL (slide://) ──────────────────────────────────────────────────
  onProtocolUrl: (callback) => {
    const fn = (_, url) => callback(url);
    ipcRenderer.on('protocol-url', fn);
    return () => ipcRenderer.removeListener('protocol-url', fn);
  },

  // ── Secure storage (encrypted on disk) ──────────────────────────────────────
  secureGet:    (key) => ipcRenderer.invoke('secure-store-get', key),
  secureSet:    (key, value) => ipcRenderer.invoke('secure-store-set', key, value),
  secureDelete: (key) => ipcRenderer.invoke('secure-store-delete', key),
  secureClear:  () => ipcRenderer.invoke('secure-store-clear'),
});

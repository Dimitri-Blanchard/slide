const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');

const APP_NAME = 'Slide';
const APP_EXE = 'Slide.exe';
const INSTALL_DIR = path.join(process.env.LOCALAPPDATA || process.env.APPDATA, 'Programs', APP_NAME);

let mainWindow = null;

function getAppZipPath() {
  return path.join(process.resourcesPath, 'app.zip');
}

function createShortcut(target, lnkPath) {
  const vbs = path.join(process.env.TEMP || process.env.TMP, 'slide_shortcut.vbs');
  const content = [
    'Set oWS = WScript.CreateObject("WScript.Shell")',
    `Set oLink = oWS.CreateShortcut(${JSON.stringify(lnkPath)})`,
    `oLink.TargetPath = ${JSON.stringify(target)}`,
    `oLink.WorkingDirectory = ${JSON.stringify(path.dirname(target))}`,
    `oLink.IconLocation = ${JSON.stringify(target + ",0")}`,
    'oLink.Save',
  ].join('\n');
  fs.writeFileSync(vbs, content);
  try {
    execSync(`cscript //nologo "${vbs}"`, { stdio: 'pipe' });
  } finally {
    try { fs.unlinkSync(vbs); } catch (_) {}
  }
}

async function install() {
  const zipPath = getAppZipPath();
  if (!fs.existsSync(zipPath)) {
    return { ok: false, error: 'app.zip not found' };
  }
  try {
    if (fs.existsSync(INSTALL_DIR)) {
      fs.rmSync(INSTALL_DIR, { recursive: true });
    }
    fs.mkdirSync(INSTALL_DIR, { recursive: true });
    const extract = require('extract-zip');
    await extract(zipPath, { dir: INSTALL_DIR });
    // Create shortcuts
    const exePath = path.join(INSTALL_DIR, APP_EXE);
    const desktop = path.join(process.env.USERPROFILE, 'Desktop', `${APP_NAME}.lnk`);
    const startMenu = path.join(process.env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs', `${APP_NAME}.lnk`);
    createShortcut(exePath, desktop);
    fs.mkdirSync(path.dirname(startMenu), { recursive: true });
    createShortcut(exePath, startMenu);
    // Uninstall registry (for Add/Remove Programs)
    const uninstallKey = `Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${APP_NAME}`;
    const uninstallBat = path.join(INSTALL_DIR, 'Uninstall Slide.bat');
    const batContent = `@echo off
taskkill /f /im Slide.exe 2>nul
timeout /t 2 /nobreak >nul
rd /s /q "%~dp0"
reg delete "HKCU\\\\Software\\\\Microsoft\\\\Windows\\\\CurrentVersion\\\\Uninstall\\\\Slide" /f 2>nul
`;
    fs.writeFileSync(uninstallBat, batContent);
    try {
      execSync(`reg add "HKCU\\${uninstallKey}" /v DisplayName /t REG_SZ /d "${APP_NAME}" /f`, { stdio: 'pipe' });
      execSync(`reg add "HKCU\\${uninstallKey}" /v UninstallString /t REG_SZ /d "${uninstallBat}" /f`, { stdio: 'pipe' });
    } catch (_) {}
    return { ok: true, path: exePath };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 420,
    height: 320,
    resizable: false,
    frame: false,
    transparent: false,
    backgroundColor: '#0f1117',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    icon: path.join(__dirname, '..', 'build', 'icon.ico'),
  });
  mainWindow.loadFile(path.join(__dirname, 'index.html'));
  mainWindow.setMenuBarVisibility(false);
}

app.whenReady().then(() => {
  createWindow();
});

ipcMain.handle('install', async () => {
  return install();
});

ipcMain.handle('launch', async (_, exePath) => {
  if (exePath && fs.existsSync(exePath)) {
    shell.openPath(exePath);
  }
});

ipcMain.on('close', () => app.quit());

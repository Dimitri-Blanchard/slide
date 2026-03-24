const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const releaseDir = path.join(root, 'release');
const winUnpacked = path.join(releaseDir, 'win-unpacked');
const installerDir = path.join(root, 'installer');
const appZip = path.join(installerDir, 'app.zip');

// 1. Build icon
console.log('[1/4] Building icon...');
execSync('node scripts/build-icon.cjs', { cwd: root, stdio: 'inherit' });

// 2. Build frontend
console.log('[2/4] Building frontend...');
execSync('npm run build:electron', { cwd: root, stdio: 'inherit' });

// 3. Build main app as dir (win-unpacked)
console.log('[3/4] Building Slide app (win-unpacked)...');
execSync('npx electron-builder --win --dir', { cwd: root, stdio: 'inherit' });

if (!fs.existsSync(winUnpacked)) {
  console.error('win-unpacked not found. Build failed.');
  process.exit(1);
}

// 4. Zip win-unpacked to app.zip (PowerShell)
console.log('[4/4] Creating app.zip...');
const winUnpackedAbs = path.resolve(winUnpacked);
const appZipAbs = path.resolve(appZip);
execSync(
  `powershell -NoProfile -Command "Compress-Archive -Path '${winUnpackedAbs.replace(/'/g, "''")}\\*' -DestinationPath '${appZipAbs.replace(/'/g, "''")}' -Force"`,
  { stdio: 'inherit' }
);

// Copy icon to installer
const iconSrc = path.join(root, 'build', 'icon.ico');
const iconDst = path.join(installerDir, 'icon.ico');
if (fs.existsSync(iconSrc)) fs.copyFileSync(iconSrc, iconDst);

// Build installer
console.log('Building custom installer...');
execSync('npm run build', { cwd: installerDir, stdio: 'inherit' });
console.log('Done. Slide-Setup.exe is in release/');

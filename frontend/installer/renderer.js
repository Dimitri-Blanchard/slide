const idle = document.getElementById('stateIdle');
const installing = document.getElementById('stateInstalling');
const done = document.getElementById('stateDone');
const errorState = document.getElementById('stateError');
const errorMsg = document.getElementById('errorMsg');

function show(state) {
  [idle, installing, done, errorState].forEach((el) => el.classList.add('hidden'));
  state.classList.remove('hidden');
}

document.getElementById('btnClose').addEventListener('click', () => window.installer.close());
document.getElementById('btnInstall').addEventListener('click', runInstall);
document.getElementById('btnRetry').addEventListener('click', runInstall);
document.getElementById('btnLaunch').addEventListener('click', () => {
  if (window._installedPath) window.installer.launch(window._installedPath);
  window.installer.close();
});

async function runInstall() {
  show(installing);
  const result = await window.installer.install();
  if (result.ok) {
    window._installedPath = result.path;
    show(done);
  } else {
    errorMsg.textContent = result.error || 'Installation failed';
    show(errorState);
  }
}

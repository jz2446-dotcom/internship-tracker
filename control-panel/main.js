// main.js — Electron main process for the Tracker Control Panel.
// Runs ONLY deterministic (zero-AI) pipeline steps by shelling out to node/python/wrangler/curl.
// No API keys, no AI calls. Everything runs on the user's own PATH.

const { app, BrowserWindow, ipcMain } = require('electron');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

// Resolve the project root. This must work in TWO modes:
//   - dev (`npm start`): __dirname is control-panel/, so the root is its parent.
//   - packaged (.exe):   __dirname is inside resources/app.asar, so "../" is wrong.
//     Instead we walk up from the executable location until we find the project
//     markers (cloudflare-worker/ + Resumes/). An explicit TRACKER_ROOT env var
//     overrides everything for portability.
function resolveProjectRoot() {
  const hasProject = (dir) => {
    try {
      return !!dir
        && fs.existsSync(path.join(dir, 'cloudflare-worker'))
        && fs.existsSync(path.join(dir, 'Resumes'));
    } catch (_) { return false; }
  };
  // 1. explicit override
  if (hasProject(process.env.TRACKER_ROOT)) return process.env.TRACKER_ROOT;
  // 2. dev: control-panel/ sits directly under the project root
  const devGuess = path.resolve(__dirname, '..');
  if (hasProject(devGuess)) return devGuess;
  // 3. packaged: walk up from the .exe until the project markers appear
  //    (exe lives at <root>/control-panel/dist/<pkg>/Tracker Control Panel.exe)
  let dir = path.dirname(process.execPath);
  for (let i = 0; i < 8; i++) {
    if (hasProject(dir)) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // 4. fall back to the dev guess; the UI will flag the missing dirs
  return devGuess;
}

const PROJECT_ROOT = resolveProjectRoot();
const WORKER_DIR = path.join(PROJECT_ROOT, 'cloudflare-worker');
const RESUME_DIR = path.join(PROJECT_ROOT, 'Resumes', '_master');
const ANALYST_DIR = path.join(PROJECT_ROOT, 'analyst');
const ANALYST_MCP_DIR = path.join(ANALYST_DIR, 'mcp');
const DATA_DIR = path.join(PROJECT_ROOT, 'data');

// One process at a time to keep the console readable and avoid clobbering shared files.
let running = false;
let child = null;

function createWindow() {
  const win = new BrowserWindow({
    width: 1100,
    height: 820,
    minWidth: 820,
    minHeight: 600,
    title: 'Tracker Control Panel',
    backgroundColor: '#0d1117',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });
  win.setMenuBarVisibility(false);
  win.loadFile(path.join(__dirname, 'index.html'));
  return win;
}

app.whenReady().then(() => {
  const win = createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (child) {
    try { child.kill(); } catch (_) {}
  }
  if (process.platform !== 'darwin') app.quit();
});

// --- IPC: report the resolved paths so the renderer can show them ---
ipcMain.handle('get-paths', () => ({
  projectRoot: PROJECT_ROOT,
  workerDir: WORKER_DIR,
  resumeDir: RESUME_DIR,
  workerDirExists: fs.existsSync(WORKER_DIR),
  resumeDirExists: fs.existsSync(RESUME_DIR)
}));

// --- IPC: list available map_*.json files for the resume dropdown ---
ipcMain.handle('list-resume-maps', () => {
  try {
    if (!fs.existsSync(RESUME_DIR)) return [];
    return fs.readdirSync(RESUME_DIR)
      .filter(f => /^map_.+\.json$/i.test(f))
      .sort();
  } catch (_) {
    return [];
  }
});

// Whitelist of directory tokens the renderer may reference. The renderer never sends
// a raw path — it sends a token and we map it here, so nothing outside these dirs runs.
const CWD_MAP = {
  worker: WORKER_DIR,
  resume: RESUME_DIR,
  root: PROJECT_ROOT,
  analyst: ANALYST_DIR,
  analystMcp: ANALYST_MCP_DIR
};

// --- IPC: list *_roster.json files for the analyst roster dropdown (legacy, unused
// by the connector-backed button below, kept for reference/back-compat) ---
ipcMain.handle('list-rosters', () => {
  try {
    if (!fs.existsSync(DATA_DIR)) return [];
    return fs.readdirSync(DATA_DIR)
      .filter(f => /_roster\.json$/i.test(f))
      .sort();
  } catch (_) {
    return [];
  }
});

// --- IPC: list all 13 tracker tabs from the analyst engine's tab registry — this is
// the single source of truth shared with the tracker-analyst MCP server, so the panel
// and Claude always agree on what a "tab" means. ---
ipcMain.handle('list-tabs', () => {
  try {
    const tabRegistry = require(path.join(ANALYST_DIR, 'lib', 'tab-registry.js'));
    return tabRegistry.list();
  } catch (e) {
    return [];
  }
});

// --- IPC: run a command, streaming stdout/stderr back to the renderer ---
// payload: { runId, cwdToken, command, env? }  (command is a full shell command string;
// env is a flat {KEY: 'value'} object merged over process.env — used e.g. for
// ANALYST_HEADED=1 to pop a visible Playwright browser window during a sweep)
ipcMain.handle('run-command', async (event, payload) => {
  const { runId, cwdToken, command, env } = payload || {};
  const sender = event.sender;

  if (running) {
    sender.send('run-output', { runId, stream: 'stderr', chunk: 'A command is already running. Wait for it to finish.\n' });
    sender.send('run-exit', { runId, code: -1, error: 'busy' });
    return { started: false, reason: 'busy' };
  }

  const cwd = CWD_MAP[cwdToken];
  if (!cwd) {
    sender.send('run-exit', { runId, code: -1, error: 'bad-cwd' });
    return { started: false, reason: 'bad-cwd' };
  }
  if (!fs.existsSync(cwd)) {
    sender.send('run-output', { runId, stream: 'stderr', chunk: `Working directory does not exist:\n  ${cwd}\n` });
    sender.send('run-exit', { runId, code: -1, error: 'no-cwd' });
    return { started: false, reason: 'no-cwd' };
  }
  if (typeof command !== 'string' || !command.trim()) {
    sender.send('run-exit', { runId, code: -1, error: 'empty-command' });
    return { started: false, reason: 'empty-command' };
  }

  running = true;
  sender.send('run-output', { runId, stream: 'meta', chunk: `$ ${command}\n(cwd: ${cwd})\n\n` });

  // shell: true on Windows lets us run node/python/wrangler/curl exactly as typed on PATH.
  child = spawn(command, {
    cwd,
    shell: true,
    windowsHide: true,
    env: env && typeof env === 'object' ? { ...process.env, ...env } : process.env
  });

  child.stdout.on('data', d => sender.send('run-output', { runId, stream: 'stdout', chunk: d.toString() }));
  child.stderr.on('data', d => sender.send('run-output', { runId, stream: 'stderr', chunk: d.toString() }));

  child.on('error', err => {
    sender.send('run-output', { runId, stream: 'stderr', chunk: `\n[spawn error] ${err.message}\n` });
  });

  child.on('close', code => {
    running = false;
    child = null;
    sender.send('run-exit', { runId, code });
  });

  return { started: true };
});

// --- IPC: kill the currently running command ---
ipcMain.handle('kill-command', () => {
  if (child) {
    try { child.kill(); return { killed: true }; } catch (_) { return { killed: false }; }
  }
  return { killed: false };
});

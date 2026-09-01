// renderer.js — UI logic for the Tracker Runner. All process work happens in main;
// this file only renders the plan, streams console output, and flips button states.

const consoleEl = document.getElementById('console');
const stepsList = document.getElementById('stepsList');
const startBtn = document.getElementById('startBtn');
const dedupBtn = document.getElementById('dedupBtn');
const stopBtn = document.getElementById('stopBtn');
const cadenceSelect = document.getElementById('cadenceSelect');
const saveScheduleBtn = document.getElementById('saveScheduleBtn');
const scheduleStatus = document.getElementById('scheduleStatus');
const clearBtn = document.getElementById('clearBtn');
const statusBar = document.getElementById('statusBar');
const modeHint = document.getElementById('modeHint');
const smokeCheck = document.getElementById('smokeCheck');
const progressFill = document.getElementById('progressFill');
const progressLabel = document.getElementById('progressLabel');
const modeBtns = [...document.querySelectorAll('#modeToggle .mode-btn')];
const brainBtns = [...document.querySelectorAll('#brainToggle .mode-btn')];
const concurrencySelect = document.getElementById('concurrencySelect');
const themeBtns = [...document.querySelectorAll('#themeToggle .mode-btn')];

// --- Theme (Light/Dark toggle) ---
// CSS already falls back to the OS preference via @media(prefers-color-scheme), so the
// very first paint is never "wrong" — this only overrides it once a choice is known,
// via :root[data-theme] rules that win over the media query in either direction.
function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  themeBtns.forEach(b => b.classList.toggle('active', b.dataset.theme === theme));
  try { localStorage.setItem('trackerRunnerTheme', theme); } catch (_) { /* storage unavailable — theme just won't persist */ }
}
themeBtns.forEach(b => b.addEventListener('click', () => applyTheme(b.dataset.theme)));
(function initTheme() {
  let saved = null;
  try { saved = localStorage.getItem('trackerRunnerTheme'); } catch (_) { /* ignore */ }
  const theme = (saved === 'light' || saved === 'dark')
    ? saved
    : (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  applyTheme(theme);
})();
const resolvedToggle = document.getElementById('resolvedToggle');
const resolvedPopup = document.getElementById('resolvedPopup');
const resolvedBody = document.getElementById('resolvedBody');
const resolvedClose = document.getElementById('resolvedClose');
let resolvedReport = null;
const calendarToggle = document.getElementById('calendarToggle');
const calendarPopup = document.getElementById('calendarPopup');
const calendarBody = document.getElementById('calendarBody');
const calendarClose = document.getElementById('calendarClose');
const historyPanel = document.getElementById('historyPanel');
const historyEmptyState = document.getElementById('historyEmptyState');
const historyViewSlot = document.getElementById('historyViewSlot');
let historyDates = [];
let selectedHistoryDate = null;

let mode = 'long';
let brain = 'nim';
let concurrency = null; // set once get-info's recommendedConcurrency arrives at boot
let running = false;

let runStartTime = null;
let latestPercent = 0;
let progressTimer = null;

function formatElapsed(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const mm = String(Math.floor(total / 60)).padStart(2, '0');
  const ss = String(total % 60).padStart(2, '0');
  return `${mm}:${ss}`;
}
function renderProgress() {
  const elapsed = runStartTime ? Date.now() - runStartTime : 0;
  progressFill.style.width = `${Math.round(latestPercent * 100)}%`;
  progressLabel.textContent = `${formatElapsed(elapsed)} · ${Math.round(latestPercent * 100)}%`;
}
function startProgressTimer() {
  stopProgressTimer();
  progressTimer = setInterval(renderProgress, 1000);
}
function stopProgressTimer() {
  if (progressTimer) { clearInterval(progressTimer); progressTimer = null; }
}

const HINTS = {
  long: '<b>Long:</b> every firm in every roster, browser fallback ON (slow, full coverage).',
  short: '<b>Short:</b> ATS-JSON boards only (--no-browse) — fast pass, lower coverage.',
};

function setMode(m) {
  if (running) return;
  mode = m;
  modeBtns.forEach(b => b.classList.toggle('active', b.dataset.mode === m));
  modeHint.innerHTML = HINTS[m];
  refreshPlan();
}
modeBtns.forEach(b => b.addEventListener('click', () => setMode(b.dataset.mode)));

brainBtns.forEach(b => b.addEventListener('click', () => {
  if (running) return;
  brain = b.dataset.brain;
  brainBtns.forEach(x => x.classList.toggle('active', x.dataset.brain === brain));
}));

concurrencySelect.addEventListener('change', () => {
  if (running) return;
  concurrency = parseInt(concurrencySelect.value, 10);
});

function runOpts() {
  const opts = { mode, brain, concurrency };
  if (smokeCheck.checked) { opts.smokeTab = 'environmental'; opts.limit = 2; opts.skipDeploy = true; }
  return opts;
}

const STATUS_ICON = {
  pending: '○', running: '◐', done: '✓', failed: '✗', stopped: '■', skipped: '–',
};

function renderSteps(labels) {
  stepsList.innerHTML = '';
  for (const label of labels) {
    const li = document.createElement('li');
    li.className = 'pending';
    li.innerHTML = `<span class="icon">${STATUS_ICON.pending}</span><span class="label"></span>`;
    li.querySelector('.label').textContent = label;
    stepsList.appendChild(li);
  }
}

async function refreshPlan() {
  const labels = await window.api.getPlan(runOpts());
  renderSteps(labels);
}
smokeCheck.addEventListener('change', () => { if (!running) refreshPlan(); });

// --- console streaming (batched appends so heavy output doesn't lock the UI) ---
let buf = '';
let flushTimer = null;
const MAX_CONSOLE = 400000; // chars kept in the pane
function appendConsole(chunk, stream) {
  buf += chunk;
  if (!flushTimer) flushTimer = setTimeout(() => {
    consoleEl.textContent += buf;
    buf = ''; flushTimer = null;
    if (consoleEl.textContent.length > MAX_CONSOLE) {
      consoleEl.textContent = consoleEl.textContent.slice(-MAX_CONSOLE);
    }
    consoleEl.scrollTop = consoleEl.scrollHeight;
  }, 80);
}

window.api.onOutput(({ chunk }) => appendConsole(chunk));

// A plan event only ever fires when a run actually starts (button OR autostart) —
// so it's the reliable place to flip the UI into its running state.
window.api.onPlan(({ steps, mode: runMode, brain: runBrain }) => {
  renderSteps(steps);
  running = true;
  startBtn.disabled = true;
  dedupBtn.disabled = true;
  stopBtn.disabled = false;
  modeBtns.forEach(b => { b.disabled = true; b.classList.toggle('active', b.dataset.mode === runMode); });
  brainBtns.forEach(b => { b.disabled = true; if (runBrain) b.classList.toggle('active', b.dataset.brain === runBrain); });
  concurrencySelect.disabled = true;
  smokeCheck.disabled = true;
  resolvedReport = null;
  resolvedToggle.disabled = true;
  statusBar.className = '';
  statusBar.textContent = 'Running…';
  runStartTime = Date.now();
  latestPercent = 0;
  startProgressTimer();
  renderProgress();
});

window.api.onStepStatus(({ index, status, percent }) => {
  const li = stepsList.children[index];
  if (li) {
    li.className = status;
    li.querySelector('.icon').textContent = STATUS_ICON[status] || '○';
    if (status === 'running') {
      statusBar.textContent = `Running: ${li.querySelector('.label').textContent}`;
      li.scrollIntoView({ block: 'nearest' });
    }
  }
  if (typeof percent === 'number') { latestPercent = percent; renderProgress(); }
});

window.api.onDone(({ ok, aborted, failures, resolved }) => {
  running = false;
  startBtn.disabled = false;
  dedupBtn.disabled = false;
  stopBtn.disabled = true;
  modeBtns.forEach(b => b.disabled = false);
  brainBtns.forEach(b => b.disabled = false);
  concurrencySelect.disabled = false;
  smokeCheck.disabled = false;
  resolvedReport = resolved || {};
  resolvedToggle.disabled = false;
  statusBar.textContent = aborted ? 'Stopped by user.'
    : ok ? 'Run complete — deployed ✓'
    : `Finished with ${failures.length} failed step(s) — see console.`;
  statusBar.className = aborted ? 'warn' : ok ? 'ok' : 'err';
  stopProgressTimer();
  latestPercent = aborted ? latestPercent : (ok ? 1 : latestPercent);
  renderProgress();
  refreshHistoryDates().catch(() => {});
});

startBtn.addEventListener('click', async () => {
  if (running) return;
  const { started, reason } = await window.api.startRun(runOpts());
  if (!started) { statusBar.textContent = `Could not start (${reason}).`; return; }
  running = true;
  startBtn.disabled = true;
  dedupBtn.disabled = true;
  stopBtn.disabled = false;
  modeBtns.forEach(b => b.disabled = true);
  smokeCheck.disabled = true;
  statusBar.className = '';
  statusBar.textContent = 'Running…';
});

dedupBtn.addEventListener('click', async () => {
  if (running) return;
  const { started, reason } = await window.api.startDedup();
  if (!started) { statusBar.textContent = `Could not start (${reason}).`; return; }
  running = true;
  startBtn.disabled = true;
  dedupBtn.disabled = true;
  stopBtn.disabled = false;
  statusBar.className = '';
  statusBar.textContent = 'Running…';
});

saveScheduleBtn.addEventListener('click', async () => {
  const cadenceHours = parseInt(cadenceSelect.value, 10);
  scheduleStatus.textContent = 'Saving…';
  const res = await window.api.saveSchedule(cadenceHours);
  scheduleStatus.textContent = res.ok ? 'Saved.' : `Failed: ${res.error}`;
});

stopBtn.addEventListener('click', () => window.api.stopRun());

clearBtn.addEventListener('click', () => { consoleEl.textContent = ''; });

// --- Console/Browser/History tabs ---
const panelTabs = [...document.querySelectorAll('.panel-tab')];
let browserVisible = false;

// --- Built-in debug browser (BrowserView, main-process-owned) ---
// Zero-token manual/visual escape hatch: inspect a career page the research
// pipeline choked on, check whether a board requires login, watch a redirect
// chain — all without leaving the app or spinning up a separate Playwright
// session. Persists cookies (partition="persist:debug-browser") so a manual
// login survives across runs.
//
// This panel has no real embedded content in the DOM — #browserViewSlot is
// just a layout placeholder. The actual page renders in a BrowserView owned
// by the main process, positioned to exactly cover this slot's rect. A
// ResizeObserver keeps that rect (and therefore the view) always correct,
// no matter what changes it — window resize, tab switch, DPI change, the
// sidebar, anything. The renderer never guesses; it measures and reports.
const browserSlot = document.getElementById('browserViewSlot');
const addressBar = document.getElementById('addressBar');
const navBack = document.getElementById('navBack');
const navFwd = document.getElementById('navFwd');
const navReload = document.getElementById('navReload');
const navGo = document.getElementById('navGo');
const navDevtools = document.getElementById('navDevtools');

function sendBrowserBounds() {
  if (!browserVisible) return;
  const r = browserSlot.getBoundingClientRect();
  window.api.browserSetBounds({
    x: Math.round(r.left), y: Math.round(r.top),
    width: Math.max(0, Math.round(r.width)), height: Math.max(0, Math.round(r.height)),
  });
}
new ResizeObserver(sendBrowserBounds).observe(browserSlot);
window.addEventListener('resize', sendBrowserBounds);

function normalizeUrl(input) {
  const v = input.trim();
  if (!v) return null;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(v)) return v;
  if (/^localhost(:\d+)?/i.test(v) || /^\d{1,3}(\.\d{1,3}){3}/.test(v)) return `http://${v}`;
  if (/^[^\s/]+\.[^\s/]{2,}([/?#].*)?$/.test(v)) return `https://${v}`;
  return `https://www.google.com/search?q=${encodeURIComponent(v)}`;
}

function navigateTo(input) {
  const url = normalizeUrl(input);
  if (!url) return;
  window.api.browserNavigate(url);
}

navGo.addEventListener('click', () => navigateTo(addressBar.value));
addressBar.addEventListener('keydown', (e) => { if (e.key === 'Enter') navigateTo(addressBar.value); });
navBack.addEventListener('click', () => window.api.browserBack());
navFwd.addEventListener('click', () => window.api.browserForward());
navReload.addEventListener('click', () => window.api.browserReload());
navDevtools.addEventListener('click', () => window.api.browserDevtools());

window.api.onBrowserNavState(({ url, canGoBack, canGoForward }) => {
  if (document.activeElement !== addressBar) addressBar.value = url;
  navBack.disabled = !canGoBack;
  navFwd.disabled = !canGoForward;
});

// --- History panel (calendar-selected snapshot, embedded BrowserView) ---
const panels = { console: document.getElementById('consolePanel'), browser: document.getElementById('browserPanel'), history: historyPanel };
let historyVisible = false;

function sendHistoryBounds() {
  if (!historyVisible) return;
  const r = historyViewSlot.getBoundingClientRect();
  window.api.historySetBounds({
    x: Math.round(r.left), y: Math.round(r.top),
    width: Math.max(0, Math.round(r.width)), height: Math.max(0, Math.round(r.height)),
  });
}
new ResizeObserver(sendHistoryBounds).observe(historyViewSlot);
window.addEventListener('resize', sendHistoryBounds);

// Computes whether the History empty-state hint should show, and with what
// message, given the current known state. Two distinct "empty" situations:
// no snapshots exist at all, vs. snapshots exist but none is selected yet.
function updateHistoryEmptyState() {
  if (!historyDates.length) {
    historyEmptyState.textContent = 'No past runs saved yet — run a refresh first.';
    historyEmptyState.classList.remove('hidden');
  } else if (!selectedHistoryDate) {
    historyEmptyState.textContent = 'Pick a date from History to view a past run.';
    historyEmptyState.classList.remove('hidden');
  } else {
    historyEmptyState.classList.add('hidden');
  }
}

function switchPanel(name) {
  panelTabs.forEach(x => x.classList.toggle('active', x.dataset.panel === name));
  Object.entries(panels).forEach(([n, el]) => el.classList.toggle('hidden', n !== name));
  browserVisible = name === 'browser';
  window.api.browserSetVisible(browserVisible);
  if (browserVisible) requestAnimationFrame(sendBrowserBounds);
  historyVisible = name === 'history';
  window.api.historySetVisible(historyVisible);
  if (historyVisible) {
    updateHistoryEmptyState();
    requestAnimationFrame(sendHistoryBounds);
  } else {
    historyEmptyState.classList.add('hidden');
  }
}
panelTabs.forEach(t => t.addEventListener('click', () => switchPanel(t.dataset.panel)));

function renderCalendar() {
  calendarBody.innerHTML = '';
  if (!historyDates.length) {
    calendarBody.innerHTML = '<div class="popup-empty">No past runs saved yet.</div>';
    return;
  }
  const grid = document.createElement('div');
  grid.className = 'calendar-grid';
  for (const date of historyDates) {
    const cell = document.createElement('div');
    cell.className = 'calendar-day has-snapshot' + (date === selectedHistoryDate ? ' selected' : '');
    cell.textContent = date.slice(5); // MM-DD
    cell.title = date;
    cell.addEventListener('click', () => selectHistoryDate(date));
    grid.appendChild(cell);
  }
  calendarBody.appendChild(grid);
}
async function refreshHistoryDates() {
  historyDates = await window.api.listHistoryDates();
}
async function selectHistoryDate(date) {
  selectedHistoryDate = date;
  await window.api.viewHistory(date);
  renderCalendar();
  calendarPopup.classList.add('hidden');
  switchPanel('history'); // re-checks the empty-state condition now that a date is selected
}
calendarToggle.addEventListener('click', async () => {
  await refreshHistoryDates();
  renderCalendar();
  calendarPopup.classList.toggle('hidden');
});
calendarClose.addEventListener('click', () => calendarPopup.classList.add('hidden'));

function renderResolvedPopup() {
  resolvedBody.innerHTML = '';
  const tabs = Object.keys(resolvedReport || {}).sort();
  if (!tabs.length) {
    resolvedBody.innerHTML = '<div class="popup-empty">No companies resolved yet.</div>';
    return;
  }
  for (const tab of tabs) {
    const group = document.createElement('div');
    group.className = 'tab-group';
    const h3 = document.createElement('h3');
    h3.textContent = `${tab} (${resolvedReport[tab].length})`;
    group.appendChild(h3);
    for (const { company, method, detail } of resolvedReport[tab]) {
      const row = document.createElement('div');
      row.className = 'company-row';
      row.innerHTML = `<span></span><span class="method"></span>`;
      row.children[0].textContent = `${company} — ${detail}`;
      row.children[1].textContent = method;
      group.appendChild(row);
    }
    resolvedBody.appendChild(group);
  }
}
resolvedToggle.addEventListener('click', () => {
  resolvedPopup.classList.toggle('hidden');
  if (!resolvedPopup.classList.contains('hidden')) renderResolvedPopup();
});
resolvedClose.addEventListener('click', () => resolvedPopup.classList.add('hidden'));

// --- boot ---
(async () => {
  const info = await window.api.getInfo();
  appendConsole(`Tracker Runner ready.\nProject root: ${info.projectRoot}\n`
    + `analyst engine: ${info.analystExists ? 'found ✓' : 'MISSING ✗'}\n`
    + `worker build:   ${info.workerExists ? 'found ✓' : 'MISSING ✗'}\n`
    + `web search:     ${info.searchProvider ? info.searchProvider + ' ✓ (search-first discovery ON)' : 'NO KEY — set TAVILY_API_KEY in OneDrive\\Documents\\.env for ~10x faster discovery'}\n`
    + `${info.tabCount} research tabs + merge + build + deploy\n\n`);
  concurrencySelect.innerHTML = '';
  for (let n = 1; n <= info.tabCount; n++) {
    const opt = document.createElement('option');
    opt.value = String(n);
    opt.textContent = n === info.tabCount
      ? `${n} (all at once)`
      : n === info.recommendedConcurrency
        ? `${n} (Recommended)`
        : String(n);
    concurrencySelect.appendChild(opt);
  }
  concurrency = info.recommendedConcurrency || info.tabCount;
  concurrencySelect.value = String(concurrency);
  if (!info.analystExists || !info.workerExists) {
    statusBar.textContent = 'Missing project components — check the console.';
    statusBar.className = 'err';
    startBtn.disabled = true;
    dedupBtn.disabled = true;
  }
  refreshPlan();
  await refreshHistoryDates();
  // No date can be selected yet at boot, so the only relevant check here is
  // whether any snapshots exist at all.
  historyEmptyState.classList.toggle('hidden', historyDates.length > 0);
})();

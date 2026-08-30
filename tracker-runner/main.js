// main.js — Electron main process for the Tracker Runner.
// One button runs the WHOLE refresh: every tracker tab is researched by the analyst
// engine (deterministic ATS-board resolution + careers-page browse for free, NIM as
// the brain on the ambiguous pile — zero Claude/Anthropic tokens), split tabs are
// merged, the data bundle is rebuilt, and the Worker is deployed via wrangler.
//
// Long vs short (the toggle):
//   long  — full coverage: every firm in every roster, Playwright browser fallback ON.
//   short — fast pass: ATS-JSON only (--no-browse), same rosters, no browser step.
//
// All model judgment is NIM (--brain nim, NVIDIA key from OneDrive\Documents\.env via
// lib/nimbrain.js). No Anthropic key needed, no per-token bill.

const { app, BrowserWindow, BrowserView, ipcMain, shell } = require('electron');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const timing = require('./lib/timing.js');
const { parseResolvedLine } = require('./lib/resolvedParser.js');
const { dedupCategories } = require('./lib/dedup.js');
const history = require('./lib/history.js');
const historyServer = require('./lib/historyServer.js');
const htmlLoader = require('./lib/htmlLoader.js');
const schedule = require('./lib/schedule.js');
const { startRunLog } = require('./lib/runLog.js');
const TIMINGS_PATH = path.join(__dirname, 'history', 'step-timings.json');
const HISTORY_DIR = path.join(__dirname, 'history');

// Resolve the project root the same way the control panel does: dev (`npm start`)
// puts this dir directly under the root; packaged walks up from the exe;
// TRACKER_ROOT overrides everything.
function resolveProjectRoot() {
  const hasProject = (dir) => {
    try {
      return !!dir
        && fs.existsSync(path.join(dir, 'cloudflare-worker'))
        && fs.existsSync(path.join(dir, 'analyst'));
    } catch (_) { return false; }
  };
  if (hasProject(process.env.TRACKER_ROOT)) return process.env.TRACKER_ROOT;
  const devGuess = path.resolve(__dirname, '..');
  if (hasProject(devGuess)) return devGuess;
  const walkUp = (start) => {
    let dir = start;
    for (let i = 0; i < 8; i++) {
      if (hasProject(dir)) return dir;
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    return null;
  };
  // Portable builds unpack to a %TEMP% dir at launch — process.execPath points
  // there, not to where the user keeps the exe. electron-builder's portable
  // target exports PORTABLE_EXECUTABLE_DIR with the real, stable location.
  if (process.env.PORTABLE_EXECUTABLE_DIR) {
    const found = walkUp(process.env.PORTABLE_EXECUTABLE_DIR);
    if (found) return found;
  }
  return walkUp(path.dirname(process.execPath)) || devGuess;
}

const PROJECT_ROOT = resolveProjectRoot();
const ANALYST_DIR = path.join(PROJECT_ROOT, 'analyst');
const WORKER_DIR = path.join(PROJECT_ROOT, 'cloudflare-worker');
const DATA_DIR = path.join(PROJECT_ROOT, 'data');
const SCHEDULE_CONFIG_PATH = path.join(DATA_DIR, '_schedule_config.json');
// __dirname resolves INSIDE app.asar in a packaged build — read-only, so fs.mkdirSync
// there throws ENOTDIR. PROJECT_ROOT is the real on-disk project checkout (resolved
// above even in a portable build via PORTABLE_EXECUTABLE_DIR), so logs land next to
// the actual source tree instead of inside the packed app.
const LOGS_DIR = path.join(PROJECT_ROOT, 'tracker-runner', 'logs');
let currentRunLog = null; // safety-net handle so a thrown-before-completion pipeline still gets its log closed
const LIVE_DATA_URL = 'https://internship-tracker.jz-tracker.workers.dev/api/data';

// Single source of truth for what a "tab" means — shared with the analyst CLI and
// the tracker-analyst MCP server so none of the three ever drift.
const tabRegistry = require(path.join(ANALYST_DIR, 'lib', 'tab-registry.js'));

// ---------------------------------------------------------------------------
// Plan building
// ---------------------------------------------------------------------------

// ALL research tabs launch SIMULTANEOUSLY (user's call: maximum wall-clock speed),
// with a hard barrier before merge/build/deploy. Each tab is its own node process;
// per-tab NIM/search concurrency is throttled to 1 via env so the global request
// rate (15 tabs × 1) stays civilised, and the caches merge-on-save so concurrent
// writes never clobber. Known cost: the 6 whole-roster tabs can't share in-flight
// search results, so an UNCACHED firm they all touch may be searched up to 6× —
// a one-time Tavily-quota hit (30-day cache absorbs it on every later run).
const TAB_ORDER = [
  'agent1', 'agent2', 'agent3', 'agent4', 'agent5',
  'libraries', 'environmental', 'realestate', 'ithaca',
  'sophomore', 'fall2026', 'spring2027', 'fellowships', 'china_hk', 'discovery',
];

// Maps each dedupable category to the results file build-data.js reads. Mirrors
// lib/dedup.js's CATEGORY_ORDER (minus spring2027, which merges into fall2026
// before this ever runs).
const CATEGORY_FILES = {
  agent1: 'agent1_results.json', agent2: 'agent2_results.json', agent3: 'agent3_results.json',
  agent4: 'agent4_results.json', agent5: 'agent5_results.json',
  sophomore: 'sophomore_results.json', fall2026: 'fall2026_results.json',
  libraries: 'libraries_results.json', environmental: 'environmental_results.json',
  realestate: 'realestate_results.json', fellowships: 'fellowships_results.json',
  china_hk: 'china_hk_results.json', ithaca: 'ithaca_results.json',
};

function loadCategoryFiles(dataDir) {
  const out = {};
  for (const [id, filename] of Object.entries(CATEGORY_FILES)) {
    const p = path.join(dataDir, filename);
    if (!fs.existsSync(p)) continue;
    try { out[id] = JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_) { /* skip unreadable */ }
  }
  return out;
}

function writeCategoryFiles(dataDir, cleaned, removals) {
  const touched = new Set(removals.map((r) => r.from));
  for (const id of touched) {
    const filename = CATEGORY_FILES[id];
    if (filename && cleaned[id]) {
      fs.writeFileSync(path.join(dataDir, filename), JSON.stringify(cleaned[id], null, 2));
    }
  }
}
// Split the old per-tab budgets across simultaneously-running tabs.
// ANALYST_BROWSE_CONC stays at 1 here (not 2+): 14 tabs already run simultaneously in
// this mode, each a full Node process; stacking more concurrent Playwright/Chromium
// sessions PER TAB on top of that multiplies system-wide browser count and burns RAM
// (measured live 2026-08-06: 14 parallel tabs + browse-conc 2 → ~190 chrome.exe procs,
// <1GB RAM free on a 16GB box — the machine thrashes and the run gets SLOWER, not
// faster). Sequential mode (one tab at a time) has the headroom for real browse
// concurrency instead.
const PARALLEL_ENV = { ANALYST_NIM_CONC: '1', ANALYST_SEARCH_CONC: '1', ANALYST_BROWSE_CONC: '1' };

// opts: { mode: 'long'|'short', limit?: number, smokeTab?: string, skipDeploy?: boolean }
function buildPlan(opts) {
  const mode = opts.mode === 'short' ? 'short' : 'long';
  const steps = [];
  const tabs = opts.dedupOnly ? [] : (opts.smokeTab ? [opts.smokeTab] : TAB_ORDER);

  // Sequential ("one at a time") trades wall-clock speed for a much lighter
  // machine load: only one tab's Node process (+ its Playwright session) is ever
  // alive at once, so each one can safely use the old single-tab budgets instead
  // of the parallel-mode throttled-down ones.
  const seqEnv = { ANALYST_NIM_CONC: '4', ANALYST_SEARCH_CONC: '4', ANALYST_BROWSE_CONC: '4' };
  const tabEnv = opts.sequential ? seqEnv : PARALLEL_ENV;
  const tabConcurrency = opts.sequential ? '8' : '3';

  for (const tabId of tabs) {
    const cfg = tabRegistry.get(tabId);
    // Brain: NIM by default (zero-cost, real AI). heuristic = zero AI calls at
    // all, deterministic rules only (fastest, cruder on the ambiguous tail). The
    // UI toggle (opts.brain) or the RUNNER_BRAIN env var (autostart/scheduled
    // runs) can swap in the local `claude` CLI — subscription auth, best
    // judgment, still heuristic-triaged so volume stays small.
    const brain = opts.brain === 'claude-cli' || opts.brain === 'heuristic'
      ? opts.brain
      : (!opts.brain && process.env.RUNNER_BRAIN === 'claude-cli') ? 'claude-cli' : 'nim';
    const args = [
      'run-analyst.js',
      '--roster', cfg.rosterPath,
      '--agent-name', cfg.agentName,
      '--brain', brain,
    ];
    if (cfg.agentKey) args.push('--agent-key', cfg.agentKey);
    if (cfg.allAgents) args.push('--all-agents');
    if (cfg.tab) args.push('--tab', cfg.tab);
    if (cfg.term) args.push('--term', cfg.term);
    if (mode === 'short') args.push('--no-browse');
    if (opts.limit) args.push('--limit', String(opts.limit));
    args.push('--concurrency', tabConcurrency);
    steps.push({
      label: `Research — ${cfg.label}`,
      kind: 'cmd', cmd: 'node', args, cwd: ANALYST_DIR, shell: false,
      wave: 1, tag: tabId, env: tabEnv, key: tabId,
    });
  }

  if (!opts.smokeTab && !opts.dedupOnly) {
    steps.push({ label: 'Merge — Fall 2026 + Spring 2027 → fall2026', kind: 'merge-fall2026', key: 'merge' });
  }
  if (opts.dedupOnly) {
    steps.push({ label: 'Remove cross-category duplicates', kind: 'dedup', key: 'dedup' });
  }

  if (!opts.skipDeploy) {
    steps.push({
      label: 'Fetch live data baseline (for changelog diff)',
      kind: 'cmd', cmd: 'curl',
      args: ['-s', LIVE_DATA_URL, '-o', path.join(WORKER_DIR, 'src', 'data.json')],
      cwd: WORKER_DIR, shell: false, key: 'fetch-baseline',
    });
    steps.push({
      label: 'Rebuild data bundle (build-data.js)',
      kind: 'cmd', cmd: 'node', args: ['build-data.js'], cwd: WORKER_DIR, shell: false, key: 'build',
    });
    steps.push({
      label: 'Deploy Worker (wrangler deploy)',
      // wrangler is a .cmd shim on Windows — needs shell:true to resolve on PATH.
      kind: 'cmd', cmd: 'wrangler deploy', args: null, cwd: WORKER_DIR, shell: true, key: 'deploy',
    });
  }

  return steps;
}

// The fall2026 tab ships as ONE results file; its fall + spring terms are researched
// as SEPARATE agent runs over the same company roster. Both runs frequently discover
// the exact same posting (a generic off-cycle listing isn't tied to one term), and each
// stamps its own copy with whichever term it ran as — deduping on company::program::term
// (the old key) let both copies survive as if they were different postings. `term` is
// stored per-entry but never actually read by the frontend (cloudflare-worker/src/index.js
// only shows one combined "Fall 2026 / Spring 2027" tab label, never per-card), so there's
// no UX reason to keep both — dedupe on company::program alone, first-seen wins.
function mergeFall2026(log) {
  const sources = ['fall2026_fall', 'fall2026_spring'];
  const seen = new Set();
  const internships = [];
  let meta = { name: 'Fall 2026 / Spring 2027', focus: '' };
  for (const a of sources) {
    const p = path.join(DATA_DIR, `${a}_results.json`);
    if (!fs.existsSync(p)) { log(`  (missing ${a}_results.json — skipping)\n`); continue; }
    let d;
    try { d = JSON.parse(fs.readFileSync(p, 'utf8')); }
    catch (e) { log(`  (unreadable ${a}_results.json: ${e.message} — skipping)\n`); continue; }
    if (d.name) meta.name = d.name;
    if (d.focus && !meta.focus) meta.focus = d.focus;
    let dupes = 0;
    for (const e of d.internships || []) {
      const k = `${(e.company || '').toLowerCase()}::${(e.program || '').toLowerCase()}`;
      if (seen.has(k)) { dupes++; continue; }
      seen.add(k);
      internships.push(e);
    }
    log(`  + ${a}: ${(d.internships || []).length} entries${dupes ? ` (${dupes} already seen under the other term — skipped)` : ''}\n`);
  }
  const out = path.join(DATA_DIR, 'fall2026_results.json');
  fs.writeFileSync(out, JSON.stringify({
    agent: 'fall2026', name: meta.name, focus: meta.focus,
    last_updated: new Date().toISOString().slice(0, 10), internships,
  }, null, 2));
  log(`  → ${internships.length} merged entries → fall2026_results.json\n`);
}

// ---------------------------------------------------------------------------
// Run engine — sequential, streaming, stoppable
// ---------------------------------------------------------------------------

let running = false;
let aborted = false;
const children = new Set();
let resolvedThisRun = [];

// Prefix every line of a chunk with the step's tag so interleaved parallel output
// stays readable ("[agent3] ✓ ATS ...").
function tagChunk(tag, chunk) {
  if (!tag) return chunk;
  return chunk.replace(/^(?=.)/gm, `[${tag}] `);
}

function runStep(step, sender) {
  return new Promise((resolve) => {
    const env = step.env ? { ...process.env, ...step.env } : process.env;
    const child = step.shell
      ? spawn(step.cmd, { cwd: step.cwd, shell: true, windowsHide: true, env })
      : spawn(step.cmd, step.args, { cwd: step.cwd, windowsHide: true, env });
    children.add(child);
    const handleData = (stream) => (d) => {
      const tagged = tagChunk(step.tag, d.toString());
      sender.send('run-output', { stream, chunk: tagged });
      if (step.tag) {
        for (const line of tagged.split('\n')) {
          const parsed = parseResolvedLine(line);
          if (parsed) resolvedThisRun.push(parsed);
        }
      }
    };
    child.stdout.on('data', handleData('stdout'));
    child.stderr.on('data', handleData('stderr'));
    child.on('error', err => {
      sender.send('run-output', { stream: 'stderr', chunk: `\n[spawn error] ${err.message}\n` });
    });
    child.on('close', code => { children.delete(child); resolve(code); });
  });
}

// Tiny promise-pool for wave execution (same shape as the engine's limiter).
function limiter(n) {
  let active = 0;
  const queue = [];
  const next = () => {
    if (active >= n || !queue.length) return;
    active++;
    const { fn, resolve } = queue.shift();
    fn().then(resolve, resolve).finally(() => { active--; next(); });
  };
  return (fn) => new Promise((resolve) => { queue.push({ fn, resolve }); next(); });
}

function groupResolved(list) {
  const byTab = {};
  for (const r of list) {
    (byTab[r.tab] = byTab[r.tab] || []).push({ company: r.company, method: r.method, detail: r.detail });
  }
  return byTab;
}

async function runPipeline(opts, sender) {
  const steps = buildPlan(opts);
  resolvedThisRun = [];
  const timingsSnapshot = timing.loadTimings(TIMINGS_PATH);
  const stepStatuses = steps.map(() => 'pending');
  const stepStartedAt = {};
  const observations = [];
  function sendStepStatus(index, status, extra) {
    stepStatuses[index] = status;
    if (status === 'running') stepStartedAt[index] = Date.now();
    else if ((status === 'done' || status === 'failed') && stepStartedAt[index]) {
      observations.push({ key: steps[index].key, ms: Date.now() - stepStartedAt[index] });
    }
    const percent = timing.computeProgress(
      steps.map((s, i) => ({ key: s.key, status: stepStatuses[i] })),
      timingsSnapshot,
    );
    sender.send('step-status', { index, status, percent, ...(extra || {}) });
  }
  aborted = false;
  sender.send('plan', { steps: steps.map(s => s.label), mode: opts.mode, brain: opts.brain || (process.env.RUNNER_BRAIN === 'claude-cli' ? 'claude-cli' : 'nim'), sequential: !!opts.sequential, smoke: !!opts.smokeTab });
  const runLog = startRunLog(LOGS_DIR);
  currentRunLog = runLog;
  const log = (chunk, stream) => {
    sender.send('run-output', { stream: stream || 'meta', chunk });
    runLog.write(chunk);
  };

  log(`=== Tracker refresh — ${opts.mode.toUpperCase()} mode${opts.smokeTab ? ` (SMOKE TEST: ${opts.smokeTab}, no deploy)` : ''} ===\n`);
  const resolvedBrain = opts.brain === 'claude-cli' || opts.brain === 'heuristic'
    ? opts.brain
    : (!opts.brain && process.env.RUNNER_BRAIN === 'claude-cli') ? 'claude-cli' : 'nim';
  const brainLabel = {
    'claude-cli': 'Claude CLI (subscription quota) — heuristic-triaged, ambiguous tail only',
    'heuristic': 'Heuristic only — zero AI calls, rules only',
    'nim': 'NIM (free, NVIDIA key) — no Claude tokens',
  }[resolvedBrain];
  log(`Project root: ${PROJECT_ROOT}\nBrain: ${brainLabel}\nResearch: ${opts.sequential ? 'one tab at a time (light load)' : 'all tabs in parallel (fast, heavier load)'}\n\n`);

  let ok = true;
  let bail = false;
  const failures = [];

  // One research step, parallel-safe (statuses/logs keyed by index).
  const execResearch = async (step, i) => {
    if (aborted) { sendStepStatus(i, 'skipped'); return; }
    sendStepStatus(i, 'running');
    log(`\n━━━ [${i + 1}/${steps.length}] ${step.label} ━━━\n`);
    const code = await runStep(step, sender);
    if (aborted) { sendStepStatus(i, 'stopped'); ok = false; return; }
    if (code === 0) { sendStepStatus(i, 'done'); }
    else {
      sendStepStatus(i, 'failed', { code });
      failures.push(step.label);
      log(`\n✗ ${step.label} failed (exit ${code}) — its previous results file survives.\n`, 'stderr');
      ok = false;
    }
  };

  // Parallel: ALL research tabs at once, Promise.all as the barrier — fastest
  // wall-clock, heaviest machine load. Sequential: one tab at a time — a plain
  // for-loop, much lighter, slower overall. Either way nothing below starts
  // until every research process has exited (done, failed, or stopped).
  const research = steps.map((s, i) => ({ s, i })).filter(({ s }) => s.wave);
  if (research.length && !aborted) {
    if (opts.sequential) {
      if (research.length > 1) log(`\n═══ Running ${research.length} research tabs one at a time ═══\n`);
      for (const { s, i } of research) {
        if (aborted) break;
        await execResearch(s, i);
      }
    } else {
      if (research.length > 1) log(`\n═══ Launching all ${research.length} research tabs simultaneously ═══\n`);
      await Promise.all(research.map(({ s, i }) => execResearch(s, i)));
    }
    if (!aborted) log(`\n═══ All research complete — moving to merge/build/deploy ═══\n`);
  }

  // Finalization steps (merge → fetch → build → deploy), strictly sequential.
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    if (step.wave) continue; // research already ran above
    if (aborted || bail) { sendStepStatus(i, 'skipped'); continue; }
    sendStepStatus(i, 'running');
    log(`\n━━━ [${i + 1}/${steps.length}] ${step.label} ━━━\n`);

    if (step.kind === 'merge-fall2026') {
      try { mergeFall2026(log); sendStepStatus(i, 'done'); }
      catch (e) {
        log(`  merge failed: ${e.message}\n`, 'stderr');
        sendStepStatus(i, 'failed');
        failures.push(step.label); ok = false;
      }
      continue;
    }

    if (step.kind === 'dedup') {
      try {
        const categories = loadCategoryFiles(DATA_DIR);
        const { cleaned, removals } = dedupCategories(categories);
        for (const r of removals) {
          log(`  - removed ${r.company} / ${r.program} from ${r.from} (kept in ${r.keptIn})\n`);
        }
        log(`  → ${removals.length} duplicate(s) removed\n`);
        writeCategoryFiles(DATA_DIR, cleaned, removals);
        sendStepStatus(i, 'done');
      } catch (e) {
        log(`  dedup failed: ${e.message}\n`, 'stderr');
        sendStepStatus(i, 'failed');
        failures.push(step.label); ok = false;
      }
      continue;
    }

    log(`$ ${step.shell ? step.cmd : [step.cmd, ...step.args].join(' ')}\n(cwd: ${step.cwd})\n`);
    const code = await runStep(step, sender);
    if (aborted) {
      sendStepStatus(i, 'stopped');
      log(`\n■ Stopped by user during "${step.label}".\n`, 'stderr');
      ok = false;
      continue;
    }
    if (code === 0) {
      sendStepStatus(i, 'done');
    } else {
      sendStepStatus(i, 'failed', { code });
      failures.push(step.label);
      log(`\n✗ Step failed (exit ${code}).`, 'stderr');
      // A failed BUILD must block the deploy that follows it.
      if (step.label.startsWith('Rebuild')) {
        log(' Build failed — skipping deploy.\n', 'stderr');
        bail = true;
      }
      ok = false;
    }
  }

  log(`\n=== Run ${aborted ? 'STOPPED' : ok ? 'COMPLETE ✓' : 'finished with failures'} ===\n`);
  if (failures.length) log(`Failed steps:\n${failures.map(f => `  ✗ ${f}`).join('\n')}\n`, 'stderr');
  const updatedTimings = timing.updateTimings(timingsSnapshot, observations);
  timing.saveTimings(TIMINGS_PATH, updatedTimings);
  sender.send('run-done', { ok, aborted, failures, resolved: groupResolved(resolvedThisRun) });

  if (ok && !aborted && !opts.smokeTab) {
    try {
      const builtDataPath = path.join(WORKER_DIR, 'src', 'data.json');
      if (fs.existsSync(builtDataPath)) {
        history.writeSnapshot(HISTORY_DIR, history.dateStr(new Date()), fs.readFileSync(builtDataPath, 'utf8'));
        log(`  → snapshotted today's results for the History calendar\n`);
      }
    } catch (e) {
      log(`  (history snapshot failed: ${e.message})\n`, 'stderr');
    }
  }
  running = false;
  await runLog.close();
  currentRunLog = null;
}

// ---------------------------------------------------------------------------
// Window + IPC
// ---------------------------------------------------------------------------

function createWindow() {
  const win = new BrowserWindow({
    width: 1180, height: 860, minWidth: 900, minHeight: 620,
    title: 'Tracker Runner',
    backgroundColor: '#0d1117',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: false,
    },
  });
  win.setMenuBarVisibility(false);
  win.loadFile(path.join(__dirname, 'index.html'));
  createDebugView(win);
  createHistoryView(win);
  return win;
}

// ---------------------------------------------------------------------------
// Debug browser — a real, embedded Chromium for looking at career pages the
// research pipeline choked on, checking whether a board needs login, etc.
// Built on BrowserView rather than <webview>: bounds are set explicitly in
// device-independent pixels from the main process instead of relying on
// flexbox to size a guest frame correctly (the <webview> tag is notorious for
// getting this wrong, especially right after being un-hidden). The renderer
// is the single source of truth for WHERE the view should sit — it measures
// its panel slot with a ResizeObserver and pushes fresh bounds on every
// change (window resize, tab switch, DPI change, anything) — so the view can
// never silently drift out of sync with the layout ("always aware").
let debugView = null;
let historyView = null;
let historyServerHandle = null;
let historyServerPort = null;
let currentHistoryDate = null;
function createDebugView(win) {
  debugView = new BrowserView({
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      partition: 'persist:debug-browser',
    },
  });
  win.addBrowserView(debugView);
  // Hidden (zero-size) until the renderer's Browser tab is active and reports
  // real bounds — BrowserView paints ON TOP of the page regardless of the
  // underlying DOM, so CSS visibility alone can't hide it.
  debugView.setBounds({ x: 0, y: 0, width: 0, height: 0 });
  debugView.setAutoResize({ width: false, height: false });
  debugView.webContents.loadURL('about:blank');
  // Send target="_blank"/popup links to the real OS browser instead of
  // spawning uncontrolled Electron windows.
  debugView.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });

  const sendNavState = () => {
    if (!win.isDestroyed()) {
      win.webContents.send('browser-nav-state', {
        url: debugView.webContents.getURL(),
        canGoBack: debugView.webContents.canGoBack(),
        canGoForward: debugView.webContents.canGoForward(),
        loading: debugView.webContents.isLoading(),
      });
    }
  };
  ['did-navigate', 'did-navigate-in-page', 'did-start-loading', 'did-stop-loading', 'page-title-updated']
    .forEach(evt => debugView.webContents.on(evt, sendNavState));

  win.on('closed', () => { debugView = null; });
  return debugView;
}

// ---------------------------------------------------------------------------
// History browser — an analogous embedded Chromium that serves the real
// tracker dashboard HTML against whichever day's snapshot the user picked
// from the calendar, via lib/historyServer.js.
function createHistoryView(win) {
  historyView = new BrowserView({
    webPreferences: { contextIsolation: true, nodeIntegration: false, partition: 'persist:history-browser' },
  });
  win.addBrowserView(historyView);
  historyView.setBounds({ x: 0, y: 0, width: 0, height: 0 });
  historyView.setAutoResize({ width: false, height: false });
  historyView.webContents.loadURL('about:blank');
  historyView.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
  win.on('closed', () => { historyView = null; });
  return historyView;
}

app.whenReady().then(() => {
  const win = createWindow();
  // RUNNER_AUTOSTART=short|long starts the run as soon as the UI loads — lets a CLI
  // launch (or a scheduled task) kick off the whole pipeline without a button click.
  win.webContents.once('did-finish-load', () => {
    const m = process.env.RUNNER_AUTOSTART;
    if ((m === 'short' || m === 'long') && !running) {
      running = true;
      runPipeline({ mode: m }, win.webContents).catch((e) => {
        running = false;
        win.webContents.send('run-output', { stream: 'stderr', chunk: `\n[pipeline error] ${e.stack || e.message}\n` });
        win.webContents.send('run-done', { ok: false, aborted: false, failures: ['pipeline error'] });
      });
    }
  });
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => {
  for (const c of children) { try { c.kill(); } catch (_) {} }
  if (historyServerHandle) { try { historyServerHandle.close(); } catch (_) {} }
  if (process.platform !== 'darwin') app.quit();
});

ipcMain.handle('get-info', () => {
  let searchProvider = null;
  try { searchProvider = require(path.join(ANALYST_DIR, 'lib', 'search.js')).provider(); } catch (_) {}
  return {
    projectRoot: PROJECT_ROOT,
    analystExists: fs.existsSync(path.join(ANALYST_DIR, 'run-analyst.js')),
    workerExists: fs.existsSync(path.join(WORKER_DIR, 'build-data.js')),
    tabCount: TAB_ORDER.length,
    searchProvider,
  };
});

ipcMain.handle('get-plan', (_e, opts) => buildPlan(opts || { mode: 'long' }).map(s => s.label));

ipcMain.handle('start-run', (event, opts) => {
  if (running) return { started: false, reason: 'busy' };
  running = true;
  runPipeline(opts || { mode: 'long' }, event.sender)
    .catch(e => {
      running = false;
      if (currentRunLog) { currentRunLog.write(`\n[pipeline error] ${e.stack || e.message}\n`); currentRunLog.close(); currentRunLog = null; }
      event.sender.send('run-output', { stream: 'stderr', chunk: `\n[pipeline error] ${e.stack || e.message}\n` });
      event.sender.send('run-done', { ok: false, aborted: false, failures: ['pipeline error'] });
    });
  return { started: true };
});

ipcMain.handle('start-dedup', (event) => {
  if (running) return { started: false, reason: 'busy' };
  running = true;
  runPipeline({ mode: 'long', dedupOnly: true }, event.sender)
    .catch(e => {
      running = false;
      if (currentRunLog) { currentRunLog.write(`\n[pipeline error] ${e.stack || e.message}\n`); currentRunLog.close(); currentRunLog = null; }
      event.sender.send('run-output', { stream: 'stderr', chunk: `\n[pipeline error] ${e.stack || e.message}\n` });
      event.sender.send('run-done', { ok: false, aborted: false, failures: ['pipeline error'] });
    });
  return { started: true };
});

ipcMain.handle('save-schedule', async (_event, cadenceHours) => {
  if (!Number.isFinite(cadenceHours) || cadenceHours <= 0) {
    return { ok: false, error: 'invalid cadence' };
  }
  try {
    const config = schedule.loadConfig(SCHEDULE_CONFIG_PATH);
    config.cadenceHours = cadenceHours;
    schedule.saveConfig(SCHEDULE_CONFIG_PATH, config);
  } catch (e) {
    return { ok: false, error: `write failed: ${e.message}` };
  }
  const pushed = await new Promise((resolve) => {
    const child = spawn('git', ['add', 'data/_schedule_config.json'], { cwd: PROJECT_ROOT, stdio: 'inherit' });
    child.on('error', () => resolve(false));
    child.on('close', (code) => {
      if (code !== 0) return resolve(false);
      const commit = spawn('git', ['commit', '-m', 'Update refresh cadence'], { cwd: PROJECT_ROOT, stdio: 'inherit' });
      commit.on('error', () => resolve(false));
      commit.on('close', (commitCode) => {
        // exit 1 with nothing to commit (cadence unchanged) is not an error
        if (commitCode !== 0 && commitCode !== 1) return resolve(false);
        const push = spawn('git', ['push'], { cwd: PROJECT_ROOT, stdio: 'inherit' });
        push.on('error', () => resolve(false));
        push.on('close', (pushCode) => resolve(pushCode === 0));
      });
    });
  });
  return { ok: pushed, error: pushed ? undefined : 'git commit/push failed — see app console' };
});

ipcMain.handle('stop-run', () => {
  if (!running) return { stopped: false };
  aborted = true;
  for (const c of children) { try { c.kill(); } catch (_) {} }
  return { stopped: true };
});

// --- Debug browser (BrowserView) IPC ---
ipcMain.handle('browser-navigate', (_e, url) => { debugView?.webContents.loadURL(url); });
ipcMain.handle('browser-back', () => { if (debugView?.webContents.canGoBack()) debugView.webContents.goBack(); });
ipcMain.handle('browser-forward', () => { if (debugView?.webContents.canGoForward()) debugView.webContents.goForward(); });
ipcMain.handle('browser-reload', () => { debugView?.webContents.reload(); });
ipcMain.handle('browser-devtools', () => {
  const wc = debugView?.webContents;
  if (!wc) return;
  if (wc.isDevToolsOpened()) wc.closeDevTools(); else wc.openDevTools({ mode: 'detach' });
});
// bounds are DIPs measured by the renderer from its panel slot — main just
// applies them; it never computes layout itself.
ipcMain.handle('browser-set-bounds', (_e, bounds) => { debugView?.setBounds(bounds); });
ipcMain.handle('browser-set-visible', (_e, visible) => {
  if (!visible) debugView?.setBounds({ x: 0, y: 0, width: 0, height: 0 });
});

// --- History panel (calendar-selected snapshot, same BrowserView pattern) ---
ipcMain.handle('list-history-dates', () => history.listSnapshotDates(HISTORY_DIR));

ipcMain.handle('view-history', async (_e, date) => {
  currentHistoryDate = date;
  if (!historyServerHandle) {
    const dashboardHtmlFn = htmlLoader.loadDashboardHtml(path.join(WORKER_DIR, 'src', 'index.js'));
    const { server, port } = await historyServer.startHistoryServer(
      () => dashboardHtmlFn(),
      () => {
        try { return history.readSnapshot(HISTORY_DIR, currentHistoryDate); } catch (_) { return null; }
      },
    );
    historyServerHandle = server;
    historyServerPort = port;
  }
  const url = `http://127.0.0.1:${historyServerPort}/`;
  historyView?.webContents.loadURL(url);
  return { url };
});

ipcMain.handle('history-set-bounds', (_e, bounds) => { historyView?.setBounds(bounds); });
ipcMain.handle('history-set-visible', (_e, visible) => {
  if (!visible) historyView?.setBounds({ x: 0, y: 0, width: 0, height: 0 });
});

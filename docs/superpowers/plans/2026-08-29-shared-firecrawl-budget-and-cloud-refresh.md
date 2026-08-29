# Shared Firecrawl Budget + Cloud-Scheduled Refresh Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the per-tab Firecrawl call cap (which silently starves coverage in
parallel mode) with one shared daily budget, and add an unattended GitHub Actions
refresh so the pipeline runs on a schedule without the user's computer being on.

**Architecture:** A new file-locked counter (`analyst/lib/firecrawl-budget.js`) is
consulted by `scrape.js` before every Firecrawl call, shared across however many
`run-analyst.js` tab processes are running concurrently. `analyst/_full_refresh_driver.js`
(the existing headless CLI replica of the Electron app's full-refresh pipeline) gains a
`--parallel` mode sized to fit GitHub Actions' 6-hour job limit. A new workflow ticks
every 2 hours and defers to a small cadence-gate script (`analyst/lib/schedule.js` +
`analyst/check-schedule.js`) reading `data/_schedule_config.json`, so the user can change
how often it actually runs without touching the workflow file — including from a new
"Schedule" section added to the existing Tracker Runner Electron app.

**Tech Stack:** Node.js (CommonJS in `analyst/`, ESM in `cloudflare-worker/`), Electron
(`tracker-runner/`), `node:test` + `node:assert/strict` for unit tests, GitHub Actions,
Playwright (already a dependency of `analyst/`), Wrangler (Cloudflare Workers CLI).

## Global Constraints

- Firecrawl daily budget defaults to 450 (`FIRECRAWL_DAILY_BUDGET` env override), safely
  under the ~500/mo free-tier credit pool, per the design spec.
- GitHub Actions jobs on hosted runners hard-cap at 6 hours — the workflow's
  `timeout-minutes` must stay at or below 350 and `_full_refresh_driver.js --parallel`
  must be sized to finish within that window.
- `cloudflare-worker/build-data.js` uses ESM `import` syntax with no local
  `package.json` (relies on Node's stable module-auto-detection, available from Node 22
  onward) — CI must use Node 22 or newer, matching the local machine's Node 24.
- Follow existing test conventions exactly: `node:test` + `node:assert/strict`,
  colocated `<name>.test.js` files next to the source they test (see
  `tracker-runner/lib/dedup.test.js` for the house style).
- No new npm dependencies — every new module uses only Node built-ins (`fs`, `path`),
  matching every existing file in `analyst/lib/`.

---

## Existing-code correction from the design spec

The design spec called for a new `analyst/lib/scrape-cache.js` (24h scrape-content
cache) as change #3. Investigation during planning found this already exists:
`analyst/lib/scrape.js:18-19` has `CACHE_FILE` / `CACHE_TTL_MS` (3 days — even more
generous than the spec's 24h) wired into `firecrawl()` already. **That change is
dropped from this plan** — there is nothing to build. Task 2 below only touches the
budget-check code path, not caching.

---

### Task 1: Shared Firecrawl budget counter

**Files:**
- Create: `analyst/lib/firecrawl-budget.js`
- Test: `analyst/lib/firecrawl-budget.test.js`

**Interfaces:**
- Produces: `tryReserve({ file, limit, now } = {}) => Promise<{ ok: boolean, used: number, limit: number }>` — `file` defaults to `data/_firecrawl_budget.json`, `limit` defaults to `FIRECRAWL_DAILY_BUDGET` env or `450`, `now` defaults to `new Date()`. Also exports `DEFAULT_FILE`, `DEFAULT_LIMIT` for Task 2 to reference.

- [ ] **Step 1: Write the failing tests**

Create `analyst/lib/firecrawl-budget.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { tryReserve } = require('./firecrawl-budget.js');

function tmpFile() {
  return path.join(os.tmpdir(), `firecrawl-budget-test-${process.pid}-${Math.random().toString(36).slice(2)}.json`);
}

test('first reservation on a fresh file succeeds with used=1', async () => {
  const file = tmpFile();
  const res = await tryReserve({ file, limit: 5 });
  assert.equal(res.ok, true);
  assert.equal(res.used, 1);
  fs.rmSync(file, { force: true });
});

test('reservations beyond the limit are rejected', async () => {
  const file = tmpFile();
  for (let i = 0; i < 3; i++) await tryReserve({ file, limit: 3 });
  const res = await tryReserve({ file, limit: 3 });
  assert.equal(res.ok, false);
  assert.equal(res.used, 3);
  fs.rmSync(file, { force: true });
});

test('a new calendar day resets the counter', async () => {
  const file = tmpFile();
  fs.writeFileSync(file, JSON.stringify({ date: '2020-01-01', used: 3 }));
  const res = await tryReserve({ file, limit: 3, now: new Date('2020-01-02T00:00:00Z') });
  assert.equal(res.ok, true);
  assert.equal(res.used, 1);
  fs.rmSync(file, { force: true });
});

test('concurrent reservations never exceed the limit', async () => {
  const file = tmpFile();
  const results = await Promise.all(Array.from({ length: 20 }, () => tryReserve({ file, limit: 10 })));
  const okCount = results.filter((r) => r.ok).length;
  assert.equal(okCount, 10);
  fs.rmSync(file, { force: true });
  fs.rmSync(file + '.lock', { force: true });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd analyst && node --test lib/firecrawl-budget.test.js`
Expected: FAIL with "Cannot find module './firecrawl-budget.js'"

- [ ] **Step 3: Write the implementation**

Create `analyst/lib/firecrawl-budget.js`:

```js
// firecrawl-budget.js — a single Firecrawl call budget shared by every concurrently
// running tab process (agent1-5, sophomore, fall2026, etc.), replacing the old
// per-process FIRECRAWL_RUN_CAP env var. Firecrawl's free tier is ~500 credits/mo;
// this keeps a full parallel run under that regardless of how many tabs are active
// at once, instead of rationing each tab in isolation. See
// docs/superpowers/specs/2026-08-29-shared-firecrawl-budget-and-cloud-refresh-design.md
const fs = require("fs");
const path = require("path");

const DEFAULT_FILE = path.join(__dirname, "..", "..", "data", "_firecrawl_budget.json");
const DEFAULT_LIMIT = Math.max(0, parseInt(process.env.FIRECRAWL_DAILY_BUDGET || "450", 10) || 450);
const LOCK_STALE_MS = 5000; // a lock older than this belongs to a crashed holder — safe to steal
const MAX_ATTEMPTS = 40;

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function todayStr(now) { return now.toISOString().slice(0, 10); }

async function acquireLock(lockPath) {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      fs.closeSync(fs.openSync(lockPath, "wx"));
      return true;
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      try {
        if (Date.now() - fs.statSync(lockPath).mtimeMs > LOCK_STALE_MS) { fs.unlinkSync(lockPath); continue; }
      } catch (_) { /* lock vanished between openSync and statSync — loop will re-acquire */ }
      await sleep(Math.min(25 * (attempt + 1), 500));
    }
  }
  return false;
}

function releaseLock(lockPath) {
  try { fs.unlinkSync(lockPath); } catch (_) {}
}

// Reserves one Firecrawl call against today's shared budget. Returns
// { ok, used, limit } — ok is false once `limit` reservations have been made today.
// Fails OPEN (ok: true, used: -1) if the lock can't be acquired at all, rather than
// blocking a scrape indefinitely over a rare double-count.
async function tryReserve({ file = DEFAULT_FILE, limit = DEFAULT_LIMIT, now = new Date() } = {}) {
  const lockPath = file + ".lock";
  const locked = await acquireLock(lockPath);
  if (!locked) return { ok: true, used: -1, limit };
  try {
    let state = { date: todayStr(now), used: 0 };
    try {
      const onDisk = JSON.parse(fs.readFileSync(file, "utf8"));
      if (onDisk && onDisk.date === todayStr(now)) state = onDisk;
    } catch (_) { /* missing/corrupt — start fresh */ }
    if (state.used >= limit) return { ok: false, used: state.used, limit };
    state.used += 1;
    fs.writeFileSync(file, JSON.stringify(state));
    return { ok: true, used: state.used, limit };
  } finally {
    releaseLock(lockPath);
  }
}

module.exports = { tryReserve, DEFAULT_FILE, DEFAULT_LIMIT };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd analyst && node --test lib/firecrawl-budget.test.js`
Expected: PASS, 4 tests, 0 failures

- [ ] **Step 5: Commit**

```bash
git add analyst/lib/firecrawl-budget.js analyst/lib/firecrawl-budget.test.js
git commit -m "Add shared Firecrawl daily budget counter"
```

---

### Task 2: Wire the shared budget into scrape.js

**Files:**
- Modify: `analyst/lib/scrape.js:1-94`
- Test: `analyst/lib/scrape.test.js`

**Interfaces:**
- Consumes: `firecrawl-budget.js`'s `tryReserve({ file, limit, now })` from Task 1.
- Produces: `scrape.js` still exports `{ fetchText, available }` unchanged (both consumed by `analyst/run-analyst.js` — do not rename), plus a new `_firecrawlForTest` export (the internal `firecrawl` function) so Task 2's test can exercise the budget-exhausted branch without a real network dependency.

- [ ] **Step 1: Write the failing test**

Create `analyst/lib/scrape.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert/strict');

test('firecrawl() returns "" without a network call once the daily budget is exhausted', async () => {
  process.env.FIRECRAWL_DAILY_BUDGET = '0';
  delete require.cache[require.resolve('./firecrawl-budget.js')];
  delete require.cache[require.resolve('./scrape.js')];
  const scrape = require('./scrape.js');
  const url = `https://example.invalid/never-cached-${Date.now()}`;
  const text = await scrape._firecrawlForTest(url);
  assert.equal(text, '');
  delete process.env.FIRECRAWL_DAILY_BUDGET;
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd analyst && node --test lib/scrape.test.js`
Expected: FAIL — `scrape._firecrawlForTest is not a function`

- [ ] **Step 3: Modify the implementation**

In `analyst/lib/scrape.js`, replace lines 7-24 (the credit-discipline comment plus
`RUN_CAP`/`used`/`capLogged`) with:

```js
// Credit discipline: Firecrawl only fires when plain fetch got <MIN_TEXT chars,
// results cache in data/_scrape_cache.json (3-day TTL — posting text drives
// open/closed calls, so don't cache it long), and every call is checked against a
// budget SHARED across all concurrently-running tab processes (lib/firecrawl-budget.js)
// — when the budget's exhausted, remaining thin pages just proceed with whatever
// plain fetch got (exactly the pre-Firecrawl behavior), logged once so a starved run
// is visible, never silent.
const budget = require("./firecrawl-budget");

let capLogged = false;
```

Then replace the `firecrawl()` function's cap check (lines 62-65 in the original) —

```diff
-  if (used >= RUN_CAP) {
-    if (!capLogged) { capLogged = true; console.error(`  firecrawl run cap (${RUN_CAP}) reached — remaining thin pages use plain-fetch text`); }
-    return "";
-  }
-  used++;
+  const reserved = await budget.tryReserve();
+  if (!reserved.ok) {
+    if (!capLogged) { capLogged = true; console.error(`  firecrawl daily budget (${reserved.limit}) exhausted — remaining thin pages use plain-fetch text`); }
+    return "";
+  }
```

Finally, update the module export at the bottom:

```diff
-module.exports = { fetchText, available };
+module.exports = { fetchText, available, _firecrawlForTest: firecrawl };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd analyst && node --test lib/scrape.test.js`
Expected: PASS, 1 test, 0 failures

- [ ] **Step 5: Commit**

```bash
git add analyst/lib/scrape.js analyst/lib/scrape.test.js
git commit -m "Replace per-process Firecrawl run cap with the shared daily budget"
```

---

### Task 3: Remove the per-tab cap from the Electron app

**Files:**
- Modify: `tracker-runner/main.js:127,139`

**Interfaces:**
- Consumes: nothing new. Produces: nothing new — this only deletes a now-meaningless env var.

- [ ] **Step 1: Edit `PARALLEL_ENV` and `seqEnv`**

```diff
-const PARALLEL_ENV = { ANALYST_NIM_CONC: '1', ANALYST_SEARCH_CONC: '1', FIRECRAWL_RUN_CAP: '10', ANALYST_BROWSE_CONC: '1' };
+const PARALLEL_ENV = { ANALYST_NIM_CONC: '1', ANALYST_SEARCH_CONC: '1', ANALYST_BROWSE_CONC: '1' };
```

```diff
-  const seqEnv = { ANALYST_NIM_CONC: '4', ANALYST_SEARCH_CONC: '4', FIRECRAWL_RUN_CAP: '60', ANALYST_BROWSE_CONC: '4' };
+  const seqEnv = { ANALYST_NIM_CONC: '4', ANALYST_SEARCH_CONC: '4', ANALYST_BROWSE_CONC: '4' };
```

- [ ] **Step 2: Confirm no remaining references**

Run: `grep -rn "FIRECRAWL_RUN_CAP" tracker-runner/ analyst/`
Expected: no matches (Task 2 already removed `scrape.js`'s read of this env var)

- [ ] **Step 3: Run the existing Tracker Runner test suite**

Run: `cd tracker-runner && npm test`
Expected: PASS — this change doesn't touch anything the existing tests cover, confirms nothing else broke.

- [ ] **Step 4: Commit**

```bash
git add tracker-runner/main.js
git commit -m "Drop the per-tab Firecrawl cap now that the budget is shared"
```

---

### Task 4: Cadence-gate pure logic

**Files:**
- Create: `analyst/lib/schedule.js`
- Test: `analyst/lib/schedule.test.js`

**Interfaces:**
- Produces: `loadConfig(configPath) => { cadenceHours: number, [otherFields]: any }`, `saveConfig(configPath, config) => void`, `isDue(cadenceHours, lastRunIso, now = new Date()) => boolean`, `DEFAULT_CONFIG = { cadenceHours: 24 }`. Task 5 and Task 8 both depend on these exact names.

- [ ] **Step 1: Write the failing tests**

Create `analyst/lib/schedule.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadConfig, saveConfig, isDue, DEFAULT_CONFIG } = require('./schedule.js');

test('isDue is true when there is no prior run recorded', () => {
  assert.equal(isDue(24, null), true);
  assert.equal(isDue(24, undefined), true);
});

test('isDue is false when elapsed time is under the cadence', () => {
  const now = new Date('2026-08-29T12:00:00Z');
  const lastRun = new Date('2026-08-29T00:00:00Z').toISOString(); // 12h ago
  assert.equal(isDue(24, lastRun, now), false);
});

test('isDue is true once elapsed time reaches the cadence', () => {
  const now = new Date('2026-08-29T12:00:00Z');
  const lastRun = new Date('2026-08-28T12:00:00Z').toISOString(); // exactly 24h ago
  assert.equal(isDue(24, lastRun, now), true);
});

test('isDue fails open (true) on an unparseable lastRunIso', () => {
  assert.equal(isDue(24, 'not-a-date', new Date()), true);
});

test('loadConfig returns the default when the file is missing', () => {
  const missingPath = path.join(os.tmpdir(), `schedule-missing-${Date.now()}.json`);
  assert.deepEqual(loadConfig(missingPath), DEFAULT_CONFIG);
});

test('saveConfig then loadConfig round-trips', () => {
  const file = path.join(os.tmpdir(), `schedule-roundtrip-${Date.now()}.json`);
  saveConfig(file, { cadenceHours: 12, lastRunAt: '2026-08-29T00:00:00.000Z' });
  const loaded = loadConfig(file);
  assert.equal(loaded.cadenceHours, 12);
  assert.equal(loaded.lastRunAt, '2026-08-29T00:00:00.000Z');
  fs.rmSync(file, { force: true });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd analyst && node --test lib/schedule.test.js`
Expected: FAIL with "Cannot find module './schedule.js'"

- [ ] **Step 3: Write the implementation**

Create `analyst/lib/schedule.js`:

```js
// schedule.js — pure cadence-gate logic for the unattended cloud refresh: given the
// configured cadence and when the last refresh actually finished, decide whether a
// scheduled tick should run the pipeline or skip as a no-op. Used by
// check-schedule.js (the CI-side gate) and the Tracker Runner Electron app's
// Schedule section (which edits data/_schedule_config.json).
const fs = require("fs");

const DEFAULT_CONFIG = { cadenceHours: 24 };

function loadConfig(configPath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(configPath, "utf8"));
    if (parsed && Number.isFinite(parsed.cadenceHours) && parsed.cadenceHours > 0) return parsed;
  } catch (_) { /* missing/corrupt — fall back to default */ }
  return { ...DEFAULT_CONFIG };
}

function saveConfig(configPath, config) {
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
}

// lastRunIso: ISO date/time of the last successful refresh, or null/undefined if none
// is recorded yet. now: injectable for tests, defaults to the real current time.
function isDue(cadenceHours, lastRunIso, now = new Date()) {
  if (!lastRunIso) return true;
  const last = new Date(lastRunIso);
  if (Number.isNaN(last.getTime())) return true; // corrupt timestamp — don't get stuck skipping forever
  const elapsedHours = (now.getTime() - last.getTime()) / (1000 * 60 * 60);
  return elapsedHours >= cadenceHours;
}

module.exports = { loadConfig, saveConfig, isDue, DEFAULT_CONFIG };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd analyst && node --test lib/schedule.test.js`
Expected: PASS, 6 tests, 0 failures

- [ ] **Step 5: Commit**

```bash
git add analyst/lib/schedule.js analyst/lib/schedule.test.js
git commit -m "Add pure cadence-gate logic for the scheduled cloud refresh"
```

---

### Task 5: CI cadence-gate CLI script

**Files:**
- Create: `analyst/check-schedule.js`

**Interfaces:**
- Consumes: `analyst/lib/schedule.js`'s `loadConfig`, `isDue` (Task 4).
- Produces: writes `due=true` or `due=false` to `$GITHUB_OUTPUT` (read by `.github/workflows/refresh.yml` in Task 7 as `steps.check.outputs.due`). Reads `data/_schedule_config.json` (created on first run if missing, via `DEFAULT_CONFIG`).

- [ ] **Step 1: Write the implementation**

Create `analyst/check-schedule.js`:

```js
#!/usr/bin/env node
// check-schedule.js — run by the GitHub Actions cron every tick (see
// .github/workflows/refresh.yml). Reads data/_schedule_config.json to decide whether
// enough time has elapsed since the last successful refresh to actually run one, and
// writes "due=true|false" to $GITHUB_OUTPUT so the workflow's later steps can be
// gated on it. _schedule_config.json's lastRunAt is updated by the workflow itself
// after a successful run (see refresh.yml's final step) — this script only reads it.
const fs = require("fs");
const path = require("path");
const schedule = require("./lib/schedule.js");

const CONFIG_PATH = path.join(__dirname, "..", "data", "_schedule_config.json");

const config = schedule.loadConfig(CONFIG_PATH);
const due = schedule.isDue(config.cadenceHours, config.lastRunAt);

console.log(`schedule check: cadenceHours=${config.cadenceHours} lastRunAt=${config.lastRunAt || "(none)"} due=${due}`);

const outFile = process.env.GITHUB_OUTPUT;
if (outFile) fs.appendFileSync(outFile, `due=${due}\n`);
```

- [ ] **Step 2: Manually verify against the pure logic it wraps**

`check-schedule.js` is a thin CLI shell around `schedule.js`, which is already fully
covered by Task 4's tests. Verify the wiring itself (not the logic) by hand:

Run: `cd analyst && node check-schedule.js`
Expected: prints a `schedule check: ...` line. Since `data/_schedule_config.json`
doesn't exist yet, `cadenceHours` should show `24` and `lastRunAt` should show
`(none)`, with `due=true` (no `$GITHUB_OUTPUT` set locally, so no file write — the
script must not throw when that env var is absent, confirming the `if (outFile)` guard
works).

- [ ] **Step 3: Commit**

```bash
git add analyst/check-schedule.js
git commit -m "Add CI cadence-gate CLI wrapper"
```

---

### Task 6: Concurrent mode for the headless full-refresh driver

**Files:**
- Modify: `analyst/_full_refresh_driver.js` (full rewrite — see below)
- Test: `analyst/_full_refresh_driver.test.js`

**Interfaces:**
- Produces: `buildArgs(cfg, brain, tabConcurrency) => string[]` (exported for testing), plus the script still runs the full pipeline end-to-end when invoked as `node _full_refresh_driver.js` (sequential, unchanged behavior) or `node _full_refresh_driver.js --parallel` (new: batches of 7 tabs run concurrently).
- Consumes: `analyst/lib/tab-registry.js`'s existing `get(tabId)` (unchanged).

- [ ] **Step 1: Write the failing tests**

Create `analyst/_full_refresh_driver.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildArgs } = require('./_full_refresh_driver.js');

test('buildArgs includes agent-key for a core agent1-5 roster', () => {
  const args = buildArgs({ rosterPath: '../data/roster.json', agentName: 'agent1', agentKey: '1' }, 'nim', '8');
  assert.deepEqual(args, ['run-analyst.js', '--roster', '../data/roster.json', '--agent-name', 'agent1', '--agent-key', '1', '--concurrency', '8']);
});

test('buildArgs includes all-agents, tab, and term for a split fall2026/spring2027 roster', () => {
  const args = buildArgs({ rosterPath: '../data/roster.json', agentName: 'fall2026_fall', allAgents: true, tab: 'fall2026', term: 'fall' }, 'nim', '2');
  assert.deepEqual(args, ['run-analyst.js', '--roster', '../data/roster.json', '--agent-name', 'fall2026_fall', '--all-agents', '--tab', 'fall2026', '--term', 'fall', '--concurrency', '2']);
});

test('buildArgs omits optional flags entirely when absent from the config', () => {
  const args = buildArgs({ rosterPath: '../data/environmental_roster.json', agentName: 'environmental' }, 'heuristic', '4');
  assert.deepEqual(args, ['run-analyst.js', '--roster', '../data/environmental_roster.json', '--agent-name', 'environmental', '--concurrency', '4']);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd analyst && node --test _full_refresh_driver.test.js`
Expected: FAIL — `buildArgs is not a function` (nothing is exported from the current file yet)

- [ ] **Step 3: Rewrite the implementation**

Replace the full contents of `analyst/_full_refresh_driver.js`:

```js
// _full_refresh_driver.js — headless CLI replica of tracker-runner/main.js's
// buildPlan()+runStep engine, for running a real full refresh without the Electron
// GUI. Same tab order, same merge/build-data/deploy tail. See main.js for the source
// of truth this mirrors.
//
// Default mode is sequential (one tab at a time) — safe for a desktop machine but at
// observed per-tab durations (tracker-runner/history/step-timings.json) sums to
// roughly 23 wall-clock hours across all 14 tabs, which exceeds GitHub Actions'
// 6-hour hosted-runner job limit. --parallel runs tabs in batches of 7 concurrently
// (children run via `spawn`, not `spawnSync`) to fit that window; concurrency knobs
// inside each tab (ANALYST_*_CONC) are also lower than the Electron app's parallel
// mode, sized for a 2-vCPU GitHub Actions runner rather than a desktop.
const { spawn, spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const tabRegistry = require("./lib/tab-registry.js");

const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, "..", "data");
const WORKER_DIR = path.join(ROOT, "..", "cloudflare-worker");

const TAB_ORDER = [
  "agent1", "agent2", "agent3", "agent4", "agent5",
  "libraries", "environmental", "realestate", "ithaca",
  "sophomore", "fall2026", "spring2027", "fellowships", "china_hk",
];

const seqEnv = { ANALYST_NIM_CONC: "4", ANALYST_SEARCH_CONC: "4", ANALYST_BROWSE_CONC: "4" };
const parallelEnv = { ANALYST_NIM_CONC: "2", ANALYST_SEARCH_CONC: "2", ANALYST_BROWSE_CONC: "2" };
const PARALLEL_BATCH_SIZE = 7;
const BRAIN = process.env.RUNNER_BRAIN || "nim";

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

function buildArgs(cfg, brain, tabConcurrency) {
  const args = ["run-analyst.js", "--roster", cfg.rosterPath, "--agent-name", cfg.agentName, "--brain", brain];
  if (cfg.agentKey) args.push("--agent-key", cfg.agentKey);
  if (cfg.allAgents) args.push("--all-agents");
  if (cfg.tab) args.push("--tab", cfg.tab);
  if (cfg.term) args.push("--term", cfg.term);
  args.push("--concurrency", tabConcurrency);
  return args;
}

function runSync(cmd, args, cwd, env, shell) {
  log(`$ ${cmd} ${(args || []).join(" ")}  (cwd=${cwd})`);
  const res = spawnSync(cmd, args, { cwd, shell: !!shell, stdio: "inherit", env: env ? { ...process.env, ...env } : process.env });
  return res.status;
}

function runAsync(cmd, args, cwd, env) {
  log(`$ ${cmd} ${(args || []).join(" ")}  (cwd=${cwd}) [async]`);
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, stdio: "inherit", env: env ? { ...process.env, ...env } : process.env });
    child.on("close", (code) => resolve(code));
  });
}

function mergeFall2026() {
  const sources = ["fall2026_fall", "fall2026_spring"];
  const seen = new Set();
  const internships = [];
  let meta = { name: "Fall 2026 / Spring 2027", focus: "" };
  for (const a of sources) {
    const p = path.join(DATA_DIR, `${a}_results.json`);
    if (!fs.existsSync(p)) { log(`  (missing ${a}_results.json — skipping)`); continue; }
    let d;
    try { d = JSON.parse(fs.readFileSync(p, "utf8")); }
    catch (e) { log(`  (unreadable ${a}_results.json: ${e.message} — skipping)`); continue; }
    if (d.name) meta.name = d.name;
    if (d.focus && !meta.focus) meta.focus = d.focus;
    let dupes = 0;
    for (const e of d.internships || []) {
      const k = `${(e.company || "").toLowerCase()}::${(e.program || "").toLowerCase()}`;
      if (seen.has(k)) { dupes++; continue; }
      seen.add(k);
      internships.push(e);
    }
    log(`  + ${a}: ${(d.internships || []).length} entries${dupes ? ` (${dupes} dupes skipped)` : ""}`);
  }
  const out = path.join(DATA_DIR, "fall2026_results.json");
  fs.writeFileSync(out, JSON.stringify({
    agent: "fall2026", name: meta.name, focus: meta.focus,
    last_updated: new Date().toISOString().slice(0, 10), internships,
  }, null, 2));
  log(`  → ${internships.length} merged entries → fall2026_results.json`);
}

async function main() {
  const PARALLEL = process.argv.includes("--parallel");
  const failed = [];

  if (PARALLEL) {
    log(`=== FULL REFRESH — parallel (batches of ${PARALLEL_BATCH_SIZE}), brain=${BRAIN}, ${TAB_ORDER.length} tabs ===`);
    for (let i = 0; i < TAB_ORDER.length; i += PARALLEL_BATCH_SIZE) {
      const batch = TAB_ORDER.slice(i, i + PARALLEL_BATCH_SIZE);
      log(`\n>>> batch: ${batch.join(", ")} <<<`);
      const codes = await Promise.all(batch.map((tabId) => {
        const cfg = tabRegistry.get(tabId);
        return runAsync("node", buildArgs(cfg, BRAIN, "3"), ROOT, parallelEnv);
      }));
      batch.forEach((tabId, idx) => { if (codes[idx] !== 0) { failed.push(tabId); log(`  !! ${tabId} exited ${codes[idx]}`); } });
    }
  } else {
    log(`=== FULL REFRESH — sequential, brain=${BRAIN}, ${TAB_ORDER.length} tabs ===`);
    for (const tabId of TAB_ORDER) {
      const cfg = tabRegistry.get(tabId);
      log(`\n>>> ${cfg.label} (${tabId}) <<<`);
      const code = runSync("node", buildArgs(cfg, BRAIN, "8"), ROOT, seqEnv, false);
      if (code !== 0) { failed.push(tabId); log(`  !! ${tabId} exited ${code}`); }
    }
  }

  log("\n=== MERGE fall2026 + spring2027 ===");
  mergeFall2026();

  log("\n=== DEPLOY ===");
  runSync("curl", ["-s", "https://internship-tracker.jz-tracker.workers.dev/api/data", "-o", path.join(WORKER_DIR, "src", "data.json")], WORKER_DIR, null, false);
  const buildCode = runSync("node", ["build-data.js"], WORKER_DIR, null, false);
  if (buildCode !== 0) { log("build-data.js FAILED — not deploying"); process.exit(1); }
  const deployCode = runSync("wrangler deploy", null, WORKER_DIR, null, true);

  log(`\n=== DONE — failed tabs: ${failed.length ? failed.join(", ") : "none"}, deploy exit: ${deployCode} ===`);
}

if (require.main === module) {
  main();
}

module.exports = { buildArgs };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd analyst && node --test _full_refresh_driver.test.js`
Expected: PASS, 3 tests, 0 failures

- [ ] **Step 5: Manually verify the script still runs standalone**

Run: `cd analyst && node _full_refresh_driver.js --help 2>&1 | head -1` is not a real
flag this script supports — instead confirm the module guard works correctly:

Run: `cd analyst && node -e "require('./_full_refresh_driver.js'); console.log('loaded without auto-running')"`
Expected: prints `loaded without auto-running` and nothing else (no `=== FULL REFRESH
===` log line) — confirms `require.main === module` correctly prevents the pipeline
from firing just because the file was required (as Task 6's test file does).

- [ ] **Step 6: Commit**

```bash
git add analyst/_full_refresh_driver.js analyst/_full_refresh_driver.test.js
git commit -m "Add --parallel batch mode to the headless full-refresh driver"
```

---

### Task 7: GitHub Actions scheduled workflow

**Files:**
- Create: `.github/workflows/refresh.yml`

**Interfaces:**
- Consumes: `analyst/check-schedule.js` (Task 5, must produce a `due` step output), `analyst/_full_refresh_driver.js --parallel` (Task 6), `cloudflare-worker/build-data.js` (existing, unchanged).
- Produces: on a due tick, commits updated `data/*.json` + `cloudflare-worker/src/data.json` and updates `data/_schedule_config.json`'s `lastRunAt`.

- [ ] **Step 1: Create the workflow file**

Create `.github/workflows/refresh.yml`:

```yaml
name: Scheduled refresh

on:
  schedule:
    - cron: '0 */2 * * *'   # ticks every 2h; check-schedule.js decides whether to actually run
  workflow_dispatch: {}

jobs:
  refresh:
    runs-on: ubuntu-latest
    timeout-minutes: 350   # stay under GitHub's 360min (6h) hard cap on hosted runners
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: '22'   # cloudflare-worker/build-data.js needs stable ESM auto-detection

      - name: Install analyst dependencies
        run: npm ci
        working-directory: analyst

      - name: Install Playwright browser
        run: npx playwright install --with-deps chromium
        working-directory: analyst

      - name: Check schedule
        id: check
        run: node check-schedule.js
        working-directory: analyst

      - name: Run full refresh (parallel)
        if: steps.check.outputs.due == 'true'
        run: node _full_refresh_driver.js --parallel
        working-directory: analyst
        env:
          TAVILY_API_KEY: ${{ secrets.TAVILY_API_KEY }}
          FIRECRAWL_API_KEY: ${{ secrets.FIRECRAWL_API_KEY }}
          NIM_API_KEY: ${{ secrets.NIM_API_KEY }}

      - name: Deploy Cloudflare Worker
        if: steps.check.outputs.due == 'true'
        run: npx wrangler@4 deploy
        working-directory: cloudflare-worker
        env:
          CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}

      - name: Record last run and push data changes
        if: steps.check.outputs.due == 'true'
        run: |
          node -e "
            const s = require('./lib/schedule.js');
            const p = require('path').join(__dirname, '..', 'data', '_schedule_config.json');
            const c = s.loadConfig(p);
            c.lastRunAt = new Date().toISOString();
            s.saveConfig(p, c);
          "
          git config user.name "tracker-bot"
          git config user.email "actions@github.com"
          git add data/ cloudflare-worker/src/data.json
          git diff --cached --quiet || git commit -m "Scheduled refresh $(date -u +%F)"
          git push
        working-directory: analyst
```

- [ ] **Step 2: Add repository secrets**

In the GitHub repo's Settings → Secrets and variables → Actions, add:
`TAVILY_API_KEY`, `FIRECRAWL_API_KEY`, `NIM_API_KEY`, `CLOUDFLARE_API_TOKEN` (values
copied from `C:\Users\justi\OneDrive\Documents\.env` — `analyst/lib/keyfile.js`'s
env-var-first check picks these up automatically in CI with no code change).

This step has no automated verification — it's a manual one-time action in GitHub's
UI. Confirm afterward with: `gh secret list --repo jz2446-dotcom/internship-tracker`
(should list all four names; values are never shown).

- [ ] **Step 3: Commit the workflow file**

```bash
git add .github/workflows/refresh.yml
git commit -m "Add scheduled GitHub Actions refresh workflow"
```

- [ ] **Step 4: Manually trigger and verify**

Push this branch, then run: `gh workflow run refresh.yml --repo jz2446-dotcom/internship-tracker`
Watch it with: `gh run watch --repo jz2446-dotcom/internship-tracker`
Expected: the "Check schedule" step logs `due=true` (no `_schedule_config.json` exists
yet, so `isDue` defaults to true), the refresh runs, and a new commit appears on the
branch with updated `data/*.json` and `_schedule_config.json`'s `lastRunAt` set.

---

### Task 8: "Schedule" section in the Tracker Runner app

**Files:**
- Modify: `tracker-runner/index.html` (add UI)
- Modify: `tracker-runner/renderer.js` (wire the UI)
- Modify: `tracker-runner/preload.js` (expose the IPC call)
- Modify: `tracker-runner/main.js` (handle the IPC call, write config, git commit+push)

**Interfaces:**
- Consumes: `analyst/lib/schedule.js`'s `loadConfig`/`saveConfig` (Task 4) — `tracker-runner/main.js` requires `../analyst/lib/schedule.js` directly (same pattern as it already requires `./lib/dedup.js` etc., just reaching one directory further for a module that's meant to be shared).
- Produces: `window.api.saveSchedule(cadenceHours) => Promise<{ ok: boolean, error?: string }>`, exposed via `preload.js`, handled by a new `ipcMain.handle('save-schedule', ...)` in `main.js`.

- [ ] **Step 1: Add the UI markup**

In `tracker-runner/index.html`, immediately after the existing button row containing
`dedupBtn` (the `<div class="mode-btn-row">` or equivalent block ending at the line
with `<button id="stopBtn" ...>`), add:

```html
<div id="scheduleSection" class="schedule-section">
  <label for="cadenceSelect">Unattended refresh:</label>
  <select id="cadenceSelect">
    <option value="24">Daily</option>
    <option value="12">Twice daily</option>
    <option value="72">Every 3 days</option>
  </select>
  <button id="saveScheduleBtn">Save schedule</button>
  <span id="scheduleStatus"></span>
</div>
```

- [ ] **Step 2: Expose the IPC call in preload.js**

In `tracker-runner/preload.js`, inside the `contextBridge.exposeInMainWorld('api', {...})` object, add alongside `startDedup`:

```diff
   startDedup: () => ipcRenderer.invoke('start-dedup'),
+  saveSchedule: (cadenceHours) => ipcRenderer.invoke('save-schedule', cadenceHours),
```

- [ ] **Step 3: Wire the button in renderer.js**

In `tracker-runner/renderer.js`, near the top where other elements are grabbed (alongside `const dedupBtn = document.getElementById('dedupBtn');`), add:

```js
const cadenceSelect = document.getElementById('cadenceSelect');
const saveScheduleBtn = document.getElementById('saveScheduleBtn');
const scheduleStatus = document.getElementById('scheduleStatus');
```

Then, near the other `addEventListener` calls (after the `dedupBtn.addEventListener(...)` block), add:

```js
saveScheduleBtn.addEventListener('click', async () => {
  const cadenceHours = parseInt(cadenceSelect.value, 10);
  scheduleStatus.textContent = 'Saving…';
  const res = await window.api.saveSchedule(cadenceHours);
  scheduleStatus.textContent = res.ok ? 'Saved.' : `Failed: ${res.error}`;
});
```

- [ ] **Step 4: Handle the IPC call in main.js**

In `tracker-runner/main.js`, add the require near the other `./lib/*` requires (after
`const { dedupCategories } = require('./lib/dedup.js');`):

```js
const schedule = require('../analyst/lib/schedule.js');
const SCHEDULE_CONFIG_PATH = path.join(DATA_DIR, '_schedule_config.json');
```

Then add a new handler near `ipcMain.handle('start-dedup', ...)`:

```js
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
    child.on('close', (code) => {
      if (code !== 0) return resolve(false);
      const commit = spawn('git', ['commit', '-m', 'Update refresh cadence'], { cwd: PROJECT_ROOT, stdio: 'inherit' });
      commit.on('close', (commitCode) => {
        // exit 1 with nothing to commit (cadence unchanged) is not an error
        if (commitCode !== 0 && commitCode !== 1) return resolve(false);
        const push = spawn('git', ['push'], { cwd: PROJECT_ROOT, stdio: 'inherit' });
        push.on('close', (pushCode) => resolve(pushCode === 0));
      });
    });
  });
  return { ok: pushed, error: pushed ? undefined : 'git commit/push failed — see app console' };
});
```

Note: `config.lastRunAt` is preserved automatically here — `loadConfig` reads the
existing file (including whatever `lastRunAt` the last GitHub Actions run wrote) and
this handler only overwrites `cadenceHours` before saving, exactly matching the design
spec's requirement not to clobber it.

- [ ] **Step 5: Manually verify end-to-end**

Run: `cd tracker-runner && npm start`
In the app: change the "Unattended refresh" dropdown to "Twice daily" and click "Save
schedule". Expected: status shows "Saved.", and `git log -1 --stat` (from the project
root) shows a new commit "Update refresh cadence" touching
`data/_schedule_config.json` with `"cadenceHours": 12`.

- [ ] **Step 6: Commit**

```bash
git add tracker-runner/index.html tracker-runner/renderer.js tracker-runner/preload.js tracker-runner/main.js
git commit -m "Add Schedule section to Tracker Runner for unattended-refresh cadence"
```

---

## Self-Review Notes

- **Spec coverage:** design spec change #1 (budget) → Task 1; #2 (scrape.js wiring) →
  Task 2; #3 (24h cache) → dropped, already exists (see correction note above); #4
  (drop per-tab cap) → Task 3; #5 (driver concurrency) → Task 6; #6 (workflow) → Task
  7; #7 (check-schedule.js) → Task 5 (and its dependency, `schedule.js` → Task 4); #8
  (Electron Schedule UI) → Task 8.
- **Type consistency checked:** `tryReserve()`'s return shape `{ok, used, limit}`
  (Task 1) matches exactly how Task 2 destructures it (`reserved.ok`, `reserved.limit`).
  `schedule.js`'s `loadConfig`/`saveConfig`/`isDue` signatures (Task 4) are used
  identically in Task 5 (`check-schedule.js`) and Task 8 (`main.js`'s handler) — same
  parameter order, same field name `cadenceHours` throughout.
- **No placeholders:** every step above includes complete, runnable code — none are
  reference-only ("similar to Task N").

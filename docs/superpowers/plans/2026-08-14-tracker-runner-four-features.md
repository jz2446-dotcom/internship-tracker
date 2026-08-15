# Tracker Runner — Four New Features Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a progress bar/time clock, a post-run resolved-companies report, a cross-category dedup+redeploy button, and a per-run history calendar to the `tracker-runner` Electron app.

**Architecture:** Six new pure(ish) `lib/*.js` modules (unit-tested with Node's built-in `node:test`, no new dependencies) implement the logic for each feature in isolation. `main.js` wires them into the existing pipeline engine (`buildPlan`/`runPipeline`/IPC handlers), extending — not replacing — the current step-status/run-output/run-done event stream. `renderer.js`/`index.html`/`styles.css` get additive UI: a progress bar, a report popup, a new button, and a calendar + third panel tab.

**Tech Stack:** Node.js (Electron main process, CommonJS), vanilla JS/HTML/CSS (renderer, no framework), `node:test` + `node:assert` for unit tests (already available — Node 24 confirmed on the dev machine, no install needed).

## Global Constraints

- No new npm dependencies — everything here is Node built-ins (`fs`, `path`, `http`, `vm`-free `new Function`) plus the app's existing Electron APIs.
- Never modify `cloudflare-worker/src/index.js` (the live Worker source) — Feature 4's HTML reuse must work by reading that file, not editing it.
- Every write to `tracker-runner/history/*` must be best-effort where noted in the spec (timing writes must never fail a run); dedup/snapshot writes may throw and should be caught and logged like any other pipeline step failure.
- Match existing code style: CommonJS `require`, 2-space indent, the GitHub-dark CSS palette already in `styles.css` (`#0d1117` bg, `#161b22` surface, `#1f6feb` accent, `#8b949e` muted text, `#f85149` error, `#3fb950` success).
- Design spec: `docs/superpowers/specs/2026-08-14-tracker-runner-four-features-design.md`. Checkpoint commit before this work: `ec147390`.

---

## File Structure

New files:
- `tracker-runner/lib/timing.js` + `tracker-runner/lib/timing.test.js` — EMA step-duration store + progress-bar math (Feature 1)
- `tracker-runner/lib/resolvedParser.js` + `.test.js` — parses `run-analyst.js`'s `✓ TAG company ...` log lines (Feature 2)
- `tracker-runner/lib/dedup.js` + `.test.js` — cross-category duplicate-removal algorithm (Feature 3)
- `tracker-runner/lib/history.js` + `.test.js` — per-day snapshot read/write/list (Feature 4)
- `tracker-runner/lib/htmlLoader.js` + `.test.js` — extracts & evaluates `getDashboardHTML()` out of the live Worker source without modifying it (Feature 4)
- `tracker-runner/lib/historyServer.js` + `.test.js` — tiny local HTTP server serving that HTML + a selected snapshot (Feature 4)

Modified files (touched across multiple tasks, called out per-task below):
- `tracker-runner/main.js` — plan-building, pipeline engine, new IPC handlers
- `tracker-runner/preload.js` — new bridged IPC methods
- `tracker-runner/renderer.js` — new UI wiring
- `tracker-runner/index.html` — new markup
- `tracker-runner/styles.css` — new styles
- `tracker-runner/package.json` — add a `test` script

---

### Task 1: `lib/timing.js` — EMA step-duration store + progress math

**Files:**
- Create: `tracker-runner/lib/timing.js`
- Create: `tracker-runner/lib/timing.test.js`
- Modify: `tracker-runner/package.json` (add `"test": "node --test lib/*.test.js"` under `"scripts"`)

**Interfaces:**
- Produces: `loadTimings(filePath) -> Object<string, number>`, `saveTimings(filePath, timings) -> void`, `updateTimings(timings, observations: Array<{key: string, ms: number}>) -> Object<string, number>`, `computeProgress(steps: Array<{key: string, status: string}>, timings: Object<string, number>) -> number` (0..1). Consumed by Task 2 (`main.js`).

- [ ] **Step 1: Write the failing tests**

Create `tracker-runner/lib/timing.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { loadTimings, saveTimings, updateTimings, computeProgress } = require('./timing.js');

test('loadTimings returns {} when the file is missing', () => {
  const p = path.join(os.tmpdir(), 'tr-timing-missing-' + Date.now() + '.json');
  assert.deepEqual(loadTimings(p), {});
});

test('loadTimings returns {} on malformed JSON, never throws', () => {
  const p = path.join(os.tmpdir(), 'tr-timing-bad-' + Date.now() + '.json');
  fs.writeFileSync(p, '{not json');
  assert.deepEqual(loadTimings(p), {});
  fs.unlinkSync(p);
});

test('saveTimings then loadTimings round-trips, creating parent dirs', () => {
  const dir = path.join(os.tmpdir(), 'tr-timing-dir-' + Date.now());
  const p = path.join(dir, 'nested', 'step-timings.json');
  saveTimings(p, { agent1: 5000 });
  assert.deepEqual(loadTimings(p), { agent1: 5000 });
  fs.rmSync(dir, { recursive: true, force: true });
});

test('updateTimings seeds a new key with the raw observation', () => {
  const next = updateTimings({}, [{ key: 'build', ms: 1000 }]);
  assert.equal(next.build, 1000);
});

test('updateTimings applies a 0.3/0.7 EMA to an existing key', () => {
  const next = updateTimings({ build: 1000 }, [{ key: 'build', ms: 2000 }]);
  assert.equal(next.build, 0.3 * 2000 + 0.7 * 1000); // 1300
});

test('updateTimings ignores non-finite or negative durations', () => {
  const next = updateTimings({ build: 1000 }, [{ key: 'build', ms: -5 }, { key: 'x', ms: NaN }]);
  assert.deepEqual(next, { build: 1000 });
});

test('computeProgress: all pending steps with known timings -> 0', () => {
  const steps = [{ key: 'a', status: 'pending' }, { key: 'b', status: 'pending' }];
  assert.equal(computeProgress(steps, { a: 100, b: 100 }), 0);
});

test('computeProgress: all done -> 1', () => {
  const steps = [{ key: 'a', status: 'done' }, { key: 'b', status: 'done' }];
  assert.equal(computeProgress(steps, { a: 100, b: 300 }), 1);
});

test('computeProgress: a running step counts as half its own weight', () => {
  const steps = [{ key: 'a', status: 'done' }, { key: 'b', status: 'running' }];
  // equal weights (100 each): done=100, running=50 of 200 total = 0.75
  assert.equal(computeProgress(steps, { a: 100, b: 100 }), 0.75);
});

test('computeProgress: failed/stopped/skipped count as fully weighted (terminal)', () => {
  const steps = [{ key: 'a', status: 'failed' }, { key: 'b', status: 'skipped' }];
  assert.equal(computeProgress(steps, { a: 100, b: 100 }), 1);
});

test('computeProgress: unknown key falls back to the mean of known timings', () => {
  const steps = [{ key: 'known', status: 'done' }, { key: 'unknown', status: 'pending' }];
  // known=100 (its real EMA), unknown falls back to mean of known timings = 100 too
  assert.equal(computeProgress(steps, { known: 100 }), 0.5);
});

test('computeProgress: empty timings map falls back to equal weight 1 per step', () => {
  const steps = [{ key: 'a', status: 'done' }, { key: 'b', status: 'pending' }];
  assert.equal(computeProgress(steps, {}), 0.5);
});

test('computeProgress: no steps -> 0', () => {
  assert.equal(computeProgress([], { a: 100 }), 0);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd tracker-runner && node --test lib/timing.test.js`
Expected: FAIL — `Cannot find module './timing.js'`

- [ ] **Step 3: Implement `lib/timing.js`**

```js
// lib/timing.js — EMA-based step duration tracking, used to weight the progress bar.
const fs = require('fs');
const path = require('path');

const ALPHA = 0.3;

function loadTimings(filePath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed : {};
  } catch (_) {
    return {};
  }
}

function saveTimings(filePath, timings) {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(timings, null, 2));
  } catch (_) {
    // best-effort — a failed write must never fail the run
  }
}

// observations: [{ key, ms }] — durations measured for this run's steps.
function updateTimings(timings, observations) {
  const next = { ...timings };
  for (const { key, ms } of observations) {
    if (!key || !Number.isFinite(ms) || ms < 0) continue;
    next[key] = (key in next) ? ALPHA * ms + (1 - ALPHA) * next[key] : ms;
  }
  return next;
}

// steps: [{ key, status }] in plan order. Returns a fraction 0..1.
function computeProgress(steps, timings) {
  if (!steps.length) return 0;
  const known = Object.values(timings).filter(Number.isFinite);
  const fallback = known.length ? known.reduce((a, b) => a + b, 0) / known.length : 1;
  const weightOf = (s) => (Number.isFinite(timings[s.key]) ? timings[s.key] : fallback);
  const total = steps.reduce((sum, s) => sum + weightOf(s), 0);
  if (total <= 0) return 0;
  const TERMINAL = new Set(['done', 'failed', 'stopped', 'skipped']);
  const done = steps.reduce((sum, s) => {
    const w = weightOf(s);
    if (TERMINAL.has(s.status)) return sum + w;
    if (s.status === 'running') return sum + w * 0.5;
    return sum;
  }, 0);
  return Math.max(0, Math.min(1, done / total));
}

module.exports = { loadTimings, saveTimings, updateTimings, computeProgress };
```

- [ ] **Step 4: Add the test script and run**

Modify `tracker-runner/package.json` — inside `"scripts"`, add:

```json
    "test": "node --test lib/*.test.js"
```

Run: `cd tracker-runner && npm test`
Expected: all 13 tests PASS

- [ ] **Step 5: Commit**

```bash
git add tracker-runner/lib/timing.js tracker-runner/lib/timing.test.js tracker-runner/package.json
git commit -m "tracker-runner: add EMA step-timing + progress-bar math (lib/timing.js)"
```

---

### Task 2: Wire the progress bar + time clock into the app

**Files:**
- Modify: `tracker-runner/main.js`
- Modify: `tracker-runner/renderer.js`
- Modify: `tracker-runner/index.html`
- Modify: `tracker-runner/styles.css`

**Interfaces:**
- Consumes: `timing.loadTimings`, `timing.updateTimings`, `timing.saveTimings`, `timing.computeProgress` from Task 1.
- Produces: every `buildPlan()` step object now has a `key` field (research steps: the tab id; `merge`, `fetch-baseline`, `build`, `deploy` for the tail). The `step-status` IPC payload now includes a `percent` field. Later tasks (6, 10) that add steps to `buildPlan()` must give each new step a `key`.

- [ ] **Step 1: Add `key` to every step `buildPlan()` produces**

Modify `tracker-runner/main.js`. In the research-step loop inside `buildPlan`, the step push currently reads:

```js
    steps.push({
      label: `Research — ${cfg.label}`,
      kind: 'cmd', cmd: 'node', args, cwd: ANALYST_DIR, shell: false,
      wave: 1, tag: tabId, env: tabEnv,
    });
```

Add `key: tabId` to that object (same line group):

```js
    steps.push({
      label: `Research — ${cfg.label}`,
      kind: 'cmd', cmd: 'node', args, cwd: ANALYST_DIR, shell: false,
      wave: 1, tag: tabId, env: tabEnv, key: tabId,
    });
```

Then give the four tail steps stable keys. Change:

```js
    steps.push({ label: 'Merge — Fall 2026 + Spring 2027 → fall2026', kind: 'merge-fall2026' });
```
to:
```js
    steps.push({ label: 'Merge — Fall 2026 + Spring 2027 → fall2026', kind: 'merge-fall2026', key: 'merge' });
```

And the three deploy-tail steps (`Fetch live data baseline...`, `Rebuild data bundle...`, `Deploy Worker...`) each get `key: 'fetch-baseline'`, `key: 'build'`, `key: 'deploy'` respectively, added to their existing object literals alongside `label`.

- [ ] **Step 2: Track step statuses/timings and compute `percent` in `runPipeline`**

Modify `tracker-runner/main.js`. Near the top, alongside the existing requires, add:

```js
const timing = require('./lib/timing.js');
const TIMINGS_PATH = path.join(__dirname, 'history', 'step-timings.json');
```

In `runPipeline`, right after `const steps = buildPlan(opts);`, add:

```js
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
```

Now replace every direct `sender.send('step-status', {...})` call in `runPipeline` with a call to `sendStepStatus`, keeping the same second-argument fields as `extra`. There are 6 call sites — for each, change `sender.send('step-status', { index: I, status: 'S', ...rest })` to `sendStepStatus(I, 'S', rest)` (omit the trailing `, rest` argument entirely when there is no extra field beyond `index`/`status`). Concretely:

- `sender.send('step-status', { index: i, status: 'skipped' });` (in `execResearch`, aborted case) → `sendStepStatus(i, 'skipped');`
- `sender.send('step-status', { index: i, status: 'running' });` (in `execResearch`) → `sendStepStatus(i, 'running');`
- `sender.send('step-status', { index: i, status: 'stopped' });` (in `execResearch`) → `sendStepStatus(i, 'stopped');`
- `sender.send('step-status', { index: i, status: 'done' });` (in `execResearch`) → `sendStepStatus(i, 'done');`
- `sender.send('step-status', { index: i, status: 'failed', code });` (in `execResearch`) → `sendStepStatus(i, 'failed', { code });`
- The two identical `sender.send('step-status', { index: i, status: aborted ? 'skipped' : 'skipped' });` and `sender.send('step-status', { index: i, status: 'running' });` in the finalization loop → `sendStepStatus(i, 'skipped');` and `sendStepStatus(i, 'running');`
- `sender.send('step-status', { index: i, status: 'done' });` (merge-fall2026 success) → `sendStepStatus(i, 'done');`
- `sender.send('step-status', { index: i, status: 'failed' });` (merge-fall2026 failure) → `sendStepStatus(i, 'failed');`
- `sender.send('step-status', { index: i, status: 'stopped' });` (cmd step aborted) → `sendStepStatus(i, 'stopped');`
- `sender.send('step-status', { index: i, status: 'done' });` (cmd step success) → `sendStepStatus(i, 'done');`
- `sender.send('step-status', { index: i, status: 'failed', code });` (cmd step failure) → `sendStepStatus(i, 'failed', { code });`

At the end of `runPipeline`, right before `running = false;`, add:

```js
  const updatedTimings = timing.updateTimings(timingsSnapshot, observations);
  timing.saveTimings(TIMINGS_PATH, updatedTimings);
```

- [ ] **Step 3: Add the progress bar markup**

Modify `tracker-runner/index.html`. Right after the closing `</div>` of `<div class="mode-hint" id="modeHint">...</div>` (before `<main>`), add:

```html
  <div class="progress-wrap" id="progressWrap">
    <div class="progress-bar"><div id="progressFill" class="progress-fill"></div></div>
    <span id="progressLabel" class="progress-label">00:00 · 0%</span>
  </div>
```

- [ ] **Step 4: Style it**

Modify `tracker-runner/styles.css`. After the `.mode-hint b { color: #c9d1d9; }` rule, add:

```css
.progress-wrap {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 18px;
  border-bottom: 1px solid #21262d;
  background: #010409;
}
.progress-bar {
  flex: 1;
  height: 6px;
  background: #161b22;
  border: 1px solid #30363d;
  border-radius: 4px;
  overflow: hidden;
}
.progress-fill {
  height: 100%;
  width: 0%;
  background: #1f6feb;
  transition: width 0.3s ease;
}
.progress-label {
  font-size: 12px;
  color: #8b949e;
  min-width: 110px;
  text-align: right;
  font-variant-numeric: tabular-nums;
}
```

- [ ] **Step 5: Wire it up in the renderer**

Modify `tracker-runner/renderer.js`. Near the top, alongside the other `document.getElementById` grabs, add:

```js
const progressFill = document.getElementById('progressFill');
const progressLabel = document.getElementById('progressLabel');
```

Add state and a ticking timer near the top (with `let mode = 'long';` etc.):

```js
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
```

In the `onPlan` handler, after `statusBar.textContent = 'Running…';`, add:

```js
  runStartTime = Date.now();
  latestPercent = 0;
  startProgressTimer();
  renderProgress();
```

In the `onStepStatus` handler, after `li.className = status;` and its icon update, add:

```js
  if (typeof status === 'object') return; // guard, shouldn't happen
```

Actually replace the whole handler body to also read `percent`. The handler currently is:

```js
window.api.onStepStatus(({ index, status }) => {
  const li = stepsList.children[index];
  if (!li) return;
  li.className = status;
  li.querySelector('.icon').textContent = STATUS_ICON[status] || '○';
  if (status === 'running') {
    statusBar.textContent = `Running: ${li.querySelector('.label').textContent}`;
    li.scrollIntoView({ block: 'nearest' });
  }
});
```

Change it to:

```js
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
```

In the `onDone` handler, after `statusBar.className = ...;`, add:

```js
  stopProgressTimer();
  latestPercent = aborted ? latestPercent : (ok ? 1 : latestPercent);
  renderProgress();
```

- [ ] **Step 6: Manual verification**

Run: `cd tracker-runner && npm start`. Click "Smoke test", then "Start run + deploy". Confirm:
- The progress bar under the mode hint fills as steps complete and the label shows `mm:ss · N%`, updating once per second.
- After the run finishes, the bar stops animating and the label freezes.
- `tracker-runner/history/step-timings.json` now exists and contains an entry for `environmental` (the smoke tab) after the run.

- [ ] **Step 7: Commit**

```bash
git add tracker-runner/main.js tracker-runner/renderer.js tracker-runner/index.html tracker-runner/styles.css
git commit -m "tracker-runner: add progress bar + time clock during a run"
```

---

### Task 3: `lib/resolvedParser.js` — parse resolved-company log lines

**Files:**
- Create: `tracker-runner/lib/resolvedParser.js`
- Create: `tracker-runner/lib/resolvedParser.test.js`

**Interfaces:**
- Produces: `parseResolvedLine(line: string) -> { tab: string, method: string, company: string, detail: string } | null`. Consumed by Task 4 (`main.js`).

- [ ] **Step 1: Write the failing tests**

Create `tracker-runner/lib/resolvedParser.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseResolvedLine } = require('./resolvedParser.js');

test('parses a REG line', () => {
  const r = parseResolvedLine('[agent3] ✓ REG  Acme Corp → greenhouse/acme (2)');
  assert.deepEqual(r, { tab: 'agent3', method: 'REG', company: 'Acme Corp', detail: 'greenhouse/acme (2)' });
});

test('parses an ATS line (no arrow, trailing paren detail)', () => {
  const r = parseResolvedLine('[environmental] ✓ ATS  Beta Fund (lever/beta, 3)');
  assert.deepEqual(r, { tab: 'environmental', method: 'ATS', company: 'Beta Fund', detail: '(lever/beta, 3)' });
});

test('parses a SRCH line', () => {
  const r = parseResolvedLine('[libraries] ✓ SRCH Gamma Museum → workday/gamma (1)');
  assert.deepEqual(r, { tab: 'libraries', method: 'SRCH', company: 'Gamma Museum', detail: 'workday/gamma (1)' });
});

test('parses a WEB line with a provider/slug detail', () => {
  const r = parseResolvedLine('[ithaca] ✓ WEB  Delta Bank → greenhouse/delta (4)');
  assert.deepEqual(r, { tab: 'ithaca', method: 'WEB', company: 'Delta Bank', detail: 'greenhouse/delta (4)' });
});

test('parses a WEB "scraped" line', () => {
  const r = parseResolvedLine('[china_hk] ✓ WEB  Epsilon LLC → scraped https://epsilon.com/careers');
  assert.deepEqual(r, { tab: 'china_hk', method: 'WEB', company: 'Epsilon LLC', detail: 'scraped https://epsilon.com/careers' });
});

test('parses a WEB "sniffed API" line', () => {
  const r = parseResolvedLine('[fellowships] ✓ WEB  Zeta Inc → sniffed API (5)');
  assert.deepEqual(r, { tab: 'fellowships', method: 'WEB', company: 'Zeta Inc', detail: 'sniffed API (5)' });
});

test('returns null for an unrelated console line', () => {
  assert.equal(parseResolvedLine('[agent1] … search pass over 12 unresolved firms (tavily)'), null);
});

test('returns null for an unresolved-firm summary line', () => {
  assert.equal(parseResolvedLine('firms:        40  (ATS 10, search-resolved 5, browser-resolved 2, still unresolved 3)'), null);
});

test('returns null for an empty or whitespace-only line', () => {
  assert.equal(parseResolvedLine(''), null);
  assert.equal(parseResolvedLine('   '), null);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd tracker-runner && node --test lib/resolvedParser.test.js`
Expected: FAIL — `Cannot find module './resolvedParser.js'`

- [ ] **Step 3: Implement `lib/resolvedParser.js`**

```js
// lib/resolvedParser.js — parses run-analyst.js's per-firm resolution log lines
// (already tagged with `[tabId] ` by main.js's tagChunk) into structured records
// for the post-run "resolved companies" report.
function parseResolvedLine(line) {
  const trimmed = (line || '').trim();
  const m = /^\[(\w+)\]\s*✓\s*(REG|ATS|SRCH|WEB)\s+(.+)$/.exec(trimmed);
  if (!m) return null;
  const [, tab, method, rest] = m;

  const arrowIdx = rest.indexOf('→');
  if (arrowIdx !== -1) {
    const company = rest.slice(0, arrowIdx).trim();
    const detail = rest.slice(arrowIdx + 1).trim();
    return company ? { tab, method, company, detail } : null;
  }

  const parenIdx = rest.indexOf('(');
  if (parenIdx !== -1) {
    const company = rest.slice(0, parenIdx).trim();
    const detail = rest.slice(parenIdx).trim();
    return company ? { tab, method, company, detail } : null;
  }

  const company = rest.trim();
  return company ? { tab, method, company, detail: '' } : null;
}

module.exports = { parseResolvedLine };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd tracker-runner && node --test lib/resolvedParser.test.js`
Expected: all 10 tests PASS

- [ ] **Step 5: Commit**

```bash
git add tracker-runner/lib/resolvedParser.js tracker-runner/lib/resolvedParser.test.js
git commit -m "tracker-runner: add resolved-company log line parser"
```

---

### Task 4: Wire the post-run resolved-companies report into the app

**Files:**
- Modify: `tracker-runner/main.js`
- Modify: `tracker-runner/renderer.js`
- Modify: `tracker-runner/index.html`
- Modify: `tracker-runner/styles.css`

**Interfaces:**
- Consumes: `parseResolvedLine` from Task 3.
- Produces: `run-done` IPC payload now includes `resolved: Object<tab, Array<{company, method, detail}>>`.

- [ ] **Step 1: Accumulate resolved lines during a run**

Modify `tracker-runner/main.js`. Add the require near the top:

```js
const { parseResolvedLine } = require('./lib/resolvedParser.js');
```

Add module-scoped state alongside `let running = false; let aborted = false; const children = new Set();`:

```js
let resolvedThisRun = [];
```

In `runStep`, the stdout/stderr handlers currently are:

```js
    child.stdout.on('data', d => sender.send('run-output', { stream: 'stdout', chunk: tagChunk(step.tag, d.toString()) }));
    child.stderr.on('data', d => sender.send('run-output', { stream: 'stderr', chunk: tagChunk(step.tag, d.toString()) }));
```

Replace with:

```js
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
```

At the top of `runPipeline` (right after `const steps = buildPlan(opts);`), add:

```js
  resolvedThisRun = [];
```

Add a grouping helper above `runPipeline`:

```js
function groupResolved(list) {
  const byTab = {};
  for (const r of list) {
    (byTab[r.tab] = byTab[r.tab] || []).push({ company: r.company, method: r.method, detail: r.detail });
  }
  return byTab;
}
```

Change the final `sender.send('run-done', { ok, aborted, failures });` to:

```js
  sender.send('run-done', { ok, aborted, failures, resolved: groupResolved(resolvedThisRun) });
```

- [ ] **Step 2: Add the toggle + popup markup**

Modify `tracker-runner/index.html`. In the `<div class="controls">` block, right before the `<button id="startBtn" ...>` line, add:

```html
      <button id="resolvedToggle" class="nav-btn" disabled>Resolved companies</button>
```

Right after `</header>`, add the popup (hidden by default):

```html
  <div id="resolvedPopup" class="popup hidden">
    <div class="popup-head">
      <h2>Resolved companies</h2>
      <button id="resolvedClose" class="clear">Close</button>
    </div>
    <div id="resolvedBody" class="popup-body"></div>
  </div>
```

- [ ] **Step 3: Style the popup**

Modify `tracker-runner/styles.css`. Add at the end of the file:

```css
.popup {
  position: fixed;
  top: 60px; right: 18px; bottom: 18px;
  width: 420px;
  background: #0d1117;
  border: 1px solid #30363d;
  border-radius: 8px;
  box-shadow: 0 8px 24px rgba(0,0,0,0.5);
  display: flex;
  flex-direction: column;
  z-index: 20;
}
.popup.hidden { display: none; }
.popup-head {
  display: flex; align-items: center; justify-content: space-between;
  padding: 12px 14px; border-bottom: 1px solid #21262d;
}
.popup-head h2 { font-size: 14px; color: #e6edf3; }
.popup-body { flex: 1; overflow-y: auto; padding: 10px 14px; }
.popup-body .tab-group { margin-bottom: 14px; }
.popup-body .tab-group h3 {
  font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em;
  color: #8b949e; margin-bottom: 6px;
}
.popup-body .company-row {
  font-size: 12.5px; color: #c9d1d9; padding: 3px 0;
  display: flex; justify-content: space-between; gap: 8px;
}
.popup-body .company-row .method { color: #58a6ff; font-size: 11px; }
.popup-empty { color: #8b949e; font-size: 13px; padding: 20px 0; text-align: center; }
```

- [ ] **Step 4: Wire the toggle in the renderer**

Modify `tracker-runner/renderer.js`. Near the top, add:

```js
const resolvedToggle = document.getElementById('resolvedToggle');
const resolvedPopup = document.getElementById('resolvedPopup');
const resolvedBody = document.getElementById('resolvedBody');
const resolvedClose = document.getElementById('resolvedClose');
let resolvedReport = null;
```

In the `onPlan` handler, add (resets the report each time a run starts):

```js
  resolvedReport = null;
  resolvedToggle.disabled = true;
```

In the `onDone` handler, add:

```js
  resolvedReport = payload.resolved || {};
  resolvedToggle.disabled = false;
```

(Note: `onDone`'s callback parameter is currently destructured as `({ ok, aborted, failures })` — change it to `({ ok, aborted, failures, resolved })` and use `resolved || {}` directly instead of `payload.resolved`.)

Add rendering + toggle logic near the bottom, before the `--- boot ---` section:

```js
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
```

- [ ] **Step 5: Manual verification**

Run: `cd tracker-runner && npm start`. Confirm "Resolved companies" is disabled before any run. Run the smoke test; confirm it stays disabled while running, becomes enabled on completion, and clicking it opens a popup listing the environmental tab's resolved firms with method tags. Click Close, then the toggle again to reopen.

- [ ] **Step 6: Commit**

```bash
git add tracker-runner/main.js tracker-runner/renderer.js tracker-runner/index.html tracker-runner/styles.css
git commit -m "tracker-runner: add post-run resolved-companies report popup"
```

---

### Task 5: `lib/dedup.js` — cross-category duplicate removal

**Files:**
- Create: `tracker-runner/lib/dedup.js`
- Create: `tracker-runner/lib/dedup.test.js`

**Interfaces:**
- Produces: `CATEGORY_ORDER: string[]` (most-specific first), `dedupCategories(categories: Object<string, {internships: Array<{company, program, ...}>}>) -> { cleaned: Object<string, {internships: Array}>, removals: Array<{company, program, from, keptIn}> }`. Consumed by Task 6 (`main.js`).

- [ ] **Step 1: Write the failing tests**

Create `tracker-runner/lib/dedup.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const { CATEGORY_ORDER, dedupCategories } = require('./dedup.js');

test('CATEGORY_ORDER puts dedicated-roster tabs before roster.json specialty tabs before agent1-5', () => {
  const idx = (id) => CATEGORY_ORDER.indexOf(id);
  assert.ok(idx('environmental') < idx('sophomore'));
  assert.ok(idx('sophomore') < idx('agent1'));
  assert.ok(idx('agent1') < idx('agent5'));
});

test('keeps a company+program pair only in the most specific category', () => {
  const categories = {
    agent1: { internships: [{ company: 'Acme', program: 'Summer Analyst' }] },
    environmental: { internships: [{ company: 'Acme', program: 'Summer Analyst' }] },
  };
  const { cleaned, removals } = dedupCategories(categories);
  assert.deepEqual(cleaned.environmental.internships, [{ company: 'Acme', program: 'Summer Analyst' }]);
  assert.deepEqual(cleaned.agent1.internships, []);
  assert.deepEqual(removals, [{ company: 'Acme', program: 'Summer Analyst', from: 'agent1', keptIn: 'environmental' }]);
});

test('is case- and whitespace-insensitive when matching keys', () => {
  const categories = {
    realestate: { internships: [{ company: 'Beta Corp', program: 'Analyst' }] },
    agent2: { internships: [{ company: '  beta corp  ', program: 'ANALYST' }] },
  };
  const { removals } = dedupCategories(categories);
  assert.equal(removals.length, 1);
  assert.equal(removals[0].from, 'agent2');
  assert.equal(removals[0].keptIn, 'realestate');
});

test('does not remove duplicates within the same category', () => {
  const categories = {
    agent1: { internships: [
      { company: 'Gamma', program: 'Analyst' },
      { company: 'Gamma', program: 'Analyst' },
    ] },
  };
  const { cleaned, removals } = dedupCategories(categories);
  assert.equal(cleaned.agent1.internships.length, 2);
  assert.equal(removals.length, 0);
});

test('leaves unrelated entries untouched and preserves non-internships fields', () => {
  const categories = {
    libraries: { name: 'Libraries & Museums', focus: 'x', internships: [{ company: 'Delta', program: 'Curator' }] },
    agent3: { name: 'Agent 3', focus: 'y', internships: [{ company: 'Epsilon', program: 'Analyst' }] },
  };
  const { cleaned, removals } = dedupCategories(categories);
  assert.equal(removals.length, 0);
  assert.equal(cleaned.libraries.name, 'Libraries & Museums');
  assert.equal(cleaned.agent3.internships.length, 1);
});

test('handles an unknown category id by processing it last', () => {
  const categories = {
    mystery: { internships: [{ company: 'Zeta', program: 'Role' }] },
    ithaca: { internships: [{ company: 'Zeta', program: 'Role' }] },
  };
  const { removals } = dedupCategories(categories);
  assert.equal(removals.length, 1);
  assert.equal(removals[0].from, 'mystery');
  assert.equal(removals[0].keptIn, 'ithaca');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd tracker-runner && node --test lib/dedup.test.js`
Expected: FAIL — `Cannot find module './dedup.js'`

- [ ] **Step 3: Implement `lib/dedup.js`**

```js
// lib/dedup.js — cross-category duplicate removal. Pure: operates on in-memory
// category data only; main.js handles all file I/O.

// Specificity order, most specific first. Mirrors analyst/lib/tab-registry.js's
// tab set, minus 'spring2027' (folded into 'fall2026' by the merge step that
// always runs before this).
const CATEGORY_ORDER = [
  'libraries', 'environmental', 'realestate', 'ithaca',
  'sophomore', 'fall2026', 'fellowships', 'china_hk',
  'agent1', 'agent2', 'agent3', 'agent4', 'agent5',
];

function keyOf(entry) {
  return `${(entry.company || '').trim().toLowerCase()}::${(entry.program || '').trim().toLowerCase()}`;
}

// categories: { [categoryId]: { internships: [...], ...rest } }
function dedupCategories(categories) {
  const order = CATEGORY_ORDER.filter((id) => id in categories);
  for (const id of Object.keys(categories)) {
    if (!order.includes(id)) order.push(id);
  }

  const claimed = new Map(); // key -> owning categoryId
  const cleaned = {};
  const removals = [];

  for (const categoryId of order) {
    const data = categories[categoryId];
    const kept = [];
    for (const entry of data.internships || []) {
      const key = keyOf(entry);
      const owner = claimed.get(key);
      if (owner === undefined) {
        claimed.set(key, categoryId);
        kept.push(entry);
      } else if (owner === categoryId) {
        kept.push(entry); // duplicate within the same category — not this feature's job
      } else {
        removals.push({ company: entry.company, program: entry.program || '', from: categoryId, keptIn: owner });
      }
    }
    cleaned[categoryId] = { ...data, internships: kept };
  }
  return { cleaned, removals };
}

module.exports = { CATEGORY_ORDER, dedupCategories };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd tracker-runner && node --test lib/dedup.test.js`
Expected: all 6 tests PASS

- [ ] **Step 5: Commit**

```bash
git add tracker-runner/lib/dedup.js tracker-runner/lib/dedup.test.js
git commit -m "tracker-runner: add cross-category dedup algorithm"
```

---

### Task 6: Wire the dedup + redeploy button into the app

**Files:**
- Modify: `tracker-runner/main.js`
- Modify: `tracker-runner/preload.js`
- Modify: `tracker-runner/renderer.js`
- Modify: `tracker-runner/index.html`
- Modify: `tracker-runner/styles.css`

**Interfaces:**
- Consumes: `dedupCategories` from Task 5. Reuses `runPipeline`'s existing engine (so it gets progress/timing/step-status/run-done/resolved-report handling for free) by adding a `dedupOnly` plan mode.
- Produces: IPC channel `start-dedup`; `preload.js` method `startDedup()`.

- [ ] **Step 1: Add category file mapping + I/O helpers**

Modify `tracker-runner/main.js`. Near `const TAB_ORDER = [...]`, add:

```js
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
```

Add the require near the top:

```js
const { dedupCategories } = require('./lib/dedup.js');
```

- [ ] **Step 2: Add a `dedupOnly` plan mode**

Modify `buildPlan` in `tracker-runner/main.js`. Currently it starts:

```js
function buildPlan(opts) {
  const mode = opts.mode === 'short' ? 'short' : 'long';
  const steps = [];
  const tabs = opts.smokeTab ? [opts.smokeTab] : TAB_ORDER;
```

Change the `tabs` line so dedup-only runs skip research entirely:

```js
  const tabs = opts.dedupOnly ? [] : (opts.smokeTab ? [opts.smokeTab] : TAB_ORDER);
```

Where the merge step is pushed:

```js
  if (!opts.smokeTab) {
    steps.push({ label: 'Merge — Fall 2026 + Spring 2027 → fall2026', kind: 'merge-fall2026', key: 'merge' });
  }
```

Change the guard to also skip on `dedupOnly` (nothing to merge — the research tabs never ran), and add the new dedup step right after:

```js
  if (!opts.smokeTab && !opts.dedupOnly) {
    steps.push({ label: 'Merge — Fall 2026 + Spring 2027 → fall2026', kind: 'merge-fall2026', key: 'merge' });
  }
  if (opts.dedupOnly) {
    steps.push({ label: 'Remove cross-category duplicates', kind: 'dedup', key: 'dedup' });
  }
```

The existing `if (!opts.skipDeploy) { ... }` deploy-tail block already runs unconditionally otherwise, which is correct — a dedup run always redeploys.

- [ ] **Step 3: Handle the `dedup` step kind in `runPipeline`**

Modify `tracker-runner/main.js`. In the finalization loop, right after the existing `if (step.kind === 'merge-fall2026') { ... continue; }` block, add:

```js
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
```

- [ ] **Step 4: Add the `start-dedup` IPC handler**

Modify `tracker-runner/main.js`. Right after the existing `ipcMain.handle('start-run', ...)` block, add:

```js
ipcMain.handle('start-dedup', (event) => {
  if (running) return { started: false, reason: 'busy' };
  running = true;
  runPipeline({ mode: 'long', dedupOnly: true }, event.sender)
    .catch(e => {
      running = false;
      event.sender.send('run-output', { stream: 'stderr', chunk: `\n[pipeline error] ${e.stack || e.message}\n` });
      event.sender.send('run-done', { ok: false, aborted: false, failures: ['pipeline error'] });
    });
  return { started: true };
});
```

- [ ] **Step 5: Bridge it in preload**

Modify `tracker-runner/preload.js`. Right after `startRun: (opts) => ipcRenderer.invoke('start-run', opts),`, add:

```js
  startDedup: () => ipcRenderer.invoke('start-dedup'),
```

- [ ] **Step 6: Add the button**

Modify `tracker-runner/index.html`. Right before `<button id="stopBtn" ...>`, add:

```html
      <button id="dedupBtn" class="dedup" title="Remove postings duplicated across categories (keeping the most specific one), then rebuild and redeploy">🧹 Dedup + redeploy</button>
```

Modify `tracker-runner/styles.css`. After the `button.clear { ... }` rule, add:

```css
button.dedup { background: #21262d; color: #d29922; border-color: #30363d; }
button.dedup:hover:not(:disabled) { background: #30363d; }
```

- [ ] **Step 7: Wire the button in the renderer**

Modify `tracker-runner/renderer.js`. Near the top, add:

```js
const dedupBtn = document.getElementById('dedupBtn');
```

At the bottom of the `onPlan` handler, add `dedupBtn.disabled = true;` (alongside the other button-disabling lines). At the bottom of the `onDone` handler, add `dedupBtn.disabled = false;`. In the `startBtn` click handler, add `dedupBtn.disabled = true;` alongside the other disables.

Add a click handler near the `startBtn`/`stopBtn` handlers:

```js
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
```

- [ ] **Step 8: Manual verification**

Run: `cd tracker-runner && npm start`. First run the smoke test so at least one category file has data. Manually add a duplicate entry (same `company`+`program`) to two different category JSON files in `../data/`. Click "🧹 Dedup + redeploy". Confirm: the console logs a `- removed ... from ... (kept in ...)` line, the step list shows "Remove cross-category duplicates" → fetch → build → deploy, and the duplicate is gone from the less-specific category's file afterward.

- [ ] **Step 9: Commit**

```bash
git add tracker-runner/main.js tracker-runner/preload.js tracker-runner/renderer.js tracker-runner/index.html tracker-runner/styles.css
git commit -m "tracker-runner: add cross-category dedup + redeploy button"
```

---

### Task 7: `lib/history.js` — per-day snapshot read/write/list

**Files:**
- Create: `tracker-runner/lib/history.js`
- Create: `tracker-runner/lib/history.test.js`

**Interfaces:**
- Produces: `dateStr(date: Date) -> 'YYYY-MM-DD'`, `snapshotPath(historyDir, date) -> string`, `writeSnapshot(historyDir, date, text) -> void`, `listSnapshotDates(historyDir) -> string[]` (sorted ascending), `readSnapshot(historyDir, date) -> string` (throws if missing). Consumed by Task 10 (`main.js`).

- [ ] **Step 1: Write the failing tests**

Create `tracker-runner/lib/history.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { dateStr, snapshotPath, writeSnapshot, listSnapshotDates, readSnapshot } = require('./history.js');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tr-history-'));
}

test('dateStr formats a Date as YYYY-MM-DD, zero-padded', () => {
  assert.equal(dateStr(new Date(2026, 0, 5)), '2026-01-05'); // month is 0-indexed
  assert.equal(dateStr(new Date(2026, 10, 23)), '2026-11-23');
});

test('snapshotPath joins the history dir and date with .json', () => {
  assert.equal(snapshotPath('/x/history', '2026-08-14'), path.join('/x/history', '2026-08-14.json'));
});

test('writeSnapshot creates the dir and file; listSnapshotDates finds it', () => {
  const dir = tmpDir();
  const nested = path.join(dir, 'history');
  writeSnapshot(nested, '2026-08-14', '{"agents":{}}');
  assert.deepEqual(listSnapshotDates(nested), ['2026-08-14']);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('writeSnapshot overwrites an existing same-day snapshot', () => {
  const dir = tmpDir();
  writeSnapshot(dir, '2026-08-14', 'first');
  writeSnapshot(dir, '2026-08-14', 'second');
  assert.equal(readSnapshot(dir, '2026-08-14'), 'second');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('listSnapshotDates returns [] for a missing directory', () => {
  assert.deepEqual(listSnapshotDates(path.join(os.tmpdir(), 'tr-history-does-not-exist')), []);
});

test('listSnapshotDates ignores non-date files and sorts ascending', () => {
  const dir = tmpDir();
  writeSnapshot(dir, '2026-08-20', 'a');
  writeSnapshot(dir, '2026-08-01', 'b');
  fs.writeFileSync(path.join(dir, 'step-timings.json'), '{}');
  fs.writeFileSync(path.join(dir, 'notadate.json'), '{}');
  assert.deepEqual(listSnapshotDates(dir), ['2026-08-01', '2026-08-20']);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('readSnapshot throws for a missing date', () => {
  const dir = tmpDir();
  assert.throws(() => readSnapshot(dir, '2026-01-01'));
  fs.rmSync(dir, { recursive: true, force: true });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd tracker-runner && node --test lib/history.test.js`
Expected: FAIL — `Cannot find module './history.js'`

- [ ] **Step 3: Implement `lib/history.js`**

```js
// lib/history.js — per-day snapshot storage backing the History calendar feature.
const fs = require('fs');
const path = require('path');

function dateStr(d) {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function snapshotPath(historyDir, date) {
  return path.join(historyDir, `${date}.json`);
}

function writeSnapshot(historyDir, date, text) {
  fs.mkdirSync(historyDir, { recursive: true });
  fs.writeFileSync(snapshotPath(historyDir, date), text);
}

function listSnapshotDates(historyDir) {
  let names;
  try { names = fs.readdirSync(historyDir); } catch (_) { return []; }
  return names
    .filter((n) => /^\d{4}-\d{2}-\d{2}\.json$/.test(n))
    .map((n) => n.slice(0, -5))
    .sort();
}

function readSnapshot(historyDir, date) {
  return fs.readFileSync(snapshotPath(historyDir, date), 'utf8');
}

module.exports = { dateStr, snapshotPath, writeSnapshot, listSnapshotDates, readSnapshot };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd tracker-runner && node --test lib/history.test.js`
Expected: all 7 tests PASS

- [ ] **Step 5: Commit**

```bash
git add tracker-runner/lib/history.js tracker-runner/lib/history.test.js
git commit -m "tracker-runner: add per-day snapshot storage (lib/history.js)"
```

---

### Task 8: `lib/htmlLoader.js` — load the live dashboard HTML without editing the Worker

**Files:**
- Create: `tracker-runner/lib/htmlLoader.js`
- Create: `tracker-runner/lib/htmlLoader.test.js`

**Interfaces:**
- Produces: `toEvaluableSource(originalSrc: string) -> string` (pure, testable with a fixture string), `loadDashboardHtml(indexJsPath: string) -> () => string` (reads a real file, throws if the expected shape isn't found). Consumed by Task 10 (`main.js`).

- [ ] **Step 1: Write the failing tests**

Create `tracker-runner/lib/htmlLoader.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { toEvaluableSource, loadDashboardHtml } = require('./htmlLoader.js');

const FIXTURE = `import BUNDLED_DATA from './data.json';
import RESUMES from './resumes.json';

export default {
  async fetch(request, env, ctx) {
    return new Response(getDashboardHTML());
  }
};

function getDashboardHTML() {
  return '<html><head><title>Fixture</title></head><body>{"looks":"like json but is a string"}</body></html>';
}
`;

test('toEvaluableSource rewrites JSON imports to const declarations', () => {
  const out = toEvaluableSource(FIXTURE);
  assert.match(out, /const BUNDLED_DATA = \{\};/);
  assert.match(out, /const RESUMES = \{\};/);
  assert.doesNotMatch(out, /^import /m);
});

test('toEvaluableSource rewrites "export default {" to "void {"', () => {
  const out = toEvaluableSource(FIXTURE);
  assert.match(out, /^void \{/m);
  assert.doesNotMatch(out, /export default/);
});

test('toEvaluableSource output is valid, evaluable script that exposes getDashboardHTML', () => {
  const out = toEvaluableSource(FIXTURE);
  const fn = new Function(`${out}\nreturn getDashboardHTML;`)();
  assert.equal(typeof fn, 'function');
  assert.match(fn(), /Fixture/);
});

test('loadDashboardHtml returns a callable that renders the real dashboard HTML', () => {
  const indexJsPath = path.join(__dirname, '..', '..', 'cloudflare-worker', 'src', 'index.js');
  const fn = loadDashboardHtml(indexJsPath);
  const html = fn();
  assert.match(html, /<title>Finance Internship Tracker<\/title>/);
});

test('loadDashboardHtml throws a clear error for a file with no import/export-default lines', () => {
  const dir = require('node:fs').mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'tr-html-'));
  const p = path.join(dir, 'plain.js');
  require('node:fs').writeFileSync(p, 'function getDashboardHTML() { return "x"; }');
  assert.throws(() => loadDashboardHtml(p), /no ESM import\/export-default lines/);
  require('node:fs').rmSync(dir, { recursive: true, force: true });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd tracker-runner && node --test lib/htmlLoader.test.js`
Expected: FAIL — `Cannot find module './htmlLoader.js'`

- [ ] **Step 3: Implement `lib/htmlLoader.js`**

```js
// lib/htmlLoader.js — loads the real getDashboardHTML() function straight out of
// cloudflare-worker/src/index.js at runtime, so the History panel always renders
// with whatever the live site's markup currently is. NEVER modifies that file:
// its ESM `import './x.json'` and `export default` lines are rewritten to plain-
// script equivalents in memory only, then evaluated with `new Function`.
const fs = require('fs');

function toEvaluableSource(originalSrc) {
  let src = originalSrc;
  src = src.replace(/^import\s+(\w+)\s+from\s+['"][^'"]+\.json['"];?\s*$/gm, 'const $1 = {};');
  src = src.replace(/^export default \{/m, 'void {');
  return src;
}

function loadDashboardHtml(indexJsPath) {
  const original = fs.readFileSync(indexJsPath, 'utf8');
  const evaluable = toEvaluableSource(original);
  if (evaluable === original) {
    throw new Error(`${indexJsPath} has no ESM import/export-default lines to rewrite — its format may have changed`);
  }
  const factory = new Function(`${evaluable}\nreturn typeof getDashboardHTML === 'function' ? getDashboardHTML : null;`);
  const fn = factory();
  if (typeof fn !== 'function') {
    throw new Error(`getDashboardHTML() not found in ${indexJsPath}`);
  }
  return fn;
}

module.exports = { toEvaluableSource, loadDashboardHtml };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd tracker-runner && node --test lib/htmlLoader.test.js`
Expected: all 5 tests PASS

- [ ] **Step 5: Commit**

```bash
git add tracker-runner/lib/htmlLoader.js tracker-runner/lib/htmlLoader.test.js
git commit -m "tracker-runner: add loader that extracts the live dashboard HTML without editing the Worker"
```

---

### Task 9: `lib/historyServer.js` — local HTTP server for the History panel

**Files:**
- Create: `tracker-runner/lib/historyServer.js`
- Create: `tracker-runner/lib/historyServer.test.js`

**Interfaces:**
- Produces: `createHistoryServer(getHtml: () => string, getSnapshotJson: () => string | null) -> http.Server`, `startHistoryServer(getHtml, getSnapshotJson) -> Promise<{ server: http.Server, port: number }>` (binds an OS-assigned port on `127.0.0.1`). Consumed by Task 10 (`main.js`).

- [ ] **Step 1: Write the failing tests**

Create `tracker-runner/lib/historyServer.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { startHistoryServer } = require('./historyServer.js');

function get(port, urlPath) {
  return new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${port}${urlPath}`, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, contentType: res.headers['content-type'], body }));
    }).on('error', reject);
  });
}

test('serves the dashboard HTML at /', async () => {
  const { server, port } = await startHistoryServer(() => '<html>hi</html>', () => null);
  const res = await get(port, '/');
  assert.equal(res.status, 200);
  assert.match(res.contentType, /text\/html/);
  assert.equal(res.body, '<html>hi</html>');
  server.close();
});

test('serves the current snapshot JSON at /api/data', async () => {
  let current = '{"agents":{}}';
  const { server, port } = await startHistoryServer(() => '<html/>', () => current);
  const res = await get(port, '/api/data');
  assert.equal(res.status, 200);
  assert.match(res.contentType, /application\/json/);
  assert.equal(res.body, '{"agents":{}}');
  server.close();
});

test('/api/data reflects a changed snapshot without restarting the server', async () => {
  let current = 'first';
  const { server, port } = await startHistoryServer(() => '<html/>', () => current);
  assert.equal((await get(port, '/api/data')).body, 'first');
  current = 'second';
  assert.equal((await get(port, '/api/data')).body, 'second');
  server.close();
});

test('returns 404 JSON at /api/data when no snapshot is selected', async () => {
  const { server, port } = await startHistoryServer(() => '<html/>', () => null);
  const res = await get(port, '/api/data');
  assert.equal(res.status, 404);
  server.close();
});

test('returns 404 for an unknown route', async () => {
  const { server, port } = await startHistoryServer(() => '<html/>', () => null);
  const res = await get(port, '/nope');
  assert.equal(res.status, 404);
  server.close();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd tracker-runner && node --test lib/historyServer.test.js`
Expected: FAIL — `Cannot find module './historyServer.js'`

- [ ] **Step 3: Implement `lib/historyServer.js`**

```js
// lib/historyServer.js — tiny local HTTP server backing the History panel's
// embedded BrowserView: '/' serves the real dashboard HTML, '/api/data' serves
// whichever snapshot is currently selected (swappable without restarting).
const http = require('http');

function createHistoryServer(getHtml, getSnapshotJson) {
  return http.createServer((req, res) => {
    const url = req.url || '/';
    if (url === '/' || url.startsWith('/?')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(getHtml());
      return;
    }
    if (url === '/api/data') {
      const json = getSnapshotJson();
      if (json == null) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'no snapshot selected' }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(json);
      return;
    }
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
  });
}

function startHistoryServer(getHtml, getSnapshotJson) {
  const server = createHistoryServer(getHtml, getSnapshotJson);
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

module.exports = { createHistoryServer, startHistoryServer };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd tracker-runner && node --test lib/historyServer.test.js`
Expected: all 5 tests PASS

- [ ] **Step 5: Run the full unit suite before moving to wiring**

Run: `cd tracker-runner && npm test`
Expected: all tests across every `lib/*.test.js` file PASS (46 tests total across Tasks 1, 3, 5, 7, 8, 9)

- [ ] **Step 6: Commit**

```bash
git add tracker-runner/lib/historyServer.js tracker-runner/lib/historyServer.test.js
git commit -m "tracker-runner: add local HTTP server for the History panel"
```

---

### Task 10: Wire the calendar + History panel into the app

**Files:**
- Modify: `tracker-runner/main.js`
- Modify: `tracker-runner/preload.js`
- Modify: `tracker-runner/renderer.js`
- Modify: `tracker-runner/index.html`
- Modify: `tracker-runner/styles.css`

**Interfaces:**
- Consumes: `history.*` from Task 7, `loadDashboardHtml` from Task 8, `startHistoryServer` from Task 9.
- Produces: IPC channels `list-history-dates`, `view-history`, `history-set-bounds`, `history-set-visible`; `preload.js` methods `listHistoryDates()`, `viewHistory(date)`, `historySetBounds(bounds)`, `historySetVisible(visible)`, `onHistoryNavState(cb)` — mirrors the existing debug-browser bridge shape.

- [ ] **Step 1: Snapshot on every successful, non-smoke run**

Modify `tracker-runner/main.js`. Add requires near the top:

```js
const history = require('./lib/history.js');
const HISTORY_DIR = path.join(__dirname, 'history');
```

In `runPipeline`, right after the existing:

```js
  log(`\n=== Run ${aborted ? 'STOPPED' : ok ? 'COMPLETE ✓' : 'finished with failures'} ===\n`);
  if (failures.length) log(`Failed steps:\n${failures.map(f => `  ✗ ${f}`).join('\n')}\n`, 'stderr');
```

add:

```js
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
```

(This runs for both normal full runs and `dedupOnly` runs, since both go through `runPipeline` and both rebuild `cloudflare-worker/src/data.json` in their deploy tail — matching the spec's "the dedup+redeploy action also snapshots on success, same rule".)

- [ ] **Step 2: Add the History BrowserView**

Modify `tracker-runner/main.js`. Near `let debugView = null;`, add:

```js
let historyView = null;
let historyServerHandle = null;
let historyServerPort = null;
let currentHistoryDate = null;
```

Right after the `createDebugView` function definition, add an analogous view creator:

```js
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
```

In `createWindow`, right after `createDebugView(win);`, add `createHistoryView(win);`.

- [ ] **Step 3: Add the history IPC handlers**

Modify `tracker-runner/main.js`. Add requires near the top:

```js
const historyServer = require('./lib/historyServer.js');
const htmlLoader = require('./lib/htmlLoader.js');
```

At the end of the file, alongside the other `ipcMain.handle(...)` calls, add:

```js
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
```

Add cleanup in the existing `app.on('window-all-closed', ...)` handler — change:

```js
app.on('window-all-closed', () => {
  for (const c of children) { try { c.kill(); } catch (_) {} }
  if (process.platform !== 'darwin') app.quit();
});
```

to:

```js
app.on('window-all-closed', () => {
  for (const c of children) { try { c.kill(); } catch (_) {} }
  if (historyServerHandle) { try { historyServerHandle.close(); } catch (_) {} }
  if (process.platform !== 'darwin') app.quit();
});
```

- [ ] **Step 4: Bridge the new IPC in preload**

Modify `tracker-runner/preload.js`. After the existing `browserSetVisible`/`onBrowserNavState` block, add:

```js
  // --- History panel (calendar-selected snapshot, same BrowserView pattern) ---
  listHistoryDates: () => ipcRenderer.invoke('list-history-dates'),
  viewHistory: (date) => ipcRenderer.invoke('view-history', date),
  historySetBounds: (bounds) => ipcRenderer.invoke('history-set-bounds', bounds),
  historySetVisible: (visible) => ipcRenderer.invoke('history-set-visible', visible),
```

- [ ] **Step 5: Add the calendar button + History panel markup**

Modify `tracker-runner/index.html`. Right before `<button id="resolvedToggle" ...>`, add:

```html
      <button id="calendarToggle" class="nav-btn">📅 History</button>
```

Add the calendar popover right after the `resolvedPopup` div:

```html
  <div id="calendarPopup" class="popup calendar-popup hidden">
    <div class="popup-head">
      <h2>Past runs</h2>
      <button id="calendarClose" class="clear">Close</button>
    </div>
    <div id="calendarBody" class="popup-body"></div>
  </div>
```

Add a third panel tab and panel body — in `.panel-tabs`, right after `<button class="panel-tab" id="tabBrowser" data-panel="browser">Browser</button>`, add:

```html
        <button class="panel-tab" id="tabHistory" data-panel="history">History</button>
```

Right after the closing `</div>` of `browserPanel`, add:

```html
      <div id="historyPanel" class="panel-body hidden">
        <div id="historyEmptyState" class="popup-empty hidden">No past runs saved yet — run a refresh first.</div>
        <div id="historyViewSlot"></div>
      </div>
```

- [ ] **Step 6: Style the calendar**

Modify `tracker-runner/styles.css`. Add at the end of the file:

```css
.calendar-popup { width: 300px; }
.calendar-month {
  display: flex; align-items: center; justify-content: space-between;
  padding: 4px 0 10px; font-size: 13px; color: #e6edf3;
}
.calendar-month button { background: none; border: none; color: #8b949e; cursor: pointer; font-size: 14px; }
.calendar-grid { display: grid; grid-template-columns: repeat(7, 1fr); gap: 4px; }
.calendar-day {
  aspect-ratio: 1; display: flex; align-items: center; justify-content: center;
  font-size: 12px; border-radius: 4px; color: #484f58;
}
.calendar-day.has-snapshot { color: #c9d1d9; background: #161b22; cursor: pointer; }
.calendar-day.has-snapshot:hover { background: #1f6feb; color: #fff; }
.calendar-day.selected { background: #1f6feb; color: #fff; }
#historyPanel { position: relative; }
#historyViewSlot {
  flex: 1; min-height: 0; margin: 0 16px 12px;
  border: 1px solid #21262d; border-radius: 6px; background: #fff;
}
```

- [ ] **Step 7: Wire the calendar in the renderer**

Modify `tracker-runner/renderer.js`. Near the top, add:

```js
const calendarToggle = document.getElementById('calendarToggle');
const calendarPopup = document.getElementById('calendarPopup');
const calendarBody = document.getElementById('calendarBody');
const calendarClose = document.getElementById('calendarClose');
const historyPanel = document.getElementById('historyPanel');
const historyEmptyState = document.getElementById('historyEmptyState');
const historyViewSlot = document.getElementById('historyViewSlot');
let historyDates = [];
let selectedHistoryDate = null;
```

Add rendering + selection logic near the resolved-popup logic:

```js
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
  switchPanel('history');
}
calendarToggle.addEventListener('click', async () => {
  await refreshHistoryDates();
  renderCalendar();
  calendarPopup.classList.toggle('hidden');
});
calendarClose.addEventListener('click', () => calendarPopup.classList.add('hidden'));
```

The existing panel-tab switching logic (Console/Browser) is inline in a `forEach` block:

```js
panelTabs.forEach(t => t.addEventListener('click', () => {
  panelTabs.forEach(x => x.classList.toggle('active', x === t));
  Object.entries(panels).forEach(([name, el]) => el.classList.toggle('hidden', name !== t.dataset.panel));
  browserVisible = t.dataset.panel === 'browser';
  window.api.browserSetVisible(browserVisible);
  if (browserVisible) requestAnimationFrame(sendBrowserBounds);
}));
```

Replace it with a named `switchPanel` function plus a click-driven call, and extend `panels` to include `history`:

```js
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

function switchPanel(name) {
  panelTabs.forEach(x => x.classList.toggle('active', x.dataset.panel === name));
  Object.entries(panels).forEach(([n, el]) => el.classList.toggle('hidden', n !== name));
  browserVisible = name === 'browser';
  window.api.browserSetVisible(browserVisible);
  if (browserVisible) requestAnimationFrame(sendBrowserBounds);
  historyVisible = name === 'history';
  window.api.historySetVisible(historyVisible);
  historyEmptyState.classList.toggle('hidden', !(name === 'history' && !historyDates.length));
  if (historyVisible) requestAnimationFrame(sendHistoryBounds);
}
panelTabs.forEach(t => t.addEventListener('click', () => switchPanel(t.dataset.panel)));
```

(Note: `const panels = {...}` and `let browserVisible = false;` already exist earlier in the file under `// --- Console/Browser tabs ---` — remove that earlier `const panels = {...}` declaration and the old inline `panelTabs.forEach(...)` handler being replaced, since they're superseded by the block above. Keep the existing `let browserVisible = false;` line as-is; it's still used.)

In the `onDone` handler, add `refreshHistoryDates();` (so a snapshot just written by this run becomes selectable immediately) — call it without `await` since `onDone`'s callback isn't async; wrap as `refreshHistoryDates().catch(() => {});`.

In the `--- boot ---` IIFE, after `refreshPlan();`, add:

```js
  await refreshHistoryDates();
  historyEmptyState.classList.toggle('hidden', historyDates.length > 0);
```

- [ ] **Step 8: Manual verification**

Run: `cd tracker-runner && npm start`. Confirm the History tab shows the "No past runs saved yet" empty state before any run. Run the smoke test to completion. Click "📅 History" — confirm today's date now appears as a clickable cell. Click it — confirm the app switches to the History tab and shows the real tracker site UI (password gate included) with that day's snapshot data. Resize the window and confirm the embedded view's bounds track correctly, same as the existing Browser tab does.

- [ ] **Step 9: Commit**

```bash
git add tracker-runner/main.js tracker-runner/preload.js tracker-runner/renderer.js tracker-runner/index.html tracker-runner/styles.css
git commit -m "tracker-runner: add history calendar + embedded-site History panel"
```

---

## Self-Review Notes

- **Spec coverage:** Feature 1 → Tasks 1–2. Feature 2 → Tasks 3–4. Feature 3 → Tasks 5–6. Feature 4 → Tasks 7–10. All four spec sections have corresponding tasks.
- **Type/name consistency checked:** `key` field introduced in Task 2 is used identically in Tasks 6 and 10's new steps (`key: 'dedup'`); `CATEGORY_ORDER`/`CATEGORY_FILES` share the same category id strings across Tasks 5 and 6; `resolved`/`resolvedThisRun`/`groupResolved` naming is consistent between Task 4's main.js and renderer.js changes; `historyView`/`historyServerHandle`/`historyServerPort`/`currentHistoryDate` names are used consistently within Task 10.
- **No placeholders:** every step above contains literal, complete code — no "add appropriate tests" or "similar to Task N" shortcuts.

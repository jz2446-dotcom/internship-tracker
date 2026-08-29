# Shared Firecrawl budget + cloud-scheduled refresh — design

Date: 2026-08-29
Component: `analyst/` (research engine) + `tracker-runner/` (Electron app) +
`cloudflare-worker/` (deploy target) + new `.github/workflows/`

## Context

Two problems surfaced while investigating why the Aug 27 refresh missed 66% of
agent1-5's roster (137/207 companies, including Honeywell):

1. **`FIRECRAWL_RUN_CAP` is a per-tab silo, not a real budget.** `tracker-runner/main.js`
   sets it to `10` in parallel mode (`PARALLEL_ENV`) and `60` in sequential mode
   (`seqEnv`). With 14 tabs running simultaneously in parallel mode, a tab stuck with
   several hard-to-resolve companies exhausts its 10-call allowance quickly and falls
   back to plain-fetch (which fails silently on JS-rendered career sites), while a tab
   full of easy ATS-matched companies never uses its allowance at all. The cap doesn't
   move to where it's needed.
2. **The whole pipeline only runs if the laptop is on, unlocked, and awake.** There's no
   way today to get a refresh to happen unattended — Windows sleep/wake-timer behavior
   on a laptop with the lid closed is unreliable (already bit the labor-dashboard
   project's scheduled task).

Both are being fixed together because the cloud-refresh piece changes which execution
mode (parallel vs. sequential) is even viable: **GitHub-hosted Actions runners hard-cap
a job at 6 hours** (platform limit, not configurable). The existing headless CLI replica
`analyst/_full_refresh_driver.js` runs all 14 tabs *sequentially* — at observed per-tab
durations (`tracker-runner/history/step-timings.json`) that sums to ~23 hours, which
would never complete in CI. The cloud job therefore needs tab-level concurrency similar
to the Electron app's parallel mode, which is exactly the mode where the per-tab
Firecrawl cap causes today's coverage gap. Fixing the budget mechanism is a prerequisite
for the cloud job being useful, not a separate nice-to-have.

## What "done" looks like

- A single Firecrawl budget is shared across however many tabs are running at once, in
  both the Electron app and the headless driver — no per-tab silo.
- Re-running the same day (e.g. a manual run after last night's scheduled one) doesn't
  re-spend Firecrawl budget on pages that haven't changed.
- `.github/workflows/refresh.yml` can run the full 14-tab pipeline unattended, on a
  schedule, entirely on GitHub's infrastructure, and pushes updated `data/*.json` +
  deploys the Cloudflare Worker — with zero dependency on the user's computer being on.
- The Tracker Runner Electron app gains a "Schedule" section where the user sets how
  often the unattended refresh should run; that setting takes effect on the next
  scheduled tick without editing YAML or touching GitHub's UI.
- The existing Electron app keeps working exactly as it does today for on-demand runs.

## Changes, by file

### 1. `analyst/lib/firecrawl-budget.js` (new) — shared, file-locked daily counter

Replaces the per-process `FIRECRAWL_RUN_CAP` env var read in `scrape.js`. Tracks spend
in `data/_firecrawl_budget.json`: `{ "date": "2026-08-29", "used": 137 }`.

```js
const LIMIT = parseInt(process.env.FIRECRAWL_DAILY_BUDGET || "450", 10);
function tryReserve() {
  const today = new Date().toISOString().slice(0, 10);
  return withFileLock(BUDGET_FILE, (state) => {
    if (!state || state.date !== today) state = { date: today, used: 0 };
    if (state.used >= LIMIT) return { ok: false, state };
    state.used += 1;
    return { ok: true, state };
  });
}
module.exports = { tryReserve };
```

`withFileLock` does read-modify-write with a `.lock` sidecar file (retry-with-backoff on
lock contention) — the same pattern already used by `search.js`'s `saveCache()`
merge-on-save, just with an exclusive lock instead of last-write-wins, since a counter
can't tolerate two processes overwriting each other's increment.

`LIMIT` defaults to 450 (safely under Firecrawl's ~500/mo free-tier credits, leaving
headroom for the rare day with two runs).

### 2. `analyst/lib/scrape.js` — call the shared budget instead of the env cap

```diff
- const RUN_CAP = Math.max(0, parseInt(process.env.FIRECRAWL_RUN_CAP || "60", 10) || 60);
+ const budget = require("./firecrawl-budget");
...
- if (used >= RUN_CAP) {
-   if (!capLogged) { capLogged = true; console.error(`  firecrawl run cap (${RUN_CAP}) reached — remaining thin pages use plain-fetch text`); }
+ const reserved = budget.tryReserve();
+ if (!reserved.ok) {
+   if (!capLogged) { capLogged = true; console.error(`  firecrawl daily budget (${reserved.limit}) exhausted — remaining thin pages use plain-fetch text`); }
```

`used` (the local in-process counter) is removed; the shared file is the single source
of truth so concurrent tab processes see each other's spend in real time.

### 3. `analyst/lib/scrape-cache.js` (new) — 24h content cache

Same shape as `search.js`'s existing cache (`data/_scrape_content_cache.json`,
merge-on-save, TTL check on read), but keyed by URL and holding the rendered page text
Firecrawl returned. `firecrawl(url)` checks this cache before spending budget; a hit
within 24h skips the network call and the budget reservation entirely. TTL is
deliberately short (postings do change day-to-day) — this only helps the case that
actually matters here: two runs (manual + scheduled, or a retry) on the *same calendar
day* re-scraping the same unchanged page.

### 4. `tracker-runner/main.js` — drop the per-tab cap

Remove `FIRECRAWL_RUN_CAP` from both `PARALLEL_ENV` and `seqEnv`. Nothing else in the
buildPlan/runStep logic needs to change — the budget is now process-external.

### 5. `analyst/_full_refresh_driver.js` — make it concurrency-capable, reusable by CI

Today this is sequential-only (`seqEnv`, no parallelism) and is the intended entry point
for the GitHub Actions job, but sequential mode's ~23h wall-clock exceeds the 6h Actions
job limit. Give it the same tab-concurrency behavior `main.js`'s `buildPlan` has: accept
a `--parallel` flag that runs all 14 `run-analyst.js` children as concurrent
`child_process.spawn` calls (not `spawnSync`) instead of one at a time, using
`ANALYST_*_CONC` values matched to CI's runner resources (2 vCPU on standard GitHub
runners — lower per-tab concurrency than the user's desktop, e.g.
`ANALYST_BROWSE_CONC=2`, tab-level parallelism capped around 6-8 simultaneous tabs
rather than all 14, to avoid starving each other on 2 cores). This keeps wall-clock
under 6h without needing the aggressive `FIRECRAWL_RUN_CAP: '10'` that caused today's
coverage gap — the shared budget (change #1) is what keeps Firecrawl spend in check now,
not concurrency-driven rationing.

### 6. `.github/workflows/refresh.yml` (new)

```yaml
name: Scheduled refresh
on:
  schedule:
    - cron: '0 */2 * * *'   # ticks every 2h; schedule-config.json decides whether to actually run
  workflow_dispatch: {}
jobs:
  refresh:
    runs-on: ubuntu-latest
    timeout-minutes: 350   # stay under the 360min (6h) platform hard cap
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '20' }
      - run: npm ci
        working-directory: analyst
      - run: npx playwright install --with-deps chromium
        working-directory: analyst
      - run: node check-schedule.js   # exits 0 with a "skip" marker file if not due yet
        working-directory: analyst
      - run: node _full_refresh_driver.js --parallel
        if: steps.check.outputs.due == 'true'
        working-directory: analyst
        env:
          TAVILY_API_KEY: ${{ secrets.TAVILY_API_KEY }}
          FIRECRAWL_API_KEY: ${{ secrets.FIRECRAWL_API_KEY }}
          NIM_API_KEY: ${{ secrets.NIM_API_KEY }}
      - run: node build-data.js
        if: steps.check.outputs.due == 'true'
        working-directory: cloudflare-worker
      - run: npx wrangler deploy
        if: steps.check.outputs.due == 'true'
        working-directory: cloudflare-worker
        env:
          CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
      - run: |
          git config user.name "tracker-bot"
          git config user.email "actions@github.com"
          git add data/ cloudflare-worker/src/data.json
          git diff --cached --quiet || git commit -m "Scheduled refresh $(date -u +%F)"
          git push
        if: steps.check.outputs.due == 'true'
```

Secrets (`TAVILY_API_KEY`, `FIRECRAWL_API_KEY`, `NIM_API_KEY`, `CLOUDFLARE_API_TOKEN`)
are added once via the GitHub repo's Settings → Secrets — `keyfile.js`'s existing
"env var first" check picks them up with no code change; the OneDrive `.env` fallback
path simply never resolves (and never needs to) in CI.

The cron ticks every 2 hours regardless of cadence — cheap no-op runs when not due are
the mechanism that lets cadence be user-adjustable without editing this file (see #8).

### 7. `analyst/check-schedule.js` (new) — cadence gate

Reads `data/_schedule_config.json` (`{ "cadenceHours": 24 }`, default written if
missing) and `data/changelog.json`'s most recent entry's date. If less than
`cadenceHours` have elapsed, writes `due=false` to `$GITHUB_OUTPUT` and the job's
remaining steps (guarded by `if: steps.check.outputs.due == 'true'`) skip, costing only
the ~10s of checkout + setup-node.

### 8. `tracker-runner/` — Schedule section in the Electron app

New UI section (`index.html`/`renderer.js`/`main.js`, alongside the existing Dedup
button) with a dropdown (Daily / Twice daily / Every 3 days / Custom hours) writing
`data/_schedule_config.json` and running `git add data/_schedule_config.json && git
commit -m "Update refresh cadence" && git push` through the same child_process pattern
`main.js` already uses for other steps. The next time the Actions cron ticks (within 2h
worst case), `check-schedule.js` reads the new value.

## Error handling

- **Firecrawl budget exhausted mid-run:** unchanged from today's behavior — falls back
  to plain-fetch text for the rest of that run, logged once. Not a hard failure.
- **File lock contention on `_firecrawl_budget.json`:** retry with capped exponential
  backoff (5 attempts, ~50ms-800ms); on total failure, fail open (treat as budget
  available) rather than blocking the scrape — a rare double-count is a one-request
  overspend, not worth stalling a tab over.
- **GitHub Actions job failure:** default GitHub behavior (email to repo owner) is
  sufficient — no custom notification wired up, matching how the rest of this project's
  local automation surfaces failures (visible in the app's log panel) rather than
  pushing alerts elsewhere.
- **Push race** (schedule-config push from the Electron app lands mid-way through a
  running Actions job that also pushes data changes at the end): the Actions step's
  `git push` uses the default fast-forward push; if it's been superseded it fails
  visibly in the job log rather than force-pushing. Acceptable since a lost data-commit
  just means those companies get re-confirmed next tick, not silently dropped (the
  carry-forward mechanism in `run-analyst.js` still applies).

## Testing

- `workflow_dispatch` lets the user manually fire the Actions workflow from GitHub's UI
  to validate end-to-end before trusting the cron.
- `check-schedule.js` and `firecrawl-budget.js` are pure functions over a JSON file —
  straightforward to unit test with a temp file path override.
- A local dry run of `_full_refresh_driver.js --parallel` (same machine, same code path
  CI uses) validates the concurrency change before it's ever exercised unattended.

## Out of scope

- Migrating the resume-matching / control-panel Electron app or any other local tool to
  the cloud — only the research-refresh-deploy pipeline moves.
- A hosted (non-Electron) web UI for the schedule setting — it's a section in the
  existing desktop app, consistent with how the rest of this project's controls work.
- Retrying/alerting logic beyond GitHub's built-in job-failure email — no Slack/SMS/etc.
  integration.
- Self-hosted runners or paid GitHub Actions minutes to lift the 6h limit — the
  concurrency change in #5 is scoped to fit comfortably under the free-tier limit
  instead.

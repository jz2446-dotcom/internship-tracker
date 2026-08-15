# Tracker Runner — four new features

Date: 2026-08-14
Component: `tracker-runner/` (Electron app) + small touches in `analyst/` (none needed) and `cloudflare-worker/`

Checkpoint commit before this work: `ec147390` ("Checkpoint before tracker-runner UI features...").

## Context

`tracker-runner` is the one-click Electron app that drives a full refresh of the
finance-internship tracker: it launches the analyst engine's research passes
per tab (`main.js` → `run-analyst.js`), merges fall/spring, rebuilds the data
bundle (`cloudflare-worker/build-data.js`), and deploys via `wrangler deploy`.
The renderer (`renderer.js`/`index.html`) shows a step list and a streaming
console; there is no progress %, no post-run summary, no dedup tooling, and no
history browsing today.

This spec adds four independent features to that app.

## Feature 1 — Progress bar + time clock

**Goal:** a header bar showing elapsed time and an estimated % complete for
the current run.

**Data:** `tracker-runner/history/step-timings.json` — a flat map from a
step's stable key (tab id for research steps; `merge`, `fetch-baseline`,
`build`, `deploy` for the rest) to an exponential moving average duration in
ms (`ema = 0.3*thisRun + 0.7*emaPrev`, seeded with the first observed value).
Updated by `main.js` at the end of every run (only for steps that actually
completed — `done` or `failed`, not `skipped`/`stopped`).

**Progress math (renderer):** on `plan`, look up each planned step's EMA
duration (default: the mean of whatever EMAs exist yet, or equal weight 1 if
the file is empty/missing — degrades gracefully on the very first run).
`percent = doneWeight / totalWeight`, where a `running` step counts as 50% of
its own weight (avoids the bar sitting still for the whole duration of a long
step). Recomputed on every `step-status` event and once a second while
running (for the time clock). Elapsed time is plain `Date.now() - runStart`
tracked in the renderer; not persisted.

**UI:** a slim bar + `mm:ss elapsed · ~NN%` label under the existing
mode-hint line. Hidden (or reset to 0/"Ready") when not running.

**Error handling:** malformed/missing `step-timings.json` → treated as empty
map, never throws. Write is best-effort (wrapped in try/catch); a failure to
persist timings never fails the run.

## Feature 2 — Post-run "resolved companies" report

**Goal:** a toggle that opens a popup listing every company the engine
resolved during the run just finished, grouped by tab. Empty/inert while a
run is in progress — populated only after `run-done`.

**Data source:** no analyst-engine changes. `run-analyst.js` already logs one
line per resolved firm to stderr:
```
✓ REG  <company> → <provider>/<slug> (<n>)
✓ ATS  <company> (<provider>/<slug>, <n>)
✓ SRCH <company> → <provider>/<slug> (<n>)
✓ WEB  <company> → <provider>/<slug> (<n>)
✓ WEB  <company> → scraped <url>
✓ WEB  <company> → sniffed API (<n>)
```
and `main.js`'s `tagChunk` already prefixes every line with `[tabId] `. In
`runStep`, alongside the existing `sender.send('run-output', ...)`, parse each
chunk line-by-line with a regex matching the `✓ TAG  company → ...` shape,
and accumulate `{ tab, method, company, detail }` into an in-memory array
(`resolvedThisRun`) scoped to the current pipeline run — reset at the start
of `runPipeline`. This array is what's shown; nothing is written to disk (a
regenerable-from-console artifact, not data worth persisting).

**IPC:** a new `get-resolved-report` handle (or just include it in the
existing `run-done` payload) returning `resolvedThisRun` grouped by tab.

**UI:** a toggle button in the header (e.g. "Resolved companies"). Clicking
while `running` shows a disabled/placeholder state ("available when the run
finishes"). After `run-done`, clicking opens a modal/popup: one collapsible
section per tab, each row `company — method (provider/slug)`. Closed by
clicking the toggle again or an explicit close control.

## Feature 3 — Cross-category dedup + redeploy button

**Goal:** a button that removes postings duplicated across categories,
keeping each in only its most-specific category, then rebuilds and deploys.

**Specificity order** (most → least specific; first match wins when a
`company::program` key — lowercased, trimmed — appears in more than one):
1. Dedicated-roster tabs: `libraries`, `environmental`, `realestate`, `ithaca`
2. `roster.json` specialty tabs: `sophomore`, `fall2026` (post-merge, i.e.
   the already-merged fall/spring file), `fellowships`, `china_hk`
3. General segment tabs: `agent1`..`agent5`

**Algorithm** (new function in `main.js`, e.g. `dedupCategories(log)`):
1. Read every category's `<agent>_results.json` from `DATA_DIR`.
2. Walk categories in specificity order; for each internship entry, compute
   `key = company::program` (lowercased/trimmed); if `key` already claimed by
   an earlier (more specific) category, drop this entry and log
   `- removed <company> / <program> from <thisCategory> (kept in <ownerCategory>)`;
   otherwise claim the key for this category and keep the entry.
3. Write back only the category files that actually lost entries.
4. Log a one-line summary: `N duplicates removed across M categories`.

**Then:** run the existing fetch-baseline → `build-data.js` →
`wrangler deploy` steps (same step objects `buildPlan` already constructs for
the tail of a normal run), so the live site reflects the cleanup immediately.

**Guard:** disabled while `running` is true (same mutex as Start).

**UI:** a new button next to Start/Stop, e.g. "🧹 Dedup + redeploy". Streams
its own log output through the existing console pane; uses the existing step
list rendering for the fetch/build/deploy tail so progress is visible the
same way a normal run's tail is.

## Feature 4 — Calendar / history browser

**Goal:** a calendar in the header; picking a date with a saved snapshot
opens a "History" panel showing the real site UI, frozen at that date's data.

**Snapshotting:** after a successful (`ok === true`), non-smoke-test deploy,
`main.js` copies the just-built `cloudflare-worker/src/data.json` to
`tracker-runner/history/<YYYY-MM-DD>.json` (local date, overwritten if the
pipeline runs again the same day — one snapshot per calendar day, matching
the calendar's day granularity). The dedup+redeploy action in Feature 3 also
snapshots on success, same rule.

**Calendar UI:** a compact month calendar in the header (button opens a
small popover, doesn't take permanent header space). Dates with a snapshot
file present render enabled/highlighted; all others are greyed out and
unclickable. Built by listing `tracker-runner/history/*.json` on demand (IPC
`list-history-dates`) — no separate index file needed, the directory listing
is the source of truth.

**Viewing a date:** new third panel tab "History" (next to Console/Browser,
same `.panel-tab` pattern already used for Browser). Selecting a calendar
date:
1. IPC `view-history(date)` in main: starts (once, lazily) a local
   `http.createServer` on an ephemeral port. Route `/`: returns the literal
   `getDashboardHTML()` string exported from
   `cloudflare-worker/src/index.js` (imported directly — it's a pure
   function with no Worker-runtime dependencies for HTML generation). Route
   `/api/data`: returns the content of `tracker-runner/history/<date>.json`
   for whatever date was last selected (server keeps the "current date" in a
   closure variable, updated per `view-history` call — no need to restart
   the server per date change). Other routes 404.
2. Main navigates a BrowserView (reusing the same debug-view machinery as
   the existing "Browser" tab, or a second BrowserView instance bounded to
   the same panel slot) to `http://localhost:<port>/`.
3. Renderer switches to the History tab and reports bounds via the existing
   ResizeObserver pattern, same as the Browser panel does today.

The site's own password gate (NCI2026$) still applies inside this embedded
view — it's the real HTML, unmodified. `/resume/*` requests will 404 (no
resumes bundled locally) — acceptable, out of scope for this feature.

**Fallback:** if `tracker-runner/history/` has zero snapshots yet (fresh
install, before this feature's first successful run), the calendar button is
present but shows no enabled dates and the History tab shows an empty-state
message instead of erroring.

## Out of scope

- Pruning/rotation of old `history/*.json` snapshots (sizes are small —
  a few hundred KB each — not worth the complexity now).
- Any change to the live public site itself (Feature 4 is Runner-app-only,
  per explicit decision).
- True in-flight "currently searching" tracking (Feature 2 is a post-run
  report only, per explicit decision) — no `run-analyst.js` changes at all.

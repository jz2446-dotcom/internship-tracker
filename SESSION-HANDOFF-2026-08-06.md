# Session Handoff — 2026-08-06

Hand this to a fresh Claude Code session to continue. Everything below is current as of end of this session.
Project root: `C:\Users\justi\Downloads\Internship Searcher\Internship Tracker`. This session's work is entirely in `analyst/` and `tracker-runner/` (the zero-token research engine + its Electron runner), not the older résumé/Opus-verification workflow described in `HANDOFF.md` — that file is stale relative to the current architecture and shouldn't be trusted for how the engine currently works.

---

## 0. TL;DR of where things stand

- Investigated why refreshes were slow and why some companies (Microsoft, PNC Bank) never showed results. Fixed the real bottleneck (serial single-session browser pass), added Workday ATS support, and built a brand-new **generic, zero-token "network sniffer"** that catches companies on bespoke career portals by mining their own background JSON API calls.
- Found and fixed two real correctness bugs already live in production data: a fall2026/spring2027 duplicate-posting bug, and an overly-broad heuristic regex that was letting non-finance tech roles (Palantir/Databricks/Roblox SWE internships) leak into the Big Tech Corporate Finance tab.
- Built a **persistent company→ATS-convention registry** (`data/_company_conventions.json`) so future runs never re-discover a company from scratch — a huge speed win going forward.
- Ran a **partial** one-time discovery sweep to pre-populate that registry: **215 of 550** unique companies across every roster are now recorded (39%). 335 remain. Batches 0-3 of a planned 10-batch sweep are done; batches 4-9 were never run.
- **Nothing has reached the live site or the packaged app yet.** All code changes are live in the engine (reads `analyst/` straight off disk), but no real refresh + deploy has happened this session, and the packaged `Tracker Runner 1.0.0.exe` is stale (missing the `main.js` dedup fix — see §5).

---

## 1. What changed in the engine (all in `analyst/`, effective immediately — no build step needed)

### `analyst/lib/ats.js` — added Workday support
Only Ashby/Greenhouse/Lever were supported before. Added a `workday()` adapter using Workday's public CXS API (`https://{tenant}.{wdN}.myworkdayjobs.com/wday/cxs/{tenant}/{site}/jobs`). Two real bugs found and fixed while building this (verified live against PNC's actual board, not guessed):
- The API 400s above `limit=20` per page (not documented anywhere — found by trial).
- The API's `total` field is only accurate on the FIRST page; every later page reports `total:0`. The first version of this code re-read `total` every page and stopped after page 2 every time. Fixed to capture it once.

Not guessable from a company name (the `wdN` subdomain number and `site` slug are per-tenant arbitrary), so `workday` is NOT in the guess-by-name `PROVIDERS` list — only reachable via a discovered slug (search pass or browse pass finding a `myworkdayjobs.com` link).

### `analyst/lib/browse.js` — Workday detection + one-hop link-following + sniffer wiring
- `detectAts()` now recognizes `*.wdN.myworkdayjobs.com/{site}` links and builds the compound `tenant|wdHost|site` slug the adapter needs.
- `pageProbe()` (new) — combined ATS-link + single-JobPosting-JSON-LD check in ONE `page.evaluate` call instead of two (each `pw` call is a separate `playwright-cli` subprocess spawn — this roughly halves per-URL cost).
- `pickJobsSearchLink()` + one-hop follow in `findFirm()` — if a landing page (e.g. a company's "university internships" overview) has no direct hit, follows one same-company "search/jobs/apply" link before giving up on that URL, mimicking a human clicking "Search jobs." Matches on registrable domain (last two hostname labels), not strict origin, since the real page is often on a different subdomain (Microsoft's actual API is `apply.careers.microsoft.com`, not `careers.microsoft.com`).
- `probePage()` also now tries `sniff.sniffJobsApi()` as a last resort per URL.

### `analyst/lib/sniff.js` — NEW. Generic, zero-token bespoke-portal detector
The key idea: rather than hardcoding every ATS vendor, mine whatever JSON API a rendered page's OWN JavaScript already called (via `playwright-cli`'s `requests` / `response-body` — no extra page load, reuses the `goto()` that already happened), and recognize "this looks like a job list" purely by **shape**: an array of ≥3 objects sharing a title-like field (`title`/`name`/`jobTitle`/...) paired with a location-, URL-, or id-like field. No vendor knowledge, no LLM.

Validated live against Microsoft's real API (`apply.careers.microsoft.com/api/pcsx/search`) before wiring in. Found and fixed a real false-positive during testing: a nav-menu array (`{name, id}` objects) initially matched the shape check; tightened id-only matches to require digit-heavy values (`looksLikeJobId()`).

Sniffed postings are **not** auto-trusted as open the way a known ATS board is — they route through the exact same `classify.routeAtsPosting` title/finance gate as everything else in `run-analyst.js`, tagged `source: "browse-sniff"`.

Live-verified catching (via the discovery sweep, not synthetic tests): KKR, Vanguard, JPMorgan Chase, Apple, Amazon, Oracle, Qualcomm, IBM, ExxonMobil, Chevron, Dell, Palo Alto Networks, Walmart, UnitedHealth Group, American Express, Deere & Company, Northrop Grumman, European Bank for Reconstruction and Development, and more.

**Known limitation, not fixed**: Microsoft itself still doesn't resolve end-to-end. Its real search page lives on a THIRD subdomain (`jobs.careers.microsoft.com`) that nothing on the site links to — it needs an actual UI interaction (typing into a search box), not just navigation. Didn't special-case it since it wouldn't generalize.

### `analyst/lib/registry.js` — NEW. Persistent company→convention memory
`data/_company_conventions.json`, no TTL (a company's ATS platform choice almost never changes). Entry shape:
```
known ATS:  { provider: "greenhouse"|"lever"|"ashby"|"workday", slug, discovered, via }
bespoke:    { provider: "sniff", hintUrl, discovered, via }
```
`get(company)`, `record(company, entry, via)`, `forget(company)`. Merge-on-save (same pattern as `lib/search.js`'s cache) so parallel tab processes never clobber each other.

**Wired into `run-analyst.js` as Pass 0**, before the old Pass 1: a registered known-ATS company skips straight to `ats.fetchBySlug()` — zero guessing, zero browser. A registered "sniff" company skips Pass 1's guessing AND Pass 1.5's search entirely, going straight to Pass 2 with its hint URL already set. **Self-healing**: if a stored convention stops returning postings (company migrated platforms), it's `forget()`'d and the firm falls through to full rediscovery, which then re-records whatever's found.

Verified end-to-end: ran PNC/S&T cold (no registry) → both resolved via search/browse (~29s+browser time). Ran again warm → both resolved via `✓ REG` direct lookup, **zero search or browser pass at all**, 28.8s total (down from needing a full Playwright render).

### `analyst/lib/heuristic.js` — fixed a real false-positive bug
`FINANCE` regex (matches generic words like `account`, `research`, `markets`, `analyst`, `capital`) was being scanned across the whole ~8000-char page BODY, not just the title. Any tech-company posting whose boilerplate happened to mention "research" or "markets" somewhere got ruled "relevant" regardless of actual content — confirmed live: Palantir "Forward Deployed Software Engineer, Internship" and similar were leaking into the Big Tech Corporate Finance tab this way.

**Fix**: `relevant` now requires the finance signal to be in the TITLE (`titleFinance`, mirroring how `classify.js` already does it), OR the tab-criteria-overlap fallback (unchanged — this is the deliberate path for tabs like museums/environmental whose titles don't carry generic finance words, e.g. "Advancement Intern"). Verified: the exact SWE-leak case is now excluded, a real finance title still passes, criteria-overlap fallback still works, closed/stale-cycle detection untouched.

**Not yet propagated to production data** — this only fixes the logic going forward. `agent3_results.json` and any other tab still has the OLD false-positive entries on disk. Purging them needs an actual re-run (page text isn't persisted, so it can't be re-judged retroactively).

### `analyst/run-analyst.js` — parallelized browser pass + orphan-cleanup + registry wiring
- **Pass 2 (browser fallback) was a single-session serial for-loop** — every firm waited on every other firm's page loads. Now a small pool of `ANALYST_BROWSE_CONC` (default 4) Playwright sessions pulls from a shared queue concurrently. Each firm's own work is still sequential internally (one page load at a time within a session), but different firms now overlap instead of stacking end-to-end.
- **Found and fixed a real orphan-process bug** while running the discovery sweep: if the process is killed externally (external stop, crash — happened repeatedly during the sweep, see §3), its opened Playwright sessions never got closed, leaving orphaned `playwright-cli` daemons + their Chromium processes silently eating RAM (confirmed live: a killed sweep left 6 orphaned sessions, ~190 `chrome.exe` processes, <1GB free RAM on a 16GB machine). Fixed with a tracked `openSessions` Set + `process.on('exit'/'SIGINT'/'SIGTERM', ...)` handlers that force-close everything open. Best-effort only — a hard `SIGKILL` still can't be intercepted by anything, and that may be part of what's been killing the discovery-sweep background tasks (see §3, root cause never fully confirmed).
- Registry lookup/write-back wired into all three passes (see `lib/registry.js` above).

### `tracker-runner/main.js`
- `ANALYST_BROWSE_CONC` added to both `PARALLEL_ENV` (`'1'`, since 14 tabs already run simultaneously — stacking more browser concurrency per tab on top of that was measured live to cause the RAM exhaustion above) and `seqEnv` (`'4'`, since sequential mode has real headroom with only one tab running at a time).
- **`mergeFall2026()` dedup fix**: was deduping on `company::program::term`, so the SAME generic (non-season-specific) posting discovered independently by both the fall and spring sweeps survived as two "different" entries (confirmed: 38 exact duplicates in the live merged file). `term` is stored per-entry but never actually displayed anywhere in the frontend (`cloudflare-worker/src/index.js` only shows one combined tab label). Fixed to dedupe on `company::program` alone. **Regenerated `data/fall2026_results.json` locally with the fix — 76 entries → 38, verified zero duplicates remain — but this has NOT been redeployed** (see §5).

### `data/roster.json`
Added **PNC Bank** and **S&T Bank** to agent2 ("Middle Market / International"), alongside comparable-scale banks already there (Wells Fargo, Capital One, Santander). Both are on Workday — verified live (PNC: `pnc|wd5|External`, 500 postings scanned/capped from ~2000; S&T: `stbancorp|wd5|ST_Bank_Careers`, 78 postings).

---

## 2. The discovery sweep — what it is and current state

**Why it exists**: the registry only helps once a company is IN it. Rather than let coverage grow organically one refresh at a time, ran a one-time sweep across every unique company in every roster to pre-populate it. Built `data/_discovery_roster.json` (550 unique companies, deduplicated across all 5 agent-1 rosters + environmental/realestate/libraries/ithaca) and ran `run-analyst.js` against it with `--brain heuristic` (fast, zero API calls — only care about ATS/convention discovery here, not judgment quality).

**Current state**: `data/_company_conventions.json` has **215 of 550 (39%)**.
```
search-ats:            97   (cached web search found the slug, then a plain API call confirmed it — no browser)
ats-guess:              69   (guessed the company name straight against the 4 known ATS APIs — no browser)
backfill-existing-data: 17   (recovered FREE, offline, from apply_urls already in old results files — see below)
browse-sniff:           31   (needed the browser + sniffer)
browse-ats:              1   (browser found a hint linking to a known ATS)
```
**182 of 215 (85%) resolved via pure HTTP — no browser at all.** Only 32 needed the unstable browser pass.

**The offline backfill** (`backfill-existing-data`, 17 companies): before continuing the sweep, scanned every existing `*_results.json` file's `apply_url` fields and ran the same `detectAts()` regex against them, purely offline — any company whose CURRENT production data already had a posting on a recognizable ATS hostname got recorded for free, zero network calls. Yield was smaller than hoped (only 65 of ~2000 checked `apply_url`s matched a recognizable pattern) because most existing entries either came from bespoke/brain-judged pages to begin with, or use a custom-domain ATS mapping (e.g. `jobs.company.com` proxying Greenhouse) the hostname regex doesn't catch. Worth re-running if the regex is ever broadened.

**Batches**: split the ~375-380 remaining companies (after registry + backfill) into 10 files of 40 each (`data/_disc_batch_0.json` … `_disc_batch_9.json`), run individually via:
```
cd analyst && ANALYST_BROWSE_CONC=4 node run-analyst.js --roster ../data/_disc_batch_N.json --agent-key 1 --agent-name _discbatchN --brain heuristic --concurrency 12 --out ../data/_discbatchN_results.json > ../data/_discbatchN.log 2>&1
```
**Batches 0-3 done** (0: hard bulge-bracket batch, 0 new — genuinely resistant, see §4; 1: many sniff wins; 2: 47 postings kept; 3: 7 postings kept). **Batches 4-9 never run.** To resume: same command pattern, `N` = 4 through 9. The registry makes this fully idempotent/resumable — a re-run of a batch that partially completed just gets instant `✓ REG` hits for whatever it already found and continues from there.

**⚠️ Do not run two batches concurrently.** This actually happened by accident this session (batches 2 and 3's result files finished 14 seconds apart) because a "is the previous process still running" check had a timing gap. Confirm the prior batch's result file exists (not just "process not found") before launching the next.

---

## 3. Background-task instability — never root-caused

The discovery sweep's background processes died repeatedly and unpredictably — sometimes surviving 30-40 minutes with dozens of successes, sometimes dying within a minute of entering the browser pass. Investigated at length; **the actual root cause was never confirmed**:
- Ruled out: my own `timeout` tool parameter (batches with a 9-min timeout ran 23-39 min once backgrounded — clearly not enforced once backgrounded).
- Leading theory: `sniff.js`'s per-firm cost varies wildly and unpredictably — it spawns a separate `playwright-cli` subprocess (via `spawnSync` + `shell:true`, i.e. an intermediate `cmd.exe` on Windows) for EVERY candidate network request it inspects, up to 15 per firm. A JS-heavy site loaded with analytics/tracking calls can hit that cap; a simple site might only trigger 1-2. Multiplied across 4 concurrent workers, the actual process-spawn rate at any given moment is unpredictable and could spike hard depending on which companies a batch happens to contain.
- Secondary theory: general resource contention with whatever else is running on the machine at that moment (can't fully observe this from inside the session).
- **Also discovered a real monitoring bug on my end**: at least twice, I checked mid-run, saw an incomplete log tail, and wrongly concluded a batch had died when it later completed successfully. Always confirm via the actual results file existing + a proper `── analyst run summary ──` block in the log, not just "process not found in a process list snapshot."

**If resuming the sweep**: consider lowering `ANALYST_BROWSE_CONC` further (2 instead of 4) to reduce the worst-case subprocess spike, and/or capping `sniff.js`'s `MAX_CANDIDATES` (currently 15) lower. Neither was tried this session.

Separately — twice during this session, orphaned Playwright/Chrome processes from killed runs were found still consuming real RAM (up to ~8.4GB of actual Chrome usage observed at one point) and had to be manually killed via PowerShell `Stop-Process`. The exit-cleanup fix in `run-analyst.js` (§1) should reduce this going forward for graceful stops, but can't help against a hard `SIGKILL`.

---

## 4. Things confirmed genuinely hard (not bugs)

Spot-checked to confirm these are real limitations of the deterministic approach, not something broken:
- **Goldman Sachs** (and most of batch 0's bulge-bracket bank/PE lineup — Morgan Stanley, Wells Fargo, Capital One, top-tier PE firms) — search finds a careers URL, but it's a landing page with no detectable ATS link and no real single-JobPosting schema; the sniffer finds nothing usable either. These are likely behind serious bot-defense (Akamai/Cloudflare) at a level Microsoft-style sites aren't, or genuinely lack any of the 4 recognizable signal types.
- **Microsoft** — see §1, needs an actual UI interaction on a third undiscoverable subdomain.

---

## 5. What's NOT pushed through anywhere yet — the actual next steps

Nothing described above is visible to a real user right now. Three separate things need to happen:

1. **Rebuild the packaged exe.** `tracker-runner/main.js` was last edited 19:10 (the fall2026 dedup fix); the exe was last built 00:41 that same day — BEFORE that fix. The earlier `ANALYST_BROWSE_CONC` env changes ARE already baked into the current exe (rebuilt once mid-session for that). Rebuild: `cd tracker-runner && npm run dist`.
2. **Run a real refresh.** Every fix and capability above (Workday, sniffer, registry, fixed heuristic, fixed merge, parallel browse) only takes effect on an actual tab research run — none of the `analyst/` changes have been exercised on the real per-tab roster files (`agent1_results.json` etc.) this session, only on the standalone discovery roster. A real "long" mode refresh (via the app or `node run-analyst.js` per tab) is needed to actually surface PNC/S&T, purge the old heuristic false-positives, and pick up whatever the registry + sniffer can now find across the real tabs.
3. **Deploy.** `cloudflare-worker/src/data.json` (what the live site actually serves) is from 18:31 — before ANY of this session's changes, including the already-regenerated local `fall2026_results.json` dedup fix. After a real refresh: `cd cloudflare-worker && node build-data.js && wrangler deploy`.

**Recommended order when resuming**: (1) decide whether to finish the discovery sweep (batches 4-9) first for maximum registry coverage before the real refresh, since a warm registry makes the real refresh dramatically faster — or just run the real refresh now and let it organically discover/register whatever it needs; (2) run the real refresh (this will take a while — 14 tabs, "long" mode, with the browser-pass instability from §3 a real risk for any tab needing heavy browse/sniff work); (3) rebuild the exe; (4) build-data + deploy; (5) spot-check the live site for the fall2026 duplicate fix and confirm the old heuristic false-positives are gone from the Big Tech tab.

---

## 6. Files touched this session

**New files**: `analyst/lib/sniff.js`, `analyst/lib/registry.js`, `SESSION-HANDOFF-2026-08-06.md` (this file).
**Modified**: `analyst/lib/ats.js`, `analyst/lib/browse.js`, `analyst/lib/heuristic.js`, `analyst/run-analyst.js`, `tracker-runner/main.js`, `data/roster.json`, `data/fall2026_results.json` (regenerated locally, not deployed).
**Generated/working data** (safe to delete if cleaning up, all recoverable): `data/_discovery_roster.json`, `data/_discovery_results.json`, `data/_discovery.log`, `data/_disc_batch_0.json` … `_disc_batch_9.json`, `data/_discbatch0..3_results.json`, `data/_discbatch0..3.log`, `data/_discovery_remaining.json`.
**Do NOT delete**: `data/_company_conventions.json` (the registry — 215 companies of real, hard-won discovery work).
**Rebuilt once**: `tracker-runner/release/Tracker Runner 1.0.0.exe` (00:41) — now stale again relative to the 19:10 `main.js` fix, needs one more rebuild.

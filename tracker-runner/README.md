# Tracker Runner

One-click refresh + deploy for the internship tracker. Standalone Electron app —
separate from the control panel.

**What the Start button does, in order:**

1. **Research all 14 tab passes** via the analyst engine (`analyst/run-analyst.js`)
   in `--brain nim` mode — deterministic ATS-board resolution + careers-page browse
   does the mechanical work for free; **NIM** (deepseek/llama/openai, NVIDIA key from
   `OneDrive\Documents\.env`) rules the ambiguous pile. **Zero Claude/Anthropic
   tokens.** Tab list comes from `analyst/lib/tab-registry.js` (the shared source of
   truth), so new tabs added there appear here automatically.
2. **Merge** the fall + spring term passes into `fall2026_results.json`.
3. **Fetch the live `/api/data`** as the changelog diff baseline.
4. **Rebuild** the bundle (`cloudflare-worker/build-data.js` — auto-changelog).
5. **Deploy** (`wrangler deploy`).

**Long vs Short toggle:**
- **Long** — every firm in every roster, Playwright browser fallback ON. Slow, full coverage.
- **Short** — `--no-browse`: no browser pass. Fast; firms the ATS/search passes can't
  resolve stay unresolved (their previous results files survive).

**Real web search (added 2026-08-01):** with a `TAVILY_API_KEY` (tavily.com, free
1000/mo) or `BRAVE_API_KEY` in the env or `OneDrive\Documents\.env`, unresolved firms
get a **search pass** (`analyst/lib/search.js`) between the ATS and browser passes:
one ~1s API query replaces ~20s of Playwright domain-guessing. Search-found ATS slugs
rejoin the free JSON path with no browser at all; search-found careers URLs become
direct hints for the browser pass. Results cache in `data/_search_cache.json` (30-day
TTL — it holds firm→board *locations*, not postings; postings are always fetched
live) so each firm costs ONE search per month (~460/mo total) — any refresh cadence
stays inside the free tier. No key → the pass is skipped and the
old guess-then-browse behavior is unchanged. The search pass runs in Short mode too,
which massively lifts Short's coverage.

**Smoke test checkbox** — runs only the Environmental tab with `--limit 2` and skips
deploy. Use it to verify wiring without an hour-long run.

A failed research tab does **not** kill the run (its old `_results.json` survives and
still ships); a failed *build* does block the deploy.

## Run

```
cd tracker-runner
npm install        # first time only
npm start
```

Needs on PATH: `node`, `curl`, `wrangler`. NIM key: `NVIDIA_API_KEY` env var or
`OneDrive\Documents\.env` (already set — same key the tracker's judge uses).

**Brain architecture (2026-08-04):** judgment is now three-tier, AI-last:
1. **Heuristic brain first** (`analyst/lib/heuristic.js`, deterministic, zero network) —
   rules outright whenever evidence is explicit (finance-in-title + apply-now/closed
   language, or no finance signal at all). Handles ~70-80% of ambiguous candidates.
2. **NIM** only for the genuinely uncertain tail — tri-model failover
   (deepseek→llama→openai, per-model 60s cooldowns on 429/timeout).
3. **Heuristic fallback** if every model is down — low-confidence, re-judged next
   refresh. Candidates are never dropped for API unavailability.
`--brain heuristic` runs tier 1 alone: zero AI in the entire pipeline.

**Firecrawl (optional, key-gated):** with `FIRECRAWL_API_KEY` in the env or OneDrive
`.env` (firecrawl.dev, free ~500 credits), JS-rendered posting pages that plain fetch
can't read get render-extracted so the brain judges with real text (`analyst/lib/scrape.js`
— fires only when plain fetch returns <300 chars, 3-day cache, capped at 60 calls/run
via `FIRECRAWL_RUN_CAP`). No key → plain-fetch behavior, unchanged.

## What this app is NOT

It does not run the Claude-driven `/refresh-tracker` skill (WebSearch research,
Sonnet open-verification, notes regen). It's the fully-autonomous, zero-token
counterpart: analyst engine + NIM only. Coverage is bounded by what the engine can
resolve (see `analyst/README.md` — Workday/iCIMS/bespoke firms stay unresolved).

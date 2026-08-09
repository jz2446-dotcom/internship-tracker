---
type: map-of-content
updated: 2026-07-08
---

# 🗺️ Internship Tracker — Map of Content

Central hub for the finance/investing internship tracker. Open Obsidian **Graph View** to see every agent → subagent → company connection.

## System
- [[Dashboard]] — live stats & top picks
- [[HANDOFF]] — full project handoff (architecture, how to run, lessons)
- [[Setup Guide]] — Cloudflare deploy & update
- [[Résumé Coverage]] — 📄 which open roles have / need an ATS résumé (Dataview board)
- **Live site:** https://internship-tracker.jz-tracker.workers.dev
- **Refresh:** run the `/refresh-tracker` skill (on-demand full re-research + deploy)

## Research agents (5)
- [[Agent 1 - Elite Investing]] — banks, asset mgrs, PE/VC, boutiques · *asset/risk mgmt + IB*
- [[Agent 2 - Middle Market & International]] — MM IB + international banks · *asset/risk mgmt + IB*
- [[Agent 3 - Big Tech Corporate Finance]] — FP&A / finance rotational at tech · *corporate finance*
- [[Agent 4 - Consulting & Top F500]] — MBB, Big 4, advisory, retail · *corporate finance*
- [[Agent 5 - Other F500]] — telecom, airlines, industrials, defense · *corporate finance*

## Downstream agent (résumés)
- [[Résumé Agent]] — 📄 after open roles are Opus-verified, generates one ATS-tailored résumé per open role and serves it from each card (`/resume/<id>`). Coverage board: [[Résumé Coverage]].

## Special tab
- [[Sophomore Internships]] — 🎓 genuine multi-week internships done the summer AFTER sophomore year (Deloitte Discovery, JPMorgan Fellowship, BofA/MS Sophomore SA, PwC Start, EY Launch, KPMG Embark, McKinsey SSBA, BCG GFL, Amex/Capital One/NVIDIA, T. Rowe/Fidelity, Vista Rising Sophomore...). Data → `data/sophomore_results.json`. Rendered as its own dashboard tab. Excludes 1-day insight events. Each card has a competitiveness note.

## How a run works
1. Each agent splits into **subagents** (~10 companies each) — see each agent note for its branches.
2. Each subagent: Google-search every company → open careers site → capture real apply URL → verify the link → tag Class of **2028** / **2029**.
3. Results saved to `data/agentN_results.json`.
4. After opens are Opus-verified, the [[Résumé Agent]] generates one ATS-tailored résumé per open role (see [[Résumé Coverage]]).
5. Rebuild + deploy: `cd cloudflare-worker && node build-data.js && wrangler deploy`.

## Models & second opinions (set 2026-07-10)
Who runs what in a refresh — see [[Run Log & Lessons]], [[gemini-tracker-dualpass]], [[nim-preferred-models]]:
- **Fable 5** — orchestrator (dispatch/compile/reconcile/deploy) **and** the Step 6.5 pre-deploy QA reviewer.
- **Sonnet** — the research subagents (step 1–3 above).
- **Opus** — Step 5 open/closed verification. **Sole authority** on whether a role is `open`; never downgraded.
- **Gemini** (free) — independent **grounded research** only, until its search quota runs out. No longer judges.
- **NIM** deepseek/llama/openai (free, `scripts/nim/judge.js`) — the independent **open/closed judge**; no quota, runs every refresh. A second opinion, never flips a status.

## Class-year convention
- **2028** = rising junior (Summer 2027 = junior summer / rising-senior analyst programs)
- **2029** = rising sophomore (freshman/sophomore, diversity & early-insight programs)
- Empty class years = hidden from toggle (MBA-only / no-program / not-yet-eligible)

## Reusable prompt template (paste per subagent)
> You are a recruiting research agent. Today is {DATE}. Do ALL work yourself (WebSearch + WebFetch) — do NOT spawn sub-agents. For EACH company below, find current/upcoming {FINANCE FOCUS} internships, capture the real apply URL, WebFetch-verify it (`ok`/`bot-walled`/`redirect`/`dead`), and tag class years (2028 rising junior, 2029 rising sophomore). Companies: {LIST}. Return ONLY a JSON array with: company, program, category, class_years, location, status (open|program-page|closed|none|unknown), apply_url, link_status, notes.

> ⚠️ Lesson from last run: tell subagents **"do not delegate"** — agents 3c/3d spawned children and stalled. Re-run with the no-delegate instruction (see [[Run Log & Lessons]]).

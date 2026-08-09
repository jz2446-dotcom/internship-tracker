# Session Handoff — 2026-06-30

Hand this to a fresh Claude Code session to continue. Everything below is current as of end of this session.
Project root: `C:\Users\justi\Downloads\Internship Searcher\Internship Tracker`. Read `HANDOFF.md` (project overview) and the memory files (see bottom) first.

---

## 0. TL;DR of where things stand
- **Tracker is live and correct:** https://internship-tracker.jz-tracker.workers.dev — **223 programs, 11 open**, deployed Worker version `d2c4394d`, changelog dated 2026-06-30.
- **11 open roles** (each now has a résumé download button on its card): BlackRock (2027 Summer – AMERS); Wells Fargo (Finance / WIM / Commercial); Amazon ×3 (Finance Rotation: Business Unit / Operations / Accounting); Bain ACI Round 2; PwC Destination CPA (Audit/Tax S27); AlixPartners ×2 (Turnaround & Restructuring; Investigations, Disputes & Economics).
- **11 ATS-tailored résumés were generated and deployed — BUT THEY HAVE A BUG (see §1). Several bullets wrap to a 2nd line. They need to be re-fixed.**
- The user then asked for **4 new things** (see §2). I was about to save a lesson to memory and ask 4 clarifying questions (see §3) when they asked for this handoff. **No agents were spawned yet for the 4 tasks.**

---

## 1. TASK 1 — Résumé wrapping bug (diagnosis DONE, FIX NOT DONE)

### The bug (confirmed empirically)
Several of the 11 résumés have a bullet that **wraps onto a second line** (violating the user's hard rule "each bullet is exactly one line"). Confirmed by re-measuring the deployed PDFs with PyMuPDF: orphan tail words appear on line 2 — e.g. `min_amzn_bu.pdf` bullet 0 ("…and key cash-flow and FP&A **metrics**") spills "metrics"; `amzn_acct`/`pwc` spill "data"; `amzn_ops`/`bain`/`wf_comm`/`wf_fin` also show orphan "metrics"; `alix_ide`/`alix_tr`/`blackrock`/`wf_wim` likely have 1–2 wraps too. **A proper per-bullet line count is needed to pin down every offender across all 11.**

### Why I didn't notice (root cause — this is the "report back")
1. **The verifier inferred one-line-ness from proxies instead of measuring it.** `Resumes/_master/build.py` decided PASS from: `pages==1` **AND** each bullet's *first* rendered line width ≤ usable text width. Neither detects a bullet that wraps **but still fits on page 1**: the wrapped bullet's first line is packed to ~full width (small gap) so it *passes* the width test, and the extra wrapped line is invisible because the matcher only counted bullet-**start** lines (so "18/18 matched" stayed true). The only wrap I caught during dev was Amazon BU — and only because that one overflowed to `pages==2`. Every wrap that stayed on page 1 slipped through as "PASS."
2. **No independent or visual verification.** I trusted a single self-authored numeric heuristic with a blind spot, never rendered a résumé to an image to eyeball it, and never built the **independent QA subagent the user explicitly asked for** in the original plan ("a subagent that verifies each resume as soon as it is completed"). Defense-in-depth would have caught it; one proxy check did not.
3. **Contributing:** the reportlab width calibration (`×1.141`) is approximate, so a bullet estimated "in band" can render a hair wider and wrap — and the post-render check had the blind spot above, so it never corrected the estimate.

### The FIX to do
1. **Rewrite the verifier** in `build.py` to **count the actual rendered text-lines each bullet occupies** (a bullet is one line iff exactly one text line sits between its start and the next bullet's start). Flag any bullet with >1 line regardless of page count. Add an independent check: render to PNG and have a QA subagent (or the user) look, and/or assert total body line-count == expected.
2. **Re-measure all 11**, list every wrapping bullet, **shorten those bullets** (they're ~2–6 chars too long) to one line while keeping keywords + the fill target, re-render until the new verifier passes.
3. **Re-bundle + redeploy:** `node` script rebuilds `cloudflare-worker/src/resumes.json` from the corrected `min_*.pdf`, then `node build-data.js && wrangler deploy`. Re-verify `/resume/<id>` serves the fixed PDFs.

### Lesson to SAVE TO MEMORY (was about to; NOT yet saved)
Create `…/memory/verify-by-measuring-not-proxies.md` (type: feedback). Gist: *When a hard constraint is "each X is exactly one line / one page / no wrap," MEASURE it directly (count lines per X) — never infer it from correlated proxies (page-count, first-line width). And add independent verification (render-to-image + a second agent, or the human), especially any verifier the user explicitly requested. A single self-authored proxy check with no visual cross-check silently misses what it wasn't designed to see — this is exactly how 11 résumés shipped with wrapped bullets while the checker reported PASS.* Add a line to `MEMORY.md` index. Also update `resume-generator.md` to note build.py's check was flawed and how it was fixed.

---

## 2. The user's four requests (create four agents, in parallel)
1. **Résumé bug** — diagnose (done, §1), save the lesson to memory, and (almost certainly) FIX the résumés.
2. **Electron app** — build a local Electron app that offloads as much of the tracker/résumé work as possible from Claude, "so everything works effectively and efficiently while freeing up space for you to focus on other things."
3. **Terminal/PowerShell** — tell the user how to move everything so they can do their work directly from terminal/PowerShell, and **whether that saves tokens**.
4. **Obsidian** — reflect the new résumé agent in Obsidian and make it run more efficiently *with the help of Obsidian*, and act on it.

The user wants **four agents tackling these in parallel**, and said "ask me any questions."

---

## 3. Open questions to ask the user BEFORE spawning agents (I hadn't asked yet)
- **Electron app scope (multi-select):** (a) *Pipeline control panel* — buttons to run the deterministic/CLI steps (compile → add-estimates → build-data → wrangler deploy → gen-notes → résumé render+one-line-check+bundle); (b) *Résumé studio* — pick a role, edit bullets with a live one-line-fill meter, render/preview, bundle/upload; (c) *AI automation* — app calls the Claude API itself for research/Opus-verification/keyword-tailoring (**needs an Anthropic API key**, costs usage; the app reads `ANTHROPIC_API_KEY` from env — never share the key with Claude).
- **Terminal move meaning:** run the pipeline as plain PowerShell/npm scripts (no Claude) vs. switch to the Claude Code **CLI** in the terminal vs. both.
- **Fix résumés now** vs. just diagnose+memory this round? (Recommend: fix now.)
- **Obsidian intent:** a Dataview board tracking which open roles have/need résumés + documenting the agent in the Map graph, vs. one-click triggers (Obsidian buttons launching the scripts), vs. both.

### Pre-answer to Task 3's token question (so it's ready)
- Moving the **deterministic** steps (compile, add-estimates, build-data, deploy, gen-notes, résumé render/measure/bundle) into plain PowerShell/npm scripts **DOES save tokens** — they run with **zero** model involvement.
- Switching from the desktop app to the **Claude Code terminal CLI does NOT inherently save tokens** — it's the same model and same context accounting; token cost is driven by context size and LLM calls, not the interface.
- Real savings = delegate deterministic work to scripts / the Electron app; keep only the genuinely-AI parts (web research, Opus open-verification, résumé keyword tailoring) on the model.

---

## 4. Current file/state map
- **Data:** `data/agent{1..5}_results.json` + `data/sophomore_results.json` (schema: company, program, category, class_years, location, status[open|program-page|closed|none], apply_url, notes, acceptance_rate, competitiveness; open ones also posted_date/close_date; the 11 open also `resume_url:"/resume/<id>"`). `data/changelog.json` auto-maintained.
- **Worker:** `cloudflare-worker/src/index.js` (imports `data.json` + `resumes.json`; serves `/api/data`, and `/resume/<id>` → base64 PDF; renders a "📄 Résumé" button on open cards). `src/data.json` (bundled dataset) + `src/resumes.json` (11 base64 PDFs, ~2.6 MB → 1.84 MB gzip; deploy accepted). Scripts: `build-data.js`, `add-estimates.js`, `gen-notes.js`, `fix-status.js`, `add-postdates.js`.
- **Résumés:** `Resumes/_master/master-resume.docx` (the master — Times New Roman 10pt, 8.5×11, margins L0.5/R0.25 → 7.75″ text; **18 bullets**, 6 activities × 3, List Paragraph style, multi-run but uniform). `Resumes/_master/build.py` (edit+render+measure harness — **its measure is the buggy part**). `Resumes/_master/map_<role>.json` (11 per-role bullet mappings). `Resumes/_master/min_<role>.pdf` (font-subset/compressed via PyMuPDF, bundled to the Worker). Final per-role outputs in `Resumes/<Company - Program>/resume.{docx,pdf}` (11 folders).
- **Résumé width facts:** rendered width ≈ reportlab Times-Roman width × **1.141**; usable line width **557.9pt**; right text edge **594pt**; hanging indent **36.1pt**; master bullets fill to gap **15–31pt**; target per-bullet reportlab width **462–478pt** (→ one line filling to margin). **These are the right numbers; the failure was the wrap check, not the calibration.**
- **Tooling installed this session:** `python-docx`, `pdfplumber`, `reportlab`, `pymupdf` (Python 3.12). LibreOffice at `C:\Program Files\LibreOffice\program\soffice.exe` (headless docx→pdf). No Ghostscript/qpdf. Node + wrangler (OAuth; **KV writes fail — data is bundled into the Worker, do NOT `wrangler kv key put`**; KV is empty so the bundle is served).
- **Chrome:** Claude-in-Chrome MCP works for reading bot-walled JDs (`navigate` + `javascript_tool(document.body.innerText)`). Two browsers are paired; the user picks one via the connect flow. Pre-extracted JD keywords in scratchpad `run2/keywords.json`.

## 5. Key commands
```powershell
# refresh build + deploy (from cloudflare-worker/)
node add-estimates.js ; node build-data.js ; wrangler deploy
# render one résumé + measure (from Resumes/_master/)
python build.py map_<role>.json out_<role>.docx
# regenerate Dataview notes (preserves personal fields)
node gen-notes.js
# verify live
curl "https://internship-tracker.jz-tracker.workers.dev/api/data?cb=1"
```

## 6. Hard rules / gotchas (do not repeat)
- **`open` requires positive evidence** the application is accepting NOW (live req + active Apply, window covering today, or a future close date — quote it). HTTP 200 / a rendered Apply button can be a **stale cache** (the Citi trap this run — close date was Dec 2025). Bot-walled/unconfirmable → `program-page`. **Verify every `open` with Opus.**
- **Keep `company` + `program` text stable** across refreshes (site's Applied checkboxes are keyed on `company::program` in localStorage). This run used a delta-compile off the prior day's files to preserve keys.
- **Résumé rules (from the user):** edit ONLY bullet text; never change fonts/sizes/spacing/indent/bullet position or count/order; every edited bullet must be exactly one line reaching the margin; keywords must be **truthful** reframings of real experience (no fabrication).
- Scan/coverage window is **2026-03-31 onward** (memory). Refresh is on-demand only (no cron writes data).

## 7. Memory files (in `C:\Users\justi\.claude\projects\C--Users-justi-Downloads-Internship-Searcher\memory\`)
`internship-tracker-project`, `cloudflare-wrangler-kv-gotcha`, `use-opus-to-verify-links` (now includes the PwC over-generalization lesson), `scan-window-march-2026-onward`, `resume-hosting-r2-disabled`, `always-be-active`, `resume-generator` (+ `MEMORY.md` index). **STILL TO ADD:** the `verify-by-measuring-not-proxies` lesson from §1.

## 8. Loose threads
- Obsidian docs updated for the 06-30 run (Dashboard/HANDOFF/Run Log/MOC/agent-note frontmatter counts). The **résumé agent is NOT yet reflected in the Map graph** (that's Task 4).
- Background "zombie" task-failed notifications may keep firing for agents from earlier in the session — they already returned their results; ignore them (no recovery needed).

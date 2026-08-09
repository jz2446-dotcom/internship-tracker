---
type: agent
agent: resume
focus: per-open-role ATS-tailored résumé generation + site delivery
companies: 0
programs: 27
updated: 2026-07-20
---

> [!info] 2026-07-20 status: **27 open roles carry a tailored résumé on disk; 18 served this deploy** (17 real + `wf_wim`→`blackrock` alias) under the 3 MiB cap. Bundled: jpm_mkt, jpm_ia, jpm_am, citi_svc, bofa_risk/fm/ec, blackrock, trowe_er, wf_fin/comm/wim, amzn_ops/bu, bain, alix_tr/ide, tesla_fin. On disk but unbundled (no button): bofa_sm, amzn_acct, amzn_tax, tesla_acct, baird_er, tpg_climate, ga_munich, warburg_inv, eqt_ai. See [[Résumé Coverage]].

# 📄 Résumé Agent

Part of [[Internship Tracker MOC]]. Focus: **generate one ATS-tailored résumé per OPEN role and serve it from the tracker site**. Runs *after* the 5 research agents + [[Sophomore Internships]] finish and the open roles are Opus-verified. Coverage board: [[Résumé Coverage]]. Full spec in memory `[[resume-generator]]`.

Unlike the 5 research agents ([[Agent 1 - Elite Investing]], [[Agent 2 - Middle Market & International]], [[Agent 3 - Big Tech Corporate Finance]], [[Agent 4 - Consulting & Top F500]], [[Agent 5 - Other F500]]) which discover programs, this agent is a **downstream, deterministic harness** — it consumes the confirmed-open roles and produces résumés.

## What it does
1. Reads the master résumé `Resumes/_master/master-resume.docx` (Times New Roman 10pt, 8.5×11, margins L0.5/R0.25 → 7.75″ text; **18 bullets** = 6 activities × 3, `List Paragraph` style).
2. For each OPEN role, reads the posting's JD (keywords) — via Claude-in-Chrome (`navigate` + `javascript_tool(document.body.innerText)`), reliable even on bot-walled sites.
3. Writes a per-role mapping `Resumes/_master/map_<id>.json` (`{bullet_index 0–17: new truthful text}`).
4. `build.py` edits **only** each bullet's text (`runs[0].text`, clears the rest → font/size/glyph preserved), renders via LibreOffice headless, then measures each bullet.
5. **One-line-fill rule:** every edited bullet must render as exactly one line filling to the right margin. Verified by **measuring the actual rendered text-lines per bullet** (`measure_lines.py`): a résumé passes iff `markers=18/18 AND palatino_body_lines=18/18 AND wraps=0`. (Target reportlab Times-Roman width **462–478pt** ≈ rendered × 1.141 to fill the margin with a safety gap.) Iterate wording on any FAIL (underfill → lengthen; wrap → shorten). Do NOT infer one-line-ness from page-count/width proxies — see `[[verify-by-measuring-not-proxies]]`.
6. Font-subsets/compresses each PDF with PyMuPDF (`min_<id>.pdf`), base64-bundles into `cloudflare-worker/src/resumes.json`.
7. The Worker serves `GET /resume/<id>` as `application/pdf`; each open card renders a "📄 Résumé" button. Each open entry in `data/*.json` carries `resume_url:"/resume/<id>"`.

## Hard rules (do not relax)
- Edit **only** bullet text — never fonts/sizes/spacing/indent/bullet-position or bullet count/order.
- Every edited bullet = **exactly one line reaching the margin** (no wrap, no short bullet).
- Keywords must be **truthful** reframings of Justin's real experience — no fabrication.
- Dedup: skip a role whose `Resumes/<Company - Program>/` folder already has a current PDF.

## Résumés generated (2026-07-16) — 47 open cards / 29 résumé ids (18 real PDFs + 11 aliases)
[[JPMorgan Chase]] Markets `/resume/jpm_mkt` (Agent 1 + 🎓) · Internal Audit `/resume/jpm_ia` 🆕 re-opened (Agent 1 + 🎓) · [[Citigroup]] Services `/resume/citi_svc` · [[BlackRock]] `/resume/blackrock` · [[T. Rowe Price]] ER `/resume/trowe_er` (Agent 1 + 🎓) · [[Bank of America]] Global Risk `/resume/bofa_risk` · Finance Mgmt `/resume/bofa_fm` · Enterprise Credit `/resume/bofa_ec` 🆕 · Strategy & Mgmt `/resume/bofa_sm` 🆕 (all four Agent 1 + 🎓) · [[TPG]] Y Analytics `/resume/tpg_climate` (Agent 1 + 🍂) · [[Brookfield Asset Management]] BA `/resume/brk_ba` · [[Warburg Pincus]] Berlin `/resume/warburg_inv` (Agent 1 + 🍂) · [[EQT Partners]] AI `/resume/eqt_ai` · [[Houlihan Lokey]] Corp Dev `/resume/hl_corpdev` · Off-Cycle EMEA/APAC `/resume/hl_offcycle` 🆕 · [[Wells Fargo]] Finance `/resume/wf_fin` · WIM `/resume/wf_wim` · Commercial `/resume/wf_comm` (all three + 🎓) · [[Robert W. Baird]] ER `/resume/baird_er` · [[Capital One]] Commercial `/resume/c1_comm` (+ 🎓) · [[Amazon]] BU `/resume/amzn_bu` · Ops `/resume/amzn_ops` · Accounting `/resume/amzn_acct` · Tax `/resume/amzn_tax` · [[Tesla]] Acct & Finance Fall 2026 `/resume/tesla_acct` 🆕 re-opened (Agent 3 + 🍂) · [[McKinsey & Company]] Summer BA `/resume/mck_ba` 🆕 (⚠️ closes 08-11; Agent 4 + 🎓) · [[Bain & Company]] ACI `/resume/bain` · [[AlixPartners]] T&R `/resume/alix_tr` · IDE `/resume/alix_ide`. Per-role keyword targeting → [[Résumé Coverage]].
**New this run:** maps `bofa_ec` (from bofa_risk, credit-underwriting bullets), `bofa_sm` + `mck_ba` (from bain, strategy/research bullets), `hl_offcycle` + `ga_munich` (verbatim copies); revived `jpm_ia`, `tesla_acct`. All 7 rendered `18/18 wraps=0 PASS` first try. **Open but no résumé by design:** GA Munich (German required, closes 07-23) + PwC Tax JD ×2 (JD-only).
> ⚠️ **The 3 MiB limit is now BINDING — tailoring had to be rationed (2026-07-16).** ~163 KiB gz per real PDF means ≤18 reals fit. Renders are NOT byte-identical across runs (timestamps), so aliasing is now by **map-content policy**: 18 reals + 11 aliases shipped. `bofa_ec`→`bofa_risk`, `bofa_sm`/`mck_ba`→`bain`, `hl_offcycle`→`hl_corpdev` (the served PDF is the base map's; the fully-tailored maps are verified on disk, unbundleable); `warburg_inv`→`trowe_er` and `tesla_acct`→`amzn_acct` demoted to aliases; prior aliases kept. Deploy gzip **3040/3072 KiB**. **Options: Workers paid plan ($5/mo → 10 MiB, restores full tailoring) · second free Worker for overflow · keep content-aliasing niche roles.** Also: `bundle-resumes.js` is obsolete (bundles every PDF on disk) — the bundle is built from an explicit real/alias plan now. See [[Run Log & Lessons]] (2026-07-16).

## ✅ Verifier bug — FIXED (2026-07-01, see [[Run Log & Lessons]] / [[verify-by-measuring-not-proxies]])
`build.py`'s original verifier inferred one-line-ness from proxies (page count + first-line width) and **missed bullets that wrap but still fit on page 1** — 11 résumés once shipped with orphan-word wraps while the check reported PASS. Fixed: the verifier now delegates to `measure_lines.py`, which **counts the actual rendered text-lines per bullet** and asserts `markers=18 AND body_lines=18 AND wraps=0`. This run all 13 résumés (incl. both new Tesla) pass, and the orchestrator re-measured them independently before bundling.

## Why Obsidian makes this run more efficiently
- **[[Résumé Coverage]] is the single source of truth for coverage.** The Dataview "needs one" table answers *"which open roles still lack a résumé?"* at a glance — no re-deriving from `data/*.json` or the live site each run. When a new role opens, add `resume: true` + `resume_url` to its `Applications/` note and it drops off the "needs" list automatically.
- Documenting the harness here (with the [[resume-generator]] memory link) keeps the one-line-fill rules and the known verifier bug in one place, so the next run doesn't re-learn them.
- Wiring this note into the graph puts the résumé step visibly **downstream** of the 5 research agents in Graph View, so the full pipeline (research → verify → résumé → deploy) reads as one connected map.
- *(Not built: one-click script triggers — user opted for the board + graph node instead.)*

## 2026-07-18 refresh state
Bundle: **17 reals + 14 aliases, gzip 2906/3072 KiB** (headroom restored by dropping closed `alix_ide`). New: `jpm_am` (alias→jpm_mkt) for the JPMC AM Product SA; fixed dangling ids `c1_fin`→wf_fin, `tesla_fin`→amzn_bu, `ga_munich`→trowe_er. Removed: `alix_ide` (real), `baird_er` (alias) — both roles positively closed, files kept on disk. **No résumés for the 🍂 Fall/Spring and 🏛️ Libraries & Museums tabs** (user decision 2026-07-17, pending 3 MiB plan decision). No new map tailoring was needed this run (every newly-open role either reused its existing map or was covered by a content-alias).

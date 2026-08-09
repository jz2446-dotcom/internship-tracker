---
type: special-tab
programs: 107
updated: 2026-07-29
---

# 🎓 Sophomore Internships

Part of [[Internship Tracker MOC]]. A dedicated dashboard **tab** (not an agent). Data → `data/sophomore_results.json`.

**Definition:** genuine multi-week PAID internships done the summer *after* sophomore year — sophomore-specific / early-insight / diversity pipelines. **Excludes** 1-day insight events (Citi Early ID, Piper CEP, TD Invest in Success, Cornerstone Sophomore Summit were screened out).

## Competitiveness (the user's question)
**Mixed — partly true.**
- ✅ *More accessible* (~8–15% accept): [[Deloitte]] Discovery, [[PwC]] Start, [[EY (Ernst & Young)]] Launch, [[KPMG]] Embark, [[American Express]], [[Capital One]], [[Wells Fargo]] — accounting/corporate + diversity pipelines.
- ❌ *Still very competitive* (<1–2%): McKinsey SSBA, BCG GFL, [[Goldman Sachs]]/[[Morgan Stanley]] sophomore SA, megafund sophomore programs — they're the early entry point, not an easy one.

## Programs (26)
Deloitte Discovery · PwC Start · EY Launch · EY-Parthenon Emerging Leaders · KPMG Embark Scholars · McKinsey SSBA · BCG GFL · BofA Sophomore SA (IB + S&T) · MS Sophomore SA (FI/IM) · JPMorgan Fellowship · Wells Fargo Sophomore Discovery Fellowship · Deutsche Bank dbAchieve · Santander Sophomore SA · RBC GIB (sophomore) · American Express Sophomore Finance · Capital One Analyst Early Internship · NVIDIA Ignite · Mastercard · T. Rowe Price Equity Research · Fidelity Equity Research Associate · Vista Rising Sophomore · Johnson & Johnson · Coca-Cola Ignite · GE Aerospace FMP

## Research subagents (last run, Sonnet; links verified by **Opus** per [[use-opus-to-verify-links]])
- **Soph-A — Finance** (banks, asset mgrs, PE, boutiques)
- **Soph-B — Consulting & Corporate** (MBB, Big 4, tech/F500 finance)

## Current status (2026-07-14)
85 programs (expanded from 25 this run — deeper sophomore sweep), **13 open**, all Class-2029-eligible twins of Opus-verified postings: [[Bank of America]] ×4 (Global Risk, Finance Mgmt, Enterprise Credit, Strategy & Mgmt — close Sep 30–Oct 1), [[JPMorgan Chase]] Markets (Sep 30) + Internal Audit (Oct 30), [[Wells Fargo]] ×3 (Sep 29–30), [[Capital One]] Commercial, [[T. Rowe Price]] Equity Research (`trowe_er`), [[McKinsey & Company]] Summer BA (⚠️ closes Aug 11), PwC Tax JD (hidden/JD-only). AmEx Sophomore Finance was REFUTED (search-page URL, 0 live reqs → program-page). Everything else is `program-page` (most cycles open Aug–Sept 2026: Amex Aug–Sept, dbAchieve Sept 1, BCG GFL ~Aug w/ mid-Sept deadline, NVIDIA Ignite Aug–Sept, Fidelity ER "opens Fall 2026") or `closed` (JPM Fellowship Jan-13 deadline passed, Santander CIB Sophomore Dec-1 passed, RBC Pathways Oct-10 passed). **August–September 2026 is the sophomore-program application wave — check back then.**

## Current status (2026-07-29 — LONG MODE full sweep)
107 programs, **0 open**. Confirmed genuine sophomore-branded programs open to the user's eligibility exist (Citi Sophomore Leadership Program, NY Fed Sophomore Career Exploration, BofA Sophomore Analyst IB/Global Markets S&T, EY Launch, EY-Parthenon Emerging Leaders, KPMG Embark Scholars, Deloitte Discovery Internship), but none have a live 2027 posting yet — cycles typically open Aug–Sept 2026. Race/gender-restricted programs correctly excluded per the eligibility filter: McKinsey SSBA (Black/Hispanic/Indigenous-only), BCG Growing Future Leaders/Advance (same + women-only), KPMG Rise Leadership Conference (person-of-color/veteran/disability/LGBTQ/first-gen-restricted). GE Aerospace's only sophomore-adjacent offering is a 3-day invite-only summit (excluded, not multi-week). Coca-Cola has no genuine sophomore-summer program (Pay It Forward is juniors/seniors, Ignite & Blaze is EU rotational).

## Lessons
- Tag class_years **["2028","2029"]** so the tab populates under both toggles (sophomore programs roll forward each year). Notes clarify timing.
- Opus link check: McKinsey blocks curl entirely (bot-walled, loads in browser); Wells Fargo & Deutsche Bank specific URLs 404'd → switched to their early-careers hubs.
- **Bain BEL excluded (2026-06-29):** it's a 1.5-day affinity-group event, not a multi-week internship — fails the tab's definition. Keep it out.
- **Opus over-generalization (2026-06-29):** match a live req to the exact program/level before calling `open` — a niche sub-program (e.g. PwC Destination CPA / Tax JD) being open does not make the broad entry open. See [[use-opus-to-verify-links]].
- **Sophomore-tab program names can genuinely differ from the same company's agent-tab wording** (2026-07-08): T. Rowe Price, Johnson & Johnson, and GE Aerospace each have distinct sophomore-tab phrasing from their agent-tab sibling entries. A Step 3.5 reconciliation pass that pools "live" candidates across tabs by company (instead of scoping to the same tab) will wrongly rename the sophomore entry to match the agent-tab wording — caught and fixed before the 2026-07-08 deploy. Keep tab-scoped when reconciling.

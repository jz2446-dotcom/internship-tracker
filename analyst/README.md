# Analyst Engine

A scripted analyst loop for the internship tracker. It does the **mechanical**
research for free and calls **Claude (the brain)** only for the judgment a script
can't make — the exact split we scoped in chat.

## How it splits the work

Per firm in a roster:

1. **Resolve the ATS board** (`lib/ats.js`) — try Ashby / Greenhouse / Lever public
   JSON endpoints by slug. A requisition being live on the board *is* positive
   evidence it's open → **open/closed for free, no browser, no model.**
2. **Title gate** (`lib/classify.js`) — regex sweep (internship × finance, minus
   senior/non-finance-function exclusions). Clean internship+finance titles are
   marked relevant **for free**.
3. **Brain** (`lib/brain.js`) — only the *ambiguous* shortlist (internship title,
   finance unclear) goes to Claude, which reads the posting text and rules on
   relevance, open/closed, and class-year eligibility. This is the only paid step.

4. **Browser fallback** (`lib/browse.js`, `lib/extract.js`, `lib/pw.js`) — for firms
   with no guessable ATS board, drive `playwright-cli` to the firm's own careers page
   (guessed from its name) and mine it: if it links straight to an Ashby/Greenhouse/
   Lever board we hand the firm back to the free ATS path; if the page is itself a
   posting we scrape its JSON-LD (`validThrough` → open/closed) and route it. All
   zero-token; the model only runs on the text this surfaces.

**Reality check on search:** general web search (DuckDuckGo, Bing) is **bot-walled**
in headless WebKit — it returns nav chrome, not organic results. So discovery is
**search-free careers-page guessing**, which resolves a meaningful subset (proven on
Persefoni → Greenhouse) but not firms on Workday/iCIMS/bespoke or with non-obvious
domains. Those stay honestly **unresolved** in the summary. `--no-browse` skips this
pass entirely (ATS-JSON only).

## Run

```
node run-analyst.js --roster ../data/environmental_roster.json --brain claude
node run-analyst.js --roster ../data/realestate_roster.json  --brain none --limit 10
```

- `--brain nim` — **FREE.** Uses your NVIDIA NIM key (deepseek/llama/openai) for the
  relevance ruling — same key the tracker's open/closed judge uses. No per-token bill.
- `--brain claude` — Claude rules the uncertain pile (needs a paid key or `ant` login).
- `--brain none` — deterministic only, zero model (title-based; ambiguous roles dropped).
- `--brain defer` — **the `new-refresh` skill's mode.** Does all the free work, runs
  **NIM in-process as an always-on backup + second opinion** on each ambiguous candidate,
  and writes the shortlist to disk for the **session Claude** to reconcile (Claude judges
  *with* NIM's verdict in view). See "Defer mode" below.
- `--no-nim` — in defer mode, skip the NIM backup (Claude-only shortlist). Off by default.
- `--limit N` — first N firms (smoke tests).
- `--criteria "..."` — tab focus for the brain (defaults to the roster's description).

Output (single-brain modes): `<agent>_results.json` next to the roster, in the tracker's
per-tab schema. Prints a free-vs-brain split so you can see how much the model was needed.

## Defer mode — free work here, Claude reconciles, NIM backs it up

`--brain defer` is a two-phase handoff so the **session Claude** (free under the
subscription) is the primary brain instead of the paid API, while **NIM stays in the loop**
as a backup and second opinion:

1. **App (this script):** all free passes + NIM on each ambiguous candidate. Writes
   `<agent>_results.partial.json` (free-decided internships) and `<agent>_shortlist.json`
   (ambiguous candidates, each carrying its `page_text` and NIM's `nim` verdict).
2. **Claude:** reads the shortlist, judges each item with NIM's verdict in view, writes
   `<agent>_verdicts.json` (`{"verdicts":[{company,title,relevant,status,class_years,...}]}`).
3. **`apply-verdicts.js`:** merges partial + shortlist + verdicts into the final
   `<agent>_results.json`. Claude is primary; NIM is the fallback for any item Claude
   didn't rule (e.g. a headless run). Each reconciled entry gets a `source`:
   `consensus:claude+nim` · `brain:claude(over-nim)` · `brain:claude` · `brain:nim(backup)`.

```
node run-analyst.js --roster ../data/environmental_roster.json --brain defer
# … Claude writes data/environmental_verdicts.json …
node apply-verdicts.js --agent environmental
```

## Brain providers + auth

- **`nim` (free, recommended):** `lib/nimbrain.js`, NVIDIA NIM. Key `NVIDIA_API_KEY`
  from env or `OneDrive\Documents\.env` (already set — it's the tracker's judge key).
  Default model `llama`; override with `ANALYST_NIM_MODEL` = `deepseek|llama|openai`.
- **`claude` (paid):** `lib/brain.js`. Default `claude-opus-4-8`; override with
  `ANALYST_BRAIN_MODEL` (e.g. `claude-haiku-4-5`). Auth: `ANTHROPIC_API_KEY`, else an
  `ant auth login` OAuth token (reuses a Claude login).
- **`none`:** no model.

All raw HTTPS via built-in `fetch` — no SDK install.

## What it can't do by itself (unchanged from the design chat)

Discovery of firms/URLs it isn't pointed at, prose-only pages with no structured
data, captcha/login walls, and résumé writing all still need the model or you. This
engine shrinks the model's job to relevance + the ambiguous remainder — it doesn't
eliminate it.

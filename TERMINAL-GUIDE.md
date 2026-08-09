# TERMINAL GUIDE — running the tracker & résumés yourself

This guide lets you drive the deterministic parts of the project directly from
PowerShell, with **zero Claude involvement** (and zero token cost). It also
explains how the Claude Code **terminal CLI** differs from the desktop app, and
answers the "does terminal save tokens?" question.

Project root:
`C:\Users\justi\Downloads\Internship Searcher\Internship Tracker`

The scripts live in `scripts\`. They wrap the exact same underlying commands the
Electron control panel's buttons will call — one source of truth, two front ends.

---

## 0. One-time setup: allow scripts to run

PowerShell blocks unsigned local scripts by default. Allow them **for your user
only** (safe; does not affect other users or require admin):

```powershell
Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned
```

If you'd rather not change the policy at all, run any script per-invocation with:

```powershell
powershell -ExecutionPolicy Bypass -File ".\scripts\verify.ps1"
```

Prereqs already installed on this machine: Node 24, Python 3.12
(`python-docx`, `pdfplumber`, `reportlab`, `pymupdf`), `wrangler` 4.x
(logged in via OAuth), LibreOffice (headless) at
`C:\Program Files\LibreOffice\program\soffice.exe`.

---

## 1. Plain-scripts workflow (the deterministic pipeline)

Open PowerShell and `cd` to the project root:

```powershell
cd "C:\Users\justi\Downloads\Internship Searcher\Internship Tracker"
```

Every script echoes the directory + command it runs, and **stops on the first
error** (`$ErrorActionPreference = 'Stop'`). All are idempotent — safe to re-run.

### The scripts

| Script | What it does | When to run it |
|---|---|---|
| `scripts\verify.ps1` | GETs the live `/api/data` (cache-busted) and prints total programs + status breakdown (open/program-page/closed/none). | Anytime, to confirm what's actually deployed. Read-only. |
| `scripts\refresh-and-deploy.ps1` | `node add-estimates.js` → `node build-data.js` → (optional) deploy → `verify`. Rebuilds `src/data.json` from `data/*.json` and the changelog. | After you (or a Claude research run) edited `data/*.json` and want the site rebuilt. Does **not** deploy unless you add `-Deploy`. |
| `scripts\deploy.ps1` | Prompts for confirmation, then `wrangler deploy`, then verifies. The site is **live**, so it asks first. | When you're ready to publish the current bundle. Add `-Force` to skip the prompt. |
| `scripts\gen-notes.ps1` | `node gen-notes.js` — regenerates the Obsidian `Applications/` notes from `data/*.json`, preserving your personal fields + note bodies. | After a data refresh, to sync your Obsidian tracker. |
| `scripts\render-resume.ps1 <role>` | `python build.py map_<role>.json out_<role>.docx` (render) then `python measure_lines.py` (accurate per-bullet one-line check). `-All` does every role; `-Bundle` also re-packs `min_*.pdf` → `resumes.json`. | After editing a role's bullet mapping, to render + verify the résumé is one line per bullet. |

### Typical end-to-end (data already updated in `data/*.json`)

```powershell
# 1. Rebuild the data bundle + changelog, but DON'T deploy yet; just verify.
.\scripts\refresh-and-deploy.ps1

# 2. Sync the Obsidian application notes.
.\scripts\gen-notes.ps1

# 3. When happy, publish (asks you to type 'yes'):
.\scripts\deploy.ps1
```

Or do the rebuild + deploy in one shot:

```powershell
.\scripts\refresh-and-deploy.ps1 -Deploy    # rebuild, then deploy (confirms first)
```

### Résumé workflow

```powershell
# Render + measure ONE role (roles are the map_<role>.json suffixes):
.\scripts\render-resume.ps1 blackrock

# Render + measure ALL 11:
.\scripts\render-resume.ps1 -All

# Render one, then re-bundle min_*.pdf into src/resumes.json (does NOT deploy):
.\scripts\render-resume.ps1 blackrock -Bundle
```

Valid roles: `blackrock  wf_fin  wf_wim  wf_comm  amzn_bu  amzn_ops  amzn_acct
bain  pwc  alix_tr  alix_ide`.

`measure_lines.py` is the authoritative one-line-per-bullet check (it counts the
actual rendered text-lines each bullet occupies). `build.py`'s own PASS/CHECK
line has a known wrap blind spot — trust `measure_lines.py`'s `=> PASS/FAIL`.

After re-bundling résumés you still need to rebuild + deploy to publish them:

```powershell
.\scripts\render-resume.ps1 -All -Bundle     # render, verify, re-pack resumes.json
.\scripts\refresh-and-deploy.ps1 -Deploy     # build-data + deploy
```

### The raw commands (what the scripts wrap)

If you ever want to run them by hand:

```powershell
# From cloudflare-worker/
cd "C:\Users\justi\Downloads\Internship Searcher\Internship Tracker\cloudflare-worker"
node add-estimates.js       # add acceptance_rate + competitiveness
node build-data.js          # data/*.json -> src/data.json (+ changelog diff)
node bundle-resumes.js      # Resumes/_master/min_*.pdf -> src/resumes.json
wrangler deploy             # publish (LIVE)
curl "https://internship-tracker.jz-tracker.workers.dev/api/data?cb=1"

# From Resumes/_master/
cd "C:\Users\justi\Downloads\Internship Searcher\Internship Tracker\Resumes\_master"
python build.py map_blackrock.json out_blackrock.docx     # render
python measure_lines.py out_blackrock.pdf map_blackrock.json   # verify one-line
```

> Note: `bundle-resumes.js` is new (added with these scripts). It reads every
> `Resumes/_master/min_<id>.pdf` and writes `src/resumes.json` as `{id: base64}`.
> The `<id>` matches the résumé's `resume_url` slug (`/resume/<id>`).

---

## 2. Claude Code CLI in the terminal

You can run Claude Code from the terminal instead of (or alongside) the desktop
app.

### Install & launch

```powershell
npm install -g @anthropic-ai/claude-code    # one-time
claude                                        # start an interactive session in the current dir
```

Run it from the project root so it has the repo in context:

```powershell
cd "C:\Users\justi\Downloads\Internship Searcher\Internship Tracker"
claude
```

Useful non-interactive form (one-shot prompt, good for scripting):

```powershell
claude -p "refresh the tracker and deploy"
```

### How the CLI differs from the desktop app

- **Same model, same account, same billing.** The CLI is just a different
  *interface* to the same Claude. It authenticates with your Anthropic login/API
  and consumes the same usage.
- **Interface, not cost:** the desktop app has the rich GUI; the CLI lives in
  your terminal, integrates with your shell, and is easy to script/pipe.
- **What's identical:** the skills (`/refresh-tracker`, `/deep-research`, résumé
  skills), the tools, the memory files, and the context accounting.

### What to keep on Claude vs. run as a script

Keep on Claude (genuinely needs the model):
- Web research / re-running the 5 research agents (`/refresh-tracker`'s research
  phase).
- **Opus open-verification** — deciding whether a posting is truly `open` (the
  judgment call that avoids the "stale cached Apply" trap).
- Résumé **keyword tailoring** — writing truthful bullet reframings per role.

Run as a plain script (no model needed):
- `add-estimates` → `build-data` → `deploy` → `verify`.
- `gen-notes` (Obsidian sync).
- Résumé **render + one-line measure + bundle**.

Rule of thumb: if a step has a single deterministic correct output, script it.
If it needs reasoning, search, or judgment, keep it on Claude.

---

## 3. TOKEN VERDICT — does moving to the terminal save tokens?

**Short answer: it depends on *what* you move, not *where* you type.**

- **Moving the DETERMINISTIC steps into plain scripts → YES, saves tokens.**
  `compile → add-estimates → build-data → deploy → gen-notes` and the résumé
  `render → measure → bundle` run with **zero model involvement**. When you run
  `.\scripts\refresh-and-deploy.ps1`, no tokens are spent at all — it's just
  Node, Python, and wrangler. Every one of those steps you hand to a script is a
  step Claude no longer has to read, think about, and narrate. **This is the
  real saving.**

- **Switching from the desktop app to the Claude Code CLI → NO, not by itself.**
  The CLI is the *same model* with the *same context accounting*. Token cost is
  driven by **how big the context is and how many LLM calls you make**, not by
  whether you're in a GUI or a terminal. Typing `claude` in PowerShell instead of
  opening the app does not make a task cheaper.

**Why (plain-English):** you pay tokens for what the *model* reads and writes.
A deterministic command (like `wrangler deploy`) has one correct result and
needs no thinking — so running it in a script costs nothing, while asking Claude
to run it costs tokens for the model to read the request, decide, call the tool,
read the output, and report back. The interface (app vs. terminal) is just a
window onto the same model; it doesn't change how much the model reads or thinks.

**So the real savings come from delegation, not the terminal:**
- Hand every deterministic step to these scripts (or the Electron control panel).
- Keep only the genuinely-AI work on the model: web research, Opus
  open-verification, and résumé keyword tailoring.

Use the CLI if you *like* working in the terminal (scriptable, pipeable, lives
next to your shell) — just don't expect the switch alone to lower your token
bill. The scripts are what lower it.

---

## 4. What stays on the model vs. what you can now do yourself

| Task | Now a script? | Stays on Claude? | Why |
|---|---|---|---|
| add-estimates | ✅ `refresh-and-deploy.ps1` | — | Deterministic transform. |
| build-data (bundle + changelog) | ✅ `refresh-and-deploy.ps1` | — | Deterministic transform. |
| wrangler deploy | ✅ `deploy.ps1` | — | Deterministic publish. |
| verify live data | ✅ `verify.ps1` | — | Deterministic HTTP + count. |
| gen-notes (Obsidian sync) | ✅ `gen-notes.ps1` | — | Deterministic regen. |
| résumé render | ✅ `render-resume.ps1` | — | LibreOffice render. |
| résumé one-line measure | ✅ `render-resume.ps1` | — | PyMuPDF line count. |
| résumé re-bundle | ✅ `render-resume.ps1 -Bundle` / `bundle-resumes.js` | — | Deterministic base64 pack. |
| re-run the 5 research agents | — | ✅ | Web search + synthesis. |
| verify a posting is truly OPEN | — | ✅ (Opus) | Judgment; avoids stale-cache traps. |
| résumé keyword tailoring | — | ✅ | Truthful reframing per role. |

---

## 5. Gotchas (unchanged from the project rules)

- **KV writes fail** under the OAuth token. Data is **bundled into the Worker**
  (`build-data.js` → `src/data.json`; `bundle-resumes.js` → `src/resumes.json`).
  Never `wrangler kv key put`.
- Keep each program's `company` + `program` text **stable** across refreshes —
  the site's "Applied" checkboxes are keyed on `company::program`.
- Mark a role `open` only with **positive evidence** it's accepting now; verify
  with Opus. A page that loads (HTTP 200) can be a stale cache.
- Every edited résumé bullet must render as **exactly one line** to the margin;
  keywords must be truthful reframings. `measure_lines.py` is the check.

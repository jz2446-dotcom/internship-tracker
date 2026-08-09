# Tracker Control Panel

A **local** Electron desktop app that runs the **deterministic, zero-AI** steps of the
internship tracker + résumé pipeline with buttons, streaming live command output to the UI.

It exists to keep deterministic build/deploy work **off the model** so Claude focuses on the
genuinely-AI work (research, Opus open-verification, résumé keyword tailoring).

- **No AI calls. No API key.** The app only shells out to tools already on your PATH
  (`node`, `python`, `wrangler`, `curl`) via `child_process.spawn`.
- **No secrets** are stored or read by the app. It inherits your normal environment.
- Paths are resolved **relative to this folder** (`..` = the project root), so it stays portable.

## Install

```powershell
cd "C:\Users\justi\Downloads\Internship Searcher\Internship Tracker\control-panel"
npm install
```

## Launch

```powershell
npm start
```

## Buttons

Each button runs a real command in a specific working directory (shown in the UI) and streams
stdout + stderr to the shared console, with a status pill (running / success / failed + exit code).

### Data pipeline  — cwd: `cloudflare-worker/`
| Button | Command |
| --- | --- |
| **Add estimates** | `node add-estimates.js` |
| **Build data bundle** | `node build-data.js` |
| **Generate Dataview notes** | `node gen-notes.js` |

### Deploy & verify  — cwd: `cloudflare-worker/`
| Button | Command |
| --- | --- |
| **Verify live** | `curl -s "https://internship-tracker.jz-tracker.workers.dev/api/data?cb=1"` |
| **Deploy to Cloudflare** | `wrangler deploy` — **GUARDED** |

> ⚠️ **Deploy is LIVE.** The Deploy button is disabled until you tick the confirmation
> checkbox, and clicking it then pops a native confirm dialog. It publishes the current
> bundle to `internship-tracker.jz-tracker.workers.dev`. Run **Build data bundle**
> (and **Re-bundle résumés** if PDFs changed) first.

### Résumés  — cwd: `Resumes/_master/` (render) / project root (re-bundle)
| Button | Command |
| --- | --- |
| **Render + one-line check** | `python build.py map_<role>.json out_<role>.docx` (role chosen from the dropdown, which lists `map_*.json`) |
| **Re-bundle résumés** | `node control-panel/rebundle-resumes.js` |

**Re-bundle** rebuilds `cloudflare-worker/src/resumes.json` (a flat `{ "<id>": "<base64 pdf>" }`
map) from the `Resumes/_master/min_<id>.pdf` files. The tracker repo did not previously ship
such a script — résumés were bundled by hand — so this app provides `rebundle-resumes.js`.
Deploy afterward with the Deploy button. (`node control-panel/rebundle-resumes.js --dry-run`
reports without writing.)

## Notes

- Only one command runs at a time; the **Stop** button kills the running process.
- The app never sends raw paths from the UI — the renderer sends a directory *token*
  (`worker` / `resume` / `root`) that the main process maps to a whitelisted absolute path.
- `contextIsolation` is ON and `nodeIntegration` is OFF; the renderer talks to the OS only
  through the narrow `window.api` bridge in `preload.js`.

## Files

- `package.json` — Electron devDependency + `npm start`
- `main.js` — main process; spawns commands, streams output, whitelists cwds
- `preload.js` — safe IPC bridge (`window.api`)
- `index.html` / `styles.css` / `renderer.js` — the UI
- `rebundle-resumes.js` — rebuilds `resumes.json` from `min_*.pdf`

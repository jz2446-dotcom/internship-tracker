# tracker-analyst MCP server

Wraps the analyst engine (`../run-analyst.js`, `../apply-verdicts.js`) as MCP tools so a
Claude Code session can drive the `/refresh-tracker` research step directly — call tools
instead of spawning research subagents. Session Claude is the brain; NIM runs in-process
as an always-on backup/second opinion on the ambiguous shortlist (same split as `new-refresh`).

## Setup (already done once)
```
cd analyst/mcp && npm install
claude mcp add tracker-analyst -s local -- node "<repo>/analyst/mcp/server.js"
```
`-s local` scopes it to this project only, privately to this machine/user — not a global
change. **New MCP servers only connect at session start** — after adding or editing
`server.js`, start a fresh Claude Code session before its tools show up.

## Tools
- `list_tabs` — the 13 tabs and their roster files (see `../lib/tab-registry.js`)
- `get_roster(tab)` — normalized company list for a tab, any of the 3 roster shapes
- `run_full_sweep(tab, limit?, noBrowse?, noNim?)` — free ATS+browser research pass,
  writes `<agent>_results.partial.json` + `<agent>_shortlist.json`
- `get_shortlist(tab)` — the ambiguous candidates for Claude to judge (NIM's verdict attached)
- `submit_verdicts(tab, verdicts)` — write your rulings
- `apply_verdicts(tab)` — merge partial + shortlist + verdicts → final `<agent>_results.json`
- `merge_agent_files(sourceAgentNames, outAgentName)` — for tabs run in multiple passes
  (fall2026's fall + spring terms use separate agentNames, merged into one file)
- `build_and_deploy(skipDeploy?)` — curl live snapshot → build-data.js → wrangler deploy

## ⚠️ Testing gotcha (hit once already, described here so it isn't repeated)
`apply_verdicts` and `run_full_sweep` write straight to `data/<agentName>_results.json` —
for the 13 real tabs, that **is** the production file (e.g. `agentName: "ithaca"` →
`data/ithaca_results.json`). A smoke test run against a real tab's `agentName` will
overwrite real tracker data with test output. **Always pass a throwaway `--agent-name` /
`agentName` for smoke tests** (e.g. `ithaca_smoketest`), never one of the 13 real tab names,
unless you genuinely intend to refresh that tab's live data.

## Known limitations (not yet solved)
- **Fellowships tab**: this engine only sweeps the 5-agent roster for internal
  fellowship-branded tracks. It does NOT know about the fixed list of *named external*
  fellowship/pipeline programs (PIMCO Foundation, KPMG Embark, etc.) — those aren't
  "companies with an ATS board," they need separate handling (a small hardcoded list,
  researched directly, not via ats.js/browse.js). The `/refresh-tracker` skill's
  Sonnet-subagent approach still covers this half of the Fellowships tab.
- **Part-time detection (Ithaca tab)**: `classify.partTimeGate()` is a regex heuristic on
  title/text ("part-time", "N hrs/week" vs "full-time", "40 hrs/week", "exempt"). Ambiguous
  postings fall through to the brain rather than being assumed part-time, per the tab's hard
  rule, but the regex itself hasn't been tuned against real postings yet.
- **China/HK region targeting**: the free ATS/title-gate pass has no real concept of
  "this posting is in Hong Kong" — region correctness currently relies entirely on the
  `queryHint`/`criteriaPreamble` steering the browser-fallback search and the brain's
  judgment when reading `page_text`, not on any engine-level filter.
- **`/refresh-tracker` skill itself has not been rewritten** to call these tools instead of
  its current Agent-based research fan-out (Step 2). This MCP server is built and wired in,
  but the skill's Step 2 instructions still say "spawn Sonnet subagents." Updating the skill
  to use `run_full_sweep`/`get_shortlist`/`submit_verdicts`/`apply_verdicts` per tab instead
  is a separate follow-up, not yet done.

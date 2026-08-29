#!/usr/bin/env bash
# Full 14-tab refresh, run the same way the Tracker Runner app's "short + heuristic"
# pipeline does, but from the CLI so it can't misfire on the wrong cwd. Each tab is
# its own subshell pinned to the analyst/ dir via absolute path. Logs land in
# data/_full_refresh_logs/<tab>.log so failures are inspectable afterward.
set -u
cd "/c/Users/justi/Downloads/Internship Searcher/Internship Tracker/analyst" || exit 1
mkdir -p ../data/_full_refresh_logs

export ANALYST_NIM_CONC=1 ANALYST_SEARCH_CONC=1 FIRECRAWL_RUN_CAP=10 ANALYST_BROWSE_CONC=1

run_tab() {
  local name="$1"; shift
  ( cd "/c/Users/justi/Downloads/Internship Searcher/Internship Tracker/analyst" && \
    node run-analyst.js "$@" > "../data/_full_refresh_logs/${name}.log" 2>&1
    echo "EXIT:$?" >> "../data/_full_refresh_logs/${name}.log" )
}

run_tab agent1 --roster ../data/roster.json --agent-name agent1 --brain heuristic --agent-key 1 --no-browse --concurrency 3 &
run_tab agent2 --roster ../data/roster.json --agent-name agent2 --brain heuristic --agent-key 2 --no-browse --concurrency 3 &
run_tab agent3 --roster ../data/roster.json --agent-name agent3 --brain heuristic --agent-key 3 --no-browse --concurrency 3 &
run_tab agent4 --roster ../data/roster.json --agent-name agent4 --brain heuristic --agent-key 4 --no-browse --concurrency 3 &
run_tab agent5 --roster ../data/roster.json --agent-name agent5 --brain heuristic --agent-key 5 --no-browse --concurrency 3 &
run_tab libraries --roster ../data/libraries_roster.json --agent-name libraries --brain heuristic --tab libraries --no-browse --concurrency 3 &
run_tab environmental --roster ../data/environmental_roster.json --agent-name environmental --brain heuristic --tab environmental --no-browse --concurrency 3 &
run_tab realestate --roster ../data/realestate_roster.json --agent-name realestate --brain heuristic --tab realestate --no-browse --concurrency 3 &
run_tab ithaca --roster ../data/ithaca_roster.json --agent-name ithaca --brain heuristic --tab ithaca --no-browse --concurrency 3 &
run_tab sophomore --roster ../data/roster.json --agent-name sophomore --brain heuristic --all-agents --tab sophomore --no-browse --concurrency 3 &
run_tab fall2026_fall --roster ../data/roster.json --agent-name fall2026_fall --brain heuristic --all-agents --tab fall2026 --term fall2026 --no-browse --concurrency 3 &
run_tab fall2026_spring --roster ../data/roster.json --agent-name fall2026_spring --brain heuristic --all-agents --tab fall2026 --term spring2027 --no-browse --concurrency 3 &
run_tab fellowships --roster ../data/roster.json --agent-name fellowships --brain heuristic --all-agents --tab fellowships --no-browse --concurrency 3 &
run_tab china_hk --roster ../data/roster.json --agent-name china_hk --brain heuristic --all-agents --tab china_hk --no-browse --concurrency 3 &

wait
echo "=== all 14 research tabs finished ==="

node -e "
const fs = require('fs'), path = require('path');
const DATA_DIR = path.resolve('../data');
const sources = ['fall2026_fall', 'fall2026_spring'];
const seen = new Set();
const internships = [];
let meta = { name: 'Fall 2026 / Spring 2027', focus: '' };
for (const a of sources) {
  const p = path.join(DATA_DIR, a + '_results.json');
  if (!fs.existsSync(p)) { console.log('missing ' + a); continue; }
  const d = JSON.parse(fs.readFileSync(p, 'utf8'));
  if (d.name) meta.name = d.name;
  if (d.focus && !meta.focus) meta.focus = d.focus;
  for (const e of d.internships || []) {
    const k = (e.company||'').toLowerCase() + '::' + (e.program||'').toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    internships.push(e);
  }
}
fs.writeFileSync(path.join(DATA_DIR, 'fall2026_results.json'), JSON.stringify({
  agent: 'fall2026', name: meta.name, focus: meta.focus,
  last_updated: new Date().toISOString().slice(0,10), internships
}, null, 2));
console.log('merged fall2026: ' + internships.length + ' entries');
"

echo "=== merge done ==="

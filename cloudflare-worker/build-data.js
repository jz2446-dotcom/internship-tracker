// Run: node build-data.js
// Combines ../data/agentN_results.json into src/data.json, which the Worker imports and serves.
// This avoids needing a remote KV write (which fails under the current OAuth token).
//
// Also auto-maintains a CHANGELOG: before overwriting src/data.json, it diffs the
// previously-deployed bundle against the new data and, if anything changed
// (status flips, added/removed programs), prepends a dated entry to
// ../data/changelog.json. The changelog is bundled into src/data.json and served at
// /api/data, then rendered by the Worker's "🆕 What's changed" tab. This makes the
// "what changed" update happen automatically on EVERY refresh — no extra step.
import { readFileSync, existsSync, writeFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(__dirname, '../data');
const outFile = path.join(__dirname, 'src', 'data.json');
const changelogFile = path.join(dataDir, 'changelog.json');

// --- read the previously-deployed bundle (for diffing) BEFORE we overwrite it ---
let prev = null;
if (existsSync(outFile)) {
  try { prev = JSON.parse(readFileSync(outFile, 'utf-8')); } catch { prev = null; }
}

// --- build the new combined dataset ---
const combined = { last_updated: new Date().toISOString(), agents: {} };

for (let i = 1; i <= 5; i++) {
  const file = path.join(dataDir, `agent${i}_results.json`);
  if (existsSync(file)) {
    const data = JSON.parse(readFileSync(file, 'utf-8'));
    combined.agents[String(i)] = data;
    console.log(`Loaded Agent ${i}: ${data.internships?.length || 0} internships`);
  } else {
    console.log(`Agent ${i}: no data file yet`);
  }
}

// Sophomore Internships tab (separate top-level group, rendered under its own tab)
const sophFile = path.join(dataDir, 'sophomore_results.json');
if (existsSync(sophFile)) {
  combined.sophomore = JSON.parse(readFileSync(sophFile, 'utf-8'));
  console.log(`Loaded Sophomore Internships: ${combined.sophomore.internships?.length || 0} programs`);
}

// Fall 2026 / Spring 2027 Internships tab (separate top-level group, rendered under its own tab)
const fallFile = path.join(dataDir, 'fall2026_results.json');
if (existsSync(fallFile)) {
  combined.fall2026 = JSON.parse(readFileSync(fallFile, 'utf-8'));
  console.log(`Loaded Fall 2026 / Spring 2027 Internships: ${combined.fall2026.internships?.length || 0} programs`);
}

// Libraries & Museums finance internships tab (separate top-level group, rendered under its own tab)
const libFile = path.join(dataDir, 'libraries_results.json');
if (existsSync(libFile)) {
  combined.libraries = JSON.parse(readFileSync(libFile, 'utf-8'));
  console.log(`Loaded Libraries & Museums: ${combined.libraries.internships?.length || 0} programs`);
}

// Environmental Impact Finance tab (separate top-level group, rendered under its own tab)
const envFile = path.join(dataDir, 'environmental_results.json');
if (existsSync(envFile)) {
  combined.environmental = JSON.parse(readFileSync(envFile, 'utf-8'));
  console.log(`Loaded Environmental Impact Finance: ${combined.environmental.internships?.length || 0} programs`);
}

// Real Estate Finance tab (separate top-level group, rendered under its own tab)
const reFile = path.join(dataDir, 'realestate_results.json');
if (existsSync(reFile)) {
  combined.realestate = JSON.parse(readFileSync(reFile, 'utf-8'));
  console.log(`Loaded Real Estate Finance: ${combined.realestate.internships?.length || 0} programs`);
}

// Fellowships tab (separate top-level group, rendered under its own tab)
const fellowshipsFile = path.join(dataDir, 'fellowships_results.json');
if (existsSync(fellowshipsFile)) {
  combined.fellowships = JSON.parse(readFileSync(fellowshipsFile, 'utf-8'));
  console.log(`Loaded Fellowships: ${combined.fellowships.internships?.length || 0} programs`);
}

// China / Hong Kong tab (separate top-level group, rendered under its own tab)
const chinaHkFile = path.join(dataDir, 'china_hk_results.json');
if (existsSync(chinaHkFile)) {
  combined.china_hk = JSON.parse(readFileSync(chinaHkFile, 'utf-8'));
  console.log(`Loaded China / Hong Kong: ${combined.china_hk.internships?.length || 0} programs`);
}

// Ithaca, NY local finance jobs tab (separate top-level group, rendered under its own tab)
const ithacaFile = path.join(dataDir, 'ithaca_results.json');
if (existsSync(ithacaFile)) {
  combined.ithaca = JSON.parse(readFileSync(ithacaFile, 'utf-8'));
  console.log(`Loaded Ithaca, NY Local Finance Jobs: ${combined.ithaca.internships?.length || 0} roles`);
}

// --- changelog: flatten + diff helpers ---
function flatten(bundle) {
  const out = [];
  if (!bundle) return out;
  const groups = [];
  if (bundle.agents) for (const k of Object.keys(bundle.agents)) groups.push([k, bundle.agents[k]]);
  if (bundle.sophomore) groups.push(['sophomore', bundle.sophomore]);
  if (bundle.fall2026) groups.push(['fall2026', bundle.fall2026]);
  if (bundle.libraries) groups.push(['libraries', bundle.libraries]);
  if (bundle.environmental) groups.push(['environmental', bundle.environmental]);
  if (bundle.realestate) groups.push(['realestate', bundle.realestate]);
  if (bundle.fellowships) groups.push(['fellowships', bundle.fellowships]);
  if (bundle.china_hk) groups.push(['china_hk', bundle.china_hk]);
  if (bundle.ithaca) groups.push(['ithaca', bundle.ithaca]);
  for (const [g, gd] of groups) {
    for (const it of (gd.internships || [])) {
      out.push({ group: g, company: it.company, program: it.program || '', status: it.status || 'unknown' });
    }
  }
  return out;
}
const keyOf = (x) => x.group + '||' + x.company + '||' + x.program;

function computeDiff(prevBundle, newBundle) {
  const oldMap = new Map(flatten(prevBundle).map(x => [keyOf(x), x]));
  const newMap = new Map(flatten(newBundle).map(x => [keyOf(x), x]));
  const added = [], removed = [], status_changed = [];
  for (const [k, x] of newMap) if (!oldMap.has(k)) added.push({ group: x.group, company: x.company, program: x.program, status: x.status });
  for (const [k, x] of oldMap) if (!newMap.has(k)) removed.push({ group: x.group, company: x.company, program: x.program, status: x.status });
  for (const [k, x] of newMap) {
    const o = oldMap.get(k);
    if (o && o.status !== x.status) status_changed.push({ group: x.group, company: x.company, program: x.program, from: o.status, to: x.status });
  }
  return { added, removed, status_changed };
}

const allNew = flatten(combined);
const totalCount = allNew.length;
const openCount = allNew.filter(x => x.status === 'open').length;

// load (or init) the persistent changelog
let changelog = { entries: [] };
if (existsSync(changelogFile)) {
  try {
    changelog = JSON.parse(readFileSync(changelogFile, 'utf-8'));
    if (!Array.isArray(changelog.entries)) changelog.entries = [];
  } catch { changelog = { entries: [] }; }
}

const d = prev ? computeDiff(prev, combined) : { added: [], removed: [], status_changed: [] };
const hasChanges = d.added.length + d.removed.length + d.status_changed.length > 0;
const dateStr = combined.last_updated.slice(0, 10);

if (hasChanges) {
  changelog.entries.unshift({
    date: dateStr,
    summary: `${totalCount} programs, ${openCount} open · ${d.status_changed.length} status change(s), +${d.added.length} added, −${d.removed.length} removed`,
    total: totalCount,
    open: openCount,
    added: d.added,
    removed: d.removed,
    status_changed: d.status_changed
  });
  writeFileSync(changelogFile, JSON.stringify(changelog, null, 2));
  console.log(`✓ Changelog: ${d.status_changed.length} status change(s), +${d.added.length} added, −${d.removed.length} removed (entry ${dateStr})`);
} else {
  console.log(prev ? 'No data changes vs previous bundle — no changelog entry added.' : 'No previous bundle to diff — skipping changelog entry.');
}

// bundle the most recent 30 changelog entries so the Worker can render the "What's changed" tab
combined.changelog = changelog.entries.slice(0, 30);

writeFileSync(outFile, JSON.stringify(combined));
console.log(`✓ Wrote ${outFile} (${Object.keys(combined.agents).length} agents${combined.sophomore ? ' + sophomore tab' : ''}, ${combined.changelog.length} changelog entries)`);

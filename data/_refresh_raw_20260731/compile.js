const fs = require('fs');
const path = require('path');

const RAW = __dirname;
const DATA = path.join(RAW, '..');

function load(f) { return JSON.parse(fs.readFileSync(path.join(RAW, f), 'utf8')); }
function loadDest(f) { return JSON.parse(fs.readFileSync(path.join(DATA, f), 'utf8')); }

function normKey(company, program, term) {
  const norm = s => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  return norm(company) + '::' + norm(program) + (term ? '::' + term : '');
}

// Merge a list of new entries into an existing internships array, deduping by company::program(::term)
function mergeInternships(existing, newEntries, hasTerm) {
  const map = new Map();
  for (const e of existing) {
    map.set(normKey(e.company, e.program, hasTerm ? e.term : null), e);
  }
  let added = 0, updated = 0;
  for (const e of newEntries) {
    const key = normKey(e.company, e.program, hasTerm ? e.term : null);
    if (map.has(key)) {
      // merge: prefer new status/notes/apply_url if present, keep existing otherwise
      const old = map.get(key);
      map.set(key, { ...old, ...e });
      updated++;
    } else {
      map.set(key, e);
      added++;
    }
  }
  return { merged: Array.from(map.values()), added, updated };
}

function writeDest(f, obj) {
  fs.writeFileSync(path.join(DATA, f), JSON.stringify(obj, null, 2) + '\n');
}

const results = {};

// ---- Agent 1 ----
{
  const dest = loadDest('agent1_results.json');
  const raw = [...load('agent1_groupA.json'), ...load('agent1_groupB.json')];
  const { merged, added, updated } = mergeInternships(dest.internships, raw, false);
  dest.internships = merged;
  dest.last_updated = '2026-07-31';
  writeDest('agent1_results.json', dest);
  results.agent1 = { added, updated, total: merged.length };
}

// ---- Agent 2 (incl China/HK-native firms on its roster) ----
{
  const dest = loadDest('agent2_results.json');
  const raw = [...load('agent2_groupA.json'), ...load('agent2_groupB.json'), ...load('agent2_groupC_chinahk.json')];
  const { merged, added, updated } = mergeInternships(dest.internships, raw, false);
  dest.internships = merged;
  dest.last_updated = '2026-07-31';
  writeDest('agent2_results.json', dest);
  results.agent2 = { added, updated, total: merged.length };
}

// ---- Agent 3 ----
{
  const dest = loadDest('agent3_results.json');
  const raw = [...load('agent3_groupA.json'), ...load('agent3_groupB.json')];
  const { merged, added, updated } = mergeInternships(dest.internships, raw, false);
  dest.internships = merged;
  dest.last_updated = '2026-07-31';
  writeDest('agent3_results.json', dest);
  results.agent3 = { added, updated, total: merged.length };
}

// ---- Agent 4 ----
{
  const dest = loadDest('agent4_results.json');
  const raw = [...load('agent4_groupA.json'), ...load('agent4_groupB.json')];
  const { merged, added, updated } = mergeInternships(dest.internships, raw, false);
  dest.internships = merged;
  dest.last_updated = '2026-07-31';
  writeDest('agent4_results.json', dest);
  results.agent4 = { added, updated, total: merged.length };
}

// ---- Agent 5 ----
{
  const dest = loadDest('agent5_results.json');
  const raw = load('agent5.json');
  const { merged, added, updated } = mergeInternships(dest.internships, raw, false);
  dest.internships = merged;
  dest.last_updated = '2026-07-31';
  writeDest('agent5_results.json', dest);
  results.agent5 = { added, updated, total: merged.length };
}

// ---- Sophomore ----
{
  const dest = loadDest('sophomore_results.json');
  const raw = load('sophomore_full.json');
  const { merged, added, updated } = mergeInternships(dest.internships, raw, false);
  dest.internships = merged;
  dest.last_updated = '2026-07-31';
  writeDest('sophomore_results.json', dest);
  results.sophomore = { added, updated, total: merged.length };
}

// ---- Fall2026/Spring2027 off-cycle (has term field) ----
{
  const dest = loadDest('fall2026_results.json');
  const raw = [
    ...load('offcycle_group1_agent1.json'),
    ...load('offcycle_group2_agent2.json'),
    ...load('offcycle_group3_agent3.json'),
    ...load('offcycle_group4_agent4_5.json'),
  ];
  const { merged, added, updated } = mergeInternships(dest.internships, raw, true);
  dest.internships = merged;
  dest.last_updated = '2026-07-31';
  writeDest('fall2026_results.json', dest);
  results.fall2026 = { added, updated, total: merged.length };
}

// ---- Libraries ----
{
  const dest = loadDest('libraries_results.json');
  const raw = [
    ...load('libraries_groupA_B.json'),
    ...load('libraries_groupC_D.json'),
    ...load('libraries_groupE_F.json'),
    ...load('libraries_groupG_H.json'),
  ];
  const { merged, added, updated } = mergeInternships(dest.internships, raw, false);
  dest.internships = merged;
  dest.last_updated = '2026-07-31';
  writeDest('libraries_results.json', dest);
  results.libraries = { added, updated, total: merged.length };
}

// ---- Environmental ----
{
  const dest = loadDest('environmental_results.json');
  const raw = [
    ...load('env_groupA_B.json'),
    ...load('env_groupC_D.json'),
    ...load('env_groupE_F.json'),
    ...load('env_groupG.json'),
  ];
  const { merged, added, updated } = mergeInternships(dest.internships, raw, false);
  dest.internships = merged;
  dest.last_updated = '2026-07-31';
  writeDest('environmental_results.json', dest);
  results.environmental = { added, updated, total: merged.length };
}

// ---- Real Estate ----
{
  const dest = loadDest('realestate_results.json');
  const raw = [
    ...load('re_groupA_B.json'),
    ...load('re_groupC_D.json'),
    ...load('re_groupE_F.json'),
    ...load('re_groupG.json'),
  ];
  const { merged, added, updated } = mergeInternships(dest.internships, raw, false);
  dest.internships = merged;
  dest.last_updated = '2026-07-31';
  writeDest('realestate_results.json', dest);
  results.realestate = { added, updated, total: merged.length };
}

// ---- Fellowships (with MLT removal + eligibility filtering applied at compile time) ----
{
  const dest = loadDest('fellowships_results.json');
  const raw = [
    ...load('fellowships_group1_named.json'),
    ...load('fellowships_group2_discover.json'),
  ];
  // Remove MLT entries per ineligibility finding (restricted to Black/Hispanic/Native American students)
  dest.internships = dest.internships.filter(e => !/management leadership for tomorrow|\bmlt\b/i.test(e.company));
  // Also drop the MLT "flag" entry itself from raw (it's informational only, not a real listing)
  const rawFiltered = raw.filter(e => !/management leadership for tomorrow/i.test(e.company));
  const { merged, added, updated } = mergeInternships(dest.internships, rawFiltered, false);
  dest.internships = merged;
  dest.last_updated = '2026-07-31';
  writeDest('fellowships_results.json', dest);
  results.fellowships = { added, updated, total: merged.length };
}

// ---- China/Hong Kong ----
{
  const dest = loadDest('china_hk_results.json');
  const raw = [
    ...load('chinahk_group1_agent1_3.json'),
    ...load('chinahk_group2_western.json'),
  ];
  const { merged, added, updated } = mergeInternships(dest.internships, raw, false);
  dest.internships = merged;
  dest.last_updated = '2026-07-31';
  writeDest('china_hk_results.json', dest);
  results.china_hk = { added, updated, total: merged.length };
}

// ---- Ithaca ----
{
  const dest = loadDest('ithaca_results.json');
  const raw = load('ithaca_full.json');
  const { merged, added, updated } = mergeInternships(dest.internships, raw, false);
  dest.internships = merged;
  dest.last_updated = '2026-07-31';
  writeDest('ithaca_results.json', dest);
  results.ithaca = { added, updated, total: merged.length };
}

console.log(JSON.stringify(results, null, 2));

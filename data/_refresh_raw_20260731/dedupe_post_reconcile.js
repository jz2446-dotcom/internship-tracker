const fs = require('fs');
const path = require('path');
const DATA = path.join(__dirname, '..');

const FILES = [
  'agent1_results.json','agent2_results.json','agent3_results.json','agent4_results.json','agent5_results.json',
  'sophomore_results.json','fall2026_results.json','libraries_results.json','environmental_results.json',
  'realestate_results.json','fellowships_results.json','china_hk_results.json','ithaca_results.json',
];

function norm(s) { return (s||'').toLowerCase().replace(/[^a-z0-9]/g,''); }

let totalDeduped = 0;
for (const f of FILES) {
  const p = path.join(DATA, f);
  const d = JSON.parse(fs.readFileSync(p, 'utf8'));
  const hasTerm = f === 'fall2026_results.json';
  const map = new Map(); // key -> entry
  let deduped = 0;
  for (const e of d.internships) {
    const key = norm(e.company) + '::' + norm(e.program) + (hasTerm ? '::' + norm(e.term) : '');
    if (!map.has(key)) {
      map.set(key, e);
      continue;
    }
    deduped++;
    const existing = map.get(key);
    // Prefer the one with the longer notes (more accumulated history/context)
    const existingLen = (existing.notes || '').length;
    const newLen = (e.notes || '').length;
    let winner, loser;
    if (newLen > existingLen) { winner = e; loser = existing; } else { winner = existing; loser = e; }
    // Status priority: if verdicts differ, prefer whichever came from the more recent explicit status
    // (both should already reflect this run's Sonnet 5 verification where applicable; if one says
    // closed/program-page and the other open, trust the non-open one only if it has explicit evidence)
    const merged = { ...loser, ...winner };
    // Merge notes without duplicating identical text
    if (loser.notes && winner.notes && !winner.notes.includes(loser.notes.slice(0, 40))) {
      merged.notes = winner.notes + ' | (merged duplicate) ' + loser.notes;
    }
    // Fill in any fields winner lacks from loser
    for (const k of Object.keys(loser)) {
      if (merged[k] === undefined || merged[k] === null || merged[k] === '') merged[k] = loser[k];
    }
    map.set(key, merged);
  }
  d.internships = Array.from(map.values());
  fs.writeFileSync(p, JSON.stringify(d, null, 2) + '\n');
  totalDeduped += deduped;
  console.log(f, 'deduped:', deduped, 'final count:', d.internships.length);
}
console.log('TOTAL DEDUPED:', totalDeduped);

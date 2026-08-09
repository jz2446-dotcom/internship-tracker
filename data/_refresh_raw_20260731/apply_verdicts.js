const fs = require('fs');
const path = require('path');
const RAW = __dirname;
const DATA = path.join(RAW, '..');

const verdicts = JSON.parse(fs.readFileSync(path.join(RAW, 'verdicts.json'), 'utf8'));

const FILES = [
  'agent1_results.json','agent2_results.json','agent3_results.json','agent4_results.json','agent5_results.json',
  'sophomore_results.json','fall2026_results.json','libraries_results.json','environmental_results.json',
  'realestate_results.json','fellowships_results.json','china_hk_results.json','ithaca_results.json',
];

function norm(s) { return (s||'').toLowerCase().replace(/[^a-z0-9]/g,''); }

// Build a verdict lookup keyed by normalized company+program, keeping the LAST verdict seen
// (later batches supersede earlier "program-page" placeholders when we got a better verdict)
const verdictMap = new Map();
for (const v of verdicts) {
  const key = norm(v.company) + '::' + norm(v.program);
  const existing = verdictMap.get(key);
  // Prefer 'open' or 'closed' over 'program-page' if conflicting; else last-write-wins
  if (!existing || existing.verdict === 'program-page' || v.verdict !== 'program-page') {
    verdictMap.set(key, v);
  }
}

let changed = 0, matched = 0;
for (const f of FILES) {
  const p = path.join(DATA, f);
  const d = JSON.parse(fs.readFileSync(p, 'utf8'));
  for (const e of d.internships) {
    if (e.status !== 'open') continue;
    const key = norm(e.company) + '::' + norm(e.program);
    const v = verdictMap.get(key);
    if (!v) continue; // no verdict found for this exact key; leave as-is, flag separately
    matched++;
    if (v.verdict !== e.status) {
      e.status = v.verdict;
      e.notes = (e.notes || '') + ` [Sonnet 5 verify 2026-07-31: ${v.verdict} - ${v.evidence}]`;
      changed++;
    } else {
      e.notes = (e.notes || '') + ` [Sonnet 5 verify 2026-07-31: confirmed open - ${v.evidence}]`;
    }
  }
  fs.writeFileSync(p, JSON.stringify(d, null, 2) + '\n');
}

console.log('Matched:', matched, 'Changed:', changed, 'Total verdicts:', verdicts.length, 'Unique keys:', verdictMap.size);

// Report opens with no verdict found (need investigation)
const allOpens = [];
for (const f of FILES) {
  const d = JSON.parse(fs.readFileSync(path.join(DATA, f), 'utf8'));
  for (const e of d.internships) {
    if (e.status === 'open') {
      const key = norm(e.company) + '::' + norm(e.program);
      if (!verdictMap.has(key)) allOpens.push({ file: f, company: e.company, program: e.program });
    }
  }
}
console.log('Opens with NO verdict (still open, unverified this run):', allOpens.length);
console.log(JSON.stringify(allOpens, null, 2));

const fs = require('fs');
const path = require('path');

const RAW = __dirname;
const DATA = path.join(RAW, '..');

const live = JSON.parse(fs.readFileSync(path.join(RAW, 'live_snapshot.json'), 'utf8'));

const FILLER = new Set(['2026','2027','2028','2029','summer','program','internship','analyst','the','and','for','a','of','in','to','&','-','–','—']);
function tokens(s) {
  return new Set(
    (s || '').toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter(t => t && !FILLER.has(t))
  );
}
function jaccard(a, b) {
  const A = tokens(a), B = tokens(b);
  if (A.size === 0 && B.size === 0) return 1;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  const union = new Set([...A, ...B]).size;
  return union === 0 ? 0 : inter / union;
}

// Build live company -> [programs] map per tab key
function indexOf(internships) {
  const byCompany = {};
  for (const e of internships) {
    if (!byCompany[e.company]) byCompany[e.company] = [];
    byCompany[e.company].push(e.program);
  }
  return byCompany;
}

const liveIdx = {
  agent1: indexOf(live.agents['1'].internships),
  agent2: indexOf(live.agents['2'].internships),
  agent3: indexOf(live.agents['3'].internships),
  agent4: indexOf(live.agents['4'].internships),
  agent5: indexOf(live.agents['5'].internships),
  sophomore: indexOf(live.sophomore.internships),
  fall2026: indexOf(live.fall2026.internships),
  libraries: indexOf(live.libraries.internships),
  environmental: indexOf(live.environmental.internships),
  realestate: indexOf(live.realestate.internships),
  fellowships: indexOf(live.fellowships.internships),
  china_hk: indexOf(live.china_hk.internships),
  ithaca: indexOf(live.ithaca.internships),
};

const FILES = {
  agent1: 'agent1_results.json',
  agent2: 'agent2_results.json',
  agent3: 'agent3_results.json',
  agent4: 'agent4_results.json',
  agent5: 'agent5_results.json',
  sophomore: 'sophomore_results.json',
  fall2026: 'fall2026_results.json',
  libraries: 'libraries_results.json',
  environmental: 'environmental_results.json',
  realestate: 'realestate_results.json',
  fellowships: 'fellowships_results.json',
  china_hk: 'china_hk_results.json',
  ithaca: 'ithaca_results.json',
};

let totalReconciled = 0;
const report = [];

for (const [liveKey, file] of Object.entries(FILES)) {
  const filePath = path.join(DATA, file);
  const dest = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  const liveCompanies = liveIdx[liveKey] || {};

  for (const entry of dest.internships) {
    const livePrograms = liveCompanies[entry.company];
    if (!livePrograms || livePrograms.length === 0) continue;
    if (livePrograms.includes(entry.program)) continue; // exact match already

    // 1:1 fallback: exactly one live program and this company now has exactly one entry in new data
    const newCompanyCount = dest.internships.filter(e => e.company === entry.company).length;
    if (livePrograms.length === 1 && newCompanyCount === 1) {
      report.push({ file, company: entry.company, old: entry.program, new: livePrograms[0], method: '1:1 fallback' });
      entry.program = livePrograms[0];
      totalReconciled++;
      continue;
    }

    // Jaccard match against each live program, pick best >= 0.34
    let best = null, bestScore = 0;
    for (const lp of livePrograms) {
      const score = jaccard(entry.program, lp);
      if (score > bestScore) { bestScore = score; best = lp; }
    }
    if (best && bestScore >= 0.34) {
      report.push({ file, company: entry.company, old: entry.program, new: best, method: `jaccard ${bestScore.toFixed(2)}` });
      entry.program = best;
      totalReconciled++;
    }
  }

  fs.writeFileSync(filePath, JSON.stringify(dest, null, 2) + '\n');
}

console.log('Total reconciled:', totalReconciled);
console.log(JSON.stringify(report, null, 2));

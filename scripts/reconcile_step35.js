const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const LIVE = JSON.parse(fs.readFileSync('C:/Users/justi/AppData/Local/Temp/claude/C--Users-justi/b0a25ec6-e8e6-4e57-b023-e18f83b739c5/scratchpad/live_data_snapshot.json', 'utf8'));

const FILLER = new Set(['2027','2026','2028','2029','summer','program','internship','intern','analyst','the','a','an','of','for','and','&','-','–','–','at']);

function tokens(s) {
  return new Set(
    (s || '')
      .toLowerCase()
      .replace(/[()]/g, ' ')
      .split(/[\s\-\/,]+/)
      .map(t => t.trim())
      .filter(t => t && !FILLER.has(t))
  );
}

function jaccard(a, b) {
  const ta = tokens(a), tb = tokens(b);
  if (ta.size === 0 && tb.size === 0) return 1;
  const inter = [...ta].filter(x => tb.has(x)).length;
  const union = new Set([...ta, ...tb]).size;
  return union === 0 ? 0 : inter / union;
}

function normCompany(c) {
  return (c || '').toLowerCase().trim();
}

// Build live lookup: company -> [programs]
function buildLiveIndex(liveArr) {
  const idx = {};
  for (const e of liveArr || []) {
    const c = normCompany(e.company);
    if (!idx[c]) idx[c] = [];
    idx[c].push(e.program);
  }
  return idx;
}

const targets = [
  { file: 'agent1_results.json', liveArr: LIVE.agents['1'].internships, key: 'internships' },
  { file: 'agent2_results.json', liveArr: LIVE.agents['2'].internships, key: 'internships' },
  { file: 'agent3_results.json', liveArr: LIVE.agents['3'].internships, key: 'internships' },
  { file: 'agent4_results.json', liveArr: LIVE.agents['4'].internships, key: 'internships' },
  { file: 'agent5_results.json', liveArr: LIVE.agents['5'].internships, key: 'internships' },
  { file: 'sophomore_results.json', liveArr: LIVE.sophomore.internships, key: 'internships' },
  { file: 'fall2026_results.json', liveArr: LIVE.fall2026.internships, key: 'internships' },
  { file: 'libraries_results.json', liveArr: LIVE.libraries.internships, key: 'internships' },
  { file: 'environmental_results.json', liveArr: LIVE.environmental.internships, key: 'internships' },
  { file: 'realestate_results.json', liveArr: LIVE.realestate.internships, key: 'internships' },
  { file: 'fellowships_results.json', liveArr: LIVE.fellowships.internships, key: 'internships' },
  { file: 'china_hk_results.json', liveArr: LIVE.china_hk.internships, key: 'internships' },
  { file: 'ithaca_results.json', liveArr: LIVE.ithaca.internships, key: 'internships' },
];

let totalReconciled = 0;
const suspicious = [];
const reconciledLog = [];

for (const t of targets) {
  const fp = path.join(DATA_DIR, t.file);
  if (!fs.existsSync(fp)) { console.log('MISSING', t.file); continue; }
  const data = JSON.parse(fs.readFileSync(fp, 'utf8'));
  const arr = data[t.key];
  const liveIdx = buildLiveIndex(t.liveArr);

  for (const entry of arr) {
    const c = normCompany(entry.company);
    const livePrograms = liveIdx[c];
    if (!livePrograms || livePrograms.length === 0) continue;
    if (entry.program && livePrograms.includes(entry.program)) continue; // already exact match

    // 1:1 fallback
    const newEntriesForCompany = arr.filter(e => normCompany(e.company) === c);
    if (livePrograms.length === 1 && newEntriesForCompany.length === 1) {
      if (entry.program !== livePrograms[0]) {
        reconciledLog.push({ file: t.file, company: entry.company, from: entry.program, to: livePrograms[0], rule: '1:1 fallback' });
        entry.program = livePrograms[0];
        totalReconciled++;
      }
      continue;
    }

    // Jaccard match against each live program for this company
    let best = null, bestScore = 0;
    for (const lp of livePrograms) {
      const score = jaccard(entry.program, lp);
      if (score > bestScore) { bestScore = score; best = lp; }
    }
    if (best && bestScore >= 0.34) {
      if (entry.program !== best) {
        reconciledLog.push({ file: t.file, company: entry.company, from: entry.program, to: best, rule: `jaccard=${bestScore.toFixed(2)}` });
        entry.program = best;
        totalReconciled++;
      }
    } else if (best && bestScore > 0.15) {
      suspicious.push({ file: t.file, company: entry.company, new: entry.program, closestLive: best, score: bestScore.toFixed(2) });
    }
  }

  fs.writeFileSync(fp, JSON.stringify(data, null, 2));
}

console.log('TOTAL RECONCILED:', totalReconciled);
console.log(JSON.stringify(reconciledLog, null, 2));
console.log('SUSPICIOUS (not auto-reconciled, needs review):');
console.log(JSON.stringify(suspicious, null, 2));

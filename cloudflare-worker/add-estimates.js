// Run: node add-estimates.js
// Adds estimated acceptance_rate + competitiveness label to every internship in
// ../data/agent{1..5}_results.json and ../data/sophomore_results.json.
// Estimates are tier-based (firm prestige + role type) — NOT official figures. Labeled "est." in UI.
import { readFileSync, writeFileSync, existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(__dirname, '../data');
const has = (c, arr) => arr.some(x => c.includes(x));

// Tier sets (lowercased company-name substrings)
const MEGAFUND = ['blackstone','kkr','apollo','carlyle','tpg','bain capital','brookfield','ares','general atlantic','warburg','silver lake','thoma bravo','vista','advent','cvc','eqt','sequoia','andreessen','accel','kleiner','lightspeed'];
const ELITE_BANK = ['goldman','morgan stanley','jpmorgan','bank of america','citigroup','citi','barclays','deutsche','ubs','lazard','evercore','centerview','houlihan','pjt','perella','moelis','jefferies','rothschild','guggenheim'];
const ASSET_MGR = ['blackrock','vanguard','fidelity','state street','capital group','t. rowe','invesco','franklin templeton','wellington','pimco','nuveen','cbre'];
const MM_INTL = ['william blair','baird','harris williams','lincoln','piper sandler','stifel','raymond james','cowen','societe generale','bnp','hsbc','credit agricole','natixis','ing','santander','nomura','mizuho','smbc','wells fargo','capital one'];
const MBB = ['mckinsey','boston consulting','bcg','bain & company'];
const CONSULT_T2 = ['oliver wyman','roland berger','l.e.k','lek','kearney','monitor deloitte','parthenon','strategy&','accenture','ibm consulting','alvarez','alixpartners','cornerstone'];
const BIG4 = ['deloitte','pwc','ey (','ernst','kpmg'];
const BIGTECH = ['apple','microsoft','alphabet','google','amazon','meta platforms','nvidia','netflix','tesla'];

function estimate(item) {
  const c = (item.company || '').toLowerCase();
  const cat = (item.category || '').toLowerCase();
  const ib = cat.includes('investment banking') || cat.includes('private equity') || cat.includes('restructuring');

  // No real program → no rate
  if (item.status === 'none' || (Array.isArray(item.class_years) && item.class_years.length === 0 && (item.status === 'unknown' || item.status === 'unclear'))) {
    return { acceptance_rate: '—', competitiveness: 'No undergrad program' };
  }

  if (has(c, MEGAFUND))               return { acceptance_rate: '~<1%',    competitiveness: 'Extremely competitive' };
  if (has(c, MBB))                    return { acceptance_rate: '~1–3%',   competitiveness: 'Extremely competitive' };
  if (has(c, ELITE_BANK))             return ib ? { acceptance_rate: '~1–2%', competitiveness: 'Extremely competitive' }
                                                : { acceptance_rate: '~2–4%', competitiveness: 'Very competitive' };
  if (has(c, ASSET_MGR))             return { acceptance_rate: '~2–5%',   competitiveness: 'Very competitive' };
  if (has(c, CONSULT_T2))            return { acceptance_rate: '~4–8%',   competitiveness: 'Very competitive' };
  if (has(c, MM_INTL))              return { acceptance_rate: '~4–8%',   competitiveness: 'Competitive' };
  if (has(c, BIGTECH))             return { acceptance_rate: '~3–7%',   competitiveness: 'Very competitive' };
  if (has(c, BIG4))               return { acceptance_rate: '~12–20%', competitiveness: 'Moderate' };
  return { acceptance_rate: '~8–15%', competitiveness: 'Moderate' };
}

// Sophomore programs: diversity/accounting/corporate pipelines are more accessible; elite stay low.
const SOPH_ELITE = ['mckinsey','boston consulting','bcg','goldman','morgan stanley','kkr','vista'];
const SOPH_ACCESSIBLE = ['deloitte','pwc','ey','kpmg','american express','capital one','wells fargo','jpmorgan','mastercard','coca-cola','ge aerospace','johnson & johnson','nvidia'];
function estimateSoph(item) {
  const c = (item.company || '').toLowerCase();
  if (has(c, SOPH_ELITE))       return { acceptance_rate: '~<1–2%', level: 'Extremely competitive' };
  if (has(c, SOPH_ACCESSIBLE)) return { acceptance_rate: '~8–15%', level: 'Accessible / Moderate' };
  return { acceptance_rate: '~3–6%', level: 'Competitive' };
}

let total = 0;
for (let i = 1; i <= 5; i++) {
  const f = path.join(dataDir, `agent${i}_results.json`);
  if (!existsSync(f)) continue;
  const d = JSON.parse(readFileSync(f, 'utf-8'));
  d.internships.forEach(it => { const e = estimate(it); it.acceptance_rate = e.acceptance_rate; it.competitiveness = e.competitiveness; total++; });
  writeFileSync(f, JSON.stringify(d, null, 2));
  console.log(`Agent ${i}: tagged ${d.internships.length}`);
}

const sf = path.join(dataDir, 'sophomore_results.json');
if (existsSync(sf)) {
  const d = JSON.parse(readFileSync(sf, 'utf-8'));
  d.internships.forEach(it => {
    const e = estimateSoph(it);
    it.acceptance_rate = e.acceptance_rate;
    // keep existing descriptive competitiveness text, but prefix the level label
    it.competitiveness = it.competitiveness ? `${e.level} — ${it.competitiveness}` : e.level;
    total++;
  });
  writeFileSync(sf, JSON.stringify(d, null, 2));
  console.log(`Sophomore: tagged ${d.internships.length}`);
}

const ff = path.join(dataDir, 'fall2026_results.json');
if (existsSync(ff)) {
  const d = JSON.parse(readFileSync(ff, 'utf-8'));
  d.internships.forEach(it => { const e = estimate(it); it.acceptance_rate = e.acceptance_rate; it.competitiveness = e.competitiveness; total++; });
  writeFileSync(ff, JSON.stringify(d, null, 2));
  console.log(`Fall 2026: tagged ${d.internships.length}`);
}
for (const name of ['environmental_results', 'realestate_results', 'libraries_results']) {
  const xf = path.join(dataDir, `${name}.json`);
  if (!existsSync(xf)) continue;
  const d = JSON.parse(readFileSync(xf, 'utf-8'));
  d.internships.forEach(it => { const e = estimate(it); it.acceptance_rate = e.acceptance_rate; it.competitiveness = e.competitiveness; total++; });
  writeFileSync(xf, JSON.stringify(d, null, 2));
  console.log(`${name}: tagged ${d.internships.length}`);
}
console.log(`✓ Added estimates to ${total} programs`);

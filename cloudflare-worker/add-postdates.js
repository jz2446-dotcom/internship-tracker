// Run: node add-postdates.js — adds posted_date / close_date to the verified-open programs (Opus, 2026-06-27).
import { readFileSync, writeFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dir = path.join(__dirname, '../data');

const dates = {
  'agent1_results.json': [
    { company:'Centerview Partners', inc:'Summer Analyst', posted:'rolling', close:'until filled' }
  ],
  'agent2_results.json': [
    { company:'Wells Fargo', inc:'Finance Summer Internship', posted:'', close:'2026-09-29' },
    { company:'Wells Fargo', inc:'Wealth & Investment Management', posted:'', close:'2026-09-29' },
    { company:'Wells Fargo', inc:'Commercial Banking', posted:'', close:'2026-09-30' }
  ],
  'agent3_results.json': [
    { company:'Amazon', inc:'Business Unit Finance', posted:'2025-11-19', close:'' },
    { company:'Amazon', inc:'Operations Finance', posted:'2025-11-19', close:'' },
    { company:'Amazon', inc:'Accounting Intern', posted:'2025-11-19', close:'' }
  ],
  'agent4_results.json': [
    { company:'Bain & Company', inc:'Associate Consultant Internship', posted:'', close:'2026-08-31' },
    { company:'PwC', inc:'Destination CPA', posted:'', close:'until filled' },
    { company:'AlixPartners', inc:'Turnaround', posted:'2026-05-06', close:'' },
    { company:'AlixPartners', inc:'Investigations', posted:'2026-05-06', close:'' }
  ]
};

let n = 0;
for (const [file, list] of Object.entries(dates)) {
  const p = path.join(dir, file);
  const d = JSON.parse(readFileSync(p, 'utf-8'));
  for (const ch of list) {
    const hits = d.internships.filter(it => it.company === ch.company && (it.program||'').includes(ch.inc));
    if (!hits.length) { console.log('!! no match:', ch.company, ch.inc); continue; }
    for (const it of hits) {
      if (ch.posted) it.posted_date = ch.posted;
      if (ch.close) it.close_date = ch.close;
      n++;
      console.log(`${ch.company} / ${ch.inc}: posted=${ch.posted||'—'} close=${ch.close||'—'}`);
    }
  }
  writeFileSync(p, JSON.stringify(d, null, 2));
}
console.log(`\n✓ Added dates to ${n} open programs`);

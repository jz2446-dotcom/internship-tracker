// Run: node fix-status.js
// Applies Opus re-verification (2026-06-27) corrections to status, appending a re-verify note.
import { readFileSync, writeFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dir = path.join(__dirname, '../data');
const TAG = ' [Re-verified 2026-06-27]';

// file -> [ {company, inc (program substring), status, why} ]
const changes = {
  'agent1_results.json': [
    { company:'Citigroup', inc:'Sales & Trading', status:'closed', why:'Close date Dec 29 2025 (passed).' },
    { company:'Citigroup', inc:'Quantitative', status:'closed', why:'Close date Dec 29 2025 (passed).' },
    { company:'BlackRock', inc:'AMERS', status:'program-page', why:'Review windows passed; no function confirmed accepting now.' },
    { company:'T. Rowe Price', inc:'Equity Research', status:'program-page', why:'CONFLICT: a Built In mirror shows the req removed Apr 10 2026, but the portal still shows Apply — verify directly.' },
    { company:'Blackstone', inc:'Private Equity', status:'closed', why:'Opened Jan 2, closed ~Mar 31 2026.' },
    { company:'Blackstone', inc:'Credit & Insurance', status:'program-page', why:'No live accepting req confirmable (Workday bot-walled).' },
    { company:'Apollo Global Management', inc:'Credit Trading', status:'program-page', why:'Workday req not confirmable as live-accepting.' },
    { company:'Apollo Global Management', inc:'Real Estate Credit', status:'program-page', why:'Workday req not confirmable as live-accepting.' },
    { company:'Lazard', inc:'Financial Advisory', status:'closed', why:'2027 FA Summer Analyst shows "closed to applications".' },
    { company:'Houlihan Lokey', inc:'Investment Banking Summer Analyst', status:'program-page', why:'Req indexed but live-accepting status not confirmable (Workday bot-walled).' }
  ],
  'agent2_results.json': [
    { company:'Guggenheim', inc:'Generalist', status:'program-page', why:'Workday req not confirmable live; typical Jan–Feb window likely passed.' },
    { company:'Guggenheim', inc:'Private Capital Advisory', status:'program-page', why:'Workday req not confirmable live.' },
    { company:'Barclays', inc:'Coverage/M&A', status:'closed', why:'Posting removed (404); Markets roles confirmed removed Dec 17 2025.' },
    { company:'Barclays', inc:'Capital Markets', status:'closed', why:'Posting removed (404).' },
    { company:'Barclays', inc:'Sales, Trading', status:'closed', why:'Posting removed (404/410 Gone).' },
    { company:'Barclays', inc:'Quantitative', status:'closed', why:'Built In: removed Dec 17 2025.' },
    { company:'Wells Fargo', inc:'Investment Banking Summer Analyst', status:'closed', why:'Dedicated IB reqs removed (404); only a separate CIB-COO ops role remains open.' },
    { company:'Wells Fargo', inc:'Finance Summer Internship', status:'open', why:'Apply Now live; closes Sep 29 2026.' },
    { company:'Wells Fargo', inc:'Wealth & Investment Management', status:'open', why:'Apply Now live; closes Sep 29 2026.' },
    { company:'Wells Fargo', inc:'Commercial Banking', status:'open', why:'Apply Now live; closes Sep 30 2026.' }
  ],
  'agent3_results.json': [
    { company:'Amazon', inc:'Business Unit Finance', status:'open', why:'Apply Now live.' },
    { company:'Amazon', inc:'Operations Finance', status:'open', why:'Apply Now live.' },
    { company:'Amazon', inc:'Accounting Intern', status:'open', why:'"Applications are now open"; Apply Now live.' }
  ],
  'agent4_results.json': [
    { company:'McKinsey & Company', inc:'Business Analyst Intern', status:'closed', why:'Fixed deadline Mar 29 2026 (passed).' },
    { company:'Bain & Company', inc:'Associate Consultant Internship', status:'open', why:'Round 2 deadline Aug 31 2026 (future).' },
    { company:'PwC', inc:'Destination CPA', status:'open', why:'"Accepted until filled or removed"; active Apply.' },
    { company:'PwC', inc:'Financial Due Diligence', status:'closed', why:'Posting end date Jun 8 2026 (passed).' },
    { company:'KPMG', inc:'Audit Intern', status:'closed', why:'"Filled or no longer available".' },
    { company:'AlixPartners', inc:'Turnaround', status:'open', why:'Apply Now live (posted May 6 2026).' },
    { company:'AlixPartners', inc:'Investigations', status:'open', why:'Apply Now live (posted May 6 2026).' }
  ],
  'agent5_results.json': [
    { company:'The Boeing Company', inc:'Finance Career Foundation', status:'program-page', why:'Workday req exists but live-accepting state not confirmable.' },
    { company:'General Dynamics', inc:'Year-Round Finance', status:'program-page', why:'Careers site 403/JS-rendered; not confirmable live.' },
    { company:'Northrop Grumman', inc:'Finance Analyst', status:'program-page', why:'JS-rendered; a career-center mirror shows 410 Gone (likely removed).' }
  ],
  'sophomore_results.json': [
    { company:'JPMorgan Chase', inc:'Fellowship', status:'closed', why:'2026 cycle deadline Jan 13 2026 (passed); info page loads but shows no active req. (This was the reported bug.)' },
    { company:'T. Rowe Price', inc:'Equity Research', status:'program-page', why:'CONFLICT: Built In shows removed Apr 10 2026, portal shows Apply — verify directly.' }
  ]
};

let changed = 0;
for (const [file, list] of Object.entries(changes)) {
  const p = path.join(dir, file);
  const d = JSON.parse(readFileSync(p, 'utf-8'));
  for (const ch of list) {
    const hits = d.internships.filter(it => it.company === ch.company && (it.program||'').includes(ch.inc));
    if (!hits.length) { console.log('!! no match:', file, ch.company, ch.inc); continue; }
    for (const it of hits) {
      const old = it.status;
      it.status = ch.status;
      if (!it.notes.includes('[Re-verified')) it.notes = it.notes + TAG + ' ' + ch.why;
      changed++;
      if (old !== ch.status) console.log(`${ch.company} / ${ch.inc}: ${old} -> ${ch.status}`);
    }
  }
  writeFileSync(p, JSON.stringify(d, null, 2));
}
console.log(`\n✓ Applied ${changed} corrections`);

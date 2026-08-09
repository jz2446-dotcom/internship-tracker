// finalize_v2.js — explicit, safe Step 3/3.5 application of verified statuses.
// UPDATE existing entries in place by exact company+program match (text stays stable →
// no applied-checkbox/note orphaning). ADD only genuinely-new open programs.
const fs = require("fs");
const path = require("path");
const DATA = path.join(__dirname, "../../data");
const MASTER = path.join(__dirname, "../../Resumes/_master");
const SCRATCH = process.env.SCRATCH;
const urls = require(path.join(SCRATCH, "new_urls.json"));
const haveResume = new Set(fs.readdirSync(MASTER).filter((f) => /^min_.*\.pdf$/.test(f)).map((f) => f.replace(/^min_|\.pdf$/g, "")));

const load = (a) => JSON.parse(fs.readFileSync(path.join(DATA, `${a}_results.json`), "utf8"));
const save = (a, d) => fs.writeFileSync(path.join(DATA, `${a}_results.json`), JSON.stringify(d, null, 2));

// UPDATES: match an existing entry by company + program contains(needle) -> flip to open
const updates = [
  { agent: "agent1", company: "JPMorgan Chase", needle: "2027 Markets Summer Analyst Program", id: "jpm_mkt", apply: urls.jpm_mkt },
  { agent: "agent1", company: "JPMorgan Chase", needle: "Global Private Bank Summer Analyst", id: "jpm_gpb", apply: urls.jpm_gpb },
  { agent: "agent1", company: "T. Rowe Price", needle: "Equity Research Internship", id: "trowe_er" },
  { agent: "agent4", company: "Roland Berger", needle: "Summer Internship", id: "rberger" },
  { agent: "agent5", company: "Caterpillar", needle: "Corporate Finance Internship", id: "cat_fin", apply: urls.cat_fin, close: "2026-07-10" },
];
// ADDS: genuinely-new open programs
const adds = [
  { agent: "agent1", id: "jpm_csi", company: "JPMorgan Chase", program: "2027 Commercial & Specialized Industries Summer Analyst Program", apply: urls.jpm_csi, cy: ["2028"], cat: "Commercial Banking", loc: "Multiple (US)" },
  { agent: "agent1", id: "bofa_risk", company: "Bank of America", program: "Global Risk Summer Analyst Program – 2027", apply: urls.bofa_risk, cy: ["2028"], cat: "Risk Management", loc: "Charlotte, NC / New York, NY", close: "2026-10-01" },
];

const report = { updated: [], added: [] };
const dirty = {};
const get = (a) => (dirty[a] ||= load(a));

for (const u of updates) {
  const d = get(u.agent);
  const e = (d.internships || []).find((x) => x.company === u.company && x.program.includes(u.needle));
  if (!e) { report.updated.push(`NOT FOUND: ${u.company} / ${u.needle}`); continue; }
  const was = e.status; e.status = "open";
  if (u.apply) e.apply_url = u.apply;
  if (u.close) e.close_date = u.close;
  if (haveResume.has(u.id)) e.resume_url = `/resume/${u.id}`;
  e.notes = (e.notes ? e.notes + " | " : "") + "Confirmed OPEN via Opus verification 2026-07-10.";
  report.updated.push(`${u.company} :: ${e.program.slice(0, 40)} [${was}->open]${haveResume.has(u.id) ? " +resume" : ""}`);
}
for (const a of adds) {
  const d = get(a.agent);
  const dup = (d.internships || []).find((x) => x.company === a.company && x.program === a.program);
  if (dup) { report.added.push(`DUP-SKIP ${a.program}`); continue; }
  const entry = { company: a.company, program: a.program, category: a.cat, class_years: a.cy, location: a.loc, status: "open", apply_url: a.apply, notes: "Confirmed OPEN via Opus verification 2026-07-10.", source: "claude" };
  if (a.close) entry.close_date = a.close;
  if (haveResume.has(a.id)) entry.resume_url = `/resume/${a.id}`;
  d.internships.push(entry);
  report.added.push(`${a.company} :: ${a.program.slice(0, 40)} [${a.id}]${haveResume.has(a.id) ? " +resume" : " (resume-pending)"}`);
}
for (const a of Object.keys(dirty)) { dirty[a].last_updated = "2026-07-10"; save(a, dirty[a]); }

console.log("UPDATED:"); report.updated.forEach((x) => console.log("  " + x));
console.log("ADDED:"); report.added.forEach((x) => console.log("  " + x));
// final open count
let open = 0, withResume = 0;
for (const a of ["agent1", "agent2", "agent3", "agent4", "agent5", "sophomore"]) { for (const e of load(a).internships || []) if (e.status === "open") { open++; if (e.resume_url) withResume++; } }
console.log(`\nTotal OPEN now: ${open} | with resume_url: ${withResume} | resume-pending: ${open - withResume}`);

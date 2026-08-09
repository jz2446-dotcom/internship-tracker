// apply-verdicts.js — the merge step for `--brain defer` runs (driven by the `new-refresh`
// skill). It combines three inputs into the final tracker-schema results file for one agent:
//   1. <agent>_results.partial.json — the free-decided internships (ATS board / title gate)
//   2. <agent>_shortlist.json       — ambiguous candidates, each carrying a NIM backup verdict
//   3. <agent>_verdicts.json        — the session Claude's verdicts (written by the skill)
//
// Reconciliation, per shortlist item: Claude is the PRIMARY brain — and because it judged each
// item WITH NIM's verdict in view, its call already reconciles the two. NIM is the BACKUP: used
// verbatim for any item Claude didn't return a verdict for (e.g. a headless run where the Claude
// phase never happened). Each entry's `source` records which path decided it, so consensus vs.
// single-brain vs. backup is visible in the shipped data.
//
// Usage:
//   node apply-verdicts.js --agent environmental [--dir ../data] [--out <path>]
const fs = require("fs");
const path = require("path");

function arg(name, def) {
  const i = process.argv.indexOf("--" + name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

const AGENT = arg("agent");
if (!AGENT) { console.error("--agent <name> is required (e.g. environmental)"); process.exit(2); }
const DIR = arg("dir", path.join(__dirname, "..", "data"));
const OUT = arg("out", path.join(DIR, AGENT + "_results.json"));

const partialPath = path.join(DIR, AGENT + "_results.partial.json");
const shortPath = path.join(DIR, AGENT + "_shortlist.json");
const verdictPath = path.join(DIR, AGENT + "_verdicts.json");

function readJson(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch (_) { return fallback; }
}

const partial = readJson(partialPath, null);
if (!partial) {
  console.error(`missing/unreadable ${partialPath} — run the analyst in --brain defer mode first`);
  process.exit(1);
}
const short = readJson(shortPath, { shortlist: [] });
const verdictsRaw = readJson(verdictPath, { verdicts: [] });

// Lookup of Claude verdicts by normalized company::title. Accepts either { verdicts: [...] }
// or a bare array, so the skill can write whichever is simpler.
const norm = (s) => (s || "").toLowerCase().trim();
const vkey = (c, t) => `${norm(c)}::${norm(t)}`;
const verdicts = new Map();
for (const v of verdictsRaw.verdicts || verdictsRaw || []) {
  if (v && v.company && v.title) verdicts.set(vkey(v.company, v.title), v);
}

const internships = [];
const seen = new Set();
const stats = { free: (partial.internships || []).length, consensus: 0, claude: 0, nim_backup: 0, undecided: 0, dropped: 0, carried: 0 };

function pushEntry(e) {
  const k = `${norm(e.company)}::${norm(e.program)}`;
  if (seen.has(k)) return;
  seen.add(k);
  internships.push(e);
}

// 1) carry the free-decided internships straight through.
for (const e of partial.internships || []) pushEntry(e);

// 1.5) firms this sweep couldn't even check (no ATS match, no scrapeable careers page)
// keep their prior entries rather than silently dropping them — "unresolved" is not
// evidence a posting closed, just that this run's coverage missed the firm.
const unresolvedSet = new Set((partial.unresolvedCompanies || []).map(norm));
if (unresolvedSet.size) {
  const prior = readJson(OUT, null);
  for (const e of (prior && prior.internships) || []) {
    if (unresolvedSet.has(norm(e.company))) {
      pushEntry({ ...e, notes: e.notes ? e.notes : "", carried_forward: true });
      stats.carried++;
    }
  }
}

// 2) reconcile each shortlist item: Claude primary (judged with NIM in view), NIM as backup.
const agree = (a, b) => a && b && !!a.relevant === !!b.relevant && a.status === b.status;
for (const item of short.shortlist || []) {
  const claudeV = verdicts.get(vkey(item.company, item.title));
  const nimV = item.nim;
  const final = claudeV || nimV;
  if (!final) { stats.undecided++; continue; }        // no brain ruled at all
  if (!final.relevant) { stats.dropped++; continue; } // ruled not a fit for the tab
  let source;
  if (claudeV && nimV) {
    if (agree(claudeV, nimV)) { source = "consensus:claude+nim"; stats.consensus++; }
    else { source = "brain:claude(over-nim)"; stats.claude++; }
  } else if (claudeV) { source = "brain:claude"; stats.claude++; }
  else { source = "brain:nim(backup)"; stats.nim_backup++; }
  pushEntry({
    company: item.company,
    program: item.title,
    category: AGENT,
    class_years: Array.isArray(final.class_years) ? final.class_years : ["2028", "2029"],
    location: final.location || item.location || "",
    status: ["open", "closed", "program-page"].includes(final.status) ? final.status : "program-page",
    apply_url: item.apply_url,
    notes: final.notes || "",
    source,
  });
}

fs.writeFileSync(OUT, JSON.stringify({
  agent: AGENT, name: partial.name, focus: partial.focus, last_updated: partial.last_updated, internships,
}, null, 2));

console.error("── apply-verdicts summary ──────────────────────");
console.error(`free carried:   ${stats.free}`);
console.error(`carried fwd:    ${stats.carried}   (prior entries kept — firm unresolved this sweep, not evidence it closed)`);
console.error(`consensus:      ${stats.consensus}   (Claude + NIM agree)`);
console.error(`claude-ruled:   ${stats.claude}   (Claude present; NIM absent or overridden)`);
console.error(`nim-backup:     ${stats.nim_backup}   (no Claude verdict — NIM stood in)`);
console.error(`dropped:        ${stats.dropped} not-relevant   |   undecided (no brain): ${stats.undecided}`);
console.error(`final kept:     ${internships.length} relevant internships → ${OUT}`);
console.error("────────────────────────────────────────────────");

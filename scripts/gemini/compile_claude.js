// compile_claude.js — merge the 10 Claude group checkpoints into one normalized
// entry set, mapped back to the correct agent, deduped, class_years normalized.
// Prints the open set. Writes <SCRATCH>/claude_entries.json (flat) + per-agent buckets.
const fs = require("fs");
const path = require("path");

const SCRATCH = process.env.SCRATCH;
const dir = path.join(SCRATCH, "claude");
// group -> agent file
const GROUP_AGENT = { G1: 1, G2: 1, G3: 2, G4: 3, G5: 3, G6: 4, G7: 4, G8: 5, SophA: "soph", SophB: "soph" };

function normClassYears(cy) {
  // schema wants ["2028"] / ["2029"] / [] (empty = MBA-only/no-undergrad, hidden from toggles)
  if (Array.isArray(cy)) return cy.filter((x) => /^20\d\d$/.test(String(x)));
  const s = String(cy || "");
  const out = new Set();
  // undergrad Summer 2027 => sophomores (2028) and juniors (2029) are the tracked class years
  if (/mba/i.test(s) && !/undergrad|bachelor/i.test(s)) return []; // MBA-only -> hidden
  if (/2028/.test(s)) out.add("2028");
  if (/2029/.test(s)) out.add("2029");
  // grad-year language: "graduating ... 2028" already caught; default undergrad summer-2027 -> both
  if (!out.size && /(undergrad|bachelor|sophomore|junior|rising|current)/i.test(s)) { out.add("2028"); out.add("2029"); }
  return [...out];
}
const normCo = (s) => (s || "").toLowerCase().replace(/&amp;/g, "&").replace(/[^a-z0-9]+/g, " ").trim();
const clean = (s) => (typeof s === "string" ? s.replace(/&amp;/g, "&") : s);

const buckets = { 1: [], 2: [], 3: [], 4: [], 5: [], soph: [] };
const all = [];
const seen = new Map();
const groupsFound = [];
for (const g of Object.keys(GROUP_AGENT)) {
  const f = path.join(dir, g + ".json");
  if (!fs.existsSync(f)) continue;
  let arr;
  try { arr = JSON.parse(fs.readFileSync(f, "utf8")); } catch (e) { console.error("BAD JSON:", g, e.message); continue; }
  if (!Array.isArray(arr)) continue;
  groupsFound.push(g + "(" + arr.length + ")");
  const agent = GROUP_AGENT[g];
  for (const e of arr) {
    e.company = clean(e.company); e.program = clean(e.program); e.category = clean(e.category); e.notes = clean(e.notes);
    e.class_years = normClassYears(e.class_years);
    e.source = "claude";
    const key = normCo(e.company) + "::" + normCo(e.program);
    if (seen.has(key)) {
      // dedupe: prefer 'open' status; merge
      const prev = seen.get(key);
      const rank = { open: 3, closed: 2, "program-page": 1 };
      if ((rank[e.status] || 0) > (rank[prev.status] || 0)) { Object.assign(prev, e); }
      continue;
    }
    const rec = { ...e, __agent: agent };
    seen.set(key, rec); all.push(rec);
    (buckets[agent] || (buckets[agent] = [])).push(rec);
  }
}
fs.writeFileSync(path.join(SCRATCH, "claude_entries.json"), JSON.stringify(all, null, 1));
fs.writeFileSync(path.join(SCRATCH, "claude_buckets.json"), JSON.stringify(buckets, null, 1));

const open = all.filter((e) => e.status === "open");
console.log("Groups compiled:", groupsFound.join(" "));
console.log("Total unique entries:", all.length, "| open:", open.length);
console.log("\n=== OPEN SET (Claude) ===");
for (const e of open) console.log(`[a${e.__agent}] ${e.company} :: ${e.program} | cy=${JSON.stringify(e.class_years)}`);

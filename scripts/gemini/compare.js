// compare.js — reconcile Claude's research against Gemini's, producing the
// "best report": where they agree, where they conflict (→ priority Opus verify),
// and what each found that the other missed. Program matching reuses the skill's
// Step 3.5 heuristic (strip filler, token-Jaccard >= 0.34, plus 1:1 per-company fallback).
//
// Usage: node compare.js <claude_entries.json> <gemini_research_dir> <out_prefix>
//   claude_entries.json = flat array of Claude entries {company,program,status,...}
//   gemini_research_dir = dir of per-company arrays written by research.js
// Writes <out_prefix>.json (structured) and <out_prefix>.md (human report).
const fs = require("fs");
const path = require("path");

const [, , claudePath, gemDir, outPrefix] = process.argv;
if (!claudePath || !gemDir || !outPrefix) { console.error("usage: node compare.js <claude.json> <gemini_dir> <out_prefix>"); process.exit(1); }

const normCo = (s) => (s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\b(inc|llc|lp|group|company|co|the|and)\b/g, "").trim();
const FILLER = new Set(["2027", "2028", "2029", "summer", "program", "internship", "intern", "analyst", "the", "and", "of", "for", "a", "an", "amers", "americas", "us", "na"]);
const tokens = (s) => (s || "").toLowerCase().split(/[^a-z0-9]+/).filter((w) => w && !FILLER.has(w));
function jaccard(a, b) {
  const A = new Set(tokens(a)), B = new Set(tokens(b));
  if (!A.size && !B.size) return 1;
  let inter = 0; for (const x of A) if (B.has(x)) inter++;
  return inter / (A.size + B.size - inter);
}

const claude = JSON.parse(fs.readFileSync(claudePath, "utf8"));
// load gemini per-company files
let gemini = [];
for (const f of fs.readdirSync(gemDir)) {
  if (!f.endsWith(".json") || f.startsWith("_")) continue;
  try { const arr = JSON.parse(fs.readFileSync(path.join(gemDir, f), "utf8")); if (Array.isArray(arr)) gemini.push(...arr); } catch (e) {}
}

// index gemini by company
const gemByCo = {};
for (const g of gemini) { (gemByCo[normCo(g.company)] ||= []).push(g); }
const claudeCos = new Set(claude.map((c) => normCo(c.company)));
const gemCos = new Set(gemini.map((g) => normCo(g.company)));

const rows = [];
const usedGem = new Set();
for (const c of claude) {
  const co = normCo(c.company);
  const cands = (gemByCo[co] || []);
  let best = null, bestScore = 0;
  for (const g of cands) { const s = jaccard(c.program, g.program); if (s > bestScore) { bestScore = s; best = g; } }
  // 1:1 fallback: one entry each side for this company
  if ((!best || bestScore < 0.34) && cands.length === 1 && claude.filter((x) => normCo(x.company) === co).length === 1) { best = cands[0]; bestScore = 0.34; }
  if (best && bestScore >= 0.34) usedGem.add(best);
  const gemStatus = best && bestScore >= 0.34 ? best.status : null;
  let verdict;
  if (!gemCos.has(co)) verdict = "claude-only-cos-uncovered"; // Gemini never researched this company (quota)
  else if (gemStatus == null) verdict = "claude-only-program";  // Gemini covered company but missed this program
  else if (c.status === gemStatus) verdict = "agree-" + c.status;
  else verdict = "DISAGREE";
  rows.push({ company: c.company, program: c.program, claude_status: c.status, gemini_status: gemStatus, match: +bestScore.toFixed(2), verdict, apply_url: c.apply_url });
}
// gemini-only programs (in a company Claude also researched, but no claude match)
const gemOnly = [];
for (const g of gemini) {
  if (usedGem.has(g)) continue;
  const co = normCo(g.company);
  if (!claudeCos.has(co)) { gemOnly.push({ ...g, why: "company-not-in-claude" }); continue; }
  // check claude has no fuzzy match
  const cc = claude.filter((x) => normCo(x.company) === co);
  const anyMatch = cc.some((x) => jaccard(x.program, g.program) >= 0.34);
  if (!anyMatch) gemOnly.push({ ...g, why: "program-not-in-claude" });
}

const tally = {};
for (const r of rows) tally[r.verdict] = (tally[r.verdict] || 0) + 1;
const disagreements = rows.filter((r) => r.verdict === "DISAGREE");
const geminiOnlyOpen = gemOnly.filter((g) => g.status === "open");

// priority verify list: any disagreement, plus gemini-only OPEN finds
const verifyPriority = [
  ...disagreements.map((d) => ({ company: d.company, program: d.program, apply_url: d.apply_url, reason: `Claude=${d.claude_status} vs Gemini=${d.gemini_status}` })),
  ...geminiOnlyOpen.map((g) => ({ company: g.company, program: g.program, apply_url: g.apply_url, reason: `Gemini-only OPEN find (${g.why})` })),
];

const result = { generated: "2026-07-09", gemini_companies_covered: gemCos.size, gemini_programs_found: gemini.length, tally, disagreements, gemini_only: gemOnly, verify_priority: verifyPriority };
fs.writeFileSync(outPrefix + ".json", JSON.stringify(result, null, 1));

// markdown
let md = `# Claude vs Gemini research reconciliation\n\nGenerated 2026-07-09.\n\n`;
md += `- Gemini independently covered **${gemCos.size}** companies, surfacing **${gemini.length}** programs before quota.\n`;
md += `- Claude entries compared: **${claude.length}**.\n\n## Agreement tally\n\n| Verdict | Count |\n|---|---|\n`;
for (const k of Object.keys(tally).sort()) md += `| ${k} | ${tally[k]} |\n`;
md += `\n## Disagreements (→ priority Opus verify)\n\n`;
if (!disagreements.length) md += `_None._\n`;
else { md += `| Company | Program | Claude | Gemini |\n|---|---|---|---|\n`; for (const d of disagreements) md += `| ${d.company} | ${d.program} | ${d.claude_status} | ${d.gemini_status} |\n`; }
md += `\n## Gemini-only finds (Claude missed — candidates to verify/add)\n\n`;
if (!gemOnly.length) md += `_None._\n`;
else { md += `| Company | Program | Gemini status | Why |\n|---|---|---|---|\n`; for (const g of gemOnly) md += `| ${g.company} | ${g.program} | ${g.status} | ${g.why} |\n`; }
fs.writeFileSync(outPrefix + ".md", md);
console.log(`Reconciled. tally=${JSON.stringify(tally)} disagreements=${disagreements.length} gemini_only=${gemOnly.length} verify_priority=${verifyPriority.length}`);
console.log(`Wrote ${outPrefix}.json and ${outPrefix}.md`);

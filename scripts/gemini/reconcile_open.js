// reconcile_open.js — join Claude's open claim + Opus verdict + Gemini judge verdict
// for each open posting, on the SAME evidence (Opus's fetched page_excerpt is what
// Gemini judged). Opus is the authority for the final status; Gemini is the second
// opinion. Emits the final open set + a Claude-vs-Opus-vs-Gemini comparison report.
//
// Inputs (all in SCRATCH):
//   claude_open.json   [{n,company,program,apply_url,claude_status:"open",class_years,__agent,id?}]
//   opus_verdicts.json [{n,company,program,opus_status,evidence_quote,close_date,page_excerpt,mba_only?}]
//   gemini_judge.json  [{n,gemini_status,confidence,reason,quote}]
const fs = require("fs");
const path = require("path");
const SCRATCH = process.env.SCRATCH;
const rd = (f) => JSON.parse(fs.readFileSync(path.join(SCRATCH, f), "utf8"));

const claude = rd("claude_open.json");
const opus = rd("opus_verdicts.json");
const gem = rd("gemini_judge.json");
const byN = (arr) => Object.fromEntries(arr.map((x) => [x.n, x]));
const O = byN(opus), G = byN(gem);

const rows = claude.map((c) => {
  const o = O[c.n] || {}, g = G[c.n] || {};
  const final = o.opus_status || "program-page"; // Opus is authority
  return {
    n: c.n, company: c.company, program: c.program, id: c.id, apply_url: c.apply_url,
    claude: "open", opus: o.opus_status || "?", gemini: g.gemini_status || "?",
    final, mba_only: !!o.mba_only,
    agree_opus_gem: o.opus_status && g.gemini_status ? (o.opus_status === g.gemini_status) : null,
    evidence: o.evidence_quote || "", close_date: o.close_date || "", gem_reason: g.reason || "",
  };
});

const finalOpen = rows.filter((r) => r.final === "open" && !r.mba_only);
const downgraded = rows.filter((r) => r.final !== "open");
const splits = rows.filter((r) => r.agree_opus_gem === false);

const out = { generated: "2026-07-09", total_claude_open: rows.length, final_open: finalOpen.length, rows, final_open_set: finalOpen, downgraded, opus_gemini_splits: splits };
fs.writeFileSync(path.join(SCRATCH, "reconcile_open.json"), JSON.stringify(out, null, 1));

// markdown comparison report
let md = `## Open-set verification — Claude claim vs Opus (authority) vs Gemini (judge)\n\n`;
md += `25 postings Claude tagged \`open\` were re-verified. Opus sets the final status; Gemini independently judged the same page text.\n\n`;
md += `| # | Company · Program | Claude | Opus | Gemini | Final | O/G agree |\n|---|---|---|---|---|---|---|\n`;
for (const r of rows) {
  md += `| ${r.n} | ${r.company} · ${r.program.slice(0, 42)} | open | ${r.opus} | ${r.gemini} | **${r.final}**${r.mba_only ? " (MBA-only→hidden)" : ""} | ${r.agree_opus_gem === null ? "—" : r.agree_opus_gem ? "✓" : "✗ SPLIT"} |\n`;
}
md += `\n**Final confirmed-open (excl. MBA-only): ${finalOpen.length}**\n`;
const agreeCount = rows.filter((r) => r.agree_opus_gem === true).length;
const splitCount = splits.length;
md += `\nOpus/Gemini agreement: ${agreeCount}/${rows.filter(r=>r.agree_opus_gem!==null).length} comparable · ${splitCount} split.\n`;
if (splits.length) { md += `\n### Opus/Gemini splits (surfaced for the user)\n`; for (const s of splits) md += `- **${s.company} · ${s.program.slice(0,50)}** — Opus=${s.opus}, Gemini=${s.gemini}. Opus (authority) → ${s.final}.\n`; }
if (downgraded.length) { md += `\n### Downgraded from Claude's \`open\`\n`; for (const d of downgraded) md += `- **${d.company} · ${d.program.slice(0,50)}** → ${d.final}${d.mba_only?" (MBA-only)":""} ${d.evidence?`(${d.evidence.slice(0,80)})`:""}\n`; }
fs.writeFileSync(path.join(SCRATCH, "reconcile_open.md"), md);
console.log(`Final open: ${finalOpen.length} | downgraded: ${downgraded.length} | Opus/Gemini splits: ${splits.length}`);
console.log("Final open set:"); finalOpen.forEach((r) => console.log(`  ${r.company} :: ${r.program.slice(0,50)} [${r.id||"no-id"}]`));

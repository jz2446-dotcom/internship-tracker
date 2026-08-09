// judge.js — Gemini's FALLBACK role when grounded-search quota is dead.
// Claude does the WebFetch (grounding), writes each posting's page text into an
// input file, and Gemini independently RULES on open/closed from that text only.
// This uses plain generation (no web_search tool) so it keeps working after the
// grounded quota is exhausted — Gemini still contributes an independent judgment.
//
// Input JSON: [{"id":"blackrock","company":"...","program":"...","apply_url":"...","page_text":"<innerText of the posting>"}]
// Output: <out> = [{"id":...,"gemini_status":"open|closed|program-page","confidence":"high|med|low","reason":"...","quote":"..."}]
const fs = require("fs");
const { runGemini, extractJson } = require("./gemini-lib");

const [, , inPath, outPath] = process.argv;
if (!inPath || !outPath) { console.error("usage: node judge.js <in.json> <out.json>"); process.exit(1); }
const items = JSON.parse(fs.readFileSync(inPath, "utf8"));
const TODAY = "2026-07-09";

function prompt(it) {
  const text = (it.page_text || "").slice(0, 8000);
  return `Today is ${TODAY}. Decide whether this internship application is CURRENTLY OPEN, based ONLY on the page text provided. Do not use outside knowledge.

Company: ${it.company}
Program: ${it.program}
URL: ${it.apply_url || "(none)"}

--- PAGE TEXT START ---
${text}
--- PAGE TEXT END ---

Rules:
- "open" = the text gives positive evidence the application is accepting submissions now (a live Apply action, an application window covering today, or a stated future close/deadline date). Quote the exact evidence.
- "closed" = the text says applications closed / deadline passed / no longer accepting.
- "program-page" = a program is described but the text does NOT positively confirm it is accepting applications right now (this is the default when unsure — never guess open).

Return ONLY JSON: {"gemini_status":"open|closed|program-page","confidence":"high|med|low","reason":"one sentence","quote":"exact snippet or empty"}`;
}

const out = [];
let quotaHit = false;
for (const it of items) {
  process.stdout.write(`judge ${it.id || it.company} ... `);
  const r = runGemini(prompt(it), { model: "gemini-2.5-flash", timeoutMs: 90000 });
  if (r.quotaDead) { quotaHit = true; out.push({ id: it.id, gemini_status: "error", reason: "quota_dead" }); console.log("429"); continue; }
  const v = extractJson(r.text) || {};
  out.push({ id: it.id, company: it.company, program: it.program, gemini_status: v.gemini_status || "unknown", confidence: v.confidence || "low", reason: v.reason || "", quote: v.quote || "" });
  console.log(v.gemini_status || "unknown");
}
fs.writeFileSync(outPath, JSON.stringify(out, null, 1));
console.log(`\nJudged ${out.length} items${quotaHit ? " (some hit quota — plain-gen quota also exhausted)" : ""}`);

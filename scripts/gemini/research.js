// research.js — Gemini's INDEPENDENT grounded research pass over the roster.
// For each company it does its own Google-Search-grounded lookup and returns the
// same JSON schema Claude's research agents return. Every company is checkpointed
// to its own file the instant it completes, so a mid-run 429 (quota death) keeps
// 100% of what Gemini already produced.
//
// Usage:
//   node research.js <company_list.json> <out_dir> [--limit N] [--model M]
// Resumes automatically: any company with an existing non-empty <out_dir>/<slug>.json
// is skipped. Stops early after MAX_CONSEC_429 consecutive quota failures.
const fs = require("fs");
const path = require("path");
const { runGemini, extractJson } = require("./gemini-lib");

const MAX_CONSEC_429 = 3;
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");

const [, , listPath, outDir, ...rest] = process.argv;
if (!listPath || !outDir) { console.error("usage: node research.js <list.json> <out_dir> [--limit N] [--model M]"); process.exit(1); }
const limit = rest.includes("--limit") ? +rest[rest.indexOf("--limit") + 1] : Infinity;
const model = rest.includes("--model") ? rest[rest.indexOf("--model") + 1] : "gemini-2.5-flash";
fs.mkdirSync(outDir, { recursive: true });

const companies = JSON.parse(fs.readFileSync(listPath, "utf8"));
const TODAY = "2026-07-09";

function prompt(company) {
  return `You are a finance-internship researcher. Use Google Search to find CURRENT facts. Today is ${TODAY}.

Company: "${company}"

Find every SUMMER 2027 (class years 2028/2029) finance/business internship or analyst program this company currently lists, PLUS scan its careers site for any program whose title/description contains: pricing, economics, corporate, treasury, credit, markets, research, wealth, trading, equity.

For EACH program return an object. status rules (be strict):
- "open"  = you have positive evidence the application is accepting submissions NOW (live Apply, application window covering today, or a future close date).
- "closed" = deadline passed / "no longer accepting".
- "program-page" = a program page exists but you cannot confirm it is accepting applications right now (page merely loads, bot-walled, JS/login-walled, unclear). NEVER assert open without positive evidence.

Return ONLY a JSON array (no prose) of:
[{"company":"${company}","program":"...","category":"...","class_years":["2028"],"location":"...","status":"open|closed|program-page","apply_url":"...","notes":"cite the evidence you saw","source":"gemini"}]
If nothing qualifies, return [].`;
}

const summary = { model, started: TODAY, done: [], skipped: [], quota_dead_after: null, errors: [] };
let consec429 = 0, processed = 0;

for (const company of companies) {
  if (processed >= limit) { console.log(`[limit ${limit} reached]`); break; }
  const outFile = path.join(outDir, slug(company) + ".json");
  if (fs.existsSync(outFile) && fs.statSync(outFile).size > 2) { summary.skipped.push(company); continue; }
  processed++;
  process.stdout.write(`(${processed}) ${company} ... `);
  const r = runGemini(prompt(company), { model, timeoutMs: 45000 });
  if (r.quotaDead) {
    consec429++;
    console.log(`429 (consec ${consec429})`);
    if (consec429 >= MAX_CONSEC_429) { summary.quota_dead_after = company; console.log(`\n[QUOTA DEAD after ${MAX_CONSEC_429} consecutive 429s — stopping grounded pass]`); break; }
    continue;
  }
  consec429 = 0;
  const arr = extractJson(r.text);
  if (Array.isArray(arr)) {
    fs.writeFileSync(outFile, JSON.stringify(arr, null, 1));
    summary.done.push({ company, count: arr.length });
    console.log(`ok (${arr.length})`);
  } else {
    summary.errors.push({ company, reason: "no_json", sample: (r.text || "").slice(0, 120) });
    console.log("no-json");
  }
}

fs.writeFileSync(path.join(outDir, "_summary.json"), JSON.stringify(summary, null, 1));
console.log(`\nDONE: ${summary.done.length} researched, ${summary.skipped.length} skipped, quotaDead=${summary.quota_dead_after || "no"}`);

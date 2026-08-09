// finalize_data.js — apply the verified open/closed statuses onto the EXISTING data
// files in place (program text stays byte-stable → no applied-checkbox/note orphaning,
// Step 3.5). Adds the genuinely-new open programs. Sets/clears resume_url. Preserves
// each file's top-level agent/name/focus and every non-open entry's text.
const fs = require("fs");
const path = require("path");
const DATA = path.join(__dirname, "../../data");
const MASTER = path.join(__dirname, "../../Resumes/_master");
const SCRATCH = process.env.SCRATCH;

const norm = (s) => (s || "").toLowerCase().replace(/&amp;|&/g, "and").replace(/[^a-z0-9]+/g, " ").replace(/\b(inc|llc|lp|group|company|co|the|and|of|for|a|an|program|internship|intern|analyst|summer|2027|2028)\b/g, "").trim();
const haveResume = new Set(fs.readdirSync(MASTER).filter((f) => /^min_.*\.pdf$/.test(f)).map((f) => f.replace(/^min_|\.pdf$/g, "")));

// verified final statuses (Opus authority + Step 5.5)
const finalStatus = require(path.join(SCRATCH, "final_status.json")); // [{id,company,program,status,close_date,mba_only}]
// research downgrades that were NOT in the open-set verification (from research, e.g. things that flipped closed)
// map: normalized company+program -> {status, id, close_date}
const verified = {};
for (const f of finalStatus) verified[norm(f.company) + "|" + norm(f.program)] = f;

// which verified-open ids already exist in data (to know which to ADD)
const openIds = new Set(finalStatus.filter((f) => f.status === "open" && !f.mba_only).map((f) => f.id));
const matchedIds = new Set();

const files = { 1: "agent1_results.json", 2: "agent2_results.json", 3: "agent3_results.json", 4: "agent4_results.json", 5: "agent5_results.json", soph: "sophomore_results.json" };
const report = { updated: [], resume_set: [], resume_cleared: [], added: [] };

for (const [agent, fname] of Object.entries(files)) {
  const fp = path.join(DATA, fname);
  const d = JSON.parse(fs.readFileSync(fp, "utf8"));
  for (const e of d.internships || []) {
    const key = norm(e.company) + "|" + norm(e.program);
    const v = verified[key];
    if (v) {
      if (e.status !== v.status) { report.updated.push(`${e.company}::${e.program.slice(0,30)} ${e.status}->${v.status}`); e.status = v.status; }
      if (v.close_date) e.close_date = v.close_date;
      matchedIds.add(v.id);
      // resume_url based on final status
      if (v.status === "open" && haveResume.has(v.id)) { if (e.resume_url !== `/resume/${v.id}`) report.resume_set.push(v.id); e.resume_url = `/resume/${v.id}`; }
      else if (v.status !== "open" && e.resume_url) { report.resume_cleared.push(v.id); delete e.resume_url; }
    }
    // also: existing open entry whose id (via resume_url) is a confirmed-open with a resume -> keep
  }
  fs.writeFileSync(fp, JSON.stringify(d, null, 2));
}

// ADD genuinely-new open programs not matched to any existing entry
const claudeOpen = require(path.join(SCRATCH, "claude_open.json"));
const byId = Object.fromEntries(claudeOpen.map((c) => [c.id, c]));
const AGENT_OF = { jpm_mkt: 1, jpm_csi: 1, jpm_gpb: 1, bofa_risk: 1, warburg_berlin: 1, trowe_er: 1, cat_fin: 5, rberger: 4 };
for (const f of finalStatus) {
  if (f.status !== "open" || f.mba_only) continue;
  if (matchedIds.has(f.id)) continue; // already updated in place
  const agent = AGENT_OF[f.id];
  if (!agent) { report.added.push(`(SKIP no-agent-map ${f.id})`); continue; }
  const src = byId[f.id] || {};
  const fp = path.join(DATA, files[agent]);
  const d = JSON.parse(fs.readFileSync(fp, "utf8"));
  const entry = {
    company: f.company, program: f.program,
    category: "Corporate Finance", class_years: (src.class_years && src.class_years.length ? src.class_years : ["2028", "2029"]),
    location: "", status: "open", apply_url: src.apply_url || "",
    notes: "Confirmed open via Opus verification 2026-07-10.", source: "claude",
    close_date: f.close_date || "",
  };
  if (haveResume.has(f.id)) entry.resume_url = `/resume/${f.id}`;
  d.internships.push(entry);
  fs.writeFileSync(fp, JSON.stringify(d, null, 2));
  report.added.push(`${f.company}::${f.program.slice(0,32)} [${f.id}]${haveResume.has(f.id) ? " +resume" : " (resume-pending)"}`);
}

console.log("=== finalize report ===");
console.log("status updated:", report.updated.length); report.updated.forEach((x) => console.log("  " + x));
console.log("resume_url set:", report.resume_set.join(" "));
console.log("resume_url cleared:", report.resume_cleared.join(" ") || "(none)");
console.log("new open programs added:", report.added.length); report.added.forEach((x) => console.log("  + " + x));
console.log("\nUnmatched verified-open ids (added or need attention):", [...openIds].filter((id) => !matchedIds.has(id)).join(" ") || "(none)");

// _full_refresh_driver.js — headless CLI replica of tracker-runner/main.js's
// buildPlan({mode:'long', sequential:true}) + runStep engine, for running a real
// full refresh without the Electron GUI. Same tab order, same env budgets, same
// merge/build-data/deploy tail. See main.js for the source of truth this mirrors.
const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, "..", "data");
const WORKER_DIR = path.join(ROOT, "..", "cloudflare-worker");
const tabRegistry = require("./lib/tab-registry.js");

const TAB_ORDER = [
  "agent1", "agent2", "agent3", "agent4", "agent5",
  "libraries", "environmental", "realestate", "ithaca",
  "sophomore", "fall2026", "spring2027", "fellowships", "china_hk",
];

const seqEnv = { ANALYST_NIM_CONC: "4", ANALYST_SEARCH_CONC: "4", FIRECRAWL_RUN_CAP: "60", ANALYST_BROWSE_CONC: "4" };
const tabConcurrency = "8";
const BRAIN = process.env.RUNNER_BRAIN || "nim";

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
}

function run(cmd, args, cwd, env, shell) {
  log(`$ ${cmd} ${(args || []).join(" ")}  (cwd=${cwd})`);
  const res = spawnSync(cmd, args, {
    cwd, shell: !!shell, stdio: "inherit",
    env: env ? { ...process.env, ...env } : process.env,
  });
  return res.status;
}

function mergeFall2026() {
  const sources = ["fall2026_fall", "fall2026_spring"];
  const seen = new Set();
  const internships = [];
  let meta = { name: "Fall 2026 / Spring 2027", focus: "" };
  for (const a of sources) {
    const p = path.join(DATA_DIR, `${a}_results.json`);
    if (!fs.existsSync(p)) { log(`  (missing ${a}_results.json — skipping)`); continue; }
    let d;
    try { d = JSON.parse(fs.readFileSync(p, "utf8")); }
    catch (e) { log(`  (unreadable ${a}_results.json: ${e.message} — skipping)`); continue; }
    if (d.name) meta.name = d.name;
    if (d.focus && !meta.focus) meta.focus = d.focus;
    let dupes = 0;
    for (const e of d.internships || []) {
      const k = `${(e.company || "").toLowerCase()}::${(e.program || "").toLowerCase()}`;
      if (seen.has(k)) { dupes++; continue; }
      seen.add(k);
      internships.push(e);
    }
    log(`  + ${a}: ${(d.internships || []).length} entries${dupes ? ` (${dupes} dupes skipped)` : ""}`);
  }
  const out = path.join(DATA_DIR, "fall2026_results.json");
  fs.writeFileSync(out, JSON.stringify({
    agent: "fall2026", name: meta.name, focus: meta.focus,
    last_updated: new Date().toISOString().slice(0, 10), internships,
  }, null, 2));
  log(`  → ${internships.length} merged entries → fall2026_results.json`);
}

(async () => {
  log(`=== FULL REFRESH — sequential, brain=${BRAIN}, ${TAB_ORDER.length} tabs ===`);
  const failed = [];
  for (const tabId of TAB_ORDER) {
    const cfg = tabRegistry.get(tabId);
    const args = ["run-analyst.js", "--roster", cfg.rosterPath, "--agent-name", cfg.agentName, "--brain", BRAIN];
    if (cfg.agentKey) args.push("--agent-key", cfg.agentKey);
    if (cfg.allAgents) args.push("--all-agents");
    if (cfg.tab) args.push("--tab", cfg.tab);
    if (cfg.term) args.push("--term", cfg.term);
    args.push("--concurrency", tabConcurrency);
    log(`\n>>> ${cfg.label} (${tabId}) <<<`);
    const code = run("node", args, ROOT, seqEnv, false);
    if (code !== 0) { failed.push(tabId); log(`  !! ${tabId} exited ${code}`); }
  }

  log("\n=== MERGE fall2026 + spring2027 ===");
  mergeFall2026();

  log("\n=== DEPLOY ===");
  run("curl", ["-s", "https://internship-tracker.jz-tracker.workers.dev/api/data", "-o", path.join(WORKER_DIR, "src", "data.json")], WORKER_DIR, null, false);
  const buildCode = run("node", ["build-data.js"], WORKER_DIR, null, false);
  if (buildCode !== 0) { log("build-data.js FAILED — not deploying"); process.exit(1); }
  const deployCode = run("wrangler deploy", null, WORKER_DIR, null, true);

  log(`\n=== DONE — failed tabs: ${failed.length ? failed.join(", ") : "none"}, deploy exit: ${deployCode} ===`);
})();

// _full_refresh_driver.js — headless CLI replica of tracker-runner/main.js's
// buildPlan()+runStep engine, for running a real full refresh without the Electron
// GUI. Same tab order, same merge/build-data/deploy tail. See main.js for the source
// of truth this mirrors.
//
// Default mode is sequential (one tab at a time) — safe for a desktop machine but at
// observed per-tab durations (tracker-runner/history/step-timings.json) sums to
// roughly 23 wall-clock hours across all 14 tabs, which exceeds GitHub Actions'
// 6-hour hosted-runner job limit. --parallel runs tabs in batches of 7 concurrently
// (children run via `spawn`, not `spawnSync`) to fit that window; concurrency knobs
// inside each tab (ANALYST_*_CONC) are also lower than the Electron app's parallel
// mode, sized for a 2-vCPU GitHub Actions runner rather than a desktop.
const { spawn, spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const tabRegistry = require("./lib/tab-registry.js");

const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, "..", "data");
const WORKER_DIR = path.join(ROOT, "..", "cloudflare-worker");

const TAB_ORDER = [
  "agent1", "agent2", "agent3", "agent4", "agent5",
  "libraries", "environmental", "realestate", "ithaca",
  "sophomore", "fall2026", "spring2027", "fellowships", "china_hk",
];

const seqEnv = { ANALYST_NIM_CONC: "4", ANALYST_SEARCH_CONC: "4", ANALYST_BROWSE_CONC: "4" };
const parallelEnv = { ANALYST_NIM_CONC: "2", ANALYST_SEARCH_CONC: "2", ANALYST_BROWSE_CONC: "2" };
const PARALLEL_BATCH_SIZE = 7;
const BRAIN = process.env.RUNNER_BRAIN || "nim";

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

function buildArgs(cfg, brain, tabConcurrency) {
  const args = ["run-analyst.js", "--roster", cfg.rosterPath, "--agent-name", cfg.agentName, "--brain", brain];
  if (cfg.agentKey) args.push("--agent-key", cfg.agentKey);
  if (cfg.allAgents) args.push("--all-agents");
  if (cfg.tab) args.push("--tab", cfg.tab);
  if (cfg.term) args.push("--term", cfg.term);
  args.push("--concurrency", tabConcurrency);
  return args;
}

function runSync(cmd, args, cwd, env, shell) {
  log(`$ ${cmd} ${(args || []).join(" ")}  (cwd=${cwd})`);
  const res = spawnSync(cmd, args, { cwd, shell: !!shell, stdio: "inherit", env: env ? { ...process.env, ...env } : process.env });
  return res.status;
}

function runAsync(cmd, args, cwd, env) {
  log(`$ ${cmd} ${(args || []).join(" ")}  (cwd=${cwd}) [async]`);
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, stdio: "inherit", env: env ? { ...process.env, ...env } : process.env });
    child.on("close", (code) => resolve(code));
  });
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

async function main() {
  const PARALLEL = process.argv.includes("--parallel");
  const NO_DEPLOY = process.argv.includes("--no-deploy");
  const failed = [];

  if (PARALLEL) {
    log(`=== FULL REFRESH — parallel (batches of ${PARALLEL_BATCH_SIZE}), brain=${BRAIN}, ${TAB_ORDER.length} tabs ===`);
    for (let i = 0; i < TAB_ORDER.length; i += PARALLEL_BATCH_SIZE) {
      const batch = TAB_ORDER.slice(i, i + PARALLEL_BATCH_SIZE);
      log(`\n>>> batch: ${batch.join(", ")} <<<`);
      const codes = await Promise.all(batch.map((tabId) => {
        const cfg = tabRegistry.get(tabId);
        return runAsync("node", buildArgs(cfg, BRAIN, "3"), ROOT, parallelEnv);
      }));
      batch.forEach((tabId, idx) => { if (codes[idx] !== 0) { failed.push(tabId); log(`  !! ${tabId} exited ${codes[idx]}`); } });
    }
  } else {
    log(`=== FULL REFRESH — sequential, brain=${BRAIN}, ${TAB_ORDER.length} tabs ===`);
    for (const tabId of TAB_ORDER) {
      const cfg = tabRegistry.get(tabId);
      log(`\n>>> ${cfg.label} (${tabId}) <<<`);
      const code = runSync("node", buildArgs(cfg, BRAIN, "8"), ROOT, seqEnv, false);
      if (code !== 0) { failed.push(tabId); log(`  !! ${tabId} exited ${code}`); }
    }
  }

  log("\n=== MERGE fall2026 + spring2027 ===");
  mergeFall2026();

  if (NO_DEPLOY) {
    log("\n=== DEPLOY skipped (--no-deploy) ===");
    log(`\n=== DONE — failed tabs: ${failed.length ? failed.join(", ") : "none"}, deploy: skipped ===`);
    return;
  }

  log("\n=== DEPLOY ===");
  runSync("curl", ["-s", "https://internship-tracker.jz-tracker.workers.dev/api/data", "-o", path.join(WORKER_DIR, "src", "data.json")], WORKER_DIR, null, false);
  const buildCode = runSync("node", ["build-data.js"], WORKER_DIR, null, false);
  if (buildCode !== 0) { log("build-data.js FAILED — not deploying"); process.exit(1); }
  const deployCode = runSync("wrangler deploy", null, WORKER_DIR, null, true);

  log(`\n=== DONE — failed tabs: ${failed.length ? failed.join(", ") : "none"}, deploy exit: ${deployCode} ===`);
}

if (require.main === module) {
  main();
}

module.exports = { buildArgs };

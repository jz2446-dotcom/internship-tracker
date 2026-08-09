// breaker.js — the "machine remembers" circuit breaker for AI brains (user rule,
// 2026-08-05): if an AI brain fails 3 CONSECUTIVE times (full chain — no model
// produced a verdict), trip the breaker and route ALL future judgments to the
// built-in heuristic brain — not just in this process, but in every tab process
// and every later run, via data/_brain_breaker.json.
//
// The breaker self-heals after BRAIN_BREAKER_TTL_HOURS (default 2h): AI outages
// are usually congestion windows, and a permanently-tripped breaker would keep the
// app lobotomized long after NVIDIA/Claude recovered. Delete the file to reset it
// manually; raise the env var to make the machine hold the grudge longer.
const fs = require("fs");
const path = require("path");

const FILE = path.join(__dirname, "..", "..", "data", "_brain_breaker.json");
const TTL_MS = Math.max(0.1, parseFloat(process.env.BRAIN_BREAKER_TTL_HOURS || "2")) * 3600 * 1000;
const THRESHOLD = 3;

let consecutive = 0; // this process's consecutive full-chain AI failures
let announced = false;

function isActive() {
  try {
    const b = JSON.parse(fs.readFileSync(FILE, "utf8"));
    if (Date.now() - b.tripped_at < TTL_MS) {
      if (!announced) {
        announced = true;
        const mins = Math.round((TTL_MS - (Date.now() - b.tripped_at)) / 60000);
        console.error(`  ⚡ brain breaker active (${b.reason}; tripped ${b.at}) — heuristic-only for ~${mins} more min`);
      }
      return true;
    }
  } catch (_) { /* no breaker file */ }
  return false;
}

// Call on every full-chain AI failure. Trips (and persists) at 3 consecutive.
function recordFailure(reason) {
  consecutive++;
  if (consecutive < THRESHOLD) return false;
  try {
    fs.writeFileSync(FILE, JSON.stringify({ tripped_at: Date.now(), at: new Date().toISOString(), reason }, null, 2));
  } catch (_) {}
  console.error(`  ⚡ AI brain failed ${THRESHOLD} consecutive times — breaker TRIPPED (${reason}). All future judgments use the built-in heuristic brain for ${Math.round(TTL_MS / 3600000 * 10) / 10}h (delete data/_brain_breaker.json to reset).`);
  return true;
}

// Call on any AI success: the streak is broken.
function recordSuccess() {
  consecutive = 0;
}

module.exports = { isActive, recordFailure, recordSuccess, FILE };

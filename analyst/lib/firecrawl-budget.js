// firecrawl-budget.js — a single Firecrawl call budget shared by every concurrently
// running tab process (agent1-5, sophomore, fall2026, etc.), replacing the old
// per-process FIRECRAWL_RUN_CAP env var. Firecrawl's free tier is ~500 credits/mo;
// this keeps a full parallel run under that regardless of how many tabs are active
// at once, instead of rationing each tab in isolation. See
// docs/superpowers/specs/2026-08-29-shared-firecrawl-budget-and-cloud-refresh-design.md
const fs = require("fs");
const path = require("path");

const DEFAULT_FILE = path.join(__dirname, "..", "..", "data", "_firecrawl_budget.json");
const DEFAULT_LIMIT = Math.max(0, parseInt(process.env.FIRECRAWL_DAILY_BUDGET || "450", 10) || 450);
const LOCK_STALE_MS = 5000; // a lock older than this belongs to a crashed holder — safe to steal
const MAX_ATTEMPTS = 40;

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function todayStr(now) { return now.toISOString().slice(0, 10); }

async function acquireLock(lockPath) {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      fs.closeSync(fs.openSync(lockPath, "wx"));
      return true;
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      try {
        if (Date.now() - fs.statSync(lockPath).mtimeMs > LOCK_STALE_MS) { fs.unlinkSync(lockPath); continue; }
      } catch (_) { /* lock vanished between openSync and statSync — loop will re-acquire */ }
      await sleep(Math.min(25 * (attempt + 1), 500));
    }
  }
  return false;
}

function releaseLock(lockPath) {
  try { fs.unlinkSync(lockPath); } catch (_) {}
}

// Reserves one Firecrawl call against today's shared budget. Returns
// { ok, used, limit } — ok is false once `limit` reservations have been made today.
// Fails OPEN (ok: true, used: -1) if the lock can't be acquired at all, rather than
// blocking a scrape indefinitely over a rare double-count.
async function tryReserve({ file = DEFAULT_FILE, limit = DEFAULT_LIMIT, now = new Date() } = {}) {
  const lockPath = file + ".lock";
  const locked = await acquireLock(lockPath);
  if (!locked) return { ok: true, used: -1, limit };
  try {
    let state = { date: todayStr(now), used: 0 };
    try {
      const onDisk = JSON.parse(fs.readFileSync(file, "utf8"));
      if (onDisk && onDisk.date === todayStr(now)) state = onDisk;
    } catch (_) { /* missing/corrupt — start fresh */ }
    if (state.used >= limit) return { ok: false, used: state.used, limit };
    state.used += 1;
    fs.writeFileSync(file, JSON.stringify(state));
    return { ok: true, used: state.used, limit };
  } finally {
    releaseLock(lockPath);
  }
}

module.exports = { tryReserve, DEFAULT_FILE, DEFAULT_LIMIT };

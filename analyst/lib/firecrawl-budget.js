// firecrawl-budget.js — a single Firecrawl call budget shared by every concurrently
// running tab process (agent1-5, sophomore, fall2026, etc.), replacing the old
// per-process FIRECRAWL_RUN_CAP env var. Firecrawl's free tier is ~500 credits PER
// MONTH — this tracks usage per calendar month (not per day; an earlier version of
// this file reset daily, which let one day's run alone burn through the account's
// entire monthly allowance) and keeps a full run under that regardless of how many
// tabs are active at once, instead of rationing each tab in isolation. See
// docs/superpowers/specs/2026-08-29-shared-firecrawl-budget-and-cloud-refresh-design.md
const fs = require("fs");
const path = require("path");

const DEFAULT_FILE = path.join(__dirname, "..", "..", "data", "_firecrawl_budget.json");
const parsedLimit = parseInt(process.env.FIRECRAWL_MONTHLY_BUDGET || "450", 10);
const DEFAULT_LIMIT = Math.max(0, Number.isNaN(parsedLimit) ? 450 : parsedLimit);
const LOCK_STALE_MS = 5000; // a lock older than this belongs to a crashed holder — safe to steal
const MAX_ATTEMPTS = 40;

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function monthStr(now) { return now.toISOString().slice(0, 7); } // "2026-08"

// Errors that mean "someone else holds the lock right now" rather than a real
// failure. Windows' O_CREAT|O_EXCL doesn't reliably surface EEXIST under real
// multi-process contention (15 separate `node run-analyst.js` processes all
// hammering the same lock file) the way POSIX does — it can throw EPERM or
// EBUSY instead when another process has the path open or mid-delete at that
// exact instant. Observed live: every tab crashed with an uncaught EPERM here
// the first time 15 processes actually contended for this lock concurrently.
const LOCK_CONTENTION_CODES = new Set(["EEXIST", "EPERM", "EBUSY"]);

async function acquireLock(lockPath) {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      fs.closeSync(fs.openSync(lockPath, "wx"));
      return true;
    } catch (e) {
      if (!LOCK_CONTENTION_CODES.has(e.code)) throw e;
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

// Reserves one Firecrawl call against this month's shared budget. Returns
// { ok, used, limit } — ok is false once `limit` reservations have been made this
// calendar month. Fails OPEN (ok: true, used: -1) if the lock can't be acquired at
// all, rather than blocking a scrape indefinitely over a rare double-count.
async function tryReserve({ file = DEFAULT_FILE, limit = DEFAULT_LIMIT, now = new Date() } = {}) {
  const lockPath = file + ".lock";
  const locked = await acquireLock(lockPath);
  if (!locked) return { ok: true, used: -1, limit };
  try {
    const thisMonth = monthStr(now);
    let state = { month: thisMonth, used: 0 };
    try {
      const onDisk = JSON.parse(fs.readFileSync(file, "utf8"));
      if (onDisk && onDisk.month === thisMonth) {
        state = onDisk;
      } else if (onDisk && typeof onDisk.date === "string" && onDisk.date.slice(0, 7) === thisMonth) {
        // Migrating from the old daily-reset format: today's spend already happened
        // against the real Firecrawl account this month — carry it forward instead
        // of resetting to 0, which would let this month's real quota get double-spent.
        state = { month: thisMonth, used: onDisk.used };
      }
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

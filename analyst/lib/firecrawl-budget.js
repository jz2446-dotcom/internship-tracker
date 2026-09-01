// firecrawl-budget.js — a single Firecrawl call budget shared by every concurrently
// running tab process (agent1-5, sophomore, fall2026, etc.), replacing the old
// per-process FIRECRAWL_RUN_CAP env var.
//
// PRIMARY signal: Firecrawl's own /v1/team/credit-usage endpoint — the real
// remaining balance on the real account. Verified live 2026-09-01: the account is
// actually a 1000-credit plan (not the ~500/mo this module originally guessed), and
// the billing period is a rolling ~30-day window tied to the subscription date
// (2026-08-05 → 2026-09-05 seen live), NOT the calendar month a from-scratch guess
// would assume. Querying the real endpoint sidesteps needing to know either number
// or the exact reset date — it's always current truth. Cached briefly so 14
// concurrent tab processes don't hammer Firecrawl's API on every single call.
//
// FALLBACK (no key, or the live check fails — network down, Firecrawl API issue):
// the local file-locked monthly counter this module always had, sized to the real
// 1000-credit plan now instead of the original wrong guess.
// See docs/superpowers/specs/2026-08-29-shared-firecrawl-budget-and-cloud-refresh-design.md
const fs = require("fs");
const path = require("path");
const { apiKey } = require("./keyfile");
const { rawRequest } = require("./http"); // NOT fetch()/undici — see lib/http.js

const DEFAULT_FILE = path.join(__dirname, "..", "..", "data", "_firecrawl_budget.json");
const parsedLimit = parseInt(process.env.FIRECRAWL_MONTHLY_BUDGET || "1000", 10);
const DEFAULT_LIMIT = Math.max(0, Number.isNaN(parsedLimit) ? 1000 : parsedLimit);
const LOCK_STALE_MS = 5000; // a lock older than this belongs to a crashed holder — safe to steal
const MAX_ATTEMPTS = 40;

// Stop reserving once the REAL account has this few credits left — leaves headroom
// against the live number's inherent lag (Firecrawl's own accounting catches up
// asynchronously after each call; a hard 0 would let a burst of concurrent
// in-flight calls overshoot into a negative/blocked account).
const SAFETY_MARGIN = Math.max(0, parseInt(process.env.FIRECRAWL_SAFETY_MARGIN || "10", 10) || 10);

// Don't hammer Firecrawl's API — every tab process calls tryReserve() many times;
// re-check the real balance at most this often and reuse the reading in between.
const LIVE_CHECK_TTL_MS = 5 * 60 * 1000;

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function monthStr(now) { return now.toISOString().slice(0, 7); } // "2026-08" — fallback-only bucketing

let liveCache = null; // { remaining, checkedAt } — process-local, not shared across tab processes
let defaultFetchLive = null; // test-only override for callers (e.g. scrape.js) that don't pass fetchLive themselves

// Real call to Firecrawl's own usage endpoint. Returns a number, or null if
// unreachable/no key/malformed response — callers treat null as "can't verify,
// use the fallback."
async function fetchLiveRemaining() {
  const key = apiKey("FIRECRAWL_API_KEY");
  if (!key) return null;
  try {
    const res = await rawRequest("https://api.firecrawl.dev/v1/team/credit-usage", {
      headers: { Authorization: `Bearer ${key}` },
      timeoutMs: 10000,
    });
    if (!res || res.status < 200 || res.status >= 300) return null;
    const j = JSON.parse(res.body);
    const remaining = j && j.data && j.data.remaining_credits;
    return typeof remaining === "number" ? remaining : null;
  } catch (_) {
    return null;
  }
}

// Cached live lookup. `fetchLive` and `now` are injectable for tests; callers that
// don't pass `fetchLive` explicitly (e.g. scrape.js) get `defaultFetchLive` if a
// test has set one, otherwise the real fetchLiveRemaining.
async function liveRemaining({ fetchLive = defaultFetchLive || fetchLiveRemaining, now = new Date() } = {}) {
  if (liveCache && now.getTime() - liveCache.checkedAt < LIVE_CHECK_TTL_MS) return liveCache.remaining;
  const remaining = await fetchLive();
  if (remaining !== null) {
    liveCache = { remaining, checkedAt: now.getTime() };
    return remaining;
  }
  // Fresh fetch failed — reuse a stale cached reading rather than falling straight
  // to the local-file fallback on a single transient network hiccup.
  return liveCache ? liveCache.remaining : null;
}

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

function reserveLocal(file, limit, now) {
  const thisMonth = monthStr(now);
  let state = { month: thisMonth, used: 0 };
  try {
    const onDisk = JSON.parse(fs.readFileSync(file, "utf8"));
    if (onDisk && onDisk.month === thisMonth) {
      state = onDisk;
    } else if (onDisk && typeof onDisk.date === "string" && onDisk.date.slice(0, 7) === thisMonth) {
      // Migrating from the old daily-reset format: that spend already happened
      // against the real account this month — carry it forward instead of
      // resetting to 0, which would let this month's real quota get double-spent.
      state = { month: thisMonth, used: onDisk.used };
    }
  } catch (_) { /* missing/corrupt — start fresh */ }
  if (state.used >= limit) return { ok: false, used: state.used, limit };
  state.used += 1;
  fs.writeFileSync(file, JSON.stringify(state));
  return { ok: true, used: state.used, limit };
}

// Reserves one Firecrawl call. Checks the REAL account balance first (cached
// briefly); only falls back to the local file-locked monthly counter if the live
// check can't be verified (no key, or the request fails). Returns
// { ok, used, limit, remaining? } — `remaining` is present when the live check
// answered, `used`/`limit` are always present (from the local counter in fallback
// mode, or synthesized around `remaining` when the live check governed). Fails
// OPEN (ok: true, used: -1) if the local lock can't be acquired at all in fallback
// mode, rather than blocking a scrape indefinitely over a rare double-count.
async function tryReserve({ file = DEFAULT_FILE, limit = DEFAULT_LIMIT, now = new Date(), fetchLive } = {}) {
  const remaining = await liveRemaining(fetchLive ? { fetchLive, now } : { now });
  if (remaining !== null) {
    if (remaining <= SAFETY_MARGIN) return { ok: false, used: -1, limit, remaining };
    // A local reservation still happens under the lock so concurrent callers in
    // the same process/run see a consistent count for logging — but the ok/not-ok
    // decision above already came from the real account, not this local number.
    const lockPath = file + ".lock";
    const locked = await acquireLock(lockPath);
    if (!locked) return { ok: true, used: -1, limit, remaining };
    try {
      const r = reserveLocal(file, Infinity, now); // local counter is informational only here — never itself the gate
      return { ok: true, used: r.used, limit, remaining };
    } finally {
      releaseLock(lockPath);
    }
  }

  // Live check unavailable — fall back to the local file-locked monthly counter.
  const lockPath = file + ".lock";
  const locked = await acquireLock(lockPath);
  if (!locked) return { ok: true, used: -1, limit };
  try {
    return reserveLocal(file, limit, now);
  } finally {
    releaseLock(lockPath);
  }
}

module.exports = {
  tryReserve, DEFAULT_FILE, DEFAULT_LIMIT,
  _resetLiveCacheForTest: () => { liveCache = null; }, // test isolation only — liveCache is module-level
  _setFetchLiveForTest: (fn) => { defaultFetchLive = fn; }, // test isolation only — lets callers that don't pass fetchLive (e.g. scrape.js) be tested without a real network call
};

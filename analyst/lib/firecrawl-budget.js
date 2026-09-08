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
// SECOND ACCOUNT: when the primary account's live balance is at/under the safety
// margin, this module automatically checks a second Firecrawl account's key
// (~\Downloads\Firecrawl2.env, a separate account the user keeps as backup) before
// falling back to the no-credit-cost Playwright path. Verified live 2026-09-03: the
// primary account was down to 1 real credit for an entire run, silently forcing
// every thin page to the slower Playwright fallback — this closes that gap.
//
// FALLBACK (neither account's key is set, or both live checks fail — network down,
// Firecrawl API issue): the local file-locked monthly counter this module always
// had, sized to the real 1000-credit plan now instead of the original wrong guess.
// See docs/superpowers/specs/2026-08-29-shared-firecrawl-budget-and-cloud-refresh-design.md
//
// RUN CAP (added 2026-09-08): the live-balance check above has NO ceiling of its
// own — it happily spends real credits until an account is nearly empty. Incident:
// with 11 tabs running concurrently plus the new Fortune 500 agents 6/7 (~1,067
// candidates alone), a single run drained BOTH the primary (fresh 1000-credit
// reset) and the 1025-credit backup account to 0 in a couple of days. The old
// per-process FIRECRAWL_RUN_CAP this module replaced (see top comment) at least
// bounded worst-case spend (60/tab). That protection is restored here, but as a
// ceiling ON TOP of the live-balance/failover logic rather than instead of it: a
// counter shared across every tab process IN ONE PIPELINE RUN (keyed by
// ANALYST_RUN_ID, set once by tracker-runner's buildPlan() and passed to every tab
// child process; a standalone/CLI invocation with no run id gets its own
// per-process id, same as the old design). Default 300 real calls/run — tunable via
// FIRECRAWL_RUN_CAP, 0 disables it.
const fs = require("fs");
const path = require("path");
const { apiKey } = require("./keyfile");
const { rawRequest } = require("./http"); // NOT fetch()/undici — see lib/http.js

const BACKUP_KEY_FILE = "C:\\Users\\justi\\Downloads\\Firecrawl2.env";
function backupApiKey() {
  try {
    const text = fs.readFileSync(BACKUP_KEY_FILE, "utf8").trim();
    return text || null;
  } catch (_) {
    return null; // file missing — no second account configured
  }
}
function keyForAccount(account) {
  return account === "backup" ? backupApiKey() : apiKey("FIRECRAWL_API_KEY");
}

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

const parsedRunCap = parseInt(process.env.FIRECRAWL_RUN_CAP || "300", 10);
const DEFAULT_RUN_CAP = Math.max(0, Number.isNaN(parsedRunCap) ? 300 : parsedRunCap);
// Shared across every tab process spawned by the same tracker-runner pipeline run
// (main.js sets this once in buildPlan() and passes it to every tab's env). A
// standalone `node run-analyst.js` invocation (CLI/MCP, no tracker-runner parent)
// has no shared run id — each such process gets its own, so the cap applies
// per-process there, same as the pre-2026-08-29 behavior.
const DEFAULT_RUN_ID = process.env.ANALYST_RUN_ID || `solo-${process.pid}`;

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function monthStr(now) { return now.toISOString().slice(0, 7); } // "2026-08" — fallback-only bucketing

let liveCache = null; // { remaining, account, checkedAt } — process-local, not shared across tab processes
let defaultFetchLive = null; // test-only override for callers (e.g. scrape.js) that don't pass fetchLive themselves
let defaultFetchLiveBackup = null; // test-only override for the backup-account check
let backupSwitchLogged = false; // one notice per process, not one per call

// Real call to Firecrawl's own usage endpoint for a given key. Returns a number,
// or null if unreachable/no key/malformed response — callers treat null as
// "can't verify, use the fallback."
async function fetchLiveRemainingForKey(key) {
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
async function fetchLiveRemaining() { return fetchLiveRemainingForKey(apiKey("FIRECRAWL_API_KEY")); }
async function fetchLiveRemainingBackup() { return fetchLiveRemainingForKey(backupApiKey()); }

// Cached live lookup, now over TWO accounts. `fetchLive`/`fetchLiveBackup`/`now` are
// injectable for tests (per-call or via the `_setFetchLive*ForTest` setters).
// Production callers that stub neither (e.g. scrape.js's bare `tryReserve()`) get
// the real primary check, and — ONLY if the primary comes back at/under the safety
// margin — the real backup check too. A caller that stubs the primary (either way)
// but not the backup gets a no-op backup (stays network-free/deterministic) unless
// it opts in explicitly — see `primaryIsStubbed` below.
async function liveRemaining({ fetchLive, fetchLiveBackup, now = new Date() } = {}) {
  if (liveCache && now.getTime() - liveCache.checkedAt < LIVE_CHECK_TTL_MS) return liveCache;

  const resolvedFetchLive = fetchLive || defaultFetchLive || fetchLiveRemaining;
  // A test stubbing the primary check — either per-call (`fetchLive`) or via
  // `_setFetchLiveForTest` (`defaultFetchLive`) — gets a no-op backup unless it ALSO
  // opts into testing the backup path explicitly. Real production calls (neither
  // stubbed) get the real backup fetcher.
  const primaryIsStubbed = !!(fetchLive || defaultFetchLive);
  const resolvedFetchLiveBackup = fetchLiveBackup || defaultFetchLiveBackup
    || (primaryIsStubbed ? (async () => null) : fetchLiveRemainingBackup);

  const primary = await resolvedFetchLive();
  if (primary !== null && primary > SAFETY_MARGIN) {
    liveCache = { remaining: primary, account: "primary", checkedAt: now.getTime() };
    return liveCache;
  }

  // Primary is at/under the margin (or unverifiable) — try the backup account
  // automatically before giving up the live signal entirely.
  const backup = await resolvedFetchLiveBackup();
  if (backup !== null && backup > SAFETY_MARGIN) {
    if (!backupSwitchLogged) {
      backupSwitchLogged = true;
      const primaryDesc = primary === null ? "unverifiable" : `${primary} left`;
      console.error(`  firecrawl: primary account low (${primaryDesc}) — switched to backup account (${backup} left)`);
    }
    liveCache = { remaining: backup, account: "backup", checkedAt: now.getTime() };
    return liveCache;
  }

  if (primary !== null) {
    // A verified (low) primary reading IS the live signal, even though the
    // backup couldn't cover it — don't fall through to the stale-cache/local
    // fallback path below as if the check never happened.
    liveCache = { remaining: primary, account: "primary", checkedAt: now.getTime() };
    return liveCache;
  }
  // Both checks totally unverifiable (network down, no keys at all) — reuse a
  // stale cached reading rather than falling straight to the fallback on a
  // single transient hiccup.
  return liveCache;
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

// Run-cap counter: same shape/locking as reserveLocal above, but keyed by runId
// instead of calendar month — a mismatched runId on disk means a NEW pipeline run
// started, so the counter resets rather than carrying forward (unlike the monthly
// counter, which deliberately DOES carry forward within the same month).
function reserveRunLocal(file, runId, limit) {
  let state = { runId, used: 0 };
  try {
    const onDisk = JSON.parse(fs.readFileSync(file, "utf8"));
    if (onDisk && onDisk.runId === runId) state = onDisk;
  } catch (_) { /* missing/corrupt — start fresh */ }
  if (state.used >= limit) return { ok: false, used: state.used, limit };
  state.used += 1;
  fs.writeFileSync(file, JSON.stringify(state));
  return { ok: true, used: state.used, limit };
}

async function reserveRunCap(file, limit, runId) {
  const lockPath = file + ".lock";
  const locked = await acquireLock(lockPath);
  if (!locked) return { ok: true, used: -1, limit }; // fail open, same policy as the monthly counter
  try {
    return reserveRunLocal(file, runId, limit);
  } finally {
    releaseLock(lockPath);
  }
}

// Reserves one Firecrawl call. Checks the REAL account balance first (cached
// briefly, and automatically trying the backup account if the primary is at/under
// its safety margin); only falls back to the local file-locked monthly counter if
// NEITHER account's live check can be verified (no key, or the request fails).
// Either way, a call that the live/monthly check would allow can STILL be rejected
// by the run cap — a hard ceiling on real Firecrawl calls for the current pipeline
// run (see the RUN CAP comment at the top of this file), independent of how much
// balance remains on the accounts.
// Returns { ok, used, limit, remaining?, account?, reason? } — `remaining`/`account`
// are present when a live check answered ("primary" or "backup"), `used`/`limit`
// are always present (from the local counter in fallback mode, or synthesized
// around `remaining` when a live check governed), `reason: "run-cap"` is present
// when the run cap (not the account balance) is what rejected the call. Fails OPEN
// (ok: true, used: -1) if a lock can't be acquired at all, rather than blocking a
// scrape indefinitely over a rare double-count.
async function tryReserve({ file = DEFAULT_FILE, limit = DEFAULT_LIMIT, now = new Date(), fetchLive, fetchLiveBackup, runCapFile, runCapLimit = DEFAULT_RUN_CAP, runId = DEFAULT_RUN_ID } = {}) {
  const rcFile = runCapFile || (file + ".runcap");
  const checkRunCap = async () => (runCapLimit > 0 ? reserveRunCap(rcFile, runCapLimit, runId) : { ok: true, used: -1, limit: runCapLimit });

  const live = await liveRemaining({ fetchLive, fetchLiveBackup, now });
  if (live !== null) {
    const { remaining, account } = live;
    if (remaining <= SAFETY_MARGIN) return { ok: false, used: -1, limit, remaining, account };
    const runCap = await checkRunCap();
    if (!runCap.ok) return { ok: false, used: runCap.used, limit: runCap.limit, remaining, account, reason: "run-cap" };
    // A local reservation still happens under the lock so concurrent callers in
    // the same process/run see a consistent count for logging — but the ok/not-ok
    // decision above already came from the real account, not this local number.
    const lockPath = file + ".lock";
    const locked = await acquireLock(lockPath);
    if (!locked) return { ok: true, used: -1, limit, remaining, account };
    try {
      const r = reserveLocal(file, Infinity, now); // local counter is informational only here — never itself the gate
      return { ok: true, used: r.used, limit, remaining, account };
    } finally {
      releaseLock(lockPath);
    }
  }

  // Live check unavailable — fall back to the local file-locked monthly counter
  // (still gated by the run cap first).
  const runCap = await checkRunCap();
  if (!runCap.ok) return { ok: false, used: runCap.used, limit: runCap.limit, reason: "run-cap" };
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
  tryReserve, DEFAULT_FILE, DEFAULT_LIMIT, DEFAULT_RUN_CAP, DEFAULT_RUN_ID, backupApiKey, keyForAccount,
  _resetLiveCacheForTest: () => { liveCache = null; backupSwitchLogged = false; }, // test isolation only — liveCache is module-level
  _setFetchLiveForTest: (fn) => { defaultFetchLive = fn; }, // test isolation only — lets callers that don't pass fetchLive (e.g. scrape.js) be tested without a real network call
  _setFetchLiveBackupForTest: (fn) => { defaultFetchLiveBackup = fn; }, // test isolation only — same, for the backup-account check
};

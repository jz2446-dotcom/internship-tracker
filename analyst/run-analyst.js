// run-analyst.js — the scripted analyst loop. For each firm in a roster it does the
// mechanical work for FREE (resolve the ATS board → pull postings JSON → keyword-gate
// titles → mark board-present roles open) and hands only the ambiguous shortlist to
// the brain (Claude) for a relevance + eligibility ruling. Firms with no guessable ATS
// board get a browser pass (search → real ATS slug, or a careers page to scrape).
// Emits results in the tracker's per-tab schema plus an honest free-vs-brain split.
//
// Usage:
//   node run-analyst.js --roster ../data/environmental_roster.json [options]
// Options:
//   --brain nim|claude|none   who rules the uncertain pile. nim = FREE (NVIDIA key);
//                             claude = paid API key / ant login; none = title-only, no model.
//   --no-browse           skip the Playwright fallback for unresolved firms (ATS-JSON only)
//   --limit N             only process the first N firms (smoke tests)
//   --criteria "..."      tab focus for the brain; defaults to the roster's description
//   --out <path>          write results JSON here (default derives from the roster name)
//   --agent-key 1-5       for the 5-agent roster.json: extract just this agent's companies
//   --all-agents          for the 5-agent roster.json: flatten every agent's companies into
//                         one roster (sophomore/fall2026/fellowships/china_hk sweep these)
//   --tab <name>          tab-specific search/classify behavior — see lib/tab-profiles.js
//   --term fall2026|spring2027   tags every kept entry with this term (fall2026 tab)
//   --concurrency N       firms processed at once (default 8; NIM and search have their
//                         own internal throttles at 4 regardless of this value)
//
// Env: ANALYST_BROWSE_CONC controls how many Playwright sessions run concurrently in
// the Pass 2 browser fallback (default 4). Was a single serial session — see
// lib/browse.js / lib/pw.js for why each firm there is relatively expensive (multiple
// playwright-cli subprocess spawns per candidate URL).
//
// Model + auth for the brain live in lib/brain.js (ANALYST_BRAIN_MODEL, ANTHROPIC_API_KEY / ant login).
const fs = require("fs");
const path = require("path");
const ats = require("./lib/ats");
const classify = require("./lib/classify");
const browse = require("./lib/browse");
const extract = require("./lib/extract");
const pw = require("./lib/pw");
const webSearch = require("./lib/search");
const registry = require("./lib/registry");
const rosterAdapter = require("./lib/roster-adapter");
const tabProfiles = require("./lib/tab-profiles");

function arg(name, def) {
  const i = process.argv.indexOf("--" + name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}
const has = (name) => process.argv.includes("--" + name);

const ROSTER = arg("roster");
if (!ROSTER) { console.error("--roster <path> is required"); process.exit(2); }
// Brain provider: claude (paid API key/login), nim (FREE — NVIDIA key), none (deterministic),
// or defer — the mode the `new-refresh` skill drives: the app does ALL the free work and runs
// NIM in-process as the always-on backup + second opinion, then writes the ambiguous shortlist
// (each candidate carrying NIM's verdict + the page text) to disk for the session Claude to
// reconcile. Claude is the primary brain but judges WITH NIM's call in view — best of both.
const BRAIN = arg("brain", "claude");
const DEFER = BRAIN === "defer";
// In-process brain: NIM for both --brain nim and --brain defer (the free backup);
// heuristic = the deterministic in-app brain ALONE (zero AI, zero network judgments);
// otherwise whichever provider --brain names.
const brainMod =
  BRAIN === "heuristic"
    ? { MODEL: "heuristic", judge: async (c, crit) => require("./lib/heuristic").judge(c, crit) }
    : BRAIN === "claude-cli"
      ? require("./lib/claudecli") // local `claude` CLI, subscription auth — heuristic-triaged, opt-in
      : BRAIN === "ollama"
        ? require("./lib/ollamaBrain") // local Ollama server, fully offline, zero cost — heuristic-triaged, opt-in
        : BRAIN === "nim" || DEFER
          ? require("./lib/nimbrain")
          : require("./lib/brain");
// NIM backup runs in defer mode by default; --no-nim turns it off (Claude-only shortlist).
const NIM_BACKUP = DEFER && !has("no-nim");
const BROWSE = !has("no-browse");
const LIMIT = parseInt(arg("limit", "0"), 10) || 0;
const TAB = arg("tab", "");
const TERM = arg("term", "");
const AGENT_KEY = arg("agent-key", "");
const ALL_AGENTS = has("all-agents");
// Firms are processed concurrently — the work is almost pure I/O waiting (ATS JSON,
// search API, posting-page fetches, NIM judgments), so parallelism is nearly free
// wall-clock-wise. NIM gets its own tighter throttle across ALL firms so a burst of
// ambiguous candidates doesn't trip NVIDIA's rate limits (nimbrain retries 429s too).
const CONCURRENCY = Math.max(1, parseInt(arg("concurrency", "8"), 10) || 8);

// Tiny promise-pool: limiter(n) returns a wrap(fn) that lets at most n fn()s run at once.
function limiter(n) {
  let active = 0;
  const queue = [];
  const next = () => {
    if (active >= n || !queue.length) return;
    active++;
    const { fn, resolve, reject } = queue.shift();
    fn().then(resolve, reject).finally(() => { active--; next(); });
  };
  return (fn) => new Promise((resolve, reject) => { queue.push({ fn, resolve, reject }); next(); });
}
// NIM/search throttles are per-PROCESS; when the runner launches tabs in parallel it
// sets these env vars lower so the GLOBAL rate across all tabs stays what a single
// sequential tab used to send (e.g. 4 parallel tabs × ANALYST_NIM_CONC=1 ≈ old 4).
const firmLimit = limiter(CONCURRENCY);
const nimLimit = limiter(Math.max(1, parseInt(process.env.ANALYST_NIM_CONC || "4", 10) || 4));
const searchLimit = limiter(Math.max(1, parseInt(process.env.ANALYST_SEARCH_CONC || "4", 10) || 4));

const roster = rosterAdapter.loadRoster(ROSTER, { agentKey: AGENT_KEY, allAgents: ALL_AGENTS });
const profile = tabProfiles.get(TAB);
const CRITERIA = arg("criteria", (profile.criteriaPreamble ? profile.criteriaPreamble + " " : "") + (roster.description || roster.name || "finance/investing internships"));
const firms = Object.values(roster.groups || {}).flat();
const todo = LIMIT ? firms.slice(0, LIMIT) : firms;

const AGENT = arg("agent-name", path.basename(ROSTER).replace(/_roster\.json$/i, ""));
const OUT = arg("out", path.join(path.dirname(ROSTER), AGENT + "_results.json"));
const TODAY = new Date().toISOString().slice(0, 10);
// Session name is per-agent so parallel tabs in long mode each get their own browser
// instead of fighting over one named playwright-cli session.
const SESSION = "analyst-" + AGENT.replace(/[^a-z0-9_-]/gi, "");

const internships = [];
const shortlist = []; // defer mode: ambiguous candidates (+ NIM backup verdict) for the session Claude to reconcile
const stats = { firms: todo.length, ats: 0, searched: 0, browsed: 0, unresolved: 0, candidates: 0, free: 0, brain: 0, deferred: 0, dropped: 0 };
const seen = new Set(); // dedupe on company::title

// Pass 2 opens named Playwright sessions (lib/pw.js) that only got closed at the
// natural end of a worker's queue loop — if the process is killed mid-run (external
// stop, crash, timeout), those sessions leaked as orphaned playwright-cli daemons +
// their Chromium processes, silently eating RAM until the machine was manually swept
// (found live 2026-08-07: a killed discovery sweep left 6 orphaned sessions running).
// Track every opened session and force-close them on exit/interrupt as a safety net —
// best-effort only, since a hard SIGKILL gives no process any chance to run cleanup.
const openSessions = new Set();
let _cleaningUp = false;
function closeOpenSessions() {
  if (_cleaningUp) return;
  _cleaningUp = true;
  for (const s of openSessions) { try { pw.close(s); } catch (_) {} }
}
process.on("exit", closeOpenSessions);
process.on("SIGINT", () => { closeOpenSessions(); process.exit(130); });
process.on("SIGTERM", () => { closeOpenSessions(); process.exit(143); });

// Safety net for uncatchable Node/undici internal crashes (e.g. the ERR_ASSERTION in
// Parser.finish under concurrent keep-alive socket reuse — nodejs/undici#2109, #5450;
// confirmed live 2026-08-06 killing whole tabs mid-run with zero results written). Node
// explicitly warns it's unsafe to resume normal operation after uncaughtException, so
// this does NOT try to continue the run — it does synchronous cleanup (close browser
// sessions, dump whatever `internships` were already gathered this run to OUT so the
// work isn't silently lost) and exits. Without this, a crash mid-Pass-1 leaves OUT
// completely untouched (stale data, not even a partial write) with no trace of why.
process.on("uncaughtException", (err) => {
  console.error(`\n✗ uncaught exception (likely a Node/undici internal bug under load, not app logic): ${err && err.stack || err}`);
  closeOpenSessions();
  try {
    fs.writeFileSync(OUT, JSON.stringify({ agent: AGENT, name: roster.name, focus: CRITERIA, last_updated: TODAY, internships }, null, 2));
    console.error(`  wrote ${internships.length} entries gathered before the crash → ${OUT}`);
  } catch (writeErr) {
    console.error(`  could not write partial results: ${writeErr.message}`);
  }
  process.exit(1);
});

// Posting-page text for the brain: plain fetch, with Firecrawl render fallback for
// JS-shell pages when FIRECRAWL_API_KEY is set (lib/scrape.js — cached + capped).
const fetchText = (url) => require("./lib/scrape").fetchText(url);

function push(company, title, opts) {
  const key = `${company}::${title}::${TERM}`.toLowerCase();
  if (seen.has(key)) return;
  seen.add(key);
  internships.push({ company, program: title, category: AGENT, ...(TERM ? { term: TERM } : {}), ...opts });
}

// defer mode: run NIM in-process as the always-on backup / second opinion, then queue the
// candidate (with NIM's verdict + the page text) for the session Claude to reconcile later.
// Claude is the primary brain, but it judges each of these WITH NIM's verdict in view; if a
// Claude verdict never arrives (e.g. a headless run), apply-verdicts.js falls back to NIM's.
async function deferCandidate(company, title, apply_url, page_text, meta) {
  const key = `${company}::${title}::${TERM}`.toLowerCase();
  if (seen.has(key)) return;
  seen.add(key);
  let nim = null;
  if (NIM_BACKUP) {
    try { nim = await nimLimit(() => brainMod.judge({ company, title, apply_url, page_text }, CRITERIA)); }
    catch (e) { console.error(`  nim backup error: ${e.message}`); }
  }
  shortlist.push({
    company, title, apply_url,
    location: (meta && meta.location) || "",
    board: (meta && meta.board) || "",
    validThrough: (meta && meta.validThrough) || "",
    page_text: (page_text || "").slice(0, 8000),
    ...(TERM ? { term: TERM } : {}),
    nim,
  });
  stats.deferred++;
}

// Route one ATS posting (board presence ⇒ open). Free when the title is unambiguous;
// otherwise the brain rules relevance + eligibility.
async function processAtsPosting(company, p, sourceLabel) {
  const r = classify.routeAtsPosting(p, TAB);
  if (r.route === "skip") { stats.dropped++; return; }
  stats.candidates++;
  if (r.route === "confident") {
    stats.free++;
    push(company, p.title, {
      class_years: ["2028", "2029"], location: p.location, status: "open",
      apply_url: p.apply_url, notes: `Auto: ${p.source} board`, source: sourceLabel || "deterministic",
    });
    return;
  }
  if (DEFER) {
    const page_text = await fetchText(p.apply_url);
    await deferCandidate(company, p.title, p.apply_url, page_text, { location: p.location, board: p.source });
    return;
  }
  if (BRAIN === "none") { stats.dropped++; return; }
  stats.brain++;
  const page_text = await fetchText(p.apply_url);
  let v;
  try { v = await nimLimit(() => brainMod.judge({ company, title: p.title, apply_url: p.apply_url, page_text }, CRITERIA)); }
  catch (e) { console.error(`  brain error: ${e.message}`); stats.brain--; stats.dropped++; return; }
  if (!v.relevant) { stats.dropped++; return; }
  push(company, p.title, {
    class_years: v.class_years, location: v.location || p.location, status: v.status,
    apply_url: p.apply_url, notes: v.notes, source: `brain:${brainMod.MODEL}`,
  });
}

// Route a single self-hosted job page scraped by the browser (JSON-LD + body text).
async function processScraped(company, scraped, url) {
  const jp = scraped.jobPosting;
  if (!jp || !jp.title) return false;
  const tv = classify.titleVerdict(jp.title, TAB);
  if (tv === "skip") { stats.dropped++; return true; }
  stats.candidates++;
  const detVerdict = classify.verdictFromValidThrough(jp.validThrough); // open | closed | unknown
  if (tv === "confident" && detVerdict === "open") {
    stats.free++;
    push(company, jp.title, {
      class_years: ["2028", "2029"], location: "", status: "open", apply_url: url,
      notes: `Auto: JSON-LD (closes ${String(jp.validThrough).slice(0, 10)})`, source: "deterministic:jsonld",
    });
    return true;
  }
  if (DEFER) {
    await deferCandidate(company, jp.title, url, scraped.text, { validThrough: jp.validThrough || "" });
    return true;
  }
  if (BRAIN === "none") { stats.dropped++; return true; }
  stats.brain++;
  let v;
  try {
    v = await nimLimit(() => brainMod.judge({ company, title: jp.title, apply_url: url, page_text: scraped.text }, CRITERIA));
  } catch (e) { console.error(`  brain error: ${e.message}`); stats.brain--; stats.dropped++; return true; }
  if (!v.relevant) { stats.dropped++; return true; }
  push(company, jp.title, {
    class_years: v.class_years, location: v.location, status: v.status, apply_url: url,
    notes: v.notes, source: `brain:${brainMod.MODEL}`,
  });
  return true;
}

async function main() {
  const unresolved = [];
  const stillUnresolved = []; // survives both passes — apply-verdicts.js carries these firms' prior entries forward
  const careersHints = {}; // company -> careers URL found by search OR a remembered registry hint

  // Pass 0 — registry lookup (lib/registry.js): a firm solved in a PRIOR run doesn't
  // need to be re-guessed/re-searched/re-browsed from scratch. Known-ATS entries are
  // handled inline in Pass 1 below (skip slug-guessing, direct fetchBySlug). Known
  // bespoke ("sniff") entries skip straight to Pass 2 with their hint URL already set —
  // no point re-running Pass 1's guessing or Pass 1.5's search for a firm we already
  // know is neither.
  const guessTodo = [];
  const registrySniffFirms = []; // kept OUT of unresolved until after Pass 1.5, so the
  // search pass below (which drains `unresolved`) never wastes a lookup re-discovering
  // a hint we already have.
  for (const company of todo) {
    const reg = registry.get(company);
    if (reg && reg.provider === "sniff" && reg.hintUrl) {
      careersHints[company] = reg.hintUrl;
      registrySniffFirms.push(company);
    } else {
      guessTodo.push({ company, reg });
    }
  }

  // Pass 1 — free ATS-JSON path, CONCURRENCY firms at a time (pure I/O waiting).
  // seen/stats/push are all synchronous single-threaded mutations, so no locking needed;
  // completion order (and thus log order) is nondeterministic, which is fine.
  await Promise.all(guessTodo.map(({ company, reg }) => firmLimit(async () => {
    if (reg && reg.provider && reg.slug) {
      const postings = await ats.fetchBySlug(reg.provider, reg.slug);
      if (postings) {
        stats.ats++;
        for (const p of postings) await processAtsPosting(company, p, "registry");
        console.error(`✓ REG  ${company} → ${reg.provider}/${reg.slug} (${postings.length})`);
        return;
      }
      registry.forget(company); // stale — the board's gone or moved; rediscover below
    }
    const board = await ats.resolveBoard(company);
    if (!board) { unresolved.push(company); return; }
    stats.ats++;
    registry.record(company, { provider: board.provider, slug: board.slug }, "ats-guess");
    for (const p of board.postings) await processAtsPosting(company, p, "deterministic");
    console.error(`✓ ATS  ${company} (${board.provider}/${board.slug}, ${board.postings.length})`);
  })));

  // Pass 1.5 — REAL web search over the unresolved (Tavily/Brave key via keyfile.js;
  // cached cross-tab in data/_search_cache.json). Pure HTTP, ~1s/firm vs ~20s of
  // browser guessing. A search-found ATS slug rejoins the free ATS-JSON path with no
  // browser at all; a search-found careers URL becomes a direct hint for the browser
  // pass; a search miss falls through to the old guess-then-browse path unchanged.
  if (unresolved.length && webSearch.available()) {
    console.error(`\n… search pass over ${unresolved.length} unresolved firms (${webSearch.provider()})`);
    const stillAfterSearch = [];
    await Promise.all(unresolved.splice(0).map((company) => searchLimit(async () => {
      let hit = null;
      try { hit = await webSearch.resolveFirm(company, browse); } catch (_) {}
      if (hit && hit.slug) {
        const postings = await ats.fetchBySlug(hit.provider, hit.slug);
        if (postings) {
          stats.searched++;
          registry.record(company, { provider: hit.provider, slug: hit.slug }, "search-ats");
          for (const p of postings) await processAtsPosting(company, p, "search-ats");
          console.error(`✓ SRCH ${company} → ${hit.provider}/${hit.slug} (${postings.length})`);
          return;
        }
      }
      if (hit && hit.careersUrl) careersHints[company] = hit.careersUrl;
      stillAfterSearch.push(company);
    })));
    unresolved.push(...stillAfterSearch);
  }
  unresolved.push(...registrySniffFirms); // known-bespoke firms rejoin here with their hint already set

  // Pass 2 — browser fallback for the unresolved. Was a single-session serial for-loop
  // (every firm waited on every other firm's page loads); now a small pool of BROWSE
  // sessions pulls from a shared queue concurrently. Each firm's own findFirm() work is
  // still sequential internally (browser can't parallelize within one page), but
  // different firms' page loads now overlap instead of stacking end-to-end.
  if (BROWSE && unresolved.length) {
    console.error(`\n… browser pass over ${unresolved.length} unresolved firms`);
    const BROWSE_CONCURRENCY = Math.max(1, parseInt(process.env.ANALYST_BROWSE_CONC || "4", 10) || 4);
    const workerCount = Math.min(BROWSE_CONCURRENCY, unresolved.length);
    const queue = unresolved.slice();
    let qi = 0;
    const runWorker = async (wi) => {
      const wsession = `${SESSION}-b${wi}`;
      let opened = false;
      while (qi < queue.length) {
        const company = queue[qi++];
        if (!opened) { pw.openBlank(wsession); opened = true; openSessions.add(wsession); }
        const hit = browse.findFirm(wsession, company, profile.queryHint, careersHints[company], profile.searchTerm);
        if (hit && hit.slug) {
          const postings = await ats.fetchBySlug(hit.provider, hit.slug);
          if (postings) {
            stats.browsed++;
            registry.record(company, { provider: hit.provider, slug: hit.slug }, "browse-ats");
            for (const p of postings) await processAtsPosting(company, p, "browse-ats");
            console.error(`✓ WEB  ${company} → ${hit.provider}/${hit.slug} (${postings.length})`);
            continue;
          }
        }
        if (hit && hit.careersUrl) {
          const scraped = extract.fetchJobPage(wsession, hit.careersUrl);
          if (scraped && (await processScraped(company, scraped, hit.careersUrl))) {
            stats.browsed++;
            console.error(`✓ WEB  ${company} → scraped ${hit.careersUrl}`);
            continue;
          }
        }
        if (hit && hit.sniffed) {
          // A bespoke portal's own JSON API, mined by shape (lib/sniff.js) — not a
          // known ATS board, so routed through the SAME title/finance gate as
          // everything else rather than trusted as "board presence ⇒ open". The hint
          // URL IS remembered though — next run skips straight past guess+search to
          // this exact page instead of rediscovering it.
          stats.browsed++;
          registry.record(company, { provider: "sniff", hintUrl: hit.sniffedUrl }, "browse-sniff");
          for (const p of hit.sniffed) await processAtsPosting(company, p, "browse-sniff");
          console.error(`✓ WEB  ${company} → sniffed API (${hit.sniffed.length})`);
          continue;
        }
        stats.unresolved++;
        stillUnresolved.push(company);
      }
      if (opened) { pw.close(wsession); openSessions.delete(wsession); }
    };
    await Promise.all(Array.from({ length: workerCount }, (_, wi) => runWorker(wi)));
  } else {
    stats.unresolved = unresolved.length;
    stillUnresolved.push(...unresolved);
  }

  const dir = path.dirname(ROSTER);
  if (DEFER) {
    const partialPath = path.join(dir, AGENT + "_results.partial.json");
    const shortPath = path.join(dir, AGENT + "_shortlist.json");
    // Firms this sweep could not even check (no ATS match, no scrapeable careers page) —
    // apply-verdicts.js needs this list to carry forward their prior entries instead of
    // silently dropping them, since "unresolved" is not evidence a posting closed.
    fs.writeFileSync(partialPath, JSON.stringify({ agent: AGENT, name: roster.name, focus: CRITERIA, last_updated: TODAY, internships, unresolvedCompanies: stillUnresolved }, null, 2));
    fs.writeFileSync(shortPath, JSON.stringify({ agent: AGENT, name: roster.name, focus: CRITERIA, criteria: CRITERIA, last_updated: TODAY, shortlist }, null, 2));
  } else {
    // CARRY-FORWARD (the fix for the 2026-08-04 data loss): this engine can only see
    // firms it resolved via ATS/search/browse. For firms still unresolved this run,
    // absence is NOT evidence anything closed — keep their entries from the previous
    // results file instead of silently discarding them. (The defer path always had
    // this via apply-verdicts' unresolvedCompanies; the single-brain modes did not,
    // so a --no-browse run overwrote agent1's 277 entries with 3.)
    let carried = 0;
    try {
      const prev = JSON.parse(fs.readFileSync(OUT, "utf8"));
      const un = new Set(stillUnresolved.map((c) => c.toLowerCase()));
      for (const e of prev.internships || []) {
        if (!un.has((e.company || "").toLowerCase())) continue;
        const k = `${e.company}::${e.program}::${TERM}`.toLowerCase();
        if (seen.has(k)) continue;
        seen.add(k);
        internships.push(e);
        carried++;
      }
    } catch (_) { /* no previous file — nothing to carry */ }
    if (carried) console.error(`↩ carried forward ${carried} prior entries for ${stillUnresolved.length} unresolved firms`);
    fs.writeFileSync(OUT, JSON.stringify({ agent: AGENT, name: roster.name, focus: CRITERIA, last_updated: TODAY, internships }, null, 2));
  }

  const decided = stats.free + stats.brain || 1;
  console.error("\n── analyst run summary ─────────────────────────");
  console.error(`firms:        ${stats.firms}  (ATS ${stats.ats}, search-resolved ${stats.searched}, browser-resolved ${stats.browsed}, still unresolved ${stats.unresolved})`);
  console.error(`candidates:   ${stats.candidates} title-gated postings`);
  if (DEFER) {
    const nimCount = shortlist.filter((s) => s.nim).length;
    console.error(`decided FREE: ${stats.free}   |  deferred to Claude: ${stats.deferred}   (NIM backup verdict on ${nimCount}/${stats.deferred})`);
    console.error(`free results: ${internships.length} → ${AGENT}_results.partial.json`);
    console.error(`shortlist:    ${shortlist.length} → ${AGENT}_shortlist.json   (Claude judges, then run apply-verdicts.js --agent ${AGENT})`);
  } else {
    console.error(`decided FREE: ${stats.free}   |  sent to BRAIN: ${stats.brain}   (${Math.round((stats.free / decided) * 100)}% free of decided)`);
    console.error(`kept:         ${internships.length} relevant internships → ${OUT}`);
  }
  console.error("────────────────────────────────────────────────");
}

main().catch((e) => { console.error(e); process.exit(1); });

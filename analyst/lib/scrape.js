// scrape.js — posting-page text for the brain to read. Plain fetch first (free,
// instant, works for server-rendered pages). If that comes back THIN — the classic
// JS-rendered shell (Workday, embedded boards, SPA career sites) where the brain
// would otherwise judge half-blind — fall back to Firecrawl's render-and-extract
// API (FIRECRAWL_API_KEY via lib/keyfile.js; firecrawl.dev). If Firecrawl is
// unavailable or its real account balance is exhausted (lib/firecrawl-budget.js),
// fall back further to a local Playwright render (lib/pw.js) — the same zero-token
// browser engine the career-page discovery pass already uses. This is a hard rule:
// a thin page NEVER just gives up with degraded text — there is always a path to
// real rendered content, so a Firecrawl outage or exhausted balance never silently
// shrinks research coverage the way the old per-tab cap did.
//
// Credit discipline: Firecrawl only fires when plain fetch got <MIN_TEXT chars, and
// every call is checked against the real account balance (lib/firecrawl-budget.js).
// Playwright has no credit cost but is slower (a real browser render per page) —
// it only fires when Firecrawl ALSO didn't produce enough text, not on every thin
// page unconditionally.
//
// Both Firecrawl and Playwright results cache in data/_scrape_cache.json (3-day
// TTL — posting text drives open/closed calls, so don't cache it long).
const fs = require("fs");
const path = require("path");
const { apiKey } = require("./keyfile");
const { rawRequest } = require("./http"); // NOT fetch()/undici — see lib/http.js
const pw = require("./pw");

const CACHE_FILE = path.join(__dirname, "..", "..", "data", "_scrape_cache.json");
const CACHE_TTL_MS = 3 * 24 * 60 * 60 * 1000;
const MIN_TEXT = 300; // plain-fetch text shorter than this = JS shell, worth rendering
const budget = require("./firecrawl-budget");

let capLogged = false;
let _cache = null;
function loadCache() {
  if (_cache) return _cache;
  try { _cache = JSON.parse(fs.readFileSync(CACHE_FILE, "utf8")); } catch (_) { _cache = {}; }
  return _cache;
}
function saveCache() {
  // Merge-on-save so parallel tabs don't clobber each other's cached scrapes.
  try {
    let onDisk = {};
    try { onDisk = JSON.parse(fs.readFileSync(CACHE_FILE, "utf8")); } catch (_) {}
    _cache = { ...onDisk, ..._cache };
    fs.writeFileSync(CACHE_FILE, JSON.stringify(_cache));
  } catch (_) {}
}
function cacheGet(url) {
  const hit = loadCache()[url];
  return hit && Date.now() - hit.t < CACHE_TTL_MS ? hit.text : null;
}
function cacheSet(url, text) {
  loadCache()[url] = { t: Date.now(), text };
  saveCache();
}

const available = () => !!apiKey("FIRECRAWL_API_KEY");

function htmlToText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

async function plainFetch(url, timeoutMs) {
  const res = await rawRequest(url, { timeoutMs });
  if (!res || res.status < 200 || res.status >= 300) return "";
  return htmlToText(res.body);
}

async function firecrawl(url) {
  const cached = cacheGet(url);
  if (cached !== null) return cached;
  const reserved = await budget.tryReserve();
  if (!reserved.ok) {
    if (!capLogged) {
      capLogged = true;
      const why = typeof reserved.remaining === "number" ? `${reserved.remaining} real credits left` : `local budget ${reserved.limit} reached`;
      console.error(`  firecrawl budget exhausted (${why}) — falling back to local Playwright render`);
    }
    return "";
  }
  try {
    const res = await rawRequest("https://api.firecrawl.dev/v1/scrape", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey("FIRECRAWL_API_KEY")}`, "Content-Type": "application/json" },
      body: JSON.stringify({ url, formats: ["markdown"], onlyMainContent: true }),
      timeoutMs: 45000,
    });
    if (!res || res.status < 200 || res.status >= 300) return "";
    const j = JSON.parse(res.body);
    const text = ((j.data && j.data.markdown) || "").replace(/\s+/g, " ").trim();
    cacheSet(url, text);
    return text;
  } catch (_) {
    return "";
  }
}

// A single warm Playwright session, lazily opened and reused for every fallback
// render in this process (each tab is its own short-lived node process) — matches
// the session-per-worker pattern lib/browse.js's Pass 2 already uses, so repeated
// fallback fetches don't each pay a full browser launch. Closed on process exit,
// same mechanism run-analyst.js's own sessions use, so a killed/crashed run never
// leaks an orphaned browser (the exact failure this codebase has hit before).
const PW_SESSION = `scrape-${process.pid}`;
let pwOpened = false;
let playwrightLogged = false;
process.on("exit", () => { if (pwOpened) { try { pw.close(PW_SESSION); } catch (_) {} } });

const EXTRACT_TEXT_FN = "() => (document.body.innerText || '').slice(0, 9000)";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function extractPwText() {
  const text = pw.evalJson(PW_SESSION, EXTRACT_TEXT_FN);
  return (typeof text === "string" ? text : "").replace(/\s+/g, " ").trim();
}

async function playwrightRender(url) {
  const cached = cacheGet(url);
  if (cached !== null) return cached;
  if (!playwrightLogged) { playwrightLogged = true; console.error("  rendering thin pages locally via Playwright (no credit cost, slower per page)"); }
  try {
    if (!pwOpened) { pw.openBlank(PW_SESSION); pwOpened = true; }
    const r = pw.goto(PW_SESSION, url);
    if (r.code !== 0) return "";
    // `goto` returns once the page's own load event fires, but SPA job boards
    // (Workday etc.) fetch the actual posting data AFTER that — grabbing text
    // immediately captures just the loading shell. Give it a moment, and if
    // still thin, one longer second attempt before accepting what we have.
    await sleep(2000);
    let clean = extractPwText();
    if (clean.length < MIN_TEXT) {
      await sleep(3000);
      const retry = extractPwText();
      if (retry.length > clean.length) clean = retry;
    }
    if (clean) cacheSet(url, clean);
    return clean;
  } catch (_) {
    return "";
  }
}

// The one entry point: best-available plain text for a posting page, capped at `max` chars.
// Hard rule: a thin plain-fetch NEVER just gives up — Firecrawl (if available and
// under budget) then Playwright (always available) both get a real chance before
// falling back to whatever plain fetch got.
async function fetchText(url, { timeoutMs = 15000, max = 9000 } = {}) {
  if (!url) return "";
  const plain = await plainFetch(url, timeoutMs);
  if (plain.length >= MIN_TEXT) return plain.slice(0, max);

  let best = plain;
  if (available()) {
    const rendered = await firecrawl(url);
    if (rendered.length > best.length) best = rendered;
  }
  if (best.length < MIN_TEXT) {
    const viaPw = await playwrightRender(url);
    if (viaPw.length > best.length) best = viaPw;
  }
  return best.slice(0, max);
}

module.exports = { fetchText, available, _firecrawlForTest: firecrawl, _playwrightRenderForTest: playwrightRender };

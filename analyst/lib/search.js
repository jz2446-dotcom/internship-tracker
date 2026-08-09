// search.js — REAL web search for firm discovery, replacing the browser-guessing
// bottleneck. Plain keyless scraping is dead (DuckDuckGo captchas even a plain Node
// fetch — verified 2026-08-01), so this uses a real search API with a free tier:
//
//   TAVILY_API_KEY  — tavily.com, free 1000 searches/mo   (preferred)
//   BRAVE_API_KEY   — brave.com/search/api, free 2000/mo  (fallback provider)
//
// Keys load like every other credential here: env var, else OneDrive\Documents\.env
// (lib/keyfile.js). No key at all → available() is false and callers skip the search
// pass entirely (the old guess-then-browse path still works unchanged).
//
// QUOTA DISCIPLINE: one query per firm, and every result is cached in
// data/_search_cache.json with a 30-day TTL. The whole-roster tabs (sophomore, fall,
// spring, fellowships, china_hk) hit the same ~160 unresolved firms as the 5 core
// agents — the cache means each firm costs ONE search per month across ALL tabs and
// runs (~460/mo total), keeping any refresh cadence inside the free tier.
const fs = require("fs");
const path = require("path");
const { apiKey } = require("./keyfile");
const { rawRequest } = require("./http"); // NOT fetch()/undici — see lib/http.js

const CACHE_FILE = path.join(__dirname, "..", "..", "data", "_search_cache.json");
// 30 days: the cache holds firm→board-location mappings (which ATS a company uses /
// where its careers page is), NOT posting data — postings are fetched live from the
// board every run. Board locations are stable for months, and a 7-day TTL would cost
// ~460 searches/week ≈ 1,850/mo — over Tavily's 1,000 free tier. 30 days ≈ ~460/mo.
const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

let _cache = null;
function loadCache() {
  if (_cache) return _cache;
  try { _cache = JSON.parse(fs.readFileSync(CACHE_FILE, "utf8")); }
  catch (_) { _cache = {}; }
  return _cache;
}
function saveCache() {
  // Merge-on-save: parallel tabs each hold an in-memory copy — re-read the file and
  // fold our entries over it so concurrent processes never clobber each other's writes.
  try {
    let onDisk = {};
    try { onDisk = JSON.parse(fs.readFileSync(CACHE_FILE, "utf8")); } catch (_) {}
    _cache = { ...onDisk, ..._cache };
    fs.writeFileSync(CACHE_FILE, JSON.stringify(_cache, null, 1));
  } catch (_) {}
}

function provider() {
  if (apiKey("TAVILY_API_KEY")) return "tavily";
  if (apiKey("BRAVE_API_KEY")) return "brave";
  return null;
}
const available = () => !!provider();

async function fetchJson(url, opts, timeoutMs) {
  const res = await rawRequest(url, { ...opts, timeoutMs: timeoutMs || 20000 });
  if (!res) throw new Error("search request failed");
  if (res.status === 429) throw new Error("rate-limited (429)");
  if (res.status < 200 || res.status >= 300) throw new Error(`search HTTP ${res.status}`);
  try { return JSON.parse(res.body); } catch (_) { throw new Error("search response not JSON"); }
}

async function tavilySearch(query, count) {
  const j = await fetchJson("https://api.tavily.com/search", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey("TAVILY_API_KEY")}` },
    body: JSON.stringify({ query, max_results: count, search_depth: "basic" }),
  });
  return (j.results || []).map((r) => ({ url: r.url, title: r.title || "", snippet: r.content || "" }));
}

async function braveSearch(query, count) {
  const j = await fetchJson(
    `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${count}`,
    { headers: { "X-Subscription-Token": apiKey("BRAVE_API_KEY"), Accept: "application/json" } }
  );
  return ((j.web && j.web.results) || []).map((r) => ({ url: r.url, title: r.title || "", snippet: r.description || "" }));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// One search, cached + retried. Returns [{url,title,snippet}] or null (unavailable/failed).
// Failures return null rather than throwing — an unsearchable firm falls through to the
// browse pass exactly as before.
async function search(query, { count = 10 } = {}) {
  const prov = provider();
  if (!prov) return null;
  const cache = loadCache();
  const key = `${prov}:${query}`;
  const hit = cache[key];
  if (hit && Date.now() - hit.t < CACHE_TTL_MS) return hit.results;
  for (let a = 0; a < 3; a++) {
    try {
      const results = prov === "tavily" ? await tavilySearch(query, count) : await braveSearch(query, count);
      cache[key] = { t: Date.now(), results };
      saveCache();
      return results;
    } catch (e) {
      if (a === 2) { console.error(`  search failed (${e.message}) — falling back to browse`); return null; }
      await sleep(2000 * (a + 1));
    }
  }
  return null;
}

// Firm discovery: ONE deliberately tab-independent query per firm (no per-tab hint, so
// every tab shares the cache entry), mined for an ATS slug or a careers URL — the same
// two outcomes browse.findFirm produces, so run-analyst can treat them identically.
// detectAts/pickCareersUrl are injected by the caller (they live in browse.js; requiring
// browse.js here would drag in the playwright wrapper for nothing).
async function resolveFirm(company, { detectAts, pickCareersUrl }) {
  const results = await search(`"${company}" careers internship jobs`, { count: 10 });
  if (!results || !results.length) return null;
  const urls = results.map((r) => r.url);
  const ats = detectAts(urls);
  if (ats) return ats;
  const careersUrl = pickCareersUrl(urls, company);
  return careersUrl ? { careersUrl } : null;
}

module.exports = { available, provider, search, resolveFirm, CACHE_FILE };

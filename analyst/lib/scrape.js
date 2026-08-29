// scrape.js — posting-page text for the brain to read. Plain fetch first (free,
// instant, works for server-rendered pages). If that comes back THIN — the classic
// JS-rendered shell (Workday, embedded boards, SPA career sites) where the brain
// would otherwise judge half-blind — fall back to Firecrawl's render-and-extract
// API (FIRECRAWL_API_KEY via lib/keyfile.js; firecrawl.dev, free ~500 credits).
//
// Credit discipline: Firecrawl only fires when plain fetch got <MIN_TEXT chars,
// results cache in data/_scrape_cache.json (3-day TTL — posting text drives
// open/closed calls, so don't cache it long), and every call is checked against a
// budget SHARED across all concurrently-running tab processes (lib/firecrawl-budget.js)
// — when the budget's exhausted, remaining thin pages just proceed with whatever
// plain fetch got (exactly the pre-Firecrawl behavior), logged once so a starved run
// is visible, never silent.
const fs = require("fs");
const path = require("path");
const { apiKey } = require("./keyfile");
const { rawRequest } = require("./http"); // NOT fetch()/undici — see lib/http.js

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
  const cache = loadCache();
  const hit = cache[url];
  if (hit && Date.now() - hit.t < CACHE_TTL_MS) return hit.text;
  const reserved = await budget.tryReserve();
  if (!reserved.ok) {
    if (!capLogged) { capLogged = true; console.error(`  firecrawl daily budget (${reserved.limit}) exhausted — remaining thin pages use plain-fetch text`); }
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
    cache[url] = { t: Date.now(), text };
    saveCache();
    return text;
  } catch (_) {
    return "";
  }
}

// The one entry point: best-available plain text for a posting page, capped at `max` chars.
async function fetchText(url, { timeoutMs = 15000, max = 9000 } = {}) {
  if (!url) return "";
  const plain = await plainFetch(url, timeoutMs);
  if (plain.length >= MIN_TEXT || !available()) return plain.slice(0, max);
  const rendered = await firecrawl(url);
  return (rendered.length > plain.length ? rendered : plain).slice(0, max);
}

module.exports = { fetchText, available, _firecrawlForTest: firecrawl };

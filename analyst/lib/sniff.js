// sniff.js — zero-token, vendor-agnostic job-API detector. detectAts() only catches
// companies on one of a handful of known ATS platforms; a company running a fully
// bespoke careers portal (e.g. Microsoft) is invisible to it even though the portal
// almost always still fetches its own listings from SOME backend JSON API client-side
// (verified live 2026-08-06: careers.microsoft.com calls
// apply.careers.microsoft.com/api/pcsx/search — a plain, unauthenticated JSON API).
//
// Rather than hardcoding every vendor (impossible), this reads whatever XHR/fetch
// responses the page ALREADY made while rendering (via playwright-cli's `requests` /
// `response-body` — no extra page load, reuses the goto() that already happened) and
// recognizes "this looks like a job list" purely by JSON SHAPE: an array of >=3
// objects sharing a title-like field paired with a location/URL/id-like field. No
// LLM, no per-vendor knowledge — pure structural pattern matching, same zero-token
// spirit as the ATS-JSON path.
//
// Sniffed postings are NOT auto-trusted as "board presence = open" the way a known
// ATS's board is (an unknown vendor might list closed postings too) — run-analyst.js
// routes them through classify.routeAtsPosting exactly like any other candidate, so
// the SAME title/finance gate that filters ATS noise also filters sniff noise for
// free, and only genuinely ambiguous ones reach the brain.
const pw = require("./pw");

const TITLE_KEYS = ["title", "name", "jobtitle", "positiontitle", "job_title", "position_title", "req_title", "postingtitle", "requisitiontitle"];
const LOC_KEYS = ["location", "locations", "city", "joblocation", "worklocation", "standardizedlocations", "primarylocation"];
const URL_KEYS = ["url", "applyurl", "joburl", "postingurl", "positionurl", "req_url", "href", "link", "detailurl"];
const ID_KEYS = ["id", "jobid", "requisitionid", "reqid", "positionid", "atsjobid", "req_id", "displayjobid"];

function keyMatch(keys, wantList) {
  const lower = keys.map((k) => k.toLowerCase());
  return wantList.find((w) => lower.includes(w));
}

// A real job id/req number almost always carries digits (numeric id, "R231441-1", a
// long opaque token) — a nav menu's "nav1"/"nav2"/"nav3" doesn't. Guards a bare
// id-only match (no url, no location) from accepting non-job lists.
function looksLikeJobId(v) {
  const s = String(v);
  return /\d{2,}/.test(s) || s.length >= 8;
}

// Score one candidate array: does it look like a job/position list?
function scoreArray(arr) {
  if (!Array.isArray(arr) || arr.length < 3) return null; // too small a sample to trust
  const sample = arr.slice(0, 10).filter((x) => x && typeof x === "object" && !Array.isArray(x));
  if (sample.length < 3) return null;
  const keys = Object.keys(sample[0]);
  const titleKey = keyMatch(keys, TITLE_KEYS);
  const locKey = keyMatch(keys, LOC_KEYS);
  const urlKey = keyMatch(keys, URL_KEYS);
  const idKey = keyMatch(keys, ID_KEYS);
  if (!titleKey) return null;
  const titleHitRate = sample.filter((o) => typeof o[Object.keys(o).find((k) => k.toLowerCase() === titleKey)] === "string").length / sample.length;
  if (titleHitRate < 0.8) return null;
  if (locKey || urlKey) return { titleKey, locKey, urlKey, idKey, size: arr.length };
  if (idKey) {
    const idHitRate = sample.filter((o) => looksLikeJobId(o[Object.keys(o).find((k) => k.toLowerCase() === idKey)])).length / sample.length;
    if (idHitRate >= 0.8) return { titleKey, locKey, urlKey, idKey, size: arr.length };
  }
  return null;
}

// Walk the object (bounded depth) looking for the best-scoring array anywhere inside.
function findJobArray(obj, depth, best) {
  if (depth > 4 || obj == null || typeof obj !== "object") return best;
  if (Array.isArray(obj)) {
    const s = scoreArray(obj);
    if (s && (!best || s.size > best.score.size)) best = { array: obj, score: s };
    return best;
  }
  for (const v of Object.values(obj)) best = findJobArray(v, depth + 1, best);
  return best;
}

function extractPostings(json, baseUrl) {
  const hit = findJobArray(json, 0, null);
  if (!hit) return null;
  const { array, score } = hit;
  const realKey = (obj, lowerKey) => lowerKey && Object.keys(obj).find((k) => k.toLowerCase() === lowerKey);
  const postings = array
    .map((o) => {
      const tk = realKey(o, score.titleKey);
      const lk = realKey(o, score.locKey);
      const uk = realKey(o, score.urlKey);
      let url = uk ? o[uk] : "";
      if (url && baseUrl && !/^https?:\/\//i.test(url)) {
        try { url = new URL(url, baseUrl).href; } catch (_) { url = ""; }
      }
      let loc = lk ? o[lk] : "";
      if (Array.isArray(loc)) loc = loc.join("; ");
      return { title: tk ? o[tk] : "", apply_url: url, location: loc || "", open: true, source: "sniff" };
    })
    .filter((p) => p.title);
  return postings.length ? postings : null;
}

// Known noise: analytics/telemetry/ad/CDN endpoints that are never job data, so we
// don't waste a response-body CLI call (each is its own subprocess spawn) on them.
const NOISE_HOSTS = /google|youtube|gstatic|onecollector|events\.data\.microsoft|doubleclick|facebook\.net|hotjar|segment\.io|mixpanel|amplitude|clarity\.ms|adnxs|criteo|visualstudio\.com\/v2\/track/i;
const MAX_CANDIDATES = 15; // cap response-body calls per firm

function listCandidateRequests(session) {
  const r = pw.run(session, ["requests", "--raw"], { timeout: 20000 });
  if (r.code !== 0 || !r.out) return [];
  const out = [];
  for (const line of r.out.split("\n")) {
    const m = line.match(/^(\d+)\.\s+\[(GET|POST)\]\s+(\S+)\s+=>\s+\[(\d+)\]/);
    if (!m) continue;
    const [, idx, , url, status] = m;
    if (status !== "200") continue;
    if (NOISE_HOSTS.test(url)) continue;
    if (!/json|api|search|jobs?|position|career|posting|opening|listing/i.test(url)) continue;
    out.push({ idx, url });
  }
  return out.slice(0, MAX_CANDIDATES);
}

// Last-resort discovery for a page already loaded in `session`: mine its own network
// traffic for a job-shaped JSON array. Returns postings[] or null.
function sniffJobsApi(session) {
  for (const { idx, url } of listCandidateRequests(session)) {
    const r = pw.run(session, ["response-body", idx, "--raw"], { timeout: 15000 });
    if (r.code !== 0 || !r.out) continue;
    let json;
    try { json = JSON.parse(r.out); } catch (_) { continue; }
    const postings = extractPostings(json, url);
    if (postings) return postings;
  }
  return null;
}

module.exports = { sniffJobsApi, extractPostings, scoreArray };

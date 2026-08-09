// http.js — shared low-level HTTP helper for the whole analyst pipeline. Uses Node's
// classic `http`/`https` modules directly, NOT the global fetch() (which is backed by
// undici). undici's connection pool has a real, currently-open upstream bug where
// concurrent requests can crash the whole process with an uncatchable ERR_ASSERTION
// deep in its HTTP parser during keep-alive socket teardown (nodejs/undici#2109,
// #5450). Confirmed live 2026-08-06/07 across THREE different call sites in this repo
// (ats.js's Workday pagination, scrape.js's plain-text page fetches, and — moved here
// specifically so nimbrain.js/brain.js don't reopen it in production once real judging
// resumes) — it isn't tied to one host or one pattern, it's inherent to fetch() under
// this app's concurrency. A `Connection: close` header does NOT fix it: "Connection" is
// forbidden by the Fetch spec and undici silently drops it, so that header never
// reaches the wire. `agent: false` on the classic http(s) client genuinely disables
// connection reuse instead of asking undici nicely.
const http = require("http");
const https = require("https");
const { URL } = require("url");

// Resolves { status, headers, body } on any completed HTTP response (2xx through 5xx —
// callers decide what counts as an error, same as they did inspecting `res.ok`/
// `res.status` on a fetch() Response). Resolves null on network failure, timeout, or an
// unparseable URL. Never throws — same contract fetch() callers here already expected
// from their try/catch wrappers.
function rawRequest(url, { method = "GET", headers = {}, body, timeoutMs = 15000 } = {}) {
  return new Promise((resolve) => {
    let u;
    try { u = new URL(url); } catch (_) { return resolve(null); }
    const lib = u.protocol === "http:" ? http : https;
    const payload = body != null ? (typeof body === "string" ? body : JSON.stringify(body)) : undefined;
    const req = lib.request(
      {
        hostname: u.hostname,
        port: u.port || undefined,
        path: u.pathname + u.search,
        method,
        agent: false, // no pooled socket — sidesteps undici's connection-pool bug entirely
        headers: { ...headers, ...(payload ? { "Content-Length": Buffer.byteLength(payload) } : {}) },
      },
      (res) => {
        let data = "";
        res.setEncoding("utf8");
        res.on("data", (c) => { data += c; });
        res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
        res.on("error", () => resolve(null));
      }
    );
    req.on("error", () => resolve(null));
    req.setTimeout(timeoutMs, () => { req.destroy(); resolve(null); });
    if (payload) req.write(payload);
    req.end();
  });
}

// JSON convenience wrapper matching the old fetch()+res.json() shape most call sites
// used. Resolves null on any failure (network, timeout, non-2xx, bad JSON).
async function rawJson(url, opts) {
  const res = await rawRequest(url, opts);
  if (!res || res.status < 200 || res.status >= 300) return null;
  try { return JSON.parse(res.body); } catch (_) { return null; }
}

module.exports = { rawRequest, rawJson };

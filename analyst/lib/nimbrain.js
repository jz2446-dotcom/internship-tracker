// nimbrain.js — a FREE brain, drop-in for lib/brain.js. Uses the NVIDIA NIM models
// (deepseek / llama / openai) the tracker already has a key for, so the relevance
// judgment runs at $0 with no console API key. Same judge() signature and return
// shape as brain.js, so run-analyst.js can swap providers with --brain nim.
//
// Model: one NIM model does the relevance call (the tri-model consensus in
// scripts/nim/judge.js is for the open/closed second opinion, not needed here).
// Default deepseek — measured 2026-08-01: deepseek 1-4s/call, llama 38-125s (congested),
// openai/gpt-oss timing out entirely. Override with ANALYST_NIM_MODEL = deepseek | llama | openai
// if the queues shift. Key: NVIDIA_API_KEY from env or OneDrive\Documents\.env (same loader as judge.js).
const { apiKey } = require("./keyfile");
const { rawRequest } = require("./http"); // NOT fetch()/undici — see lib/http.js

const BASE = "https://integrate.api.nvidia.com/v1/chat/completions";
const IDS = {
  deepseek: "deepseek-ai/deepseek-v4-pro",
  llama: "meta/llama-3.3-70b-instruct",
  openai: "openai/gpt-oss-120b",
};
const SHORT = process.env.ANALYST_NIM_MODEL || "deepseek";
const MODEL = "nim:" + SHORT;
const TODAY = new Date().toISOString().slice(0, 10);

function extractJson(text) {
  if (!text) return null;
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
}

function prompt(candidate, criteria) {
  const text = (candidate.page_text || "").slice(0, 8000);
  return `Today is ${TODAY}. Screen ONE job posting for an internship tracker, using the page text ONLY (no outside knowledge).

TAB FOCUS (a role only counts if it fits this): ${criteria}

Company: ${candidate.company}
Posting title: ${candidate.title}

--- PAGE TEXT START ---
${text}
--- PAGE TEXT END ---

Return ONLY a JSON object, no prose, with exactly these keys:
{"relevant": true|false, "status": "open"|"closed"|"program-page", "class_years": ["2028"|"2029"...], "location": "short string or empty", "notes": "one short sentence", "confidence": "high"|"med"|"low"}

- relevant: true only if the posting genuinely fits the TAB FOCUS (a general/back-office role at a firm that merely has the relevant function does NOT count).
- status: "open" only with positive evidence it's accepting applications now; "closed" if the deadline passed; else "program-page".
- class_years: which of "2028","2029" it's open to; default both unless the text restricts eligibility (grad-only → []).`;
}

// One HTTP attempt with its own timeout. Split out so judge() can retry — a single
// timed-out call used to bubble up as "This operation was aborted" and run-analyst
// would DROP that candidate from the run entirely.
async function attempt(key, id, candidate, criteria, timeoutMs) {
  const timeoutRef = {};
  const res = await rawRequest(BASE, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: id,
      messages: [{ role: "user", content: prompt(candidate, criteria) }],
      max_tokens: 800, // openai/gpt-oss is a reasoning model — needs room
      temperature: 0,
    }),
    timeoutMs,
  }, timeoutRef);
  if (!res) {
    const e = new Error(timeoutRef.timedOut ? "NIM request timed out" : "NIM request failed");
    e.isTimeout = !!timeoutRef.timedOut; // congestion/slow response — NOT evidence the key/model is dead, see judge()
    throw e;
  }
  if (res.status < 200 || res.status >= 300) throw new Error(`NIM ${res.status}`);
  return JSON.parse(res.body);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function parseVerdict(j, modelShort) {
  const msg = (j.choices && j.choices[0] && j.choices[0].message) || {};
  const content = (msg.content && msg.content.trim()) || msg.reasoning_content || "";
  const v = extractJson(content);
  if (!v) return { relevant: false, status: "program-page", class_years: [], location: "", notes: `nim:${modelShort} unparseable`, confidence: "low" };
  return {
    relevant: !!v.relevant,
    status: ["open", "closed", "program-page"].includes(v.status) ? v.status : "program-page",
    class_years: Array.isArray(v.class_years) ? v.class_years.filter((y) => y === "2028" || y === "2029") : [],
    location: v.location || "",
    notes: v.notes || "",
    confidence: v.confidence || "low",
  };
}

// Failover order: preferred model first, then the other two. Each NIM model has its
// OWN rate bucket, so a 429 on one says nothing about the others — switch instantly
// instead of backing off (a 429'd model goes on a shared 60s cooldown so concurrent
// callers stop hammering it too). If EVERY model is unavailable, the deterministic
// heuristic brain (lib/heuristic.js) rules — conservative, low-confidence, never drops.
const ORDER = [SHORT, ...Object.keys(IDS).filter((m) => m !== SHORT)];
const cooldownUntil = {}; // model short name -> epoch ms
const failStreak = {}; // model short name -> consecutive failures (drives escalating cooldown)

// Escalating cooldown: 1min → 2min → 4min → ... capped at 10min. A flat 60s cooldown
// thrashed on congested evenings — it expired between candidates, so EVERY candidate
// re-paid the full 3-model probe (~minutes each). Consecutive failures now stretch the
// cooldown, and a success resets it.
function coolOff(m) {
  failStreak[m] = (failStreak[m] || 0) + 1;
  const ms = Math.min(60000 * 2 ** (failStreak[m] - 1), 600000);
  cooldownUntil[m] = Date.now() + ms;
  return Math.round(ms / 1000);
}

// Passive calibration telemetry: whenever a model rules a candidate the heuristic
// was UNSURE about, append both verdicts to data/_calibration.jsonl. Costs nothing
// at runtime; over a few refreshes it shows exactly where the heuristic's rules
// disagree with the models — i.e. which rule to tighten or add next.
function logCalibration(candidate, h, v, model) {
  try {
    const fs = require("fs");
    const path = require("path");
    const line = JSON.stringify({
      t: new Date().toISOString().slice(0, 10),
      company: candidate.company, title: candidate.title,
      heuristic: { relevant: h.relevant, status: h.status },
      model: { relevant: v.relevant, status: v.status, by: model },
      agree: h.relevant === v.relevant && h.status === v.status,
    });
    fs.appendFileSync(path.join(__dirname, "..", "..", "data", "_calibration.jsonl"), line + "\n");
  } catch (_) { /* telemetry must never break a run */ }
}

// 45s/attempt: a healthy NIM model answers in 1-4s; anything past 45s is a congested
// queue that the failover chain + cooldowns handle better than waiting ever would.
async function judge(candidate, criteria, { timeoutMs = 45000 } = {}) {
  // TRIAGE: the deterministic in-app brain rules FIRST. When its evidence is explicit
  // (clear finance-in-title + apply-now/closed language, or no finance signal at all)
  // it decides outright and NO model is called — the AI handles only the genuinely
  // ambiguous tail. This cuts NIM traffic ~70-80%, which is also what keeps the
  // engine's own speed from 429-ing the rate windows.
  const h = require("./heuristic").judge(candidate, criteria);
  if (h.confidence === "high") return h;

  // Breaker (user rule): 3 consecutive full-chain AI failures anywhere → heuristic
  // rules everything, across all tabs and runs, until the breaker's TTL expires.
  const breaker = require("./breaker");
  if (breaker.isActive()) return h;

  const key = apiKey("NVIDIA_API_KEY");
  if (!key) {
    throw new Error(
      "NVIDIA_API_KEY not found in the environment or OneDrive\\Documents\\.env. " +
        "This is the FREE brain — set that key, or use --brain none (deterministic only)."
    );
  }
  // Only a REAL failure (429/5xx/bad response) counts as evidence the AI brain is
  // unavailable. A chain where every attempt merely timed out (congestion, not a
  // dead key/model) must NOT trip the breaker — see judge()'s call to recordFailure
  // below, gated on this flag.
  let hadRealFailure = false;
  for (const m of ORDER) {
    if (cooldownUntil[m] && Date.now() < cooldownUntil[m]) continue;
    for (let a = 0; a < 2; a++) {
      try {
        const j = await attempt(key, IDS[m], candidate, criteria, timeoutMs);
        const v = parseVerdict(j, m);
        failStreak[m] = 0; // healthy again — reset the escalation
        breaker.recordSuccess();
        logCalibration(candidate, h, v, m);
        return v;
      } catch (e) {
        if (!e.isTimeout) hadRealFailure = true;
        if (/429/.test(e.message || "")) {
          const s = coolOff(m);
          console.error(`  nim ${m} rate-limited — ${s}s cooldown, trying next model`);
          break; // next model, no pointless same-bucket retry
        }
        if (a === 0) { await sleep(3000); continue; } // timeout/5xx: one same-model retry
        // Both attempts failed — cool this model too, so the NEXT candidate doesn't
        // re-pay two timeouts proving the same dead model is dead.
        const s = coolOff(m);
        console.error(`  nim ${m} failed (${e.message || e.name}) — ${s}s cooldown, trying next model`);
      }
    }
  }
  console.error("  all NIM models unavailable — heuristic brain ruling (low confidence)");
  // Skip when every failure in the chain was just a timeout — that's congestion, not
  // proof the brain is down, and shouldn't cost the breaker one of its 3 strikes.
  if (hadRealFailure) breaker.recordFailure("NIM: all models unavailable");
  return h; // the triage ruling from the top — already computed, low-confidence
}

module.exports = { judge, MODEL };

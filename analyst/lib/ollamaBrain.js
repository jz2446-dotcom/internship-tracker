// ollamaBrain.js — a FREE, fully-offline brain, drop-in for lib/brain.js / lib/nimbrain.js.
// Calls a locally-running Ollama server (https://ollama.com) instead of a cloud API — no
// key, no internet dependency, but ALL 14 concurrent tabs share one local model instance,
// so it's slower under load than NIM's cloud models spread across separate rate buckets.
// Same judge() signature and return shape as nimbrain.js, so run-analyst.js can swap
// providers with --brain ollama.
//
// Model: OLLAMA_MODEL env var, default "llama3.1:8b" (whatever's already pulled locally —
// check with `ollama list`). Server: OLLAMA_HOST env var, default http://localhost:11434.
const { rawRequest } = require("./http"); // NOT fetch()/undici — see lib/http.js

const HOST = process.env.OLLAMA_HOST || "http://localhost:11434";
const SHORT = process.env.OLLAMA_MODEL || "llama3.1:8b";
const MODEL = "ollama:" + SHORT;
const TODAY = new Date().toISOString().slice(0, 10);

function extractJson(text) {
  if (!text) return null;
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
}

// Same prompt shape as nimbrain.js's prompt() — keeps judgments comparable across brains.
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

async function attempt(candidate, criteria, timeoutMs) {
  const res = await rawRequest(`${HOST}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: SHORT,
      messages: [{ role: "user", content: prompt(candidate, criteria) }],
      stream: false,
      options: { temperature: 0 },
    }),
    timeoutMs,
  });
  if (!res) throw new Error("ollama request failed");
  if (res.status < 200 || res.status >= 300) throw new Error(`ollama ${res.status}`);
  return JSON.parse(res.body);
}

function parseVerdict(j) {
  const content = (j.message && j.message.content && j.message.content.trim()) || "";
  const v = extractJson(content);
  if (!v) return { relevant: false, status: "program-page", class_years: [], location: "", notes: `${MODEL} unparseable`, confidence: "low" };
  return {
    relevant: !!v.relevant,
    status: ["open", "closed", "program-page"].includes(v.status) ? v.status : "program-page",
    class_years: Array.isArray(v.class_years) ? v.class_years.filter((y) => y === "2028" || y === "2029") : [],
    location: v.location || "",
    notes: v.notes || "",
    confidence: v.confidence || "low",
  };
}

// Passive calibration telemetry — same file/shape nimbrain.js writes to, so a refresh can
// mix brains across runs and still compare against the heuristic in one place.
function logCalibration(candidate, h, v) {
  try {
    const fs = require("fs");
    const path = require("path");
    const line = JSON.stringify({
      t: new Date().toISOString().slice(0, 10),
      company: candidate.company, title: candidate.title,
      heuristic: { relevant: h.relevant, status: h.status },
      model: { relevant: v.relevant, status: v.status, by: MODEL },
      agree: h.relevant === v.relevant && h.status === v.status,
    });
    fs.appendFileSync(path.join(__dirname, "..", "..", "data", "_calibration.jsonl"), line + "\n");
  } catch (_) { /* telemetry must never break a run */ }
}

// 60s/attempt: a local 8B model on CPU can take 10-30s/call even uncontended, and this
// engine runs up to 14 tabs concurrently against the SAME server — give it real room
// before falling back, rather than nimbrain's cloud-tuned 45s.
async function judge(candidate, criteria, { timeoutMs = 60000 } = {}) {
  // Same triage as nimbrain.js: the deterministic heuristic rules first on explicit
  // evidence; only the genuinely ambiguous tail reaches the model at all.
  const h = require("./heuristic").judge(candidate, criteria);
  if (h.confidence === "high") return h;

  const breaker = require("./breaker");
  if (breaker.isActive()) return h;

  try {
    const j = await attempt(candidate, criteria, timeoutMs);
    const v = parseVerdict(j);
    breaker.recordSuccess();
    logCalibration(candidate, h, v);
    return v;
  } catch (e) {
    console.error(`  ollama (${SHORT}) failed (${e.message || e.name}) — heuristic brain ruling (low confidence)`);
    breaker.recordFailure(`Ollama: ${e.message || e.name}`);
    return h; // the triage ruling from the top — already computed, low-confidence
  }
}

module.exports = { judge, MODEL };

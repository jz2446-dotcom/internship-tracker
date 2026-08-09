// brain.js — the "brain" of the analyst engine: Claude decides the questions
// deterministic code can't (relevance to the tab's focus, open/closed on prose-only
// pages, class-year eligibility from body text). This is the ONLY paid step; the
// engine hands it just the shortlist that classify.js couldn't settle for free.
//
// Model: defaults to claude-opus-4-8 (the project-wide default). Override with the
// ANALYST_BRAIN_MODEL env var — e.g. "claude-haiku-4-5" or "claude-sonnet-5" for a
// cheaper high-volume brain. For a fully free judge, run the engine with --brain nim
// (routes to scripts/nim/judge.js instead of this module).
//
// Auth (first match wins):
//   1. ANTHROPIC_API_KEY from the environment or OneDrive\Documents\.env  → x-api-key
//   2. a Claude login via the `ant` CLI (`ant auth print-credentials --access-token`)
//      → Authorization: Bearer + the oauth-2025-04-20 beta header. This lets the app
//      reuse an existing Claude Code / Console login instead of a separate paid key.
// Raw HTTPS via built-in fetch — matches the project's dependency-free style
// (scripts/nim/judge.js); no SDK install required.
const { spawnSync } = require("child_process");
const { apiKey } = require("./keyfile");
const { rawRequest } = require("./http"); // NOT fetch()/undici — see lib/http.js

// Resolve auth headers, or null if no credential is available.
function authHeaders() {
  const key = apiKey("ANTHROPIC_API_KEY");
  if (key) return { "x-api-key": key };
  // Fall back to an OAuth access token from the ant CLI, if installed + logged in.
  try {
    const r = spawnSync("ant", ["auth", "print-credentials", "--access-token"], {
      shell: true, encoding: "utf8", timeout: 15000,
    });
    const token = (r.stdout || "").trim();
    if (r.status === 0 && token && !/\s/.test(token)) {
      return { authorization: "Bearer " + token, "anthropic-beta": "oauth-2025-04-20" };
    }
  } catch (_) { /* ant not installed — fall through */ }
  return null;
}

const ENDPOINT = "https://api.anthropic.com/v1/messages";
const MODEL = process.env.ANALYST_BRAIN_MODEL || "claude-opus-4-8";
const TODAY = new Date().toISOString().slice(0, 10);

// Structured-output schema — forces clean, parseable JSON (no prose to strip).
const SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    relevant: { type: "boolean" },
    status: { type: "string", enum: ["open", "closed", "program-page"] },
    class_years: { type: "array", items: { type: "string", enum: ["2028", "2029"] } },
    location: { type: "string" },
    notes: { type: "string" },
    confidence: { type: "string", enum: ["high", "med", "low"] },
  },
  required: ["relevant", "status", "class_years", "location", "notes", "confidence"],
};

function prompt(candidate, criteria) {
  const text = (candidate.page_text || "").slice(0, 8000);
  return `Today is ${TODAY}. You are screening one job posting for an internship tracker.

TAB FOCUS (a role only counts if it fits this): ${criteria}

Company: ${candidate.company}
Posting title: ${candidate.title}
Apply URL: ${candidate.apply_url || "(none)"}

--- PAGE TEXT START ---
${text}
--- PAGE TEXT END ---

Decide, from the page text ONLY (no outside knowledge):
- relevant: true only if this posting genuinely fits the TAB FOCUS above. A general/back-office role at a firm that merely *has* the relevant function does NOT count.
- status: "open" = positive evidence it is accepting applications now (a live Apply, an application window covering today, or a stated future close date). "closed" = deadline passed / no longer accepting. "program-page" = described but not positively confirmed open (default when unsure — never guess open).
- class_years: which of ["2028","2029"] the posting is open to. Default ["2028","2029"] unless the text restricts eligibility (e.g. grad-only → []).
- location: short location string, or "" if unclear.
- notes: one short sentence (schedule, pay, or what makes it relevant).
- confidence: high | med | low.`;
}

async function judge(candidate, criteria, { timeoutMs = 60000 } = {}) {
  const auth = authHeaders();
  if (!auth) {
    throw new Error(
      "No Anthropic credential found. Either set ANTHROPIC_API_KEY (env or " +
        "OneDrive\\Documents\\.env), or install the `ant` CLI and run `ant auth login` " +
        "to reuse a Claude login. Or run the engine with --brain none (free, deterministic only)."
    );
  }
  const res = await rawRequest(ENDPOINT, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "anthropic-version": "2023-06-01",
      ...auth,
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 1024,
      output_config: { format: { type: "json_schema", schema: SCHEMA } },
      messages: [{ role: "user", content: prompt(candidate, criteria) }],
    }),
    timeoutMs,
  });
  if (!res) throw new Error("Anthropic request failed");
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`Anthropic ${res.status}: ${res.body.slice(0, 300)}`);
  }
  const data = JSON.parse(res.body);
  if (data.stop_reason === "refusal") {
    return { relevant: false, status: "program-page", class_years: [], location: "", notes: "brain refused", confidence: "low" };
  }
  const textBlock = (data.content || []).find((b) => b.type === "text");
  return JSON.parse(textBlock.text);
}

module.exports = { judge, MODEL };

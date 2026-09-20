// claudecli.js — Claude as a brain via the LOCAL `claude` CLI (subscription auth, no
// API key), drop-in for lib/nimbrain.js. The MCP connector can't do this (MCP's arrow
// points the other way — Claude calls the app, the app can't summon Claude), but the
// CLI can be spawned headlessly: `claude -p` judges one candidate and exits.
//
// USAGE COSTS SUBSCRIPTION QUOTA — which is why this is opt-in (--brain claude-cli,
// or RUNNER_BRAIN=claude-cli for the Tracker Runner app) and why the heuristic triage
// still runs first here exactly as it does for NIM: Claude only sees the ambiguous
// tail the deterministic brain couldn't decide (~10-30 candidates/tab, not hundreds).
// Model: haiku by default (fast + light on quota; the task is a constrained JSON
// screening call). Override with ANALYST_CLAUDE_CLI_MODEL.
const { spawn } = require("child_process");

const MODEL_ID = process.env.ANALYST_CLAUDE_CLI_MODEL || "haiku";
const MODEL = "claude-cli:" + MODEL_ID;
const TODAY = new Date().toISOString().slice(0, 10);

function extractJson(text) {
  if (!text) return null;
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
}

function prompt(candidate, criteria) {
  const text = (candidate.page_text || "").slice(0, 8000);
  return `Today is ${TODAY}. Screen ONE job posting for an internship tracker, using the page text ONLY (no outside knowledge, no tools).

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

// One headless CLI call. The prompt goes via STDIN (Windows argv length limits make
// an 8KB prompt as an argument fragile). shell:true resolves the npm .cmd shim.
function runClaude(text, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(`claude -p --output-format text --model ${MODEL_ID}`, {
      shell: true, windowsHide: true,
      env: { ...process.env, CLAUDECODE: "" }, // don't inherit nested-session markers
    });
    let out = "", err = "";
    const timer = setTimeout(() => {
      try { child.kill(); } catch (_) {}
      const e = new Error("claude-cli timeout");
      e.isTimeout = true; // slow/congested run, not proof the CLI/quota is dead — see judge()
      reject(e);
    }, timeoutMs);
    child.stdout.on("data", (d) => (out += d.toString()));
    child.stderr.on("data", (d) => (err += d.toString()));
    child.on("error", (e) => { clearTimeout(timer); reject(e); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(new Error(`claude-cli exit ${code}: ${err.slice(0, 200)}`));
    });
    child.stdin.write(text);
    child.stdin.end();
  });
}

async function judge(candidate, criteria, { timeoutMs = 120000 } = {}) {
  // Same triage as nimbrain: the deterministic brain rules explicit cases for free;
  // Claude (and your quota) only sees what it couldn't decide.
  const h = require("./heuristic").judge(candidate, criteria);
  if (h.confidence === "high") return h;

  // Same breaker rule as the NIM brain: 3 consecutive AI failures → heuristic-only.
  const breaker = require("./breaker");
  if (breaker.isActive()) return h;

  let out;
  try {
    out = await runClaude(prompt(candidate, criteria), timeoutMs);
    breaker.recordSuccess();
  } catch (e) {
    console.error(`  claude-cli failed (${e.message}) — heuristic fallback`);
    // A timeout is congestion/slowness, not evidence the CLI/subscription is dead —
    // don't spend one of the breaker's 3 strikes on it.
    if (!e.isTimeout) breaker.recordFailure("claude-cli: " + (e.message || "").slice(0, 60));
    return h;
  }
  const v = extractJson(out);
  if (!v) return { ...h, notes: "claude-cli: unparseable — heuristic fallback" };
  return {
    relevant: !!v.relevant,
    status: ["open", "closed", "program-page"].includes(v.status) ? v.status : "program-page",
    class_years: Array.isArray(v.class_years) ? v.class_years.filter((y) => y === "2028" || y === "2029") : [],
    location: v.location || "",
    notes: v.notes || "",
    confidence: v.confidence || "low",
  };
}

module.exports = { judge, MODEL };

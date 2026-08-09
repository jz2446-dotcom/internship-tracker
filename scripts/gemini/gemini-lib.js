// gemini-lib.js — thin wrapper around the Gemini CLI for the tracker dual-pass.
// Exposes runGemini(prompt, opts) -> { ok, text, quotaDead, raw, error }
// Design notes:
//  - Prompt is passed via STDIN (not -p) to avoid Windows arg-length/quoting limits.
//  - Grounded web search is what burns the scarce free-tier quota; plain generation
//    has a much larger allowance. `search:true` just phrases the prompt to use Google
//    Search — the CLI decides to call its web_search tool from the prompt.
//  - 429 / RESOURCE_EXHAUSTED is detected so callers can stop the grounded pass and
//    fall back to judge-mode (Claude fetches page text, Gemini rules from that text).
const { spawnSync } = require("child_process");

const NOISE = /true color|Ripgrep is not available|Falling back to GrepTool|Loaded cached|Warning:/i;

function runGemini(prompt, opts = {}) {
  const model = opts.model || "gemini-2.5-flash";
  const timeoutMs = opts.timeoutMs || 120000;
  const args = ["-m", model];
  const res = spawnSync("gemini", args, {
    input: prompt,
    shell: true,
    encoding: "utf8",
    timeout: timeoutMs,
    env: { ...process.env, GEMINI_CLI_TRUST_WORKSPACE: "true" },
    maxBuffer: 1024 * 1024 * 32,
  });
  const raw = (res.stdout || "") + (res.stderr ? "\n" + res.stderr : "");
  const quotaDead = /429|RESOURCE_EXHAUSTED|exceeded your current quota/i.test(raw);
  if (res.error) {
    return { ok: false, text: "", quotaDead, raw, error: String(res.error) };
  }
  // Strip the CLI's cosmetic warning lines; keep the model's actual answer.
  const text = raw
    .split(/\r?\n/)
    .filter((l) => !NOISE.test(l))
    .join("\n")
    .trim();
  return { ok: !quotaDead && text.length > 0, text, quotaDead, raw, error: null };
}

// Pull the first JSON array or object out of a model response (handles ```json fences).
function extractJson(text) {
  if (!text) return null;
  let t = text.replace(/```json/gi, "```").trim();
  const fence = t.match(/```\s*([\s\S]*?)```/);
  if (fence) t = fence[1].trim();
  // find first [ or { and matching close
  const start = t.search(/[\[{]/);
  if (start === -1) return null;
  const open = t[start];
  const close = open === "[" ? "]" : "}";
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < t.length; i++) {
    const c = t[i];
    if (esc) { esc = false; continue; }
    if (c === "\\") { esc = true; continue; }
    if (c === '"') inStr = !inStr;
    if (inStr) continue;
    if (c === open) depth++;
    else if (c === close) { depth--; if (depth === 0) {
      const slice = t.slice(start, i + 1);
      try { return JSON.parse(slice); } catch (e) { return null; }
    }}
  }
  return null;
}

module.exports = { runGemini, extractJson };

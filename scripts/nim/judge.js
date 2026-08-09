// judge.js (NIM) — independent second opinion on open/closed, mirroring gemini/judge.js.
// Claude does the WebFetch (grounding) and writes each posting's page text into an
// input file; three NVIDIA NIM models (deepseek, llama, openai) each RULE on
// open/closed from that text ONLY. We then take a majority consensus.
//
// This is a SECOND OPINION, never an authority — Opus (Step 5) makes the final
// open/closed call. NIM only raises/lowers confidence and flags disagreements.
// Unlike Gemini it has no shared grounded-search quota, so it always runs.
//
// Input JSON:  [{"id":"blackrock","company":"...","program":"...","apply_url":"...","page_text":"<innerText>"}]
// Output JSON: [{"id":...,"deepseek_status":...,"llama_status":...,"openai_status":...,
//               "nim_consensus":"open|closed|program-page|split","confidence":"high|med|low","reasons":{...}}]
//
// Usage: node judge.js <in.json> <out.json>
// Key:   NVIDIA_API_KEY from the environment, else from OneDrive\Documents\.env
const fs = require("fs");
const path = require("path");

const BASE = "https://integrate.api.nvidia.com/v1/chat/completions";
const MODELS = {
  deepseek: "deepseek-ai/deepseek-v4-pro",
  llama:    "meta/llama-3.3-70b-instruct",
  openai:   "openai/gpt-oss-120b",
};
const ENV_FILE = "C:\\Users\\justi\\OneDrive\\Documents\\.env";
const TODAY = new Date().toISOString().slice(0, 10);

function apiKey() {
  if (process.env.NVIDIA_API_KEY) return process.env.NVIDIA_API_KEY.trim();
  const line = fs.readFileSync(ENV_FILE, "utf8").split(/\r?\n/).find(l => l.startsWith("NVIDIA_API_KEY="));
  if (!line) throw new Error("NVIDIA_API_KEY not in env or " + ENV_FILE);
  return line.split("=").slice(1).join("=").trim();
}

function extractJson(text) {
  if (!text) return null;
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
}

function prompt(it) {
  const text = (it.page_text || "").slice(0, 8000);
  return `Today is ${TODAY}. Decide whether this internship application is CURRENTLY OPEN, based ONLY on the page text provided. Do not use outside knowledge.

Company: ${it.company}
Program: ${it.program}
URL: ${it.apply_url || "(none)"}

--- PAGE TEXT START ---
${text}
--- PAGE TEXT END ---

Rules:
- "open" = the text gives positive evidence the application is accepting submissions now (a live Apply action, an application window covering today, or a stated future close/deadline date). Quote the exact evidence.
- "closed" = the text says applications closed / deadline passed / no longer accepting.
- "program-page" = a program is described but the text does NOT positively confirm it is accepting applications right now (default when unsure — never guess open).

Return ONLY JSON: {"status":"open|closed|program-page","confidence":"high|med|low","reason":"one sentence","quote":"exact snippet or empty"}`;
}

async function callModel(key, modelId, userPrompt) {
  const body = {
    model: modelId,
    messages: [{ role: "user", content: userPrompt }],
    max_tokens: 800,          // openai/gpt-oss is a reasoning model — needs room
    temperature: 0,
  };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 120000);
  try {
    const res = await fetch(BASE, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!res.ok) return { status: "error", reason: `http_${res.status}` };
    const j = await res.json();
    const msg = j.choices?.[0]?.message || {};
    const content = (msg.content && msg.content.trim()) || msg.reasoning_content || "";
    const v = extractJson(content) || {};
    return {
      status: v.status || "unknown",
      confidence: v.confidence || "low",
      reason: v.reason || "",
      quote: v.quote || "",
    };
  } catch (e) {
    return { status: "error", reason: e.name === "AbortError" ? "timeout" : String(e.message || e) };
  } finally {
    clearTimeout(timer);
  }
}

function consensus(statuses) {
  // statuses: array of "open|closed|program-page|error|unknown"
  const votes = statuses.filter(s => ["open", "closed", "program-page"].includes(s));
  if (votes.length === 0) return { nim_consensus: "error", confidence: "low" };
  const tally = {};
  for (const s of votes) tally[s] = (tally[s] || 0) + 1;
  const top = Object.entries(tally).sort((a, b) => b[1] - a[1]);
  if (top.length > 1 && top[0][1] === top[1][1]) return { nim_consensus: "split", confidence: "low" };
  const winner = top[0][0], n = top[0][1];
  const conf = n === 3 ? "high" : n === 2 ? "med" : "low";
  return { nim_consensus: winner, confidence: conf };
}

(async () => {
  const [, , inPath, outPath] = process.argv;
  if (!inPath || !outPath) { console.error("usage: node judge.js <in.json> <out.json>"); process.exit(1); }
  const key = apiKey();
  const items = JSON.parse(fs.readFileSync(inPath, "utf8"));
  const out = [];
  for (const it of items) {
    process.stdout.write(`judge ${it.id || it.company} ... `);
    const p = prompt(it);
    const [ds, lm, oa] = await Promise.all([
      callModel(key, MODELS.deepseek, p),
      callModel(key, MODELS.llama, p),
      callModel(key, MODELS.openai, p),
    ]);
    const c = consensus([ds.status, lm.status, oa.status]);
    out.push({
      id: it.id, company: it.company, program: it.program,
      deepseek_status: ds.status, llama_status: lm.status, openai_status: oa.status,
      nim_consensus: c.nim_consensus, confidence: c.confidence,
      reasons: { deepseek: ds.reason, llama: lm.reason, openai: oa.reason },
      quotes: { deepseek: ds.quote, llama: lm.quote, openai: oa.quote },
    });
    // incremental checkpoint (background jobs can be killed by usage limits)
    fs.writeFileSync(outPath, JSON.stringify(out, null, 1));
    console.log(`${c.nim_consensus} (ds=${ds.status} lm=${lm.status} oa=${oa.status})`);
  }
  const splits = out.filter(o => o.nim_consensus === "split").length;
  console.log(`\nJudged ${out.length} items — ${splits} split (send those to the front of Opus's queue).`);
})();

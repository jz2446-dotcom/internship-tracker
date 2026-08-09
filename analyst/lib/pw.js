// pw.js — thin driver around the `playwright-cli` binary (the zero-token browser
// engine). Each call is a separate process; a named session keeps one browser warm
// across calls. Snapshots land in `cwd/.playwright-cli`, so we run from a scratch
// dir instead of littering the project root.
const { spawnSync } = require("child_process");
const path = require("path");
const fs = require("fs");

const SCRATCH = path.join(__dirname, "..", ".pw-scratch");
try { fs.mkdirSync(SCRATCH, { recursive: true }); } catch (_) {}

// On Windows the binary is playwright-cli.cmd on PATH; spawnSync with shell:true
// resolves it either way.
function run(session, args, { timeout = 60000 } = {}) {
  const full = ["-s=" + session, ...args];
  const r = spawnSync("playwright-cli", full, {
    cwd: SCRATCH,
    shell: true,
    timeout,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  return { code: r.status, out: (r.stdout || "").trim(), err: (r.stderr || "").trim() };
}

// ANALYST_HEADED=1 pops a real, visible browser window instead of running headless —
// so you can literally watch the browser-fallback pass navigate career pages.
const HEADED = process.env.ANALYST_HEADED === "1" ? ["--headed"] : [];

function open(session, url) { return run(session, ["open", url, "--json", ...HEADED]); }
function openBlank(session) { return run(session, ["open", "--json", ...HEADED]); }
function goto(session, url) { return run(session, ["goto", url, "--json"]); }
function close(session) { return run(session, ["close"]); }

// Evaluate a page-context function and parse its JSON result. We route through
// `run-code --filename` (loads the code from a file) rather than `eval "<js>"` on the
// command line, because spawn with shell:true concatenates args UNQUOTED — any JS with
// spaces/quotes/parens gets mangled by the shell. Writing the code to a file sidesteps
// quoting entirely. Returns null on any failure so callers can fall through gracefully.
let evalSeq = 0;
function evalJson(session, fnStr) {
  // Use a SPACE-FREE basename and rely on cwd=SCRATCH: the scratch path itself
  // contains spaces, and shell:true would split an unquoted absolute path.
  const name = `_eval_${process.pid}_${evalSeq++}.js`;
  const file = path.join(SCRATCH, name);
  // Pass fnStr as a REAL function to page.evaluate (not a string) — the proven form.
  fs.writeFileSync(file, `async (page) => { return await page.evaluate(${fnStr}); }`);
  try {
    const r = run(session, ["run-code", "--filename", name, "--raw"]);
    if (r.code !== 0 || !r.out) return null;
    try { return JSON.parse(r.out); } catch (_) { return null; }
  } finally {
    try { fs.unlinkSync(file); } catch (_) {}
  }
}

module.exports = { run, open, openBlank, goto, close, evalJson, SCRATCH };

#!/usr/bin/env node
// server.js — MCP server wrapping the tracker's analyst engine. Exposes the pipeline
// (roster -> free ATS/browser research -> shortlist -> Claude verdicts -> merge -> deploy)
// as tool calls, so a Claude Code session can drive the whole /refresh-tracker research
// step itself instead of fanning out research subagents per tab.
//
// Design: high-level actions, not raw scraping primitives (per user's stated preference).
// The calling Claude session is the "brain" — get_shortlist returns structured candidates
// (with NIM's backup verdict already attached) for Claude to reason over directly and rule
// on via submit_verdicts, mirroring the existing `new-refresh` skill's manual choreography.
const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const { StdioServerTransport } = require("@modelcontextprotocol/sdk/server/stdio.js");
const { z } = require("zod");
const { spawnSync, spawn } = require("child_process");
const fs = require("fs");
const path = require("path");

const LOG_DIR = path.join(__dirname, "..", "..", "data");
function logPath(agentName) { return path.join(LOG_DIR, `${agentName}_sweep.log`); }

// Runs a command with output streamed LIVE to <agentName>_sweep.log (truncated first),
// not just captured at the end — so a caller tailing that file (e.g. the control panel's
// bridge, or a human with `tail -f`) sees progress in real time while the tool call is
// still in flight, exactly like watching the CLI run directly, but genuinely routed
// through this MCP server rather than shelled ad hoc.
function spawnWithLiveLog(cmd, args, opts, agentName) {
  return new Promise((resolve) => {
    const lp = logPath(agentName);
    fs.writeFileSync(lp, `$ ${cmd} ${args.join(" ")}\n\n`);
    const child = spawn(cmd, args, { ...opts, encoding: "utf8" });
    let stderr = "";
    child.stdout.on("data", (d) => fs.appendFileSync(lp, d.toString()));
    child.stderr.on("data", (d) => { stderr += d.toString(); fs.appendFileSync(lp, d.toString()); });
    child.on("error", (err) => resolve({ status: -1, stderr: stderr + `\n[spawn error] ${err.message}` }));
    child.on("close", (code) => resolve({ status: code, stderr }));
  });
}

const ANALYST_DIR = path.join(__dirname, "..");
const DATA_DIR = path.join(ANALYST_DIR, "..", "data");
const WORKER_DIR = path.join(ANALYST_DIR, "..", "cloudflare-worker");
const tabRegistry = require("../lib/tab-registry");

function readJson(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch (_) { return fallback; }
}

function paths(agentName) {
  return {
    partial: path.join(DATA_DIR, `${agentName}_results.partial.json`),
    shortlist: path.join(DATA_DIR, `${agentName}_shortlist.json`),
    verdicts: path.join(DATA_DIR, `${agentName}_verdicts.json`),
    results: path.join(DATA_DIR, `${agentName}_results.json`),
  };
}

const server = new McpServer({ name: "tracker-analyst", version: "1.0.0" });

server.registerTool(
  "list_tabs",
  {
    title: "List refresh-tracker tabs",
    description: "Returns every tab the analyst engine can research (id, label, roster file, term if any) — call this first to see valid `tab` values for the other tools.",
    inputSchema: {},
  },
  async () => ({ content: [{ type: "text", text: JSON.stringify(tabRegistry.list(), null, 2) }] })
);

server.registerTool(
  "get_roster",
  {
    title: "Get a tab's roster",
    description: "Returns the normalized company roster for one tab (name, description, groups, per-group and total company counts) — regardless of which of the tracker's 3 roster file shapes it's stored in.",
    inputSchema: { tab: z.string().describe("Tab id from list_tabs, e.g. 'environmental', 'agent2', 'ithaca'") },
  },
  async ({ tab }) => {
    const cfg = tabRegistry.get(tab);
    const rosterAdapter = require("../lib/roster-adapter");
    const roster = rosterAdapter.loadRoster(cfg.rosterPath, { agentKey: cfg.agentKey, allAgents: cfg.allAgents });
    const counts = Object.fromEntries(Object.entries(roster.groups).map(([g, c]) => [g, c.length]));
    const total = Object.values(roster.groups).flat().length;
    return { content: [{ type: "text", text: JSON.stringify({ name: roster.name, description: roster.description, groupCounts: counts, totalCompanies: total, groups: roster.groups }, null, 2) }] };
  }
);

server.registerTool(
  "run_full_sweep",
  {
    title: "Run the analyst engine's free research pass on a tab",
    description:
      "Spawns run-analyst.js in --brain defer mode for one tab: resolves each firm's ATS board or careers page for FREE, title-gates postings, and writes <agent>_results.partial.json (free-decided) + <agent>_shortlist.json (ambiguous candidates, each already carrying NIM's backup verdict + page text). Nothing is final yet — call get_shortlist next to judge the ambiguous pile yourself, then submit_verdicts + apply_verdicts to merge. Can take several minutes for a large roster (browser fallback pass is slow); pass limit for a quick smoke test.",
    inputSchema: {
      tab: z.string().describe("Tab id from list_tabs"),
      limit: z.number().int().optional().describe("Only process the first N firms (smoke test)"),
      noBrowse: z.boolean().optional().describe("Skip the Playwright browser fallback (ATS-JSON only, much faster, lower coverage)"),
      noNim: z.boolean().optional().describe("Skip NIM's in-process backup verdict on shortlist candidates (NIM is on by default)"),
      timeoutMs: z.number().int().optional().describe("Max time to let the sweep run before giving up (default 20 minutes)"),
    },
  },
  async ({ tab, limit, noBrowse, noNim, timeoutMs }) => {
    const cfg = tabRegistry.get(tab);
    const args = ["run-analyst.js", "--roster", cfg.rosterPath, "--agent-name", cfg.agentName, "--brain", "defer"];
    if (cfg.agentKey) args.push("--agent-key", cfg.agentKey);
    if (cfg.allAgents) args.push("--all-agents");
    if (cfg.tab) args.push("--tab", cfg.tab);
    if (cfg.term) args.push("--term", cfg.term);
    if (limit) args.push("--limit", String(limit));
    if (noBrowse) args.push("--no-browse");
    if (noNim) args.push("--no-nim");

    // Live log at data/<agentName>_sweep.log — tail it (e.g. the control panel's
    // cli-bridge.js) to watch this sweep progress in real time while this call is
    // still pending; the tool itself only resolves once the process exits.
    const r = await spawnWithLiveLog("node", args, { cwd: ANALYST_DIR, timeout: timeoutMs || 20 * 60 * 1000 }, cfg.agentName);
    const p = paths(cfg.agentName);
    const shortlistCount = readJson(p.shortlist, { shortlist: [] }).shortlist.length;
    const partialCount = readJson(p.partial, { internships: [] }).internships.length;
    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          tab, agentName: cfg.agentName, exitCode: r.status,
          freeDecided: partialCount, shortlistSize: shortlistCount,
          partialFile: p.partial, shortlistFile: p.shortlist, logFile: logPath(cfg.agentName),
          stderrTail: (r.stderr || "").split("\n").slice(-15).join("\n"),
        }, null, 2),
      }],
    };
  }
);

server.registerTool(
  "get_shortlist",
  {
    title: "Get a tab's ambiguous-candidate shortlist",
    description:
      "Returns the shortlist run_full_sweep queued for this tab: each item has company, title, apply_url, location, page_text (truncated), and NIM's backup verdict already attached. Judge each one yourself (relevant / status / class_years / location / notes), then call submit_verdicts with your rulings — you are the primary brain; NIM's verdict is a second opinion to weigh, not a rubber stamp.",
    inputSchema: { tab: z.string().describe("Tab id from list_tabs") },
  },
  async ({ tab }) => {
    const cfg = tabRegistry.get(tab);
    const p = paths(cfg.agentName);
    const short = readJson(p.shortlist, null);
    if (!short) return { content: [{ type: "text", text: `No shortlist found at ${p.shortlist} — run run_full_sweep for tab "${tab}" first.` }], isError: true };
    // Trim page_text for payload sanity; full text was already capped at 8000 chars on write.
    const trimmed = { ...short, shortlist: short.shortlist.map((s) => ({ ...s, page_text: (s.page_text || "").slice(0, 3000) })) };
    return { content: [{ type: "text", text: JSON.stringify(trimmed, null, 2) }] };
  }
);

server.registerTool(
  "submit_verdicts",
  {
    title: "Submit your verdicts on a tab's shortlist",
    description:
      "Writes your rulings for a tab's shortlist to <agent>_verdicts.json. Each verdict must include company + title (exact match to the shortlist item, used as the merge key) plus relevant (bool), status ('open'|'closed'|'program-page'), class_years (subset of ['2028','2029']), location, notes. Omit an item entirely to defer to NIM's backup verdict instead of inventing a ruling. Call apply_verdicts next to merge everything into the final results file.",
    inputSchema: {
      tab: z.string().describe("Tab id from list_tabs"),
      verdicts: z.array(z.object({
        company: z.string(),
        title: z.string(),
        relevant: z.boolean(),
        status: z.enum(["open", "closed", "program-page"]).optional(),
        class_years: z.array(z.string()).optional(),
        location: z.string().optional(),
        notes: z.string().optional(),
      })).describe("Your verdicts, one per shortlist item you're ruling on"),
    },
  },
  async ({ tab, verdicts }) => {
    const cfg = tabRegistry.get(tab);
    const p = paths(cfg.agentName);
    fs.writeFileSync(p.verdicts, JSON.stringify({ verdicts }, null, 2));
    return { content: [{ type: "text", text: JSON.stringify({ written: p.verdicts, count: verdicts.length }, null, 2) }] };
  }
);

server.registerTool(
  "apply_verdicts",
  {
    title: "Merge free results + shortlist + verdicts into the final tab results",
    description:
      "Runs apply-verdicts.js for one tab: merges <agent>_results.partial.json (free-decided) with your submitted verdicts (falling back to NIM's backup verdict for anything you didn't rule on) into the final <agent>_results.json in the tracker's standard schema. Call this after get_shortlist + submit_verdicts.",
    inputSchema: { tab: z.string().describe("Tab id from list_tabs") },
  },
  async ({ tab }) => {
    const cfg = tabRegistry.get(tab);
    const r = spawnSync("node", ["apply-verdicts.js", "--agent", cfg.agentName, "--dir", DATA_DIR], { cwd: ANALYST_DIR, encoding: "utf8", timeout: 60000 });
    const p = paths(cfg.agentName);
    const final = readJson(p.results, { internships: [] });
    return {
      content: [{
        type: "text",
        text: JSON.stringify({ tab, agentName: cfg.agentName, exitCode: r.status, finalCount: final.internships.length, resultsFile: p.results, log: (r.stderr || "").trim() }, null, 2),
      }],
    };
  }
);

server.registerTool(
  "merge_agent_files",
  {
    title: "Merge multiple analyst-engine output files into one tab's final results",
    description:
      "For tabs the engine researches in more than one pass (e.g. fall2026's fall + spring terms run as separate agentNames), merges their <agentName>_results.json internships arrays (deduped on company::program::term) into one output file with the tracker's standard top-level shape.",
    inputSchema: {
      sourceAgentNames: z.array(z.string()).describe("agentName values whose _results.json files should be merged, e.g. ['fall2026_fall','fall2026_spring']"),
      outAgentName: z.string().describe("agent field + filename base for the merged output, e.g. 'fall2026'"),
      name: z.string().optional(),
      focus: z.string().optional(),
    },
  },
  async ({ sourceAgentNames, outAgentName, name, focus }) => {
    const seen = new Set();
    const internships = [];
    let meta = { name: name || outAgentName, focus: focus || "" };
    for (const a of sourceAgentNames) {
      const d = readJson(path.join(DATA_DIR, `${a}_results.json`), null);
      if (!d) continue;
      if (!name) meta.name = d.name || meta.name;
      if (!focus) meta.focus = d.focus || meta.focus;
      for (const e of d.internships || []) {
        const k = `${(e.company || "").toLowerCase()}::${(e.program || "").toLowerCase()}::${e.term || ""}`;
        if (seen.has(k)) continue;
        seen.add(k);
        internships.push(e);
      }
    }
    const out = path.join(DATA_DIR, `${outAgentName}_results.json`);
    fs.writeFileSync(out, JSON.stringify({ agent: outAgentName, name: meta.name, focus: meta.focus, last_updated: new Date().toISOString().slice(0, 10), internships }, null, 2));
    return { content: [{ type: "text", text: JSON.stringify({ written: out, mergedFrom: sourceAgentNames, totalCount: internships.length }, null, 2) }] };
  }
);

server.registerTool(
  "build_and_deploy",
  {
    title: "Rebuild the bundled dataset and deploy the Worker",
    description:
      "Fetches the live /api/data as the diff baseline, runs build-data.js (auto-generates the changelog entry), then wrangler deploy. Run this after all tabs' apply_verdicts calls are done for this refresh.",
    inputSchema: { skipDeploy: z.boolean().optional().describe("Only rebuild src/data.json, don't run wrangler deploy (for dry-run/inspection)") },
  },
  async ({ skipDeploy }) => {
    const curl = spawnSync("curl", ["-s", "https://internship-tracker.jz-tracker.workers.dev/api/data", "-o", path.join(WORKER_DIR, "src", "data.json")], { encoding: "utf8", timeout: 30000 });
    const build = spawnSync("node", ["build-data.js"], { cwd: WORKER_DIR, encoding: "utf8", timeout: 60000 });
    let deploy = null;
    if (!skipDeploy) {
      deploy = spawnSync("wrangler", ["deploy"], { cwd: WORKER_DIR, encoding: "utf8", timeout: 120000, shell: true });
    }
    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          curlExit: curl.status,
          buildExit: build.status, buildLog: (build.stderr || build.stdout || "").trim(),
          deployExit: deploy ? deploy.status : null, deployLog: deploy ? (deploy.stdout || deploy.stderr || "").trim() : "(skipped)",
        }, null, 2),
      }],
    };
  }
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("tracker-analyst MCP server running on stdio");
}

main().catch((e) => { console.error(e); process.exit(1); });

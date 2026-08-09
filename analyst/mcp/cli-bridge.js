#!/usr/bin/env node
// cli-bridge.js — a genuine MCP CLIENT for the tracker-analyst server, meant to be run
// as a normal child process (so the Electron control panel, or anything else that just
// wants to spawn+stream a command, can delegate through the actual MCP connector instead
// of shelling out to run-analyst.js directly).
//
// Usage:
//   node cli-bridge.js <toolName> [--key value ...] [--flag]
//   node cli-bridge.js run_full_sweep --tab agent1 --limit 5 --noBrowse
//   node cli-bridge.js list_tabs
//
// While a tool call that writes a live log (currently: run_full_sweep, which streams to
// data/<agentName>_sweep.log) is in flight, this bridge tails that file and relays new
// lines to its own stdout in real time — so a caller streaming THIS process's stdout
// (like the control panel already does for run-analyst.js) sees live progress exactly as
// before, except the work now genuinely goes through the tracker-analyst MCP server.
const path = require("path");
const fs = require("fs");
const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { StdioClientTransport } = require("@modelcontextprotocol/sdk/client/stdio.js");
const tabRegistry = require("../lib/tab-registry");

const argv = process.argv.slice(2);
const toolName = argv[0];
if (!toolName) {
  console.error("Usage: node cli-bridge.js <toolName> [--key value ...] [--flag]");
  process.exit(2);
}

// Parse --key value / --flag pairs into a tool-args object. Numeric-looking values
// become numbers; bare --flags become true. Good enough for this server's tool schemas.
const args = {};
for (let i = 1; i < argv.length; i++) {
  if (!argv[i].startsWith("--")) continue;
  const key = argv[i].slice(2);
  const next = argv[i + 1];
  if (next === undefined || next.startsWith("--")) { args[key] = true; continue; }
  args[key] = /^-?\d+$/.test(next) ? parseInt(next, 10) : next;
  i++;
}

function logPathFor(agentName) {
  return path.join(__dirname, "..", "..", "data", `${agentName}_sweep.log`);
}

function tailLog(filePath) {
  let pos = 0;
  let timer = null;
  const poll = () => {
    try {
      const stat = fs.statSync(filePath);
      if (stat.size > pos) {
        const fd = fs.openSync(filePath, "r");
        const buf = Buffer.alloc(stat.size - pos);
        fs.readSync(fd, buf, 0, buf.length, pos);
        fs.closeSync(fd);
        process.stdout.write(buf.toString("utf8"));
        pos = stat.size;
      }
    } catch (_) { /* file not written yet */ }
    timer = setTimeout(poll, 400);
  };
  poll();
  return () => { if (timer) clearTimeout(timer); };
}

async function main() {
  const client = new Client({ name: "control-panel-bridge", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: "node",
    args: [path.join(__dirname, "server.js")],
  });
  await client.connect(transport);

  // If this call is going to produce a live log (run_full_sweep, keyed by tab -> agentName),
  // start tailing it now so progress streams to our own stdout while the call is pending.
  let stopTail = null;
  if (toolName === "run_full_sweep" && args.tab) {
    try {
      const cfg = tabRegistry.get(args.tab);
      const lp = logPathFor(cfg.agentName);
      console.error(`[cli-bridge] delegating to tracker-analyst MCP server — tool: ${toolName}, tab: ${args.tab}`);
      console.error(`[cli-bridge] tailing live log: ${lp}\n`);
      stopTail = tailLog(lp);
    } catch (e) {
      console.error(`[cli-bridge] couldn't resolve log path for tab "${args.tab}": ${e.message}`);
    }
  } else {
    console.error(`[cli-bridge] delegating to tracker-analyst MCP server — tool: ${toolName}, args: ${JSON.stringify(args)}\n`);
  }

  try {
    const result = await client.callTool({ name: toolName, arguments: args });
    if (stopTail) { await new Promise((r) => setTimeout(r, 500)); stopTail(); } // drain any trailing bytes
    console.log("\n[cli-bridge] final result:");
    for (const block of result.content || []) {
      if (block.type === "text") console.log(block.text);
    }
    if (result.isError) process.exitCode = 1;
  } catch (e) {
    if (stopTail) stopTail();
    console.error(`[cli-bridge] tool call failed: ${e.message}`);
    process.exitCode = 1;
  } finally {
    await client.close();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });

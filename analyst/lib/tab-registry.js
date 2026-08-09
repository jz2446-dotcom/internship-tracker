// tab-registry.js — maps each of the tracker's 13 tabs to the run-analyst.js invocation
// that researches it (which roster file, which roster-adapter mode, which tab profile,
// which output agent name). Single source of truth for both the CLI and the MCP server
// so the two never drift on "which flags does tab X need".
const path = require("path");
const DATA_DIR = path.join(__dirname, "..", "..", "data");

const TABS = {
  agent1: { roster: "roster.json", agentKey: "1", tab: "agent1", agentName: "agent1", label: "Agent 1 — Elite Investing" },
  agent2: { roster: "roster.json", agentKey: "2", tab: "agent2", agentName: "agent2", label: "Agent 2 — Middle Market & International" },
  agent3: { roster: "roster.json", agentKey: "3", tab: "agent3", agentName: "agent3", label: "Agent 3 — Big Tech Corporate Finance" },
  agent4: { roster: "roster.json", agentKey: "4", tab: "agent4", agentName: "agent4", label: "Agent 4 — Consulting & Top F500" },
  agent5: { roster: "roster.json", agentKey: "5", tab: "agent5", agentName: "agent5", label: "Agent 5 — Other F500" },
  sophomore: { roster: "roster.json", allAgents: true, tab: "sophomore", agentName: "sophomore", label: "Sophomore Internships" },
  fall2026: { roster: "roster.json", allAgents: true, tab: "fall2026", agentName: "fall2026_fall", term: "fall2026", label: "Fall 2026 / Spring 2027 (fall term)" },
  spring2027: { roster: "roster.json", allAgents: true, tab: "fall2026", agentName: "fall2026_spring", term: "spring2027", label: "Fall 2026 / Spring 2027 (spring term)" },
  libraries: { roster: "libraries_roster.json", tab: "libraries", agentName: "libraries", label: "Libraries & Museums" },
  environmental: { roster: "environmental_roster.json", tab: "environmental", agentName: "environmental", label: "Environmental Impact Finance" },
  realestate: { roster: "realestate_roster.json", tab: "realestate", agentName: "realestate", label: "Real Estate Finance" },
  fellowships: { roster: "roster.json", allAgents: true, tab: "fellowships", agentName: "fellowships", label: "Fellowships (internal fellowship-branded tracks only — named external programs need separate handling, see README)" },
  china_hk: { roster: "roster.json", allAgents: true, tab: "china_hk", agentName: "china_hk", label: "China / Hong Kong" },
  ithaca: { roster: "ithaca_roster.json", tab: "ithaca", agentName: "ithaca", label: "Ithaca, NY Local" },
};

function get(tabId) {
  const cfg = TABS[tabId];
  if (!cfg) throw new Error(`Unknown tab "${tabId}" — known tabs: ${Object.keys(TABS).join(", ")}`);
  return { ...cfg, rosterPath: path.join(DATA_DIR, cfg.roster) };
}

function list() {
  return Object.entries(TABS).map(([id, cfg]) => ({ id, label: cfg.label, roster: cfg.roster, term: cfg.term || null }));
}

module.exports = { get, list, DATA_DIR, TABS };

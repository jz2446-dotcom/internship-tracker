// roster-adapter.js — normalizes the tracker's several roster JSON shapes into one
// shape run-analyst.js understands: { name, description, groups: { groupName: [company, ...] } }.
//
// Shapes seen in the wild:
//   1. { name, description, groups: {...} }        — environmental/realestate/libraries rosters
//   2. { agents: { "1": {name, focus, companies}, ... } } — the 5-agent roster.json
//   3. { name, description, companies: [...] }      — ithaca_roster.json (flat, no groups)
//
// Plus a virtual roster for tabs with no dedicated roster file (sophomore, fall2026,
// fellowships, china_hk): they sweep the same companies the 5 agents track, so
// loadRoster(rosterJsonPath, {allAgents: true}) flattens every agent's companies into
// one roster.
const fs = require("fs");

function normalize(raw, opts) {
  opts = opts || {};

  // Shape 2: the 5-agent roster.json — either one named agent or all of them flattened.
  if (raw.agents && typeof raw.agents === "object") {
    if (opts.allAgents) {
      const groups = {};
      for (const [id, a] of Object.entries(raw.agents)) {
        groups[`agent${id} (${a.focus || a.name || id})`] = a.companies || [];
      }
      return { name: "All tracked companies (agents 1-5)", description: opts.criteria || "finance/investing internships", groups };
    }
    const key = opts.agentKey;
    const a = raw.agents[key];
    if (!a) throw new Error(`agentKey "${key}" not found in roster.agents (have: ${Object.keys(raw.agents).join(", ")})`);
    return { name: a.name || `Agent ${key}`, description: a.focus || opts.criteria, groups: { [`agent${key}`]: a.companies || [] } };
  }

  // Shape 1: already has groups.
  if (raw.groups && typeof raw.groups === "object") {
    return { name: raw.name, description: raw.description, groups: raw.groups };
  }

  // Shape 3: flat companies array, no groups.
  if (Array.isArray(raw.companies)) {
    return { name: raw.name, description: raw.description, groups: { main: raw.companies } };
  }

  throw new Error("Unrecognized roster shape — expected .groups, .agents, or .companies");
}

// loadRoster(path, opts) → { name, description, groups }
//   opts.agentKey  — for the 5-agent roster.json, which agent ("1".."5") to extract.
//   opts.allAgents — for the 5-agent roster.json, flatten all agents into one roster
//                    (used by sophomore/fall2026/fellowships/china_hk tabs).
//   opts.criteria  — fallback description text if the source roster has none.
function loadRoster(rosterPath, opts) {
  const raw = JSON.parse(fs.readFileSync(rosterPath, "utf8"));
  return normalize(raw, opts);
}

module.exports = { loadRoster, normalize };

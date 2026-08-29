// schedule.js — pure cadence-gate logic for the unattended cloud refresh: given the
// configured cadence and when the last refresh actually finished, decide whether a
// scheduled tick should run the pipeline or skip as a no-op. Used by
// check-schedule.js (the CI-side gate) and the Tracker Runner Electron app's
// Schedule section (which edits data/_schedule_config.json).
const fs = require("fs");

const DEFAULT_CONFIG = { cadenceHours: 24 };

function loadConfig(configPath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(configPath, "utf8"));
    if (parsed && Number.isFinite(parsed.cadenceHours) && parsed.cadenceHours > 0) return parsed;
  } catch (_) { /* missing/corrupt — fall back to default */ }
  return { ...DEFAULT_CONFIG };
}

function saveConfig(configPath, config) {
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
}

// lastRunIso: ISO date/time of the last successful refresh, or null/undefined if none
// is recorded yet. now: injectable for tests, defaults to the real current time.
function isDue(cadenceHours, lastRunIso, now = new Date()) {
  if (!lastRunIso) return true;
  const last = new Date(lastRunIso);
  if (Number.isNaN(last.getTime())) return true; // corrupt timestamp — don't get stuck skipping forever
  const elapsedHours = (now.getTime() - last.getTime()) / (1000 * 60 * 60);
  return elapsedHours >= cadenceHours;
}

module.exports = { loadConfig, saveConfig, isDue, DEFAULT_CONFIG };

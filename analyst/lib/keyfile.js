// keyfile.js — resolve an API key from the environment, else from the shared
// OneDrive\Documents\.env file. Mirrors scripts/nim/judge.js's apiKey() so the
// analyst engine loads credentials exactly the way the rest of the project does.
// This module NEVER prints the key; callers get the value, not the source text.
const fs = require("fs");

const ENV_FILE = "C:\\Users\\justi\\OneDrive\\Documents\\.env";

function apiKey(name) {
  if (process.env[name] && process.env[name].trim()) return process.env[name].trim();
  try {
    const line = fs
      .readFileSync(ENV_FILE, "utf8")
      .split(/\r?\n/)
      .find((l) => l.startsWith(name + "="));
    if (line) return line.split("=").slice(1).join("=").trim();
  } catch (_) {
    /* file missing — fall through */
  }
  return null;
}

module.exports = { apiKey, ENV_FILE };

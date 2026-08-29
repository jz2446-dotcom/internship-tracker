#!/usr/bin/env node
// check-schedule.js — run by the GitHub Actions cron every tick (see
// .github/workflows/refresh.yml). Reads data/_schedule_config.json to decide whether
// enough time has elapsed since the last successful refresh to actually run one, and
// writes "due=true|false" to $GITHUB_OUTPUT so the workflow's later steps can be
// gated on it. _schedule_config.json's lastRunAt is updated by the workflow itself
// after a successful run (see refresh.yml's final step) — this script only reads it.
const fs = require("fs");
const path = require("path");
const schedule = require("./lib/schedule.js");

const CONFIG_PATH = path.join(__dirname, "..", "data", "_schedule_config.json");

const config = schedule.loadConfig(CONFIG_PATH);
const due = schedule.isDue(config.cadenceHours, config.lastRunAt);

console.log(`schedule check: cadenceHours=${config.cadenceHours} lastRunAt=${config.lastRunAt || "(none)"} due=${due}`);

const outFile = process.env.GITHUB_OUTPUT;
if (outFile) fs.appendFileSync(outFile, `due=${due}\n`);

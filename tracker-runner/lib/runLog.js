// runLog.js — persists each run's full console output to a timestamped file,
// so a failure can be diagnosed after the app window is closed instead of
// vanishing with the console. Separate from history.js's calendar snapshots
// (those are the RESULTS of a run; this is the RAW LOG of one).
const fs = require('fs');
const path = require('path');

function timestampForFilename(date) {
  return date.toISOString().replace(/[:.]/g, '-');
}

// Opens (creating parent dirs as needed) a new log file for one run and
// returns { filePath, write(chunk), close() }. now is injectable for tests.
function startRunLog(logsDir, now = new Date()) {
  fs.mkdirSync(logsDir, { recursive: true });
  const filePath = path.join(logsDir, `${timestampForFilename(now)}.log`);
  const stream = fs.createWriteStream(filePath, { flags: 'a' });
  return {
    filePath,
    write(chunk) { stream.write(chunk); },
    close() { return new Promise((resolve) => stream.end(resolve)); },
  };
}

module.exports = { startRunLog };

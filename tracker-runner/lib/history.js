// lib/history.js — per-day snapshot storage backing the History calendar feature.
const fs = require('fs');
const path = require('path');

function dateStr(d) {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function snapshotPath(historyDir, date) {
  return path.join(historyDir, `${date}.json`);
}

function writeSnapshot(historyDir, date, text) {
  fs.mkdirSync(historyDir, { recursive: true });
  fs.writeFileSync(snapshotPath(historyDir, date), text);
}

function listSnapshotDates(historyDir) {
  let names;
  try { names = fs.readdirSync(historyDir); } catch (_) { return []; }
  return names
    .filter((n) => /^\d{4}-\d{2}-\d{2}\.json$/.test(n))
    .map((n) => n.slice(0, -5))
    .sort();
}

function readSnapshot(historyDir, date) {
  return fs.readFileSync(snapshotPath(historyDir, date), 'utf8');
}

module.exports = { dateStr, snapshotPath, writeSnapshot, listSnapshotDates, readSnapshot };

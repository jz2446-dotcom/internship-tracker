// lib/timing.js — EMA-based step duration tracking, used to weight the progress bar.
const fs = require('fs');
const path = require('path');

const ALPHA = 0.3;

function loadTimings(filePath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed : {};
  } catch (_) {
    return {};
  }
}

function saveTimings(filePath, timings) {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(timings, null, 2));
  } catch (_) {
    // best-effort — a failed write must never fail the run
  }
}

// observations: [{ key, ms }] — durations measured for this run's steps.
function updateTimings(timings, observations) {
  const next = { ...timings };
  for (const { key, ms } of observations) {
    if (!key || !Number.isFinite(ms) || ms < 0) continue;
    next[key] = (key in next) ? ALPHA * ms + (1 - ALPHA) * next[key] : ms;
  }
  return next;
}

// steps: [{ key, status }] in plan order. Returns a fraction 0..1.
function computeProgress(steps, timings) {
  if (!steps.length) return 0;
  const known = Object.values(timings).filter(Number.isFinite);
  const fallback = known.length ? known.reduce((a, b) => a + b, 0) / known.length : 1;
  const weightOf = (s) => (Number.isFinite(timings[s.key]) ? timings[s.key] : fallback);
  const total = steps.reduce((sum, s) => sum + weightOf(s), 0);
  if (total <= 0) return 0;
  const TERMINAL = new Set(['done', 'failed', 'stopped', 'skipped']);
  const done = steps.reduce((sum, s) => {
    const w = weightOf(s);
    if (TERMINAL.has(s.status)) return sum + w;
    if (s.status === 'running') return sum + w * 0.5;
    return sum;
  }, 0);
  return Math.max(0, Math.min(1, done / total));
}

module.exports = { loadTimings, saveTimings, updateTimings, computeProgress };

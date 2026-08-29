const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadConfig, saveConfig, isDue, DEFAULT_CONFIG } = require('./schedule.js');

test('isDue is true when there is no prior run recorded', () => {
  assert.equal(isDue(24, null), true);
  assert.equal(isDue(24, undefined), true);
});

test('isDue is false when elapsed time is under the cadence', () => {
  const now = new Date('2026-08-29T12:00:00Z');
  const lastRun = new Date('2026-08-29T00:00:00Z').toISOString(); // 12h ago
  assert.equal(isDue(24, lastRun, now), false);
});

test('isDue is true once elapsed time reaches the cadence', () => {
  const now = new Date('2026-08-29T12:00:00Z');
  const lastRun = new Date('2026-08-28T12:00:00Z').toISOString(); // exactly 24h ago
  assert.equal(isDue(24, lastRun, now), true);
});

test('isDue fails open (true) on an unparseable lastRunIso', () => {
  assert.equal(isDue(24, 'not-a-date', new Date()), true);
});

test('loadConfig returns the default when the file is missing', () => {
  const missingPath = path.join(os.tmpdir(), `schedule-missing-${Date.now()}.json`);
  assert.deepEqual(loadConfig(missingPath), DEFAULT_CONFIG);
});

test('saveConfig then loadConfig round-trips', () => {
  const file = path.join(os.tmpdir(), `schedule-roundtrip-${Date.now()}.json`);
  saveConfig(file, { cadenceHours: 12, lastRunAt: '2026-08-29T00:00:00.000Z' });
  const loaded = loadConfig(file);
  assert.equal(loaded.cadenceHours, 12);
  assert.equal(loaded.lastRunAt, '2026-08-29T00:00:00.000Z');
  fs.rmSync(file, { force: true });
});

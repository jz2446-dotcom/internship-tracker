const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { loadTimings, saveTimings, updateTimings, computeProgress } = require('./timing.js');

test('loadTimings returns {} when the file is missing', () => {
  const p = path.join(os.tmpdir(), 'tr-timing-missing-' + Date.now() + '.json');
  assert.deepEqual(loadTimings(p), {});
});

test('loadTimings returns {} on malformed JSON, never throws', () => {
  const p = path.join(os.tmpdir(), 'tr-timing-bad-' + Date.now() + '.json');
  fs.writeFileSync(p, '{not json');
  assert.deepEqual(loadTimings(p), {});
  fs.unlinkSync(p);
});

test('saveTimings then loadTimings round-trips, creating parent dirs', () => {
  const dir = path.join(os.tmpdir(), 'tr-timing-dir-' + Date.now());
  const p = path.join(dir, 'nested', 'step-timings.json');
  saveTimings(p, { agent1: 5000 });
  assert.deepEqual(loadTimings(p), { agent1: 5000 });
  fs.rmSync(dir, { recursive: true, force: true });
});

test('updateTimings seeds a new key with the raw observation', () => {
  const next = updateTimings({}, [{ key: 'build', ms: 1000 }]);
  assert.equal(next.build, 1000);
});

test('updateTimings applies a 0.3/0.7 EMA to an existing key', () => {
  const next = updateTimings({ build: 1000 }, [{ key: 'build', ms: 2000 }]);
  assert.equal(next.build, 0.3 * 2000 + 0.7 * 1000); // 1300
});

test('updateTimings ignores non-finite or negative durations', () => {
  const next = updateTimings({ build: 1000 }, [{ key: 'build', ms: -5 }, { key: 'x', ms: NaN }]);
  assert.deepEqual(next, { build: 1000 });
});

test('computeProgress: all pending steps with known timings -> 0', () => {
  const steps = [{ key: 'a', status: 'pending' }, { key: 'b', status: 'pending' }];
  assert.equal(computeProgress(steps, { a: 100, b: 100 }), 0);
});

test('computeProgress: all done -> 1', () => {
  const steps = [{ key: 'a', status: 'done' }, { key: 'b', status: 'done' }];
  assert.equal(computeProgress(steps, { a: 100, b: 300 }), 1);
});

test('computeProgress: a running step counts as half its own weight', () => {
  const steps = [{ key: 'a', status: 'done' }, { key: 'b', status: 'running' }];
  // equal weights (100 each): done=100, running=50 of 200 total = 0.75
  assert.equal(computeProgress(steps, { a: 100, b: 100 }), 0.75);
});

test('computeProgress: failed/stopped/skipped count as fully weighted (terminal)', () => {
  const steps = [{ key: 'a', status: 'failed' }, { key: 'b', status: 'skipped' }];
  assert.equal(computeProgress(steps, { a: 100, b: 100 }), 1);
});

test('computeProgress: unknown key falls back to the mean of known timings', () => {
  const steps = [{ key: 'known', status: 'done' }, { key: 'unknown', status: 'pending' }];
  // known=100 (its real EMA), unknown falls back to mean of known timings = 100 too
  assert.equal(computeProgress(steps, { known: 100 }), 0.5);
});

test('computeProgress: empty timings map falls back to equal weight 1 per step', () => {
  const steps = [{ key: 'a', status: 'done' }, { key: 'b', status: 'pending' }];
  assert.equal(computeProgress(steps, {}), 0.5);
});

test('computeProgress: no steps -> 0', () => {
  assert.equal(computeProgress([], { a: 100 }), 0);
});

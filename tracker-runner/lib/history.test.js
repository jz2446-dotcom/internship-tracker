const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { dateStr, snapshotPath, writeSnapshot, listSnapshotDates, readSnapshot } = require('./history.js');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tr-history-'));
}

test('dateStr formats a Date as YYYY-MM-DD, zero-padded', () => {
  assert.equal(dateStr(new Date(2026, 0, 5)), '2026-01-05'); // month is 0-indexed
  assert.equal(dateStr(new Date(2026, 10, 23)), '2026-11-23');
});

test('snapshotPath joins the history dir and date with .json', () => {
  assert.equal(snapshotPath('/x/history', '2026-08-14'), path.join('/x/history', '2026-08-14.json'));
});

test('writeSnapshot creates the dir and file; listSnapshotDates finds it', () => {
  const dir = tmpDir();
  const nested = path.join(dir, 'history');
  writeSnapshot(nested, '2026-08-14', '{"agents":{}}');
  assert.deepEqual(listSnapshotDates(nested), ['2026-08-14']);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('writeSnapshot overwrites an existing same-day snapshot', () => {
  const dir = tmpDir();
  writeSnapshot(dir, '2026-08-14', 'first');
  writeSnapshot(dir, '2026-08-14', 'second');
  assert.equal(readSnapshot(dir, '2026-08-14'), 'second');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('listSnapshotDates returns [] for a missing directory', () => {
  assert.deepEqual(listSnapshotDates(path.join(os.tmpdir(), 'tr-history-does-not-exist')), []);
});

test('listSnapshotDates ignores non-date files and sorts ascending', () => {
  const dir = tmpDir();
  writeSnapshot(dir, '2026-08-20', 'a');
  writeSnapshot(dir, '2026-08-01', 'b');
  fs.writeFileSync(path.join(dir, 'step-timings.json'), '{}');
  fs.writeFileSync(path.join(dir, 'notadate.json'), '{}');
  assert.deepEqual(listSnapshotDates(dir), ['2026-08-01', '2026-08-20']);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('readSnapshot throws for a missing date', () => {
  const dir = tmpDir();
  assert.throws(() => readSnapshot(dir, '2026-01-01'));
  fs.rmSync(dir, { recursive: true, force: true });
});

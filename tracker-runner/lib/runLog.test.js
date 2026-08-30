const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { startRunLog } = require('./runLog.js');

function tmpDir() {
  return path.join(os.tmpdir(), `runlog-test-${process.pid}-${Math.random().toString(36).slice(2)}`);
}

test('creates the logs directory if missing and writes content to a new file', async () => {
  const dir = tmpDir();
  const runLog = startRunLog(dir, new Date('2026-08-30T12:00:00.000Z'));
  runLog.write('hello\n');
  runLog.write('world\n');
  await runLog.close();
  const content = fs.readFileSync(runLog.filePath, 'utf8');
  assert.equal(content, 'hello\nworld\n');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('two runs started at different times get different files', async () => {
  const dir = tmpDir();
  const a = startRunLog(dir, new Date('2026-08-30T12:00:00.000Z'));
  const b = startRunLog(dir, new Date('2026-08-30T12:05:00.000Z'));
  assert.notEqual(a.filePath, b.filePath);
  await Promise.all([a.close(), b.close()]);
  fs.rmSync(dir, { recursive: true, force: true });
});

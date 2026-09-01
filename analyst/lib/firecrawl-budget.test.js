const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { tryReserve } = require('./firecrawl-budget.js');

function tmpFile() {
  return path.join(os.tmpdir(), `firecrawl-budget-test-${process.pid}-${Math.random().toString(36).slice(2)}.json`);
}

test('first reservation on a fresh file succeeds with used=1', async () => {
  const file = tmpFile();
  const res = await tryReserve({ file, limit: 5 });
  assert.equal(res.ok, true);
  assert.equal(res.used, 1);
  fs.rmSync(file, { force: true });
});

test('reservations beyond the limit are rejected', async () => {
  const file = tmpFile();
  for (let i = 0; i < 3; i++) await tryReserve({ file, limit: 3 });
  const res = await tryReserve({ file, limit: 3 });
  assert.equal(res.ok, false);
  assert.equal(res.used, 3);
  fs.rmSync(file, { force: true });
});

test('a new calendar month resets the counter', async () => {
  const file = tmpFile();
  fs.writeFileSync(file, JSON.stringify({ month: '2020-01', used: 3 }));
  const res = await tryReserve({ file, limit: 3, now: new Date('2020-02-01T00:00:00Z') });
  assert.equal(res.ok, true);
  assert.equal(res.used, 1);
  fs.rmSync(file, { force: true });
});

test('a new calendar day within the SAME month does NOT reset the counter', async () => {
  const file = tmpFile();
  fs.writeFileSync(file, JSON.stringify({ month: '2020-01', used: 3 }));
  const res = await tryReserve({ file, limit: 3, now: new Date('2020-01-31T00:00:00Z') });
  assert.equal(res.ok, false);
  assert.equal(res.used, 3);
  fs.rmSync(file, { force: true });
});

test('migrates the old daily-reset format: carries forward used spend within the same month instead of resetting to 0', async () => {
  const file = tmpFile();
  fs.writeFileSync(file, JSON.stringify({ date: '2026-08-31', used: 450 }));
  const res = await tryReserve({ file, limit: 450, now: new Date('2026-08-31T12:00:00Z') });
  assert.equal(res.ok, false);
  assert.equal(res.used, 450);
  fs.rmSync(file, { force: true });
});

test('an old daily-reset entry from a PRIOR month starts fresh, not carried forward', async () => {
  const file = tmpFile();
  fs.writeFileSync(file, JSON.stringify({ date: '2026-07-31', used: 450 }));
  const res = await tryReserve({ file, limit: 450, now: new Date('2026-08-01T00:00:00Z') });
  assert.equal(res.ok, true);
  assert.equal(res.used, 1);
  fs.rmSync(file, { force: true });
});

test('concurrent reservations never exceed the limit', async () => {
  const file = tmpFile();
  const results = await Promise.all(Array.from({ length: 20 }, () => tryReserve({ file, limit: 10 })));
  const okCount = results.filter((r) => r.ok).length;
  assert.equal(okCount, 10);
  fs.rmSync(file, { force: true });
  fs.rmSync(file + '.lock', { force: true });
});

test('FIRECRAWL_MONTHLY_BUDGET="0" is honored as an explicit zero, not coerced to the 450 default', () => {
  const prev = process.env.FIRECRAWL_MONTHLY_BUDGET;
  process.env.FIRECRAWL_MONTHLY_BUDGET = '0';
  delete require.cache[require.resolve('./firecrawl-budget.js')];
  const { DEFAULT_LIMIT } = require('./firecrawl-budget.js');
  assert.equal(DEFAULT_LIMIT, 0);
  if (prev === undefined) delete process.env.FIRECRAWL_MONTHLY_BUDGET;
  else process.env.FIRECRAWL_MONTHLY_BUDGET = prev;
  delete require.cache[require.resolve('./firecrawl-budget.js')];
});

test('retries past a transient EPERM on lock creation instead of crashing (Windows multi-process contention observed live)', async () => {
  const file = tmpFile();
  const realOpenSync = fs.openSync;
  let calls = 0;
  fs.openSync = (p, flags) => {
    if (p === file + '.lock' && flags === 'wx' && calls++ === 0) {
      const err = new Error(`EPERM: operation not permitted, open '${p}'`);
      err.code = 'EPERM';
      throw err;
    }
    return realOpenSync(p, flags);
  };
  try {
    const res = await tryReserve({ file, limit: 5 });
    assert.equal(res.ok, true);
    assert.equal(res.used, 1);
  } finally {
    fs.openSync = realOpenSync;
    fs.rmSync(file, { force: true });
  }
});

test('an unset FIRECRAWL_MONTHLY_BUDGET falls back to 450', () => {
  const prev = process.env.FIRECRAWL_MONTHLY_BUDGET;
  delete process.env.FIRECRAWL_MONTHLY_BUDGET;
  delete require.cache[require.resolve('./firecrawl-budget.js')];
  const { DEFAULT_LIMIT } = require('./firecrawl-budget.js');
  assert.equal(DEFAULT_LIMIT, 450);
  if (prev === undefined) delete process.env.FIRECRAWL_MONTHLY_BUDGET;
  else process.env.FIRECRAWL_MONTHLY_BUDGET = prev;
  delete require.cache[require.resolve('./firecrawl-budget.js')];
});

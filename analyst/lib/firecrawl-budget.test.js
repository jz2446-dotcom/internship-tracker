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

test('a new calendar day resets the counter', async () => {
  const file = tmpFile();
  fs.writeFileSync(file, JSON.stringify({ date: '2020-01-01', used: 3 }));
  const res = await tryReserve({ file, limit: 3, now: new Date('2020-01-02T00:00:00Z') });
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

test('FIRECRAWL_DAILY_BUDGET="0" is honored as an explicit zero, not coerced to the 450 default', () => {
  const prev = process.env.FIRECRAWL_DAILY_BUDGET;
  process.env.FIRECRAWL_DAILY_BUDGET = '0';
  delete require.cache[require.resolve('./firecrawl-budget.js')];
  const { DEFAULT_LIMIT } = require('./firecrawl-budget.js');
  assert.equal(DEFAULT_LIMIT, 0);
  if (prev === undefined) delete process.env.FIRECRAWL_DAILY_BUDGET;
  else process.env.FIRECRAWL_DAILY_BUDGET = prev;
  delete require.cache[require.resolve('./firecrawl-budget.js')];
});

test('an unset FIRECRAWL_DAILY_BUDGET falls back to 450', () => {
  const prev = process.env.FIRECRAWL_DAILY_BUDGET;
  delete process.env.FIRECRAWL_DAILY_BUDGET;
  delete require.cache[require.resolve('./firecrawl-budget.js')];
  const { DEFAULT_LIMIT } = require('./firecrawl-budget.js');
  assert.equal(DEFAULT_LIMIT, 450);
  if (prev === undefined) delete process.env.FIRECRAWL_DAILY_BUDGET;
  else process.env.FIRECRAWL_DAILY_BUDGET = prev;
  delete require.cache[require.resolve('./firecrawl-budget.js')];
});

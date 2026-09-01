const test = require('node:test');
const assert = require('node:assert/strict');

test('firecrawl() returns "" without a network call once the budget is exhausted', async () => {
  process.env.FIRECRAWL_MONTHLY_BUDGET = '0';
  delete require.cache[require.resolve('./firecrawl-budget.js')];
  delete require.cache[require.resolve('./scrape.js')];
  const budget = require('./firecrawl-budget.js');
  // Force the local-counter fallback path (no real call to Firecrawl's live
  // credit-usage endpoint) — this test is about scrape.js's WIRING to the budget
  // check, not about firecrawl-budget.js's own logic (that has its own full suite).
  budget._setFetchLiveForTest(async () => null);
  const scrape = require('./scrape.js');
  const url = `https://example.invalid/never-cached-${Date.now()}`;
  const text = await scrape._firecrawlForTest(url);
  assert.equal(text, '');
  budget._setFetchLiveForTest(null);
  delete process.env.FIRECRAWL_MONTHLY_BUDGET;
});

const test = require('node:test');
const assert = require('node:assert/strict');

test('firecrawl() returns "" without a network call once the monthly budget is exhausted', async () => {
  process.env.FIRECRAWL_MONTHLY_BUDGET = '0';
  delete require.cache[require.resolve('./firecrawl-budget.js')];
  delete require.cache[require.resolve('./scrape.js')];
  const scrape = require('./scrape.js');
  const url = `https://example.invalid/never-cached-${Date.now()}`;
  const text = await scrape._firecrawlForTest(url);
  assert.equal(text, '');
  delete process.env.FIRECRAWL_MONTHLY_BUDGET;
});

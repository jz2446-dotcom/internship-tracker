const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const CACHE_FILE = path.join(__dirname, '..', '..', 'data', '_scrape_cache.json');

// A successful playwrightRender() writes to the REAL data/_scrape_cache.json (same
// file scrape.js always uses — no injectable path for it, matching how the
// firecrawl() test above never reaches that write path). Strip the test's own URL
// back out afterward so repeated test runs don't accumulate junk entries there.
function forgetCacheEntry(url) {
  try {
    const onDisk = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    delete onDisk[url];
    fs.writeFileSync(CACHE_FILE, JSON.stringify(onDisk));
  } catch (_) { /* nothing to clean up */ }
}

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

test('playwrightRender() returns rendered text via pw.js, caching it for next time', async () => {
  delete require.cache[require.resolve('./scrape.js')];
  const scrape = require('./scrape.js');
  const pw = require('./pw.js');
  const real = { openBlank: pw.openBlank, goto: pw.goto, evalJson: pw.evalJson, close: pw.close };
  let gotoCalls = 0;
  pw.openBlank = () => ({ code: 0 });
  pw.goto = () => { gotoCalls++; return { code: 0 }; };
  pw.evalJson = () => 'x'.repeat(400); // above MIN_TEXT (300)
  pw.close = () => ({ code: 0 });
  try {
    const url = `https://example.invalid/pw-fallback-${Date.now()}`;
    const text = await scrape._playwrightRenderForTest(url);
    assert.equal(text.length, 400);
    // second call for the SAME url should hit the cache, not call pw.goto again
    await scrape._playwrightRenderForTest(url);
    assert.equal(gotoCalls, 1);
    forgetCacheEntry(url);
  } finally {
    Object.assign(pw, real);
  }
});

test('playwrightRender() returns "" (not throws) when the page fails to load', async () => {
  delete require.cache[require.resolve('./scrape.js')];
  const scrape = require('./scrape.js');
  const pw = require('./pw.js');
  const real = { openBlank: pw.openBlank, goto: pw.goto, close: pw.close };
  pw.openBlank = () => ({ code: 0 });
  pw.goto = () => ({ code: 1 }); // navigation failure
  pw.close = () => ({ code: 0 });
  try {
    const url = `https://example.invalid/pw-fail-${Date.now()}`;
    const text = await scrape._playwrightRenderForTest(url);
    assert.equal(text, '');
  } finally {
    Object.assign(pw, real);
  }
});

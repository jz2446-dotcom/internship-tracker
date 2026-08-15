const test = require('node:test');
const assert = require('node:assert/strict');
const { parseResolvedLine } = require('./resolvedParser.js');

test('parses a REG line', () => {
  const r = parseResolvedLine('[agent3] ✓ REG  Acme Corp → greenhouse/acme (2)');
  assert.deepEqual(r, { tab: 'agent3', method: 'REG', company: 'Acme Corp', detail: 'greenhouse/acme (2)' });
});

test('parses an ATS line (no arrow, trailing paren detail)', () => {
  const r = parseResolvedLine('[environmental] ✓ ATS  Beta Fund (lever/beta, 3)');
  assert.deepEqual(r, { tab: 'environmental', method: 'ATS', company: 'Beta Fund', detail: '(lever/beta, 3)' });
});

test('parses a SRCH line', () => {
  const r = parseResolvedLine('[libraries] ✓ SRCH Gamma Museum → workday/gamma (1)');
  assert.deepEqual(r, { tab: 'libraries', method: 'SRCH', company: 'Gamma Museum', detail: 'workday/gamma (1)' });
});

test('parses a WEB line with a provider/slug detail', () => {
  const r = parseResolvedLine('[ithaca] ✓ WEB  Delta Bank → greenhouse/delta (4)');
  assert.deepEqual(r, { tab: 'ithaca', method: 'WEB', company: 'Delta Bank', detail: 'greenhouse/delta (4)' });
});

test('parses a WEB "scraped" line', () => {
  const r = parseResolvedLine('[china_hk] ✓ WEB  Epsilon LLC → scraped https://epsilon.com/careers');
  assert.deepEqual(r, { tab: 'china_hk', method: 'WEB', company: 'Epsilon LLC', detail: 'scraped https://epsilon.com/careers' });
});

test('parses a WEB "sniffed API" line', () => {
  const r = parseResolvedLine('[fellowships] ✓ WEB  Zeta Inc → sniffed API (5)');
  assert.deepEqual(r, { tab: 'fellowships', method: 'WEB', company: 'Zeta Inc', detail: 'sniffed API (5)' });
});

test('returns null for an unrelated console line', () => {
  assert.equal(parseResolvedLine('[agent1] … search pass over 12 unresolved firms (tavily)'), null);
});

test('returns null for an unresolved-firm summary line', () => {
  assert.equal(parseResolvedLine('firms:        40  (ATS 10, search-resolved 5, browser-resolved 2, still unresolved 3)'), null);
});

test('returns null for an empty or whitespace-only line', () => {
  assert.equal(parseResolvedLine(''), null);
  assert.equal(parseResolvedLine('   '), null);
});

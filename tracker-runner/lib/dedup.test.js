const test = require('node:test');
const assert = require('node:assert/strict');
const { CATEGORY_ORDER, dedupCategories } = require('./dedup.js');

test('CATEGORY_ORDER puts dedicated-roster tabs before roster.json specialty tabs before agent1-5', () => {
  const idx = (id) => CATEGORY_ORDER.indexOf(id);
  assert.ok(idx('environmental') < idx('sophomore'));
  assert.ok(idx('sophomore') < idx('agent1'));
  assert.ok(idx('agent1') < idx('agent5'));
});

test('keeps a company+program pair only in the most specific category', () => {
  const categories = {
    agent1: { internships: [{ company: 'Acme', program: 'Summer Analyst' }] },
    environmental: { internships: [{ company: 'Acme', program: 'Summer Analyst' }] },
  };
  const { cleaned, removals } = dedupCategories(categories);
  assert.deepEqual(cleaned.environmental.internships, [{ company: 'Acme', program: 'Summer Analyst' }]);
  assert.deepEqual(cleaned.agent1.internships, []);
  assert.deepEqual(removals, [{ company: 'Acme', program: 'Summer Analyst', from: 'agent1', keptIn: 'environmental' }]);
});

test('is case- and whitespace-insensitive when matching keys', () => {
  const categories = {
    realestate: { internships: [{ company: 'Beta Corp', program: 'Analyst' }] },
    agent2: { internships: [{ company: '  beta corp  ', program: 'ANALYST' }] },
  };
  const { removals } = dedupCategories(categories);
  assert.equal(removals.length, 1);
  assert.equal(removals[0].from, 'agent2');
  assert.equal(removals[0].keptIn, 'realestate');
});

test('does not remove duplicates within the same category', () => {
  const categories = {
    agent1: { internships: [
      { company: 'Gamma', program: 'Analyst' },
      { company: 'Gamma', program: 'Analyst' },
    ] },
  };
  const { cleaned, removals } = dedupCategories(categories);
  assert.equal(cleaned.agent1.internships.length, 2);
  assert.equal(removals.length, 0);
});

test('leaves unrelated entries untouched and preserves non-internships fields', () => {
  const categories = {
    libraries: { name: 'Libraries & Museums', focus: 'x', internships: [{ company: 'Delta', program: 'Curator' }] },
    agent3: { name: 'Agent 3', focus: 'y', internships: [{ company: 'Epsilon', program: 'Analyst' }] },
  };
  const { cleaned, removals } = dedupCategories(categories);
  assert.equal(removals.length, 0);
  assert.equal(cleaned.libraries.name, 'Libraries & Museums');
  assert.equal(cleaned.agent3.internships.length, 1);
});

test('handles an unknown category id by processing it last', () => {
  const categories = {
    mystery: { internships: [{ company: 'Zeta', program: 'Role' }] },
    ithaca: { internships: [{ company: 'Zeta', program: 'Role' }] },
  };
  const { removals } = dedupCategories(categories);
  assert.equal(removals.length, 1);
  assert.equal(removals[0].from, 'mystery');
  assert.equal(removals[0].keptIn, 'ithaca');
});

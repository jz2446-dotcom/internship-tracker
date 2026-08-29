const test = require('node:test');
const assert = require('node:assert/strict');
const { buildArgs } = require('./_full_refresh_driver.js');

test('buildArgs includes agent-key for a core agent1-5 roster', () => {
  const args = buildArgs({ rosterPath: '../data/roster.json', agentName: 'agent1', agentKey: '1' }, 'nim', '8');
  assert.deepEqual(args, ['run-analyst.js', '--roster', '../data/roster.json', '--agent-name', 'agent1', '--brain', 'nim', '--agent-key', '1', '--concurrency', '8']);
});

test('buildArgs includes all-agents, tab, and term for a split fall2026/spring2027 roster', () => {
  const args = buildArgs({ rosterPath: '../data/roster.json', agentName: 'fall2026_fall', allAgents: true, tab: 'fall2026', term: 'fall' }, 'nim', '2');
  assert.deepEqual(args, ['run-analyst.js', '--roster', '../data/roster.json', '--agent-name', 'fall2026_fall', '--brain', 'nim', '--all-agents', '--tab', 'fall2026', '--term', 'fall', '--concurrency', '2']);
});

test('buildArgs omits optional flags entirely when absent from the config', () => {
  const args = buildArgs({ rosterPath: '../data/environmental_roster.json', agentName: 'environmental' }, 'heuristic', '4');
  assert.deepEqual(args, ['run-analyst.js', '--roster', '../data/environmental_roster.json', '--agent-name', 'environmental', '--brain', 'heuristic', '--concurrency', '4']);
});

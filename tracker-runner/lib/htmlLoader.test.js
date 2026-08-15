const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { toEvaluableSource, loadDashboardHtml } = require('./htmlLoader.js');

const FIXTURE = `import BUNDLED_DATA from './data.json';
import RESUMES from './resumes.json';

export default {
  async fetch(request, env, ctx) {
    return new Response(getDashboardHTML());
  }
};

function getDashboardHTML() {
  return '<html><head><title>Fixture</title></head><body>{"looks":"like json but is a string"}</body></html>';
}
`;

test('toEvaluableSource rewrites JSON imports to const declarations', () => {
  const out = toEvaluableSource(FIXTURE);
  assert.match(out, /const BUNDLED_DATA = \{\};/);
  assert.match(out, /const RESUMES = \{\};/);
  assert.doesNotMatch(out, /^import /m);
});

test('toEvaluableSource rewrites "export default {" to "void {"', () => {
  const out = toEvaluableSource(FIXTURE);
  assert.match(out, /^void \{/m);
  assert.doesNotMatch(out, /export default/);
});

test('toEvaluableSource output is valid, evaluable script that exposes getDashboardHTML', () => {
  const out = toEvaluableSource(FIXTURE);
  const fn = new Function(`${out}\nreturn getDashboardHTML;`)();
  assert.equal(typeof fn, 'function');
  assert.match(fn(), /Fixture/);
});

test('loadDashboardHtml returns a callable that renders the real dashboard HTML', () => {
  const indexJsPath = path.join(__dirname, '..', '..', 'cloudflare-worker', 'src', 'index.js');
  const fn = loadDashboardHtml(indexJsPath);
  const html = fn();
  assert.match(html, /<title>Finance Internship Tracker<\/title>/);
});

test('loadDashboardHtml throws a clear error for a file with no import/export-default lines', () => {
  const dir = require('node:fs').mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'tr-html-'));
  const p = path.join(dir, 'plain.js');
  require('node:fs').writeFileSync(p, 'function getDashboardHTML() { return "x"; }');
  assert.throws(() => loadDashboardHtml(p), /no ESM import\/export-default lines/);
  require('node:fs').rmSync(dir, { recursive: true, force: true });
});

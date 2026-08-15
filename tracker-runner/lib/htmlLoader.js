// lib/htmlLoader.js — loads the real getDashboardHTML() function straight out of
// cloudflare-worker/src/index.js at runtime, so the History panel always renders
// with whatever the live site's markup currently is. NEVER modifies that file:
// its ESM `import './x.json'` and `export default` lines are rewritten to plain-
// script equivalents in memory only, then evaluated with `new Function`.
const fs = require('fs');

function toEvaluableSource(originalSrc) {
  let src = originalSrc;
  src = src.replace(/^import\s+(\w+)\s+from\s+['"][^'"]+\.json['"];?\s*$/gm, 'const $1 = {};');
  src = src.replace(/^export default \{/m, 'void {');
  return src;
}

function loadDashboardHtml(indexJsPath) {
  const original = fs.readFileSync(indexJsPath, 'utf8');
  const evaluable = toEvaluableSource(original);
  if (evaluable === original) {
    throw new Error(`${indexJsPath} has no ESM import/export-default lines to rewrite — its format may have changed`);
  }
  const factory = new Function(`${evaluable}\nreturn typeof getDashboardHTML === 'function' ? getDashboardHTML : null;`);
  const fn = factory();
  if (typeof fn !== 'function') {
    throw new Error(`getDashboardHTML() not found in ${indexJsPath}`);
  }
  return fn;
}

module.exports = { toEvaluableSource, loadDashboardHtml };

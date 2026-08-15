// lib/resolvedParser.js — parses run-analyst.js's per-firm resolution log lines
// (already tagged with `[tabId] ` by main.js's tagChunk) into structured records
// for the post-run "resolved companies" report.
function parseResolvedLine(line) {
  const trimmed = (line || '').trim();
  const m = /^\[([\w-]+)\]\s*✓\s*(REG|ATS|SRCH|WEB)\s+(.+)$/.exec(trimmed);
  if (!m) return null;
  const [, tab, method, rest] = m;

  const arrowIdx = rest.indexOf('→');
  if (arrowIdx !== -1) {
    const company = rest.slice(0, arrowIdx).trim();
    const detail = rest.slice(arrowIdx + 1).trim();
    return company ? { tab, method, company, detail } : null;
  }

  const parenIdx = rest.indexOf('(');
  if (parenIdx !== -1) {
    const company = rest.slice(0, parenIdx).trim();
    const detail = rest.slice(parenIdx).trim();
    return company ? { tab, method, company, detail } : null;
  }

  const company = rest.trim();
  return company ? { tab, method, company, detail: '' } : null;
}

module.exports = { parseResolvedLine };

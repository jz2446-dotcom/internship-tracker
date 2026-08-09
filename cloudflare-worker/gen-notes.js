// Run: node gen-notes.js
// Generates one markdown note per program in ../Applications/ with YAML frontmatter for Dataview.
// PRESERVES your personal fields (applied, stage, priority, referral) and the note body across refreshes,
// matching existing notes by their frontmatter `key` (company::program). Never deletes notes.
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(__dirname, '../data');
const outDir = path.join(__dirname, '../Applications');
if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

const GROUPS = {
  agent1: 'Agent 1 — Elite Investing',
  agent2: 'Agent 2 — Middle Market / International',
  agent3: 'Agent 3 — Big Tech Corporate Finance',
  agent4: 'Agent 4 — Consulting + Top F500',
  agent5: 'Agent 5 — Other F500',
  sophomore: 'Sophomore Internships',
  fall2026: 'Fall 2026 Internships'
};
const PERSONAL = ['applied', 'stage', 'priority', 'referral'];

// ---- read existing notes, index by `key`, keep personal fields + body ----
function parse(txt) {
  if (!txt.startsWith('---')) return { fm: {}, body: txt };
  const end = txt.indexOf('\n---', 3);
  if (end < 0) return { fm: {}, body: txt };
  const fm = {};
  for (const line of txt.slice(3, end).trim().split(/\r?\n/)) {
    const m = line.match(/^([A-Za-z_]+):\s?(.*)$/);
    if (m) fm[m[1]] = m[2].replace(/^"(.*)"$/, '$1');
  }
  return { fm, body: txt.slice(end + 4).replace(/^\n+/, '') };
}
const existing = {};
for (const f of readdirSync(outDir)) {
  if (!f.endsWith('.md')) continue;
  const { fm, body } = parse(readFileSync(path.join(outDir, f), 'utf-8'));
  if (fm.key) existing[fm.key] = { file: f, fm, body };
}

const q = s => '"' + String(s == null ? '' : s).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
const sanitize = s => s.replace(/[\\/:*?"<>|#^[\]]/g, '').replace(/\s+/g, ' ').trim().slice(0, 90);
const usedNames = new Set(Object.values(existing).map(e => e.file));

let created = 0, updated = 0;
function emit(it, groupKey) {
  const key = it.company + '::' + (it.program || '');
  const prior = existing[key];
  // personal fields: keep prior if present, else defaults
  const personal = {
    applied: prior?.fm.applied ?? 'false',
    stage: prior?.fm.stage ?? 'to-apply',
    priority: prior?.fm.priority ?? '',
    referral: prior?.fm.referral ?? ''
  };
  const body = prior ? prior.body : '## My notes\n\n_Add referral contacts, recruiter names, interview dates, status, links — preserved across refreshes._\n';
  let file = prior?.file;
  if (!file) {
    let base = sanitize(it.company + ' - ' + (it.program || '')) || 'program';
    file = base + '.md';
    let n = 2;
    while (usedNames.has(file)) file = `${base} (${n++}).md`;
    usedNames.add(file);
  }
  const cy = (it.class_years || []).map(y => '"' + y + '"').join(', ');
  const fm = [
    '---',
    'key: ' + q(key),
    'company: ' + q(it.company),
    'program: ' + q(it.program || ''),
    'group: ' + q(GROUPS[groupKey] || groupKey),
    'category: ' + q(it.category || ''),
    'class_years: [' + cy + ']',
    'status: ' + q(it.status || 'unknown'),
    'deadline: ' + q(it.close_date || ''),
    'posted: ' + q(it.posted_date || ''),
    'acceptance_rate: ' + q(it.acceptance_rate || ''),
    'competitiveness: ' + q((it.competitiveness || '').split(' — ')[0]),
    'location: ' + q(it.location || ''),
    'apply_url: ' + q(it.apply_url || ''),
    ...(it.resume_url ? ['resume_url: ' + q(it.resume_url), 'resume: true'] : []),
    '# ---- your fields below are preserved on every refresh ----',
    'applied: ' + personal.applied,
    'stage: ' + q(personal.stage),
    'priority: ' + q(personal.priority),
    'referral: ' + q(personal.referral),
    '---',
    ''
  ].join('\n');
  writeFileSync(path.join(outDir, file), fm + body);
  if (prior) updated++; else created++;
}

for (const gk of Object.keys(GROUPS)) {
  const file = path.join(dataDir, gk === 'sophomore' ? 'sophomore_results.json' : gk + '_results.json');
  if (!existsSync(file)) continue;
  const d = JSON.parse(readFileSync(file, 'utf-8'));
  for (const it of d.internships) emit(it, gk);
}
console.log(`✓ Notes: ${created} created, ${updated} updated (personal fields preserved). Folder: Applications/`);

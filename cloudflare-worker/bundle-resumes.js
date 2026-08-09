// bundle-resumes.js — rebuild src/resumes.json from the subset/compressed
// per-role PDFs in Resumes/_master/min_<id>.pdf.
//
// The Worker imports src/resumes.json and serves /resume/<id> -> base64 PDF.
// Each open role's resume_url is "/resume/<id>", where <id> matches the
// min_<id>.pdf / map_<id>.json suffix (e.g. min_blackrock.pdf -> "blackrock").
//
// Run this after re-rendering any resume so the deployed bundle picks up the
// corrected PDF. It is deterministic and safe to re-run: it overwrites
// src/resumes.json from whatever min_*.pdf files currently exist.
//
//   node bundle-resumes.js
//
// Then: node build-data.js && wrangler deploy   (deploy is owned separately).

const fs = require('fs');
const path = require('path');

const MASTER_DIR = path.resolve(__dirname, '..', 'Resumes', '_master');
const OUT = path.resolve(__dirname, 'src', 'resumes.json');

if (!fs.existsSync(MASTER_DIR)) {
  console.error(`ERROR: master dir not found: ${MASTER_DIR}`);
  process.exit(1);
}

const files = fs
  .readdirSync(MASTER_DIR)
  .filter((f) => /^min_.+\.pdf$/i.test(f))
  .sort();

if (files.length === 0) {
  console.error(`ERROR: no min_*.pdf files found in ${MASTER_DIR}`);
  process.exit(1);
}

const bundle = {};
let totalBytes = 0;
for (const f of files) {
  const id = f.replace(/^min_/i, '').replace(/\.pdf$/i, '');
  const buf = fs.readFileSync(path.join(MASTER_DIR, f));
  bundle[id] = buf.toString('base64');
  totalBytes += buf.length;
  console.log(`  + ${id.padEnd(12)} <- ${f} (${(buf.length / 1024).toFixed(1)} KB)`);
}

fs.writeFileSync(OUT, JSON.stringify(bundle));
console.log(
  `Wrote ${OUT} — ${files.length} resumes, ${(totalBytes / 1024 / 1024).toFixed(2)} MB raw PDF.`
);

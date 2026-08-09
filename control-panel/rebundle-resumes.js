// rebundle-resumes.js — rebuilds cloudflare-worker/src/resumes.json from the
// Resumes/_master/min_<id>.pdf files. resumes.json is a flat map { "<id>": "<base64 pdf>" }
// keyed by the suffix of each min_<id>.pdf; the Worker imports it and serves /resume/<id>.
//
// This build tool did not previously exist in the repo (résumés were bundled by hand),
// so the control panel ships it. Run from the control-panel/ folder:
//     node rebundle-resumes.js            # writes src/resumes.json
//     node rebundle-resumes.js --dry-run  # report only, writes nothing
//
// It writes ../cloudflare-worker/src/resumes.json. Deploy separately with `wrangler deploy`.

const fs = require('fs');
const path = require('path');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const RESUME_DIR = path.join(PROJECT_ROOT, 'Resumes', '_master');
const OUT_FILE = path.join(PROJECT_ROOT, 'cloudflare-worker', 'src', 'resumes.json');

const dryRun = process.argv.includes('--dry-run');

function main() {
  if (!fs.existsSync(RESUME_DIR)) {
    console.error(`[error] resume dir not found: ${RESUME_DIR}`);
    process.exit(1);
  }

  const pdfs = fs.readdirSync(RESUME_DIR).filter(f => /^min_.+\.pdf$/i.test(f)).sort();
  if (pdfs.length === 0) {
    console.error(`[error] no min_*.pdf files found in ${RESUME_DIR}`);
    process.exit(1);
  }

  const bundle = {};
  let totalBytes = 0;
  for (const f of pdfs) {
    const id = f.replace(/^min_/i, '').replace(/\.pdf$/i, '');
    const buf = fs.readFileSync(path.join(RESUME_DIR, f));
    bundle[id] = buf.toString('base64');
    totalBytes += buf.length;
    console.log(`  + ${id}  (${(buf.length / 1024).toFixed(1)} KB pdf -> ${(bundle[id].length / 1024).toFixed(1)} KB b64)`);
  }

  const json = JSON.stringify(bundle);
  console.log(`\nbundled ${pdfs.length} resumes; raw PDFs ${(totalBytes / 1024 / 1024).toFixed(2)} MB, json ${(json.length / 1024 / 1024).toFixed(2)} MB`);

  if (dryRun) {
    console.log('\n[dry-run] no file written. Target would be:');
    console.log(`  ${OUT_FILE}`);
    return;
  }

  fs.writeFileSync(OUT_FILE, json);
  console.log(`\nwrote ${OUT_FILE}`);
  console.log('Now deploy with:  wrangler deploy   (from cloudflare-worker/)');
}

main();

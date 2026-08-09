// Run: node seed-kv.js
import { execSync } from 'child_process';
import { readFileSync, existsSync, writeFileSync, unlinkSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(__dirname, '../data');

const combined = {
  last_updated: new Date().toISOString(),
  agents: {}
};

for (let i = 1; i <= 5; i++) {
  const file = path.join(dataDir, `agent${i}_results.json`);
  if (existsSync(file)) {
    const data = JSON.parse(readFileSync(file, 'utf-8'));
    combined.agents[String(i)] = data;
    console.log(`Loaded Agent ${i}: ${data.internships?.length || 0} internships`);
  } else {
    console.log(`Agent ${i}: no data file yet (${file})`);
  }
}

const json = JSON.stringify(combined);
const tmpFile = path.join(__dirname, '.kv-upload-tmp.json');
writeFileSync(tmpFile, json);

try {
  // wrangler 4.x syntax: `kv key put` instead of `kv:key put`
  // --remote writes to the live KV namespace the deployed Worker reads (local is default otherwise)
  execSync(`wrangler kv key put --binding INTERNSHIP_KV internship_data --path "${tmpFile}" --remote`, {
    stdio: 'inherit',
    cwd: __dirname
  });
  console.log('✓ KV upload complete');
} finally {
  unlinkSync(tmpFile);
}

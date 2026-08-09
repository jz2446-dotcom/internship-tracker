// renderer.js — UI logic. Talks to main via the window.api bridge (see preload.js).

const consoleEl = document.getElementById('console');
const statusEl = document.getElementById('status');
const killBtn = document.getElementById('kill-btn');
const clearBtn = document.getElementById('clear-btn');
const deployBtn = document.getElementById('deploy-btn');
const deployConfirm = document.getElementById('deploy-confirm');
const mapSelect = document.getElementById('map-select');
const renderBtn = document.getElementById('render-btn');
const tabSelect = document.getElementById('tab-select');
const limitInput = document.getElementById('limit-input');
const analystBtn = document.getElementById('analyst-btn');
const nimCheck = document.getElementById('nim-check');
const browseCheck = document.getElementById('browse-check');
const headedCheck = document.getElementById('headed-check');

let activeRunId = null;
let busy = false;

function short(p) { return p; }

function append(text, cls) {
  const span = document.createElement('span');
  if (cls) span.className = cls;
  span.textContent = text;
  consoleEl.appendChild(span);
  consoleEl.scrollTop = consoleEl.scrollHeight;
}

function setStatus(kind, label) {
  statusEl.className = 'status ' + kind;
  statusEl.textContent = label;
}

function setBusy(state) {
  busy = state;
  document.querySelectorAll('.btn').forEach(b => { b.disabled = state; });
  renderBtn.disabled = state;
  killBtn.disabled = !state;
  // keep deploy button governed by its own confirm state too
  syncDeployBtn();
}

function syncDeployBtn() {
  if (busy) { deployBtn.disabled = true; return; }
  deployBtn.disabled = !deployConfirm.checked;
}

// --- populate paths + resume dropdown ---
async function init() {
  const paths = await window.api.getPaths();
  const pdiv = document.getElementById('paths');
  const wOk = paths.workerDirExists ? '' : ' <span class="bad">(missing!)</span>';
  const rOk = paths.resumeDirExists ? '' : ' <span class="bad">(missing!)</span>';
  pdiv.innerHTML =
    `<b>project root:</b> ${paths.projectRoot}<br>` +
    `<b>worker cwd:</b> ${paths.workerDir}${wOk}<br>` +
    `<b>résumé cwd:</b> ${paths.resumeDir}${rOk}`;

  document.getElementById('cwd-worker').textContent = paths.workerDir;
  document.getElementById('cwd-worker2').textContent = paths.workerDir;
  document.getElementById('cwd-resume').textContent = paths.resumeDir;

  // Populate the analyst tab dropdown from the shared tab-registry (same list the
  // tracker-analyst MCP server and Claude both use — one source of truth).
  const tabs = await window.api.listTabs();
  tabSelect.innerHTML = '';
  if (tabs.length === 0) {
    const opt = document.createElement('option');
    opt.textContent = 'no tabs found (check analyst/lib/tab-registry.js)';
    opt.value = '';
    tabSelect.appendChild(opt);
    analystBtn.disabled = true;
  } else {
    for (const t of tabs) {
      const opt = document.createElement('option');
      opt.value = t.id;
      opt.textContent = t.label;
      tabSelect.appendChild(opt);
    }
  }

  const maps = await window.api.listResumeMaps();
  mapSelect.innerHTML = '';
  if (maps.length === 0) {
    const opt = document.createElement('option');
    opt.textContent = 'no map_*.json found';
    opt.value = '';
    mapSelect.appendChild(opt);
    renderBtn.disabled = true;
  } else {
    for (const m of maps) {
      const opt = document.createElement('option');
      opt.value = m;
      opt.textContent = m;
      mapSelect.appendChild(opt);
    }
  }
}

// --- streaming wiring ---
window.api.onOutput(({ runId, stream, chunk }) => {
  if (runId !== activeRunId) return;
  if (stream === 'stderr') append(chunk, 'err');
  else if (stream === 'meta') append(chunk, 'meta');
  else append(chunk);
});

window.api.onExit(({ runId, code, error }) => {
  if (runId !== activeRunId) return;
  setBusy(false);
  if (code === 0) {
    append(`\n✔ exited with code 0\n\n`, 'exit-ok');
    setStatus('success', 'success (0)');
  } else {
    const suffix = error ? ` (${error})` : '';
    append(`\n✖ exited with code ${code}${suffix}\n\n`, 'exit-bad');
    setStatus('failed', `failed (${code})`);
  }
  activeRunId = null;
});

async function run(cwdToken, command, env) {
  if (busy) return;
  activeRunId = 'r' + Date.now() + Math.random().toString(16).slice(2);
  setBusy(true);
  setStatus('running', 'running…');
  const res = await window.api.runCommand({ runId: activeRunId, cwdToken, command, env });
  if (res && res.started === false) {
    // main already emitted an exit event; nothing else to do
  }
}

// --- generic buttons (data pipeline, verify, re-bundle) ---
document.querySelectorAll('.btn[data-cmd]').forEach(btn => {
  btn.addEventListener('click', () => {
    if (btn.id === 'deploy-btn') return; // handled separately
    run(btn.dataset.cwd, btn.dataset.cmd);
  });
});

// --- deploy button (guarded) ---
deployConfirm.addEventListener('change', syncDeployBtn);
deployBtn.addEventListener('click', () => {
  if (!deployConfirm.checked || busy) return;
  const ok = window.confirm(
    'Deploy to the LIVE Cloudflare site?\n\n' +
    'This runs `wrangler deploy` and publishes the current bundle to\n' +
    'internship-tracker.jz-tracker.workers.dev\n\n' +
    'Make sure build-data.js (and any re-bundle) has already run.'
  );
  if (!ok) return;
  // one-shot: uncheck after firing so it can't be double-clicked accidentally
  deployConfirm.checked = false;
  syncDeployBtn();
  run(deployBtn.dataset.cwd, deployBtn.dataset.cmd);
});

// --- resume render button ---
renderBtn.addEventListener('click', () => {
  const map = mapSelect.value;
  if (!map) return;
  // map_amzn_bu.json -> out_amzn_bu.docx
  const role = map.replace(/^map_/i, '').replace(/\.json$/i, '');
  const out = `out_${role}.docx`;
  run('resume', `python build.py ${map} ${out}`);
});

// --- analyst engine button — delegates through the tracker-analyst MCP connector ---
analystBtn.addEventListener('click', () => {
  const tab = tabSelect.value;
  if (!tab || busy) return;
  const limit = parseInt(limitInput.value, 10);
  let cmd = `node cli-bridge.js run_full_sweep --tab ${tab}`;
  if (Number.isFinite(limit) && limit > 0) cmd += ` --limit ${limit}`;
  if (!nimCheck.checked) cmd += ` --noNim`;
  if (!browseCheck.checked) cmd += ` --noBrowse`;
  const env = headedCheck.checked ? { ANALYST_HEADED: '1' } : undefined;
  run('analystMcp', cmd, env);
});

// --- console controls ---
clearBtn.addEventListener('click', () => { consoleEl.textContent = ''; });
killBtn.addEventListener('click', async () => {
  await window.api.killCommand();
});

init();

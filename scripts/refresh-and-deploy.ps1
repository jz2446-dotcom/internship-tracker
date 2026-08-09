# refresh-and-deploy.ps1
# Deterministic data refresh + deploy of the tracker site. ZERO model involvement.
#
# Steps (all in cloudflare-worker/):
#   1. node add-estimates.js   -> add acceptance_rate + competitiveness to every program
#   2. node build-data.js      -> combine data/*.json into src/data.json (+ changelog diff)
#   3. wrangler deploy         -> publish the Worker (LIVE site)  [gated by -Deploy]
#   4. verify                  -> curl /api/data and print the program counts
#
# This does NOT re-run web research (that needs a Claude run). It redeploys
# whatever is currently in data/*.json.
#
# Usage:
#   .\refresh-and-deploy.ps1            # build + verify, but SKIP deploy (safe default)
#   .\refresh-and-deploy.ps1 -Deploy    # also run wrangler deploy (asks to confirm)

param(
    [switch]$Deploy
)

. "$PSScriptRoot\_common.ps1"

Assert-Path $WorkerDir 'cloudflare-worker dir'

Run-Step -Dir $WorkerDir -Exe 'node' -Args @('add-estimates.js')
Run-Step -Dir $WorkerDir -Exe 'node' -Args @('build-data.js')

if ($Deploy) {
    & "$PSScriptRoot\deploy.ps1"
} else {
    Write-Host ""
    Write-Host "Skipped 'wrangler deploy' (run with -Deploy to publish, or use deploy.ps1)." -ForegroundColor Yellow
}

# Verify live data regardless (reads whatever is currently deployed).
& "$PSScriptRoot\verify.ps1"

Write-Host ""
Write-Host "refresh-and-deploy complete: $(Get-Date)" -ForegroundColor Green

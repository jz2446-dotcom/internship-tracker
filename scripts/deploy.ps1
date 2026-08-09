# deploy.ps1
# Publish the Worker to the LIVE site. Prompts for confirmation first.
# ZERO model involvement.
#
# NOTE: data is BUNDLED into the Worker (src/data.json + src/resumes.json).
# Do NOT push to KV (KV writes fail under the OAuth token; the Worker serves
# the bundle). Just `wrangler deploy`.
#
# Usage:
#   .\deploy.ps1            # confirm, then wrangler deploy
#   .\deploy.ps1 -Force     # deploy without the confirmation prompt

param(
    [switch]$Force
)

. "$PSScriptRoot\_common.ps1"

Assert-Path $WorkerDir 'cloudflare-worker dir'

if (-not $Force) {
    Write-Host ""
    Write-Host "You are about to deploy to the LIVE site:" -ForegroundColor Yellow
    Write-Host "    $SiteUrl" -ForegroundColor Yellow
    $ans = Read-Host "Type 'yes' to deploy"
    if ($ans -ne 'yes') {
        Write-Host "Aborted - nothing deployed." -ForegroundColor Red
        return
    }
}

Run-Step -Dir $WorkerDir -Exe 'wrangler' -Args @('deploy')

Write-Host ""
Write-Host "Deployed: $(Get-Date). Verifying..." -ForegroundColor Green
& "$PSScriptRoot\verify.ps1"

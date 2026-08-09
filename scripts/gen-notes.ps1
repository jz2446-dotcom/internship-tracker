# gen-notes.ps1
# Regenerate the Obsidian Applications/ notes from data/*.json.
# Preserves your personal fields (applied / stage / referral) + note bodies,
# matched by the program's 'key'. ZERO model involvement.
#
# Usage:
#   .\gen-notes.ps1

. "$PSScriptRoot\_common.ps1"

Assert-Path (Join-Path $WorkerDir 'gen-notes.js') 'gen-notes.js'

Run-Step -Dir $WorkerDir -Exe 'node' -Args @('gen-notes.js')

Write-Host ""
Write-Host "gen-notes complete: $(Get-Date)" -ForegroundColor Green

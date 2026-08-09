# _common.ps1 - shared setup dot-sourced by the other scripts.
# Defines repo paths and a Run-Step helper that echoes the dir + command,
# runs it, and stops on any non-zero exit.

$ErrorActionPreference = 'Stop'

# Repo root = parent of this scripts/ folder.
$RepoRoot     = Split-Path -Parent $PSScriptRoot
$WorkerDir    = Join-Path $RepoRoot 'cloudflare-worker'
$MasterDir    = Join-Path $RepoRoot 'Resumes\_master'
$SiteUrl      = 'https://internship-tracker.jz-tracker.workers.dev'

function Run-Step {
    param(
        [Parameter(Mandatory)][string]$Dir,
        [Parameter(Mandatory)][string]$Exe,
        [string[]]$Args = @()
    )
    Write-Host ""
    Write-Host "==> [$Dir]" -ForegroundColor Cyan
    Write-Host "    $Exe $($Args -join ' ')" -ForegroundColor Cyan
    Push-Location $Dir
    try {
        & $Exe @Args
        if ($LASTEXITCODE -ne $null -and $LASTEXITCODE -ne 0) {
            throw "Command failed (exit $LASTEXITCODE): $Exe $($Args -join ' ')"
        }
    }
    finally {
        Pop-Location
    }
}

function Assert-Path {
    param([Parameter(Mandatory)][string]$Path, [string]$What = 'path')
    if (-not (Test-Path $Path)) { throw "Missing $What`: $Path" }
}

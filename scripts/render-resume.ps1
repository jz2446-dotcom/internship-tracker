# render-resume.ps1
# Render a per-role resume from its map file, then MEASURE it with the accurate
# per-bullet line checker (measure_lines.py) so wrapped bullets are caught.
# ZERO model involvement (rendering is LibreOffice; measuring is PyMuPDF).
#
# Roles are the map_<role>.json / min_<role>.pdf suffixes, e.g.:
#   blackrock wf_fin wf_wim wf_comm amzn_bu amzn_ops amzn_acct bain pwc alix_tr alix_ide
#
# What it does per role:
#   1. python build.py map_<role>.json out_<role>.docx   (edit master -> render PDF)
#   2. python measure_lines.py out_<role>.pdf map_<role>.json  (per-bullet line count)
# The build step still prints its own PASS/CHECK, but measure_lines.py is the
# authoritative one-line-per-bullet verdict (build.py's own check has a known
# wrap blind spot - see SESSION-HANDOFF).
#
# Usage:
#   .\render-resume.ps1 blackrock          # render + measure one role
#   .\render-resume.ps1 -All               # render + measure every map_*.json
#   .\render-resume.ps1 blackrock -Bundle  # ...and re-bundle min_*.pdf -> resumes.json
#
# NOTE: -Bundle rewrites cloudflare-worker/src/resumes.json. It does NOT deploy.
#       Renders produce out_<role>.pdf; the deployed bundle uses min_<role>.pdf.
#       Regenerating min_*.pdf (font-subset/compress) is done inside the resume
#       run; this script measures out_*.pdf and, on -Bundle, packs whatever
#       min_*.pdf currently exist.

param(
    [string]$Role,
    [switch]$All,
    [switch]$Bundle
)

. "$PSScriptRoot\_common.ps1"

Assert-Path $MasterDir 'Resumes/_master dir'
Assert-Path (Join-Path $MasterDir 'build.py') 'build.py'
Assert-Path (Join-Path $MasterDir 'measure_lines.py') 'measure_lines.py'

# Resolve which roles to process.
$roles = @()
if ($All) {
    $roles = Get-ChildItem -Path $MasterDir -Filter 'map_*.json' |
        ForEach-Object { $_.BaseName -replace '^map_', '' }
    if ($roles.Count -eq 0) { throw "No map_*.json files found in $MasterDir" }
} elseif ($Role) {
    $roles = @($Role)
} else {
    throw "Specify a role (e.g. .\render-resume.ps1 blackrock) or -All."
}

foreach ($r in $roles) {
    $map = "map_$r.json"
    $mapPath = Join-Path $MasterDir $map
    Assert-Path $mapPath "map file for role '$r'"

    Write-Host ""
    Write-Host "################ ROLE: $r ################" -ForegroundColor Magenta
    Run-Step -Dir $MasterDir -Exe 'python' -Args @('build.py', $map, "out_$r.docx")
    Run-Step -Dir $MasterDir -Exe 'python' -Args @('measure_lines.py', "out_$r.pdf", $map)
}

if ($Bundle) {
    Write-Host ""
    Write-Host "Re-bundling min_*.pdf -> src/resumes.json ..." -ForegroundColor Cyan
    Run-Step -Dir $WorkerDir -Exe 'node' -Args @('bundle-resumes.js')
    Write-Host "Bundle updated. Next: node build-data.js  then  deploy.ps1" -ForegroundColor Yellow
}

Write-Host ""
Write-Host "render-resume complete: $(Get-Date)" -ForegroundColor Green

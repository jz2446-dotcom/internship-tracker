# verify.ps1
# Hit the live /api/data endpoint (cache-busted) and print a quick summary:
# total programs and the status breakdown. ZERO model involvement.
#
# Usage:
#   .\verify.ps1

. "$PSScriptRoot\_common.ps1"

$url = "$SiteUrl/api/data?cb=$(Get-Random)"
Write-Host ""
Write-Host "==> GET $url" -ForegroundColor Cyan

# Invoke-RestMethod parses JSON for us (portable across PowerShell 5.1 / 7).
$data = Invoke-RestMethod -Uri $url -Headers @{ 'Cache-Control' = 'no-cache' }

# Real shape: { last_updated, agents:{1..5}, sophomore, changelog }.
# Each agent value and sophomore have an .internships array. Flatten them all,
# but stay defensive in case the shape shifts.
$programs = @()
if ($data -is [System.Array]) {
    $programs = $data
} else {
    if ($data.agents) {
        # agents is an object keyed 1..5; each value has .internships.
        foreach ($p in $data.agents.PSObject.Properties) {
            $val = $p.Value
            if ($val.internships) { $programs += $val.internships }
            elseif ($val -is [System.Array]) { $programs += $val }
        }
    }
    if ($data.sophomore -and $data.sophomore.internships) {
        $programs += $data.sophomore.internships
    }
    if ($programs.Count -eq 0) {
        # Last-ditch: any nested object exposing a 'status' field.
        $programs = $data.PSObject.Properties.Value | Where-Object { $_.status }
    }
}

$total = ($programs | Measure-Object).Count
Write-Host ""
Write-Host "Total programs: $total" -ForegroundColor Green
if ($total -gt 0) {
    $programs | Group-Object status | Sort-Object Count -Descending |
        ForEach-Object { Write-Host ("  {0,-14} {1}" -f $_.Name, $_.Count) }
    $open = ($programs | Where-Object { $_.status -eq 'open' } | Measure-Object).Count
    Write-Host ""
    Write-Host "Open now: $open" -ForegroundColor Green
} else {
    Write-Host "(Could not parse program list from response - check the endpoint manually.)" -ForegroundColor Yellow
}

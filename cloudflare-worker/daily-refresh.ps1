# daily-refresh.ps1 — rebuild the data bundle and redeploy the site.
# This refreshes the DEPLOYMENT with whatever is in data/*.json. It does NOT re-run the
# web research (that needs a Claude run). Use this after data files are updated, or schedule
# it daily via Windows Task Scheduler if you only want a redeploy heartbeat.
#
# Schedule example (run once in an elevated PowerShell to register a 9am daily task):
#   $action  = New-ScheduledTaskAction -Execute "powershell.exe" -Argument '-File "C:\Users\justi\Downloads\Internship Searcher\Internship Tracker\cloudflare-worker\daily-refresh.ps1"'
#   $trigger = New-ScheduledTaskTrigger -Daily -At 9am
#   Register-ScheduledTask -TaskName "InternshipTrackerRefresh" -Action $action -Trigger $trigger

Set-Location "C:\Users\justi\Downloads\Internship Searcher\Internship Tracker\cloudflare-worker"
node build-data.js
wrangler deploy
Write-Host "Refresh complete: $(Get-Date)"

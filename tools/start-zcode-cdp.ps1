# Start ZCode desktop with a local CDP debugging port (for OpenAcom desktop mode).
# Usage: powershell -File start-zcode-cdp.ps1 [-Port 9222]
# Quit ZCode first (tray icon -> exit); this script will wait and then relaunch it.
param([int]$Port = 9222, [switch]$Force, [int]$DelaySec = 0)

$exe = "$env:LOCALAPPDATA\Programs\ZCode\ZCode.exe"
if (-not (Test-Path $exe)) { Write-Output "ERR: ZCode.exe not found at $exe"; exit 1 }

if ($DelaySec -gt 0) { Start-Sleep -Seconds $DelaySec }

$running = Get-Process -Name ZCode -ErrorAction SilentlyContinue
if ($running -and -not $Force) {
  Write-Output 'ZCode is still running - quit it fully first (tray icon -> Exit), rerun, or add -Force.'
  $running | ForEach-Object { "  still alive: pid $($_.Id)" }
  exit 2
}
if ($running) {
  $running | Stop-Process -Force
  Start-Sleep -Seconds 2
}

Start-Process -FilePath $exe -ArgumentList "--remote-debugging-port=$Port"
Write-Output "launched with --remote-debugging-port=$Port"
Start-Sleep -Seconds 4
try {
  $targets = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/json" -TimeoutSec 5
  Write-Output ("CDP OK: {0} targets" -f $targets.Count)
} catch {
  Write-Output "WARN: CDP port not responding yet ($($_.Exception.Message))"
}

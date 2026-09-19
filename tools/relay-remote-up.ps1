# Bring up remote access to the local OpenAcom MCP:
#   1) streamable-http MCP server on 127.0.0.1:9322 (if not already running)
#   2) SSH reverse tunnel <server>:9321 -> this machine:9322 (if not already up)
# Local 9321 is owned by the Orca desktop app now, so openacom listens on
# 9322 and the tunnel maps the remote's unchanged 9321 onto it. The remote
# machine's Claude still uses http://127.0.0.1:9321/mcp.
# Usage: powershell -File relay-remote-up.ps1 [-SshHost root@host] [-LocalPort 9322] [-RemotePort 9321]
param([string]$SshHost = 'root@156.238.253.180', [int]$LocalPort = 9322, [int]$RemotePort = 9321)

$ErrorActionPreference = 'Continue'
$repo = Split-Path -Parent $PSScriptRoot
$logDir = "$env:USERPROFILE\.openacom\logs"
New-Item -ItemType Directory -Force -Path $logDir | Out-Null

# 1) HTTP MCP server (local port 9322; 9321 belongs to Orca now)
$alive = $false
try {
  $h = Invoke-RestMethod "http://127.0.0.1:$LocalPort/health" -TimeoutSec 2
  $alive = ($h.ok -eq $true) -and ($h.server -eq 'openacom')
} catch {}
if (-not $alive) {
  $log = "$logDir\mcp-http.log"
  Start-Process -WindowStyle Hidden node -ArgumentList "`"$repo\bin\openacom.js`" mcp-http $LocalPort" -RedirectStandardError "$log.err" -RedirectStandardOutput "$log.out"
  Start-Sleep -Seconds 2
  try {
    $h = Invoke-RestMethod "http://127.0.0.1:$LocalPort/health" -TimeoutSec 3
    $alive = ($h.ok -eq $true) -and ($h.server -eq 'openacom')
  } catch {}
}
Write-Output ("mcp-http: " + ($(if ($alive) { "up on 127.0.0.1:$LocalPort" } else { "FAILED to start (check $logDir\mcp-http.log)" })))

# 2) reverse tunnel: remote 127.0.0.1:$RemotePort -> local 127.0.0.1:$LocalPort
# (idempotent-ish: dup tunnels are harmless but noisy)
$tun = Get-CimInstance Win32_Process -Filter "Name='ssh.exe'" | Where-Object { $_.CommandLine -match "-R.*$RemotePort.*:$LocalPort" -and $_.CommandLine -match [regex]::Escape($SshHost) }
if (-not $tun) {
  ssh -o BatchMode=yes -o ExitOnForwardFailure=yes -f -N -R "127.0.0.1:${RemotePort}:127.0.0.1:${LocalPort}" $SshHost
  Start-Sleep -Seconds 1
  $tun = Get-CimInstance Win32_Process -Filter "Name='ssh.exe'" | Where-Object { $_.CommandLine -match "-R.*$RemotePort.*:$LocalPort" -and $_.CommandLine -match [regex]::Escape($SshHost) }
}
Write-Output ("tunnel: " + ($(if ($tun) { "up ($SshHost):$RemotePort -> local:$LocalPort" } else { "FAILED (ssh $SshHost reachable? key auth set up?)" })))

# Bring up remote access to the local AgentRelay MCP:
#   1) streamable-http MCP server on 127.0.0.1:9321 (if not already running)
#   2) SSH reverse tunnel <server>:9321 -> this machine:9321 (if not already up)
# The remote machine's Claude then uses http://127.0.0.1:9321/mcp.
# Usage: powershell -File relay-remote-up.ps1 [-SshHost root@host] [-Port 9321]
param([string]$SshHost = 'root@156.238.253.180', [int]$Port = 9321)

$ErrorActionPreference = 'Continue'
$repo = Split-Path -Parent $PSScriptRoot
$logDir = "$env:USERPROFILE\.agentrelay\logs"
New-Item -ItemType Directory -Force -Path $logDir | Out-Null

# 1) HTTP MCP server
$alive = $false
try { $alive = (Invoke-RestMethod "http://127.0.0.1:$Port/health" -TimeoutSec 2).ok -eq $true } catch {}
if (-not $alive) {
  $log = "$logDir\mcp-http.log"
  Start-Process -WindowStyle Hidden node -ArgumentList "`"$repo\bin\agentrelay.js`" mcp-http $Port" -RedirectStandardError $log -RedirectStandardOutput $log
  Start-Sleep -Seconds 2
  try { $alive = (Invoke-RestMethod "http://127.0.0.1:$Port/health" -TimeoutSec 3).ok -eq $true } catch {}
}
Write-Output ("mcp-http: " + ($(if ($alive) { "up on 127.0.0.1:$Port" } else { "FAILED to start (check $logDir\mcp-http.log)" })))

# 2) reverse tunnel (idempotent-ish: reuse ControlMaster-less -f; dup tunnels are harmless but noisy)
$tun = Get-CimInstance Win32_Process -Filter "Name='ssh.exe'" | Where-Object { $_.CommandLine -match "-R.*$Port" }
if (-not $tun) {
  ssh -o BatchMode=yes -o ExitOnForwardFailure=yes -f -N -R "127.0.0.1:${Port}:127.0.0.1:${Port}" $SshHost
  Start-Sleep -Seconds 1
  $tun = Get-CimInstance Win32_Process -Filter "Name='ssh.exe'" | Where-Object { $_.CommandLine -match "-R.*$Port" }
}
Write-Output ("tunnel: " + ($(if ($tun) { "up ($SshHost):$Port -> local:$Port" } else { "FAILED (ssh $SshHost reachable? key auth set up?)" })))

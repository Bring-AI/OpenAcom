# Launch the ZCode desktop with CDP. Never terminate CLI or helper processes by image name.
param(
    [ValidateRange(1,65535)][int]$Port = 9222,
    [switch]$Force,
    [ValidateRange(0,30)][int]$DelaySec = 0,
    [switch]$Inspect,
    [switch]$LibraryOnly
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)

function Get-ZcodeDesktopCandidates {
    param([object[]]$Processes, [string]$Executable)
    @($Processes | Where-Object {
        $_.ExecutablePath -and $_.ExecutablePath -ieq $Executable -and
        -not [string]::IsNullOrWhiteSpace($_.CommandLine) -and
        $_.CommandLine -notmatch '(?i)--type=' -and
        $_.CommandLine -notmatch '(?i)(?:^|\s)(?:-[ep](?:\s|$)|--(?:eval|print|version|help)(?:[=\s]|$))' -and
        $_.CommandLine -notmatch '(?i)\.(cjs|mjs|js)(["\s]|$)' -and
        $_.CommandLine -notmatch '(?i)(app-server|__zcode-plugin-host|cua-helper)'
    })
}
if ($LibraryOnly) { return }

$exe = Join-Path $env:LOCALAPPDATA 'Programs/ZCode/ZCode.exe'
if (-not (Test-Path -LiteralPath $exe)) { throw "ZCode.exe not found: $exe" }
$roots = @(Get-ZcodeDesktopCandidates -Processes @(Get-CimInstance Win32_Process -Filter "Name='ZCode.exe'") -Executable $exe)
if ($Inspect) {
    [pscustomobject]@{
        executable = $exe
        desktopCount = $roots.Count
        desktopPids = @($roots | ForEach-Object { $_.ProcessId })
        debugPortEnabled = @($roots | Where-Object { $_.CommandLine -match "--remote-debugging-port[= ]$Port(\s|$)" }).Count -gt 0
        port = $Port
    } | ConvertTo-Json -Compress
    return
}
if ($DelaySec -gt 0) { Start-Sleep -Seconds $DelaySec }
if ($roots.Count -gt 1) { throw 'Multiple ZCode desktop instances exist. No process was stopped; select the intended desktop by closing it first.' }
if ($roots.Count -eq 1 -and -not $Force) { throw 'ZCode desktop is running. Restart needs explicit confirmation (-Force); no process was stopped.' }
if ($roots.Count -eq 1) {
    # -Force is the operator's explicit approval to restart this uniquely identified desktop.
    $desktopPid = [int]$roots[0].ProcessId
    $desktop = Get-Process -Id $desktopPid
    if ($desktop.MainWindowHandle -eq 0) { throw 'No desktop window could be verified. Open or quit ZCode from its tray menu first; no process was stopped.' }
    Stop-Process -Id $desktopPid -Force
    $deadline = [DateTime]::UtcNow.AddSeconds(8)
    while ((Get-Process -Id $desktopPid -ErrorAction SilentlyContinue) -and [DateTime]::UtcNow -lt $deadline) { Start-Sleep -Milliseconds 200 }
    if (Get-Process -Id $desktopPid -ErrorAction SilentlyContinue) { throw 'The desktop did not stop; a second instance was not launched.' }
}
$started = Start-Process -FilePath $exe -ArgumentList @('--remote-debugging-address=127.0.0.1', "--remote-debugging-port=$Port") -PassThru
Write-Output "Started ZCode desktop PID $($started.Id) with CDP port $Port."
$ready = $false
$deadline = [DateTime]::UtcNow.AddSeconds(15)
do {
    try { $version = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/json/version" -TimeoutSec 1; if ($version.Browser) { $ready = $true; break } } catch { }
    Start-Sleep -Milliseconds 300
} while ([DateTime]::UtcNow -lt $deadline)
if (-not $ready) { throw "The desktop started, but CDP is not answering on 127.0.0.1:$Port. Check desktop startup before retrying delivery." }
Write-Output "CDP is answering on 127.0.0.1:$Port. Run the identity check before sending."

param([string]$Destination)
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
if (-not $Destination) { $Destination = Join-Path $repo 'artifacts/OpenAcom-Desktop' }
$Destination = [System.IO.Path]::GetFullPath($Destination)
& (Join-Path $PSScriptRoot 'build.cmd')
if ($LASTEXITCODE -ne 0) { throw 'Desktop compilation failed' }
New-Item -ItemType Directory -Force -Path $Destination | Out-Null
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'openacom-desktop.exe') -Destination (Join-Path $Destination 'OpenAcom.exe') -Force
foreach ($file in @('bridge.js','control-api.js','service-host.js','fleet-api.js','remote-agent.js','remote-node-worker.js')) { Copy-Item -LiteralPath (Join-Path $PSScriptRoot $file) -Destination $Destination -Force }
foreach ($module in @('node-pty','node-addon-api')) { $source = Join-Path $repo ('node_modules/' + $module); if (Test-Path -LiteralPath $source) { New-Item -ItemType Directory -Force -Path (Join-Path $Destination 'node_modules') | Out-Null; Copy-Item -LiteralPath $source -Destination (Join-Path $Destination 'node_modules') -Recurse -Force } }
Copy-Item -LiteralPath (Join-Path $repo 'package.json') -Destination $Destination -Force
foreach ($folder in @('lib','tools','bin')) { Copy-Item -LiteralPath (Join-Path $repo $folder) -Destination $Destination -Recurse -Force }
$nodeExecutable = (Get-Command node.exe -ErrorAction Stop).Source
Copy-Item -LiteralPath $nodeExecutable -Destination (Join-Path $Destination 'node.exe') -Force
$license = Join-Path (Split-Path -Parent $nodeExecutable) 'LICENSE'
if (Test-Path -LiteralPath $license) {
    Copy-Item -LiteralPath $license -Destination (Join-Path $Destination 'NODE-LICENSE.txt') -Force
} else {
    $nodeVersion = & $nodeExecutable --version
    Invoke-WebRequest -Uri ('https://raw.githubusercontent.com/nodejs/node/' + $nodeVersion + '/LICENSE') -OutFile (Join-Path $Destination 'NODE-LICENSE.txt')
}
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'README.md') -Destination $Destination -Force
$zipPath = $Destination + '.zip'
Compress-Archive -Path $Destination -DestinationPath $zipPath -Force
Write-Output "Desktop: $Destination"
Write-Output "Archive: $zipPath"


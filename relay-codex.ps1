param([ValidateSet('read','reply')][string]$Action='read',[string]$Message)
$root = Join-Path $PSScriptRoot 'relay'; $in=Join-Path $root 'to-codex.jsonl'; $out=Join-Path $root 'to-claude.jsonl'
if($Action -eq 'read'){ if(Test-Path $in){Get-Content $in -Encoding UTF8} }
else { if(-not $Message){throw '请提供 -Message'}; $o=[ordered]@{time=(Get-Date).ToUniversalTime().ToString('o');message=$Message}; ($o|ConvertTo-Json -Compress) | Add-Content $out -Encoding UTF8; '已写入 Claude 回复队列' }

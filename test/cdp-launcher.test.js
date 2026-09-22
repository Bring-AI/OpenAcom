'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {spawnSync}=require('node:child_process');
const path=require('node:path');

test('CDP restart classifies only desktop roots, excluding CLI, eval, renderers and helper processes', {skip:process.platform!=='win32'},()=>{
 const script=path.resolve(__dirname,'../tools/start-zcode-cdp.ps1').replace(/'/g,"''");
 const code=`. '${script}' -LibraryOnly
 $exe='C:\\ZCode\\ZCode.exe'
 $rows=@(
 [pscustomobject]@{ProcessId=1;ExecutablePath=$exe;CommandLine='"C:\\ZCode\\ZCode.exe" --updated'},
 [pscustomobject]@{ProcessId=2;ExecutablePath=$exe;CommandLine='"C:\\ZCode\\ZCode.exe" --type=renderer'},
 [pscustomobject]@{ProcessId=3;ExecutablePath=$exe;CommandLine='"C:\\ZCode\\ZCode.exe" C:\\app\\zcode.cjs app-server --stdio'},
 [pscustomobject]@{ProcessId=4;ExecutablePath=$exe;CommandLine='"C:\\ZCode\\ZCode.exe" -e "process.stdin.resume()"'},
 [pscustomobject]@{ProcessId=5;ExecutablePath=$exe;CommandLine='"C:\\ZCode\\ZCode.exe" C:\\tools\\windows-helper.js'},
 [pscustomobject]@{ProcessId=6;ExecutablePath='C:\\Other\\ZCode.exe';CommandLine='"C:\\Other\\ZCode.exe" --updated'}
 )
 @(Get-ZcodeDesktopCandidates -Processes $rows -Executable $exe | ForEach-Object { $_.ProcessId }) | ConvertTo-Json -Compress
 `;
 const result=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',code],{encoding:'utf8',windowsHide:true,timeout:10000});
 assert.equal(result.status,0,result.stderr);assert.equal(JSON.parse(result.stdout),1);
});

# AgentRelay desktop-mode sender for ZCode (Windows only).
# Drives the real ZCode desktop UI: selects the session in the sidebar, types the
# message into the composer and presses Enter. The turn runs inside the desktop
# app, so its window live-updates and the message chain stays native.
#
# Focus: typing needs the ZCode window in the foreground; the script activates it
# (brief focus steal). If Windows' foreground lock blocks activation, exit code 3.
# NOTE: keep this file ASCII-only; PowerShell 5.1 misreads BOM-less UTF-8 as ANSI.

param([string]$TitleB64 = '', [string]$MessageB64 = '', [switch]$DryRun)

$Title = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($TitleB64))
$Message = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($MessageB64))

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName System.Windows.Forms

Add-Type @'
using System;
using System.Runtime.InteropServices;
public class FGWin {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
}
'@

# Composer title patterns contain Chinese; built from char code points so this
# file stays pure ASCII.
function Decode-Codes([int[]]$codes) { -join ($codes | ForEach-Object { [char]$_ }) }
$pAsk    = Decode-Codes @(0x5411) + ' ZCode ' + Decode-Codes @(0x63D0, 0x95EE)
$pQueue  = Decode-Codes @(0x7EE7, 0x7EED, 0x8F93, 0x5165)
$pFollow = Decode-Codes @(0x63D0, 0x51FA, 0x540E, 0x7EED, 0x4FEE, 0x6539)
$pSay    = Decode-Codes @(0x8BF4, 0x70B9, 0x4EC0, 0x4E48)
$composerRe = $pAsk + '|' + $pQueue + '|' + $pFollow + '|' + $pSay

$procs = Get-Process -Name ZCode -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 }
if (-not $procs) { Write-Output 'ERR: no ZCode window found (is the desktop app running?)'; exit 2 }

$root = [System.Windows.Automation.AutomationElement]::RootElement
$prefix = $Title.Trim()
if ($prefix.Length -gt 24) { $prefix = $prefix.Substring(0, 24) }

$targetWindow = $null; $targetRow = $null
foreach ($p in $procs) {
  $cond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ProcessIdProperty, $p.Id)
  $wins = $root.FindAll([System.Windows.Automation.TreeScope]::Children, $cond)
  foreach ($w in $wins) {
    $rows = $w.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
    foreach ($r in $rows) {
      $n = $r.Current.Name
      if ($n -and $n.StartsWith($prefix) -and $n.Length -le ($prefix.Length + 8)) {
        $targetWindow = $w; $targetRow = $r; break
      }
    }
    if ($targetRow) { break }
  }
  if ($targetRow) { break }
}
if (-not $targetRow) { Write-Output "ERR: session row not found in ZCode sidebar for title: $Title"; exit 4 }

if ($DryRun) {
  Write-Output ("OK dry-run: window='{0}' row='{1}'" -f $targetWindow.Current.Name, $targetRow.Current.Name)
  exit 0
}

# --- activate the window (focus steal is inherent to desktop mode) ---
$h = [IntPtr]$targetWindow.Current.NativeWindowHandle
[FGWin]::ShowWindow($h, 9) | Out-Null
[FGWin]::SetForegroundWindow($h) | Out-Null
Start-Sleep -Milliseconds 400
$fgPid = 0
[FGWin]::GetWindowThreadProcessId([FGWin]::GetForegroundWindow(), [ref]$fgPid) | Out-Null
if ($fgPid -ne $targetWindow.Current.ProcessId) {
  [FGWin]::SetForegroundWindow($h) | Out-Null
  Start-Sleep -Milliseconds 400
  [FGWin]::GetWindowThreadProcessId([FGWin]::GetForegroundWindow(), [ref]$fgPid) | Out-Null
}
if ($fgPid -ne $targetWindow.Current.ProcessId) {
  Write-Output 'ERR: could not bring ZCode to the foreground (Windows foreground lock - retry when not typing in another window)'; exit 3
}

# --- select the session row ---
$did = $false
try { $pat = $targetRow.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern); $pat.Invoke(); $did = $true } catch {}
if (-not $did) { try { $pat = $targetRow.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern); $pat.Select(); $did = $true } catch {} }
if (-not $did) { Write-Output 'ERR: cannot invoke the session row'; exit 5 }
Start-Sleep -Milliseconds 900

# --- find the composer of the opened conversation ---
$composer = $null
$all = $targetWindow.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
foreach ($e in $all) {
  $n = $e.Current.Name
  if ($n -and $n -match $composerRe) { $composer = $e; break }
}
if (-not $composer) { Write-Output 'ERR: composer textbox not found after opening the session'; exit 6 }

# --- type: clipboard paste (safe for arbitrary text), then Enter ---
$composer.SetFocus()
Start-Sleep -Milliseconds 300
Set-Clipboard -Value $Message
[System.Windows.Forms.SendKeys]::SendWait('^v')
Start-Sleep -Milliseconds 400
[System.Windows.Forms.SendKeys]::SendWait('{ENTER}')
Start-Sleep -Milliseconds 300
Write-Output 'OK sent via desktop UI'

param(
  [Parameter(Mandatory=$true)][string]$Message,
  [string]$SessionTitle,
  [switch]$Send
)

Add-Type @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class Win32 {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr p);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr hWnd, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
}
'@
Add-Type -AssemblyName System.Windows.Forms

$windows = [System.Collections.Generic.List[object]]::new()
[Win32]::EnumWindows({ param($h,$p)
  if ([Win32]::IsWindowVisible($h)) {
    $b = New-Object Text.StringBuilder 512
    [void][Win32]::GetWindowText($h,$b,$b.Capacity)
    if ($b.ToString() -match '(?i)Claude') { $windows.Add([pscustomobject]@{Handle=$h;Title=$b.ToString()}) }
  }; return $true
}, [IntPtr]::Zero) | Out-Null

if ($windows.Count -eq 0) { throw '未找到 Claude Desktop 窗口。请先启动 Claude Desktop。' }
$target = if ($SessionTitle) {
  $windows | Where-Object { $_.Title -like "*$SessionTitle*" } | Select-Object -First 1
} else { $windows | Select-Object -First 1 }
if (-not $target) { throw "未找到标题包含 '$SessionTitle' 的 Claude 窗口；请先打开目标 session。" }

[Win32]::SetForegroundWindow($target.Handle) | Out-Null
Start-Sleep -Milliseconds 250
[Windows.Forms.Clipboard]::SetText($Message)
[Windows.Forms.SendKeys]::SendWait('^v')
Start-Sleep -Milliseconds 100
if ($Send) { [Windows.Forms.SendKeys]::SendWait('{ENTER}') }

Write-Output ("已填入 Claude session: {0}" -f $target.Title)
if ($Send) { Write-Output '消息已发送。' } else { Write-Output '消息停留在输入框；加 -Send 才会发送。' }

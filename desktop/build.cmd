@echo off
rem OpenAcom Desktop build - uses the C# compiler that already ships with
rem Windows. Nothing is downloaded and no toolchain is installed.
rem The in-box csc.exe is a C# 5 compiler, so OpenAcomDesktop.cs stays C# 5.
setlocal EnableExtensions
set "HERE=%~dp0"
set "SRC=%HERE%OpenAcomDesktop.cs"
set "OUT=%HERE%openacom-desktop.exe"

set "CSC=%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe"
if not exist "%CSC%" set "CSC=%WINDIR%\Microsoft.NET\Framework\v4.0.30319\csc.exe"
if not exist "%CSC%" set "CSC=%ProgramFiles(x86)%\MSBuild\14.0\Bin\csc.exe"
if not exist "%CSC%" set "CSC=%ProgramFiles%\Microsoft Visual Studio\2022\Community\MSBuild\Current\Bin\Roslyn\csc.exe"
if not exist "%CSC%" set "CSC=%ProgramFiles(x86)%\Microsoft Visual Studio\2019\BuildTools\MSBuild\Current\Bin\Roslyn\csc.exe"
if not exist "%CSC%" (
  echo build-desktop: no C# compiler found; looked for the in-box .NET Framework csc.exe 1>&2
  exit /b 2
)
if not exist "%SRC%" (
  echo build-desktop: missing source %SRC% 1>&2
  exit /b 2
)

echo build-desktop: compiler "%CSC%"
"%CSC%" /nologo /optimize+ /debug- /target:winexe /codepage:65001 /out:"%OUT%" /r:System.dll /r:System.Core.dll /r:System.Drawing.dll /r:System.Windows.Forms.dll /r:System.Security.dll /r:System.Xaml.dll /r:"%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\WPF\WindowsBase.dll" /r:"%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\WPF\PresentationCore.dll" /r:"%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\WPF\PresentationFramework.dll" /resource:"%HERE%ModernShell.xaml",ModernShell.xaml "%SRC%" "%HERE%ModernDesktop.cs" "%HERE%Dashboard.cs" "%HERE%ControlCenter.cs" "%HERE%FleetConsole.cs" "%HERE%SessionViews.cs"
if errorlevel 1 (
  echo build-desktop: compile failed 1>&2
  exit /b 1
)
for %%F in ("%OUT%") do echo build-desktop: wrote %%~fF (%%~zF bytes)
exit /b 0



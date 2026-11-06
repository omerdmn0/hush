@echo off
rem Builds hush-audio-capture.exe with MSVC (GitHub Actions' windows-latest has it).
setlocal
for /f "usebackq tokens=*" %%i in (`"%ProgramFiles(x86)%\Microsoft Visual Studio\Installer\vswhere.exe" -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath`) do set "VS=%%i"
if not defined VS (
  echo Visual Studio C++ tools not found
  exit /b 1
)
call "%VS%\VC\Auxiliary\Build\vcvars64.bat" || exit /b 1
if not exist native\windows\out mkdir native\windows\out
cl /nologo /EHsc /O2 /W4 /MT native\windows\hush-audio-capture.cpp /Fo:native\windows\out\ /Fe:native\windows\out\hush-audio-capture.exe /link ole32.lib mmdevapi.lib || exit /b 1

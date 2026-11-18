@echo off
setlocal
rem Usage: Install.cmd [-SkipCodex]
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\install.ps1" %*
set "setup_result=%errorlevel%"
if "%~1"=="" pause
exit /b %setup_result%

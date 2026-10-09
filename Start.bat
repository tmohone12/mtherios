@echo off
pwsh -NoProfile -File "%~dp0start.ps1" %*
if errorlevel 1 (
  pause
  exit /b 1
)

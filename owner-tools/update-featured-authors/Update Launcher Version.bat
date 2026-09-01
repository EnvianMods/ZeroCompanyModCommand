@echo off
cd /d "%~dp0"
if "%~1"=="" (
  echo Usage: "Update Launcher Version.bat" 1.2.0 https://download-page-url
  echo        add --notes "what's new" for banner text, or --show to see current.
  pause
  exit /b 1
)
node update-launcher-version.js %*
pause

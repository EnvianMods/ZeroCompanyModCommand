@echo off
cd /d "%~dp0"
if "%~1"=="" (
  echo Usage: "Publish Release.bat" 1.2.0 "path\to\ZeroCompanyModCommand-v1.2.0.zip" --notes "what's new"
  echo        creates the GitHub Release, uploads the zip, and announces to all launchers.
  echo        add --show to list existing releases.
  pause
  exit /b 1
)
node publish-release.js %*
pause

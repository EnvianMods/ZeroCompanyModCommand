@echo off
cd /d "%~dp0"
if "%~1"=="" (
  echo Usage: "Archive Release.bat" 1.0.0 "path\to\build.zip" "path\to\source.zip" --notes "..."
  echo        pushes the version archive to github.com/EnvianMods/ZeroCompanyModCommandArchive
  echo        add --show to list archived versions.
  pause
  exit /b 1
)
node archive-release.js %*
pause

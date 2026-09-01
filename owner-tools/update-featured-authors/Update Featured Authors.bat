@echo off
cd /d "%~dp0"
if "%~1"=="" (
  echo Usage: "Update Featured Authors.bat" AuthorName [AuthorName ...]
  echo Example: "Update Featured Authors.bat" SmexyXey EnvianMN
  echo.
  echo Add --show to see the currently published roster.
  pause
  exit /b 1
)
node update-featured-authors.js %*
pause

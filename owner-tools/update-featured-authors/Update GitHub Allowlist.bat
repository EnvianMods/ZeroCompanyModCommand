@echo off
cd /d "%~dp0"
if "%~1"=="" (
  echo Usage: "Update GitHub Allowlist.bat" Owner/Repo [Owner/Repo ...]
  echo Example: "Update GitHub Allowlist.bat" Sternab/ZeroCompanyMandoWardrobe
  echo.
  echo Add --show to see the currently published allowlist.
  pause
  exit /b 1
)
node update-github-allowlist.js %*
pause

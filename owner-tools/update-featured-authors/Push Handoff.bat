@echo off
cd /d "%~dp0"
echo Pushing HANDOFF.md to github.com/EnvianMods/ZeroCompanyModCommandArchive (docs/HANDOFF.md, branch main)
echo   add --show to compare the local file with the archived copy without pushing.
node push-handoff.js %*
pause

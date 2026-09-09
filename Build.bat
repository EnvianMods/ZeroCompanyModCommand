@echo off
setlocal EnableExtensions
title Zero Company Mod Command - build from source
cd /d "%~dp0"
echo.
echo  ZERO COMPANY MOD COMMAND - build from source
echo  ============================================
echo  Builds the portable ZeroCompanyModCommand.exe on your own PC from the source
echo  in this folder - the same source as github.com/EnvianMods/ZeroCompanyModCommand.
echo  Needs Node.js 20 or newer and an internet connection. Takes 2-5 minutes.
echo.
where node >nul 2>nul || goto :noNode
where npm  >nul 2>nul || goto :noNode
for /f "delims=" %%v in ('node --version') do set "NODEVER=%%v"
echo  [1/3] Node.js %NODEVER% found.
echo  [2/3] Installing build dependencies - Electron and electron-builder, about 150 MB, once...
if exist package-lock.json (
  call npm ci --no-audit --no-fund --loglevel=error
) else (
  call npm install --no-audit --no-fund --loglevel=error
)
if errorlevel 1 goto :npmFail
echo  [3/3] Fetching bundled tools and building the exe...
call npm run build-exe
if errorlevel 1 goto :buildFail
if not exist "release\ZeroCompanyModCommand.exe" goto :buildFail
copy /y "release\ZeroCompanyModCommand.exe" "ZeroCompanyModCommand.exe" >nul
echo.
echo  DONE. ZeroCompanyModCommand.exe is now in this folder - run it from here.
echo  It keeps its data in %%APPDATA%%\ZeroCompanyModCommand, so updates never touch your mods.
echo.
if defined ZC_BUILD_QUIET exit /b 0
start "" explorer.exe "%~dp0"
pause
exit /b 0

:noNode
echo.
echo  Node.js was not found. Install the LTS version from https://nodejs.org/ - accept the
echo  defaults - then run Build.bat again. Nothing else is needed.
echo.
pause
exit /b 1

:npmFail
echo.
echo  Installing the build dependencies failed. Check your internet connection and run
echo  Build.bat again. If it keeps failing, delete the node_modules folder first.
echo.
pause
exit /b 1

:buildFail
echo.
echo  The build did not produce release\ZeroCompanyModCommand.exe. Scroll up for the error.
echo  Running Build.bat again usually fixes an interrupted download.
echo.
pause
exit /b 1

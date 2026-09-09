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
echo  [1/4] Node.js %NODEVER% found.

echo  [2/4] Installing build dependencies - Electron and electron-builder, about 150 MB, once...
if exist package-lock.json (
  call npm ci --no-audit --no-fund --loglevel=error
) else (
  call npm install --no-audit --no-fund --loglevel=error
)
if errorlevel 1 goto :npmFail

echo  [3/4] Fetching the bundled tools that are not shipped inside the source zip...
call :tools

echo  [4/4] Building the portable exe with electron-builder...
call npx electron-builder --win portable --publish never
if errorlevel 1 goto :buildFail
if not exist "release\ZeroCompanyModCommand.exe" goto :buildFail
copy /y "release\ZeroCompanyModCommand.exe" "ZeroCompanyModCommand.exe" >nul
echo.
echo  DONE. ZeroCompanyModCommand.exe is now in this folder - run it from here.
echo  It keeps its data in %%APPDATA%%\ZeroCompanyModCommand, so updates never touch your mods.
echo  You can delete the node_modules and release folders afterwards, or keep them so
echo  the next rebuild is faster.
echo.
if defined ZC_BUILD_QUIET exit /b 0
start "" explorer.exe "%~dp0"
pause
exit /b 0

:tools
if not exist tools mkdir tools

rem --- 7-Zip 25.01 for .7z / .rar mod archives. Official MSI, unpacked with an
rem --- administrative install into a temp folder - nothing is installed system-wide.
if not exist "tools\7-Zip\7z.exe" (
  echo     - 7-Zip 25.01 ...
  if exist "%TEMP%\zc-7z" rmdir /s /q "%TEMP%\zc-7z"
  curl.exe -sL -o "%TEMP%\zc-7z.msi" https://www.7-zip.org/a/7z2501-x64.msi
  if exist "%TEMP%\zc-7z.msi" start "" /wait msiexec.exe /a "%TEMP%\zc-7z.msi" /qn TARGETDIR="%TEMP%\zc-7z"
  if exist "%TEMP%\zc-7z\Files\7-Zip\7z.exe" (
    if not exist "tools\7-Zip" mkdir "tools\7-Zip"
    copy /y "%TEMP%\zc-7z\Files\7-Zip\7z.exe" "tools\7-Zip\" >nul
    copy /y "%TEMP%\zc-7z\Files\7-Zip\7z.dll" "tools\7-Zip\" >nul
    copy /y "%TEMP%\zc-7z\Files\7-Zip\License.txt" "tools\7-Zip\" >nul
  )
  if exist "tools\7-Zip\7z.exe" (echo       ok) else (echo       skipped - .7z and .rar mods will need 7-Zip installed)
)

rem --- retoc 0.1.5: lists the files inside pak / iostore mods for conflict detection.
if not exist "tools\retoc.exe" (
  echo     - retoc 0.1.5 ...
  rem System32\tar.exe is bsdtar, which reads zips; a GNU tar earlier on PATH would not.
  curl.exe -sL -o "%TEMP%\zc-retoc.zip" https://github.com/trumank/retoc/releases/download/v0.1.5/retoc_cli-x86_64-pc-windows-msvc.zip
  if exist "%TEMP%\zc-retoc.zip" "%SystemRoot%\System32\tar.exe" -xf "%TEMP%\zc-retoc.zip" -C tools retoc.exe
  if exist "tools\retoc.exe" (echo       ok) else (echo       skipped - pak content listing will be unavailable)
)

rem --- ZCSDK Runtime: the newest release becomes the offline copy. The app also
rem --- fetches it from GitHub on demand, so this one is optional.
if not exist "tools\ZCSDKRuntime.zip" (
  echo     - ZCSDK Runtime ...
  powershell -NoProfile -ExecutionPolicy Bypass -Command "try { $j = Invoke-RestMethod 'https://raw.githubusercontent.com/EnvianMods/ZCSDK-Runtime-Release/main/latest.json'; Invoke-WebRequest $j.url -OutFile 'tools\ZCSDKRuntime.zip'; @{ version = $j.version; bridge = $j.bridge; loader = $j.loader; file = 'ZCSDKRuntime.zip'; source = 'EnvianMods/ZCSDK-Runtime-Release ' + $j.version + ' (fetched by Build.bat)' } | ConvertTo-Json | Set-Content -Encoding UTF8 'tools\zcsdk-runtime.json' } catch { }"
  if exist "tools\ZCSDKRuntime.zip" (echo       ok) else (echo       skipped - the app downloads it from GitHub when needed)
)

rem --- Oodle: the game's own oo2core_9_win64.dll lets retoc read Oodle-compressed
rem --- paks. Copied from the game folder when it is there; otherwise skipped.
if not exist "tools\oo2core_9_win64.dll" (
  for %%d in (
    "%ProgramFiles(x86)%\Steam\steamapps\common\Star Wars Zero Company"
    "C:\SteamLibrary\steamapps\common\Star Wars Zero Company"
    "D:\SteamLibrary\steamapps\common\Star Wars Zero Company"
    "E:\SteamLibrary\steamapps\common\Star Wars Zero Company"
    "F:\SteamLibrary\steamapps\common\Star Wars Zero Company"
    "G:\SteamLibrary\steamapps\common\Star Wars Zero Company"
    "C:\Games\steamapps\common\Star Wars Zero Company"
    "D:\Games\steamapps\common\Star Wars Zero Company"
  ) do (
    if exist "%%~d\SWZeroCompany\Binaries\Win64\oo2core_9_win64.dll" copy /y "%%~d\SWZeroCompany\Binaries\Win64\oo2core_9_win64.dll" "tools\" >nul
  )
)
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
echo  Common causes: antivirus blocking electron-builder, or the first download of the
echo  Electron binary being interrupted - running Build.bat again usually fixes both.
echo.
pause
exit /b 1

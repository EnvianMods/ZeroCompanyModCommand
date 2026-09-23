ZERO COMPANY MOD COMMAND v1.0.9
A dedicated mod manager & launcher for STAR WARS: Zero Company
by Envian Mods

QUICK START
-----------
1. Put ZeroCompanyModCommand.exe anywhere you like (somewhere permanent is best)
   and run it. Windows SmartScreen may warn because the exe is unsigned:
   click "More info" -> "Run anyway".
2. The game is found automatically through Steam. If not, set the game folder
   in Settings.
3. Optional but recommended: in Settings -> Nexus Mods, press "Sign in with
   Nexus Mods". Your browser opens on nexusmods.com, you approve Mod Command
   there, and the app picks it up - it never sees your password and stores
   only the sign-in tokens Nexus issues, encrypted with your Windows account.
   Then press "Register handler". After that, the "Mod Manager Download"
   buttons on nexusmods.com install mods straight into the manager. You can
   revoke the app's access at any time from your Nexus account settings.
4. Browse mods in the Holonet tab, or drag & drop mod archives onto the window.

The manager keeps its settings in %APPDATA%\ZeroCompanyModCommand and your mod
archive (library, backups, archived versions) in the game folder under
"ModCommandArchive" - nothing is written next to the exe, so you can move or
replace the exe freely. Reinstalling a mod at another version joins the same
entry: use its "versions" button to roll back or try an archived version.

NOTES
-----
- The Holonet has two tabs: Nexus Mods, and GitHub - GitHub mods curated
  by Envian Mods. Installed mods are checked for updates automatically.
- The Forge tab in the side rail hosts the Zero Company Mod SDK (a separate
  download for making mods) once you point Mod Command at it in
  Settings -> SDK. Without the SDK it explains what it is and where to get it.
- Adult-rated content follows your Nexus Mods account preference; there is no
  separate switch in the app.
- .zip, .7z and .rar archives all work out of the box (7-Zip ships with the app).
- UE4SS (needed for Lua/DLL mods) installs with one click in Settings, using
  the "UE4SS for Star Wars Zero Company" package from Nexus Mods.
- Diagnostics shows conflicts between your mods, including which game assets
  overlap and which mod wins.

THIRD-PARTY COMPONENTS SHIPPED WITH THE APP
--------------------------------------------
Everything below is downloaded unmodified from its official source by the
build script (build/fetch-tools.js in the source repository) and placed in the
app's resources\tools folder. None of it is part of the app's own source code.
- 7-Zip 25.01 (x64) command-line build (7z.exe, 7z.dll) from
  https://www.7-zip.org - archive extraction. License: LGPL + unRAR restriction
  (see tools\7-Zip\License.txt).
- retoc 0.1.5 (retoc.exe, with the oo2core_9_win64.dll it ships with) from
  https://github.com/trumank/retoc - reads IoStore containers for conflict
  detection.
- ZCSDK Runtime (ZCSDKRuntime.zip, offline copy) from
  https://github.com/EnvianMods/ZCSDK-Runtime-Release - the UE4SS-based runtime
  that Zero Company Mod SDK content mods need; the app installs the newest
  release from that repository when online.
- Electron (the application framework) and the npm package extract-zip, both
  declared in package.json.

Source code: https://github.com/EnvianMods/ZeroCompanyModCommand

SUPPORT
-------
Discord (requests, bug reports, mod submissions): https://discord.gg/YNPCA6qRq3
Support the mods (PayPal): https://paypal.me/Envian707

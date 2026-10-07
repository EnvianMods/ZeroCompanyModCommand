# Zero Company Mod Command

A Star Wars themed mod manager and launcher for **STAR WARS: Zero Company**, built as an
Electron app with a holo-terminal aesthetic.

## Run it

Double-click **`Zero Company Mod Command.bat`**, or from this folder:

```
npm start
```

First run auto-detects the game through Steam (library folders + `appmanifest_2075800.acf`).
A copy of [retoc](https://github.com/trumank/retoc) (0.1.5) ships in `tools/` and is used
automatically for IoStore package inspection; a different copy can be selected in Settings.

## Features

- **Command Deck** — game detection (path, Steam build ID), mod/conflict counts,
  UE4SS / retoc / 7-Zip status, quick actions, Steam launch (`steam://run/2075800`).
- **Hangar Bay** — install mods from `.zip` (native), `.7z`/`.rar` (7-Zip, bundled on Windows), loose
  `.pak`/`.utoc`/`.ucas` files (same-name siblings are picked up automatically), or
  extracted folders. Drag & drop anywhere in the window. Enable/disable, rename, uninstall.
- **Mod types** (auto-classified):
  - `pak` / `iostore` → deployed to `SWZeroCompany/Content/Paks/~mods` with
    `pakchunk99-P###_Name` priority naming (matched basenames across pak/utoc/ucas).
  - Content mods built with the **Zero Company Mod SDK** ship two sidecars beside
    the pak trio (`<Mod>.AssetRegistry.bin` + `<Mod>.zcsdk.lua`); they deploy to
    `~mods` too, keeping their exact names, and the row gets a ◆ SDK chip. They
    need the **ZCSDK Runtime** (see below) or the game can't discover the content.
  - `gfp` (PLUGIN) — **Game Feature plugin** mods: a folder holding
    `<Mod>.uplugin`, `AssetRegistry.bin` at its root and `Content/Paks/<Mod>_P.pak`
    (+ `.utoc`/`.ucas`), optionally `Config/Tags/GameplayTags.ini`. The whole
    folder is installed, unrenamed, as `SWZeroCompany/Mods/<Mod>/` — the name
    comes from the `.uplugin`, never from the display name, so renaming the mod
    here never moves the folder. The game's own loader mounts every folder in
    `SWZeroCompany/Mods` at startup and appends its `AssetRegistry.bin` itself,
    so these mods need no runtime, no load-order prefix and no `~mods` (putting
    their paks in `~mods` mounts the content but hides everything the mod ADDS).
    Disabling removes the folder, which is exactly how the game "forgets" the
    mod — unequip its gear in game and save first, because saves record modded
    gear by file location. Plugin folders you copied in by hand are found by the
    existing-mods scan (Hangar Bay → **Import**) and adopted in place. The
    display name comes from `modinfo.json` `title`, else the `.uplugin`'s
    `FriendlyName`; version/author fall back to `VersionName`/`CreatedBy`.
  - `logicmods` → `SWZeroCompany/Content/Paks/LogicMods`.
  - UE4SS Lua/DLL mods (folders with `Scripts/main.lua` or `dlls/main.dll`) →
    `SWZeroCompany/Binaries/Win64/ue4ss/Mods/<Folder>` with `enabled.txt`, where
    `<Folder>` is the mod's own folder name from its archive (recorded as
    `ue4ssFolder`; only an archive whose root IS the mod falls back to the
    display name). The display name defaults to the folder name; a
    `modinfo.json` in the mod folder can override it with a friendly title (see
    **Mod metadata** below) — the title and a rename change the display name
    only, never the folder, so `mods.txt`, the mod's own Lua paths and add-on
    pack detection keep working. Two UE4SS mods cannot share a folder. Entries
    from before v1.9.20 (folder named after the display name) are recorded where
    they are, nothing moves; when their own folder name is known and differs, the
    row offers **Use original name** (moves the files, anything the mod wrote
    there and its `mods.txt` line) or **Keep as is**. A mod's
    own `paks/` folder travels with it into `ue4ss/Mods/<Folder>/paks/`, unrenamed
    — the mod mounts those containers itself at startup, so they are never moved
    into `~mods`. Disabling or removing a UE4SS mod deletes only the files it
    deployed (then the folders left empty); anything else in its folder —
    configs it wrote, ZC Unlocked's `addons\` — stays.
  - ZC Unlocked add-ons (ZCU ADD-ON) — a folder holding an `addon.ini` with an
    `[addon]` section that is not itself a UE4SS mod folder (archive roots like
    `ue4ss/Mods/ZCUnlocked/addons/<Folder>/`, `ZCUnlocked/addons/<Folder>/`,
    `addons/<Folder>/` or just `<Folder>/addon.ini`) → the whole folder, its
    `050_ZCA_<Key>_P` paks included, goes to
    `ue4ss/Mods/ZCUnlocked/addons/<Folder>/` under its original name (ZC
    Unlocked keys add-ons by that name and mounts their paks itself; nothing
    goes to `~mods`). Name and version come from `addon.ini`; updates match by
    folder name. Disable/enable flips `enabled=0/1` in the deployed `addon.ini`
    (everything else in the file stays byte for byte) and the folder never moves;
    that line is Mod Command's, so it never counts as "changed outside Mod
    Command". Needs ZC Unlocked (`ue4ss/Mods/ZCUnlocked`): without it the add-on
    is kept in the library, not deployed, with a warning, and deployed once ZC
    Unlocked is there. Uninstall removes only the add-on's own files. A UE4SS mod
    folder that carries an `addon.ini` (an add-on pack) still installs as that
    UE4SS mod. Add-on folders you copied in by hand are found by the
    existing-mods scan (Hangar Bay → **Import**) and adopted in place — also
    bare add-on packs straight in `ue4ss/Mods/<Pack>/` (an `addon.ini`, no
    `Scripts/main.lua` or `dlls/main.dll`), which ZC Unlocked loads too: they
    stay in `ue4ss/Mods/<Pack>/` and switch with `enabled=` like any add-on,
    and they are never treated as UE4SS mods (no `mods.txt` entry). ZC Unlocked
    would load two copies of the same add-on (same folder name, compared the
    way ZC Unlocked keys it, or the same `name=` in `addon.ini`): an add-on
    installed while another copy is on goes in switched off with a warning
    naming that copy, it can't be switched on until that copy is off or gone,
    and Diagnostics lists every duplicate with both paths. Your own copy is
    never changed.
  - UE4SS runtime archives (dwmapi.dll + ue4ss folder) → installed into `Binaries/Win64`,
    replacing only UE4SS's own files (your `ue4ss/Mods`, `mods.txt` and settings are kept).
  - `gamefolder` (GAMEFILES) — archives laid out against the game root
    (`SWZeroCompany/...`, `Engine/...`, e.g. replacement movies) deploy over the
    game's own files. The original of every replaced file is backed up to
    `data/backups/gamefiles/<id>/` first and restored on disable/uninstall.
- **Multi-mod archives** — an archive holding several mods installs each as its
  own entry (separate enable/order/update/remove): UE4SS mod folders split per
  folder, Game Feature plugin folders split per `.uplugin` (their inner
  `Content/Paks` stays with them), pak containers split by containing folder
  (multiple paks in ONE folder stay one mod), LogicMods subfolders keep their
  deployment, and each
  entry reads its own `modinfo.json`. Nexus/GitHub origin tracking covers every
  entry; updating one replaces all siblings from a fresh download, preserving
  enabled state and priorities by name.
- **Guided installers (FOMOD)** — an archive shipping `fomod/ModuleConfig.xml`
  installs by answering the author's own steps: option groups with descriptions,
  images and recommended answers, flags/conditional steps, and a Back button.
  Scripts are read, never executed; every source/destination path is re-validated
  in the main process (no traversal, no absolute paths). Titles/versions come from
  `fomod/info.xml`. Conditions on other game plugins or tool versions don't exist
  for Zero Company — they're surfaced as a warning and treated as unmet.
- **Load Order** — drag to reorder pak/IoStore mods; applying renumbers the deployed
  `P###` prefixes (later = wins conflicts). **Suggest order** proposes an ordering
  (broad mods first, targeted patches later so the focused mod wins) and lists which
  confirmed conflicts the ordering decides. **Review & apply** previews every
  conflict pair and which winners change before anything moves; **Undo last apply**
  rolls back to the pre-apply order (press again to redo). On startup, enabled mods
  whose deployed files went missing are redeployed automatically from the library.
- **SHA-256 ownership** — every installed and deployed file's hash is recorded.
  Disable/uninstall/reorder verify the deployed files first: a file changed outside
  the manager stops the operation and asks before anything is deleted. Archive
  extraction rejects path traversal and strips symlinks.
- **UE4SS start order** — a second panel in Load Order for enabled UE4SS mods.
  Applying writes ONE managed block into `ue4ss/Mods/mods.txt`, placed just
  before the runtime's `Keybinds` entry with its "do not move up" warning kept
  attached; runtime entries, comments and hand-added mods are preserved, a
  hand-placed managed entry moves into the block, and `enabled.txt` markers are
  retired once the block is authoritative. Rows carry DLL PASS / LUA PASS tags —
  UE4SS starts every DLL mod during runtime init and Lua mods once scripting
  exists, so order applies within each pass.
- **Game-build warnings** — each install/adoption records the game build it
  happened under (Steam manifest buildid, or an exe fingerprint for EA/manual
  installs). After a game update, affected mods show a "game updated" chip and
  a Diagnostics warning; clicking the chip marks the mod verified on the
  current build.
- **EA App support** — the EA-launcher edition is detected (registry + EA Games
  folder scan + `__Installer` signature) and mods deploy identically for EA
  players; Launch starts the exe directly for EA installs. Per-mod EA
  compatibility comes from the mod's `modinfo.json` (`"eaCompatible": false`
  or `"launchers": ["steam"]`) and an owner-curated live list (`ea-compat.json`
  in the remote-config repo, edited with `update-ea-compat.js`); EA users get a
  red chip + enable-time confirm, Steam users an FYI chip, and Diagnostics
  reports both directions.
- **Linux / Proton / Steam Deck** — Steam library discovery covers native,
  classic and flatpak Linux locations; Proton compat prefixes are detected and
  Diagnostics carries the `WINEDLLOVERRIDES="dwmapi=n,b" %command%` guidance
  UE4SS needs (never applied automatically). nxm:// registers via a .desktop
  entry + xdg-mime; 7-Zip is found via p7zip. The AppImage is built by the
  `build-linux.yml` GitHub workflow (Windows can't cross-build it — the
  AppImage tooling needs symlinks).
- **Compatibility matrix** — Diagnostics shows an N×N grid of enabled mods:
  ✔ compatible, ▲ suspected overlap, ✖ confirmed asset overlap (hover for details).
- **UE4SS hook scan** — statically scans the Lua scripts of every *active* UE4SS mod
  (manager-installed and unmanaged folders in `ue4ss/Mods`, built-ins excluded) for
  `RegisterHook`/`RegisterCustomEvent` targets and `RegisterKeyBind` keys. Two mods
  hooking the same UFunction or binding the same key (modifiers respected, comments
  ignored) are reported in Diagnostics' UE4SS Hook Report; managed pairs also surface
  in the pairwise conflict report and matrix. Hook callbacks stack in UE4SS load
  order, so the report explains rather than picks a "winner".
- **Squad profiles** — save the current enabled set + load order under a name
  (Hangar Bay profile bar), then apply/delete. Profiles pin each mod's version;
  applying swaps pinned versions back in from the version vault. Mods installed
  after a profile was saved are appended last with a warning; missing mods are
  skipped. Enable all / Disable all buttons cover the whole hangar.
- **Version vault** — every mod update archives the outgoing version under
  `data/versions/<modType-name>/` (newest 5 kept). The ⧗ button on a Hangar row
  lists archived versions; rolling back archives the current version first, so
  roll-forward works too. Identity is modType+name, so renames start fresh
  history.
- **Game update freeze** — opt-in Settings toggle (Steam installs only): sets
  `AutoUpdateBehavior "1"` in the appmanifest, locks the manifest read-only,
  and (since 1.9.6) leaves LAUNCH GAME as a real Steam launch — DIRECT LAUNCH is the no-update path. Re-asserted
  at startup, reported in Diagnostics, fully reversible. EA App has no per-game
  mechanism — users are pointed at the EA App's global auto-update setting.
  While frozen, play with the slimmer DIRECT LAUNCH button (local exe, started with
  Steam's app-id environment so the game does not relaunch itself through Steam — no
  update check). LAUNCH GAME always goes through Steam; it and Steam's own Play button
  fail with "Disk write error – appmanifest_2075800.acf" whenever an update is pending —
  that is the freeze working, and turning it off lets Steam update.
- **Installed badges in Holonet/GitHub** — cards for mods already in the hangar
  show a green IN HANGAR tag; the Install button becomes ✓ Installed, or
  ⬆ Update when one is waiting.
- **Featured transmissions** — the Holonet opens with a rotating 3-slot promo strip of
  mods by the featured-creator roster. The roster is owner-controlled, not a user
  setting: the baked-in list lives in `lib/featured.js` (ships with launcher updates),
  and an optional `REMOTE_ROSTER_URL` there can point at an owner-hosted JSON
  (`{"promotedAuthors": [...]}`) that every installed launcher fetches live — edit
  that one file to change the roster for everyone without shipping an update. Slots
  cycle every 6s (pause on hover, off with reduced motion). Roster mods carry an amber
  PROMOTED tag; slots the roster can't fill are backfilled with random top-downloaded
  mods, tagged TOP RATED in cyan and reshuffled each cycle.
- **Config Editor** (opened from a button on the Command Deck) — edit game and mod config files in-app: the UE user
  configs (`%LOCALAPPDATA%\SWZeroCompany\Saved\Config\Windows\` — Engine.ini,
  GameUserSettings.ini, Input.ini, Scalability.ini; missing ones are created on first
  save), UE4SS-settings.ini and mods.txt, config files found anywhere inside a UE4SS
  mod folder (4 levels deep, `dlls\` and `Scripts\` included — .ini/.cfg/.json/.txt/
  .toml/.yml, plus .lua whose name says config such as `config.lua` / `settings.lua`;
  enabled.txt, modinfo.json, README/.md and .log never), plus any file added via
  "Add file…" (right-click a custom entry to remove it).
  INI files get a structured section/key/value view that preserves comments, ordering
  and duplicate keys exactly (only values are editable); Raw view edits the full text.
  The original file is backed up to `.zcbak` on first save.
- **Adult content follows your Nexus account** — there is no "show adult content"
  switch in Mod Command, by design. Signed out, adult-rated mods are filtered out of
  every listing: browsing, categories, search, the featured strip and the Link wizard
  (a search by name is not a way past it). Signed in, the app reads your own Nexus
  account's content preference — the one behind Nexus's age verification — and follows
  it, blurring adult thumbnails when your account asks for that (hover to reveal).
  Adult-rated mods always carry an **18+** chip. Settings → Nexus Mods states what is
  in force and links to your Nexus content-preferences page to change it.
- **◆ Forge — the Mod SDK's workbench, hosted** — point Mod Command at an installed
  Zero Company Mod SDK (Settings → ◆ SDK; Detect looks beside the install and beside
  the game folder) and the Forge view hosts the SDK's own UI, loaded from the SDK
  folder against its embed contract (`<sdk>/tools/sdk-ui/manifest.json`; the host's
  side is `lib/sdk-link.js`, design in `docs/SDK_LINK.md`). Mod Command ships no copy
  of the panel, so an SDK update needs no Mod Command release. With no SDK linked the
  Forge item stays in the rail, dimmed, and opens the "Get the SDK" page (what it is,
  what it needs — including Node.js 22.12+ — one **Get** button, "point at an installed SDK", and a note that the SDK is not open source). That button's
  destination is **not hard-coded**: it comes from the `sdk` block of the asset repo's
  `launcher-version.json` — the same file that announces Mod Command's own updates —
  fetched at startup and hourly, cached in `sdkAssetLinks` so it survives offline, and
  labelled from the url's own host (Nexus / GitHub); with nothing ever fetched it shows
  a dim "could not be fetched" line instead of a dead link. Detect also reads the SDK
  workbench's own settings (`%APPDATA%\Zero Company Mod SDK\sdk-ui-settings.json`); once
  linked, the ◆ SDK card's **Paths & dependencies…** button opens the Forge view's Settings,
  where the SDK's Unreal, game, retoc and reflection paths live. The SDK's own update file
  (`sdk-version.json`, URL from its manifest) puts a badge on Forge when a newer SDK is
  published.
  The ◆ SDK card names the installed SDK version with its public name and links the SDK's own
  `docs/CHANGELOG.md` ("What's new in the SDK"). Against SDK 1.0.3 the hosted workbench also brings
  its first-run walkthrough, build stepper, mod-def editor, asset drop zone and Test / Conflicts /
  Publish views, with no change to Mod Command.
- **Holonet browser** — an in-app Nexus Mods browser for Zero Company: grid of mods
  with thumbnails, author/version/category, download & endorsement counts, live search,
  category filter, and sorting (downloads / endorsements / newest / updated / name),
  with paging. Powered by the Nexus GraphQL v2 API (browsing needs no sign-in). The
  Install button downloads+installs directly for premium accounts; non-premium
  accounts get the mod's Files page opened — pressing "Mod Manager Download" there
  sends the nxm:// link back into the manager, which installs it automatically.
- **Nexus Mods integration** — press **Sign in with Nexus Mods** in Settings: the
  app opens nexusmods.com in your own browser (OAuth 2.0 authorization code +
  PKCE, per Nexus's app guidelines), you approve Mod Command there, and it never
  sees your password. Only the access tokens Nexus issues are kept, encrypted
  with your OS user credentials (Windows DPAPI via Electron safeStorage) — never
  in plain text: without a secure OS key store they are kept for the session
  only — never in the game-folder archive, never shown to the UI, masked in
  the log and support report, and only ever sent to nexusmods.com; revoke access any time
  from your Nexus account page. Register the `nxm://` handler and "Mod Manager
  Download" buttons on nexusmods.com install straight into the manager, with
  download progress, auto naming/version from Nexus mod info. Non-premium
  accounts must start downloads from the website button (the nxm link carries the
  required key/expires). Every request to Nexus — v1, GraphQL, the OAuth endpoints
  and the download CDN — goes out through one helper (`lib/nexus-http.js`) that
  identifies the app by registered name, version and User-Agent.
- **Request allowance, read from Nexus** — Settings → Nexus Mods shows the quota
  Nexus reports on every reply ("API requests: 1,950 of 2,000 this hour (resets
  16:00) · 19,900 of 20,000 today (resets 00:00 UTC)"). When it runs out the app
  stops instead of retrying, with a readable "try again after HH:MM"; it honours
  `Retry-After` on a 429, keeps at most two requests in flight, and background
  work (the hourly update check, the file-name index) leaves a reserve for your
  own clicks and reschedules itself rather than spending it.
- **UE4SS: one source, kept current** — Mod Command installs, updates and
  switches to exactly one UE4SS: Nexus mod 9 **"UE4SS for Star Wars Zero
  Company"** (UE4SS plus this game's signatures, loader settings and helpers;
  its page states the game build it was tested on). The stock upstream build
  from GitHub (UE4SS-RE/RE-UE4SS) is never downloaded — there is no fallback to
  it anywhere (install, ⧗ Versions, the ZCSDK-runtime prompt, Diagnostics).
  `install-ue4ss` with no payload installs mod 9's primary MAIN file,
  `{ nexusFileId }` one specific file of that page. Premium accounts download
  directly; free accounts get the embedded Nexus page, whose "Mod Manager
  Download" comes back as nxm:// into `handleNxm`, which recognises the runtime;
  signed-out users get `{ needsSignIn }` — the card offers the sign-in (then
  installs) or shows the page. If the page cannot be read, the install says so
  and stops. The page is read anonymously via GraphQL (`refreshNexusLatest()`,
  cached for the hourly cadence; the small "UE4SS Diagnostic Tool" on the same
  page is never an install candidate).
  - **Which UE4SS is installed** (`lib/ue4ss.js classifyInstall`, shown on the
    Settings card, the dashboard, a Settings nav badge and in Diagnostics):
    *nexus* — installed by Mod Command from mod 9 (`settings.ue4ssInstalled`,
    which records the file id, version, tested game build and UE4SS.dll's MD5),
    or recognised by a UE4SS.dll MD5 this app installed from Nexus before;
    *stock* — recorded as a GitHub install by an older Mod Command, the old flat
    layout, or no `ue4ss\UE4SS_Signatures\*.lua` (the stock release zip has
    none); *unknown* — anything else, including a UE4SS.dll that no longer
    matches the recorded Nexus build. Signature files present are never taken
    as Nexus evidence — the Zero Company Mod SDK generates its own there — so a
    UE4SS with no install record and signatures is *unknown*, not *nexus*.
    UE4SS.dll's version resource (VS_FIXEDFILEINFO) is reported alongside when
    the DLL has one. Stock/unknown show *"UE4SS
    installed is the stock build — switch to the Star Wars Zero Company UE4SS
    (Nexus)"* with a one-click **Switch to the Nexus build** (card notice and a
    Diagnostics fix button), plus one toast per build on disk.
  - **Install / update / switch keep what is yours**
    (`_installUe4ssRuntime`): only UE4SS's own files are replaced. Folders in
    `ue4ss\Mods` the package does not ship are untouched, a managed UE4SS mod's
    folder is never overwritten, a built-in you disabled stays disabled;
    `mods.txt` keeps every line (values, comments, the managed start-order
    block) and only gains entries the package adds (before Keybinds);
    `UE4SS-settings.ini` takes the package's file and carries over each value
    you changed from what the previous package shipped (kept as
    `<data>\ue4ss-shipped-settings.ini`; without one — a switch from a build
    placed by hand — the [Debug] values that differ from the stock defaults,
    which match the untouched stock 3.0.1 file: console and GUI console off,
    GuiConsoleFontScaling 1, monospace editors off, opengl, ExternalThread,
    ToggleGuiKey O).
    *The runtime is an allow-list*, never "everything in ue4ss\": dwmapi.dll,
    ue4ss\{UE4SS.dll, UE4SS.pdb, UE4SS-settings.ini, LICENSE, API.txt,
    Changelog.md, README.md}, the folders UE4SS_Signatures,
    VTableLayoutTemplates, MemberVarLayoutTemplates and CustomGameConfigs, plus
    what the last package shipped (`<data>\ue4ss-shipped-files.json`, written
    at install from the payload minus ue4ss\Mods). Dumps, .jmap files, logs,
    crash dumps, imgui.ini, liveview\, watches\, UE4SS_SDK_Backends\ and the
    Mod SDK's ZCSDKBridge.* files are never snapshotted, retired or deleted,
    and SDK-generated `UE4SS_Signatures\*.lua` ("Generated by
    ZeroCompanyModSDK") never count as runtime. A complete package retires
    only what the previous shipped list has and it lacks (no list: only
    UE4SS.pdb / API.txt / Changelog.md / README.md). A package or restore that
    overwrites a non-runtime file of the same name (an SDK signature) keeps it
    in the snapshot first (`foreign` in vault.json), and a restore puts it back.
    A signature the ZCSDK Runtime installer placed and still owns (listed in
    `<data>\zcsdk-signatures.json`, unchanged since) is never overwritten by a
    package or restore: the incoming copy is held in
    `<data>\zcsdk-signatures-backup\` as the one put back when the runtime is
    removed (a held copy the Mod SDK generated is never replaced; one a later
    package no longer ships is dropped), snapshots keep a held copy with their
    build, and those runtime signatures never count in the *stock*/*unknown*
    signature check.
    Every replacement first snapshots the old runtime into
    `versions/ue4ss-runtime/` (5 kept; the entry being restored is never
    pruned), with its shipped list and shipped settings; restore removes only
    runtime files, writes back only allow-listed ones (an older whole-folder
    snapshot's dumps/logs/SDK files are ignored; an SDK signature only fills a
    gap) and brings those records back. ⧗ Versions lists every runtime file on
    the Nexus page (main first, older uploads for a game kept on an older
    build) and restores any kept build — restoring never downloads anything.
  - **Staying up to date** — at startup and hourly (`maybeCheckUe4ss`, the same
    cadence as the mod update check; **Check now** on the card runs it on
    demand) the installed file id is compared with the page's main file (Nexus
    file ids only grow). With **Keep UE4SS up to date automatically** (Settings,
    `settings.ue4ssAutoUpdate`, default on) and a premium account, the new file
    is installed while the game is closed; while `SWZeroCompany.exe` /
    `SWZeroCompany-Win64-Shipping.exe` runs from this install (`steam.isGameRunning`,
    tasklist + image paths) it is held back, you are told once, and it is
    retried every five minutes. With it off, on a free account, or signed out,
    you get one toast per new file and **Update to …** on the card (and in
    Diagnostics). A manual install/restore also refuses while the game runs.
    When signed in but the account is not loaded yet (the startup check), it
    is validated first, so a premium account is never treated as free.
- **retoc update check** — Settings → retoc compares the installed
  `retoc --version` with the newest GitHub release (trumank/retoc, Windows zip
  asset) and installs it into `<dataDir>/tools/retoc.exe`, which `retocPath()`
  prefers over the copy bundled in `tools/` (`settings.retocInstalled`).
  Reported at startup, in the update check and in Diagnostics.
- **ZCSDK Runtime one-click install** — Settings → ZCSDK Runtime installs the two
  UE4SS mods (ZCSDKBridge + ZCSDKLoader) that SDK-built content mods need. The SDK
  publishes every runtime build to `github.com/EnvianMods/ZCSDK-Runtime-Release`
  (a Release zip + `latest.json` at the repo root); Mod Command reads `latest.json`
  at startup (and on "Check for updates"), downloads the newest release, and offers
  "Update to x" when the installed copy is behind — no Mod Command release needed
  for a runtime update. `tools/ZCSDKRuntime.zip` (+ `tools/zcsdk-runtime.json`)
  stays bundled as the offline fallback. Existing copies are vaulted and replaced
  by name; installing an SDK-built mod without a working runtime offers the install
  immediately, and UE4SS is fetched first when it is missing.
  While installed mods need it, the runtime is a protected dependency: its two
  parts can't be switched off, removed, rolled back or renamed from the Hangar,
  Disable all and profiles leave it on, an old copy can never be adopted or
  installed over it (Import lists one as "Old ZCSDK Runtime copy — safe to clean
  up"), and Settings → ZCSDK Runtime → **Remove** takes both parts out together.
  If it goes missing or gets switched off, Mod Command puts it back (from the
  bundled copy, or after asking when that needs a download) — unless you removed
  it, or its files were changed outside Mod Command. A failed install or update
  puts the previous runtime back.
- **Safe mod changes** — nothing is switched, removed, updated, rolled back,
  renamed or reordered while Star Wars Zero Company runs from the game folder (the
  check looks at whether the game's own exe files are in use; when it cannot be
  sure, the change waits with a **Check again** button). Undeploying removes only
  the files Mod Command deployed and keeps anything else in a mod's folder; a
  file held open stops the undeploy cleanly; a failed update, adoption or
  rollback puts the previous version back exactly as it was.
- **Incompatibility check** — pairwise conflict detection between enabled mods:
  **CONFIRMED** pairs modify the same game assets (asset paths extracted from each mod's
  `.utoc` via `retoc list --path`); **SUSPECTED** pairs ship identically named files.
  Each conflicting mod shows a clickable "⚠ N conflicts" chip in the Hangar Bay that
  expands to the opposing mod, the overlapping asset paths, and which mod wins (loads
  later). The full report also appears in Diagnostics, which additionally rescans any
  IoStore mods installed while retoc was unavailable.
- **Support reports** — Diagnostics → Copy support report / Save report…:
  a single sanitized text block (game/launcher/build, tools, full mod list
  with origins and priorities, conflicts, hook collisions, duplicates, health
  scan, session log). Paths, usernames and machine names are scrubbed by
  `lib/report.js`; the in-memory session log lives in `lib/log.js`.
- **Diagnostics** — installation health scan: game layout, Steam manifest/build,
  `~mods` presence, the `SWZeroCompany/Mods` plugin folder (how many plugin folders
  are there and how many Mod Command manages, so hand-copied ones are visible),
  UE4SS layout, retoc/7-Zip availability, deployed-file audit, conflicts.
  Also flags **duplicate mods** — the same UE4SS mod active under two folders in
  `ue4ss/Mods` (e.g. a manager install plus a leftover from a manual/one-click
  install under a different name). Two active copies run at once (double
  hooks/loops) and cause frame stutter; folders are matched by `modinfo.json`
  title or identical entry script, so a copy with a manifest and one without
  still pair up. The report names each folder and whether it's managed.
- **Settings** — game/retoc/7z paths, theme, close-on-launch, reduced motion.

### Themes

A thank-you to everyone who has stuck with Mod Command: **Settings → Themes**
changes the look of the whole app, instantly and without a restart.

- **Mod Command** (default) — the original blue holo-terminal look. Everyone
  starts on it, including existing users updating from an earlier version.
- **Bounty Hunter** — weathered armor green, dented ochre gold and rust-red
  markings on scorched gunmetal, with condensed stencil-style headings,
  hazard stripes and a grimy plate texture. Pure CSS: no extra downloads, and
  it uses only fonts already on your system (Bahnschrift on Windows 10/11,
  falling back to common condensed fonts, then Segoe UI). Every text color
  meets WCAG AA contrast.

The choice is stored as `theme` in your settings (`manager-data.json`), so it
survives restarts and updates. It is applied before the window first paints,
so there is no flash of the other theme. An unknown or missing value falls
back to Mod Command. The embedded Nexus Mods page and the SDK's own panel
are their sites' own pages and are not restyled; only Mod Command's frame
around them follows the theme.

## Mod metadata (`modinfo.json`)

A UE4SS Lua/DLL mod can ship an optional `modinfo.json` in its mod folder (next
to `Scripts/` or `dlls/`) to control how it appears in the manager:

```json
{
  "title": "Envian's Movement Patch"
}
```

- `title` — the display name shown in the Hangar Bay (1–120 chars; spaces and
  punctuation are fine). Without it, the mod falls back to its folder name run
  through the filesystem sanitizer (so `My Cool Mod` would show as `My_Cool_Mod`).
- The **deployed folder** on disk is always the sanitized name regardless of
  `title`, so the on-disk layout stays filesystem-safe. `title` is display-only.
- The convention is opt-in: mods without a `modinfo.json` behave exactly as before.
- Read at install/import time (`classifyFolder` in `lib/mods.js`); a malformed
  manifest is ignored and the folder name is used.

Only `title` is consumed today; unknown keys are ignored, so the file is a safe
place to stash other metadata (author, version, notes) for future use.

## Layout

```
main.js            Electron main process (IPC, dialogs, launch, diagnostics)
preload.js         contextBridge API (window.zc)
lib/steam.js       Steam library scan + appmanifest parsing (AppID 2075800)
lib/store.js       portable JSON store  → data/manager-data.json
lib/mods.js        mod engine: classify/install/deploy/order/conflicts/UE4SS
lib/ue4ss.js       UE4SS for Star Wars Zero Company (Nexus mod 9): page reads, install origin, updates
lib/archive.js     zip (bsdtar / extract-zip) + 7z/rar (7-Zip CLI — tools/7-Zip on Windows, system copy on Linux)
lib/themes.js      theme ids, default + fallback (Settings → Themes)
src/               UI (index.html / styles.css / app.js); theme-boot.js sets the theme before first paint
test/              node --test test/themes.test.js
data/              settings when running from source (shipped builds use %APPDATA%\ZeroCompanyModCommand)
build/uninstaller/ Uninstall.cs + app.manifest → release/ZeroCompanyModCommand-Uninstall.exe
```

Mods keep their canonical files in the **mod archive** — by default
`<game>\ModCommandArchive\` (library/ + backups/ + versions/ + a mirrored
manifest), so mods survive app updates and deletions; Settings → Paths can move
it anywhere (copy-verify-delete migration) or reset it. A pre-1.9.0 archive
under the old `ZeroCompanyModArchive` name is renamed in place on startup.
Enabling copies files into the game, disabling removes them, uninstalling
deletes the library copy. A fresh install that finds an archive restores
everything from it automatically, and a one-time scan after the first game
connection offers any unmanaged/orphaned/other-manager mods for adoption (also
on demand: Import existing → "Import from a manager folder…"). The settings
file itself lives in the per-user app-data folder —
`%APPDATA%\ZeroCompanyModCommand` on Windows — never beside the exe
(`data/manager-data.json` when running from source).

Installs are **version-aware**: a mod whose `modinfo.json` names the same
title (and author) as an installed mod joins that mod's line instead of
becoming a new entry. A newer version replaces the install and vaults the old
one; an older version is vaulted as an alternate without touching the install;
the same version is a reinstall. The ⧗ versions button then offers every
archived version for rollback or testing.

## Uninstalling

`ZeroCompanyModCommand-Uninstall.exe` ships in the release zip next to the app. It
removes Mod Command's own files and leaves the user's mods deployed and working:
`%APPDATA%\ZeroCompanyModCommand` (settings, staging, tools, backups),
`%APPDATA%\Zero Company Mod Command` (Electron's userData — named after `productName`),
`%TEMP%\ZeroCompanyModCommand` plus `%TEMP%\zc-retoc*`, the mod archive
(`<game>\ModCommandArchive`, or only the `library`/`backups`/`versions` + mirror
inside a custom `settings.storageDir`; the pre-1.9.0 `ZeroCompanyModArchive` too),
the update freeze on `appmanifest_2075800.acf` (undone exactly like
`setUpdateFreeze(…, false)`), the `HKCU\Software\Classes\nxm` tree **only** when its
command points at `ZeroCompanyModCommand.exe`, and the exe (+ the zip's README.txt and
CHANGELOG.md, never from a source checkout) beside the uninstaller, which then deletes
itself. It never touches `Content\Paks\~mods`, `LogicMods`, `Binaries\Win64` (UE4SS,
`ue4ss\Mods`, proxy dlls), `SWZeroCompany\Mods`, replaced game files or
`%LOCALAPPDATA%\SWZeroCompany`; deletion clears read-only attributes, removes
junctions/symlinks as links without following them, and refuses any target inside the
game folder other than the archive. It refuses to run while `ZeroCompanyModCommand.exe`
or `Zero Company Mod Command.exe` is running. No UAC (`asInvoker`); everything is per-user.

Switches: `/silent` (defaults, exit 0 = done, 1 = something failed, 2 = the app is
running), `/dry-run` (prints the plan, deletes nothing), `/keep-archive`. Test-only:
`/appdata:<dir>` and `/temp:<dir>` (stand-ins for `%APPDATA%` / `%TEMP%`),
`/game:<dir>`, `/regroot:<HKCU subkey>` (where `Software\Classes\nxm` is looked up) and
`/screenshot:<png>` (renders the dialog and exits). Any override switches on test mode:
no Steam discovery, and a location that was not overridden is left out entirely.

Build: `npm run build-uninstaller` (also run by `build-exe` and `build`, after
fetch-tools) compiles `build/uninstaller/Uninstall.cs` with the C# 5 compiler that
ships with Windows (`%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe`) into
`release/ZeroCompanyModCommand-Uninstall.exe` — no SDK or download needed. The Linux
AppImage has no uninstaller: delete `~/.config/ZeroCompanyModCommand` and the game's
`ModCommandArchive` by hand.

## Releases

```
npm run dist
```

produces `release/ZeroCompanyModCommand.exe` — a single portable executable. When run,
it keeps its settings in `%APPDATA%\ZeroCompanyModCommand` and the mod archive in the
game folder under `ModCommandArchive` — nothing is written beside the exe (the dev
`data/` folder is separate). A pre-1.9.0 `ZeroCompanyModCommand-data` folder next to
the exe is copied into app-data on first start and left behind renamed `.migrated-<date>`.
The `nxm://` registration from a portable exe points at the exe's on-disk location, so
keep it somewhere permanent. On every launch the portable stub unpacks the app into
`%TEMP%\ZeroCompanyModCommand` (a fixed name, set by `build.portable.unpackDirName`,
wiped and re-extracted each run and deleted again on exit) and runs it from there — so
a user whose antivirus quarantines a runtime file such as `ffmpeg.dll` has one stable
path to add to their exclusions, and the app names that folder in an error dialog if
part of the runtime is missing when it starts.

Shipping structure (v1.0.0 onward):
- version lives in `package.json`; per-version notes in `CHANGELOG.md`
- the Nexus upload is `release/ZeroCompanyModCommand-v<version>.zip`, containing
  `ZeroCompanyModCommand.exe` + `ZeroCompanyModCommand-Uninstall.exe` + `README.txt` + `CHANGELOG.md`
  (the exe filename stays constant across versions so nxm:// registrations survive updates)
- mod-page art: `src/assets/nexus-banner.png` (header) and `mod-placeholder@2x.png`

## Releasing

**Distribution policy (2026-09-01, until otherwise stated):** users download from
NEXUS — update announcements always point at the Nexus mod page, so update traffic
counts toward download stats, rankings, and Donation Points. GitHub gets a silent
mirror release (source + zip) for backup and transparency, with no announcement.

**Nexus ships the SAME exe as GitHub (policy restored 2026-09-10, in
anticipation of the mod being accepted by Nexus):** the Nexus main file is the
Windows exe zip (`ZeroCompanyModCommand-v<public>.zip`, identical bytes to the
GitHub release asset), the optional file is the Linux AppImage zip. Nexus's
automated scan quarantines unsigned exes until a human reviews them, and — as
measured on 2026-09-09 — any package with a batch/script file too (only a
package with no exe/dll/bat/cmd/ps1/py and no nested archive came back
VERIFIED). While that review is pending, the build-from-source package remains
available as a fallback: `package-source-release.js` → the source tree +
`README-BUILD.txt` + `Build.bat.txt`; users install Node.js LTS, run
`npm run build` (= `npm ci`, `build/fetch-tools.js` for 7-Zip/retoc/ZCSDK
Runtime, electron-builder) and get the same exe. The packager refuses to emit a
package containing a binary or nested archive.

The project is a git repo with `origin` set to
`github.com/EnvianMods/ZeroCompanyModCommand`. Full release flow:

1. Bump `version` in package.json, add a CHANGELOG entry, commit
2. `npm run build-uninstaller && npm run dist`, zip exe + `ZeroCompanyModCommand-Uninstall.exe`
   + README.txt + CHANGELOG.md as `ZeroCompanyModCommand-v<version>.zip`; snapshot the source (no
   node_modules/release/data/.git) as `...-source-v<version>.zip`
3. Upload the exe zip to Nexus as a new version of the existing main file:
   `upload-nexus-file.js <public> <zip> --name "Zero Company Mod Command" --update
   --archive-old --set-mod-version`; the Linux zip likewise with
   `--name "Zero Company Mod Command (Linux AppImage)" --category optional
   --no-primary --update --archive-old`. (Fallback while an exe is held by the
   scan: `package-source-release.js` + the same upload with
   `--name "Zero Company Mod Command (build from source)" --no-primary`.)
4. `"Archive Release.bat" <version> <build-zip> <source-zip> --notes "..."`
   — pushes the version archive (both zips as Release assets + synced changelog)
   to github.com/EnvianMods/ZeroCompanyModCommandArchive. This replaces the old
   local copy into "Envian Mods and Projects" (that folder is now legacy).
5. `git push` the source, then optionally
   `"Publish Release.bat" <version> <path-to-zip>` — silent GitHub mirror on the
   source repo
6. `"Update Launcher Version.bat" <version> "https://www.nexusmods.com/starwarszerocompany/mods/<id>?tab=files" --notes "..."`
   — announces to every installed launcher, pointing at Nexus

- **HANDOFF.md is never published.** The internal working notes are untracked in
  the public repo (listed in `.gitignore`) so they cannot end up in a tag's
  automatic "Source code (zip/tar.gz)" assets; they live in the private archive
  repo at `docs/HANDOFF.md` on `main` and are pushed with
  `owner-tools/update-featured-authors/push-handoff.js` / `"Push Handoff.bat"`
  after every HANDOFF edit. As a backstop, `publish-release.js` lists each .zip
  before uploading it and refuses any zip with an entry matching `/HANDOFF/i`
  (`node publish-release.js --check-only <zip>` runs that check alone).

## Third-party components in the shipped build

The packaged app contains this repository's code (`main.js`, `preload.js`,
`lib/`, `src/`, `package.json`) inside `resources/app.asar`, plus the npm
dependency `extract-zip` declared in `package.json`. Beside the bundle,
`resources/tools/` holds binaries that are **not** in this repository: they are
downloaded unmodified from their official sources by `build/fetch-tools.js` at
build time (the CI workflow and `npm run build` both run it):

| Component | Version | Source | License | Purpose |
|---|---|---|---|---|
| 7-Zip command-line build (`7z.exe`, `7z.dll`) | 25.01 x64 | https://www.7-zip.org (official MSI, unpacked) | GNU LGPL + unRAR restriction, BSD parts | `.7z`/`.rar` extraction; `tools/7-Zip/BUNDLED.txt` + `License.txt` record it |
| retoc (`retoc.exe`) | 0.1.5 | https://github.com/trumank/retoc release asset | MIT | IoStore container listing for conflict detection |
| ZCSDK Runtime (`ZCSDKRuntime.zip`, `zcsdk-runtime.json`) | per `latest.json` | https://github.com/EnvianMods/ZCSDK-Runtime-Release | this project's author; no separate license file | offline copy of the UE4SS-based runtime for SDK content mods |
| `elevate.exe` | — | electron-builder's portable stub | — | added by the packager, not by this project |

The full license texts ship in `tools/licenses/` (tracked here, and packaged as
`resources\tools\licenses` inside the app): `7-Zip-License.txt`,
`retoc-LICENSE.txt` and `ZCSDK-Runtime.txt`. `build/fetch-tools.js` refreshes
them on every run (retoc's `LICENSE` comes out of its release zip, 7-Zip's is
copied from `tools/7-Zip/License.txt`). The Oodle compression library
(`oo2core`) is not bundled.

To verify a shipped build against the source: unzip the release, run
`npx @electron/asar extract resources/app.asar out` on the unpacked app and
diff `out/` against the tagged commit; everything outside `node_modules/`
should match, and `resources/tools/` should contain only the items above.
The packaged `README.txt` comes from `build/README.txt` in this repository.

## Owner tools (not shipped)

`owner-tools/update-featured-authors/` pushes `featured.json` to the
`EnvianMods/SWZeroCompanyFeaturedAuthors` GitHub repo, which every installed launcher polls
(`REMOTE_ROSTER_URL` in `lib/featured.js`). Editing the roster there updates the
Featured Transmissions strip for all users live — no launcher update needed. Needs a
GitHub token (env `GITHUB_TOKEN` or `token.txt` beside the script) with Contents
write access to that repo. `--dry-run` previews, `--show` prints the published roster.

## Ideas for later

- Conflict-aware profile switching (warn when a profile enables a confirmed-conflicting pair)
- Linux/Proton/Steam Deck support (Electron builds cross-platform, but deploy paths,
  nxm registration, and 7-Zip/tar handling are Windows-specific today)

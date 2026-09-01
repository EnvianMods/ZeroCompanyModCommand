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
- **Hangar Bay** — install mods from `.zip` (native), `.7z`/`.rar` (via 7-Zip), loose
  `.pak`/`.utoc`/`.ucas` files (same-name siblings are picked up automatically), or
  extracted folders. Drag & drop anywhere in the window. Enable/disable, rename, uninstall.
- **Mod types** (auto-classified):
  - `pak` / `iostore` → deployed to `SWZeroCompany/Content/Paks/~mods` with
    `pakchunk99-P###_Name` priority naming (matched basenames across pak/utoc/ucas).
  - `logicmods` → `SWZeroCompany/Content/Paks/LogicMods`.
  - UE4SS Lua/DLL mods (folders with `Scripts/main.lua` or `dlls/main.dll`) →
    `SWZeroCompany/Binaries/Win64/ue4ss/Mods/<Name>` with `enabled.txt`.
  - UE4SS runtime archives (dwmapi.dll + ue4ss folder) → installed into `Binaries/Win64`.
- **Load Order** — drag to reorder pak/IoStore mods; applying renumbers the deployed
  `P###` prefixes (later = wins conflicts). **Suggest order** proposes an ordering
  (broad mods first, targeted patches later so the focused mod wins) and lists which
  confirmed conflicts the ordering decides; review then Apply.
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
  (Hangar Bay profile bar), then apply/delete. Mods installed after a profile was
  saved are appended last with a warning; missing mods are skipped.
- **Featured transmissions** — the Holonet opens with a rotating 3-slot promo strip of
  mods by the featured-creator roster. The roster is owner-controlled, not a user
  setting: the baked-in list lives in `lib/featured.js` (ships with launcher updates),
  and an optional `REMOTE_ROSTER_URL` there can point at an owner-hosted JSON
  (`{"promotedAuthors": [...]}`) that every installed launcher fetches live — edit
  that one file to change the roster for everyone without shipping an update. Slots
  cycle every 6s (pause on hover, off with reduced motion). Roster mods carry an amber
  PROMOTED tag; slots the roster can't fill are backfilled with random top-downloaded
  mods, tagged TOP RATED in cyan and reshuffled each cycle.
- **Datapad (config editor)** — edit game and mod config files in-app: the UE user
  configs (`%LOCALAPPDATA%\SWZeroCompany\Saved\Config\Windows\` — Engine.ini,
  GameUserSettings.ini, Input.ini, Scalability.ini; missing ones are created on first
  save), UE4SS-settings.ini and mods.txt, config files found inside UE4SS mod folders,
  plus any file added via "Add file…" (right-click a custom entry to remove it).
  INI files get a structured section/key/value view that preserves comments, ordering
  and duplicate keys exactly (only values are editable); Raw view edits the full text.
  The original file is backed up to `.zcbak` on first save.
- **Holonet browser** — an in-app Nexus Mods browser for Zero Company: grid of mods
  with thumbnails, author/version/category, download & endorsement counts, live search,
  category filter, and sorting (downloads / endorsements / newest / updated / name),
  with paging. Powered by the Nexus GraphQL v2 API (no key needed to browse). The
  Install button downloads+installs directly for premium accounts; non-premium
  accounts get the mod's Files page opened — pressing "Mod Manager Download" there
  sends the nxm:// link back into the manager, which installs it automatically.
- **Nexus Mods integration** — paste your personal API key in Settings (validated
  against the Nexus API; stored locally in `data/manager-data.json`, never shown to
  the UI). Register the `nxm://` handler and "Mod Manager Download" buttons on
  nexusmods.com install straight into the manager, with download progress, auto
  naming/version from Nexus mod info. Non-premium accounts must start downloads from
  the website button (the nxm link carries the required key/expires).
- **UE4SS one-click install** — Settings → UE4SS → Download & install fetches the
  latest experimental UE4SS runtime zip from GitHub (UE4SS-RE/RE-UE4SS) and installs
  it into `Binaries/Win64`.
- **Incompatibility check** — pairwise conflict detection between enabled mods:
  **CONFIRMED** pairs modify the same game assets (asset paths extracted from each mod's
  `.utoc` via `retoc list --path`); **SUSPECTED** pairs ship identically named files.
  Each conflicting mod shows a clickable "⚠ N conflicts" chip in the Hangar Bay that
  expands to the opposing mod, the overlapping asset paths, and which mod wins (loads
  later). The full report also appears in Diagnostics, which additionally rescans any
  IoStore mods installed while retoc was unavailable.
- **Diagnostics** — installation health scan: game layout, Steam manifest/build,
  `~mods` presence, UE4SS layout, retoc/7-Zip availability, deployed-file audit, conflicts.
- **Settings** — game/retoc/7z paths, close-on-launch, reduced motion.

## Layout

```
main.js            Electron main process (IPC, dialogs, launch, diagnostics)
preload.js         contextBridge API (window.zc)
lib/steam.js       Steam library scan + appmanifest parsing (AppID 2075800)
lib/store.js       portable JSON store  → data/manager-data.json
lib/mods.js        mod engine: classify/install/deploy/order/conflicts/UE4SS
lib/archive.js     zip (extract-zip) + 7z/rar (7-Zip CLI)
src/               UI (index.html / styles.css / app.js) — holo-terminal theme
data/              settings + mod library (canonical copies of installed mods)
```

Mods keep their canonical files in `data/library/<id>/`; enabling copies them into the
game, disabling removes them. Uninstalling removes both. The store is portable — the
whole folder can be moved.

## Releases

```
npm run dist
```

produces `release/ZeroCompanyModCommand.exe` — a single portable executable. When run,
it keeps its settings and mod library in a `ZeroCompanyModCommand-data` folder next to
the exe (the dev `data/` folder is separate). The `nxm://` registration from a portable
exe points at the exe's on-disk location, so keep it somewhere permanent.

Shipping structure (v1.0.0 onward):
- version lives in `package.json`; per-version notes in `CHANGELOG.md`
- the Nexus upload is `release/ZeroCompanyModCommand-v<version>.zip`, containing
  `ZeroCompanyModCommand.exe` + `README.txt` + `CHANGELOG.md`
  (the exe filename stays constant across versions so nxm:// registrations survive updates)
- mod-page art: `src/assets/nexus-banner.png` (header) and `mod-placeholder@2x.png`

## Releasing via GitHub

The project is a git repo with `origin` set to
`github.com/EnvianMods/ZeroCompanyModCommand`. Full release flow:

1. Bump `version` in package.json, add a CHANGELOG entry, commit
2. `npm run dist`, zip exe + README.txt + CHANGELOG.md as
   `ZeroCompanyModCommand-v<version>.zip`
3. `git push` the source
4. `owner-tools\...\"Publish Release.bat" <version> <path-to-zip> --notes "..."`
   — creates the GitHub Release, uploads the zip, and announces the version to
   every installed launcher (the in-app update banner points at the release page)

## Owner tools (not shipped)

`owner-tools/update-featured-authors/` pushes `featured.json` to the
`EnvianMods/SWZeroCompanyFeaturedAuthors` GitHub repo, which every installed launcher polls
(`REMOTE_ROSTER_URL` in `lib/featured.js`). Editing the roster there updates the
Featured Transmissions strip for all users live — no launcher update needed. Needs a
GitHub token (env `GITHUB_TOKEN` or `token.txt` beside the script) with Contents
write access to that repo. `--dry-run` previews, `--show` prints the published roster.

## Ideas for later

- Conflict-aware profile switching (warn when a profile enables a confirmed-conflicting pair)
- Mod update checks against Nexus (md5/version polling)
- Backup/restore of game-folder files overwritten by runtime installs

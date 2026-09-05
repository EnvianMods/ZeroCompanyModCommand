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
    `SWZeroCompany/Binaries/Win64/ue4ss/Mods/<Name>` with `enabled.txt`. The
    display name defaults to the folder name; a `modinfo.json` in the mod folder
    can override it with a friendly title (see **Mod metadata** below).
  - UE4SS runtime archives (dwmapi.dll + ue4ss folder) → installed into `Binaries/Win64`.
  - `gamefolder` (GAMEFILES) — archives laid out against the game root
    (`SWZeroCompany/...`, `Engine/...`, e.g. replacement movies) deploy over the
    game's own files. The original of every replaced file is backed up to
    `data/backups/gamefiles/<id>/` first and restored on disable/uninstall.
- **Multi-mod archives** — an archive holding several mods installs each as its
  own entry (separate enable/order/update/remove): UE4SS mod folders split per
  folder, pak containers split by containing folder (multiple paks in ONE
  folder stay one mod), LogicMods subfolders keep their deployment, and each
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
  and routes the Launch button to a direct exe start while frozen. Re-asserted
  at startup, reported in Diagnostics, fully reversible. EA App has no per-game
  mechanism — users are pointed at the EA App's global auto-update setting.
- **Installed badges in Holonet/Forge** — cards for mods already in the hangar
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
  against the Nexus API; stored encrypted with your OS user credentials — Windows
  DPAPI via Electron safeStorage — and never shown to the UI; a legacy plaintext
  key is migrated automatically). Register the `nxm://` handler and "Mod Manager Download" buttons on
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
- **Support reports** — Diagnostics → Copy support report / Save report…:
  a single sanitized text block (game/launcher/build, tools, full mod list
  with origins and priorities, conflicts, hook collisions, duplicates, health
  scan, session log). Paths, usernames and machine names are scrubbed by
  `lib/report.js`; the in-memory session log lives in `lib/log.js`.
- **Diagnostics** — installation health scan: game layout, Steam manifest/build,
  `~mods` presence, UE4SS layout, retoc/7-Zip availability, deployed-file audit, conflicts.
  Also flags **duplicate mods** — the same UE4SS mod active under two folders in
  `ue4ss/Mods` (e.g. a manager install plus a leftover from a manual/one-click
  install under a different name). Two active copies run at once (double
  hooks/loops) and cause frame stutter; folders are matched by `modinfo.json`
  title or identical entry script, so a copy with a manifest and one without
  still pair up. The report names each folder and whether it's managed.
- **Settings** — game/retoc/7z paths, close-on-launch, reduced motion.

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

## Releasing

**Distribution policy (2026-09-01, until otherwise stated):** users download from
NEXUS — update announcements always point at the Nexus mod page, so update traffic
counts toward download stats, rankings, and Donation Points. GitHub gets a silent
mirror release (source + zip) for backup and transparency, with no announcement.

The project is a git repo with `origin` set to
`github.com/EnvianMods/ZeroCompanyModCommand`. Full release flow:

1. Bump `version` in package.json, add a CHANGELOG entry, commit
2. `npm run dist`, zip exe + README.txt + CHANGELOG.md as
   `ZeroCompanyModCommand-v<version>.zip`; snapshot the source (no
   node_modules/release/data/.git) as `...-source-v<version>.zip`
3. Upload the zip to the Nexus mod page (new file version + changelog)
4. `"Archive Release.bat" <version> <build-zip> <source-zip> --notes "..."`
   — pushes the version archive (both zips as Release assets + synced changelog)
   to github.com/EnvianMods/ZeroCompanyModCommandArchive. This replaces the old
   local copy into "Envian Mods and Projects" (that folder is now legacy).
5. `git push` the source, then optionally
   `"Publish Release.bat" <version> <path-to-zip>` — silent GitHub mirror on the
   source repo
6. `"Update Launcher Version.bat" <version> "https://www.nexusmods.com/starwarszerocompany/mods/<id>?tab=files" --notes "..."`
   — announces to every installed launcher, pointing at Nexus

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

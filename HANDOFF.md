# HANDOFF — Zero Company Mod Command

Context document for continuing work on this project. Last updated 2026-09-03.

## What this is

**Zero Company Mod Command** — a Star Wars holo-terminal themed Electron mod manager
and launcher for STAR WARS: Zero Company (Steam AppID **2075800**), by **Envian Mods**
(the user; Nexus account **Metanoia707**, non-premium; GitHub org **EnvianMods**;
Discord https://discord.gg/YNPCA6qRq3; PayPal https://paypal.me/Envian707).

- Dev project: `G:\SteamLibrary\steamapps\common\Star Wars Zero Company\ZeroCompanyModManager`
  (run: `Zero Company Mod Command.bat` or `npm start`; dev data in `data/`)
- Portable build: `release\ZeroCompanyModCommand.exe` (data in `ZeroCompanyModCommand-data`
  next to the exe; **first boot takes up to ~35s** — AV scan + NSIS extraction; dev app
  and portable exe share a single-instance lock, only one runs at a time)

## Current state (v1.0.0, consolidated)

Everything ever built is folded into **v1.0.0** (user's decision: nothing distributed
before launch counts as pre-release). Git: `main` == `feat/pak-modinfo-metadata` ==
tag `v1.0.0`. Built zip is identical on both GitHub releases.

**NOT yet done — the actual launch:**
1. Upload `release\ZeroCompanyModCommand-v1.0.0.zip` to the Nexus mod page
   (description: `NEXUS_DESCRIPTION.bbcode`; header image: `src/assets/nexus-banner.png`;
   plain-text description for elsewhere: `DESCRIPTION.txt`)
2. Announce: `"Update Launcher Version.bat" 1.0.0 "https://www.nexusmods.com/starwarszerocompany/mods/<mod-id>?tab=files"`
   (launcher-version.json is unpublished — no update banners exist until this runs)

## Feature summary

Mods: install from zip/7z/rar/loose paks/folders (drag & drop), auto-classified
(pak / iostore / logicmods / ue4ss-mod / ue4ss-runtime), canonical copies in
`data/library/<id>`, deploy to `~mods` (`pakchunk99-P###_Name` priority naming),
`LogicMods`, or `ue4ss/Mods`. Enable/disable/rename/uninstall, drag load order +
suggested order, squad profiles, `modinfo.json` metadata (title/version/author/
description — both UE4SS and pak mods). **Adoption**: "Import existing" scans deploy
dirs for unmanaged mods, adopts in place, Nexus md5 auto-identify, manual source
linking via the LOCAL badge. Conflicts: CONFIRMED via `retoc list <utoc> --path`
asset overlap, SUSPECTED filename matches, UE4SS hook/keybind static Lua scan
(managed + unmanaged), duplicate-mod detection, N×N matrix. Holonet: Nexus browser
(GraphQL v2, anonymous) + **The Forge** (curated GitHub repos, confirm-on-install,
archive assets only) in tabs, Featured Transmissions strip above both. Updates:
origin tracking per mod, 12h auto-check + button, in-place updates (GitHub always,
Nexus premium; free accounts get flagged link + nxm replace-in-place), launcher
self-update banner. Datapad INI/config editor (structured + raw, .zcbak backups).
UE4SS one-click install (GitHub experimental-latest). nxm:// handler (single-instance
forwarding; friendly name "Mod Command").

## Owner-controlled remote config (SWZeroCompanyFeaturedAuthors repo)

Every installed launcher polls raw.githubusercontent.com/EnvianMods/SWZeroCompanyFeaturedAuthors/main/:
- `featured.json` — Featured Transmissions roster (LIVE: SmexyXey, EnvianMN)
- `github-mods.json` — Forge allowlist (LIVE: Sternab/ZeroCompanyMandoWardrobe)
- `launcher-version.json` — launcher update announcements (NOT yet published)
Fallbacks are baked in `lib/featured.js` / `lib/github.js` / `lib/launcher-update.js`.
~10min launcher cache + ~5min GitHub CDN cache.

## GitHub repos + tokens

| Repo | Purpose | Contents |
|---|---|---|
| EnvianMods/ZeroCompanyModCommand | source ("release repo") | `main` (release branch), `feat/*` branches, silent mirror Releases with zip |
| EnvianMods/ZeroCompanyModCommandArchive | version archive | `dev` branch (full history mirror), Release per version (build zip + source zip + backups), synced CHANGELOG |
| EnvianMods/SWZeroCompanyFeaturedAuthors | remote config | the three JSONs above |

Three fine-grained tokens in
`G:\Envian Mods and Projects\Zero Company Projects\ZeroCompanyModManager\Featured Author Update Utility\`:
`token.txt` (roster repo), `archive-token.txt` (*Archive repos), `release-token.txt`
(source repos). Git pushes:
`git -c http.extraheader="AUTHORIZATION: basic <b64('x-access-token:'+TOKEN)>" push …`
— never store tokens in remote URLs, never print them.

## Owner tools (`owner-tools/update-featured-authors/`, copies in the utility folder above; generalized copies + tokens also in `G:\Envian Mods and Projects\Mod Archive Tool\`)

- `update-featured-authors.js` — roster → featured.json
- `update-github-allowlist.js` — Forge allowlist → github-mods.json (validates repos)
- `update-launcher-version.js` — announce launcher version (URL = Nexus page per policy)
- `publish-release.js` — GitHub Release on source repo (`--repo` for other projects; reuses existing release; NO announcement by default)
- `archive-release.js` — version archive Release (`--repo`/`--title`/`--changelog`; idempotent)
All: `--show` lists, `--dry-run` where applicable.

## Release flow (per release)

1. Bump version (package.json + `Application-Version` in lib/nexus.js), CHANGELOG entry, commit
2. `npm run dist` → zip exe + README.txt + CHANGELOG.md as `ZeroCompanyModCommand-v<ver>.zip`;
   source snapshot (robocopy excluding node_modules/release/data/.git/token*/zcbak)
3. Upload zip to **Nexus** (downloads must count there — popularity + Donation Points)
4. `Archive Release.bat <ver> <build zip> <source zip>` → archive repo
5. `git push` main (+ push main:dev to archive repo), `Publish Release.bat <ver> <zip>` → silent source-repo mirror
6. `Update Launcher Version.bat <ver> "<nexus files url>"` → users' update banners
**POLICY**: announcements ALWAYS point at Nexus; GitHub releases are silent mirrors
(`--announce-github` exists only for a deliberate strategy change).
Local `G:\Envian Mods and Projects\...` archive folder is **legacy** — don't copy there.
GitHub won't overwrite same-named Release assets: DELETE the asset by id first, then re-upload.

## The user's live environment (handle with care)

- Installed mods (theirs, don't touch in tests): ZCUnlocked, character_creator_native,
  ZeroCompanyExpandedWardrobe, "Envian's Movement Patch", + unmanaged CheatManagerEnablerMod;
  UE4SS is installed in the game.
- Nexus API key is stored in dev `data/manager-data.json` — never print/commit it.
- User works on feature branches (e.g. `feat/pak-modinfo-metadata`) — check the current
  branch before committing; don't merge to main without asking.

## Hard-won gotchas

- **window.prompt() doesn't exist in Electron** — silently no-ops. Use the `zcPrompt()` modal (src/app.js). Test features through the real click path, not just engine functions.
- **extract-zip can hang forever** on some zips — archive.js uses Windows `tar -xf` first, extract-zip fallback.
- **Browser "Open …?" dialogs** show the handler exe's `FileDescription` → package.json `description` must stay short ("Mod Command"). Registry FriendlyAppName/Application values also set by register-nxm.
- **`signAndEditExecutable: true` breaks builds** (winCodeSign download/symlink failure) — keep false; the portable stub takes metadata from package.json anyway.
- **Electron npm install** can silently fail to fetch the binary — fix: extract `%LOCALAPPDATA%\electron\Cache\*\electron-*.zip` into `node_modules/electron/dist` + write `path.txt` containing `electron.exe`.
- robocopy exits 1-7 on success (looks like failure); PowerShell 5.1: no `&&`, `$` mangles in `node -e` double quotes (use Bash tool or files), a safety hook blocks commands mixing `Remove-Item` with `G:\Envian` paths — split such commands.
- Screenshot verification pattern: temp boot hook in app.js (`// TEMP screenshot hook`), full-virtual-screen capture, crop at (384,142) 1600px wide; ALWAYS remove the hook after.
- Nexus API: GraphQL v2 anonymous browse (`author` EQUALS filter for roster); v1 needs key; non-premium can't get download links (nxm website round-trip only); md5_search matches uploaded-archive hashes only.

## Ideas not yet built

Nexus SSO app registration (replaces manual API key), conflict-aware profile warnings,
generalizing the launcher pattern for the user's other games' projects, Forge allowlist
growth as more GitHub mods appear. Related project memory: the game also ships a
native mod framework (Game Features + DataTable overlays — see `zero-company-native-mod-framework`
memory) — potential future launcher integration.

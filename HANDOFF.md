# HANDOFF — Zero Company Mod Command

Context document for continuing work on this project. Last updated 2026-09-04.

## v1.6.0 (2026-09-04, feat/import-managers branch, NOT released)

Branch lineage: feat/api-key-help → feat/first-run-setup → feat/import-managers.
Headline: MOD ARCHIVE IN THE GAME FOLDER. lib/storage.js
(resolveStorageRoot/migrateStorage); Store.setStorageRoot re-points
library/backups/versions; save() MIRRORS manager-data.json into the archive
(guard: an empty store never clobbers a restorable mirror — found via the
scenario test, ensureStorage saved before auto-restore read it). main.js
ensureStorage (startup + game-path change + choose/reset-storage-dir IPC,
copy-verify-delete migration), autoRestoreFromArchive (fresh store + mirror →
engine.restoreFromData pruneImported). restoreFromData restores names/versions/
origins/enabled/order/profiles/vault. IMPORT: scanOrphanLibraries/adoptOrphan
(library dirs without records), importForeignLibrary (per-subfolder, descends
into library|mods, md5 identify via main.identifyOnNexus), detectManagerSources
(app-side data + LOCALAPPDATA ZCOM guesses), Import modal manager section +
"Import from a manager folder…". FIRST SCAN: settings.firstScanDone — after
first game connection the import review OPENS ITSELF when anything is found
(queued behind the setup wizard). HOLONET VERSIONS: ⧗ picker per card →
nexus-file-versions/nexus-install-file IPC (premium installs any file —
existing installs switch via replaceOrigin+vault; free → files page). Cards
refresh IN PLACE via liveCards registry (refreshBrowseCards in render()) — no
grid re-fetch. Also: setup wizard (first run; Settings → Setup assistant),
API-key guidance + next.nexusmods.com allowlisted, Holonet default sort =
endorsements. Tests: engine-test-v16.js (20) + all suites = 161 green; two
full scenario click-path runs (the failing first run caught the mirror bug).

## v1.5.0 RELEASED 2026-09-04 (merged to main, tag v1.5.0) — CURRENT

Nexus: file id 560 (Windows zip, main + primary MM) + file id 561 (Linux
AppImage, optional). Archive Release + GitHub mirror done. CI PIPELINE NOW
FULLY HANDS-OFF: the tag push built the AppImage, CI created the release with
it (race fix), publish-release reused the release and added the zip — no
manual attach needed anymore. NEXUS_DESCRIPTION.bbcode covers everything
through v1.5.0 — paste it at Publish time. STILL OUTSTANDING: (1) press
Publish + paste description + announce 1.5.0 via Update Launcher Version.bat;
(2) archive-token still lacks `workflow` scope → dev mirror stalled at
b6efcbd; (3) Steam Deck hardware test; (4) ea-compat.json seed.

## v1.5.0 (2026-09-04, feat/vault-and-freeze branch) — vault, freeze, QoL

Four user-requested features, NOT yet released:
1. Enable/Disable all (Hangar profile bar; engine.setAllEnabled with ONE
   aggregate ownership pre-check so nothing half-toggles).
2. Holonet/Forge installed badges: green IN HANGAR tag (matched by origin
   nexus modId / github repo), Install → "✓ Installed" disabled, or "⬆ Update"
   straight on the card when updateInfo is set.
3. VERSION VAULT: data/versions/<modType-name-slug>/<timestamp__version>/
   {files/, vault.json}; snapshots on every replaceOrigin + before rollback
   (roll-forward works); newest 5 kept; ⧗ button on Hangar rows → modal;
   engine.listVersions/rollbackVersion (reinstalls library-layout copy via
   install()). PROFILES now pin versions (entries carry vaultKey+version;
   applyProfile is ASYNC, swaps pinned versions from the vault, remaps saved
   order ids through the swaps). Identity = modType+name → rename starts new
   history (documented).
4. GAME UPDATE FREEZE (opt-in toggle, Steam only): steam.setUpdateFreeze sets
   AutoUpdateBehavior "1" + chmods the appmanifest read-only; Launch goes
   direct-exe while frozen; re-asserted at startup; Diagnostics reports state;
   EA/manual installs get guidance instead. attachManifest IMPROVED: a path
   shaped <lib>/steamapps/common/<game> reads its neighbor manifest directly
   (covers unregistered libraries; also what makes freeze testable).
Tests: engine-test-v15.js (21) + all four prior suites green (121 total);
bulk-toggle/vault verified through real clicks.

## v1.4.0 RELEASED 2026-09-04 (merged to main, tag v1.4.0)

Nexus: file id 555 (Windows zip, main + primary MM) and file id 556 (Linux
AppImage, optional, non-primary) on draft page 121. Archive Release + silent
GitHub mirror done (release carries zip + AppImage); main/branch/tag pushed
BEFORE publish-release (order gotcha respected). CI built the AppImage
successfully with the fixed permissions, but its attach step still raced the
release creation (CI finishes ~3min after tag; the release exists only after
the ~6min local flow) → attached manually again; the workflow now CREATES the
release when missing (publish-release reuses it), so the next tag should need
no manual step. Announcement still NOT run (page unpublished): after Publish,
announce 1.4.0. Archive repo dev mirror STILL stalled (archive-token workflow
scope).

## v1.4.0 (2026-09-04, feat/support-reports branch) — support reports

Diagnostics → Copy support report / Save report…: lib/report.js (buildReport +
makeSanitizer scrubbing gamePath/dataDir/home/username/hostname, longest-rule-
first, both slash styles, case-insensitive) + lib/log.js (600-entry in-memory
session log; wired into IPC error wrapper + install/enable/order/update/fomod/
recovery events; nothing on disk). IPC support-report / save-support-report.
CI FIXES riding this branch: --publish never on tag builds (electron-builder
otherwise self-publishes and dies without GH_TOKEN) + permissions contents:
write (default workflow token got HTTP 403 on release upload — the v1.3.0
AppImage was attached MANUALLY via API instead). NOT released.

## AppImage + Nexus multipart (2026-09-04)

v1.3.0 AppImage: CI built it (run 33926839636), attach failed on permissions →
downloaded artifact + attached via API + uploaded to NEXUS as file id 554
("Zero Company Mod Command (Linux AppImage)", category optional, NOT primary).
upload-nexus-file.js now supports --category/--no-primary AND >100MiB files:
v3 MULTIPART flow = POST /v3/uploads/multipart {size_bytes,filename,md5} →
{id, part_size_bytes(50MiB), part_presigned_urls[], complete_presigned_url} →
PUT each part (collect ETag headers) → POST S3 CompleteMultipartUpload XML
(<Part><PartNumber/><ETag/>) to complete_presigned_url → POST finalise → poll.
Bare finalise without the S3 completion 422s ("file could not be found").

## v1.3.0 RELEASED 2026-09-04 (merged to main, tag v1.3.0)

Nexus file id 551 (global 42893838385703, main + primary MM download) on draft
page 121. Archive Release + silent GitHub mirror done; main/tag pushed.
RELEASE-ORDER GOTCHA (hit this time): run `git push origin main <tag>` BEFORE
publish-release.js — creating the GitHub release first mints the remote tag at
the OLD remote main; fix is `git push --force origin <tag>` (done for v1.3.0,
release now points at the merge commit). GitHub Actions is now ENABLED on the
source repo: tag pushes trigger Build Linux AppImage. Archive repo dev mirror
STILL stalled (archive-token still lacks workflow scope).

## v1.3.0 (2026-09-04, feat/multi-mod-split branch) — multi-mod archives

Every mod in an archive becomes its own entry (ZCOM's last install-side edge):
engine._splitModGroups (UE4SS folders each split; pak/utoc/ucas group by
containing folder — several paks in ONE folder stay one mod; LogicMods
subfolders keep type; runtime/gamefolder/root-level-ue4ss never split; each
entry reads its own modinfo.json). install() returns {multi:true, mods, errors}
when split; opts {origin, version} thread through install/_installFromFolder/
FOMOD session so Nexus/GitHub origin stamps every entry. replaceInPlace REMOVED
→ engine.replaceOrigin(match, source, newOrigin, newVersion): uninstalls all
entries sharing the origin, reinstalls (re-splits), restores enabled/priorities
by name (single-entry keeps custom name). ALSO FIXED: a Nexus/GitHub download
carrying a FOMOD script now forwards the wizard to the renderer
('fomod-pending' event, main.js forwardFomod) — previously the session leaked
and nothing installed. Tests: engine-test-v13.js (21) + both prior suites green
(83 total); UI drop-path verified. NOT released.

## v1.2.0 RELEASED 2026-09-04 (merged to main, tag v1.2.0)

Nexus file id 550 (global 42893838385702, main + primary MM download) on the
still-unpublished draft page 121. Archive Release v1.2.0 done; silent GitHub
mirror release done; main/branch/tag pushed to source repo. OUTSTANDING:
1. Archive repo dev mirror is STALLED at b6efcbd — archive-token.txt lacks the
   `workflow` scope (main now contains .github/workflows/build-linux.yml).
   Extend that token like the release token, then: push main:dev.
2. Linux AppImage: workflow registered+active on the source repo but the v1.2.0
   tag push started NO run — GitHub Actions is likely disabled in the repo/org
   settings (token can't read/change it; Actions API dispatch also needs an
   `Actions: write` token permission the release token lacks). Enable Actions,
   then press "Run workflow" on Build Linux AppImage (or re-push a tag) — on a
   v* tag run it auto-attaches ZeroCompanyModCommand.AppImage to that GitHub
   release. Then optionally upload the AppImage to Nexus as an optional file.
3. Linux paths still untested on real hardware — test on Deck before promoting.

## v1.2.0 (2026-09-04, feat/steam-ea-linux branch) — cross-launcher release

Built on the user's ask to close the remaining ZCOM gaps + go further:
- **Build warnings**: mods record installedBuild (Steam buildid or `local-<hash>`
  exe fingerprint via steam.buildFingerprint); "game updated" chip → confirmBuild.
- **UE4SS start order**: managed block in mods.txt between the
  `; === Zero Company Mod Command start order (managed block) ===` markers,
  inserted before Keybinds keeping its warning attached; DLL/Lua pass tags;
  enabled.txt retired + pruned from deploy records once block is authoritative;
  auto-resync on enable/disable/uninstall/rename (engine._syncUe4ssModsTxt).
- **EA App support**: lib/ea.js — detection (registry EA Games keys, EA Games
  dirs, `__Installer` signature), launcher classification in steam.detectGame
  (steam/ea/manual), direct-exe launch for EA, per-mod compat from modinfo
  (`eaCompatible`, `launchers`) + community ea-compat.json (same remote-config
  repo; owner tool update-ea-compat.js --bad/--good <nexusId>; NOT yet
  published — baked fallback is empty). fullState.modCompat map drives chips.
- **Linux/Proton/Steam Deck**: steam.js Linux roots (native/classic/flatpak),
  proton compatdata detection, .desktop+xdg-mime nxm registration, p7zip,
  Diagnostics WINEDLLOVERRIDES guidance, AppImage target. AppImage CANNOT be
  cross-built on Windows (symlink privilege) — a CI workflow builds it on
  ubuntu-latest (tags + manual) and attaches it to the tag's release. The
  workflow is STAGED at owner-tools/ci/build-linux.yml because the release
  token lacks the `workflow` scope: move it to .github/workflows/ via the
  GitHub web UI, or grant the token Workflows read/write and push it.
  Linux paths are code-reviewed but UNTESTED on real Linux — say so in notes.
- Engine tests: scratchpad engine-test-v12.js (31 checks) + v1.1.0 suite rerun;
  UI verified through real clicks (EA chip, build chips, start-order apply).
NOT released yet — awaiting the user's go for the Nexus/GitHub release flow.

## v1.1.0 (2026-09-04) — ZCOM-parity release

Everything ZCOM Mod Manager (Nexus mod 29, the competing manager) listed as a
strength that was shippable on Windows is now in Mod Command: FOMOD guided
installers (lib/fomod.js + wizard in src/app.js; scripts read, never executed,
paths re-validated main-side), game-folder replacement mods with backup/restore
(modType 'gamefolder', backups in data/backups/gamefiles/<id>), SHA-256
ownership with verify-before-disable/uninstall/reorder (VERIFY_CHANGED:: error
protocol → renderer confirm → force), safeStorage-encrypted Nexus API key
(auto-migrates plaintext), traversal-safe extraction, load-order
review-before-apply + one-step rollback + startup redeploy recovery.
NOT done (deliberate): Linux/Proton (Windows-specific registry/paths/tools;
would ship untested), open-source relicensing (owner's legal call).
Engine test suite pattern: see the session scratchpad engine-test.js approach —
temp Store + fake game dir; UI verified via TEMP hook + ZC_DATA_DIR override
(new: env ZC_DATA_DIR redirects the data dir for isolated test runs).

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

**Nexus draft page EXISTS (unpublished): mod id 121** —
https://www.nexusmods.com/starwarszerocompany/mods/121 (global API id 42893838385273).
Created 2026-09-03: General (bbcode description, Utilities, tag "Utilities for Players",
author "Envian Mods", version 1.0.0), Media (5 gallery screenshots, copies in `docs/screenshots/`),
Files (v1.0.0 zip uploaded via the **Nexus v3 API**, main file id 519, primary MM download).
Header image SET (`src/assets/nexus-header.png`, 1300x372, source `nexus-header.svg`; an exact-size
image skips Nexus's canvas crop, which Brave's fingerprinting shield otherwise blocks).
The description's Discord banner reads "Join Smexy's Mods Discord" — that is correct: the server is
shared with SmexyXey and Envian has his own section in it.

**v1.1.0 released 2026-09-04** (still on the unpublished draft page): Nexus file
id 549 (global 42893838385701, main + primary MM download, uploaded via
`owner-tools/update-featured-authors/upload-nexus-file.js` — the v3 flow is now
a script; reads the key from nexus-key.txt / NEXUS_API_KEY / pre-1.1.0 dev
store). Archive Release + silent GitHub mirror + main/dev pushes done for 1.1.0.
NOTE: v1.1.0 encrypts the Nexus key in the app store (safeStorage) — once the
dev app runs on 1.1.0, `data/manager-data.json` no longer has the plaintext key;
put a copy in `owner-tools/update-featured-authors/nexus-key.txt` (gitignored)
for the upload script. Old v1.0.0 file (id 519) left as-is on the page — archive
it manually after publishing if desired.

**NOT yet done — the actual launch:**
1. Press **Publish** on the mod page (description update: paste the refreshed
   `NEXUS_DESCRIPTION.bbcode` — it now covers the v1.1.0 features)
2. Announce: `"Update Launcher Version.bat" 1.1.0 "https://www.nexusmods.com/starwarszerocompany/mods/121?tab=files"`
   (launcher-version.json is unpublished — no update banners exist until this runs)

**Nexus v3 API upload flow** (works with the personal API key as an `apikey` header):
GET /v3/games/<domain>/mods/<id> → global id; POST /v3/uploads {size_bytes, filename, md5 hex}
→ PUT bytes to presigned_url with Content-Disposition: attachment; filename="<name>",
Content-MD5 (base64) and **Content-Type: application/octet-stream** (signed; application/zip fails);
POST /v3/uploads/<id>/finalise; poll GET /v3/uploads/<id> until state=available; POST /v3/mod-files
{upload_id, mod_id (global), name, version, file_category:"main", primary_mod_manager_download:true}.
Worth folding into owner-tools as an upload script for future releases.

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
- **Chromium protocol dialog name is cached per browser process.** Chrome/Brave/Edge call `AssocQueryString(ASSOCSTR_FRIENDLYAPPNAME)` for `nxm` once and keep the answer in memory; `SHChangeNotify` does NOT refresh it. A stale "Open A Star Wars themed…" label means the browser process predates the last handler registration, or the handler was registered by an old build (no `FriendlyAppName` value on the command key). Fix: Unregister → Register handler in the app, then fully exit the browser (check `tasklist | findstr brave.exe`). The launch command itself is not cached, so links still open the right exe.
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

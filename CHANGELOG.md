# Zero Company Mod Command — Changelog

## v1.6.0 (2026-09-04)

**Your mod archive now lives in the game folder — and survives everything**
- The archive (installed mods, game-file backups, version vault, and a mirror
  of the manager's records) now defaults to `<game>\ZeroCompanyModArchive`.
  Deleting or updating the app no longer touches your mods: a fresh install
  finds the archive and restores everything automatically — names, versions,
  origins, enabled states, load order, squad profiles, archived versions
- Settings → Paths → Mod archive: move it anywhere (contents are copied,
  verified, then removed from the old location) or reset to the game-folder
  default. Existing installs migrate their archive automatically on first start

**Import from mod managers — not just game files**
- Import existing now also finds: orphaned entries in the manager's own
  archive (a lost settings file no longer strands your mods), a previous Mod
  Command data folder, and other managers' libraries in known locations —
  plus "Import from a manager folder…" for anywhere else
- A Mod Command archive restores with full metadata; foreign libraries import
  every mod folder as its own entry, then try to identify each on Nexus (md5)
  so names and update tracking come back

**Choose any version from the Holonet**
- Every Holonet card gains a ⧗ version picker listing all files the mod's
  Nexus page offers (newest first, with category, size, and date). Premium
  accounts install any version directly — switching an installed mod vaults
  the current version first; free accounts get routed to the exact files page
- Cards refresh in place after any install: buttons flip to "✓ Installed"
  (or "⬆ Update") immediately, without reloading the mod list from Nexus

**First-run experience**
- A setup assistant on first launch walks through game detection, getting and
  saving the Nexus API key (with a link to the key page and step-by-step
  instructions), and registering nxm:// one-click downloads; reopen it any
  time via Settings → Setup assistant
- Settings gains the same API-key guidance and link
- Holonet default sort is now Most endorsed

**Streamlined layout — five tabs instead of seven**
- The Command Deck and Hangar Bay are one tab: the operational overview on
  top, the full mod list (actions, squad profiles, Enable/Disable all) below
- Diagnostics and Load Order are one tab: compact health tiles on top (hover
  for full text), the UE4SS start order next, conflict analysis after it, and
  the pak & IoStore load order at the bottom

## v1.5.0 (2026-09-04)

**Version vault — roll back mod versions, pin them in profiles**
- Whenever a mod updates, the outgoing version is archived automatically (the
  newest 5 per mod are kept). A new ⧗ version button on every Hangar Bay row
  opens the vault: one click rolls back to any archived version — and rolling
  back archives the current version first, so you can roll forward again
- Squad profiles now pin the exact version of every mod they were saved with:
  applying a profile swaps versions back in from the vault where they differ
  (with a clear note when an archived version is no longer available)

**Game update freeze (experimental, opt-in)**
- New Settings toggle that stops the game auto-updating overnight and breaking
  a modded playthrough: it sets Steam's own "update only on launch" flag and
  locks the game's Steam manifest so no update can be scheduled, and the
  Launch button starts the game directly while frozen (a Steam launch is what
  triggers the update check). The freeze is re-asserted at startup if Steam
  unlocked the manifest, Diagnostics reports its state, and turning it off
  restores everything
- Honest limits, shown before enabling: launching from the Steam UI itself can
  still force an update, and online modes may require the current build.
  Steam installs only — EA App users get pointed at the EA App's own
  auto-update setting

**Hangar Bay & Holonet quality of life**
- Enable all / Disable all buttons (disable-all runs one aggregate file-
  ownership check first, so hand-edited files are never silently removed)
- Holonet and Forge cards now show when a mod is already installed: a green
  "IN HANGAR" badge (with a disabled note when all its entries are off), the
  Install button becomes "✓ Installed", and if an update is waiting the card
  offers "⬆ Update" directly

## v1.4.0 (2026-09-04)

**Support reports & sanitized logs**
- Diagnostics gains **Copy support report** and **Save report…**: one text
  block with everything a bug report needs — app/game/launcher/build info,
  tool status, the full mod list (type, version, origin, priorities, install
  build, EA status, pending updates), conflict pairs, UE4SS hook collisions,
  duplicates, missing deployed files, the health scan, and the session log
- Everything is sanitized before it reaches the clipboard or a file: the game
  path, the manager's data folder, your user-profile path, username, and
  machine name are replaced with placeholders; the Nexus API key is never
  included at all
- New session log: the manager records installs, enables/disables, order
  applies, update checks, guided installs, startup recovery, and every error
  in memory (nothing written to disk) — the report carries the recent tail

## v1.3.0 (2026-09-04)

**Multi-mod archives: every mod becomes its own entry**
- An archive that packs several mods now installs each as its own entry, so
  they can be enabled, ordered, updated, and removed separately:
  - every folder with `Scripts/main.lua` or `dlls/main.dll` is one UE4SS mod
    (previously only the first folder in such an archive was installed)
  - pak/utoc/ucas containers split by their containing folder — a mod that
    ships several paks in one folder stays one entry; folders under a
    `LogicMods` path keep their LogicMods deployment
  - each entry reads its own folder's `modinfo.json` for title/version/author
    and EA-compatibility declarations
  - UE4SS runtime archives, game-folder trees, and single mods never split
- Nexus/GitHub downloads that split still track their download: every entry
  carries the origin, and updating any of them replaces all sibling entries
  from a fresh download (enabled state and load-order positions are preserved
  by name across the update)
- Fixed: a Nexus/GitHub download that ships a FOMOD installer now opens the
  guided steps (previously the wizard only opened for local archive installs),
  and the finished install keeps the download's update tracking

## v1.2.0 (2026-09-04)

**EA App support — bridging the Steam and EA mod communities**
- The EA App edition of the game is now detected (registry + EA Games library
  scan, `__Installer` signature) alongside Steam installs; every mod format
  deploys identically for EA players
- Launch works for the EA edition (direct exe launch; the Launch button and
  Command Deck show which launcher owns the install)
- Per-mod EA compatibility: a mod's `modinfo.json` can declare
  `"eaCompatible": false` or `"launchers": ["steam"]`, and an owner-curated
  community list (ea-compat.json, updates live like the featured roster) flags
  known Steam-only mods by Nexus id. EA users see a red warning chip and a
  confirm before enabling; Steam users see an FYI chip so shared setups don't
  surprise EA friends. Diagnostics reports both directions

**Game-build incompatibility warnings**
- Every install/adoption records the game build it happened under (Steam
  manifest build id, or an exe fingerprint for EA/manual installs)
- When the game updates, affected mods get a "game updated" chip and a
  Diagnostics warning; after testing a mod, one click marks it verified on the
  current build

**UE4SS start order**
- New start-order panel in Load Order: drag enabled UE4SS mods; entries are
  written as one managed block in mods.txt placed just before the runtime's
  Keybinds entry, with its "do not move up" warning kept attached
- DLL-pass / Lua-pass tags reflect UE4SS's two start passes (every DLL mod
  starts before any Lua mod; order applies within each pass)
- Everything else in mods.txt — runtime entries, comments, hand-added mods —
  is preserved untouched; a managed mod hand-placed elsewhere moves into the
  block; enabled.txt markers are retired once the block is authoritative

**Linux / Proton / Steam Deck**
- Steam library discovery on Linux (native, classic, and flatpak locations),
  Proton compat-prefix detection, and an AppImage build target
- nxm:// one-click downloads register via a .desktop entry + xdg-mime
- Diagnostics gains Proton guidance (the WINEDLLOVERRIDES line UE4SS needs —
  never applied automatically) and Steam Deck notes; 7-Zip is found via p7zip
- The Launch button routes through Steam so Proton and launch options apply

## v1.1.0 (2026-09-04)

**Guided installers (FOMOD)**
- Archives that ship a FOMOD installer script now install by answering the
  author's own questions — option groups with descriptions, images and
  recommended answers, conditional steps driven by earlier choices, and a Back
  button that returns a step exactly as you left it
- Only the files your answers select are installed; they go through the same
  classification, library, and deploy pipeline as any other mod, and the
  download's update tracking keeps working
- The mod's title/version/author/description come from `fomod/info.xml`
- Installer scripts are read, never executed; every path in them is
  re-validated outside the UI before anything is written. Conditions on other
  game plugins or tool versions don't apply to Zero Company — they're shown as
  a warning and treated as unmet

**Game-folder replacement mods**
- New GAMEFILES mod type: archives laid out against the game root
  (`SWZeroCompany/...`, `Engine/...` — e.g. replacement movies) now install as
  managed mods. The original of every game file a mod replaces is backed up
  first and restored when the mod is disabled or uninstalled
- Two game-folder mods replacing the same file are flagged as a conflict on the
  exact path they both touch

**Safety**
- SHA-256 ownership: every installed and deployed file's hash is recorded.
  Disable/uninstall verifies the deployed files first — a file changed outside
  the manager stops the operation and asks before anything is deleted
- The Nexus API key is now stored encrypted with your OS user credentials
  (Windows DPAPI via Electron safeStorage); an existing plaintext key is
  migrated automatically on first start
- Archive extraction rejects path traversal and strips symbolic links

**Load order pipeline**
- Review before apply: applying a drafted order first shows every conflict pair
  and which winners change, for confirmation
- One-step rollback: “Undo last apply” restores the previous order (and undoes
  the undo if pressed again)
- Startup recovery: enabled mods whose deployed files went missing (game
  update, manual cleanup) are redeployed automatically from the library

## v1.0.0 (2026-09-01)

First public release.

**Mod management**
- Archive/folder/loose-pak installs (drag & drop), auto-classification
  (pak / IoStore / LogicMods / UE4SS mods / UE4SS runtime), enable/disable with a
  canonical mod library, rename, uninstall
- Friendly mod metadata: any mod (UE4SS or pak/IoStore) can ship a `modinfo.json`
  (`{"title", "version", "author", "description"}`) to control its display name
  and details in the Hangar Bay
- Import existing mods: adopts manually-installed mods (paks in ~mods, LogicMods,
  UE4SS folders) into full management without touching the game files. Adopted
  files matching a Nexus upload are identified automatically (md5); anything else
  can be linked by hand — click a mod's LOCAL badge to attach its Nexus page or
  curated GitHub repo so updates get tracked
- Squad profiles: save/apply/delete named mod sets with load order

**Conflict & health detection**
- CONFIRMED asset-overlap conflicts (retoc container inspection), SUSPECTED
  filename conflicts, pairwise conflict report and N×N compatibility matrix
- UE4SS hook & keybind scanning across managed and unmanaged mods
- Duplicate-mod detection: flags the same UE4SS mod active under two folders
  (double execution causes frame stutter); names each folder and which is managed
- Diagnostics: installation health scan and deployed-file audit

**Load order**
- Drag-to-reorder with priority renumbering, one-click suggested order

**Two mod sources + updates**
- Holonet: in-app Nexus Mods browser (search, category filters, sorting, paging)
  with the Featured Transmissions promo strip
- The Forge: curated GitHub mods (owner-vetted allowlist, updates live), installs
  from release archives only, behind a confirmation dialog
- nxm:// one-click download handler; Nexus API key management
- Mod update checks (automatic + on demand): GitHub mods and Nexus premium update
  in place preserving load order/names/enabled state; free Nexus accounts get a
  flagged link and the returning download replaces the old version
- Launcher update banner: the app announces when a newer launcher version is out

**Quality of life**
- Datapad: config editor for game INIs, UE4SS settings and mod configs —
  structured value editing that preserves formatting, automatic first-save backups
- UE4SS one-click runtime install
- Launch via Steam or directly; portable single-exe distribution

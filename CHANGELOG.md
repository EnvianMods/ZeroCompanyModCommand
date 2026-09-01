# Zero Company Mod Command — Changelog

## v1.3.0 (2026-09-01)

- **Friendly mod titles** — a UE4SS mod can ship a `modinfo.json`
  (`{"title": "..."}`) in its folder to set the display name shown in the Hangar
  Bay, instead of the sanitized folder name (e.g. `Envian's Movement Patch`
  instead of `Envian_s_Movement_Patch`). Opt-in; the deployed folder stays
  filesystem-safe. See README → *Mod metadata*.
- **Duplicate-mod detection** — Diagnostics now flags when the same UE4SS mod is
  active under two folders (e.g. a manager install plus a leftover from a manual
  or one-click install under a different name). Two copies run at once and cause
  frame stutter; the report names the folders and which is managed so you can
  remove the stray. Matches by `modinfo.json` title or identical entry script.

## v1.2.0 (2026-09-01)

- **Launcher update banner** — the launcher now announces when a newer launcher
  version is available, with a one-click link to the download page. No more
  modding on an outdated build without knowing it.
- **Updates at a glance** — the Command Deck shows how many mod updates are
  pending, and the Hangar Bay nav badge turns amber when updates are waiting.

## v1.1.0 (2026-09-01)

- **The Forge** — the Holonet now has two tabs: Nexus Mods and The Forge, a curated
  GitHub mod source. Only repositories vetted by Envian Mods appear (the list updates
  live, no launcher update needed). Installs come from release archives only, behind
  a confirmation dialog naming the repo and file.
- **Mod updates** — Nexus and GitHub installs are tracked. "Check updates" in the
  Hangar Bay (plus an automatic check every 12h) flags outdated mods: GitHub mods and
  Nexus premium accounts update in place with one click (name, enabled state, and
  load order preserved); free Nexus accounts get a flag that opens the mod's Files
  page, and the returning "Mod Manager Download" replaces the old version in place
  instead of duplicating it. "Update all" appears when several can auto-update.
- **Source badges** — every installed mod shows where it came from (Nexus / GitHub /
  Local); click the badge to open the mod's page.
- **Fix** — some mod zips could hang the installer forever (a zip-library bug); zip
  extraction now uses Windows' built-in extractor with the old path as fallback.

## v1.0.0 (2026-08-31)

First public release.

- Mod management: archive/folder/loose-pak installs (drag & drop), auto-classification
  (pak / IoStore / LogicMods / UE4SS mods / UE4SS runtime), enable/disable with a
  canonical mod library, rename, uninstall
- Conflict detection: CONFIRMED asset-overlap conflicts (retoc container inspection),
  SUSPECTED filename conflicts, UE4SS hook & keybind scanning (managed + unmanaged
  mods), pairwise conflict report and N×N compatibility matrix
- Load order: drag-to-reorder with priority renumbering, one-click suggested order
- Squad profiles: save/apply/delete named mod sets with load order
- Holonet: in-app Nexus Mods browser (search, category filters, sorting, paging),
  Featured Transmissions promo strip (owner-controlled roster + top-rated backfill),
  nxm:// one-click download handler, Nexus API key management
- Datapad: config editor for game INIs (created on demand), UE4SS settings and mod
  configs — structured value editing that preserves file formatting, .zcbak backups
- UE4SS: one-click download & install of the latest experimental runtime
- Diagnostics: installation health scan and deployed-file audit
- Launch via Steam or directly; portable single-exe distribution

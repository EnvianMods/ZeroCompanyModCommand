# Zero Company Mod Command — Changelog

## v1.0.0 (2026-09-01)

First public release.

**Mod management**
- Archive/folder/loose-pak installs (drag & drop), auto-classification
  (pak / IoStore / LogicMods / UE4SS mods / UE4SS runtime), enable/disable with a
  canonical mod library, rename, uninstall
- Friendly mod titles: a UE4SS mod can ship `modinfo.json` (`{"title": "..."}`)
  to set its display name in the Hangar Bay
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

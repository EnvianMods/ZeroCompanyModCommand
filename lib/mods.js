'use strict';
// Mod engine: classification, install, deploy, load order, conflicts, UE4SS.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { extractArchive } = require('./archive');
const { log } = require('./log');

const PAKS_REL = path.join('SWZeroCompany', 'Content', 'Paks');
const MODS_REL = path.join(PAKS_REL, '~mods');
const LOGIC_MODS_REL = path.join(PAKS_REL, 'LogicMods');
const WIN64_REL = path.join('SWZeroCompany', 'Binaries', 'Win64');
const UE4SS_MODS_REL = path.join(WIN64_REL, 'ue4ss', 'Mods');
// Game Feature plugin mods live as WHOLE FOLDERS here — the game's own loader
// mounts every SWZeroCompany\Mods\<Mod>\ at startup and appends the folder's
// root AssetRegistry.bin itself. No renaming, no load-order prefix, no runtime.
const GAME_MODS_REL = path.join('SWZeroCompany', 'Mods');

const PAK_EXTS = new Set(['.pak', '.utoc', '.ucas']);

// Zero Company Mod SDK content mods ship two sidecars next to their pak trio:
// <Mod>.AssetRegistry.bin (the mod's pruned asset registry, so the game can
// enumerate its net-new content) and <Mod>.zcsdk.lua (the runtime manifest:
// registry file + items to grant). The ZCSDK Runtime (UE4SS mods ZCSDKBridge +
// ZCSDKLoader) finds *.zcsdk.lua in Content/Paks and ~mods and resolves the
// registry relative to the manifest — so both deploy beside the paks UNRENAMED.
const SIDECAR_RE = /\.(zcsdk\.lua|assetregistry\.bin)$/i;
function isSidecar(f) { return SIDECAR_RE.test(path.basename(f)); }

// Describe the ZCSDK sidecars in a file list → { manifest, registry, grants }
// (file names only), or null when there is no manifest.
function zcsdkMeta(files, grants) {
  const manifest = files.find((f) => /\.zcsdk\.lua$/i.test(path.basename(f)));
  if (!manifest) return null;
  const registry = files.find((f) => /\.assetregistry\.bin$/i.test(path.basename(f)));
  return {
    manifest: path.basename(manifest),
    registry: registry ? path.basename(registry) : null,
    grants: Number.isFinite(grants) ? grants : null,
  };
}

// Markers of the manager-owned block inside UE4SS's mods.txt.
const UE4SS_BLOCK_BEGIN = '; === Zero Company Mod Command start order (managed block) ===';
const UE4SS_BLOCK_END = '; === end managed start order ===';

function newId() { return crypto.randomBytes(8).toString('hex'); }

// ---- UE4SS runtime updates: keep what the user set ------------------------

// mods.txt from a new runtime package merged into the user's file: every line
// of the user's file stays as it is (enable/disable values, comments, the
// managed start-order block); entries only the package lists are inserted
// before the Keybinds entry (its warning comment stays attached), else appended.
function mergeModsTxt(mine, pkg) {
  const eol = mine.includes('\r\n') ? '\r\n' : '\n';
  const lines = mine.split(/\r?\n/);
  const entry = /^\s*([^;#\s][^:]*?)\s*:\s*([01])\s*$/;
  const have = new Set();
  for (const l of lines) { const m = entry.exec(l); if (m) have.add(m[1].trim().toLowerCase()); }
  const add = [];
  for (const l of pkg.split(/\r?\n/)) {
    const m = entry.exec(l);
    if (m && !have.has(m[1].trim().toLowerCase())) { add.push(`${m[1].trim()} : ${m[2]}`); have.add(m[1].trim().toLowerCase()); }
  }
  if (!add.length) return mine;
  let at = lines.findIndex((l) => /^\s*Keybinds\s*:/i.test(l));
  if (at > 0 && /^\s*;/.test(lines[at - 1]) && /keybind|do not/i.test(lines[at - 1])) at -= 1;
  if (at === -1) {
    at = lines.length;
    while (at > 0 && lines[at - 1] === '') at -= 1;
  }
  lines.splice(at, 0, ...add);
  return lines.join(eol);
}

function parseIni(text) {
  const map = new Map(); // "section\u0000key" (lower-case) → value
  let section = '';
  for (const raw of String(text || '').split(/\r?\n/)) {
    const s = /^\s*\[([^\]]+)\]\s*$/.exec(raw);
    if (s) { section = s[1].trim().toLowerCase(); continue; }
    const kv = /^\s*([^;#=\s][^=]*?)\s*=\s*(.*?)\s*$/.exec(raw);
    if (kv) map.set(`${section}\u0000${kv[1].trim().toLowerCase()}`, kv[2]);
  }
  return map;
}

// The [Debug] values the stock UE4SS 3.x release ships in UE4SS-settings.ini
// (checked against an untouched UE4SS_v3.0.1-1131 experimental-latest file:
// console and GUI console off). With no record of what the previous package
// shipped (a switch from a build this app did not install), a [Debug] value
// that differs from these is taken to be the user's own choice; everything
// else comes from the new package.
const STOCK_DEBUG_DEFAULTS = {
  consoleenabled: '0', guiconsoleenabled: '0', guiconsolevisible: '0',
  guiconsolefontscaling: '1', guiconsolemonospacetexteditors: '0',
  graphicsapi: 'opengl', rendermode: 'ExternalThread', toggleguikey: 'O',
};

// UE4SS-settings.ini: the package's file with the user's own values carried
// over. With `shipped` (what the previous package installed) a value counts as
// the user's when it differs from what shipped; without it, only [Debug]
// values (console / GUI console preferences) that differ from the stock
// defaults are carried. Returns { text, carried: ['Section.Key', …] }.
function mergeUe4ssSettings(mine, pkg, shipped) {
  const user = parseIni(mine);
  const base = shipped != null ? parseIni(shipped) : null;
  const eol = pkg.includes('\r\n') ? '\r\n' : '\n';
  const carried = [];
  let section = '';
  let sectionName = '';
  const out = pkg.split(/\r?\n/).map((raw) => {
    const s = /^\s*\[([^\]]+)\]\s*$/.exec(raw);
    if (s) { sectionName = s[1].trim(); section = sectionName.toLowerCase(); return raw; }
    const kv = /^(\s*)([^;#=\s][^=]*?)(\s*=\s*)(.*?)(\s*)$/.exec(raw);
    if (!kv) return raw;
    const k = `${section}\u0000${kv[2].trim().toLowerCase()}`;
    if (!user.has(k)) return raw;
    const mineV = user.get(k);
    if (mineV === kv[4]) return raw;
    const key = kv[2].trim().toLowerCase();
    const customised = base
      ? (base.has(k) && base.get(k) !== mineV)
      : section === 'debug' && (STOCK_DEBUG_DEFAULTS[key] == null || String(STOCK_DEBUG_DEFAULTS[key]).toLowerCase() !== String(mineV).toLowerCase());
    if (!customised) return raw;
    carried.push(`${sectionName}.${kv[2].trim()}`);
    return `${kv[1]}${kv[2]}${kv[3]}${mineV}${kv[5]}`;
  });
  return { text: out.join(eol), carried };
}

// Vault key for UE4SS runtime builds (versions/ue4ss-runtime/…).
const UE4SS_VAULT_KEY = 'ue4ss-runtime';

// What counts as "the UE4SS runtime" in Binaries\Win64 — an allow-list, never
// "everything in ue4ss\". That folder also holds what other tools and the
// game session write there: object/UHT dumps, .jmap files (hundreds of MB),
// the Mod SDK's ZCSDKBridge.ctl/.scan/.symcache and its generated
// UE4SS_Signatures\*.lua, logs, crash dumps, imgui.ini, liveview\, watches\,
// UE4SS_SDK_Backends\ … none of which a snapshot, a switch or a restore may
// copy, retire or delete. Runtime = these files, these folders (recursively),
// plus whatever the last package installed listed in
// <data>\ue4ss-shipped-files.json (never ue4ss\Mods — that is the user's).
const UE4SS_CORE_FILES = ['dwmapi.dll', ...['UE4SS.dll', 'UE4SS.pdb', 'UE4SS-settings.ini', 'LICENSE', 'API.txt', 'Changelog.md', 'README.md'].map((f) => path.join('ue4ss', f))];
const UE4SS_CORE_DIRS = ['UE4SS_Signatures', 'VTableLayoutTemplates', 'MemberVarLayoutTemplates', 'CustomGameConfigs'].map((d) => path.join('ue4ss', d));
// A switch from a build with no shipped-files record (placed by hand, or the
// stock build an older Mod Command installed) retires only these — the stock
// zip's own extras — when the new package does not ship them.
const UE4SS_STOCK_EXTRAS = ['UE4SS.pdb', 'API.txt', 'Changelog.md', 'README.md'].map((f) => path.join('ue4ss', f));
// Files the Zero Company Mod SDK writes into UE4SS_Signatures carry this
// header. They are the SDK's, not the runtime's: never snapshotted as runtime,
// retired or deleted; a package that ships a file of the same name overwrites
// it only after the SDK's copy is kept in the vault.
const SDK_GENERATED_RE = /Generated by ZeroCompanyModSDK/i;
const UE4SS_SHIPPED_FILES = 'ue4ss-shipped-files.json';
const UE4SS_SHIPPED_SETTINGS = 'ue4ss-shipped-settings.ini';
// ZCSDK Runtime v0.10+ also ships UE4SS custom signature files: a
// UE4SS_Signatures\ folder in its zip (see findZcsdkSigDir) whose *.lua belong in
// Win64\ue4ss\UE4SS_Signatures\ (one level above ue4ss\Mods). The runtime
// installer copies them there and records exactly what it wrote in
// <data>\zcsdk-signatures.json ({ name, sha256, backup } per file); a file of
// the same name that was already there (the user's own, or the SDK's generator
// output) is kept in <data>\zcsdk-signatures-backup\ and put back when the
// runtime is removed. Only recorded files that still hold what was written are
// ever deleted.
const ZCSDK_SIGS_REL = path.join(WIN64_REL, 'ue4ss', 'UE4SS_Signatures');
const ZCSDK_SIGS_RECORD = 'zcsdk-signatures.json';
const ZCSDK_SIGS_BACKUP = 'zcsdk-signatures-backup';
// The first runtime release that ships signature files.
const ZCSDK_SIGS_SINCE = '0.10';

// Order two version strings ("1.2.10" > "1.2.9"; "1.3-beta" < "1.3"). Returns
// -1 / 0 / 1, or null when either side is missing (unordered). Numeric runs
// compare as numbers, anything else as text, so date-like and semver-like
// strings both behave.
function compareVersions(a, b) {
  if (!a || !b) return null;
  const parts = (s) => String(s).trim().replace(/^v/i, '').split(/[.\-_+ ]+/).filter(Boolean);
  const pa = parts(a), pb = parts(b);
  const n = Math.max(pa.length, pb.length);
  for (let i = 0; i < n; i += 1) {
    const x = pa[i], y = pb[i];
    if (x === undefined) return /^\d+$/.test(y) ? -1 : 1;   // "1.3" < "1.3.1", but "1.3" > "1.3-beta"
    if (y === undefined) return /^\d+$/.test(x) ? 1 : -1;
    const nx = /^\d+$/.test(x), ny = /^\d+$/.test(y);
    if (nx && ny) { const d = Number(x) - Number(y); if (d) return d < 0 ? -1 : 1; continue; }
    if (nx !== ny) return nx ? 1 : -1; // a number outranks a tag at the same position
    const c = x.localeCompare(y, undefined, { sensitivity: 'base' });
    if (c) return c < 0 ? -1 : 1;
  }
  return 0;
}

// Read in chunks: deployed .ucas containers run to several GB, more than one
// Buffer can hold.
function sha256File(absPath) {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(absPath, 'r');
  try {
    const buf = Buffer.allocUnsafe(4 * 1024 * 1024);
    let n;
    while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) hash.update(n === buf.length ? buf : buf.subarray(0, n));
  } finally { fs.closeSync(fd); }
  return hash.digest('hex');
}

function safeName(name) {
  return String(name).replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60) || 'Mod';
}

// Optional modinfo.json in a directory → { title, version, author, description,
// eaCompatible, launchers } (only the fields present, all sanitized).
function readModinfo(absDir) {
  const meta = {};
  try {
    const mf = JSON.parse(fs.readFileSync(path.join(absDir, 'modinfo.json'), 'utf8'));
    if (mf && typeof mf.title === 'string' && mf.title.trim()) meta.title = mf.title.trim().slice(0, 120);
    if (mf && typeof mf.version === 'string' && mf.version.trim()) meta.version = mf.version.trim().slice(0, 40);
    if (mf && typeof mf.author === 'string' && mf.author.trim()) meta.author = mf.author.trim().slice(0, 120);
    if (mf && typeof mf.description === 'string' && mf.description.trim()) meta.description = mf.description.trim().slice(0, 500);
    if (mf && typeof mf.eaCompatible === 'boolean') meta.eaCompatible = mf.eaCompatible;
    if (mf && Array.isArray(mf.launchers)) meta.launchers = mf.launchers.map((l) => String(l).toLowerCase()).slice(0, 4);
    // Zero Company Mod SDK packages describe their runtime sidecars here.
    if (mf && mf.zcsdk && typeof mf.zcsdk === 'object' && Number.isFinite(mf.zcsdk.grants)) meta.zcsdkGrants = mf.zcsdk.grants;
  } catch (_) { /* absent or malformed — no metadata */ }
  return meta;
}

function isFile(abs) {
  try { return fs.statSync(abs).isFile(); } catch (_) { return false; }
}

// The UE4SS_Signatures folder in an extracted ZCSDK Runtime package, or null:
// <root>\UE4SS_Signatures, <root>\ue4ss\UE4SS_Signatures, or the same two
// under a single folder that wraps the whole package (names case-insensitive,
// first match wins).
function findZcsdkSigDir(root) {
  const sub = (dir, name) => {
    try {
      const e = fs.readdirSync(dir, { withFileTypes: true }).find((x) => x.isDirectory() && x.name.toLowerCase() === name);
      return e ? path.join(dir, e.name) : null;
    } catch (_) { return null; }
  };
  const inDir = (dir) => {
    const ue = sub(dir, 'ue4ss');
    return sub(dir, 'ue4ss_signatures') || (ue && sub(ue, 'ue4ss_signatures'));
  };
  const top = inDir(root);
  if (top) return top;
  let entries = [];
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch (_) {}
  return entries.length === 1 && entries[0].isDirectory() ? inDir(path.join(root, entries[0].name)) : null;
}

function walkFiles(root) {
  const out = [];
  const stack = [''];
  while (stack.length) {
    const rel = stack.pop();
    const abs = path.join(root, rel);
    for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
      const childRel = rel ? path.join(rel, entry.name) : entry.name;
      if (entry.isDirectory()) stack.push(childRel);
      else out.push(childRel);
    }
  }
  return out;
}

// A Game Feature plugin's <Mod>.uplugin (plain JSON) → the fields we surface on
// the mod row. Best-effort: an absent or malformed file just yields nothing.
function readUplugin(absPath) {
  const out = {};
  try {
    const j = JSON.parse(fs.readFileSync(absPath, 'utf8'));
    if (!j || typeof j !== 'object') return out;
    if (typeof j.FriendlyName === 'string' && j.FriendlyName.trim()) out.friendlyName = j.FriendlyName.trim().slice(0, 120);
    if (typeof j.CreatedBy === 'string' && j.CreatedBy.trim()) out.author = j.CreatedBy.trim().slice(0, 120);
    if (typeof j.VersionName === 'string' || typeof j.VersionName === 'number') {
      const v = String(j.VersionName).trim();
      if (v) out.version = v.slice(0, 40);
    }
    if (typeof j.Description === 'string' && j.Description.trim()) out.description = j.Description.trim().slice(0, 500);
  } catch (_) { /* absent or malformed — no metadata */ }
  return out;
}

// Windows-safe folder name? (the plugin folder name must stay byte-identical to
// the .uplugin's stem — the game matches the two — so only sanitize when the
// stem could not be created as a directory)
function usableFolderName(name) {
  return !!name && !/[<>:"/\\|?*\x00-\x1f]/.test(name) && !/[. ]$/.test(name);
}

// Build the classification record for ONE Game Feature plugin folder inside an
// extracted tree. dir = the folder holding the .uplugin ('' or '.' when the
// tree root IS the plugin folder); upluginRel = the .uplugin relative to root.
// The WHOLE folder is the payload (uplugin, AssetRegistry.bin, Content/,
// Config/, modinfo.json, readmes) — it travels together or the mod is broken.
function gfpGroup(root, files, dir, upluginRel, fallbackName) {
  const baseDir = (!dir || dir === '.') ? '' : dir;
  const stem = path.basename(upluginRel, path.extname(upluginRel));
  const pluginName = usableFolderName(stem) ? stem : safeName(stem);
  const payload = files
    .filter((f) => (baseDir ? f.startsWith(baseDir + path.sep) : true))
    .map((f) => ({ sourceRelative: f, deployRelative: baseDir ? path.relative(baseDir, f) : f }));
  const meta = readModinfo(path.join(root, baseDir));
  const up = readUplugin(path.join(root, upluginRel));
  if (!meta.author && up.author) meta.author = up.author;
  if (!meta.version && up.version) meta.version = up.version;
  if (!meta.description && up.description) meta.description = up.description;
  // A plugin mod needs the ZCSDK Runtime only when it actually ships a
  // *.zcsdk.lua manifest (item grants, recruit pins). Its content and its root
  // AssetRegistry.bin are mounted by the game itself, so most need nothing.
  const zcsdk = zcsdkMeta(payload.map((p) => p.deployRelative).filter(isSidecar), meta.zcsdkGrants);
  delete meta.zcsdkGrants;
  if (zcsdk) meta.zcsdk = zcsdk;
  return {
    modType: 'gfp',
    name: meta.title || up.friendlyName || pluginName || fallbackName,
    pluginName,
    meta,
    payload,
    warnings: [],
  };
}

// Every Game Feature plugin folder in a file list → dir (relative, '.' for the
// tree root) -> the .uplugin's relative path. A folder holding several
// .uplugin files keeps the first (alphabetically stable via walk order).
function gfpDirs(files) {
  const found = new Map();
  for (const f of files) {
    if (path.extname(f).toLowerCase() !== '.uplugin') continue;
    const dir = path.dirname(f);
    if (!found.has(dir)) found.set(dir, f);
  }
  return found;
}

// Every UE4SS script/dll mod folder in a file list → dir (relative, '.' when the
// tree root IS the mod folder) -> the marker that identified it (Scripts/main.lua
// or dlls/main.dll). A folder with both markers keeps the first one seen.
function ue4ssModDirs(files) {
  const found = new Map();
  for (const f of files) {
    if (!/(^|[\\/])(scripts[\\/]main\.lua|dlls[\\/]main\.dll)$/i.test(f)) continue;
    const dir = path.dirname(path.dirname(f));
    if (!found.has(dir)) found.set(dir, f);
  }
  return found;
}

// Build the classification record for ONE UE4SS mod folder inside an extracted
// tree. dir = the folder holding Scripts/ or dlls/ ('' or '.' when the tree root
// IS the mod folder). The WHOLE folder is the payload — its dlls/, Scripts/,
// enabled.txt, modinfo.json AND any paks/ it ships (the mod mounts those itself
// at startup, so they travel with it and are never renamed into ~mods).
// deployRelative is relative to the mod folder, so the tree lands verbatim under
// ue4ss\Mods\<Name>\. An optional modinfo.json supplies the display title; deploy
// still uses safeName(name) for the on-disk folder.
function ue4ssModGroup(root, files, dir, fallbackName) {
  const baseDir = (!dir || dir === '.') ? '' : dir;
  const meta = readModinfo(path.join(root, baseDir));
  delete meta.zcsdkGrants; // UE4SS mods carry no ZCSDK sidecars
  const payload = files
    .filter((f) => (baseDir ? f.startsWith(baseDir + path.sep) : true))
    .map((f) => ({ sourceRelative: f, deployRelative: baseDir ? path.relative(baseDir, f) : f }));
  const warnings = [];
  const skipped = files.length - payload.length;
  if (skipped > 0) warnings.push(`${skipped} file(s) outside the mod folder were ignored.`);
  return {
    modType: 'ue4ss-mod',
    name: meta.title || safeName(baseDir ? path.basename(baseDir) : fallbackName),
    meta,
    payload,
    warnings,
  };
}

// ---------------------------------------------------------------- inspection

// Classify an extracted/staged folder. Returns { modType, name, payload, warnings }
// payload: [{ sourceRelative, kind }]
function classifyFolder(root, fallbackName) {
  const files = walkFiles(root);
  const warnings = [];
  const lower = files.map((f) => f.toLowerCase());

  // UE4SS runtime: dwmapi.dll next to a ue4ss folder
  const dwmapiIdx = lower.findIndex((f) => path.basename(f) === 'dwmapi.dll');
  if (dwmapiIdx !== -1) {
    const dwmDir = path.dirname(files[dwmapiIdx]);
    const hasUe4ssDir = files.some((f) => {
      const rel = path.relative(dwmDir === '.' ? '' : dwmDir, f);
      return !rel.startsWith('..') && rel.toLowerCase().startsWith('ue4ss' + path.sep);
    });
    if (hasUe4ssDir) {
      const baseDir = dwmDir === '.' ? '' : dwmDir;
      const payload = files
        .filter((f) => (baseDir ? f.startsWith(baseDir + path.sep) : true))
        .map((f) => ({ sourceRelative: f, deployRelative: baseDir ? path.relative(baseDir, f) : f }));
      return { modType: 'ue4ss-runtime', name: 'UE4SS Runtime', payload, warnings };
    }
  }

  // Game Feature plugin mod: a <Mod>.uplugin anywhere in the tree. Checked
  // BEFORE the pak branches on purpose — the plugin ships its paks inside
  // Content/Paks, and dropping those into ~mods gives a half-working mod (the
  // paks mount, but the game never reads the plugin's registry, so everything
  // the mod ADDS stays invisible). The whole folder goes to SWZeroCompany\Mods.
  const upluginDirs = gfpDirs(files);
  if (upluginDirs.size) {
    // Several plugin folders in one archive are split by _splitModGroups; here
    // (one mod, or a caller that skipped the split) the first folder wins and
    // anything outside it is reported as ignored.
    const [dir, upluginRel] = [...upluginDirs.entries()][0];
    const group = gfpGroup(root, files, dir, upluginRel, fallbackName);
    if (upluginDirs.size > 1) {
      group.warnings.push(`${upluginDirs.size - 1} other plugin folder(s) in this archive were ignored.`);
    } else {
      const skipped = files.length - group.payload.length;
      if (skipped > 0) warnings.push(`${skipped} file(s) outside the plugin folder were ignored.`);
    }
    group.warnings = [...warnings, ...group.warnings];
    return group;
  }

  // UE4SS script/dll mod that ships its OWN paks. Checked BEFORE the LogicMods
  // and pak branches on purpose: a UE4SS mod may keep a paks\ folder next to its
  // dll, and the mod mounts those containers itself at startup. Letting the pak
  // branch claim the archive renamed those three files into ~mods and dropped
  // the dll with a "non-pak files ignored" warning — the mod then did nothing.
  // Guarded so mixed archives are untouched: exactly ONE UE4SS mod folder, and
  // every pak-type file in the tree inside it. An archive that also carries paks
  // OUTSIDE the mod folder keeps the old order — install() has already offered it
  // to _splitModGroups, which makes the mod folder and each outside pak folder
  // their own entry (paks inside a UE4SS folder always go with that folder).
  const ue4ssDirs = ue4ssModDirs(files);
  if (ue4ssDirs.size === 1) {
    const modDir = [...ue4ssDirs.keys()][0];
    const baseDir = modDir === '.' ? '' : modDir;
    const paksOutside = baseDir && files.some((f) =>
      PAK_EXTS.has(path.extname(f).toLowerCase()) && !f.startsWith(baseDir + path.sep));
    if (!paksOutside) {
      const group = ue4ssModGroup(root, files, modDir, fallbackName);
      group.warnings = [...warnings, ...group.warnings];
      return group;
    }
  }

  // LogicMods paks
  const logicPaks = files.filter((f) => {
    const parts = f.toLowerCase().split(path.sep);
    return parts.includes('logicmods') && PAK_EXTS.has(path.extname(f).toLowerCase());
  });
  if (logicPaks.length) {
    return {
      modType: 'logicmods',
      name: fallbackName,
      payload: logicPaks.map((f) => ({ sourceRelative: f, deployRelative: path.basename(f) })),
      warnings,
    };
  }

  // Pak / IoStore
  const pakFiles = files.filter((f) => PAK_EXTS.has(path.extname(f).toLowerCase()));
  if (pakFiles.length) {
    const hasIoStore = pakFiles.some((f) => ['.utoc', '.ucas'].includes(path.extname(f).toLowerCase()));
    // Optional metadata: a modinfo.json alongside the paks (title/version/author/description).
    // Lets tool-built packages carry a clean display name + version instead of the archive filename.
    // (Mirrors the UE4SS-mod branch below.) Falls back to the archive name if absent/malformed.
    let name = fallbackName;
    const meta = {};
    const mfRel = files.find((f) => path.basename(f).toLowerCase() === 'modinfo.json');
    if (mfRel) {
      try {
        const mf = JSON.parse(fs.readFileSync(path.join(root, mfRel), 'utf8'));
        if (mf && typeof mf.title === 'string' && mf.title.trim()) { name = mf.title.trim().slice(0, 120); meta.title = name; }
        if (mf && typeof mf.version === 'string' && mf.version.trim()) meta.version = mf.version.trim().slice(0, 40);
        if (mf && typeof mf.author === 'string' && mf.author.trim()) meta.author = mf.author.trim().slice(0, 120);
        if (mf && typeof mf.description === 'string' && mf.description.trim()) meta.description = mf.description.trim().slice(0, 500);
        // Launcher compatibility declared by the author (Steam vs EA App).
        if (mf && typeof mf.eaCompatible === 'boolean') meta.eaCompatible = mf.eaCompatible;
        if (mf && Array.isArray(mf.launchers)) meta.launchers = mf.launchers.map((l) => String(l).toLowerCase()).slice(0, 4);
        if (mf && mf.zcsdk && typeof mf.zcsdk === 'object' && Number.isFinite(mf.zcsdk.grants)) meta.zcsdkGrants = mf.zcsdk.grants;
      } catch { /* malformed manifest: keep the archive name */ }
    }
    // ZCSDK sidecars ride along with the paks (deployed unrenamed beside them).
    const sidecars = files.filter(isSidecar);
    const zcsdk = zcsdkMeta(sidecars, meta.zcsdkGrants);
    delete meta.zcsdkGrants;
    if (zcsdk) meta.zcsdk = zcsdk;
    // Group by basename to keep .pak/.utoc/.ucas triples together.
    const skipped = files.length - pakFiles.length - sidecars.length - (mfRel ? 1 : 0);
    if (skipped > 0) warnings.push(`${skipped} non-pak file(s) in the archive were ignored.`);
    return {
      modType: hasIoStore ? 'iostore' : 'pak',
      name,
      meta,
      payload: [...pakFiles, ...sidecars].map((f) => ({ sourceRelative: f, deployRelative: path.basename(f) })),
      warnings,
    };
  }

  // UE4SS script/dll mod: a folder containing Scripts/main.lua or dlls/main.dll.
  // Reached only when the branch above declined — several mod folders in one
  // archive (the first wins here; install() splits them into separate entries),
  // or a single folder whose archive ALSO carries paks outside it, which the pak
  // branch has already claimed.
  if (ue4ssDirs.size) {
    const group = ue4ssModGroup(root, files, [...ue4ssDirs.keys()][0], fallbackName);
    group.warnings = [...warnings, ...group.warnings];
    return group;
  }

  // Game-folder replacement mod: files laid out against the game root
  // (SWZeroCompany/... or Engine/...), e.g. replacement movies. Deployed over
  // the game's own files — originals are backed up and restored on disable.
  const GAME_ROOTS = new Set(['swzerocompany', 'engine']);
  // The game-root folder may sit at the archive top or one wrapper folder down.
  const gameRootDepth = (f) => {
    const parts = f.split(path.sep);
    if (GAME_ROOTS.has(parts[0])) return 0;
    if (parts.length > 1 && GAME_ROOTS.has(parts[1])) return 1;
    return -1;
  };
  if (lower.some((f) => gameRootDepth(f) !== -1)) {
    const payload = [];
    for (let i = 0; i < files.length; i++) {
      const depth = gameRootDepth(lower[i]);
      if (depth === -1) continue;
      const deployRelative = depth === 0 ? files[i] : files[i].split(path.sep).slice(1).join(path.sep);
      payload.push({ sourceRelative: files[i], deployRelative });
    }
    const skipped = files.length - payload.length;
    if (skipped > 0) warnings.push(`${skipped} file(s) outside SWZeroCompany/Engine were ignored.`);
    return { modType: 'gamefolder', name: fallbackName, payload, warnings };
  }

  return { modType: null, name: fallbackName, payload: [], warnings: ['No recognizable mod files found (.pak/.utoc/.ucas, UE4SS runtime, a UE4SS Scripts mod, or game-folder replacement files).'] };
}

class ModEngine {
  constructor(store) {
    this.store = store;
    // Live FOMOD wizard sessions: sessionId -> { root, stagingDir, sourceArchive, info }
    this._fomodSessions = new Map();
  }

  gamePath() {
    return this.store.settings.gamePath;
  }

  gameAbs(rel) {
    return path.join(this.gamePath(), rel);
  }

  ensureGameDirs() {
    fs.mkdirSync(this.gameAbs(MODS_REL), { recursive: true });
    fs.mkdirSync(this.gameAbs(LOGIC_MODS_REL), { recursive: true });
  }

  // ------------------------------------------------------------- install

  // sourcePath = archive file or folder. Returns the installed mod record, or a
  // { pendingFomod } handle when the archive ships a FOMOD installer script —
  // the wizard's answers come back through completeFomod()/cancelFomod().
  async install(sourcePath, opts = {}) {
    if (!this.gamePath()) throw new Error('Set the game folder first (Settings).');
    const stat = fs.statSync(sourcePath);
    let root = sourcePath;
    let stagingDir = null;
    let sourceArchive = null;
    if (stat.isFile()) {
      const ext = path.extname(sourcePath).toLowerCase();
      stagingDir = path.join(this.store.stagingDir, newId());
      if (PAK_EXTS.has(ext)) {
        // Loose pak/utoc/ucas — stage it plus any same-name siblings.
        fs.mkdirSync(stagingDir, { recursive: true });
        const dir = path.dirname(sourcePath);
        const base = path.basename(sourcePath, ext);
        const siblings = fs.readdirSync(dir);
        // ZCSDK sidecars next to the pak come along only when the folder holds
        // this ONE pak group — otherwise we can't tell whose they are.
        const pakBases = new Set(siblings
          .filter((sib) => PAK_EXTS.has(path.extname(sib).toLowerCase()))
          .map((sib) => path.basename(sib, path.extname(sib))));
        const takeSidecars = pakBases.size === 1;
        for (const sib of siblings) {
          const sibExt = path.extname(sib).toLowerCase();
          const samePak = path.basename(sib, sibExt) === base && PAK_EXTS.has(sibExt);
          if (samePak || (takeSidecars && isSidecar(sib))) {
            fs.copyFileSync(path.join(dir, sib), path.join(stagingDir, sib));
          }
        }
      } else {
        sourceArchive = path.basename(sourcePath);
        await extractArchive(sourcePath, stagingDir, this.store.settings.sevenZipPath);
      }
      root = stagingDir;
    }
    try {
      const fallbackName = safeName(path.basename(sourcePath).replace(/\.(zip|7z|rar|pak|utoc|ucas)$/i, ''));

      // FOMOD-scripted archive: hand the script to the renderer's wizard instead
      // of guessing at the folders. The script is read, never executed.
      if (!opts.skipFomod) {
        const fomod = require('./fomod');
        const detected = fomod.detect(root);
        if (detected) {
          const sessionId = newId();
          this._fomodSessions.set(sessionId, {
            root, stagingDir, sourceArchive,
            fomodBase: detected.baseDir,
            info: detected.info,
            fallbackName,
            origin: opts.origin || null,
            version: opts.version || null,
          });
          stagingDir = null; // keep the extracted files alive for the wizard
          return {
            pendingFomod: true, sessionId,
            moduleXml: detected.moduleXml,
            info: detected.info,
            name: (detected.info && detected.info.name) || fallbackName,
          };
        }
      }

      // Multi-mod archive: install every group as its own entry.
      const groups = this._splitModGroups(root, fallbackName);
      if (groups) {
        const mods = [];
        const errors = [];
        for (const g of groups) {
          try {
            mods.push(this._installOrVersion(root, {
              fallbackName: g.name, sourceArchive, classified: g,
              origin: opts.origin, version: opts.version, keepGameFiles: opts.keepGameFiles,
            }));
          } catch (err) {
            errors.push(`${g.name}: ${err.message}`);
          }
        }
        if (!mods.length) throw new Error(errors.join(' '));
        return { multi: true, mods, errors };
      }

      return this._installOrVersion(root, {
        fallbackName, sourceArchive, metaOverride: opts.metaOverride,
        origin: opts.origin, version: opts.version, keepGameFiles: opts.keepGameFiles,
      });
    } finally {
      if (stagingDir) fs.rmSync(stagingDir, { recursive: true, force: true });
    }
  }

  // Detect an archive that packs SEVERAL mods, each in its own folder — every
  // one becomes its own entry (enable/order/remove them separately). Returns
  // an array of pre-classified groups, or null when the content is one mod.
  //
  // Grouping rules (conservative — a single mod always stays one entry):
  //  - every folder holding Scripts/main.lua or dlls/main.dll is one UE4SS mod
  //  - pak/utoc/ucas containers group by their containing folder (a mod that
  //    ships several paks in ONE folder stays together)
  //  - a UE4SS runtime archive, a game-folder tree, or a root-level UE4SS mod
  //    is never split
  _splitModGroups(root, fallbackName) {
    let files;
    try { files = walkFiles(root); } catch (_) { return null; }
    if (files.some((f) => path.basename(f).toLowerCase() === 'dwmapi.dll')) return null; // runtime

    const ue4ssDirs = ue4ssModDirs(files);
    if (ue4ssDirs.has('.')) return null; // whole archive IS one UE4SS mod

    // Game Feature plugin folders: one mod each, and their whole subtree (paks
    // included) belongs to them — never to the pak grouping below.
    const upluginDirs = gfpDirs(files);
    if (upluginDirs.has('.')) return null; // whole archive IS one plugin mod

    // Paks inside a UE4SS mod folder belong to THAT mod (it mounts its own
    // paks\ at startup) and never to a pak group below.
    const inUe4ss = (f) => [...ue4ssDirs.keys()].some((d) => f.startsWith(d + path.sep));
    const inGfp = (f) => [...upluginDirs.keys()].some((d) => f.startsWith(d + path.sep));
    const pakDirs = new Map();
    for (const f of files) {
      if (!PAK_EXTS.has(path.extname(f).toLowerCase()) || inUe4ss(f) || inGfp(f)) continue;
      const dir = path.dirname(f);
      if (!pakDirs.has(dir)) pakDirs.set(dir, []);
      pakDirs.get(dir).push(f);
    }
    if (ue4ssDirs.size + upluginDirs.size + pakDirs.size <= 1) return null;
    // ZCSDK sidecars belong to the pak group in their own folder.
    const sidecarsByDir = new Map();
    for (const f of files) {
      const dir = path.dirname(f);
      if (!isSidecar(f) || inUe4ss(f) || !pakDirs.has(dir)) continue;
      if (!sidecarsByDir.has(dir)) sidecarsByDir.set(dir, []);
      sidecarsByDir.get(dir).push(f);
    }

    const groups = [];
    for (const [dir, upluginRel] of upluginDirs) {
      groups.push(gfpGroup(root, files, dir, upluginRel, fallbackName));
    }
    for (const dir of ue4ssDirs.keys()) {
      // Whole folder, paks included; a group never warns about the files that
      // belong to its siblings.
      groups.push({ ...ue4ssModGroup(root, files, dir, fallbackName), warnings: [] });
    }
    for (const [dir, pakFiles] of pakDirs) {
      const isLogic = dir.toLowerCase().split(path.sep).includes('logicmods');
      const hasIoStore = pakFiles.some((f) => ['.utoc', '.ucas'].includes(path.extname(f).toLowerCase()));
      const meta = dir === '.' ? {} : readModinfo(path.join(root, dir));
      const sidecars = sidecarsByDir.get(dir) || [];
      const zcsdk = zcsdkMeta(sidecars, meta.zcsdkGrants);
      delete meta.zcsdkGrants;
      if (zcsdk) meta.zcsdk = zcsdk;
      groups.push({
        modType: isLogic ? 'logicmods' : (hasIoStore ? 'iostore' : 'pak'),
        name: meta.title || (dir === '.' ? fallbackName : safeName(path.basename(dir))),
        meta,
        payload: [...pakFiles, ...sidecars].map((f) => ({ sourceRelative: f, deployRelative: path.basename(f) })),
        warnings: [],
      });
    }
    return groups;
  }

  // Classify an on-disk folder and bring it into the library as a managed mod.
  // opts.classified skips detection (used when a multi-mod archive was split);
  // opts.origin / opts.version stamp where the download came from.
  // ---------------------------------------------------- version-aware installs
  // A mod whose modinfo.json names the SAME title (+ author) as an installed
  // mod is that mod at another version, not a new one. It joins the existing
  // line: a newer version replaces the install (the old one is vaulted), an
  // older one is vaulted as an alternate WITHOUT touching the install, and the
  // same version is a reinstall (previous copy vaulted). The ⧗ picker then
  // offers every archived version for rollback or testing.
  _installOrVersion(root, opts) {
    const info = opts.classified || classifyFolder(root, opts.fallbackName);
    if (info.modType && info.modType !== 'ue4ss-runtime') {
      const existing = this._findSameMod(info, opts.metaOverride);
      if (existing) return this._absorbVersion(existing, root, info, opts);
    }
    return this._installFromFolder(root, { ...opts, classified: info });
  }

  // Match an incoming mod to an installed one by modinfo identity: same type,
  // same title (the modinfo title, so a user rename doesn't break it), and the
  // same author when both sides state one. No modinfo title = no match.
  _findSameMod(info, metaOverride) {
    const meta = { ...(info.meta || {}), ...(metaOverride || {}) };
    const title = meta.title && String(meta.title).trim();
    if (!title) return null;
    const norm = (s) => safeName(String(s || '')).toLowerCase();
    const author = meta.author ? norm(meta.author) : '';
    return this.store.mods.find((m) => m.modType === info.modType
      && norm(m.metaTitle || m.name) === norm(title)
      && (!author || !m.author || norm(m.author) === author)) || null;
  }

  _absorbVersion(existing, root, info, opts) {
    const meta = { ...(info.meta || {}), ...(opts.metaOverride || {}) };
    const incoming = meta.version || opts.version || null;
    const cmp = compareVersions(incoming, existing.version);
    if (cmp < 0) {
      // Older than what is installed: archive it as an alternate version only.
      const entryId = this._vaultFromFolder(existing, root, info, incoming, opts.origin);
      return { ...this.store.getMod(existing.id), versionAction: { action: 'archived', version: incoming, current: existing.version, entryId } };
    }
    // Newer (or same / unordered): vault the current copy, then replace it in
    // place, keeping name, enabled state and load/start-order slots.
    this._snapshotVersion(existing);
    const keep = { name: existing.name, enabled: existing.enabled, loadPriority: existing.loadPriority, ue4ssPriority: existing.ue4ssPriority };
    const previous = existing.version;
    this.uninstall(existing.id, true);
    const fresh = this._installFromFolder(root, { ...opts, classified: info, reuseId: existing.id });
    if (fresh.name !== keep.name) { try { this.rename(fresh.id, keep.name); } catch (_) {} }
    const m = this.store.getMod(fresh.id);
    // Keep the version history attached if the vault key moved (an older
    // record without a shipped title was keyed by its name).
    this._moveVault(this._vaultKey(existing), this._vaultKey(m));
    if (keep.loadPriority != null && ['pak', 'iostore'].includes(m.modType)) {
      const wasEnabled = m.enabled;
      if (wasEnabled) this._undeployMod(m, true);
      m.loadPriority = keep.loadPriority;
      if (wasEnabled) this._deployMod(m);
    }
    if (keep.ue4ssPriority != null && m.modType === 'ue4ss-mod') {
      m.ue4ssPriority = keep.ue4ssPriority;
      this._syncUe4ssModsTxt();
    }
    if (!keep.enabled) this.setEnabled(m.id, false);
    this.store.save();
    return { ...this.store.getMod(m.id), versionAction: { action: cmp === 0 ? 'reinstalled' : 'updated', version: this.store.getMod(m.id).version, previous } };
  }

  // Write an incoming (not installed) mod straight into the vault of an
  // existing line, from the staged folder, so it can be rolled to later.
  _vaultFromFolder(existing, root, info, version, origin) {
    const key = this._vaultKey(existing);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const entryId = `${stamp}__${safeName(version || 'unversioned')}`;
    const dir = path.join(this.store.modVaultDir(key), entryId);
    const filesDir = path.join(dir, 'files');
    fs.mkdirSync(filesDir, { recursive: true });
    for (const p of info.payload) {
      const dst = path.join(filesDir, p.deployRelative);
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.copyFileSync(path.join(root, p.sourceRelative), dst);
    }
    fs.writeFileSync(path.join(dir, 'vault.json'), JSON.stringify({
      name: existing.name,
      version: version || null,
      modType: existing.modType,
      origin: origin || { type: 'local' },
      savedAt: new Date().toISOString(),
      archivedOnInstall: true,
    }, null, 2));
    const entries = fs.readdirSync(this.store.modVaultDir(key)).sort().reverse();
    for (const stale of entries.slice(5)) {
      fs.rmSync(path.join(this.store.modVaultDir(key), stale), { recursive: true, force: true });
    }
    return entryId;
  }

  _installFromFolder(root, { fallbackName, sourceArchive, metaOverride, classified, origin, version, reuseId, keepGameFiles }) {
    const info = classified || classifyFolder(root, fallbackName);
    if (!info.modType) throw new Error(info.warnings.join(' '));

    if (info.modType === 'ue4ss-runtime') {
      // UE4SS comes from "UE4SS for Star Wars Zero Company" on Nexus only —
      // a runtime zip arriving through the GitHub tab is refused outright.
      if (origin && origin.type === 'github') {
        throw new Error('That GitHub release is a UE4SS runtime. Mod Command installs UE4SS only from “UE4SS for Star Wars Zero Company” on Nexus Mods — Settings → UE4SS.');
      }
      return this._installUe4ssRuntime(root, info);
    }

    // reuseId: an in-place version update keeps the mod's id, so profiles and
    // the saved load order still point at it.
    const id = reuseId || newId();
    const libDir = this.store.modLibraryDir(id);
    fs.mkdirSync(libDir, { recursive: true });
    const files = [];
    for (const p of info.payload) {
      const src = path.join(root, p.sourceRelative);
      const dst = path.join(libDir, p.deployRelative);
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.copyFileSync(src, dst);
      files.push({ libraryRelative: p.deployRelative, size: fs.statSync(dst).size, sha256: sha256File(dst) });
    }

    const meta = { ...(info.meta || {}), ...(metaOverride || {}) };
    const ordered = ['pak', 'iostore'].includes(info.modType);
    const mod = {
      id,
      name: (metaOverride && metaOverride.title) || info.name,
      // The modinfo title AS SHIPPED — identity for version matching even after a
      // rename (a rollback passes the custom name as an override; never store that).
      metaTitle: (info.meta && info.meta.title) || null,
      version: meta.version || version || null,
      author: meta.author || null,
      description: meta.description || null,
      eaCompatible: typeof meta.eaCompatible === 'boolean' ? meta.eaCompatible : null,
      launchers: meta.launchers || null,
      // ZCSDK content mod: { manifest, registry, grants } — needs the ZCSDK Runtime.
      zcsdk: meta.zcsdk || null,
      modType: info.modType,
      // Game Feature plugin: the on-disk folder name under SWZeroCompany\Mods.
      // It must match the .uplugin's own name, so deploy uses THIS, never the
      // display name (which the user may rename freely).
      pluginName: info.modType === 'gfp' ? (info.pluginName || safeName(info.name)) : null,
      enabled: false,
      installedAt: new Date().toISOString(),
      installedBuild: this.currentBuildId(),
      loadPriority: ordered ? this.store.nextLoadPriority(['pak', 'iostore']) : null,
      ue4ssPriority: info.modType === 'ue4ss-mod' ? this._nextUe4ssPriority() : null,
      sourceArchive,
      files,
      packages: this._listPackages(libDir, files),
      warnings: info.warnings,
      deployed: [],
      deployedHashes: {},
      backups: [],
      // Where the mod came from.
      // {type:'local'} | {type:'nexus',modId,fileId,version} | {type:'github',repo,tag}
      origin: origin ? { ...origin } : { type: 'local' },
      updateInfo: null,
    };
    this.store.addMod(mod);
    // keepGameFiles (the automatic archive restore): files already in the game
    // where this mod deploys that are not these bytes (a newer build deployed
    // outside Mod Command) stay as they are — the mod is recorded disabled.
    if (keepGameFiles) {
      const d = this._deploymentDrift({ ...mod, deployed: files.map((f) => this._deployRel(mod, f)).filter(Boolean) }, { hash: true });
      if (d.changed.length || d.foreign.length) {
        log('warn', `${mod.name}: left disabled — the game already holds different files where it deploys (${[...d.changed, ...d.foreign].slice(0, 3).join(', ')}${d.changed.length + d.foreign.length > 3 ? ', …' : ''})`);
        this.store.save();
        return { ...this.store.getMod(id), keptGameFiles: true };
      }
    }
    this.setEnabled(id, true);
    return this.store.getMod(id);
  }

  // ------------------------------------------------------------- FOMOD sessions

  fomodSession(sessionId) {
    const s = this._fomodSessions.get(sessionId);
    if (!s) throw new Error('That guided install is no longer active.');
    return s;
  }

  // Materialize the wizard's answers (source→destination copy list, already
  // priority-ordered) into a plain folder, then install it like any other mod.
  // Every path is re-checked here — group rules on screen are not trusted.
  async completeFomod(sessionId, selections) {
    const session = this.fomodSession(sessionId);
    const fomod = require('./fomod');
    const matDir = path.join(this.store.stagingDir, `fomod-${newId()}`);
    try {
      fomod.materialize(session.root, session.fomodBase, selections, matDir);
      const metaOverride = {};
      if (session.info) {
        if (session.info.name) metaOverride.title = session.info.name;
        if (session.info.version) metaOverride.version = session.info.version;
        if (session.info.author) metaOverride.author = session.info.author;
        if (session.info.description) metaOverride.description = session.info.description;
      }
      return this._installOrVersion(matDir, {
        fallbackName: (session.info && session.info.name) ? safeName(session.info.name) : session.fallbackName,
        sourceArchive: session.sourceArchive,
        metaOverride,
        origin: session.origin || undefined,
        version: session.version || undefined,
      });
    } finally {
      fs.rmSync(matDir, { recursive: true, force: true });
      this.cancelFomod(sessionId);
    }
  }

  cancelFomod(sessionId) {
    const s = this._fomodSessions.get(sessionId);
    if (!s) return;
    this._fomodSessions.delete(sessionId);
    if (s.stagingDir) fs.rmSync(s.stagingDir, { recursive: true, force: true });
  }

  // Install / update / switch the UE4SS runtime. Only UE4SS's OWN files are
  // replaced; what belongs to the user survives:
  //   - ue4ss\Mods: every folder the package does not ship is untouched; a
  //     folder that is a Mod Command-managed UE4SS mod is never overwritten; a
  //     built-in the user switched off (no enabled.txt) stays off.
  //   - ue4ss\Mods\mods.txt: the user's file is kept line for line (enable
  //     lines, comments, the managed start-order block); built-ins the package
  //     adds that the file does not list yet are inserted before Keybinds.
  //   - UE4SS-settings.ini: the package's file is the base, and every value the
  //     user changed from what the previous package shipped is carried over
  //     (the shipped copy is kept in <data>\ue4ss-shipped-settings.ini). With
  //     no shipped copy on record (the first install by this app, or a switch
  //     from a build placed by hand) the [Debug] values — console/GUI
  //     preferences — that differ from the stock defaults are carried over
  //     and the rest comes from the package.
  //   - A complete package (it has ue4ss\UE4SS.dll) retires the files the
  //     previous package shipped (<data>\ue4ss-shipped-files.json) that it
  //     does not ship itself; with no such record (a build placed by hand, or
  //     the stock build) only the stock zip's extras (UE4SS.pdb, API.txt,
  //     Changelog.md, README.md). Nothing else in ue4ss\ is ever removed —
  //     dumps, .jmap files, logs, the Mod SDK's files and its generated
  //     UE4SS_Signatures\*.lua stay. The caller snapshots the old runtime into
  //     the vault first, so this is reversible; a package file that would
  //     overwrite a file that is not runtime (an SDK-generated signature of
  //     the same name) is kept in that snapshot before it is replaced.
  _installUe4ssRuntime(root, info) {
    const win64 = this.gameAbs(WIN64_REL);
    if (!fs.existsSync(win64)) throw new Error('Game Win64 folder not found.');
    const norm = (p) => p.split(/[\\/]+/).join(path.sep);
    const lower = (p) => norm(p).toLowerCase();
    const modsPrefix = lower(path.join('ue4ss', 'Mods')) + path.sep;
    const settingsRel = lower(path.join('ue4ss', 'UE4SS-settings.ini'));
    const modsTxtRel = lower(path.join('ue4ss', 'Mods', 'mods.txt'));
    const managedDirs = new Set(this.store.mods
      .filter((m) => m.modType === 'ue4ss-mod')
      .map((m) => safeName(m.name).toLowerCase()));
    const incoming = new Set(info.payload.map((p) => lower(p.deployRelative)));
    const complete = incoming.has(lower(path.join('ue4ss', 'UE4SS.dll'))) && incoming.has('dwmapi.dll');
    const report = { replaced: 0, keptUserMods: 0, modsTxt: 'kept', settings: 'package', retired: 0 };
    const prevShipped = this._ue4ssShippedFiles();
    const runtimeNow = new Set(this._ue4ssRuntimeFiles().map(lower));

    // Package files that would overwrite something that is not runtime (an
    // SDK-generated signature, a file some other tool put there): keep a copy
    // in the vault first, so a restore of the previous build puts it back.
    const foreign = [];
    for (const p of info.payload) {
      const rel = norm(p.deployRelative);
      const l = rel.toLowerCase();
      if (l.startsWith(modsPrefix) || l === settingsRel || runtimeNow.has(l)) continue;
      // (A ZCSDK Runtime signature is not overwritten at all — see _zcsdkShadowSig.)
      if (isFile(path.join(win64, rel)) && !this._zcsdkOwnedSig(rel)) foreign.push(rel);
    }
    if (foreign.length && !this._ue4ssKeepForeign(foreign)) {
      throw new Error(`Could not keep a copy of ${foreign.length} file(s) the UE4SS package would overwrite (${foreign.slice(0, 3).join(', ')}) — nothing was changed.`);
    }

    // Stale files of the build being replaced: only what the previous package
    // shipped (or, with no record, the stock zip's extras) and this one lacks.
    if (complete) {
      for (const rel of prevShipped || UE4SS_STOCK_EXTRAS) {
        const l = lower(rel);
        if (incoming.has(l) || l === settingsRel || l.startsWith(modsPrefix)) continue;
        const abs = path.join(win64, norm(rel));
        // Held for the ZCSDK Runtime: the old package's copy is not put back later.
        this._zcsdkDropShadow(norm(rel));
        if (!isFile(abs) || this._ue4ssSdkGenerated(norm(rel))) continue;
        try { fs.rmSync(abs, { force: true }); report.retired += 1; } catch (_) {}
      }
    }

    const skippedDirs = new Set();
    let pkgModsTxt = null;
    let pkgSettings = null;
    for (const p of info.payload) {
      const rel = norm(p.deployRelative);
      const l = rel.toLowerCase();
      const src = path.join(root, p.sourceRelative);
      const dst = path.join(win64, rel);
      if (l === modsTxtRel) { pkgModsTxt = fs.readFileSync(src, 'utf8'); continue; }
      if (l === settingsRel) { pkgSettings = fs.readFileSync(src, 'utf8'); continue; }
      if (l.startsWith(modsPrefix)) {
        const inner = rel.slice(modsPrefix.length);
        const dir = inner.split(path.sep)[0];
        const dirLower = dir.toLowerCase();
        const dirAbs = path.join(win64, 'ue4ss', 'Mods', dir);
        if (inner.includes(path.sep)) {
          // A folder that is the user's managed UE4SS mod: theirs, not ours.
          if (managedDirs.has(dirLower)) { skippedDirs.add(dirLower); continue; }
          // A built-in the user disabled (folder there, no enabled.txt) stays disabled.
          if (path.basename(l) === 'enabled.txt' && fs.existsSync(dirAbs) && !fs.existsSync(dst)) continue;
        } else if (fs.existsSync(dst)) {
          continue; // a loose file in Mods the user already has
        }
      }
      // A signature the ZCSDK Runtime placed (and still owns) stays; the
      // package's copy is the one put back when the runtime is removed.
      if (this._zcsdkShadowSig(rel, src)) { report.zcsdkSigsKept = (report.zcsdkSigsKept || 0) + 1; continue; }
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.copyFileSync(src, dst);
      report.replaced += 1;
    }
    report.keptUserMods = skippedDirs.size;
    fs.mkdirSync(path.join(win64, 'ue4ss', 'Mods'), { recursive: true });

    // What this package installed outside ue4ss\Mods — the runtime's own files
    // from now on (the next update retires from this list; snapshots and
    // restores are bounded by it). A partial package adds to the list.
    const shippedNow = info.payload.map((p) => norm(p.deployRelative)).filter((rel) => !rel.toLowerCase().startsWith(modsPrefix));
    this._writeUe4ssShippedFiles(complete || !prevShipped ? shippedNow : [...prevShipped, ...shippedNow]);

    // mods.txt: the user's lines win.
    if (pkgModsTxt != null) {
      const abs = path.join(win64, 'ue4ss', 'Mods', 'mods.txt');
      let mine = null;
      try { mine = fs.readFileSync(abs, 'utf8'); } catch (_) {}
      if (mine == null) { fs.writeFileSync(abs, pkgModsTxt); report.modsTxt = 'package'; }
      else {
        const merged = mergeModsTxt(mine, pkgModsTxt);
        if (merged !== mine) { fs.writeFileSync(abs, merged); report.modsTxt = 'merged'; }
      }
    }

    // UE4SS-settings.ini: three-way merge against what the last package shipped.
    if (pkgSettings != null) {
      const abs = path.join(win64, 'ue4ss', 'UE4SS-settings.ini');
      const shippedAbs = path.join(this.store.dataDir, UE4SS_SHIPPED_SETTINGS);
      let mine = null;
      let shipped = null;
      try { mine = fs.readFileSync(abs, 'utf8'); } catch (_) {}
      try { shipped = fs.readFileSync(shippedAbs, 'utf8'); } catch (_) {}
      const merged = mine == null ? { text: pkgSettings, carried: [] } : mergeUe4ssSettings(mine, pkgSettings, shipped);
      fs.writeFileSync(abs, merged.text);
      report.settings = merged.carried.length ? `package + ${merged.carried.length} of your setting(s)` : 'package';
      report.carriedSettings = merged.carried;
      try { fs.writeFileSync(shippedAbs, pkgSettings); } catch (_) {}
    }
    return { id: null, name: 'UE4SS Runtime', modType: 'ue4ss-runtime', enabled: true, runtime: true, report };
  }

  // Best-effort asset-path listing via `retoc list <utoc> --path` (for conflict detection).
  // Paths are printed relative to the engine binary dir, prefixed "../../../".
  _listPackages(libDir, files) {
    const retoc = this.retocPath();
    if (!retoc) return [];
    const packages = new Set();
    const failed = [];
    for (const f of files) {
      if (path.extname(f.libraryRelative).toLowerCase() !== '.utoc') continue;
      try {
        const out = execFileSync(retoc, ['list', path.join(libDir, f.libraryRelative), '--path'], {
          encoding: 'utf8', timeout: 60000, maxBuffer: 128 * 1024 * 1024,
          stdio: ['ignore', 'pipe', 'ignore'],
        });
        for (const line of out.split(/\r?\n/)) {
          const idx = line.indexOf('../../../');
          if (idx === -1) continue;
          const assetPath = line.slice(idx + '../../../'.length).trim();
          if (assetPath) packages.add(assetPath.toLowerCase());
        }
      } catch (_) { failed.push(path.basename(f.libraryRelative)); } // skip this container
    }
    // One line per scan, not per container: conflict detection falls back to
    // file names for whatever retoc could not read.
    if (failed.length) {
      log('info', `retoc could not list ${failed.length} container(s) (${failed.slice(0, 3).join(', ')}${failed.length > 3 ? ', …' : ''}); conflict detection uses file names for them`);
    }
    return [...packages];
  }

  // Re-scan asset paths for mods that were installed while retoc was unavailable.
  refreshPackages() {
    if (!this.retocPath()) return 0;
    let updated = 0;
    for (const mod of this.store.mods) {
      // 'ue4ss-mod' included for the mods that ship their own paks\ folder: the
      // containers stay inside the mod folder, but their asset paths still tell
      // us which other mods they overlap with.
      if (!['iostore', 'gfp', 'ue4ss-mod'].includes(mod.modType) || (mod.packages && mod.packages.length)) continue;
      const pkgs = this._listPackages(this.store.modLibraryDir(mod.id), mod.files);
      if (pkgs.length) {
        mod.packages = pkgs;
        updated += 1;
      }
    }
    if (updated) this.store.save();
    return updated;
  }

  retocPath() {
    const configured = this.store.settings.retocPath;
    const candidates = [
      configured,
      // A copy updated from GitHub by Settings → retoc (lib/retoc.js) beats
      // the one bundled with this build.
      path.join(this.store.dataDir, 'tools', 'retoc.exe'),
      path.join(__dirname, '..', 'tools', 'retoc.exe'),
      // Packaged builds ship tools/ next to the asar via extraResources.
      process.resourcesPath ? path.join(process.resourcesPath, 'tools', 'retoc.exe') : null,
    ].filter(Boolean);
    for (const c of candidates) {
      try { if (fs.existsSync(c)) return c; } catch (_) {}
    }
    return null;
  }

  // ------------------------------------------------------------- deploy

  _pakPrefix(mod) {
    const prio = String(mod.loadPriority || 0).padStart(3, '0');
    return `pakchunk99-P${prio}_${safeName(mod.name)}_`;
  }

  // The on-disk folder name for a Game Feature plugin mod (Diagnostics asks for
  // it too). A record whose pluginName went missing falls back to the .uplugin
  // shipped in its library copy, then to the display name.
  gfpFolderName(mod) {
    if (mod.pluginName && usableFolderName(mod.pluginName)) return mod.pluginName;
    const up = (mod.files || []).find((f) => path.extname(f.libraryRelative).toLowerCase() === '.uplugin');
    if (up) {
      const stem = path.basename(up.libraryRelative, path.extname(up.libraryRelative));
      if (usableFolderName(stem)) return stem;
    }
    return safeName(mod.name);
  }

  // Game-root-relative path a library file is deployed to (null: not deployed).
  _deployRel(mod, f) {
    if (mod.modType === 'pak' || mod.modType === 'iostore') {
      const fileName = path.basename(f.libraryRelative);
      // ZCSDK sidecars keep their exact names: the runtime finds the
      // *.zcsdk.lua manifest by suffix and resolves the registry file it
      // names relative to itself.
      if (isSidecar(fileName)) return path.join(MODS_REL, fileName);
      const base = path.basename(f.libraryRelative, path.extname(f.libraryRelative));
      const ext = path.extname(f.libraryRelative);
      const suffix = safeName(base) === safeName(mod.name) ? '' : safeName(base);
      return path.join(MODS_REL, `${this._pakPrefix(mod)}${suffix}${ext}`.replace(/_(?=\.)/, ''));
    }
    if (mod.modType === 'logicmods') return path.join(LOGIC_MODS_REL, path.basename(f.libraryRelative));
    if (mod.modType === 'ue4ss-mod') return path.join(UE4SS_MODS_REL, safeName(mod.name), f.libraryRelative);
    if (mod.modType === 'gfp') return path.join(GAME_MODS_REL, this.gfpFolderName(mod), f.libraryRelative);
    if (mod.modType === 'gamefolder') return f.libraryRelative; // game-root-relative by construction
    return null;
  }

  _deployMod(mod) {
    this.ensureGameDirs();
    const libDir = this.store.modLibraryDir(mod.id);
    const deployed = [];
    const hashes = {};
    // Deployed files are byte-identical library copies — reuse the install-time
    // hash where recorded (pre-1.1.0 installs have none; hash on the fly).
    const libHash = (f) => f.sha256 || sha256File(path.join(libDir, f.libraryRelative));
    if (mod.modType === 'pak' || mod.modType === 'iostore') {
      for (const f of mod.files) {
        const destRel = this._deployRel(mod, f);
        const dst = this.gameAbs(destRel);
        fs.copyFileSync(path.join(libDir, f.libraryRelative), dst);
        deployed.push(destRel);
        hashes[destRel] = libHash(f);
      }
    } else if (mod.modType === 'logicmods') {
      for (const f of mod.files) {
        const destRel = this._deployRel(mod, f);
        const dst = this.gameAbs(destRel);
        fs.copyFileSync(path.join(libDir, f.libraryRelative), dst);
        deployed.push(destRel);
        hashes[destRel] = libHash(f);
      }
    } else if (mod.modType === 'ue4ss-mod') {
      const modDirRel = path.join(UE4SS_MODS_REL, safeName(mod.name));
      for (const f of mod.files) {
        const destRel = this._deployRel(mod, f);
        const dst = this.gameAbs(destRel);
        fs.mkdirSync(path.dirname(dst), { recursive: true });
        fs.copyFileSync(path.join(libDir, f.libraryRelative), dst);
        deployed.push(destRel);
        hashes[destRel] = libHash(f);
      }
      // enabled.txt makes UE4SS load the mod without a mods.txt entry
      const enabledTxtRel = path.join(modDirRel, 'enabled.txt');
      const enabledTxt = this.gameAbs(enabledTxtRel);
      if (!fs.existsSync(enabledTxt)) fs.writeFileSync(enabledTxt, '');
      deployed.push(enabledTxtRel);
      // enabled.txt is a marker the user may legitimately touch — no hash.
    } else if (mod.modType === 'gfp') {
      // Game Feature plugin: the folder goes down whole, under the plugin's own
      // name, and nothing is renamed or prefixed. The game's loader mounts
      // SWZeroCompany\Mods\<Plugin>\ at startup and appends its root
      // AssetRegistry.bin itself — no ~mods, no pakchunk prefix, no load order.
      for (const f of mod.files) {
        const destRel = this._deployRel(mod, f);
        const dst = this.gameAbs(destRel);
        fs.mkdirSync(path.dirname(dst), { recursive: true });
        fs.copyFileSync(path.join(libDir, f.libraryRelative), dst);
        deployed.push(destRel);
        hashes[destRel] = libHash(f);
      }
    } else if (mod.modType === 'gamefolder') {
      // Replacement-style mod: the original of every game file it overwrites is
      // kept in the manager's backups and restored when the mod is disabled.
      const backupDir = this.store.modBackupsDir(mod.id);
      mod.backups = mod.backups || [];
      for (const f of mod.files) {
        const destRel = this._deployRel(mod, f);
        const dst = this.gameAbs(destRel);
        if (fs.existsSync(dst) && !mod.backups.includes(destRel)) {
          const bak = path.join(backupDir, destRel);
          fs.mkdirSync(path.dirname(bak), { recursive: true });
          fs.copyFileSync(dst, bak);
          mod.backups.push(destRel);
        }
        fs.mkdirSync(path.dirname(dst), { recursive: true });
        fs.copyFileSync(path.join(libDir, f.libraryRelative), dst);
        deployed.push(destRel);
        hashes[destRel] = libHash(f);
      }
    }
    mod.deployed = deployed;
    mod.deployedHashes = hashes;
  }

  // force=true skips the ownership check (used after the user confirms, and for
  // internal redeploys where the files were verified moments earlier).
  _undeployMod(mod, force) {
    if (!force) {
      // SHA-256 ownership check: a deployed file that changed outside the
      // manager is someone else's data now — stop instead of deleting it.
      const changed = [];
      for (const rel of mod.deployed || []) {
        const expected = mod.deployedHashes && mod.deployedHashes[rel];
        if (!expected) continue;
        const abs = this.gameAbs(rel);
        if (!fs.existsSync(abs)) continue;
        try { if (sha256File(abs) !== expected) changed.push(rel); } catch (_) {}
      }
      if (changed.length) {
        const err = new Error(
          `VERIFY_CHANGED::${mod.name}::${changed.join('|')}`);
        err.verifyChanged = changed;
        throw err;
      }
    }
    for (const rel of mod.deployed || []) {
      const abs = this.gameAbs(rel);
      try { fs.rmSync(abs, { force: true }); } catch (_) {}
    }
    if (mod.modType === 'gamefolder') {
      // Put the original game files back.
      const backupDir = this.store.modBackupsDir(mod.id);
      for (const rel of mod.backups || []) {
        const bak = path.join(backupDir, rel);
        if (!fs.existsSync(bak)) continue;
        const dst = this.gameAbs(rel);
        try {
          fs.mkdirSync(path.dirname(dst), { recursive: true });
          fs.copyFileSync(bak, dst);
        } catch (_) {}
      }
    }
    if (mod.modType === 'ue4ss-mod') {
      // Remove the (now empty) mod folder tree.
      const dir = this.gameAbs(path.join(UE4SS_MODS_REL, safeName(mod.name)));
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
    }
    if (mod.modType === 'gfp') {
      // The plugin folder goes with it — the game treats a leftover folder as a
      // (broken) mod, and removing the folder is what removes the mod.
      const dir = this.gameAbs(path.join(GAME_MODS_REL, this.gfpFolderName(mod)));
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
    }
    mod.deployed = [];
    mod.deployedHashes = {};
  }

  setEnabled(id, enabled, force) {
    const mod = this.store.getMod(id);
    if (!mod) throw new Error('That mod is no longer installed.');
    if (enabled === mod.enabled) return mod;
    if (enabled) this._deployMod(mod);
    else this._undeployMod(mod, force);
    mod.enabled = enabled;
    this.store.save();
    if (mod.modType === 'ue4ss-mod') this._syncUe4ssModsTxt();
    return mod;
  }

  uninstall(id, force, opts = {}) {
    const mod = this.store.getMod(id);
    if (!mod) throw new Error('That mod is no longer installed.');
    if (mod.enabled) this._undeployMod(mod, force);
    fs.rmSync(this.store.modLibraryDir(id), { recursive: true, force: true });
    fs.rmSync(this.store.modBackupsDir(id), { recursive: true, force: true });
    this.store.removeMod(id);
    if (mod.modType === 'ue4ss-mod') this._syncUe4ssModsTxt();
    // The last ZCSDK Runtime part is gone → so are the signature files the
    // runtime installer put in ue4ss\UE4SS_Signatures.
    // Not while installZcsdkRuntime swaps the parts (opts.keepZcsdkSigs).
    if (!opts.keepZcsdkSigs && this._isZcsdkPart(mod) && !this.store.mods.some((m) => this._isZcsdkPart(m))) this._removeZcsdkSignatures();
  }

  rename(id, name) {
    const mod = this.store.getMod(id);
    if (!mod) throw new Error('That mod is no longer installed.');
    if (!name || name.length > 120) throw new Error('Use a name between 1 and 120 characters.');
    // A Game Feature plugin's deployed folder is named after its .uplugin, not
    // after the display name — the game matches the two, so a rename is cosmetic
    // and must NOT move the folder (nor recopy a multi-hundred-MB payload).
    const wasEnabled = mod.enabled && mod.modType !== 'gfp';
    if (wasEnabled) this._undeployMod(mod);
    mod.name = name;
    if (wasEnabled) this._deployMod(mod);
    this.store.save();
    if (mod.modType === 'ue4ss-mod') this._syncUe4ssModsTxt();
    return mod;
  }

  // Enable or disable every installed mod at once. Disabling pre-verifies the
  // deployed files of ALL affected mods first (one aggregate ownership check),
  // so a failed check can't leave the set half-toggled.
  setAllEnabled(enabled, force) {
    const targets = this.store.mods.filter((m) => m.enabled !== enabled);
    if (!targets.length) return { changed: 0, errors: [] };
    if (!enabled && !force) {
      const changed = [];
      for (const mod of targets) {
        for (const rel of mod.deployed || []) {
          const expected = mod.deployedHashes && mod.deployedHashes[rel];
          if (!expected) continue;
          const abs = this.gameAbs(rel);
          if (!fs.existsSync(abs)) continue;
          try { if (sha256File(abs) !== expected) changed.push(rel); } catch (_) {}
        }
      }
      if (changed.length) {
        const err = new Error(`VERIFY_CHANGED::${targets.length} mods::${changed.join('|')}`);
        err.verifyChanged = changed;
        throw err;
      }
    }
    const result = { changed: 0, errors: [] };
    for (const mod of targets) {
      try {
        if (enabled) this._deployMod(mod);
        else this._undeployMod(mod, true); // verified above (or forced)
        mod.enabled = enabled;
        result.changed += 1;
      } catch (err) {
        result.errors.push(`${mod.name}: ${err.message}`);
      }
    }
    this.store.save();
    this._syncUe4ssModsTxt();
    return result;
  }

  // ------------------------------------------------------------- version vault
  // Old versions of a mod are archived (library copy + manifest) whenever an
  // update replaces it, and before every rollback — so users can roll back,
  // roll forward again, and pin profiles to specific versions. Identity is
  // modType + name, so a renamed mod starts a fresh history.

  // Vault identity: the mod type + the title its modinfo SHIPPED with, so a
  // user rename never strands the version history (records without a shipped
  // title — pre-1.9.0 installs, folder-named mods — keep using their name).
  _vaultKey(mod) {
    return `${mod.modType}-${safeName(mod.metaTitle || mod.name).toLowerCase()}`;
  }

  // Carry archived versions over when a mod's vault key changes (an older
  // record keyed by its custom name gets replaced by one keyed by its title).
  _moveVault(fromKey, toKey) {
    if (fromKey === toKey) return;
    const from = this.store.modVaultDir(fromKey);
    if (!fs.existsSync(from)) return;
    const to = this.store.modVaultDir(toKey);
    fs.mkdirSync(to, { recursive: true });
    for (const entry of fs.readdirSync(from)) {
      const dst = path.join(to, entry);
      if (!fs.existsSync(dst)) { try { fs.renameSync(path.join(from, entry), dst); } catch (_) {} }
    }
    try { if (!fs.readdirSync(from).length) fs.rmSync(from, { recursive: true, force: true }); } catch (_) {}
  }

  _snapshotVersion(mod) {
    try {
      const key = this._vaultKey(mod);
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const entryId = `${stamp}__${safeName(mod.version || 'unversioned')}`;
      const dir = path.join(this.store.modVaultDir(key), entryId);
      const filesDir = path.join(dir, 'files');
      fs.mkdirSync(filesDir, { recursive: true });
      const libDir = this.store.modLibraryDir(mod.id);
      for (const f of mod.files) {
        const dst = path.join(filesDir, f.libraryRelative);
        fs.mkdirSync(path.dirname(dst), { recursive: true });
        fs.copyFileSync(path.join(libDir, f.libraryRelative), dst);
      }
      fs.writeFileSync(path.join(dir, 'vault.json'), JSON.stringify({
        name: mod.name,
        version: mod.version || null,
        modType: mod.modType,
        origin: mod.origin || { type: 'local' },
        savedAt: new Date().toISOString(),
      }, null, 2));
      // Keep the newest 5 archived versions per mod.
      const entries = fs.readdirSync(this.store.modVaultDir(key)).sort().reverse();
      for (const stale of entries.slice(5)) {
        fs.rmSync(path.join(this.store.modVaultDir(key), stale), { recursive: true, force: true });
      }
      return entryId;
    } catch (_) { return null; /* best-effort — never blocks the operation */ }
  }

  listVersions(id) {
    const mod = this.store.getMod(id);
    if (!mod) throw new Error('That mod is no longer installed.');
    const key = this._vaultKey(mod);
    const vaultDir = this.store.modVaultDir(key);
    const entries = [];
    try {
      for (const entryId of fs.readdirSync(vaultDir).sort().reverse()) {
        try {
          const manifest = JSON.parse(fs.readFileSync(path.join(vaultDir, entryId, 'vault.json'), 'utf8'));
          entries.push({ entryId, version: manifest.version, name: manifest.name, savedAt: manifest.savedAt });
        } catch (_) {}
      }
    } catch (_) {}
    return { key, current: { version: mod.version || null, name: mod.name }, entries };
  }

  // Swap the installed mod for an archived version. The current version is
  // vaulted first, so rolling back is itself reversible.
  async rollbackVersion(id, entryId) {
    const mod = this.store.getMod(id);
    if (!mod) throw new Error('That mod is no longer installed.');
    const key = this._vaultKey(mod);
    const entryDir = path.join(this.store.modVaultDir(key), entryId);
    const manifest = JSON.parse(fs.readFileSync(path.join(entryDir, 'vault.json'), 'utf8'));
    this._snapshotVersion(mod);
    const keep = {
      enabled: mod.enabled,
      loadPriority: mod.loadPriority,
      ue4ssPriority: mod.ue4ssPriority,
    };
    this.uninstall(mod.id, true);
    const res = await this.install(path.join(entryDir, 'files'), {
      skipFomod: true,
      origin: manifest.origin,
      version: manifest.version,
      metaOverride: { title: manifest.name },
    });
    const installed = res.multi ? res.mods[0] : res;
    const fresh = this.store.getMod(installed.id);
    if (keep.loadPriority != null && ['pak', 'iostore'].includes(fresh.modType)) {
      const wasEnabled = fresh.enabled;
      if (wasEnabled) this._undeployMod(fresh, true);
      fresh.loadPriority = keep.loadPriority;
      if (wasEnabled) this._deployMod(fresh);
    }
    if (keep.ue4ssPriority != null && fresh.modType === 'ue4ss-mod') {
      fresh.ue4ssPriority = keep.ue4ssPriority;
      this._syncUe4ssModsTxt();
    }
    if (!keep.enabled) this.setEnabled(fresh.id, false);
    const final = this.store.getMod(fresh.id);
    final.updateInfo = null;
    this.store.save();
    return final;
  }

  // Mark a mod as verified against the current game build (clears the
  // "installed under a different build" warning until the game updates again).
  confirmBuild(id) {
    const mod = this.store.getMod(id);
    if (!mod) throw new Error('That mod is no longer installed.');
    mod.installedBuild = this.currentBuildId();
    this.store.save();
    return mod;
  }

  // New order = array of mod ids (pak/iostore only), first = lowest priority.
  applyLoadOrder(orderedIds) {
    const orderable = this.store.mods.filter((m) => ['pak', 'iostore'].includes(m.modType));
    const idSet = new Set(orderable.map((m) => m.id));
    if (orderedIds.length !== orderable.length || orderedIds.some((i) => !idSet.has(i))) {
      throw new Error('The order must list every installed pak mod exactly once.');
    }
    // Verify every file that will move BEFORE touching anything, so a failed
    // ownership check cannot leave the order half-applied.
    const changed = [];
    orderedIds.forEach((id, idx) => {
      const mod = this.store.getMod(id);
      if (!mod.enabled || mod.loadPriority === idx + 1) return;
      for (const rel of mod.deployed || []) {
        const expected = mod.deployedHashes && mod.deployedHashes[rel];
        if (!expected) continue;
        const abs = this.gameAbs(rel);
        if (!fs.existsSync(abs)) continue;
        try { if (sha256File(abs) !== expected) changed.push(`${mod.name}: ${rel}`); } catch (_) {}
      }
    });
    if (changed.length) {
      throw new Error(`These deployed files were changed outside the manager — reorder stopped to protect them: ${changed.join(', ')}`);
    }
    // Snapshot the outgoing order for one-step rollback.
    this.store.data.lastOrderBackup = {
      at: new Date().toISOString(),
      order: [...orderable].sort((a, b) => (a.loadPriority || 0) - (b.loadPriority || 0)).map((m) => m.id),
    };
    orderedIds.forEach((id, idx) => {
      const mod = this.store.getMod(id);
      const newPrio = idx + 1;
      if (mod.loadPriority !== newPrio) {
        const wasEnabled = mod.enabled;
        if (wasEnabled) this._undeployMod(mod, true); // verified above
        mod.loadPriority = newPrio;
        if (wasEnabled) this._deployMod(mod);
      }
    });
    this.store.save();
  }

  // Winner preview for a drafted order: which conflict pairs exist, who wins
  // now, and who would win after — shown for review before anything moves.
  previewLoadOrder(orderedIds) {
    const prio = new Map(orderedIds.map((id, i) => [id, i + 1]));
    const pairs = [];
    for (const c of this.conflicts()) {
      if (!prio.has(c.aId) || !prio.has(c.bId)) continue;
      const a = this.store.getMod(c.aId);
      const b = this.store.getMod(c.bId);
      const newWinner = prio.get(c.bId) > prio.get(c.aId) ? b : a;
      pairs.push({
        aName: a.name, bName: b.name,
        certainty: c.certainty,
        packageCount: c.packageCount, fileCount: c.fileCount,
        oldWinnerName: this.store.getMod(c.winnerId).name,
        newWinnerName: newWinner.name,
        changed: newWinner.id !== c.winnerId,
      });
    }
    const moved = orderedIds.filter((id, idx) => {
      const m = this.store.getMod(id);
      return m && m.loadPriority !== idx + 1;
    }).length;
    return { pairs, changedCount: pairs.filter((p) => p.changed).length, movedCount: moved };
  }

  // One-step undo of the last applied order (applying makes the outgoing order
  // the new backup, so rollback of a rollback is redo).
  rollbackLoadOrder() {
    const backup = this.store.data.lastOrderBackup;
    if (!backup || !Array.isArray(backup.order)) throw new Error('No earlier load order to roll back to.');
    const orderable = this.store.mods
      .filter((m) => ['pak', 'iostore'].includes(m.modType))
      .sort((a, b) => (a.loadPriority || 0) - (b.loadPriority || 0));
    const known = new Set(orderable.map((m) => m.id));
    const restored = backup.order.filter((id) => known.has(id));
    const extras = orderable.filter((m) => !restored.includes(m.id)).map((m) => m.id);
    this.applyLoadOrder([...restored, ...extras]);
    return { restoredAt: backup.at, appended: extras.length };
  }

  // How a mod's deployed files compare with its library copy:
  // { missing, changed, foreign } (game-root-relative paths). changed = still
  // present but not the library bytes (size first; equal sizes are hashed only
  // with opts.hash). foreign = files in a gfp mod's own plugin folder that the
  // record does not list — someone else deployed into it (e.g. a Mod SDK build).
  _deploymentDrift(mod, opts = {}) {
    const key = (rel) => path.normalize(rel).toLowerCase();
    const libDir = this.store.modLibraryDir(mod.id);
    const sources = new Map();
    for (const f of mod.files || []) {
      const rel = this._deployRel(mod, f);
      if (rel) sources.set(key(rel), f);
    }
    const drift = { missing: [], changed: [], foreign: [] };
    for (const rel of mod.deployed || []) {
      const abs = this.gameAbs(rel);
      let st;
      try { st = fs.statSync(abs); } catch (_) { drift.missing.push(rel); continue; }
      const f = sources.get(key(rel));
      if (!f) continue; // enabled.txt and other markers have no library source
      try {
        const lib = path.join(libDir, f.libraryRelative);
        if (st.size !== fs.statSync(lib).size) drift.changed.push(rel);
        else if (opts.hash && sha256File(abs) !== (f.sha256 || sha256File(lib))) drift.changed.push(rel);
      } catch (_) { drift.changed.push(rel); } // unreadable: treat as not ours
    }
    if (mod.modType === 'gfp') {
      const dirRel = path.join(GAME_MODS_REL, this.gfpFolderName(mod));
      const recorded = new Set((mod.deployed || []).map(key));
      let found = [];
      try { found = walkFiles(this.gameAbs(dirRel)); } catch (_) {}
      for (const r of found) {
        const rel = path.join(dirRel, r);
        if (!recorded.has(key(rel))) drift.foreign.push(rel);
      }
    }
    return drift;
  }

  // Startup recovery: an enabled mod whose deployed files went missing (deleted
  // by hand, a game update, a cleanup tool) is redeployed from its library copy —
  // but only when what is left is still ours. Files changed outside Mod Command
  // (a newer build deployed by the Mod SDK, a manual update) are never replaced
  // by the library copy: those mods are returned in `skipped` and left alone.
  repairDeployments() {
    const repaired = [];
    const skipped = [];
    for (const mod of this.store.mods.filter((m) => m.enabled)) {
      const missing = (mod.deployed || []).some((rel) => !fs.existsSync(this.gameAbs(rel)));
      if (!missing) continue;
      try {
        const drift = this._deploymentDrift(mod, { hash: true });
        if (drift.changed.length || drift.foreign.length) {
          skipped.push(mod.name);
          log('warn', `startup recovery skipped ${mod.name}: ${drift.missing.length} deployed file(s) missing, ${drift.changed.length} changed and ${drift.foreign.length} unrecorded file(s) present — the deployed files were changed outside Mod Command (${[...drift.changed, ...drift.foreign].slice(0, 3).join(', ')}${drift.changed.length + drift.foreign.length > 3 ? ', …' : ''})`);
          continue;
        }
        this._undeployMod(mod, true);
        this._deployMod(mod);
        repaired.push(mod.name);
      } catch (_) { /* leave it for diagnostics to report */ }
    }
    if (repaired.length) this.store.save();
    return { repaired, skipped };
  }

  // Diagnostics: enabled mods whose deployed files were changed outside Mod
  // Command. Cheap by default (sizes and unrecorded files); equal-size files are
  // hashed only for mods with a missing file, the ones startup recovery skips.
  auditChangedDeployments() {
    const out = [];
    for (const m of this.store.mods.filter((x) => x.enabled)) {
      const hasMissing = (m.deployed || []).some((rel) => !fs.existsSync(this.gameAbs(rel)));
      const d = this._deploymentDrift(m, { hash: hasMissing });
      if (d.changed.length || d.foreign.length) out.push({ modId: m.id, modName: m.name, changed: d.changed, foreign: d.foreign });
    }
    return out;
  }

  // Suggest an order for pak/iostore mods: broad mods (many assets) first,
  // targeted patches (few assets) later so the focused mod wins where they overlap.
  // Mods with equal/unknown asset counts keep their current relative order.
  suggestLoadOrder() {
    const current = this.store.mods
      .filter((m) => ['pak', 'iostore'].includes(m.modType))
      .sort((a, b) => (a.loadPriority || 0) - (b.loadPriority || 0));
    const count = (m) => (m.packages || []).length;
    const suggested = [...current].sort((a, b) => count(b) - count(a)); // stable in V8
    const orderedIds = suggested.map((m) => m.id);
    const changed = current.some((m, i) => m.id !== orderedIds[i]);
    // Note which confirmed conflicts this ordering decides.
    const decisions = [];
    for (const c of this.conflicts()) {
      if (c.certainty !== 'confirmed') continue;
      const ai = orderedIds.indexOf(c.aId);
      const bi = orderedIds.indexOf(c.bId);
      if (ai === -1 || bi === -1) continue;
      const winner = this.store.getMod(orderedIds[Math.max(ai, bi)]);
      const loser = this.store.getMod(orderedIds[Math.min(ai, bi)]);
      decisions.push(`${winner.name} overrides ${loser.name} (${c.packageCount} shared asset${c.packageCount === 1 ? '' : 's'})`);
    }
    return {
      orderedIds,
      changed,
      rationale: 'Broad mods first, targeted patches later — the more focused mod wins where they overlap.',
      decisions,
    };
  }

  // Replace every installed entry that came from the given origin with the
  // contents of a fresh download of it. Handles archives holding one mod OR
  // several (each re-splits into its own entry). Preserves, matching by name:
  // custom names (single-entry case), enabled state, and load priorities.
  async replaceOrigin(match, sourcePath, newOrigin, newVersion) {
    const isMatch = (m) => m.origin && m.origin.type === match.type
      && (match.type === 'nexus' ? m.origin.modId === match.modId : m.origin.repo === match.repo);
    const existing = this.store.mods.filter(isMatch);
    if (!existing.length) throw new Error('That mod is no longer installed.');
    const keepByName = new Map(existing.map((m) => [m.name.toLowerCase(), {
      enabled: m.enabled, loadPriority: m.loadPriority, ue4ssPriority: m.ue4ssPriority,
    }]));
    const singleKeep = existing.length === 1
      ? { name: existing[0].name, ...keepByName.values().next().value }
      : null;
    // Archive the outgoing versions so the update can be rolled back.
    for (const m of existing) this._snapshotVersion(m);
    for (const m of existing) this.uninstall(m.id);

    const res = await this.install(sourcePath, { origin: newOrigin, version: newVersion });
    if (res.pendingFomod) return res; // wizard finishes the install (origin rides the session)
    const mods = res.multi ? res.mods : [res];

    for (const installed of mods) {
      if (!installed.id) continue; // runtime install — nothing to restore
      const mod = this.store.getMod(installed.id);
      const keep = singleKeep || keepByName.get(mod.name.toLowerCase());
      if (!keep) continue;
      if (singleKeep && singleKeep.name && mod.name !== singleKeep.name) this.rename(mod.id, singleKeep.name);
      if (keep.loadPriority != null && ['pak', 'iostore'].includes(mod.modType)) {
        const m = this.store.getMod(mod.id);
        const wasEnabled = m.enabled;
        if (wasEnabled) this._undeployMod(m, true);
        m.loadPriority = keep.loadPriority;
        if (wasEnabled) this._deployMod(m);
      }
      if (keep.ue4ssPriority != null && mod.modType === 'ue4ss-mod') {
        this.store.getMod(mod.id).ue4ssPriority = keep.ue4ssPriority;
        this._syncUe4ssModsTxt();
      }
      if (!keep.enabled) this.setEnabled(mod.id, false);
    }
    this.store.save();
    return { multi: true, mods: mods.map((m) => (m.id ? this.store.getMod(m.id) : m)) };
  }

  // Current game build identity: Steam manifest buildid where a manifest
  // covers the install, else a local exe fingerprint (EA App / manual copies).
  currentBuildId() {
    try {
      if (!this.gamePath()) return null;
      const steam = require('./steam');
      const det = steam.detectGame(this.gamePath());
      return det.found ? det.buildId : null;
    } catch (_) { return null; }
  }

  _nextUe4ssPriority() {
    const prios = this.store.mods
      .filter((m) => m.modType === 'ue4ss-mod')
      .map((m) => m.ue4ssPriority || 0);
    return (prios.length ? Math.max(...prios) : 0) + 1;
  }

  // ------------------------------------------------------------- UE4SS start order (mods.txt)
  // UE4SS reads mods.txt top-down in two passes: DLL mods start while the
  // runtime initializes, Lua mods once the scripting runtime exists. Order
  // therefore matters WITHIN each pass. The manager owns one marked block,
  // placed just before the runtime's Keybinds entry with its warning attached;
  // everything else in the file is preserved untouched.

  _modsTxtAbs() { return this.gameAbs(path.join(UE4SS_MODS_REL, 'mods.txt')); }

  ue4ssPassOf(mod) {
    const libDir = this.store.modLibraryDir(mod.id);
    return fs.existsSync(path.join(libDir, 'dlls', 'main.dll')) ? 'dll' : 'lua';
  }

  _readModsTxt() {
    try {
      const raw = fs.readFileSync(this._modsTxtAbs(), 'utf8');
      return { lines: raw.split(/\r?\n/), eol: raw.includes('\r\n') ? '\r\n' : '\n', exists: true };
    } catch (_) {
      return {
        lines: ['; Created by Zero Company Mod Command', '; Built-in keybinds, do not move up!', 'Keybinds : 1', ''],
        eol: '\r\n',
        exists: false,
      };
    }
  }

  // Enabled UE4SS mods in start order (DLL-pass mods sort ahead of Lua-pass
  // mods by default; within a pass the saved priority, then install time).
  _managedUe4ssMods() {
    return this.store.mods
      .filter((m) => m.modType === 'ue4ss-mod' && m.enabled)
      .sort((a, b) => (a.ue4ssPriority || 1e9) - (b.ue4ssPriority || 1e9)
        || String(a.installedAt).localeCompare(String(b.installedAt)));
  }

  ue4ssOrderState() {
    const managed = this._managedUe4ssMods().map((m) => ({
      id: m.id,
      name: m.name,
      dirName: safeName(m.name),
      pass: this.ue4ssPassOf(m),
      priority: m.ue4ssPriority || null,
    }));
    const { lines, exists } = this._readModsTxt();
    const applied = lines.includes(UE4SS_BLOCK_BEGIN);
    // Entries the manager does not own (runtime built-ins, hand-added mods) — display-only.
    const managedDirs = new Set(managed.map((m) => m.dirName.toLowerCase()));
    const others = [];
    let inBlock = false;
    for (const line of lines) {
      if (line === UE4SS_BLOCK_BEGIN) { inBlock = true; continue; }
      if (line === UE4SS_BLOCK_END) { inBlock = false; continue; }
      if (inBlock) continue;
      const m = line.match(/^\s*([^;#\s][^:]*?)\s*:\s*([01])\s*$/);
      if (m && !managedDirs.has(m[1].trim().toLowerCase())) {
        others.push({ name: m[1].trim(), enabled: m[2] === '1' });
      }
    }
    return { managed, others, applied, modsTxtExists: exists };
  }

  // New order = every ENABLED UE4SS mod exactly once (any mix of passes; the
  // runtime applies each pass in this relative order).
  applyUe4ssOrder(orderedIds) {
    const eligible = this._managedUe4ssMods();
    const idSet = new Set(eligible.map((m) => m.id));
    if (orderedIds.length !== eligible.length || orderedIds.some((i) => !idSet.has(i))) {
      throw new Error('The start order must list every enabled UE4SS mod exactly once.');
    }
    orderedIds.forEach((id, idx) => { this.store.getMod(id).ue4ssPriority = idx + 1; });
    this._syncUe4ssModsTxt(true);
    this.store.save();
  }

  // Rewrite the managed block from current state. Until the first Apply the
  // block doesn't exist and deploys keep using enabled.txt markers alone;
  // pass force=true to create it (the first Apply does).
  _syncUe4ssModsTxt(force) {
    if (!this.gamePath()) return;
    if (!fs.existsSync(this.gameAbs(UE4SS_MODS_REL))) return;
    const { lines, eol } = this._readModsTxt();
    const hasBlock = lines.includes(UE4SS_BLOCK_BEGIN);
    if (!hasBlock && !force) return;
    const managed = this._managedUe4ssMods();
    const managedDirs = new Set(managed.map((m) => safeName(m.name).toLowerCase()));
    // Drop the old block, plus any bare entries for managed mods elsewhere in
    // the file — a hand-placed managed entry moves into the block.
    const kept = [];
    let inBlock = false;
    for (const line of lines) {
      if (line === UE4SS_BLOCK_BEGIN) { inBlock = true; continue; }
      if (line === UE4SS_BLOCK_END) { inBlock = false; continue; }
      if (inBlock) continue;
      const m = line.match(/^\s*([^;#\s][^:]*?)\s*:\s*[01]\s*$/);
      if (m && managedDirs.has(m[1].trim().toLowerCase())) continue;
      kept.push(line);
    }
    const block = [UE4SS_BLOCK_BEGIN, ...managed.map((m) => `${safeName(m.name)} : 1`), UE4SS_BLOCK_END];
    // Insert before the Keybinds entry, keeping its warning comment attached.
    let insertAt = kept.findIndex((l) => /^\s*Keybinds\s*:/i.test(l));
    if (insertAt > 0) {
      const prev = kept[insertAt - 1];
      if (/^\s*;/.test(prev) && /keybind|do not/i.test(prev)) insertAt -= 1;
    }
    if (insertAt === -1) insertAt = kept.length;
    kept.splice(insertAt, 0, ...block);
    fs.writeFileSync(this._modsTxtAbs(), kept.join(eol));
    // The block is authoritative — retire redundant enabled.txt markers (and
    // prune them from deploy records so startup recovery doesn't re-create them).
    let pruned = false;
    for (const m of managed) {
      const rel = path.join(UE4SS_MODS_REL, safeName(m.name), 'enabled.txt');
      try { fs.rmSync(this.gameAbs(rel), { force: true }); } catch (_) {}
      if (m.deployed && m.deployed.includes(rel)) {
        m.deployed = m.deployed.filter((r) => r !== rel);
        if (m.deployedHashes) delete m.deployedHashes[rel];
        pruned = true;
      }
    }
    if (pruned) this.store.save();
  }

  // ------------------------------------------------------------- profiles

  saveProfile(name) {
    if (!name || name.length > 60) throw new Error('Use a profile name between 1 and 60 characters.');
    const orderable = this.store.mods
      .filter((m) => ['pak', 'iostore'].includes(m.modType))
      .sort((a, b) => (a.loadPriority || 0) - (b.loadPriority || 0));
    const profile = {
      id: newId(),
      name,
      savedAt: new Date().toISOString(),
      // vaultKey + version pin the exact mod version this profile was saved
      // with; applying swaps versions back in from the vault when needed.
      entries: this.store.mods.map((m) => ({
        modId: m.id, modName: m.name, enabled: m.enabled,
        vaultKey: this._vaultKey(m), version: m.version || null,
      })),
      order: orderable.map((m) => m.id),
    };
    // Overwrite an existing profile with the same name.
    this.store.data.profiles = this.store.profiles.filter((p) => p.name.toLowerCase() !== name.toLowerCase());
    this.store.data.profiles.push(profile);
    this.store.save();
    return profile;
  }

  async applyProfile(id) {
    const profile = this.store.profiles.find((p) => p.id === id);
    if (!profile) throw new Error('That profile no longer exists.');
    const warnings = [];
    // Resolve each entry to an installed mod: by id first, then by vault key
    // (an update or rollback gives a mod a new id but keeps its identity).
    const resolved = new Map(); // entry -> current mod id (or null)
    for (const entry of profile.entries) {
      let mod = this.store.getMod(entry.modId);
      if (!mod && entry.vaultKey) {
        mod = this.store.mods.find((m) => this._vaultKey(m) === entry.vaultKey) || null;
      }
      resolved.set(entry, mod ? mod.id : null);
    }
    // Version pinning: swap in the profile's saved version where it differs
    // and the vault still holds it.
    for (const entry of profile.entries) {
      const modId = resolved.get(entry);
      if (!modId || !entry.vaultKey) continue;
      const mod = this.store.getMod(modId);
      if ((mod.version || null) === (entry.version || null)) continue;
      const versions = this.listVersions(mod.id);
      const target = versions.entries.find((e) => (e.version || null) === (entry.version || null));
      if (!target) {
        warnings.push(`"${entry.modName}" is v${mod.version || '?'} now; the profile wants v${entry.version || '?'}, which is not in the version vault — using the installed version.`);
        continue;
      }
      const swapped = await this.rollbackVersion(mod.id, target.entryId);
      resolved.set(entry, swapped.id);
      warnings.push(`"${entry.modName}" switched to v${entry.version || 'unversioned'} (profile pin).`);
    }
    for (const entry of profile.entries) {
      const modId = resolved.get(entry);
      if (!modId) {
        warnings.push(`"${entry.modName || entry.modId}" is no longer installed — skipped.`);
        continue;
      }
      const mod = this.store.getMod(modId);
      if (mod.enabled !== entry.enabled) this.setEnabled(mod.id, entry.enabled);
    }
    // Restore order: profile order first (existing mods only), new mods appended
    // in current order. Saved ids are remapped through the version swaps above.
    const idRemap = new Map(profile.entries.map((e) => [e.modId, resolved.get(e) || e.modId]));
    const orderable = this.store.mods
      .filter((m) => ['pak', 'iostore'].includes(m.modType))
      .sort((a, b) => (a.loadPriority || 0) - (b.loadPriority || 0));
    const inProfile = profile.order
      .map((mid) => idRemap.get(mid) || mid)
      .filter((mid) => orderable.some((m) => m.id === mid));
    const extras = orderable.filter((m) => !inProfile.includes(m.id)).map((m) => m.id);
    if (extras.length) warnings.push(`${extras.length} mod(s) installed after this profile was saved were placed last.`);
    this.applyLoadOrder([...inProfile, ...extras]);
    return { profile, warnings };
  }

  deleteProfile(id) {
    this.store.data.profiles = this.store.profiles.filter((p) => p.id !== id);
    this.store.save();
  }

  // ------------------------------------------------------------- adoption of existing mods

  // Find mod content in the game's deploy locations that no managed mod owns.
  // Returns candidates: { id, kind: 'pak-group'|'logicmods-group'|'ue4ss-folder',
  //                       name, modType, location, files: [game-relative], active }
  scanUnmanaged() {
    if (!this.gamePath()) return [];
    const candidates = [];
    const owned = new Set();
    for (const m of this.store.mods) {
      for (const rel of m.deployed || []) owned.add(path.resolve(this.gameAbs(rel)).toLowerCase());
    }

    // Pak-style locations: group loose pak/utoc/ucas by basename.
    for (const [locRel, kind, defaultType] of [[MODS_REL, 'pak-group', 'pak'], [LOGIC_MODS_REL, 'logicmods-group', 'logicmods']]) {
      const dir = this.gameAbs(locRel);
      if (!fs.existsSync(dir)) continue;
      const groups = new Map();
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isFile()) continue;
        const ext = path.extname(entry.name).toLowerCase();
        if (!PAK_EXTS.has(ext)) continue;
        const abs = path.resolve(path.join(dir, entry.name));
        if (owned.has(abs.toLowerCase())) continue;
        const base = path.basename(entry.name, ext);
        if (!groups.has(base)) groups.set(base, []);
        groups.get(base).push(path.join(locRel, entry.name));
      }
      // Unowned ZCSDK sidecars in ~mods ride with the pak group whose name
      // starts with the manifest's mod name (the naming _deployMod produces,
      // or a hand-copied package).
      const strays = [];
      if (locRel === MODS_REL) {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          if (!entry.isFile() || !isSidecar(entry.name)) continue;
          if (owned.has(path.resolve(path.join(dir, entry.name)).toLowerCase())) continue;
          strays.push(entry.name);
        }
      }
      for (const [base, files] of groups) {
        const hasIoStore = files.some((f) => ['.utoc', '.ucas'].includes(path.extname(f).toLowerCase()));
        const name = base.replace(/^pakchunk99-P\d+_/i, '');
        const mine = strays.filter((sc) => {
          const stem = sc.replace(SIDECAR_RE, '').toLowerCase();
          return name.toLowerCase() === stem || name.toLowerCase().startsWith(stem + '_');
        });
        candidates.push({
          id: `${kind}:${base}`,
          kind,
          name,
          modType: kind === 'logicmods-group' ? 'logicmods' : (hasIoStore ? 'iostore' : 'pak'),
          location: locRel,
          files: [...files, ...mine.map((sc) => path.join(locRel, sc))],
          active: true,
        });
      }
    }

    // Game Feature plugin folders in SWZeroCompany\Mods that no managed mod
    // owns — the layout every one of these mods' readmes tells the user to copy
    // by hand, so most users arrive with several already in place.
    const gameModsDir = this.gameAbs(GAME_MODS_REL);
    if (fs.existsSync(gameModsDir)) {
      const managedFolders = new Set(this.store.mods
        .filter((m) => m.modType === 'gfp')
        .map((m) => this.gfpFolderName(m).toLowerCase()));
      for (const dirent of fs.readdirSync(gameModsDir, { withFileTypes: true })) {
        if (!dirent.isDirectory()) continue;
        if (managedFolders.has(dirent.name.toLowerCase())) continue;
        const dir = path.join(gameModsDir, dirent.name);
        let rels;
        try { rels = walkFiles(dir); } catch (_) { continue; }
        // Prefer <folder>.uplugin (what the game looks for); accept any.
        const uplugins = rels.filter((f) => path.extname(f).toLowerCase() === '.uplugin' && !f.includes(path.sep));
        const uplugin = uplugins.find((f) => path.basename(f, path.extname(f)).toLowerCase() === dirent.name.toLowerCase())
          || uplugins[0]
          || rels.find((f) => path.extname(f).toLowerCase() === '.uplugin');
        if (!uplugin) continue;
        const up = readUplugin(path.join(dir, uplugin));
        const mf = readModinfo(dir);
        candidates.push({
          id: `gfp-folder:${dirent.name}`,
          kind: 'gfp-folder',
          name: mf.title || up.friendlyName || dirent.name,
          pluginName: dirent.name,
          modType: 'gfp',
          location: path.join(GAME_MODS_REL, dirent.name),
          files: rels.map((f) => path.join(GAME_MODS_REL, dirent.name, f)),
          // A plugin folder that is present IS mounted by the game — there is
          // no separate on/off switch, so adoption claims it enabled in place.
          active: true,
        });
      }
    }

    // UE4SS mod folders not managed and not built-in.
    const modsDir = this.gameAbs(UE4SS_MODS_REL);
    if (fs.existsSync(modsDir)) {
      const BUILTIN = new Set([
        'shared', 'bpmodloadermod', 'bpml_genericfunctions', 'consolecommandsmod',
        'consoleenablermod', 'splitscreenmod', 'linetracemod', 'actordumpermod',
        'jsbluaprofilermod', 'keybinds',
      ]);
      let modsTxt = '';
      try { modsTxt = fs.readFileSync(path.join(modsDir, 'mods.txt'), 'utf8'); } catch (_) {}
      const managedDirs = new Set(this.store.mods
        .filter((m) => m.modType === 'ue4ss-mod')
        .map((m) => safeName(m.name).toLowerCase()));
      for (const dirent of fs.readdirSync(modsDir, { withFileTypes: true })) {
        if (!dirent.isDirectory()) continue;
        const lower = dirent.name.toLowerCase();
        if (BUILTIN.has(lower) || managedDirs.has(lower)) continue;
        const dir = path.join(modsDir, dirent.name);
        const hasPayload = fs.existsSync(path.join(dir, 'Scripts', 'main.lua')) || fs.existsSync(path.join(dir, 'dlls', 'main.dll'));
        if (!hasPayload) continue;
        const active = fs.existsSync(path.join(dir, 'enabled.txt')) ||
          new RegExp(`^\\s*${dirent.name}\\s*:\\s*1\\s*$`, 'mi').test(modsTxt);
        candidates.push({
          id: `ue4ss-folder:${dirent.name}`,
          kind: 'ue4ss-folder',
          name: dirent.name,
          modType: 'ue4ss-mod',
          location: path.join(UE4SS_MODS_REL, dirent.name),
          files: walkFiles(dir).map((f) => path.join(UE4SS_MODS_REL, dirent.name, f)),
          active,
        });
      }
    }
    return candidates;
  }

  // Bring an unmanaged candidate under management: library gets the canonical
  // copy; the already-deployed game files are claimed in place (nothing moves,
  // so the game setup is untouched mid-adoption).
  adopt(candidate) {
    const id = newId();
    const libDir = this.store.modLibraryDir(id);
    fs.mkdirSync(libDir, { recursive: true });
    const files = [];
    for (const rel of candidate.files) {
      const src = this.gameAbs(rel);
      let libraryRelative;
      if (candidate.kind === 'ue4ss-folder') {
        libraryRelative = path.relative(path.join(UE4SS_MODS_REL, candidate.name), rel);
      } else if (candidate.kind === 'gfp-folder') {
        // Plugin folders keep their inner tree (Content/Paks/…, Config/…).
        libraryRelative = path.relative(path.join(GAME_MODS_REL, candidate.pluginName), rel);
      } else {
        libraryRelative = path.basename(rel);
      }
      const dst = path.join(libDir, libraryRelative);
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.copyFileSync(src, dst);
      files.push({ libraryRelative, size: fs.statSync(dst).size, sha256: sha256File(dst) });
    }
    const ordered = ['pak', 'iostore'].includes(candidate.modType);
    const isGfp = candidate.kind === 'gfp-folder';
    // A plugin folder's own metadata (modinfo.json / .uplugin) is already in the
    // library copy — read the version and author out of it while adopting.
    const gfpMeta = isGfp ? (() => {
      const meta = readModinfo(libDir);
      const upRel = files.map((f) => f.libraryRelative)
        .find((f) => path.extname(f).toLowerCase() === '.uplugin');
      const up = upRel ? readUplugin(path.join(libDir, upRel)) : {};
      return {
        version: meta.version || up.version || null,
        author: meta.author || up.author || null,
        description: meta.description || up.description || null,
      };
    })() : {};
    const mod = {
      id,
      // A plugin's display name may carry spaces — the deployed folder is named
      // from the .uplugin, so the display name needs no filesystem sanitizing.
      name: isGfp ? candidate.name : safeName(candidate.name),
      version: gfpMeta.version || null,
      author: gfpMeta.author || null,
      description: gfpMeta.description || null,
      eaCompatible: null,
      launchers: null,
      zcsdk: zcsdkMeta(files.map((f) => f.libraryRelative), null),
      modType: candidate.modType,
      pluginName: isGfp ? candidate.pluginName : null,
      enabled: candidate.active,
      installedAt: new Date().toISOString(),
      installedBuild: this.currentBuildId(),
      loadPriority: ordered ? this.store.nextLoadPriority(['pak', 'iostore']) : null,
      ue4ssPriority: candidate.modType === 'ue4ss-mod' ? this._nextUe4ssPriority() : null,
      sourceArchive: null,
      files,
      packages: this._listPackages(libDir, files),
      warnings: [],
      deployed: candidate.active ? [...candidate.files] : [],
      origin: { type: 'local', adopted: true },
      updateInfo: null,
    };
    // An inactive UE4SS folder is tidied away (the library now holds the copy);
    // enabling later redeploys it.
    if (!candidate.active && candidate.kind === 'ue4ss-folder') {
      try { fs.rmSync(this.gameAbs(path.join(UE4SS_MODS_REL, candidate.name)), { recursive: true, force: true }); } catch (_) {}
    }
    this.store.addMod(mod);
    return this.store.getMod(id);
  }

  // ------------------------------------------------- import from mod managers
  // Three sources beyond the game's deploy folders:
  //  1. Orphaned entries in OUR OWN library — data/library/<id> folders no mod
  //     record references (a lost or reset manager-data.json leaves these).
  //  2. A full Mod Command data folder somewhere else (old install, backup):
  //     restores mods with names, versions, origins, enabled states, priority
  //     order, squad profiles, and the version vault.
  //  3. Another manager's library folder: every classifiable subfolder is
  //     installed as its own mod.

  scanOrphanLibraries() {
    const known = new Set(this.store.mods.map((m) => m.id));
    const orphans = [];
    try {
      for (const dirent of fs.readdirSync(this.store.libraryDir, { withFileTypes: true })) {
        if (!dirent.isDirectory() || known.has(dirent.name)) continue;
        const abs = path.join(this.store.libraryDir, dirent.name);
        try {
          const info = classifyFolder(abs, dirent.name);
          if (!info.modType || info.modType === 'ue4ss-runtime') continue;
          orphans.push({
            id: `orphan:${dirent.name}`,
            dirName: dirent.name,
            name: info.name,
            modType: info.modType,
            fileCount: info.payload.length,
          });
        } catch (_) {}
      }
    } catch (_) {}
    return orphans;
  }

  async adoptOrphan(dirName) {
    if (!/^[0-9a-f]+$/i.test(dirName)) throw new Error('Not a library entry.');
    const abs = path.join(this.store.libraryDir, dirName);
    if (!fs.existsSync(abs)) throw new Error('That library entry is gone.');
    const res = await this.install(abs, { skipFomod: true });
    const mod = res.multi ? res.mods[0] : res;
    fs.rmSync(abs, { recursive: true, force: true }); // superseded by the fresh copy
    return this.store.getMod(mod.id);
  }

  // Full restore from another Mod Command data folder (detected by its
  // manager-data.json). Skips mods already installed (same modType+name).
  // opts.pruneImported removes each source library folder after a successful
  // import (used when restoring an archive in place, so no orphans linger).
  // opts.keepGameFiles (the automatic restore) never overwrites game files that
  // differ from a mod's library copy; such mods are listed in results.kept.
  async restoreFromData(dataDir, opts = {}) {
    const raw = JSON.parse(fs.readFileSync(path.join(dataDir, 'manager-data.json'), 'utf8'));
    const results = { imported: [], skipped: [], errors: [], kept: [], profiles: 0, vault: 0 };
    const oldMods = Array.isArray(raw.mods) ? raw.mods : [];
    // Keep relative pak order: import in old loadPriority order (then ue4ss order).
    const sorted = [...oldMods].sort((a, b) =>
      ((a.loadPriority != null ? a.loadPriority : 9e9) - (b.loadPriority != null ? b.loadPriority : 9e9))
      || ((a.ue4ssPriority != null ? a.ue4ssPriority : 9e9) - (b.ue4ssPriority != null ? b.ue4ssPriority : 9e9)));
    const existingKeys = new Set(this.store.mods.map((m) => this._vaultKey(m)));
    for (const om of sorted) {
      const key = `${om.modType}-${safeName(om.name || '').toLowerCase()}`;
      if (existingKeys.has(key)) { results.skipped.push(om.name); continue; }
      const src = path.join(dataDir, 'library', om.id);
      if (!fs.existsSync(src)) { results.errors.push(`${om.name}: library folder missing in the old data`); continue; }
      try {
        const res = await this.install(src, {
          skipFomod: true,
          origin: om.origin && om.origin.type !== 'local' ? om.origin : undefined,
          version: om.version || undefined,
          metaOverride: { title: om.name },
          keepGameFiles: opts.keepGameFiles,
        });
        const mod = res.multi ? res.mods[0] : res;
        if (mod.keptGameFiles) results.kept.push(om.name);
        const stored = this.store.getMod(mod.id);
        if (om.origin) stored.origin = { ...om.origin };
        if (typeof om.eaCompatible === 'boolean') stored.eaCompatible = om.eaCompatible;
        if (om.launchers) stored.launchers = om.launchers;
        if (om.installedBuild) stored.installedBuild = om.installedBuild;
        if (!om.enabled) this.setEnabled(mod.id, false, true);
        existingKeys.add(key);
        results.imported.push(om.name);
        if (opts.pruneImported) {
          try { fs.rmSync(src, { recursive: true, force: true }); } catch (_) {}
        }
      } catch (err) {
        results.errors.push(`${om.name}: ${err.message}`);
      }
    }
    // Profiles carry over (vault keys let them resolve the re-imported mods).
    for (const p of Array.isArray(raw.profiles) ? raw.profiles : []) {
      if (this.store.profiles.some((x) => x.name.toLowerCase() === (p.name || '').toLowerCase())) continue;
      this.store.data.profiles.push({ ...p, id: newId() });
      results.profiles += 1;
    }
    // Version vault entries that don't exist here yet.
    const vsrc = path.join(dataDir, 'versions');
    try {
      for (const keyDir of fs.readdirSync(vsrc, { withFileTypes: true })) {
        if (!keyDir.isDirectory()) continue;
        for (const entry of fs.readdirSync(path.join(vsrc, keyDir.name), { withFileTypes: true })) {
          if (!entry.isDirectory()) continue;
          const dst = path.join(this.store.modVaultDir(keyDir.name), entry.name);
          if (fs.existsSync(dst)) continue;
          fs.cpSync(path.join(vsrc, keyDir.name, entry.name), dst, { recursive: true });
          results.vault += 1;
        }
      }
    } catch (_) { /* no vault in the old data */ }
    this.store.save();
    return results;
  }

  // Import from another manager's library: every classifiable subfolder of the
  // given root becomes its own mod (skipping ones already installed).
  async importForeignLibrary(rootDir) {
    let root = rootDir;
    // The picked folder may be the manager's data dir — descend into its
    // library/mods subfolder when one exists.
    for (const sub of ['library', 'mods', 'Mods']) {
      const cand = path.join(rootDir, sub);
      try {
        if (fs.statSync(cand).isDirectory()) { root = cand; break; }
      } catch (_) {}
    }
    const results = { imported: [], skipped: [], errors: [], importedIds: [] };
    const existingKeys = new Set(this.store.mods.map((m) => this._vaultKey(m)));
    for (const dirent of fs.readdirSync(root, { withFileTypes: true })) {
      if (!dirent.isDirectory()) continue;
      const abs = path.join(root, dirent.name);
      let info;
      try { info = classifyFolder(abs, safeName(dirent.name)); } catch (_) { continue; }
      if (!info.modType || info.modType === 'ue4ss-runtime') continue;
      const key = `${info.modType}-${safeName(info.name).toLowerCase()}`;
      if (existingKeys.has(key)) { results.skipped.push(info.name); continue; }
      try {
        const res = await this.install(abs, { skipFomod: true });
        for (const mod of (res.multi ? res.mods : [res])) {
          if (!mod.id) continue;
          existingKeys.add(this._vaultKey(this.store.getMod(mod.id)));
          results.imported.push(mod.name);
          results.importedIds.push(mod.id);
        }
      } catch (err) {
        results.errors.push(`${info.name}: ${err.message}`);
      }
    }
    return results;
  }

  // Attach an update source to a mod after the fact (manual link or md5 match).
  setOrigin(id, origin) {
    const mod = this.store.getMod(id);
    if (!mod) throw new Error('That mod is no longer installed.');
    mod.origin = origin;
    mod.updateInfo = null;
    this.store.save();
    return mod;
  }

  // ------------------------------------------------------------- UE4SS hook scan

  // Static scan of UE4SS Lua mods for hook registrations that can collide:
  //  - RegisterHook / RegisterCustomEvent on the same UFunction path
  //    (callbacks stack, but mods that alter params/return values fight)
  //  - RegisterKeyBind on the same key (+modifiers) — both fire on one press
  // Covers manager-installed mods AND unmanaged folders in the game's ue4ss/Mods.
  scanUe4ssHooks() {
    const empty = { entries: [], conflicts: [] };
    if (!this.gamePath()) return empty;
    const BUILTIN = new Set([
      'shared', 'bpmodloadermod', 'bpml_genericfunctions', 'consolecommandsmod',
      'consoleenablermod', 'splitscreenmod', 'linetracemod', 'actordumpermod',
      'jsbluaprofilermod', 'keybinds',
    ]);
    const entries = [];

    // Manager-installed UE4SS mods (enabled only) — scan their canonical library copies.
    const managedDirNames = new Set();
    for (const mod of this.store.mods) {
      if (mod.modType !== 'ue4ss-mod') continue;
      managedDirNames.add(safeName(mod.name).toLowerCase());
      if (!mod.enabled) continue;
      const found = this._scanLuaDir(this.store.modLibraryDir(mod.id));
      entries.push({ name: mod.name, modId: mod.id, managed: true, ...found });
    }

    // Unmanaged mods living directly in the game's ue4ss/Mods folder.
    const modsDir = this.gameAbs(UE4SS_MODS_REL);
    if (fs.existsSync(modsDir)) {
      let modsTxt = '';
      try { modsTxt = fs.readFileSync(path.join(modsDir, 'mods.txt'), 'utf8'); } catch (_) {}
      for (const dirent of fs.readdirSync(modsDir, { withFileTypes: true })) {
        if (!dirent.isDirectory()) continue;
        const lower = dirent.name.toLowerCase();
        if (BUILTIN.has(lower) || managedDirNames.has(lower)) continue;
        const dir = path.join(modsDir, dirent.name);
        const viaEnabledTxt = fs.existsSync(path.join(dir, 'enabled.txt'));
        const viaModsTxt = new RegExp(`^\\s*${dirent.name}\\s*:\\s*1\\s*$`, 'mi').test(modsTxt);
        if (!viaEnabledTxt && !viaModsTxt) continue; // inactive
        const found = this._scanLuaDir(dir);
        entries.push({ name: dirent.name, modId: null, managed: false, ...found });
      }
    }

    // Collide hooks and keybinds across entries.
    const conflicts = [];
    const collide = (kind, pick) => {
      const map = new Map();
      for (const e of entries) {
        for (const item of pick(e)) {
          const key = item.toLowerCase();
          if (!map.has(key)) map.set(key, { display: item, entries: new Set() });
          map.get(key).entries.add(e);
        }
      }
      for (const { display, entries: who } of map.values()) {
        if (who.size < 2) continue;
        conflicts.push({
          kind,
          key: display,
          members: [...who].map((e) => ({ name: e.name, modId: e.modId, managed: e.managed })),
        });
      }
    };
    collide('hook', (e) => e.hooks);
    collide('keybind', (e) => e.keybinds);
    return { entries, conflicts };
  }

  _scanLuaDir(root) {
    const hooks = [];
    const keybinds = [];
    let luaFiles = 0;
    let files = [];
    try { files = walkFiles(root); } catch (_) {}
    for (const rel of files) {
      if (path.extname(rel).toLowerCase() !== '.lua') continue;
      luaFiles += 1;
      let src = '';
      try { src = fs.readFileSync(path.join(root, rel), 'utf8'); } catch (_) { continue; }
      // Strip Lua comments so documented examples don't count.
      src = src.replace(/--\[\[[\s\S]*?\]\]/g, '').replace(/--[^\n]*/g, '');
      for (const re of [/RegisterHook\s*\(\s*["']([^"']+)["']/g, /RegisterCustomEvent\s*\(\s*["']([^"']+)["']/g]) {
        let m;
        while ((m = re.exec(src)) !== null) hooks.push(m[1]);
      }
      const keyRe = /RegisterKeyBind\s*\(\s*Key\.([A-Z0-9_]+)\s*(?:,\s*\{([^}]*)\})?/g;
      let km;
      while ((km = keyRe.exec(src)) !== null) {
        const mods = (km[2] || '').match(/ModifierKey\.([A-Z_]+)/g) || [];
        const combo = [...mods.map((x) => x.replace('ModifierKey.', '')), km[1]].join('+');
        keybinds.push(combo);
      }
    }
    return { hooks: [...new Set(hooks)], keybinds: [...new Set(keybinds)], luaFiles };
  }

  // Identity keys for a UE4SS mod folder: its modinfo.json title (survives across
  // versions) AND a hash of its entry script/dll (catches identical copies even
  // without a manifest). Two folders sharing EITHER key are the same mod.
  _modIdentityKeys(dir) {
    const keys = [];
    try {
      const mf = path.join(dir, 'modinfo.json');
      if (fs.existsSync(mf)) {
        const j = JSON.parse(fs.readFileSync(mf, 'utf8'));
        if (j && typeof j.title === 'string' && j.title.trim()) keys.push('title:' + j.title.trim().toLowerCase());
      }
    } catch (_) {}
    for (const rel of ['Scripts/main.lua', 'dlls/main.dll']) {
      const f = path.join(dir, rel.split('/').join(path.sep));
      if (fs.existsSync(f)) {
        try { keys.push('hash:' + crypto.createHash('sha1').update(fs.readFileSync(f)).digest('hex')); } catch (_) {}
        break;
      }
    }
    return keys;
  }

  // Detect the SAME UE4SS mod active under more than one folder in ue4ss/Mods
  // (e.g. a manager-installed copy plus a leftover from a manual / one-click
  // install under a different folder name). Two active copies load and run at
  // once — double hooks/loops — and cause frame stutter. Folders are grouped by
  // shared identity key (title or identical script), so a copy with a manifest
  // and one without still match if their scripts are identical.
  // Returns [{ members: [{ folder, managed, modId, name }] }].
  scanDuplicateMods() {
    if (!this.gamePath()) return [];
    const modsDir = this.gameAbs(UE4SS_MODS_REL);
    if (!fs.existsSync(modsDir)) return [];
    const BUILTIN = new Set([
      'shared', 'bpmodloadermod', 'bpml_genericfunctions', 'consolecommandsmod',
      'consoleenablermod', 'splitscreenmod', 'linetracemod', 'actordumpermod',
      'jsbluaprofilermod', 'keybinds',
    ]);
    let modsTxt = '';
    try { modsTxt = fs.readFileSync(path.join(modsDir, 'mods.txt'), 'utf8'); } catch (_) {}
    const managedByDir = new Map();
    for (const mod of this.store.mods) {
      if (mod.modType === 'ue4ss-mod') managedByDir.set(safeName(mod.name).toLowerCase(), mod);
    }

    const nodes = [];
    for (const dirent of fs.readdirSync(modsDir, { withFileTypes: true })) {
      if (!dirent.isDirectory()) continue;
      const lower = dirent.name.toLowerCase();
      if (BUILTIN.has(lower)) continue;
      const dir = path.join(modsDir, dirent.name);
      const active = fs.existsSync(path.join(dir, 'enabled.txt')) ||
        new RegExp(`^\\s*${dirent.name}\\s*:\\s*1\\s*$`, 'mi').test(modsTxt);
      if (!active) continue;
      const keys = this._modIdentityKeys(dir);
      if (!keys.length) continue;
      const mod = managedByDir.get(lower);
      nodes.push({ folder: dirent.name, managed: !!mod, modId: mod ? mod.id : null, name: mod ? mod.name : dirent.name, keys });
    }

    // Union-find: merge nodes that share any identity key.
    const parent = nodes.map((_, i) => i);
    const find = (x) => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
    const keyToNode = new Map();
    nodes.forEach((n, i) => {
      for (const k of n.keys) {
        if (keyToNode.has(k)) parent[find(i)] = find(keyToNode.get(k));
        else keyToNode.set(k, i);
      }
    });
    const comps = new Map();
    nodes.forEach((n, i) => { const r = find(i); if (!comps.has(r)) comps.set(r, []); comps.get(r).push(n); });

    const dups = [];
    for (const members of comps.values()) {
      if (members.length > 1) {
        dups.push({ members: members.map((m) => ({ folder: m.folder, managed: m.managed, modId: m.modId, name: m.name })) });
      }
    }
    return dups;
  }

  // ------------------------------------------------------------- status

  // Pairwise incompatibility report between ENABLED mods.
  // Returns [{ aId, bId, winnerId, packageCount, fileCount, samples: [asset paths],
  //            certainty: 'confirmed'|'suspected' }]
  // 'confirmed' = overlapping asset paths proven via retoc; 'suspected' = matching
  // deploy filenames or unscanned containers that may overlap.
  conflicts(hookReport) {
    const enabled = this.store.mods.filter((m) => m.enabled);
    const pairs = new Map(); // "aId|bId" -> pair record

    const pairOf = (a, b) => {
      const [x, y] = a.id < b.id ? [a, b] : [b, a];
      const key = `${x.id}|${y.id}`;
      if (!pairs.has(key)) {
        pairs.set(key, { aId: x.id, bId: y.id, packageCount: 0, fileCount: 0, hookCount: 0, samples: [], sampleSet: new Set(), certainty: 'suspected' });
      }
      return pairs.get(key);
    };

    // 1. Confirmed: overlapping asset paths (retoc-scanned IoStore containers).
    const byPackage = new Map();
    for (const m of enabled) {
      for (const p of m.packages || []) {
        if (!byPackage.has(p)) byPackage.set(p, []);
        byPackage.get(p).push(m);
      }
    }
    for (const [assetPath, mods] of byPackage) {
      if (mods.length < 2) continue;
      for (let i = 0; i < mods.length; i++) {
        for (let j = i + 1; j < mods.length; j++) {
          const pair = pairOf(mods[i], mods[j]);
          pair.packageCount += 1;
          pair.certainty = 'confirmed';
          if (pair.samples.length < 8 && !pair.sampleSet.has(assetPath)) {
            pair.sampleSet.add(assetPath);
            pair.samples.push(assetPath);
          }
        }
      }
    }

    // 2. Suspected: same original container/file basenames (legacy paks, unscanned
    //    containers, LogicMods paks with equal names). UE4SS mods deploy into their
    //    own folders (every one ships Scripts/main.lua), so filename collisions are
    //    meaningless for them — their real conflicts are hooks, handled below.
    //    Game Feature plugins are the same: every one deploys into its own
    //    SWZeroCompany\Mods folder and they all ship an AssetRegistry.bin, so a
    //    shared basename proves nothing. Their real overlaps are asset paths,
    //    which retoc reads out of their .utoc above.
    const byFile = new Map();
    for (const m of enabled) {
      if (m.modType === 'ue4ss-mod' || m.modType === 'gfp') continue;
      for (const f of m.files || []) {
        // Game-folder mods conflict on the exact game path they replace, not on
        // a shared basename — two different-folder files never collide.
        const key = m.modType === 'gamefolder'
          ? `gamefolder:${f.libraryRelative.toLowerCase()}`
          : `${m.modType}:${path.basename(f.libraryRelative).toLowerCase()}`;
        if (!byFile.has(key)) byFile.set(key, []);
        byFile.get(key).push(m);
      }
    }
    for (const [key, mods] of byFile) {
      const unique = [...new Set(mods)];
      if (unique.length < 2) continue;
      for (let i = 0; i < unique.length; i++) {
        for (let j = i + 1; j < unique.length; j++) {
          const pair = pairOf(unique[i], unique[j]);
          pair.fileCount += 1;
          const label = key.startsWith('gamefolder:')
            ? `both replace: ${key.split(':')[1]}`
            : `same file name: ${key.split(':')[1]}`;
          if (pair.samples.length < 8 && !pair.sampleSet.has(label)) {
            pair.sampleSet.add(label);
            pair.samples.push(label);
          }
        }
      }
    }

    // 3. UE4SS hook/keybind collisions between two manager-installed mods.
    for (const c of (hookReport ? hookReport.conflicts : [])) {
      const managed = c.members.filter((m) => m.modId).map((m) => this.store.getMod(m.modId)).filter(Boolean);
      for (let i = 0; i < managed.length; i++) {
        for (let j = i + 1; j < managed.length; j++) {
          const pair = pairOf(managed[i], managed[j]);
          pair.hookCount += 1;
          const label = c.kind === 'keybind' ? `UE4SS keybind: ${c.key}` : `UE4SS hook: ${c.key}`;
          if (pair.samples.length < 8 && !pair.sampleSet.has(label)) {
            pair.sampleSet.add(label);
            pair.samples.push(label);
          }
        }
      }
    }

    // Winner = the mod that deploys later (higher load priority), else newest install.
    const out = [];
    for (const pair of pairs.values()) {
      const a = this.store.getMod(pair.aId);
      const b = this.store.getMod(pair.bId);
      let winner;
      if (a.loadPriority != null && b.loadPriority != null) {
        winner = b.loadPriority > a.loadPriority ? b : a;
      } else {
        winner = (b.installedAt || '') > (a.installedAt || '') ? b : a;
      }
      delete pair.sampleSet;
      out.push({ ...pair, winnerId: winner.id, memberIds: [pair.aId, pair.bId] });
    }
    // Confirmed conflicts first, then by overlap size.
    out.sort((x, y) =>
      (x.certainty === y.certainty
        ? (y.packageCount + y.fileCount + y.hookCount) - (x.packageCount + x.fileCount + x.hookCount)
        : x.certainty === 'confirmed' ? -1 : 1));
    return out;
  }

  ue4ssStatus() {
    if (!this.gamePath()) return { installed: false, healthy: false, message: 'Game not located.' };
    const win64 = this.gameAbs(WIN64_REL);
    const dwmapi = fs.existsSync(path.join(win64, 'dwmapi.dll'));
    const dll = fs.existsSync(path.join(win64, 'ue4ss', 'UE4SS.dll'));
    const modsDir = fs.existsSync(path.join(win64, 'ue4ss', 'Mods'));
    const installed = dwmapi || dll;
    const healthy = dwmapi && dll && modsDir;
    let message = 'Not installed (only needed for Lua/DLL mods).';
    if (installed && !healthy) message = 'Incomplete layout: dwmapi.dll, ue4ss/UE4SS.dll, or ue4ss/Mods is missing.';
    if (healthy) message = 'Runtime present and healthy.';
    return { installed, healthy, message };
  }

  // ZCSDK Runtime = the two UE4SS mods (ZCSDKBridge + ZCSDKLoader) that content
  // mods built with the Zero Company Mod SDK need: at play time they load each
  // mod's asset registry and grant its items. Reports presence, activity,
  // versions, whether a newer package is available (the newest GitHub release
  // per lib/zcsdk.js, else the bundled copy), and which mods need it.
  zcsdkStatus() {
    const zcsdk = require('./zcsdk');
    const bundled = zcsdk.bundledRuntime();
    const bundledInfo = bundled ? { version: bundled.version, bridge: bundled.bridge, loader: bundled.loader } : null;
    // The package an install would use right now.
    const pkg = zcsdk.availableRuntime();
    const available = pkg ? { version: pkg.version, bridge: pkg.bridge, loader: pkg.loader, source: pkg.source } : null;
    const neededBy = this.store.mods
      .filter((m) => m.zcsdk)
      .map((m) => ({ id: m.id, name: m.name, enabled: !!m.enabled }));
    const base = { installed: false, healthy: false, active: false, updateAvailable: false, parts: {}, signatures: null, neededBy, bundled: bundledInfo, available };
    if (!this.gamePath()) return { ...base, message: 'Game not located.' };
    const modsDir = this.gameAbs(UE4SS_MODS_REL);
    let modsTxt = '';
    try { modsTxt = fs.readFileSync(path.join(modsDir, 'mods.txt'), 'utf8'); } catch (_) {}
    const parts = {};
    const markers = { ZCSDKBridge: path.join('dlls', 'main.dll'), ZCSDKLoader: path.join('Scripts', 'main.lua') };
    for (const name of zcsdk.PARTS) {
      const dir = path.join(modsDir, name);
      const present = fs.existsSync(path.join(dir, markers[name]));
      const active = present && (fs.existsSync(path.join(dir, 'enabled.txt')) ||
        new RegExp(`^\\s*${name}\\s*:\\s*1\\s*$`, 'mi').test(modsTxt));
      let version = null;
      try {
        const mf = JSON.parse(fs.readFileSync(path.join(dir, 'modinfo.json'), 'utf8'));
        if (mf && typeof mf.version === 'string') version = mf.version.trim().slice(0, 40) || null;
      } catch (_) {}
      const managed = this.store.mods.find((m) => m.modType === 'ue4ss-mod' && safeName(m.name).toLowerCase() === name.toLowerCase()) || null;
      parts[name] = { present, active, version, managedId: managed ? managed.id : null };
    }
    const bridge = parts.ZCSDKBridge;
    const loader = parts.ZCSDKLoader;
    const installed = bridge.present && loader.present;
    const active = installed && bridge.active && loader.active;
    const ue4ss = this.ue4ssStatus();
    const healthy = active && ue4ss.healthy;
    // A newer part in the available package, or an on-disk copy without
    // version info (a hand-deployed dev copy) → offer a refresh.
    const behind = (have, want) => !have || (!!want && zcsdk.compareRuntimeVersions(want, have) > 0);
    // UE4SS signature files the runtime installer put in ue4ss\UE4SS_Signatures
    // (v0.10+). A runtime installed before this app learned to place them (or
    // by hand) has no record — a package that ships them is then an update.
    const sigRec = this._zcsdkSignaturesRecord();
    const sigDir = this.gameAbs(ZCSDK_SIGS_REL);
    const sigFiles = sigRec.files.map((f) => ({ name: f.name, present: isFile(path.join(sigDir, f.name)) }));
    const signatures = { version: sigRec.version || null, files: sigFiles, installed: sigFiles.filter((f) => f.present).length };
    const sigsExpected = !!pkg && zcsdk.compareRuntimeVersions(pkg.version, ZCSDK_SIGS_SINCE) >= 0;
    const sigsMissing = installed && ((sigsExpected && !sigFiles.length) || sigFiles.some((f) => !f.present));
    const updateAvailable = installed && !!pkg && (behind(bridge.version, pkg.bridge) || behind(loader.version, pkg.loader) || sigsMissing);
    const need = neededBy.length;
    let message;
    if (!installed) {
      message = need
        ? `Not installed — ${need} installed mod${need === 1 ? '' : 's'} need${need === 1 ? 's' : ''} it: ${neededBy.map((n) => n.name).join(', ')}.`
        : 'Not installed (only needed for content mods built with the Zero Company Mod SDK).';
      if (bridge.present !== loader.present) message = `Incomplete: only ${bridge.present ? 'ZCSDKBridge' : 'ZCSDKLoader'} is present — reinstall the runtime.`;
    } else if (!ue4ss.healthy) {
      message = 'Present, but UE4SS is missing or incomplete — the runtime cannot start.';
    } else if (!active) {
      message = `Present but not active — ${[!bridge.active && 'ZCSDKBridge', !loader.active && 'ZCSDKLoader'].filter(Boolean).join(' and ')} disabled in UE4SS.`;
    } else {
      const ver = (p) => (p.version ? `v${p.version}` : 'unversioned copy');
      message = `Runtime present and active (ZCSDKBridge ${ver(bridge)}, ZCSDKLoader ${ver(loader)}).`;
      if (sigFiles.length && !sigsMissing) message += ` UE4SS signatures: ${signatures.installed} in ue4ss\\UE4SS_Signatures.`;
      if (sigsMissing) {
        message += sigFiles.length
          ? ` ${sigFiles.length - signatures.installed} of ${sigFiles.length} UE4SS signature files are missing from ue4ss\\UE4SS_Signatures — reinstall the runtime.`
          : ' Its UE4SS signature files are not installed — update the runtime to add them.';
      }
      if (updateAvailable) message += ` Version ${pkg.version || '?'} available${pkg.source === 'github' ? ' from GitHub' : ' (bundled)'}.`;
    }
    return { ...base, installed, active, healthy, updateAvailable, parts, signatures, message };
  }

  // Install (or refresh) the ZCSDK Runtime from a zip holding its two UE4SS mod
  // folders. Existing managed copies — including adopted dev copies whose
  // on-disk files drifted from the library — are vaulted and replaced by name,
  // so no duplicate folders appear; UE4SS start-order slots are kept. A
  // UE4SS_Signatures\ folder in the package (v0.10+; see findZcsdkSigDir)
  // goes to Win64\ue4ss\UE4SS_Signatures\ (see ZCSDK_SIGS_REL); a package
  // without one leaves the signature files already placed as they are.
  async installZcsdkRuntime(zipPath, version) {
    if (!this.gamePath()) throw new Error('Set the game folder first (Settings).');
    if (!this.ue4ssStatus().installed) throw new Error('Install UE4SS first — the ZCSDK Runtime is a pair of UE4SS mods.');
    const zcsdk = require('./zcsdk');
    // install() takes only the two mod folders out of the package; stage it
    // once more for its signature files (before anything is replaced, so an
    // unreadable package changes nothing).
    const sigStage = path.join(this.store.stagingDir, `zcsdk-sigs-${newId()}`);
    try {
      await extractArchive(zipPath, sigStage, this.store.settings.sevenZipPath);
      const sigSrc = findZcsdkSigDir(sigStage);
      const sigDirOurs = this._zcsdkSignaturesRecord().createdDir;
      const names = new Set(zcsdk.PARTS.map((n) => n.toLowerCase()));
      const existing = this.store.mods.filter((m) => m.modType === 'ue4ss-mod' && names.has(safeName(m.name).toLowerCase()));
      const keep = new Map(existing.map((m) => [safeName(m.name).toLowerCase(), m.ue4ssPriority]));
      for (const m of existing) this._snapshotVersion(m);
      // force: a dev copy on disk may differ from the library. The signature
      // files stay while the parts are swapped (_installZcsdkSignatures below
      // decides what happens to them); only a failed install drops them.
      for (const m of existing) this.uninstall(m.id, true, { keepZcsdkSigs: true });
      let mods;
      try {
        const res = await this.install(zipPath, {
          skipFomod: true, version: version || undefined,
          origin: { type: 'local', bundled: 'zcsdk-runtime' },
        });
        mods = (res.multi ? res.mods : [res]).filter((m) => m && m.id);
        const got = new Set(mods.map((m) => safeName(m.name).toLowerCase()));
        if (!zcsdk.PARTS.every((n) => got.has(n.toLowerCase()))) {
          throw new Error(`The runtime package did not contain both ${zcsdk.PARTS.join(' and ')}.`);
        }
      } catch (e) {
        if (!this.store.mods.some((m) => this._isZcsdkPart(m))) this._removeZcsdkSignatures();
        throw e;
      }
      for (const installed of mods) {
        const prio = keep.get(safeName(installed.name).toLowerCase());
        if (prio != null) this.store.getMod(installed.id).ue4ssPriority = prio;
      }
      this.store.save();
      this._syncUe4ssModsTxt();
      const signatures = this._installZcsdkSignatures(sigSrc, version, sigDirOurs);
      return { mods: mods.map((m) => this.store.getMod(m.id)), replaced: existing.length, signatures, status: this.zcsdkStatus() };
    } finally {
      fs.rmSync(sigStage, { recursive: true, force: true });
    }
  }

  // Is this library entry a part of the ZCSDK Runtime?
  _isZcsdkPart(mod) {
    if (!mod || mod.modType !== 'ue4ss-mod') return false;
    if (mod.origin && mod.origin.bundled === 'zcsdk-runtime') return true;
    const names = require('./zcsdk').PARTS.map((n) => n.toLowerCase());
    return names.includes(safeName(mod.name).toLowerCase());
  }

  // <data>\zcsdk-signatures.json → { version, createdDir, files: [{ name, sha256, backup }] }
  // (files: [] when there is no record). Names are plain *.lua file names only.
  _zcsdkSignaturesRecord() {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(this.store.dataDir, ZCSDK_SIGS_RECORD), 'utf8'));
      const files = (j && Array.isArray(j.files) ? j.files : []).filter((f) => f
        && typeof f.name === 'string' && /\.lua$/i.test(f.name) && path.basename(f.name) === f.name && !/[\\/]/.test(f.name)
        && typeof f.sha256 === 'string');
      return { version: (j && typeof j.version === 'string') ? j.version : null, createdDir: !!(j && j.createdDir), files };
    } catch (_) { return { version: null, createdDir: false, files: [] }; }
  }

  _writeZcsdkSignaturesRecord(rec) {
    const abs = path.join(this.store.dataDir, ZCSDK_SIGS_RECORD);
    if (!rec || !rec.files.length) { fs.rmSync(abs, { force: true }); return; }
    fs.writeFileSync(abs, JSON.stringify({ ...rec, savedAt: new Date().toISOString() }, null, 2));
  }

  // Delete the given recorded files where they still hold what the installer
  // wrote, and put back the copy that was there before when one was kept.
  // A file changed since the install is left alone (so is its kept copy).
  _dropZcsdkSignatureFiles(files) {
    const dir = this.gameAbs(ZCSDK_SIGS_REL);
    const bak = path.join(this.store.dataDir, ZCSDK_SIGS_BACKUP);
    let removed = 0;
    for (const f of files) {
      const abs = path.join(dir, f.name);
      let ours = false;
      try { ours = isFile(abs) && sha256File(abs) === f.sha256; } catch (_) {}
      if (ours) { fs.rmSync(abs, { force: true }); removed += 1; }
      const saved = path.join(bak, f.name);
      if (f.backup && isFile(saved) && !fs.existsSync(abs)) {
        fs.mkdirSync(dir, { recursive: true });
        fs.copyFileSync(saved, abs);
        fs.rmSync(saved, { force: true });
      }
    }
    try { if (!fs.readdirSync(bak).length) fs.rmSync(bak, { recursive: true, force: true }); } catch (_) {}
    return removed;
  }

  // A signatures folder the installer created goes again once it is empty.
  _tidyZcsdkSigDir(createdDir) {
    if (!createdDir) return;
    const dir = this.gameAbs(ZCSDK_SIGS_REL);
    try { if (!fs.readdirSync(dir).length) fs.rmdirSync(dir); } catch (_) {}
  }

  // The recorded ZCSDK signature entry for `rel` (relative to Win64) when the
  // file there is still the one the runtime installer wrote; else null.
  _zcsdkOwnedSig(rel) {
    const sigPrefix = path.join('ue4ss', 'UE4SS_Signatures').toLowerCase() + path.sep;
    const l = String(rel).split(/[\\/]+/).join(path.sep).toLowerCase();
    if (!l.startsWith(sigPrefix) || l.slice(sigPrefix.length).includes(path.sep) || !this.gamePath()) return null;
    const rec = this._zcsdkSignaturesRecord();
    const f = rec.files.find((x) => x.name.toLowerCase() === l.slice(sigPrefix.length));
    if (!f) return null;
    try {
      const abs = path.join(this.gameAbs(ZCSDK_SIGS_REL), f.name);
      return isFile(abs) && sha256File(abs) === f.sha256 ? { rec, f } : null;
    } catch (_) { return null; }
  }

  // Names of the signature files in ue4ss\UE4SS_Signatures that are the ZCSDK
  // Runtime's (placed by its installer, unchanged since) — they say nothing
  // about which UE4SS build is installed.
  zcsdkSignatureNames() {
    if (!this.gamePath()) return [];
    return this._zcsdkSignaturesRecord().files
      .filter((f) => this._zcsdkOwnedSig(path.join('ue4ss', 'UE4SS_Signatures', f.name)))
      .map((f) => f.name);
  }

  // A UE4SS package (or a kept build being restored) brings a file of the
  // same name as a signature the ZCSDK Runtime placed and still owns: the
  // runtime's copy stays, and the incoming one is kept as the copy put back
  // when the runtime is removed (a kept copy the Mod SDK generated — the
  // user's own — is never replaced). Returns true when it took the file.
  _zcsdkShadowSig(rel, srcAbs) {
    const own = this._zcsdkOwnedSig(rel);
    if (!own) return false;
    const bak = path.join(this.store.dataDir, ZCSDK_SIGS_BACKUP);
    const kept = path.join(bak, own.f.name);
    if (!(own.f.backup && isFile(kept) && this._ue4ssSdkGenerated(rel, kept))) {
      fs.mkdirSync(bak, { recursive: true });
      fs.copyFileSync(srcAbs, kept);
      own.f.backup = true;
      this._writeZcsdkSignaturesRecord(own.rec);
    }
    return true;
  }

  // A UE4SS update retires `rel`: a copy held for the ZCSDK Runtime from the
  // old package is dropped too (never one the Mod SDK generated).
  _zcsdkDropShadow(rel) {
    const own = this._zcsdkOwnedSig(rel);
    if (!own || !own.f.backup) return;
    const kept = path.join(this.store.dataDir, ZCSDK_SIGS_BACKUP, own.f.name);
    if (isFile(kept) && this._ue4ssSdkGenerated(rel, kept)) return;
    fs.rmSync(kept, { force: true });
    own.f.backup = false;
    this._writeZcsdkSignaturesRecord(own.rec);
  }

  // Remove every signature file the runtime installer put in place (runtime
  // uninstalled). Never touches files it did not write.
  _removeZcsdkSignatures() {
    if (!this.gamePath()) return 0;
    const rec = this._zcsdkSignaturesRecord();
    if (!rec.files.length) return 0;
    let removed = 0;
    try {
      removed = this._dropZcsdkSignatureFiles(rec.files);
      this._tidyZcsdkSigDir(rec.createdDir);
      this._writeZcsdkSignaturesRecord(null);
    } catch (e) { log('warn', `ZCSDK Runtime: could not remove its UE4SS signature files: ${e.message}`); }
    return removed;
  }

  // Copy <srcDir>\*.lua (the package's UE4SS_Signatures folder, or null when
  // the package has none) into Win64\ue4ss\UE4SS_Signatures and record them.
  // Files the previous runtime installed that this package no longer ships
  // are removed; a same-name file that is not the installer's own is kept in
  // the backup folder first. A package with no signature files at all
  // leaves the ones already placed, and their record, untouched: without
  // them UE4SS's scans fail on the current game build and no Lua mod runs.
  // Returns the installed file names.
  _installZcsdkSignatures(srcDir, version, createdDirHint) {
    const rec = this._zcsdkSignaturesRecord();
    if (createdDirHint) rec.createdDir = true;
    let names = [];
    if (srcDir) {
      try {
        names = fs.readdirSync(srcDir, { withFileTypes: true })
          .filter((e) => e.isFile() && /\.lua$/i.test(e.name)).map((e) => e.name).sort();
      } catch (_) {}
    }
    if (!names.length) {
      if (rec.files.length) log('info', `ZCSDK Runtime: the package ships no UE4SS signature files; keeping the ${rec.files.length} already in ue4ss\\UE4SS_Signatures.`);
      return [];
    }
    const incoming = new Set(names.map((n) => n.toLowerCase()));
    this._dropZcsdkSignatureFiles(rec.files.filter((f) => !incoming.has(f.name.toLowerCase())));
    const dir = this.gameAbs(ZCSDK_SIGS_REL);
    const createdDir = rec.createdDir || !fs.existsSync(dir);
    fs.mkdirSync(dir, { recursive: true });
    const bak = path.join(this.store.dataDir, ZCSDK_SIGS_BACKUP);
    const prev = new Map(rec.files.map((f) => [f.name.toLowerCase(), f]));
    const files = [];
    for (const name of names) {
      const dst = path.join(dir, name);
      const before = prev.get(name.toLowerCase());
      let backup = !!(before && before.backup);
      if (isFile(dst) && !(before && sha256File(dst) === before.sha256)) {
        // Not the copy this installer wrote: keep it to put back later.
        fs.mkdirSync(bak, { recursive: true });
        fs.copyFileSync(dst, path.join(bak, name));
        backup = true;
      }
      fs.copyFileSync(path.join(srcDir, name), dst);
      files.push({ name, sha256: sha256File(dst), backup });
    }
    this._writeZcsdkSignaturesRecord({ version: version || null, createdDir, installedAt: new Date().toISOString(), files });
    return files.map((f) => f.name);
  }

  // ---------------------------------------------------------------- UE4SS runtime vault
  // Every runtime install, update or switch snapshots the current runtime
  // first — the allow-listed runtime files only (UE4SS_CORE_FILES, the
  // UE4SS_CORE_DIRS folders, and what the last package shipped per
  // <data>\ue4ss-shipped-files.json), never ue4ss\Mods, logs, dumps, .jmap
  // files or the Mod SDK's files — so the previous build (whatever its
  // origin) can be put back from ⧗ Versions, e.g. to match a game kept on an
  // older build.

  // What the last package installed by this app shipped outside ue4ss\Mods
  // (relative to Win64), or null when there is no record.
  _ue4ssShippedFiles() {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(this.store.dataDir, UE4SS_SHIPPED_FILES), 'utf8'));
      const list = Array.isArray(j) ? j : (j && Array.isArray(j.files) ? j.files : null);
      if (!list) return null;
      const modsPrefix = path.join('ue4ss', 'Mods').toLowerCase() + path.sep;
      return list.map((p) => String(p).split(/[\\/]+/).join(path.sep))
        .filter((rel) => rel && !path.isAbsolute(rel) && !rel.split(path.sep).includes('..') && !rel.toLowerCase().startsWith(modsPrefix));
    } catch (_) { return null; }
  }

  _writeUe4ssShippedFiles(list) {
    const abs = path.join(this.store.dataDir, UE4SS_SHIPPED_FILES);
    try {
      if (!list) { fs.rmSync(abs, { force: true }); return; }
      const seen = new Set();
      const files = list.filter((rel) => { const l = rel.toLowerCase(); if (seen.has(l)) return false; seen.add(l); return true; });
      fs.writeFileSync(abs, JSON.stringify({ files, savedAt: new Date().toISOString() }, null, 2));
    } catch (_) {}
  }

  // Is this UE4SS_Signatures file one the Mod SDK generated? (rel to Win64)
  _ue4ssSdkGenerated(rel, abs) {
    const sigPrefix = path.join('ue4ss', 'UE4SS_Signatures').toLowerCase() + path.sep;
    if (!rel.toLowerCase().startsWith(sigPrefix)) return false;
    let fd = null;
    try {
      fd = fs.openSync(abs || path.join(this.gameAbs(WIN64_REL), rel), 'r');
      const buf = Buffer.alloc(1024);
      const n = fs.readSync(fd, buf, 0, buf.length, 0);
      return SDK_GENERATED_RE.test(buf.toString('utf8', 0, n));
    } catch (_) { return false; } finally { if (fd != null) try { fs.closeSync(fd); } catch (_) {} }
  }

  // Is `rel` (relative to Win64) a runtime file by the allow-list, or one the
  // given shipped list names? ue4ss\Mods never is.
  _ue4ssAllowed(rel, shipped) {
    const l = rel.toLowerCase();
    if (l.startsWith(path.join('ue4ss', 'Mods').toLowerCase() + path.sep)) return false;
    if (rel.split(/[\\/]+/).includes('..') || path.isAbsolute(rel)) return false;
    if (UE4SS_CORE_FILES.some((f) => f.toLowerCase() === l)) return true;
    if (UE4SS_CORE_DIRS.some((d) => l.startsWith(d.toLowerCase() + path.sep))) return true;
    return !!(shipped && shipped.some((f) => f.toLowerCase() === l));
  }

  // The runtime files present now (relative to Win64). SDK-generated
  // signatures are never runtime.
  _ue4ssRuntimeFiles() {
    const win64 = this.gameAbs(WIN64_REL);
    const seen = new Map();
    const add = (rel) => { if (!seen.has(rel.toLowerCase())) seen.set(rel.toLowerCase(), rel); };
    for (const rel of UE4SS_CORE_FILES) if (isFile(path.join(win64, rel))) add(rel);
    for (const dir of UE4SS_CORE_DIRS) {
      const abs = path.join(win64, dir);
      if (!fs.existsSync(abs)) continue;
      try { for (const f of walkFiles(abs)) add(path.join(dir, f)); } catch (_) {}
    }
    const shipped = this._ue4ssShippedFiles();
    for (const rel of shipped || []) if (this._ue4ssAllowed(rel, shipped) && isFile(path.join(win64, rel))) add(rel);
    return [...seen.values()].filter((rel) => !this._ue4ssSdkGenerated(rel));
  }

  // Snapshot the installed runtime under versions/ue4ss-runtime/<stamp>__<label>.
  // meta = { tag, name, asset, publishedAt } when known. Best-effort; keeps 5
  // (opts.keep: an entry id that must survive the pruning — the one being
  // restored). opts.foreign: extra files (not runtime) that are about to be
  // overwritten, kept so a restore can put them back.
  ue4ssSnapshot(label, meta, opts = {}) {
    try {
      const foreign = (opts.foreign || []).filter((rel) => isFile(path.join(this.gameAbs(WIN64_REL), rel)));
      if (!this.gamePath() || (!this.ue4ssStatus().installed && !foreign.length)) return null;
      const runtime = this.ue4ssStatus().installed ? this._ue4ssRuntimeFiles() : [];
      if (!runtime.length && !foreign.length) return null;
      const win64 = this.gameAbs(WIN64_REL);
      const vaultDir = this.store.modVaultDir(UE4SS_VAULT_KEY);
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const entryId = `${stamp}__${safeName(label || 'unknown-build')}`;
      const entryDir = path.join(vaultDir, entryId);
      const filesDir = path.join(entryDir, 'files');
      fs.mkdirSync(filesDir, { recursive: true });
      for (const rel of [...runtime, ...foreign]) {
        const dst = path.join(filesDir, rel);
        fs.mkdirSync(path.dirname(dst), { recursive: true });
        fs.copyFileSync(path.join(win64, rel), dst);
      }
      // A signature of this build held while the ZCSDK Runtime's copy is in
      // place (_zcsdkShadowSig) belongs to the build being kept.
      let held = 0;
      if (runtime.length) {
        for (const f of this._zcsdkSignaturesRecord().files) {
          const rel = path.join('ue4ss', 'UE4SS_Signatures', f.name);
          const kept = path.join(this.store.dataDir, ZCSDK_SIGS_BACKUP, f.name);
          if (!f.backup || !isFile(kept) || this._ue4ssSdkGenerated(rel, kept) || !this._zcsdkOwnedSig(rel)) continue;
          const dst = path.join(filesDir, rel);
          if (fs.existsSync(dst)) continue;
          fs.mkdirSync(path.dirname(dst), { recursive: true });
          fs.copyFileSync(kept, dst);
          held += 1;
        }
      }
      // What the build being kept was installed with: its shipped-files list
      // and shipped settings, so a restore brings the records back with it.
      const shipped = this._ue4ssShippedFiles();
      try { fs.copyFileSync(path.join(this.store.dataDir, UE4SS_SHIPPED_SETTINGS), path.join(entryDir, 'shipped-settings.ini')); } catch (_) {}
      fs.writeFileSync(path.join(entryDir, 'vault.json'), JSON.stringify({
        label: label || 'unknown build', tag: (meta && meta.tag) || null, name: (meta && meta.name) || null,
        asset: (meta && meta.asset) || null, publishedAt: (meta && meta.publishedAt) || null,
        source: (meta && meta.source) || null, fileId: (meta && meta.fileId) || null, version: (meta && meta.version) || null,
        dllMd5: (meta && meta.dllMd5) || null, testedBuild: (meta && meta.testedBuild) || null,
        files: runtime.length + foreign.length + held, shipped: shipped || null, foreign,
        rule: 'allow-list', savedAt: new Date().toISOString(),
      }, null, 2));
      this._ue4ssLastSnapshot = { entryId, at: Date.now() };
      const keep = opts.keep ? safeName(opts.keep) : null;
      const entries = fs.readdirSync(vaultDir).filter((e) => e !== keep).sort().reverse();
      for (const stale of entries.slice(keep ? 4 : 5)) fs.rmSync(path.join(vaultDir, stale), { recursive: true, force: true });
      return entryId;
    } catch (_) { return null; }
  }

  // Keep files a package install is about to overwrite that are not runtime
  // (an SDK-generated signature of the same name): into the snapshot the
  // caller took moments ago, or a new one. Returns false if they could not be kept.
  _ue4ssKeepForeign(rels) {
    const win64 = this.gameAbs(WIN64_REL);
    const vaultDir = this.store.modVaultDir(UE4SS_VAULT_KEY);
    const last = this._ue4ssLastSnapshot;
    if (last && Date.now() - last.at < 15 * 60 * 1000) {
      try {
        const entryDir = path.join(vaultDir, last.entryId);
        const mf = path.join(entryDir, 'vault.json');
        const m = JSON.parse(fs.readFileSync(mf, 'utf8'));
        for (const rel of rels) {
          const dst = path.join(entryDir, 'files', rel);
          fs.mkdirSync(path.dirname(dst), { recursive: true });
          fs.copyFileSync(path.join(win64, rel), dst);
        }
        const had = new Set((m.foreign || []).map((r) => r.toLowerCase()));
        m.foreign = [...(m.foreign || []), ...rels.filter((r) => !had.has(r.toLowerCase()))];
        m.files = walkFiles(path.join(entryDir, 'files')).length;
        fs.writeFileSync(mf, JSON.stringify(m, null, 2));
        return true;
      } catch (_) { /* fall through to a fresh snapshot */ }
    }
    return !!this.ue4ssSnapshot('before UE4SS install', null, { foreign: rels });
  }

  ue4ssListVault() {
    const vaultDir = this.store.modVaultDir(UE4SS_VAULT_KEY);
    const entries = [];
    try {
      for (const entryId of fs.readdirSync(vaultDir).sort().reverse()) {
        try {
          const m = JSON.parse(fs.readFileSync(path.join(vaultDir, entryId, 'vault.json'), 'utf8'));
          entries.push({ entryId, label: m.label, tag: m.tag, name: m.name, asset: m.asset, publishedAt: m.publishedAt, savedAt: m.savedAt, files: m.files, source: m.source || null, fileId: m.fileId || null, version: m.version || null });
        } catch (_) {}
      }
    } catch (_) {}
    return entries;
  }

  // Put a kept build back. The current runtime is snapshotted first, so the
  // swap is itself reversible. Mods and their start order are untouched.
  // Only runtime files are removed (the current shipped list / allow-list,
  // never SDK-generated signatures) and only runtime files are written back:
  // a snapshot taken by an older build of this app may hold the whole ue4ss\
  // folder (dumps, .jmap files, logs, SDK files) — those copies are ignored.
  ue4ssRestore(entryId, currentLabel, currentMeta) {
    if (!this.gamePath()) throw new Error('Set the game folder first (Settings).');
    const vaultDir = this.store.modVaultDir(UE4SS_VAULT_KEY);
    const entryDir = path.join(vaultDir, safeName(entryId));
    const manifest = JSON.parse(fs.readFileSync(path.join(entryDir, 'vault.json'), 'utf8'));
    const filesDir = path.join(entryDir, 'files');
    const keptShipped = Array.isArray(manifest.shipped) ? manifest.shipped.map((p) => String(p).split(/[\\/]+/).join(path.sep)) : null;
    const keptForeign = new Set((manifest.foreign || []).map((p) => String(p).split(/[\\/]+/).join(path.sep).toLowerCase()));
    const files = walkFiles(filesDir).filter((rel) => this._ue4ssAllowed(rel, keptShipped) || keptForeign.has(rel.toLowerCase()));
    if (!files.some((rel) => rel.toLowerCase() === path.join('ue4ss', 'UE4SS.dll').toLowerCase())) throw new Error('That kept build has no UE4SS.dll — nothing to restore.');
    const win64 = this.gameAbs(WIN64_REL);
    if (!fs.existsSync(win64)) throw new Error('Game Win64 folder not found.');
    // An SDK-generated signature (kept because a package overwrote it, or
    // carried in an old whole-folder snapshot) only fills a gap — the SDK's
    // current file is never replaced by an older copy.
    const gapOnly = (rel) => keptForeign.has(rel.toLowerCase()) || this._ue4ssSdkGenerated(rel, path.join(filesDir, rel));
    // Files the restore will overwrite that are not runtime now (the SDK's
    // signature where the kept build has one of the same name) go into the
    // snapshot of the current state too.
    const runtimeList = this._ue4ssRuntimeFiles();
    const runtimeNow = new Set(runtimeList.map((r) => r.toLowerCase()));
    const foreign = files.filter((rel) => !gapOnly(rel) && !runtimeNow.has(rel.toLowerCase()) && isFile(path.join(win64, rel)) && !this._zcsdkOwnedSig(rel));
    const kept = this.ue4ssSnapshot(currentLabel, currentMeta, { keep: entryId, foreign });
    if (foreign.length && !kept) throw new Error(`Could not keep a copy of ${foreign.length} file(s) the restore would overwrite — nothing was changed.`);
    if (!fs.existsSync(path.join(entryDir, 'vault.json'))) throw new Error('That kept build is no longer in the vault.');
    for (const rel of runtimeList) { try { fs.rmSync(path.join(win64, rel), { force: true }); } catch (_) {} }
    for (const rel of files) {
      const src = path.join(filesDir, rel);
      const dst = path.join(win64, rel);
      if (gapOnly(rel) && fs.existsSync(dst)) continue;
      if (this._zcsdkShadowSig(rel, src)) continue;
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.copyFileSync(src, dst);
    }
    fs.mkdirSync(path.join(win64, 'ue4ss', 'Mods'), { recursive: true });
    // The records follow the build that is back.
    this._writeUe4ssShippedFiles(keptShipped);
    const shippedSettings = path.join(this.store.dataDir, UE4SS_SHIPPED_SETTINGS);
    try {
      if (fs.existsSync(path.join(entryDir, 'shipped-settings.ini'))) fs.copyFileSync(path.join(entryDir, 'shipped-settings.ini'), shippedSettings);
      else fs.rmSync(shippedSettings, { force: true });
    } catch (_) {}
    return manifest;
  }

  retocStatus() {
    const p = this.retocPath();
    if (!p) return { found: false, path: null, version: null };
    let version = null;
    try {
      version = execFileSync(p, ['--version'], { encoding: 'utf8', timeout: 10000 }).trim();
    } catch (_) {}
    return { found: true, path: p, version };
  }

  auditDeployedFiles() {
    // Verify every enabled mod's deployed files still exist.
    const missing = [];
    for (const m of this.store.mods.filter((x) => x.enabled)) {
      for (const rel of m.deployed || []) {
        if (!fs.existsSync(this.gameAbs(rel))) missing.push({ modId: m.id, modName: m.name, file: rel });
      }
    }
    return missing;
  }
}

module.exports = { ModEngine, classifyFolder, zcsdkMeta, isSidecar, compareVersions, mergeModsTxt, mergeUe4ssSettings, MODS_REL, LOGIC_MODS_REL, WIN64_REL, UE4SS_MODS_REL, GAME_MODS_REL };

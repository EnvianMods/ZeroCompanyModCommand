'use strict';
// Mod engine: classification, install, deploy, load order, conflicts, UE4SS.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { extractArchive } = require('./archive');
const { log } = require('./log');

// The game-running check could not finish (lib/steam.js gameRunningState
// 'unknown'): changes are refused as if the game were running.
const GAME_UNKNOWN_MESSAGE = 'Couldn’t confirm Star Wars Zero Company is closed — close it and try again.';

const PAKS_REL = path.join('SWZeroCompany', 'Content', 'Paks');
const MODS_REL = path.join(PAKS_REL, '~mods');
const LOGIC_MODS_REL = path.join(PAKS_REL, 'LogicMods');
const WIN64_REL = path.join('SWZeroCompany', 'Binaries', 'Win64');
const UE4SS_MODS_REL = path.join(WIN64_REL, 'ue4ss', 'Mods');
// Game Feature plugin mods live as WHOLE FOLDERS here — the game's own loader
// mounts every SWZeroCompany\Mods\<Mod>\ at startup and appends the folder's
// root AssetRegistry.bin itself. No renaming, no load-order prefix, no runtime.
const GAME_MODS_REL = path.join('SWZeroCompany', 'Mods');
// ZC Unlocked (a UE4SS mod) loads "add-ons" from ue4ss\Mods\ZCUnlocked\addons\<Folder>\:
// an addon.ini ([addon] name=/enabled=/version=) plus, optionally, its own
// 050_ZCA_<Key>_P.pak/.utoc/.ucas, which ZC Unlocked mounts itself. It keys an
// add-on by its FOLDER NAME (players' saved picks reference it), so that name
// never changes; enabled=0/1 in addon.ini is the on/off switch.
const ZCU_FOLDER = 'ZCUnlocked';
const ZCU_REL = path.join(UE4SS_MODS_REL, ZCU_FOLDER);
const ZCU_ADDONS_REL = path.join(ZCU_REL, 'addons');
const ZCU_MISSING = 'Needs ZC Unlocked — install it first. This add-on is kept in the library and is deployed to ue4ss\\Mods\\ZCUnlocked\\addons once ZC Unlocked is in the game.';

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

// UE4SS's own mod folders (shipped with the runtime) — never offered for
// adoption, never counted as duplicates.
const UE4SS_BUILTIN = new Set([
  'shared', 'bpmodloadermod', 'bpml_genericfunctions', 'consolecommandsmod',
  'consoleenablermod', 'splitscreenmod', 'linetracemod', 'actordumpermod',
  'jsbluaprofilermod', 'keybinds',
]);

// The ZCSDK Runtime's parts (lib/zcsdk.js PARTS) — ue4ss\Mods folder names.
// They are a protected dependency: only installZcsdkRuntime() installs,
// replaces or updates them, and while any installed mod needs the runtime
// they cannot be switched off, removed, rolled back or absorbed by an
// adoption (see the ZCSDK Runtime section of ModEngine).
const ZCSDK_PART_SET = new Set(require('./zcsdk').PARTS.map((n) => n.toLowerCase()));
const isZcsdkPartName = (n) => !!n && ZCSDK_PART_SET.has(safeName(n).toLowerCase());

// A mod record that is (a copy of) a ZCSDK Runtime part: a UE4SS mod the
// runtime installer placed (origin.bundled === 'zcsdk-runtime') or one whose
// deploy folder (ue4ssFolder; records without one deploy under their name) /
// shipped title is ZCSDKBridge or ZCSDKLoader.
function isZcsdkRuntimeRecord(rec) {
  if (!rec || rec.modType !== 'ue4ss-mod') return false;
  if (rec.origin && rec.origin.bundled === 'zcsdk-runtime') return true;
  return isZcsdkPartName(rec.ue4ssFolder) || isZcsdkPartName(rec.name) || isZcsdkPartName(rec.metaTitle);
}

// A classified incoming folder that is a ZCSDK Runtime part (by its own
// folder name in the archive, its name or its shipped title).
function isZcsdkRuntimeInfo(info, metaOverride) {
  if (!info || info.modType !== 'ue4ss-mod') return false;
  return isZcsdkPartName(info.folder) || isZcsdkPartName(info.name) || isZcsdkPartName(info.meta && info.meta.title)
    || isZcsdkPartName(metaOverride && metaOverride.title);
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
    // The mod's OWN folder name in the archive (null when the archive root IS
    // the mod folder). Deploy keeps it whatever the display name says: UE4SS
    // (mods.txt), the mod's own Lua paths, other tools' mods.txt lines and ZC
    // Unlocked's pack detection all know the mod by it.
    folder: baseDir ? ue4ssFolderFromName(path.basename(baseDir)) : null,
    meta,
    payload,
    warnings,
  };
}

// A folder name as it can be created on Windows: kept byte-identical when it
// is usable, else sanitized.
function folderNameOf(name) {
  return usableFolderName(name) ? name : safeName(name);
}

// A UE4SS mod folder name as shipped: kept verbatim when Windows can hold it
// and a mods.txt line can name it (no ':' — refused by usableFolderName — and
// no leading ';', '#' or space, which a mods.txt line cannot start with),
// else sanitized.
function ue4ssFolderFromName(name) {
  const n = String(name || '').trim();
  return usableFolderName(n) && !/^[;#\s]/.test(n) && n.length <= 120 ? n : safeName(n);
}

// ---- ZC Unlocked add-ons ---------------------------------------------------

// Decode an addon.ini buffer so it can be re-encoded byte for byte: UTF-16LE
// with its BOM, anything else as latin1 (1:1 bytes, so UTF-8 and its BOM survive).
function decodeIni(buf) {
  if (buf.length >= 2 && buf[0] === 0xFF && buf[1] === 0xFE) return { text: buf.subarray(2).toString('utf16le'), enc: 'utf16le' };
  return { text: buf.toString('latin1'), enc: 'latin1' };
}
function encodeIni(text, enc) {
  return enc === 'utf16le' ? Buffer.concat([Buffer.from([0xFF, 0xFE]), Buffer.from(text, 'utf16le')]) : Buffer.from(text, 'latin1');
}

// Lines with their line endings kept: [{ body, eol }].
function iniLines(text) {
  const out = [];
  const re = /([^\r\n]*)(\r\n|\n|\r|$)/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    if (m[0] === '' && re.lastIndex >= text.length) break;
    out.push({ body: m[1], eol: m[2] });
    if (!m[2]) break;
  }
  return out;
}
const INI_SECTION_RE = /^\s*\[([^\]]*)\]\s*$/;
const ADDON_ENABLED_RE = /^(\s*enabled\s*=\s*)([^;#]*?)(\s*(?:[;#].*)?)$/i;

// The [addon] section of an addon.ini → { name, version, enabled } (raw
// strings, or null), or null when the file has no [addon] section.
function parseAddonIni(buf) {
  const { text } = decodeIni(buf);
  let section = null;
  let found = false;
  const out = { name: null, version: null, enabled: null };
  for (const { body } of iniLines(text.replace(/^﻿|^ï»¿/, ''))) {
    const s = INI_SECTION_RE.exec(body);
    if (s) { section = s[1].trim().toLowerCase(); if (section === 'addon') found = true; continue; }
    if (section !== 'addon') continue;
    const kv = /^\s*([^;#=\s][^=]*?)\s*=\s*(.*?)\s*$/.exec(body);
    if (!kv) continue;
    const k = kv[1].toLowerCase();
    if (['name', 'version', 'enabled'].includes(k) && out[k] == null) out[k] = kv[2];
  }
  return found ? out : null;
}

function readAddonIni(abs) {
  try { return parseAddonIni(fs.readFileSync(abs)); } catch (_) { return null; }
}

// Set enabled=1/0 in every [addon] section of an addon.ini buffer. Everything
// else stays byte for byte (line endings, encoding, BOM, comments, order);
// a section without the key gets `enabled=X` right after its header.
function setAddonIniEnabled(buf, on) {
  const { text, enc } = decodeIni(buf);
  const lines = iniLines(text);
  const eolOf = (lines.find((l) => l.eol) || {}).eol || '\r\n';
  const val = on ? '1' : '0';
  const out = [];
  let inAddon = false;
  let headerIdx = -1;
  let hadKey = false;
  const closeSection = () => {
    if (inAddon && !hadKey && headerIdx !== -1) {
      const h = out[headerIdx];
      const eol = h.eol || eolOf;
      out.splice(headerIdx + 1, 0, { body: `enabled=${val}`, eol: h.eol ? eol : '' });
      if (!h.eol) h.eol = eol;
    }
  };
  for (const l of lines) {
    const s = INI_SECTION_RE.exec(l.body.replace(/^﻿|^ï»¿/, ''));
    if (s) {
      closeSection();
      inAddon = s[1].trim().toLowerCase() === 'addon';
      hadKey = false;
      out.push({ ...l });
      headerIdx = inAddon ? out.length - 1 : -1;
      continue;
    }
    if (inAddon) {
      const m = ADDON_ENABLED_RE.exec(l.body);
      if (m) { hadKey = true; out.push({ body: `${m[1]}${val}${m[3]}`, eol: l.eol }); continue; }
    }
    out.push({ ...l });
  }
  closeSection();
  return encodeIni(out.map((l) => l.body + l.eol).join(''), enc);
}

// addon.ini with the app-owned enabled= line(s) of its [addon] section taken
// out and trailing line breaks dropped — two copies that differ only in the
// on/off switch normalize to the same text.
function addonIniNormalized(buf) {
  const { text } = decodeIni(buf);
  let inAddon = false;
  const kept = [];
  for (const l of iniLines(text)) {
    const s = INI_SECTION_RE.exec(l.body.replace(/^﻿|^ï»¿/, ''));
    if (s) inAddon = s[1].trim().toLowerCase() === 'addon';
    else if (inAddon && ADDON_ENABLED_RE.test(l.body)) continue;
    kept.push(l.body + l.eol);
  }
  return kept.join('').replace(/[\r\n]+$/, '');
}
function addonIniHash(absOrBuf) {
  const buf = Buffer.isBuffer(absOrBuf) ? absOrBuf : fs.readFileSync(absOrBuf);
  return 'addonini:' + crypto.createHash('sha256').update(addonIniNormalized(buf), 'latin1').digest('hex');
}

// Every ZC Unlocked add-on folder in a file list → dir ('.' for the tree root)
// -> its addon.ini (relative). An add-on folder holds an addon.ini with an
// [addon] section and is NOT itself a UE4SS mod folder (a pack that is a UE4SS
// mod carrying addon.ini installs as that UE4SS mod), nor inside one or inside
// a Game Feature plugin folder (those travel with their mod).
function addonDirs(root, files, ue4ssDirs, upluginDirs) {
  const found = new Map();
  const within = (d, owners) => [...owners].some((o) => o === '.' || d === o || d.startsWith(o + path.sep));
  for (const f of files) {
    if (path.basename(f).toLowerCase() !== 'addon.ini') continue;
    const dir = path.dirname(f);
    if (found.has(dir)) continue;
    if (within(dir, ue4ssDirs.keys()) || within(dir, upluginDirs.keys())) continue;
    if (!readAddonIni(path.join(root, f))) continue;
    found.set(dir, f);
  }
  // A nested add-on folder inside another one belongs to the outer one.
  for (const d of [...found.keys()]) {
    if ([...found.keys()].some((o) => o !== d && (o === '.' || d.startsWith(o + path.sep)))) found.delete(d);
  }
  return found;
}

// Classification record for ONE add-on folder. The WHOLE folder is the
// payload (addon.ini, its paks, anything else) and lands verbatim in
// ue4ss\Mods\ZCUnlocked\addons\<addonFolder>\ — its paks never go to ~mods.
function addonGroup(root, files, dir, iniRel, fallbackName) {
  const baseDir = (!dir || dir === '.') ? '' : dir;
  const payload = files
    .filter((f) => (baseDir ? f.startsWith(baseDir + path.sep) : true))
    .map((f) => ({ sourceRelative: f, deployRelative: baseDir ? path.relative(baseDir, f) : f }));
  const ini = readAddonIni(path.join(root, iniRel)) || {};
  const folder = folderNameOf(baseDir ? path.basename(baseDir) : fallbackName);
  const meta = readModinfo(path.join(root, baseDir));
  delete meta.zcsdkGrants;
  const iniName = ini.name && ini.name.trim() ? ini.name.trim().slice(0, 120) : null;
  if (iniName) meta.title = iniName;
  if (ini.version && ini.version.trim()) meta.version = ini.version.trim().slice(0, 40);
  return {
    modType: 'zcu-addon',
    name: iniName || folder,
    addonFolder: folder,
    folderFromRoot: !baseDir,
    meta,
    payload,
    warnings: [],
  };
}

// ZC Unlocked (addons_mods=1, its default) ALSO loads add-on packs placed
// straight in ue4ss\Mods\<Pack>\ (an addon.ini beside the pack's paks), and
// keys every add-on's menu switch by its folder name with anything outside
// [A-Za-z0-9_] turned into '_' (addon_<Folder>). Two folders with the same
// key, or with the same addon.ini name=, are the same add-on to the player:
// both copies would be mounted and registered.
function addonKeyOf(folder) {
  return String(folder || '').replace(/[^A-Za-z0-9_]/g, '_').toLowerCase();
}
function addonNameKey(name) {
  const n = String(name == null ? '' : name).trim().toLowerCase();
  return n || null;
}
// Is an add-on switched on in its addon.ini (no enabled= line counts as on)?
function addonIniActive(ini) {
  return !!ini && (ini.enabled == null || !/^0\s*([;#].*)?$/.test(String(ini.enabled).trim()));
}
// The duplicate-copy warning an add-on carries while it is left off.
const ADDON_DUP_RE = /— ZC Unlocked would load both\./;

// A bare add-on pack directly in ue4ss\Mods: <dirAbs>\addon.ini with an
// [addon] section, and NOT a UE4SS script/dll mod (no Scripts\main.lua, no
// dlls\main.dll). UE4SS never runs it; only ZC Unlocked loads it. Returns its
// parsed [addon] section, or null.
function bareAddonPackIni(dirAbs) {
  if (isFile(path.join(dirAbs, 'Scripts', 'main.lua')) || isFile(path.join(dirAbs, 'dlls', 'main.dll'))) return null;
  return readAddonIni(path.join(dirAbs, 'addon.ini'));
}

// A library folder's name: the 16-hex id newId() gave the entry. It carries
// nothing about the mod, so it must never become a mod's name.
const LIBRARY_ID_RE = /^[0-9a-f]{16}$/i;
// Layout folders and file stems that say nothing about which mod it is.
const GENERIC_DIRS = new Set(['scripts', 'dlls', 'paks', 'content', 'config', 'binaries', 'win64', 'ue4ss', 'mods', '~mods', 'logicmods', 'swzerocompany', 'engine']);
const GENERIC_STEMS = new Set(['main', 'enabled', 'addon', 'modinfo', 'readme', 'license', 'mods']);

// A readable fallback name for a folder whose own name means nothing — an
// orphaned library copy (<library>\<16-hex id>) holds only the mod's files.
// Real metadata (modinfo title, .uplugin name, addon.ini name=, a UE4SS mod's
// folder) still wins in classifyFolder; this only replaces the folder name:
//  - ZC Unlocked add-on paks 050_ZCA_<Key>_P.*  → <Key>
//  - other paks: the first pak's stem without a load-order prefix (^\d+_)
//    and a trailing _P
//  - else the single top-level folder, else the first file's stem
//  - last resort "Recovered mod"
function libraryFallbackName(root) {
  const usable = (n) => !!n && !LIBRARY_ID_RE.test(n) ? n.trim().slice(0, 120) : null;
  let files = [];
  try { files = walkFiles(root).sort((a, b) => a.localeCompare(b)); } catch (_) {}
  const stemOf = (f) => path.basename(f, path.extname(f));
  const paks = files.filter((f) => PAK_EXTS.has(path.extname(f).toLowerCase()));
  for (const f of paks) {
    const m = /^050_ZCA_(.+)_P$/i.exec(stemOf(f));
    if (m && usable(m[1])) return usable(m[1]);
  }
  if (paks.length) {
    const n = usable(stemOf(paks[0]).replace(/^\d+_/, '').replace(/_P$/i, ''));
    if (n) return n;
  }
  let dirs = [];
  try { dirs = fs.readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory()); } catch (_) {}
  if (dirs.length === 1 && !GENERIC_DIRS.has(dirs[0].name.toLowerCase()) && usable(dirs[0].name)) return usable(dirs[0].name);
  for (const f of files) {
    const stem = stemOf(f);
    if (!GENERIC_STEMS.has(stem.toLowerCase()) && usable(stem)) return usable(stem);
  }
  return 'Recovered mod';
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

  // ZC Unlocked add-on: a folder holding an addon.ini with an [addon] section
  // that is not a UE4SS mod folder (typically …\ZCUnlocked\addons\<Folder>\).
  // Checked BEFORE the pak branches: its 050_ZCA_*_P paks are mounted by ZC
  // Unlocked from the add-on folder and must never be renamed into ~mods.
  const ue4ssDirs = ue4ssModDirs(files);
  const addons = addonDirs(root, files, ue4ssDirs, upluginDirs);
  if (addons.size) {
    const [dir, iniRel] = [...addons.entries()][0];
    const group = addonGroup(root, files, dir, iniRel, fallbackName);
    if (addons.size > 1) group.warnings.push(`${addons.size - 1} other add-on folder(s) in this archive were ignored.`);
    else {
      const skipped = files.length - group.payload.length;
      if (skipped > 0) group.warnings.push(`${skipped} file(s) outside the add-on folder were ignored.`);
    }
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
    // () -> 'running' | 'not-running' | 'unknown' (or a boolean) for Star Wars
    // Zero Company started from this game folder (main.js wires lib/steam.js
    // gameRunningState; null in tests = never running).
    this.gameRunning = null;
    // > 0 while installZcsdkRuntime / removeZcsdkRuntime / an allowed
    // runtime rollback works on the runtime's own parts.
    this._runtimeOp = 0;
  }

  // ------------------------------------------------------------ runtime guard

  isRuntimePart(mod) { return isZcsdkRuntimeRecord(mod); }

  // Installed mods that need the ZCSDK Runtime (they ship a *.zcsdk.lua).
  runtimeDependents() {
    return this.store.mods.filter((m) => m.zcsdk && !isZcsdkRuntimeRecord(m));
  }

  // A runtime part that must stay: SDK mods are installed and this is not
  // the runtime installer/remover itself at work.
  runtimeLocked(mod) {
    return !this._runtimeOp && isZcsdkRuntimeRecord(mod) && this.runtimeDependents().length > 0;
  }

  _refuseRuntime(mod, doing) {
    if (!this.runtimeLocked(mod)) return;
    const deps = this.runtimeDependents();
    const n = deps.length;
    const names = deps.slice(0, 4).map((m) => m.name).join(', ') + (n > 4 ? ', …' : '');
    const err = new Error(`“${mod.name}” is part of the ZCSDK Runtime, which ${n} installed SDK mod${n === 1 ? '' : 's'} `
      + `need${n === 1 ? 's' : ''} (${names}) — it can’t be ${doing} while ${n === 1 ? 'that mod is' : 'they are'} installed. `
      + 'To take the runtime out, use Settings → ZCSDK Runtime → Remove.');
    err.runtimeProtected = true;
    throw err;
  }

  // ------------------------------------------------------------ game guard

  // 'running' | 'not-running' | 'unknown'. this.gameRunning may answer a
  // boolean or one of those states; a check that throws is 'unknown'.
  _gameRunningState() {
    if (!this.gameRunning) return 'not-running';
    let v;
    try { v = this.gameRunning(); } catch (_) { return 'unknown'; }
    if (v === true) return 'running';
    if (v === false || v === null || v === undefined) return 'not-running';
    return ['running', 'not-running', 'unknown'].includes(v) ? v : 'unknown';
  }

  _gameIsRunning() { return this._gameRunningState() !== 'not-running'; }

  // Files of a running game are loaded (UE4SS's dlls and every mounted pak
  // are locked): taking mods out of it or putting them back now fails half
  // way. Refuse before anything is touched — also when it could not be
  // confirmed that the game is closed.
  _assertGameClosed(doing) {
    const st = this._gameRunningState();
    if (st === 'not-running') return;
    if (st === 'unknown') {
      const err = new Error(`${GAME_UNKNOWN_MESSAGE} (${doing} changes files the running game would have loaded.) Nothing was changed.`);
      err.gameRunning = true;
      err.gameUnknown = true;
      throw err;
    }
    const err = new Error(`Close Star Wars Zero Company first — ${doing} changes files the running game has loaded `
      + '(UE4SS mods and paks stay locked until the game exits). Nothing was changed.');
    err.gameRunning = true;
    throw err;
  }

  // The mod's stored copy (its library folder) is gone — deleted by hand or
  // with the archive folder. Nothing can be deployed from it.
  storedCopyMissing(mod) {
    return !!mod && !fs.existsSync(this.store.modLibraryDir(mod.id));
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
      // opts.fallbackName: a readable name for a source whose own name means
      // nothing (an orphaned library copy is named after its storage id).
      const fallbackName = opts.fallbackName || safeName(path.basename(sourcePath).replace(/\.(zip|7z|rar|pak|utoc|ucas)$/i, ''));

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
              // A split archive: per-entry state by name only (never one
              // name, nor one UE4SS / add-on folder, for every entry).
              keepFor: opts.keepFor,
              keep: opts.keep ? { ...opts.keep, name: undefined, folder: undefined, addonRoot: undefined, modType: undefined } : undefined,
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
        ue4ssKeep: opts.ue4ssKeep, addonFolder: opts.addonFolder, addonRoot: opts.addonRoot,
        keep: opts.keep, keepFor: opts.keepFor,
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

    // ZC Unlocked add-on folders: one entry each, their whole subtree (their
    // 050_ZCA_* paks included) belongs to them.
    const addons = addonDirs(root, files, ue4ssDirs, upluginDirs);
    if (addons.has('.')) return null; // whole archive IS one add-on

    // Paks inside a UE4SS mod folder belong to THAT mod (it mounts its own
    // paks\ at startup) and never to a pak group below.
    const inUe4ss = (f) => [...ue4ssDirs.keys()].some((d) => f.startsWith(d + path.sep));
    const inGfp = (f) => [...upluginDirs.keys()].some((d) => f.startsWith(d + path.sep));
    const inAddon = (f) => [...addons.keys()].some((d) => f.startsWith(d + path.sep));
    const pakDirs = new Map();
    for (const f of files) {
      if (!PAK_EXTS.has(path.extname(f).toLowerCase()) || inUe4ss(f) || inGfp(f) || inAddon(f)) continue;
      const dir = path.dirname(f);
      if (!pakDirs.has(dir)) pakDirs.set(dir, []);
      pakDirs.get(dir).push(f);
    }
    if (ue4ssDirs.size + upluginDirs.size + addons.size + pakDirs.size <= 1) return null;
    // ZCSDK sidecars belong to the pak group in their own folder.
    const sidecarsByDir = new Map();
    for (const f of files) {
      const dir = path.dirname(f);
      if (!isSidecar(f) || inUe4ss(f) || inAddon(f) || !pakDirs.has(dir)) continue;
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
    for (const [dir, iniRel] of addons) {
      groups.push(addonGroup(root, files, dir, iniRel, fallbackName));
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
    let info = opts.classified || classifyFolder(root, opts.fallbackName);
    // opts.addonFolder: the add-on folder a restore / rollback must keep (the
    // library copy sits at the root, so the tree carries no folder name).
    // (A UE4SS mod's folder rides in opts.ue4ssKeep, see _installFromFolder.)
    // opts.addonRoot: 'mods' for an add-on adopted in place at ue4ss\Mods\<Pack>.
    if (opts.addonFolder && info.modType === 'zcu-addon') info = { ...info, addonFolder: opts.addonFolder, addonRoot: opts.addonRoot || info.addonRoot };
    if (info.modType && info.modType !== 'ue4ss-runtime') {
      // The ZCSDK Runtime's parts come in through installZcsdkRuntime() only:
      // a stray or older copy (an orphaned archive entry, a dropped folder, a
      // restore from another manager) must never replace or shadow the
      // runtime the installed SDK mods need.
      if (!this._runtimeOp && isZcsdkRuntimeInfo(info, opts.metaOverride)) {
        const label = (opts.metaOverride && opts.metaOverride.title) || (info.meta && info.meta.title) || info.name;
        const err = new Error(`“${label}” is part of the ZCSDK Runtime — it is installed and updated only from `
          + 'Settings → ZCSDK Runtime, never as a regular mod.');
        err.runtimeProtected = true;
        throw err;
      }
      const existing = this._findSameMod(info, opts.metaOverride);
      if (existing) return this._absorbVersion(existing, root, info, opts);
    }
    return this._installFromFolder(root, { ...opts, classified: info });
  }

  // Match an incoming mod to an installed one by modinfo identity: same type,
  // same title (the modinfo title, so a user rename doesn't break it), and the
  // same author when both sides state one. No modinfo title = no match.
  _findSameMod(info, metaOverride) {
    // A ZC Unlocked add-on IS its folder name (ZC Unlocked keys it by that, and
    // saved picks reference it) — the display name in addon.ini may change.
    if (info.modType === 'zcu-addon') {
      const key = String(info.addonFolder || '').toLowerCase();
      if (!key) return null;
      const same = this.store.mods.filter((m) => m.modType === 'zcu-addon' && this.addonFolderName(m).toLowerCase() === key);
      // A restore / rollback of a pack adopted in ue4ss\Mods matches only
      // that pack; anything else prefers the entry in ZCUnlocked\addons and
      // otherwise updates the adopted pack in place.
      if (info.addonRoot === 'mods') return same.find((m) => this._addonRoot(m) === 'mods') || null;
      return same.find((m) => this._addonRoot(m) === 'addons') || same.find((m) => this._addonRoot(m) === 'mods') || null;
    }
    const meta = { ...(info.meta || {}), ...(metaOverride || {}) };
    const title = meta.title && String(meta.title).trim();
    if (!title) return null;
    const norm = (s) => safeName(String(s || '')).toLowerCase();
    const author = meta.author ? norm(meta.author) : '';
    return this.store.mods.find((m) => m.modType === info.modType
      // Runtime parts are never another mod's "other version".
      && (this._runtimeOp || !isZcsdkRuntimeRecord(m))
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
    // place, keeping name, enabled state and load/start-order slots. The new
    // copy goes in straight in that state — a mod that was off is installed
    // off (never deployed and then taken out again). If anything fails, the
    // previous version is put back exactly as it was, from the copy just
    // vaulted.
    if (this._isDeployed(existing)) this._assertGameClosed(`replacing “${existing.name}”`);
    // An add-on that was only waiting for ZC Unlocked was never switched off
    // by the user: it comes back on.
    const keep = { name: existing.name, enabled: existing.enabled || !!existing.needsZcu, loadPriority: existing.loadPriority, ue4ssPriority: existing.ue4ssPriority };
    const previous = existing.version;
    // The new version deploys into the folder the installed one uses (UE4SS
    // start order, Lua paths, ZC Unlocked's keys stay valid) — nothing moves.
    // (An add-on adopted in place at ue4ss\Mods\<Pack> stays there.)
    const swapped = existing.modType === 'zcu-addon' ? { ...info, addonFolder: this.addonFolderName(existing), addonRoot: this._addonRoot(existing) } : info;
    const ue4ssKeep = this._ue4ssKeep(existing);
    const cap = this._captureForReplace(existing);
    const before = new Set(this.store.mods.map((m) => m.id));
    let m;
    let addonDuplicate = null;
    try {
      this.uninstall(existing.id, true, { keepZcsdkSigs: true });
      cap.removed = true;
      const fresh = this._installFromFolder(root, { ...opts, classified: swapped, reuseId: existing.id, keep, keepFor: null, ue4ssKeep });
      m = this.store.getMod(fresh.id);
      addonDuplicate = fresh.addonDuplicate || null;
    } catch (err) {
      this._restoreReplaced([cap], before);
      const e = new Error(`Could not replace “${keep.name}”${previous ? ` v${previous}` : ''}: ${err.message} — `
        + 'the installed version was put back as it was.');
      e.restored = true;
      throw e;
    }
    // Keep the version history attached if the vault key moved (an older
    // record without a shipped title was keyed by its name).
    this._moveVault(this._vaultKey(existing), this._vaultKey(m));
    if (m.modType === 'ue4ss-mod') this._syncUe4ssModsTxt();
    this.store.save();
    return {
      ...this.store.getMod(m.id),
      ...(addonDuplicate ? { addonDuplicate } : {}),
      versionAction: { action: cmp === 0 ? 'reinstalled' : 'updated', version: this.store.getMod(m.id).version, previous },
    };
  }

  // ------------------------------------------- replace transactions (undo)
  // Everything that swaps an installed mod for another copy (a version
  // update, an adoption that matches it, a rollback, an update from its
  // source, a runtime reinstall) captures it first: the library copy goes
  // into the version vault (the "previous version" entry) and the record is
  // cloned. A failure anywhere in the swap puts the record and its files
  // back with _restoreReplaced() — never a half-replaced, disabled entry.
  _captureForReplace(mod) {
    const missing = this.storedCopyMissing(mod);
    const entryId = missing ? null : this._snapshotVersion(mod);
    if (!entryId && !missing) {
      throw new Error(`Could not keep a copy of “${mod.name}” before replacing it — nothing was changed.`);
    }
    return {
      record: JSON.parse(JSON.stringify(mod)),
      key: this._vaultKey(mod),
      entryId,
      removed: false,
    };
  }

  // before = the record ids that existed before the swap started.
  _restoreReplaced(caps, before) {
    const capById = new Map(caps.map((c) => [c.record.id, c]));
    // 1. Take out whatever the failed attempt added (a fresh record, or a
    //    captured id reused after the original was removed).
    for (const m of [...this.store.mods]) {
      const cap = capById.get(m.id);
      const added = cap ? cap.removed : !before.has(m.id);
      if (!added) continue;
      try { this._undeployMod(m, true); } catch (e) { log('warn', `restore: could not take out the new copy of "${m.name}": ${e.message}`); }
      if (!cap) {
        try { fs.rmSync(this.store.modLibraryDir(m.id), { recursive: true, force: true }); } catch (_) {}
        try { fs.rmSync(this.store.modBackupsDir(m.id), { recursive: true, force: true }); } catch (_) {}
      }
      this.store.data.mods = this.store.data.mods.filter((x) => x !== m);
    }
    // 2. Put each captured record back, with its library copy and its files
    //    in the game.
    const put = [];
    for (const cap of caps) {
      if (!cap.removed) {
        // Never taken out (its removal was refused or failed, and
        // _undeployOrRestore already put back anything it had removed): the
        // record and its files are as they were. Only the capture's vault
        // entry goes.
        if (cap.entryId) {
          try { fs.rmSync(path.join(this.store.modVaultDir(cap.key), cap.entryId), { recursive: true, force: true }); } catch (_) {}
        }
        continue;
      }
      const rec = JSON.parse(JSON.stringify(cap.record));
      const libDir = this.store.modLibraryDir(rec.id);
      if (cap.entryId) {
        try {
          fs.rmSync(libDir, { recursive: true, force: true });
          fs.cpSync(path.join(this.store.modVaultDir(cap.key), cap.entryId, 'files'), libDir, { recursive: true });
        } catch (e) { log('error', `restore: could not put back the stored copy of "${rec.name}": ${e.message}`); }
      }
      if (rec.modType === 'gamefolder' && !fs.existsSync(this.store.modBackupsDir(rec.id))) {
        // Its backups went with the removal (the originals are back in the
        // game): the redeploy below takes them again.
        rec.backups = [];
      }
      const idx = this.store.data.mods.findIndex((x) => x.id === rec.id);
      if (idx >= 0) this.store.data.mods[idx] = rec; else this.store.data.mods.push(rec);
      // (A ZC Unlocked add-on that was off was in the game too, enabled=0.)
      if (rec.enabled || (rec.modType === 'zcu-addon' && (rec.deployed || []).length)) {
        try { this._deployMod(rec, { skipIdentical: true }); } catch (e) {
          log('warn', `restore: "${rec.name}" is back, but ${e.message} — missing files are redeployed at the next start`);
        }
      }
      // The version was not replaced after all: drop the "previous version"
      // entry the capture made.
      if (cap.entryId) {
        try { fs.rmSync(path.join(this.store.modVaultDir(cap.key), cap.entryId), { recursive: true, force: true }); } catch (_) {}
      }
      put.push(rec.name);
    }
    this.store.save();
    try { this._syncUe4ssModsTxt(); } catch (_) {}
    if (put.length) log('warn', `a replace failed — put back ${put.join(', ')} as ${put.length === 1 ? 'it was' : 'they were'}`);
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

  // keep / keepFor(name): the state an entry being replaced had — { name,
  // enabled, loadPriority, ue4ssPriority, and for a UE4SS mod / add-on
  // modType + folder (+ ue4ssFolderNoticeDismissed) } — so the new copy is
  // installed in it directly (a mod that was off is never deployed; no
  // rename, reorder or folder move afterwards that would take files out and
  // put them back). ue4ssKeep: the UE4SS folder fields an entry being
  // replaced carries over (see _ue4ssKeep).
  _installFromFolder(root, { fallbackName, sourceArchive, metaOverride, classified, origin, version, reuseId, keepGameFiles, keep, keepFor, ue4ssKeep }) {
    let info = classified || classifyFolder(root, fallbackName);
    if (!info.modType) throw new Error(info.warnings.join(' '));

    if (info.modType === 'ue4ss-runtime') {
      // UE4SS comes from "UE4SS for Star Wars Zero Company" on Nexus only —
      // a runtime zip arriving through the GitHub tab is refused outright.
      if (origin && origin.type === 'github') {
        throw new Error('That GitHub release is a UE4SS runtime. Mod Command installs UE4SS only from “UE4SS for Star Wars Zero Company” on Nexus Mods — Settings → UE4SS.');
      }
      return this._installUe4ssRuntime(root, info);
    }

    // UE4SS mod: the folder it deploys to under ue4ss\Mods. An entry being
    // replaced (update, rollback, restore) keeps the folder it is deployed in
    // (ue4ssKeep — nothing moves); a new one takes the mod's own folder name
    // from the archive. Only an archive whose root IS the mod folder (no name
    // of its own) falls back to the display name, as before.
    const baseName = (metaOverride && metaOverride.title) || info.name;
    const k = { ...((keepFor && keepFor(baseName)) || {}), ...(keep || {}) };
    // The folder the entry being replaced is deployed in (keep.folder, same
    // mod type only) stays.
    const keptFolder = k.folder && (!k.modType || k.modType === info.modType) ? k.folder : null;
    if (keptFolder && info.modType === 'zcu-addon') info = { ...info, addonFolder: keptFolder, addonRoot: k.addonRoot || info.addonRoot };
    const uk = {
      ...(keptFolder && info.modType === 'ue4ss-mod' ? { ue4ssFolder: keptFolder, ue4ssFolderNoticeDismissed: k.ue4ssFolderNoticeDismissed || null } : {}),
      ...(ue4ssKeep || {}),
    };
    let ue4ssFolder = null;
    let ue4ssOwnFolder = null;
    if (info.modType === 'ue4ss-mod') {
      ue4ssOwnFolder = info.folder || uk.ue4ssOwnFolder || null;
      ue4ssFolder = uk.ue4ssFolder || ue4ssOwnFolder || safeName(baseName);
      // Two UE4SS mods can never share a folder: the second would overwrite
      // the first one's files and both would load as one.
      const holder = this.store.mods.find((m) => m.modType === 'ue4ss-mod' && m.id !== reuseId
        && this.ue4ssFolderOf(m).toLowerCase() === ue4ssFolder.toLowerCase());
      if (holder) {
        const err = new Error(`“${baseName}” installs into the UE4SS mod folder “${ue4ssFolder}”, which “${holder.name}” already uses — `
          + 'two UE4SS mods cannot share a folder. If it is another copy or version of that mod, update or remove that one first.');
        err.ue4ssFolderTaken = { folder: ue4ssFolder, holderId: holder.id };
        throw err;
      }
      // Nor take the folder of a ZC Unlocked add-on pack managed in place there.
      const pack = this.store.mods.find((m) => m.modType === 'zcu-addon' && this._addonRoot(m) === 'mods'
        && this.addonFolderName(m).toLowerCase() === ue4ssFolder.toLowerCase());
      if (pack) {
        const err = new Error(`“${baseName}” installs into the UE4SS mod folder “${ue4ssFolder}”, which holds the ZC Unlocked add-on “${pack.name}” — `
          + 'a UE4SS mod and an add-on cannot share a folder. Remove that add-on first.');
        err.ue4ssFolderTaken = { folder: ue4ssFolder, holderId: pack.id };
        throw err;
      }
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
      name: k.name || baseName,
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
      // UE4SS mod: the folder under ue4ss\Mods it deploys to, and the mod's
      // own folder name from its archive (null when unknown). Deploy uses
      // ue4ssFolder, never the display name — a rename is cosmetic. When the
      // two differ (an entry deployed under a folder named after an earlier
      // display name) the row offers to move it back; see useOwnUe4ssFolder.
      ue4ssFolder,
      ue4ssOwnFolder,
      ue4ssFolderNoticeDismissed: info.modType === 'ue4ss-mod' ? (uk.ue4ssFolderNoticeDismissed || null) : null,
      // ZC Unlocked add-on: its folder under ue4ss\Mods\ZCUnlocked\addons — the
      // add-on's key, never changed (see addonFolderName).
      addonFolder: info.modType === 'zcu-addon' ? (info.addonFolder || safeName(info.name)) : undefined,
      // ...and where that folder lives: 'addons' (ue4ss\Mods\ZCUnlocked\addons,
      // where Mod Command deploys add-ons) or 'mods' (ue4ss\Mods\<Pack>, a
      // hand-placed pack adopted in place — it stays there).
      addonRoot: info.modType === 'zcu-addon' ? (info.addonRoot === 'mods' ? 'mods' : 'addons') : undefined,
      enabled: false,
      installedAt: new Date().toISOString(),
      installedBuild: this.currentBuildId(),
      loadPriority: ordered ? (k.loadPriority != null ? k.loadPriority : this.store.nextLoadPriority(['pak', 'iostore'])) : null,
      ue4ssPriority: info.modType === 'ue4ss-mod' ? (k.ue4ssPriority != null ? k.ue4ssPriority : this._nextUe4ssPriority()) : null,
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
    // A mod that was off stays off, never deployed — except a ZC Unlocked
    // add-on: off means in the game with enabled=0 in its addon.ini (ZC
    // Unlocked keeps listing it), so it goes back in switched off.
    const stayOff = k.enabled === false;
    if (stayOff && mod.modType !== 'zcu-addon') return this.store.getMod(id);
    // keepGameFiles (the automatic archive restore): files already in the game
    // where this mod deploys that are not these bytes (a newer build deployed
    // outside Mod Command) stay as they are — the mod is recorded disabled.
    // A game-folder mod is exempt: it replaces game files by design and keeps
    // their originals in its backups.
    if (keepGameFiles && mod.modType !== 'gamefolder') {
      const d = this._targetDrift(mod);
      if (d.changed.length || d.foreign.length) {
        log('warn', `${mod.name}: left disabled — the game already holds different files where it deploys (${this._driftList(d)})`);
        this.store.save();
        return { ...this.store.getMod(id), keptGameFiles: true };
      }
    }
    // An add-on with no ZC Unlocked in the game is kept in the library,
    // disabled and not deployed, until ZC Unlocked is there to load it (one
    // the user had switched off just stays off).
    if (mod.modType === 'zcu-addon' && !this.zcuPresent()) {
      if (stayOff) return this.store.getMod(id);
      mod.warnings = [...(mod.warnings || []), ZCU_MISSING];
      mod.needsZcu = true;
      log('warn', `${mod.name}: ZC Unlocked add-on installed to the library but not deployed — ZC Unlocked is not in the game`);
      this.store.save();
      return { ...this.store.getMod(id), needsZcu: true };
    }
    // Another copy of this add-on is already loaded by ZC Unlocked (a pack the
    // player put in ue4ss\Mods\<Pack>, or another entry): this one goes in
    // switched off (enabled=0), so nothing is loaded twice, with a warning
    // naming the other copy. The other copy is never touched.
    const dup = mod.modType === 'zcu-addon' && !stayOff ? this._activeAddonDuplicate(mod) : null;
    if (stayOff || dup) {
      try {
        this._deployMod(mod, { addonOn: false });
      } catch (err) {
        try { this._undeployMod(mod, true); } catch (_) {}
        mod.deployed = [];
        mod.deployedHashes = {};
        this.store.save();
        throw err;
      }
      if (dup) {
        const message = this._noteAddonDuplicate(mod, dup);
        this.store.save();
        return { ...this.store.getMod(id), addonDuplicate: { ...dup, message } };
      }
      this.store.save();
      return this.store.getMod(id);
    }
    // (_setEnabledCore also deploys the add-ons waiting for ZC Unlocked when
    // this is ZC Unlocked arriving.)
    this._setEnabledCore(id, true);
    return this.store.getMod(id);
  }

  // ---------------------------------------------------- ZC Unlocked add-ons

  // Is ZC Unlocked in the game (UE4SS present and ue4ss\Mods\ZCUnlocked holding
  // its dll or script)? Add-ons are deployed only then.
  zcuPresent() {
    if (!this.gamePath()) return false;
    if (!this.ue4ssStatus().installed) return false;
    const dir = this.gameAbs(ZCU_REL);
    return ['dlls/main.dll', 'Scripts/main.lua', 'main.dll'].some((r) => isFile(path.join(dir, ...r.split('/'))));
  }

  zcuStatus() {
    const addons = this.store.mods.filter((m) => m.modType === 'zcu-addon');
    const waiting = addons.filter((m) => m.needsZcu);
    return {
      present: this.zcuPresent(),
      addons: addons.length,
      // adopted in place as ue4ss\Mods\<Pack>
      packs: addons.filter((m) => this._addonRoot(m) === 'mods').length,
      waiting: waiting.map((m) => ({ id: m.id, name: m.name })),
    };
  }

  // Add-ons installed while ZC Unlocked was missing get deployed and enabled
  // once it is there — never under a running game (startup repair retries
  // after it exits). Returns the names deployed.
  _deployWaitingAddons() {
    if (!this.zcuPresent() || this._gameIsRunning()) return [];
    const done = [];
    for (const m of this.store.mods.filter((x) => x.modType === 'zcu-addon' && x.needsZcu)) {
      try {
        // A copy of it the player put in meanwhile is already loaded: this
        // one goes in switched off (enabled=0) with the duplicate warning.
        const dup = m.enabled ? null : this._activeAddonDuplicate(m);
        if (dup) {
          if ((m.deployed || []).length) this._undeployMod(m, true);
          try { this._deployMod(m, { addonOn: false }); } catch (err) {
            try { this._undeployMod(m, true); } catch (_) {}
            m.deployed = [];
            m.deployedHashes = {};
            throw err;
          }
          this._noteAddonDuplicate(m, dup);
        } else if (!m.enabled) this._setEnabledCore(m.id, true);
        delete m.needsZcu;
        m.warnings = (m.warnings || []).filter((w) => w !== ZCU_MISSING);
        done.push(m.name);
      } catch (e) { log('warn', `${m.name}: could not deploy the add-on: ${e.message}`); }
    }
    if (done.length) this.store.save();
    return done;
  }

  // The folder a UE4SS mod deploys to under ue4ss\Mods: its recorded
  // ue4ssFolder (the mod's own folder name, or the folder an older entry is
  // deployed in), never the display name. A record without one (written
  // before v1.9.20 and not migrated yet) is where the old builds put it.
  // Every caller (deploy, undeploy, mods.txt block, enabled.txt, start order,
  // unmanaged/hook/duplicate scans, ZCSDK parts, the UE4SS runtime's
  // managed-folder guard) goes through here.
  ue4ssFolderOf(mod) {
    if (mod && mod.ue4ssFolder && usableFolderName(mod.ue4ssFolder)) return mod.ue4ssFolder;
    return safeName(mod ? mod.name : 'Mod');
  }

  // The folder a record is deployed in right now, read from its deployed
  // list (null when nothing of it is under ue4ss\Mods).
  _ue4ssDeployedFolder(mod) {
    const prefix = UE4SS_MODS_REL.toLowerCase() + path.sep;
    for (const rel of mod.deployed || []) {
      if (!rel.toLowerCase().startsWith(prefix)) continue;
      const seg = rel.slice(prefix.length).split(path.sep)[0];
      if (seg) return seg;
    }
    return null;
  }

  // What an entry being replaced (update, rollback, reinstall) carries over
  // so its UE4SS folder stays where it is.
  _ue4ssKeep(mod) {
    if (!mod || mod.modType !== 'ue4ss-mod') return {};
    return {
      ue4ssFolder: this.ue4ssFolderOf(mod),
      ue4ssOwnFolder: mod.ue4ssOwnFolder || null,
      ue4ssFolderNoticeDismissed: mod.ue4ssFolderNoticeDismissed || null,
    };
  }

  // Records written before v1.9.20 deployed a UE4SS mod into a folder named
  // after its DISPLAY name (so a rename moved it). Give each one its folder
  // field without moving anything: the folder it is deployed in now (or,
  // when off, the one the old builds would have used). The mod's own folder
  // name is recorded where it is known — the modinfo title it shipped with,
  // the name the old builds deployed it under before any rename — so a
  // record whose folder was renamed shows the "Use original name" notice.
  // Idempotent; returns how many records changed.
  migrateUe4ssFolders() {
    let changed = 0;
    for (const mod of this.store.mods) {
      if (mod.modType !== 'ue4ss-mod' || mod.ue4ssFolder) continue;
      const deployedIn = this._ue4ssDeployedFolder(mod);
      mod.ue4ssFolder = deployedIn || safeName(mod.name);
      if (mod.ue4ssOwnFolder === undefined) {
        mod.ue4ssOwnFolder = this._isZcsdkPart(mod)
          ? mod.ue4ssFolder
          : (mod.metaTitle ? safeName(mod.metaTitle) : null);
      }
      if (mod.ue4ssFolderNoticeDismissed === undefined) mod.ue4ssFolderNoticeDismissed = null;
      changed += 1;
    }
    if (changed) {
      this.store.save();
      log('info', `UE4SS mods: recorded the deploy folder of ${changed} older entr${changed === 1 ? 'y' : 'ies'} (nothing moved)`);
    }
    return changed;
  }

  // { deployedAs, own } when a UE4SS mod is deployed under a folder other
  // than its own folder name and the user has not dismissed it; else null.
  ue4ssFolderNotice(mod) {
    if (!mod || mod.modType !== 'ue4ss-mod' || this._isZcsdkPart(mod)) return null;
    const own = mod.ue4ssOwnFolder;
    if (!own || !usableFolderName(own)) return null;
    const folder = this.ue4ssFolderOf(mod);
    if (folder.toLowerCase() === own.toLowerCase()) return null;
    if (mod.ue4ssFolderNoticeDismissed && mod.ue4ssFolderNoticeDismissed.toLowerCase() === own.toLowerCase()) return null;
    return { deployedAs: folder, own };
  }

  dismissUe4ssFolderNotice(id) {
    const mod = this.store.getMod(id);
    if (!mod) throw new Error('That mod is no longer installed.');
    mod.ue4ssFolderNoticeDismissed = mod.ue4ssOwnFolder || null;
    this.store.save();
    return mod;
  }

  // "Use original name": move a UE4SS mod from the folder it is deployed in
  // to its own folder name — its deployed files, plus anything the mod or the
  // user put in the old folder (saved settings), and its mods.txt line.
  // Refused when the folder is taken, or when deployed files were changed
  // outside the manager (force after the user confirms), and while the game
  // runs (or can't be confirmed closed) when the mod is on. A failure puts
  // everything back where it was.
  useOwnUe4ssFolder(id, force) {
    const mod = this.store.getMod(id);
    if (!mod) throw new Error('That mod is no longer installed.');
    if (mod.modType !== 'ue4ss-mod') throw new Error(`“${mod.name}” is not a UE4SS mod.`);
    if (this._isZcsdkPart(mod)) throw new Error(`“${mod.name}” is part of the ZCSDK Runtime — its folder name is fixed.`);
    const own = mod.ue4ssOwnFolder;
    const from = this.ue4ssFolderOf(mod);
    if (!own || !usableFolderName(own)) throw new Error(`The original folder name of “${mod.name}” is not known.`);
    if (own === from) return mod;
    if (mod.enabled) this._assertGameClosed(`moving “${mod.name}” to its own folder`);
    const holder = this.store.mods.find((m) => m !== mod && m.modType === 'ue4ss-mod'
      && this.ue4ssFolderOf(m).toLowerCase() === own.toLowerCase());
    if (holder) throw new Error(`The folder “${own}” is already used by “${holder.name}” — two UE4SS mods cannot share a folder. Nothing was changed.`);
    const caseOnly = own.toLowerCase() === from.toLowerCase();
    const toAbs = this.gameAbs(path.join(UE4SS_MODS_REL, own));
    if (!caseOnly && fs.existsSync(toAbs)) {
      let left = [];
      try { left = walkFiles(toAbs); } catch (_) {}
      if (left.length) {
        throw new Error(`ue4ss\\Mods\\${own} already exists and holds ${left.length} file(s) that are not “${mod.name}”'s — `
          + 'move or remove that folder first. Nothing was changed.');
      }
    }
    const fromAbs = this.gameAbs(path.join(UE4SS_MODS_REL, from));
    if (mod.enabled) {
      // Verify (or force), take the files out (a locked file puts back what
      // was removed and stops here), put them in under the new folder; on
      // failure back again.
      this._undeployOrRestore(mod, force);
      const extras = [];
      try {
        mod.ue4ssFolder = own;
        if (caseOnly && fs.existsSync(fromAbs)) {
          // Windows: a case-only rename of a folder that still holds the
          // mod's own leftovers goes through a temporary name.
          const tmp = `${fromAbs}.zcmc-move-${newId()}`;
          fs.renameSync(fromAbs, tmp);
          fs.renameSync(tmp, toAbs);
        }
        this._deployMod(mod);
        // What the mod (or the user) kept in the old folder moves with it —
        // never over a file just deployed.
        if (!caseOnly && fs.existsSync(fromAbs)) {
          for (const rel of walkFiles(fromAbs)) {
            const dst = path.join(toAbs, rel);
            if (fs.existsSync(dst)) continue;
            fs.mkdirSync(path.dirname(dst), { recursive: true });
            fs.renameSync(path.join(fromAbs, rel), dst);
            extras.push(rel);
          }
          this._pruneEmptyDirs(fromAbs);
        }
      } catch (err) {
        try {
          for (const rel of extras) {
            fs.mkdirSync(path.dirname(path.join(fromAbs, rel)), { recursive: true });
            fs.renameSync(path.join(toAbs, rel), path.join(fromAbs, rel));
          }
        } catch (_) {}
        try { this._undeployMod(mod, true); } catch (_) {}
        mod.ue4ssFolder = from;
        try { this._deployMod(mod); } catch (e) { log('warn', `"${mod.name}": could not put it back in ${from} (${e.message}) — it is redeployed at the next start`); }
        this.store.save();
        this._syncUe4ssModsTxt();
        throw new Error(`Could not move “${mod.name}” to ue4ss\\Mods\\${own}: ${err.message} — it was left in ${from}.`);
      }
    } else {
      mod.ue4ssFolder = own;
    }
    this._renameModsTxtEntry(from, own);
    this.store.save();
    this._syncUe4ssModsTxt();
    log('info', `"${mod.name}": moved from ue4ss\\Mods\\${from} to its own folder name ${own}`);
    return mod;
  }

  // A plain "<Folder> : 0|1" line for a folder that moved (written by hand or
  // by another tool, outside the managed block) follows it.
  _renameModsTxtEntry(fromName, toName) {
    if (!this.gamePath() || !fs.existsSync(this._modsTxtAbs())) return;
    const { lines, eol } = this._readModsTxt();
    let inBlock = false;
    let changed = false;
    const out = lines.map((line) => {
      if (line === UE4SS_BLOCK_BEGIN) { inBlock = true; return line; }
      if (line === UE4SS_BLOCK_END) { inBlock = false; return line; }
      if (inBlock) return line;
      const m = /^(\s*)([^;#\s][^:]*?)(\s*:\s*[01]\s*)$/.exec(line);
      if (!m || m[2].trim().toLowerCase() !== fromName.toLowerCase()) return line;
      changed = true;
      return `${m[1]}${toName}${m[3]}`;
    });
    if (changed) fs.writeFileSync(this._modsTxtAbs(), out.join(eol));
  }

  // Remove every empty folder under dirAbs (deepest first), then dirAbs itself
  // when it is empty.
  _pruneEmptyDirs(dirAbs) {
    let entries = [];
    try { entries = fs.readdirSync(dirAbs, { withFileTypes: true }); } catch (_) { return; }
    for (const e of entries) if (e.isDirectory()) this._pruneEmptyDirs(path.join(dirAbs, e.name));
    try { if (!fs.readdirSync(dirAbs).length) fs.rmdirSync(dirAbs); } catch (_) {}
  }

  // UE4SS mods whose deployed files sit outside their recorded folder
  // (Diagnostics). [{ modId, modName, expected, found }].
  auditDeployedNames() {
    const out = [];
    for (const m of this.store.mods.filter((x) => x.enabled && x.modType === 'ue4ss-mod')) {
      const prefix = path.join(UE4SS_MODS_REL, this.ue4ssFolderOf(m)).toLowerCase() + path.sep;
      const off = (m.deployed || []).filter((r) => !r.toLowerCase().startsWith(prefix));
      if (off.length) out.push({ modId: m.id, modName: m.name, expected: `ue4ss\\Mods\\${this.ue4ssFolderOf(m)}`, found: off.slice(0, 3) });
    }
    return out;
  }

  // The on-disk folder of a ZC Unlocked add-on (under ZCUnlocked\addons, or
  // under ue4ss\Mods for a pack adopted in place there — see _addonRoot).
  addonFolderName(mod) {
    if (mod && mod.addonFolder) return folderNameOf(mod.addonFolder);
    return safeName(mod.name);
  }

  // Where an add-on's folder lives: 'addons' (ue4ss\Mods\ZCUnlocked\addons —
  // every add-on Mod Command deploys, and every record without the field) or
  // 'mods' (ue4ss\Mods\<Pack> — a hand-placed pack adopted in place).
  _addonRoot(mod) { return mod && mod.addonRoot === 'mods' ? 'mods' : 'addons'; }
  _addonRootRel(mod) { return this._addonRoot(mod) === 'mods' ? UE4SS_MODS_REL : ZCU_ADDONS_REL; }
  // Game-root-relative folder of an add-on. Deploy, undeploy, the enabled=
  // switch, drift/repair and the audits all go through here.
  _addonDirRel(mod) { return path.join(this._addonRootRel(mod), this.addonFolderName(mod)); }

  // Every add-on folder in the game that ZC Unlocked loads:
  // ue4ss\Mods\ZCUnlocked\addons\<Folder>\ (addon.ini with an [addon]
  // section) and the bare packs ue4ss\Mods\<Pack>\ (addon.ini, not a UE4SS
  // script/dll mod). [{ root: 'addons'|'mods', folder, dirRel, location,
  // name (addon.ini name=, or null), active (enabled= is not 0), managedId,
  // managedName }]
  addonCopies() {
    if (!this.gamePath()) return [];
    const managed = new Map();
    for (const m of this.store.mods) {
      if (m.modType === 'zcu-addon') managed.set(this._addonDirRel(m).toLowerCase(), m);
    }
    const out = [];
    const SKIP = new Set([...UE4SS_BUILTIN, ...ZCSDK_PART_SET, ZCU_FOLDER.toLowerCase()]);
    for (const [root, rootRel] of [['addons', ZCU_ADDONS_REL], ['mods', UE4SS_MODS_REL]]) {
      let dirents = [];
      try { dirents = fs.readdirSync(this.gameAbs(rootRel), { withFileTypes: true }); } catch (_) { continue; }
      for (const d of dirents) {
        if (!d.isDirectory()) continue;
        if (root === 'mods' && SKIP.has(d.name.toLowerCase())) continue;
        const dirRel = path.join(rootRel, d.name);
        const abs = this.gameAbs(dirRel);
        const ini = root === 'mods' ? bareAddonPackIni(abs) : readAddonIni(path.join(abs, 'addon.ini'));
        if (!ini) continue;
        const m = managed.get(dirRel.toLowerCase()) || null;
        out.push({
          root,
          folder: d.name,
          dirRel,
          location: `${path.relative(WIN64_REL, dirRel)}${path.sep}`,
          name: ini.name && ini.name.trim() ? ini.name.trim().slice(0, 120) : null,
          active: addonIniActive(ini),
          managedId: m ? m.id : null,
          managedName: m ? m.name : null,
        });
      }
    }
    return out;
  }

  // An add-on's identity to ZC Unlocked: its folder (keyed as addon_<Folder>)
  // and the name= in its addon.ini (the library copy's; else its title).
  _addonIdentity(mod) {
    let name = null;
    const f = (mod.files || []).find((x) => String(x.libraryRelative).toLowerCase() === 'addon.ini');
    if (f) {
      const ini = readAddonIni(path.join(this.store.modLibraryDir(mod.id), f.libraryRelative));
      if (ini && ini.name && ini.name.trim()) name = ini.name.trim();
    }
    return { folder: this.addonFolderName(mod), name: name || mod.metaTitle || null };
  }

  // The add-on copies in the game that are the same add-on as `identity`
  // ({ folder, name }): the same folder key (rule 'folder') or the same
  // addon.ini name= (rule 'name'). excludeDirRel: the entry's own folder.
  _addonMatches(identity, copies, excludeDirRel) {
    const key = addonKeyOf(identity.folder);
    const nameKey = addonNameKey(identity.name);
    const skip = excludeDirRel ? path.normalize(excludeDirRel).toLowerCase() : null;
    const out = [];
    for (const c of copies) {
      if (skip && c.dirRel.toLowerCase() === skip) continue;
      const rule = addonKeyOf(c.folder) === key ? 'folder' : (nameKey && addonNameKey(c.name) === nameKey ? 'name' : null);
      if (rule) out.push({ ...c, rule });
    }
    return out;
  }

  // Other copies of a managed add-on in the game (switched on or off).
  findAddonDuplicates(idOrMod) {
    const mod = typeof idOrMod === 'string' ? this.store.getMod(idOrMod) : idOrMod;
    if (!mod || mod.modType !== 'zcu-addon') return [];
    return this._addonMatches(this._addonIdentity(mod), this.addonCopies(), this._addonDirRel(mod));
  }

  // The first other copy ZC Unlocked loads right now (its enabled= is not
  // 0), or null. A copy switched off with enabled=0 is not loaded.
  _activeAddonDuplicate(mod) {
    return this.findAddonDuplicates(mod).find((c) => c.active) || null;
  }

  _addonDuplicateMessage(mod, dup) {
    const label = this._addonIdentity(mod).name || mod.name;
    const why = dup.rule === 'name' ? ' (same name= in its addon.ini)' : '';
    if (dup.managedId) {
      return `A copy of ${label} is already at ${dup.location}${why} (“${dup.managedName}” in Mod Command) — ZC Unlocked would load both. `
        + 'Switch that copy off (or remove it) and then turn this one on.';
    }
    return `A copy of ${label} is already at ${dup.location}${why} — ZC Unlocked would load both. Remove that copy (or Import it) and then turn this one on.`;
  }

  // Record the duplicate warning on an add-on left switched off because of it.
  _noteAddonDuplicate(mod, dup) {
    const message = this._addonDuplicateMessage(mod, dup);
    mod.warnings = [...(mod.warnings || []).filter((w) => !ADDON_DUP_RE.test(w)), message];
    log('warn', `${mod.name}: installed switched off (enabled=0) — ${message}`);
    return message;
  }

  // Duplicate add-on copies in the game, managed or not (Diagnostics):
  // [{ members: [copy…], rules: ['folder'|'name'…], active: n }] — copies
  // grouped by folder key or addon.ini name=.
  addonDuplicateGroups() {
    const copies = this.addonCopies();
    const parent = copies.map((_, i) => i);
    const find = (x) => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
    const rules = new Map();
    const byKey = new Map();
    copies.forEach((c, i) => {
      for (const [rule, k] of [['folder', `f:${addonKeyOf(c.folder)}`], ['name', addonNameKey(c.name) ? `n:${addonNameKey(c.name)}` : null]]) {
        if (!k) continue;
        if (byKey.has(k)) {
          const a = find(i); const b = find(byKey.get(k));
          if (a !== b) parent[a] = b;
          rules.set(k, rule);
        } else byKey.set(k, i);
      }
    });
    const groups = new Map();
    copies.forEach((c, i) => { const r = find(i); if (!groups.has(r)) groups.set(r, []); groups.get(r).push(c); });
    const out = [];
    for (const members of groups.values()) {
      if (members.length < 2) continue;
      const ruleSet = new Set();
      for (const [k, rule] of rules) {
        const hits = members.filter((c) => (k.startsWith('f:') ? `f:${addonKeyOf(c.folder)}` : `n:${addonNameKey(c.name)}`) === k);
        if (hits.length > 1) ruleSet.add(rule);
      }
      out.push({ members, rules: [...ruleSet], active: members.filter((c) => c.active).length });
    }
    return out;
  }

  // The deploy folder that identifies a folder-keyed mod, or null.
  _deployFolder(mod) {
    if (mod.modType === 'ue4ss-mod') return this.ue4ssFolderOf(mod);
    if (mod.modType === 'zcu-addon') return this.addonFolderName(mod);
    return null;
  }

  // Is `rel` (relative to the UE4SS mod folder `dirAbs`) inside a ZC Unlocked
  // add-on folder there (addons\<Folder>\ holding an addon.ini — or anything
  // under ZCUnlocked\addons\, which is add-on space as a whole)?
  _insideAddonFolder(dirAbs, rel) {
    const parts = rel.split(path.sep);
    if (parts.length < 3 || parts[0].toLowerCase() !== 'addons') return false;
    if (path.basename(dirAbs).toLowerCase() === ZCU_FOLDER.toLowerCase()) return true;
    return !!readAddonIni(path.join(dirAbs, parts[0], parts[1], 'addon.ini'));
  }

  _isAddonIni(mod, rel) {
    return mod.modType === 'zcu-addon' && path.basename(rel).toLowerCase() === 'addon.ini'
      && path.dirname(path.normalize(rel)).toLowerCase() === this._addonDirRel(mod).toLowerCase();
  }

  // Does the deployed file at `rel` still hold what Mod Command put there?
  // An add-on's addon.ini is compared without its enabled= line (Mod Command
  // owns that line). Missing / unrecorded → true (nothing to protect).
  _deployedFileIsOurs(mod, rel) {
    const expected = mod.deployedHashes && mod.deployedHashes[rel];
    if (!expected) return true;
    const abs = this.gameAbs(rel);
    if (!fs.existsSync(abs)) return true;
    try {
      if (expected.startsWith('addonini:')) return addonIniHash(abs) === expected;
      return sha256File(abs) === expected;
    } catch (_) { return true; }
  }

  // Write enabled=1/0 into the deployed addon.ini (nothing else changes).
  _writeAddonState(mod, on) {
    const rel = (mod.deployed || []).find((r) => this._isAddonIni(mod, r));
    if (!rel) return false;
    const abs = this.gameAbs(rel);
    let buf;
    try { buf = fs.readFileSync(abs); } catch (_) { return false; }
    const next = setAddonIniEnabled(buf, on);
    if (!next.equals(buf)) fs.writeFileSync(abs, next);
    return true;
  }

  // Remove the now-empty folders a mod's deployed files lived in, deepest
  // first, never above `stopRel` (kept itself when not empty). Only folders on
  // the path of a recorded file are considered — nothing else is touched.
  _pruneDeployDirs(deployed, stopRel) {
    const stop = path.normalize(stopRel).toLowerCase();
    const dirs = new Map();
    for (const rel of deployed) {
      let d = path.dirname(path.normalize(rel));
      while (d && d !== '.' && (d.toLowerCase() + path.sep).startsWith(stop + path.sep)) {
        dirs.set(d.toLowerCase(), d);
        if (d.toLowerCase() === stop) break;
        d = path.dirname(d);
      }
    }
    const order = [...dirs.values()].sort((a, b) => b.split(path.sep).length - a.split(path.sep).length);
    for (const d of order) {
      try { const abs = this.gameAbs(d); if (fs.existsSync(abs) && !fs.readdirSync(abs).length) fs.rmdirSync(abs); } catch (_) {}
    }
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
      .map((m) => this.ue4ssFolderOf(m).toLowerCase()));
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
        // A signature the ZCSDK Runtime placed (and still owns) is never
        // retired; a copy of this name held for it from the old package is
        // dropped (not put back when the runtime is removed).
        if (this._zcsdkOwnedSig(norm(rel))) { this._zcsdkDropShadow(norm(rel)); continue; }
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
          stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true,
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
      if (!['iostore', 'gfp', 'ue4ss-mod', 'zcu-addon'].includes(mod.modType) || (mod.packages && mod.packages.length)) continue;
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
    return `pakchunk99-P${prio}_${safeName(this._pakDeployName(mod))}_`;
  }

  // The name a pak/IoStore mod's ~mods files carry: its display name, unless
  // the record keeps the name its files were deployed under (deployName — a
  // display name fixed without touching the game, see repairLibraryIdNames).
  // The next undeploy drops it, so the files take the display name the next
  // time they go in.
  _pakDeployName(mod) {
    return mod.deployName || mod.name;
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
      const suffix = safeName(base) === safeName(this._pakDeployName(mod)) ? '' : safeName(base);
      return path.join(MODS_REL, `${this._pakPrefix(mod)}${suffix}${ext}`.replace(/_(?=\.)/, ''));
    }
    if (mod.modType === 'logicmods') return path.join(LOGIC_MODS_REL, path.basename(f.libraryRelative));
    if (mod.modType === 'ue4ss-mod') return path.join(UE4SS_MODS_REL, this.ue4ssFolderOf(mod), f.libraryRelative);
    if (mod.modType === 'zcu-addon') return path.join(this._addonDirRel(mod), f.libraryRelative);
    if (mod.modType === 'gfp') return path.join(GAME_MODS_REL, this.gfpFolderName(mod), f.libraryRelative);
    if (mod.modType === 'gamefolder') return f.libraryRelative; // game-root-relative by construction
    return null;
  }

  // opts.skipIdentical: a file already in place with the library copy's exact
  // bytes is claimed as is instead of copied again (putting a mod back after
  // a failed replace — a file the game holds open can't be overwritten, but
  // it doesn't need to be). If a copy fails, mod.deployed lists what this
  // call did write, so the caller can take exactly that back out.
  // opts.addonOn: the enabled= state written into a ZC Unlocked add-on's
  // addon.ini (default: the record's enabled flag).
  _deployMod(mod, opts = {}) {
    if (mod.modType === 'zcu-addon' && !this.zcuPresent()) throw new Error(ZCU_MISSING);
    const libDir = this.store.modLibraryDir(mod.id);
    if (!fs.existsSync(libDir)) {
      throw new Error(`The stored copy of “${mod.name}” is missing from the mod archive — `
        + 'install the mod again, or uninstall it here.');
    }
    this.ensureGameDirs();
    const deployed = [];
    const hashes = {};
    // Deployed files are byte-identical library copies — reuse the install-time
    // hash where recorded (pre-1.1.0 installs have none; hash on the fly).
    const libHash = (f) => f.sha256 || sha256File(path.join(libDir, f.libraryRelative));
    const place = (f, destRel) => {
      const src = path.join(libDir, f.libraryRelative);
      const dst = this.gameAbs(destRel);
      let same = false;
      if (opts.skipIdentical && isFile(dst)) {
        try { same = fs.statSync(dst).size === fs.statSync(src).size && sha256File(dst) === libHash(f); } catch (_) {}
      }
      if (!same) {
        fs.mkdirSync(path.dirname(dst), { recursive: true });
        fs.copyFileSync(src, dst);
      }
      deployed.push(destRel);
      hashes[destRel] = libHash(f);
    };
    try {
      if (mod.modType === 'pak' || mod.modType === 'iostore' || mod.modType === 'logicmods') {
        for (const f of mod.files) place(f, this._deployRel(mod, f));
      } else if (mod.modType === 'zcu-addon') {
        // ZC Unlocked add-on: the folder goes down whole under its own name in
        // ZCUnlocked\addons; ZC Unlocked mounts its paks itself. The enabled=
        // line in addon.ini is Mod Command's on/off switch, so addon.ini is
        // recorded by its content WITHOUT that line.
        const on = opts.addonOn != null ? !!opts.addonOn : !!mod.enabled;
        for (const f of mod.files) {
          const destRel = this._deployRel(mod, f);
          if (!this._isAddonIni(mod, destRel)) { place(f, destRel); continue; }
          const dst = this.gameAbs(destRel);
          const buf = fs.readFileSync(path.join(libDir, f.libraryRelative));
          const next = setAddonIniEnabled(buf, on);
          let same = false;
          if (opts.skipIdentical && isFile(dst)) { try { same = fs.readFileSync(dst).equals(next); } catch (_) {} }
          if (!same) {
            fs.mkdirSync(path.dirname(dst), { recursive: true });
            fs.writeFileSync(dst, next);
          }
          deployed.push(destRel);
          hashes[destRel] = addonIniHash(buf);
        }
      } else if (mod.modType === 'ue4ss-mod') {
        // Two UE4SS mods in one folder would overwrite each other's files.
        const folder = this.ue4ssFolderOf(mod);
        const holder = this.store.mods.find((m) => m !== mod && m.id !== mod.id && m.modType === 'ue4ss-mod' && m.enabled
          && this.ue4ssFolderOf(m).toLowerCase() === folder.toLowerCase());
        if (holder) {
          throw new Error(`“${mod.name}” deploys into ue4ss\\Mods\\${folder}, which “${holder.name}” already uses — `
            + 'two UE4SS mods cannot share a folder. Disable or remove that one first.');
        }
        const modDirRel = path.join(UE4SS_MODS_REL, folder);
        for (const f of mod.files) place(f, this._deployRel(mod, f));
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
        for (const f of mod.files) place(f, this._deployRel(mod, f));
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
          place(f, destRel);
        }
      }
    } catch (err) {
      mod.deployed = deployed;
      mod.deployedHashes = hashes;
      throw err;
    }
    mod.deployed = deployed;
    mod.deployedHashes = hashes;
  }

  // The folder a mod type owns as a whole in the game (UE4SS mods, ZC
  // Unlocked add-ons and Game Feature plugins), or null when its files sit in
  // a shared folder.
  _modFolderRel(mod) {
    if (mod.modType === 'ue4ss-mod') return path.join(UE4SS_MODS_REL, this.ue4ssFolderOf(mod));
    if (mod.modType === 'zcu-addon') return this._addonDirRel(mod);
    if (mod.modType === 'gfp') return path.join(GAME_MODS_REL, this.gfpFolderName(mod));
    return null;
  }

  // force=true skips the ownership check (used after the user confirms, and for
  // internal redeploys where the files were verified moments earlier).
  //
  // Only the files this mod deployed (its record's deployed list) are removed
  // — plus, for a UE4SS mod, its own enabled.txt switch — and then only the
  // folders that are left empty. A mod folder that still holds anything else
  // (a file the user or another tool put there, a settings file the mod wrote
  // itself) stays, and the leftovers are logged. A file that cannot be removed
  // (held open by the running game) stops the undeploy with an error; the
  // record then lists just the files still in place.
  _undeployMod(mod, force) {
    if (!force) {
      // SHA-256 ownership check: a deployed file that changed outside the
      // manager is someone else's data now — stop instead of deleting it.
      const changed = (mod.deployed || []).filter((rel) => !this._deployedFileIsOurs(mod, rel));
      if (changed.length) {
        const err = new Error(
          `VERIFY_CHANGED::${mod.name}::${changed.join('|')}`);
        err.verifyChanged = changed;
        throw err;
      }
    }
    const failed = [];
    const remove = (rel) => {
      const abs = this.gameAbs(rel);
      if (!fs.existsSync(abs)) return;
      // A UE4SS signature the ZCSDK Runtime placed is the runtime's (another
      // mod that deployed the same bytes does not own it).
      if (this._zcsdkOwnedGameRel(rel)) return;
      try { fs.rmSync(abs, { force: true }); } catch (e) { failed.push({ rel, code: e.code || e.message }); }
    };
    for (const rel of mod.deployed || []) remove(rel);
    const folderRel = this._modFolderRel(mod);
    // The on/off switch belongs to the manager even when the start-order
    // block retired it from the deployed list.
    const enabledTxtRel = mod.modType === 'ue4ss-mod' ? path.join(folderRel, 'enabled.txt') : null;
    if (enabledTxtRel) remove(enabledTxtRel);
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
    if (folderRel) {
      // Then only the folders that are left empty. A Game Feature plugin's
      // folder goes once it is empty (the game treats a leftover plugin folder
      // as a (broken) mod). A UE4SS mod or ZC Unlocked add-on only loses the
      // empty folders its own recorded files lived in — never the whole
      // folder, nor anything else in it: ZC Unlocked's addons\<Folder>\
      // add-ons (each its own entry or the user's), configs and logs the mod
      // writes at runtime. Anything the manager did not put there is kept.
      const dir = this.gameAbs(folderRel);
      if (mod.modType === 'gfp') this._pruneEmptyDirs(dir);
      else this._pruneDeployDirs([...(mod.deployed || []), ...(enabledTxtRel ? [enabledTxtRel] : [])], folderRel);
      if (fs.existsSync(dir) && !failed.length) {
        let left = [];
        try { left = walkFiles(dir); } catch (_) {}
        if (left.length) {
          log('info', `"${mod.name}" is off; kept ${left.length} file(s) in ${folderRel} that Mod Command did not deploy: `
            + `${left.slice(0, 5).join(', ')}${left.length > 5 ? ', …' : ''}`);
        }
      }
    }
    // Nothing of it is left in the game: the next deploy names its files
    // after the display name again.
    if (!failed.length && mod.deployName) delete mod.deployName;
    if (failed.length) {
      const still = new Set(failed.map((f) => f.rel));
      mod.deployed = (mod.deployed || []).filter((r) => still.has(r));
      const h = {};
      for (const r of mod.deployed) if (mod.deployedHashes && mod.deployedHashes[r]) h[r] = mod.deployedHashes[r];
      mod.deployedHashes = h;
      const err = new Error(`Could not remove ${failed.length} file(s) of “${mod.name}” `
        + `(${failed.slice(0, 3).map((f) => path.basename(f.rel)).join(', ')}${failed.length > 3 ? ', …' : ''}: ${failed[0].code}) — `
        + 'they are in use, most likely by the running game. Close it and try again.');
      err.undeployFailed = failed.map((f) => f.rel);
      throw err;
    }
    mod.deployed = [];
    mod.deployedHashes = {};
  }

  // Take a mod's files out of the game; if that fails part way (a locked
  // file), put back what was already removed, so the mod stays whole and on
  // instead of half-removed. The ownership check's refusal comes before any
  // file is touched and needs no repair.
  _undeployOrRestore(mod, force) {
    const snapshot = { deployed: [...(mod.deployed || [])], deployedHashes: { ...(mod.deployedHashes || {}) } };
    try {
      this._undeployMod(mod, force);
    } catch (err) {
      if (err.undeployFailed) {
        mod.deployed = snapshot.deployed;
        mod.deployedHashes = snapshot.deployedHashes;
        try { this._deployMod(mod, { skipIdentical: true }); } catch (e) {
          log('warn', `"${mod.name}": could not put back its removed files (${e.message}) — they are redeployed at the next start`);
          mod.deployed = snapshot.deployed;
          mod.deployedHashes = snapshot.deployedHashes;
        }
        this.store.save();
      }
      throw err;
    }
  }

  // The user's switch: refused while the game runs (or can't be confirmed
  // closed). Internal paths that already checked use _setEnabledCore.
  setEnabled(id, enabled, force) {
    const mod = this.store.getMod(id);
    if (!mod) throw new Error('That mod is no longer installed.');
    if (!enabled) this._refuseRuntime(mod, 'switched off');
    if (enabled !== mod.enabled) this._assertGameClosed(enabled ? `enabling “${mod.name}”` : `disabling “${mod.name}”`);
    return this._setEnabledCore(id, enabled, force);
  }

  _setEnabledCore(id, enabled, force) {
    const mod = this.store.getMod(id);
    if (!mod) throw new Error('That mod is no longer installed.');
    if (enabled === mod.enabled) return mod;
    if (enabled) this._enableOrClean(mod);
    else this._disableMod(mod, force);
    mod.enabled = enabled;
    this.store.save();
    if (mod.modType === 'ue4ss-mod') {
      this._syncUe4ssModsTxt();
      if (enabled && this.ue4ssFolderOf(mod).toLowerCase() === ZCU_FOLDER.toLowerCase()) this._deployWaitingAddons();
    }
    return mod;
  }

  // _enableMod, and on failure nothing half-deployed stays behind a record
  // that is still off. A ZC Unlocked add-on that was in the game switched off
  // stays there as it was (enabled=0).
  _enableOrClean(mod) {
    const had = (mod.deployed || []).length > 0;
    try {
      this._enableMod(mod);
    } catch (err) {
      if (mod.modType === 'zcu-addon' && had) {
        try { this._writeAddonState(mod, false); } catch (_) {}
      } else {
        try { this._undeployMod(mod, true); } catch (_) {}
        mod.deployed = [];
        mod.deployedHashes = {};
      }
      throw err;
    }
  }

  // Deploy (enable). A ZC Unlocked add-on that is still in the game with
  // enabled=0 only gets its switch flipped back; otherwise it deploys whole.
  _enableMod(mod) {
    if (mod.modType === 'zcu-addon') {
      if (!this.zcuPresent()) throw new Error(ZCU_MISSING);
      // Another copy ZC Unlocked loads (one the player put in ue4ss\Mods\<Pack>,
      // or another entry): turning this one on would load the add-on twice.
      const dup = this._activeAddonDuplicate(mod);
      if (dup) {
        const err = new Error(this._addonDuplicateMessage(mod, dup));
        err.addonDuplicate = dup;
        throw err;
      }
      const ini = (mod.deployed || []).find((r) => this._isAddonIni(mod, r));
      if (ini && fs.existsSync(this.gameAbs(ini))) { this._writeAddonState(mod, true); }
      else {
        if ((mod.deployed || []).length) this._undeployMod(mod, true);
        this._deployMod(mod, { addonOn: true });
      }
      if (mod.needsZcu) { delete mod.needsZcu; mod.warnings = (mod.warnings || []).filter((w) => w !== ZCU_MISSING); }
      mod.warnings = (mod.warnings || []).filter((w) => !ADDON_DUP_RE.test(w));
      return;
    }
    this._deployMod(mod);
  }

  // Undeploy (disable). A ZC Unlocked add-on stays where it is — moving or
  // renaming its folder would lose its key — and gets enabled=0 in addon.ini.
  // Only that line changes (any other edit in the file stays), so there is
  // nothing to verify first.
  _disableMod(mod, force) {
    if (mod.modType === 'zcu-addon') {
      this._writeAddonState(mod, false); // false: nothing in the game to switch off
      return;
    }
    this._undeployOrRestore(mod, force);
  }

  uninstall(id, force, opts = {}) {
    const mod = this.store.getMod(id);
    if (!mod) throw new Error('That mod is no longer installed.');
    this._refuseRuntime(mod, 'removed');
    // A disabled ZC Unlocked add-on is still deployed (enabled=0).
    const inGame = this._isDeployed(mod);
    if (inGame) this._assertGameClosed(`removing “${mod.name}”`);
    // The last ZCSDK Runtime part going takes the signature files the runtime
    // installer put in ue4ss\UE4SS_Signatures with it — not while
    // installZcsdkRuntime or a replace swaps the parts (opts.keepZcsdkSigs).
    const dropSigs = !opts.keepZcsdkSigs && this._isZcsdkPart(mod)
      && !this.store.mods.some((m) => m !== mod && this._isZcsdkPart(m));
    if (dropSigs && this._zcsdkSignaturesRecord().files.length) this._assertGameClosed('removing the ZCSDK Runtime’s UE4SS signature files');
    if (inGame) this._undeployOrRestore(mod, force);
    fs.rmSync(this.store.modLibraryDir(id), { recursive: true, force: true });
    fs.rmSync(this.store.modBackupsDir(id), { recursive: true, force: true });
    this.store.removeMod(id);
    if (mod.modType === 'ue4ss-mod') this._syncUe4ssModsTxt();
    if (dropSigs) this._removeZcsdkSignatures();
  }

  rename(id, name) {
    const mod = this.store.getMod(id);
    if (!mod) throw new Error('That mod is no longer installed.');
    if (!name || name.length > 120) throw new Error('Use a name between 1 and 120 characters.');
    // A runtime part's folder name is what the other part and every SDK mod
    // look for; and no other UE4SS mod may take one of those folder names.
    if (!this._runtimeOp && isZcsdkRuntimeRecord(mod) && name !== mod.name) {
      throw new Error(`“${mod.name}” is part of the ZCSDK Runtime — its name is its folder in ue4ss\\Mods and cannot change.`);
    }
    if (mod.modType === 'ue4ss-mod' && !isZcsdkRuntimeRecord(mod) && isZcsdkPartName(name)) {
      throw new Error(`“${name}” is the name of a ZCSDK Runtime part — pick another name.`);
    }
    // A Game Feature plugin's deployed folder is named after its .uplugin, not
    // after the display name — the game matches the two, so a rename is cosmetic
    // and must NOT move the folder (nor recopy a multi-hundred-MB payload).
    // The same holds for a UE4SS mod (its folder is its name in mods.txt, in
    // its own Lua paths and to ZC Unlocked) and a ZC Unlocked add-on (its
    // folder is its key). A UE4SS mod recorded before v1.9.20 has no folder on
    // record: it is pinned to where it is deployed now, then renamed.
    if (mod.modType === 'ue4ss-mod' && !mod.ue4ssFolder) mod.ue4ssFolder = this.ue4ssFolderOf(mod);
    const wasEnabled = mod.enabled && !['gfp', 'ue4ss-mod', 'zcu-addon'].includes(mod.modType);
    if (wasEnabled && name !== mod.name) this._assertGameClosed(`renaming “${mod.name}”`);
    if (wasEnabled) this._undeployOrRestore(mod);
    mod.name = name;
    if (wasEnabled) this._deployMod(mod);
    this.store.save();
    return mod;
  }

  // Enable or disable every installed mod at once. Disabling pre-verifies the
  // deployed files of ALL affected mods first (one aggregate ownership check),
  // so a failed check can't leave the set half-toggled. "Disable all" leaves
  // the ZCSDK Runtime on while SDK mods are installed (result.kept).
  setAllEnabled(enabled, force) {
    const kept = enabled ? [] : this.store.mods.filter((m) => m.enabled && this.runtimeLocked(m));
    const targets = this.store.mods.filter((m) => m.enabled !== enabled && !kept.includes(m));
    if (!targets.length) return { changed: 0, errors: [], kept: kept.map((m) => m.name) };
    this._assertGameClosed(enabled ? 'enabling every mod' : 'disabling every mod');
    // ZC Unlocked itself is deployed before the add-ons that need it.
    if (enabled) targets.sort((a, b) => (a.modType === 'zcu-addon') - (b.modType === 'zcu-addon'));
    if (!enabled && !force) {
      const changed = [];
      for (const mod of targets) {
        if (mod.modType === 'zcu-addon') continue; // only its enabled= line changes
        for (const rel of mod.deployed || []) {
          if (!this._deployedFileIsOurs(mod, rel)) changed.push(rel);
        }
      }
      if (changed.length) {
        const err = new Error(`VERIFY_CHANGED::${targets.length} mods::${changed.join('|')}`);
        err.verifyChanged = changed;
        throw err;
      }
    }
    const result = { changed: 0, errors: [], kept: kept.map((m) => m.name) };
    for (const mod of targets) {
      try {
        if (enabled) this._enableOrClean(mod);
        else this._disableMod(mod, true); // verified above (or forced)
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
    // A ZC Unlocked add-on is keyed by its folder (its identity to ZC Unlocked).
    // (A pack adopted in place in ue4ss\Mods has its own history: the same
    // folder name may also be managed in ZCUnlocked\addons.)
    if (mod.modType === 'zcu-addon') return `zcu-addon-${this._addonRoot(mod) === 'mods' ? 'pack-' : ''}${safeName(this.addonFolderName(mod)).toLowerCase()}`;
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
  // vaulted first, so rolling back is itself reversible; the archived copy
  // goes in straight in the mod's current state (on or off, same slots), and
  // a failure puts the current version back as it was.
  async rollbackVersion(id, entryId) {
    const mod = this.store.getMod(id);
    if (!mod) throw new Error('That mod is no longer installed.');
    this._refuseRuntime(mod, 'rolled back');
    if (this._isDeployed(mod)) this._assertGameClosed(`rolling back “${mod.name}”`);
    const key = this._vaultKey(mod);
    const entryDir = path.join(this.store.modVaultDir(key), entryId);
    const manifest = JSON.parse(fs.readFileSync(path.join(entryDir, 'vault.json'), 'utf8'));
    const keep = {
      // (an add-on only waiting for ZC Unlocked keeps waiting, not off)
      enabled: mod.enabled || !!mod.needsZcu,
      loadPriority: mod.loadPriority,
      ue4ssPriority: mod.ue4ssPriority,
    };
    // The vaulted files sit at the root of the entry, so the folder name comes
    // from the installed record (the swap never moves a UE4SS mod / add-on).
    const ue4ssKeep = this._ue4ssKeep(mod);
    const addonFolder = mod.modType === 'zcu-addon' ? this.addonFolderName(mod) : undefined;
    const addonRoot = mod.modType === 'zcu-addon' ? this._addonRoot(mod) : undefined;
    const cap = this._captureForReplace(mod);
    const before = new Set(this.store.mods.map((m) => m.id));
    // A runtime part (allowed only while no SDK mod needs it) is the runtime
    // installer's to swap.
    const runtime = isZcsdkRuntimeRecord(mod);
    if (runtime) this._runtimeOp += 1;
    let fresh;
    try {
      this.uninstall(mod.id, true, { keepZcsdkSigs: true });
      cap.removed = true;
      const res = await this.install(path.join(entryDir, 'files'), {
        skipFomod: true,
        origin: manifest.origin,
        version: manifest.version,
        metaOverride: { title: manifest.name },
        keep, ue4ssKeep, addonFolder, addonRoot,
      });
      const installed = res.multi ? res.mods[0] : res;
      fresh = installed && installed.id ? this.store.getMod(installed.id) : null;
      if (!fresh) throw new Error('the archived version did not install');
    } catch (err) {
      this._restoreReplaced([cap], before);
      throw new Error(`Could not roll “${mod.name}” back: ${err.message} — the installed version was put back as it was.`);
    } finally {
      if (runtime) this._runtimeOp -= 1;
    }
    if (fresh.modType === 'ue4ss-mod') this._syncUe4ssModsTxt();
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
    if (orderedIds.some((id, idx) => { const m = this.store.getMod(id); return m.enabled && m.loadPriority !== idx + 1; })) {
      this._assertGameClosed('changing the load order');
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
    // A UE4SS mod's enabled.txt is the on/off switch (the manager, UE4SS and
    // the user may all rewrite it), even when the package ships one: never
    // evidence of a different build.
    if (mod.modType === 'ue4ss-mod') sources.delete(key(path.join(UE4SS_MODS_REL, this.ue4ssFolderOf(mod), 'enabled.txt')));
    const drift = { missing: [], changed: [], foreign: [] };
    for (const rel of mod.deployed || []) {
      const abs = this.gameAbs(rel);
      let st;
      try { st = fs.statSync(abs); } catch (_) { drift.missing.push(rel); continue; }
      const f = sources.get(key(rel));
      if (!f) continue; // enabled.txt and other markers have no library source
      try {
        const lib = path.join(libDir, f.libraryRelative);
        // An add-on's addon.ini: its enabled= line is Mod Command's switch,
        // so the rest of the file is what must match the library copy.
        if (this._isAddonIni(mod, rel)) {
          if (addonIniHash(abs) !== addonIniHash(lib)) drift.changed.push(rel);
          continue;
        }
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

  // The same, for a mod that has nothing deployed (yet): every place it WOULD
  // deploy to, hashed.
  _targetDrift(mod) {
    return this._deploymentDrift({ ...mod, deployed: (mod.files || []).map((f) => this._deployRel(mod, f)).filter(Boolean) }, { hash: true });
  }

  _driftList(d) {
    const all = [...d.changed, ...d.foreign];
    return `${all.slice(0, 3).join(', ')}${all.length > 3 ? ', …' : ''}`;
  }

  // Startup recovery: an enabled mod whose deployed files went missing (deleted
  // by hand, a game update, a cleanup tool) is redeployed from its library copy —
  // but only when what is left is still ours. Files changed outside Mod Command
  // (a newer build deployed by the Mod SDK, a manual update) are never replaced
  // by the library copy: those mods are returned in `skipped` and left alone.
  repairDeployments() {
    const repaired = [];
    const skipped = [];
    // A running game holds its files: repair after it exits (main.js retries).
    if (this._gameIsRunning()) return { repaired, skipped, waiting: true };
    for (const mod of this.store.mods.filter((m) => this._isDeployed(m))) {
      const missing = (mod.deployed || []).some((rel) => !fs.existsSync(this.gameAbs(rel)));
      if (!missing) continue;
      // Nothing to redeploy from — leave whatever is still in the game alone.
      if (this.storedCopyMissing(mod)) continue;
      // An add-on is put back only where ZC Unlocked is there to load it.
      if (mod.modType === 'zcu-addon' && !this.zcuPresent()) continue;
      try {
        const drift = this._deploymentDrift(mod, { hash: true });
        if (drift.changed.length || drift.foreign.length) {
          skipped.push(mod.name);
          log('warn', `startup recovery skipped ${mod.name}: ${drift.missing.length} deployed file(s) missing, ${drift.changed.length} changed and ${drift.foreign.length} unrecorded file(s) present — the deployed files were changed outside Mod Command (${this._driftList(drift)})`);
          continue;
        }
        this._undeployMod(mod, true);
        this._deployMod(mod);
        repaired.push(mod.name);
      } catch (_) { /* leave it for diagnostics to report */ }
    }
    if (repaired.length) this.store.save();
    // Add-ons installed before ZC Unlocked was in the game, now that it is.
    const addonsDeployed = this._deployWaitingAddons();
    if (!addonsDeployed.length) return { repaired, skipped };
    log('info', `ZC Unlocked found — deployed ${addonsDeployed.length} add-on(s) that were waiting for it: ${addonsDeployed.join(', ')}`);
    return { repaired, skipped, addonsDeployed };
  }

  // Mod records named after their library folder's storage id (an orphaned
  // archive entry adopted by an older build came in as e.g. "59abe3e7933d7d49")
  // get a readable name from their stored copy, once — the same way Import
  // names such an entry now. DISPLAY NAME ONLY: nothing in the game is moved,
  // renamed or redeployed (the game may be running). Every on-disk name that
  // was derived from the display name is pinned first: a pak/IoStore mod's
  // ~mods files keep theirs (deployName) until they next come out of the game,
  // and a record without its folder on record (UE4SS mod, add-on, plugin) gets
  // the folder it uses now. Returns [{ id, from, to }].
  repairLibraryIdNames() {
    const out = [];
    for (const mod of this.store.mods) {
      if (!LIBRARY_ID_RE.test(String(mod.name || '')) || isZcsdkRuntimeRecord(mod)) continue;
      const libDir = this.store.modLibraryDir(mod.id);
      if (!fs.existsSync(libDir)) continue; // nothing to name it from (yet)
      // A folder name of its own on record (not an id) names it best.
      const own = [
        mod.modType === 'ue4ss-mod' && mod.ue4ssFolder,
        mod.modType === 'zcu-addon' && mod.addonFolder,
        mod.modType === 'gfp' && mod.pluginName,
      ].find((n) => n && !LIBRARY_ID_RE.test(n));
      const fallback = own || libraryFallbackName(libDir);
      let name = fallback;
      try {
        const info = classifyFolder(libDir, fallback);
        if (info.modType === mod.modType && info.name && !LIBRARY_ID_RE.test(info.name)) name = info.name;
      } catch (_) { /* unreadable copy: the files' name will do */ }
      name = String(name).trim().slice(0, 120) || 'Recovered mod';
      if (mod.modType === 'ue4ss-mod' && !mod.ue4ssFolder) mod.ue4ssFolder = this.ue4ssFolderOf(mod);
      if (mod.modType === 'zcu-addon' && !mod.addonFolder) mod.addonFolder = this.addonFolderName(mod);
      if (mod.modType === 'gfp' && !mod.pluginName) mod.pluginName = this.gfpFolderName(mod);
      if (['pak', 'iostore'].includes(mod.modType) && (mod.deployed || []).length && !mod.deployName) mod.deployName = mod.name;
      const oldKey = this._vaultKey(mod);
      const from = mod.name;
      mod.name = name;
      // A record without a shipped title is keyed by its name: its version
      // history and saved profiles follow it.
      const newKey = this._vaultKey(mod);
      if (newKey !== oldKey) { try { this._moveVault(oldKey, newKey); } catch (_) {} }
      for (const p of this.store.profiles) {
        for (const e of p.entries || []) {
          if (e.modId !== mod.id) continue;
          if (e.vaultKey === oldKey) e.vaultKey = newKey;
          if (e.modName === from) e.modName = name;
        }
      }
      out.push({ id: mod.id, from, to: name });
    }
    if (out.length) {
      this.store.save();
      log('info', `named ${out.length} mod(s) that carried their archive id as their name: ${out.map((r) => `${r.from} -> ${r.to}`).join(', ')}`);
    }
    return out;
  }

  // Has this mod's files in the game? Enabled mods, plus disabled ZC Unlocked
  // add-ons (they stay deployed with enabled=0 in addon.ini).
  _isDeployed(m) {
    return !!m.enabled || (m.modType === 'zcu-addon' && (m.deployed || []).length > 0);
  }

  // Diagnostics: enabled mods whose deployed files were changed outside Mod
  // Command. Cheap by default (sizes and unrecorded files); equal-size files are
  // hashed only for mods with a missing file, the ones startup recovery skips.
  auditChangedDeployments() {
    const out = [];
    for (const m of this.store.mods.filter((x) => this._isDeployed(x))) {
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
    for (const m of existing) this._refuseRuntime(m, 'replaced by a download');
    if (existing.some((m) => this._isDeployed(m))) this._assertGameClosed(`updating “${existing[0].name}”`);
    const keepByName = new Map(existing.map((m) => [m.name.toLowerCase(), {
      // (an add-on only waiting for ZC Unlocked keeps waiting, not off)
      enabled: m.enabled || !!m.needsZcu, loadPriority: m.loadPriority, ue4ssPriority: m.ue4ssPriority,
      // A UE4SS mod / add-on stays in the folder it is deployed in; the fresh
      // download's own folder name is recorded beside it (a difference shows
      // the "Use original name" notice).
      modType: m.modType, folder: this._deployFolder(m),
      addonRoot: m.modType === 'zcu-addon' ? this._addonRoot(m) : undefined,
      ue4ssFolderNoticeDismissed: m.modType === 'ue4ss-mod' ? (m.ue4ssFolderNoticeDismissed || null) : undefined,
    }]));
    const singleKeep = existing.length === 1
      ? { name: existing[0].name, ...keepByName.values().next().value }
      : null;
    // Archive the outgoing versions so the update can be rolled back (and put
    // back right away if the update fails).
    const caps = existing.map((m) => this._captureForReplace(m));
    const before = new Set(this.store.mods.map((m) => m.id));
    let res;
    try {
      for (const cap of caps) {
        this.uninstall(cap.record.id, undefined, { keepZcsdkSigs: true });
        cap.removed = true;
      }
      // Each new entry goes in straight in the state of the one it replaces
      // (by name; the only one when a single entry is replaced).
      res = await this.install(sourcePath, {
        origin: newOrigin, version: newVersion,
        keep: singleKeep || undefined,
        keepFor: singleKeep ? undefined : (name) => keepByName.get(String(name).toLowerCase()) || null,
      });
    } catch (err) {
      this._restoreReplaced(caps, before);
      if (err.verifyChanged) throw err;
      throw new Error(`${err.message} — the installed version was put back as it was.`);
    }
    if (res.pendingFomod) return res; // wizard finishes the install (origin rides the session)
    const mods = res.multi ? res.mods : [res];
    if (mods.some((m) => m && m.modType === 'ue4ss-mod')) this._syncUe4ssModsTxt();
    this.store.save();
    // (an add-on left off because of another copy keeps saying so)
    return { multi: true, mods: mods.map((m) => (m.id ? { ...this.store.getMod(m.id), ...(m.addonDuplicate ? { addonDuplicate: m.addonDuplicate } : {}) } : m)) };
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
      dirName: this.ue4ssFolderOf(m),
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
    const managedDirs = new Set(managed.map((m) => this.ue4ssFolderOf(m).toLowerCase()));
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
    const block = [UE4SS_BLOCK_BEGIN, ...managed.map((m) => `${this.ue4ssFolderOf(m)} : 1`), UE4SS_BLOCK_END];
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
    // The ZCSDK Runtime's parts keep theirs: their switch must not depend on a
    // mods.txt another tool may rewrite.
    let pruned = false;
    for (const m of managed) {
      if (isZcsdkRuntimeRecord(m)) {
        // (and get back one an earlier version retired)
        const rel = path.join(UE4SS_MODS_REL, this.ue4ssFolderOf(m), 'enabled.txt');
        const dir = this.gameAbs(path.dirname(rel));
        try {
          if (fs.existsSync(dir) && !fs.existsSync(this.gameAbs(rel))) fs.writeFileSync(this.gameAbs(rel), '');
          if (m.deployed && !m.deployed.includes(rel)) { m.deployed.push(rel); pruned = true; }
        } catch (_) {}
        continue;
      }
      const rel = path.join(UE4SS_MODS_REL, this.ue4ssFolderOf(m), 'enabled.txt');
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
    // A profile swaps versions, switches mods and reorders paks: none of it
    // may happen under a running game.
    this._assertGameClosed(`applying the profile “${profile.name}”`);
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
      if (this.runtimeLocked(mod)) {
        warnings.push(`"${mod.name}" is part of the ZCSDK Runtime your SDK mods need — it stays at v${mod.version || '?'} (the profile wants v${entry.version || '?'}).`);
        continue;
      }
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
      if (mod.enabled === entry.enabled) continue;
      if (!entry.enabled && this.runtimeLocked(mod)) {
        warnings.push(`"${mod.name}" is part of the ZCSDK Runtime your SDK mods need — it stays on.`);
        continue;
      }
      this.setEnabled(mod.id, entry.enabled);
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
  // Returns candidates: { id, kind: 'pak-group'|'logicmods-group'|'gfp-folder'
  //                       |'ue4ss-folder'|'zcu-addon-folder',
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
      // UE4SS's own folders, and the ZCSDK Runtime's parts: those are
      // installed and kept by Settings → ZCSDK Runtime, never adopted as
      // ordinary mods (an adopted copy could later be switched off or
      // removed like one, taking the runtime with it).
      const BUILTIN = new Set([...UE4SS_BUILTIN, ...ZCSDK_PART_SET]);
      let modsTxt = '';
      try { modsTxt = fs.readFileSync(path.join(modsDir, 'mods.txt'), 'utf8'); } catch (_) {}
      const managedDirs = new Set(this.store.mods
        .filter((m) => m.modType === 'ue4ss-mod')
        .map((m) => this.ue4ssFolderOf(m).toLowerCase()));
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
          // Not the ZC Unlocked add-ons inside it (addons\<Folder>\ with an
          // addon.ini) nor files another managed mod deployed there — adopting
          // ZC Unlocked must not claim them as its own.
          files: walkFiles(dir)
            .filter((f) => !this._insideAddonFolder(dir, f))
            .map((f) => path.join(UE4SS_MODS_REL, dirent.name, f))
            .filter((rel) => !owned.has(path.resolve(this.gameAbs(rel)).toLowerCase())),
          active,
        });
      }
    }

    // ZC Unlocked add-on folders (ue4ss\Mods\ZCUnlocked\addons\<Folder>\ with
    // an addon.ini [addon] section) no managed add-on owns — an add-on copied
    // in by hand. Adopted as a ZCU ADD-ON in place, under its folder name (ZC
    // Unlocked's key for it); addon.ini enabled=0 means it is in the game but
    // switched off.
    const addonsDir = this.gameAbs(ZCU_ADDONS_REL);
    if (fs.existsSync(addonsDir)) {
      const managedAddons = new Set(this.store.mods
        .filter((m) => m.modType === 'zcu-addon' && this._addonRoot(m) === 'addons')
        .map((m) => this.addonFolderName(m).toLowerCase()));
      for (const dirent of fs.readdirSync(addonsDir, { withFileTypes: true })) {
        if (!dirent.isDirectory() || managedAddons.has(dirent.name.toLowerCase())) continue;
        const dir = path.join(addonsDir, dirent.name);
        const ini = readAddonIni(path.join(dir, 'addon.ini'));
        if (!ini) continue;
        let rels;
        try { rels = walkFiles(dir); } catch (_) { continue; }
        const files = rels.map((f) => path.join(ZCU_ADDONS_REL, dirent.name, f))
          .filter((rel) => !owned.has(path.resolve(this.gameAbs(rel)).toLowerCase()));
        if (!files.some((rel) => path.basename(rel).toLowerCase() === 'addon.ini')) continue;
        const iniName = ini.name && ini.name.trim() ? ini.name.trim().slice(0, 120) : null;
        candidates.push({
          id: `zcu-addon-folder:${dirent.name}`,
          kind: 'zcu-addon-folder',
          name: iniName || dirent.name,
          addonFolder: dirent.name,
          version: ini.version && ini.version.trim() ? ini.version.trim().slice(0, 40) : null,
          modType: 'zcu-addon',
          addonRoot: 'addons',
          location: path.join(ZCU_ADDONS_REL, dirent.name),
          files,
          active: ini.enabled == null || String(ini.enabled).trim() !== '0',
        });
      }
    }

    // Bare ZC Unlocked add-on packs straight in ue4ss\Mods\<Pack>\ (addon.ini
    // with an [addon] section, no Scripts\main.lua or dlls\main.dll) — ZC
    // Unlocked loads those too. Offered as ZCU ADD-ON rows and adopted IN
    // PLACE (addonRoot 'mods'): the folder stays where the player put it.
    if (fs.existsSync(modsDir)) {
      const SKIP = new Set([...UE4SS_BUILTIN, ...ZCSDK_PART_SET, ZCU_FOLDER.toLowerCase()]);
      const managedPacks = new Set(this.store.mods
        .filter((m) => m.modType === 'zcu-addon' && this._addonRoot(m) === 'mods')
        .map((m) => this.addonFolderName(m).toLowerCase()));
      for (const dirent of fs.readdirSync(modsDir, { withFileTypes: true })) {
        if (!dirent.isDirectory()) continue;
        const lower = dirent.name.toLowerCase();
        if (SKIP.has(lower) || managedPacks.has(lower)) continue;
        const dir = path.join(modsDir, dirent.name);
        const ini = bareAddonPackIni(dir);
        if (!ini) continue;
        let rels;
        try { rels = walkFiles(dir); } catch (_) { continue; }
        const files = rels.map((f) => path.join(UE4SS_MODS_REL, dirent.name, f))
          .filter((rel) => !owned.has(path.resolve(this.gameAbs(rel)).toLowerCase()));
        if (!files.some((rel) => path.basename(rel).toLowerCase() === 'addon.ini')) continue;
        const iniName = ini.name && ini.name.trim() ? ini.name.trim().slice(0, 120) : null;
        candidates.push({
          id: `zcu-addon-pack:${dirent.name}`,
          kind: 'zcu-addon-folder',
          name: iniName || dirent.name,
          addonFolder: dirent.name,
          version: ini.version && ini.version.trim() ? ini.version.trim().slice(0, 40) : null,
          modType: 'zcu-addon',
          addonRoot: 'mods',
          location: path.join(UE4SS_MODS_REL, dirent.name),
          files,
          active: addonIniActive(ini),
        });
      }
    }

    // An add-on row that is the same add-on as another copy in the game (a
    // managed entry, or another hand-placed folder) says so: adopting both
    // would keep two copies ZC Unlocked loads.
    const addonRows = candidates.filter((c) => c.kind === 'zcu-addon-folder');
    if (addonRows.length) {
      const copies = this.addonCopies();
      for (const c of addonRows) {
        const dups = this._addonMatches({ folder: c.addonFolder, name: c.name === c.addonFolder ? null : c.name }, copies, c.location);
        if (dups.length) {
          c.duplicateOf = dups.map((d) => ({ location: d.location, managed: !!d.managedId, name: d.managedName || d.name || d.folder, active: d.active, rule: d.rule }));
        }
      }
    }
    return candidates;
  }

  // Bring an unmanaged candidate under management: library gets the canonical
  // copy; the already-deployed game files are claimed in place (nothing moves,
  // so the game setup is untouched mid-adoption).
  adopt(candidate) {
    if (candidate.kind === 'ue4ss-folder' && isZcsdkPartName(candidate.name)) {
      throw new Error(`“${candidate.name}” is part of the ZCSDK Runtime — it is managed from Settings → ZCSDK Runtime, not adopted.`);
    }
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
      } else if (candidate.kind === 'zcu-addon-folder') {
        // (in ZCUnlocked\addons, or a bare pack in ue4ss\Mods adopted in place)
        const rootRel = candidate.addonRoot === 'mods' ? UE4SS_MODS_REL : ZCU_ADDONS_REL;
        libraryRelative = path.relative(path.join(rootRel, candidate.addonFolder), rel);
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
    const isAddon = candidate.kind === 'zcu-addon-folder';
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
      name: isGfp || isAddon ? candidate.name : safeName(candidate.name),
      version: gfpMeta.version || (isAddon ? candidate.version : null) || null,
      author: gfpMeta.author || null,
      description: gfpMeta.description || null,
      eaCompatible: null,
      launchers: null,
      zcsdk: zcsdkMeta(files.map((f) => f.libraryRelative), null),
      modType: candidate.modType,
      pluginName: isGfp ? candidate.pluginName : null,
      // An adopted UE4SS folder stays exactly where (and as) it is.
      ue4ssFolder: candidate.kind === 'ue4ss-folder' ? candidate.name : null,
      ue4ssOwnFolder: candidate.kind === 'ue4ss-folder' ? candidate.name : null,
      ue4ssFolderNoticeDismissed: null,
      // An adopted add-on keeps its folder (its key to ZC Unlocked).
      addonFolder: isAddon ? candidate.addonFolder : undefined,
      // ...where it stays: ZCUnlocked\addons, or ue4ss\Mods for a bare pack.
      addonRoot: isAddon ? (candidate.addonRoot === 'mods' ? 'mods' : 'addons') : undefined,
      enabled: candidate.active,
      installedAt: new Date().toISOString(),
      installedBuild: this.currentBuildId(),
      loadPriority: ordered ? this.store.nextLoadPriority(['pak', 'iostore']) : null,
      ue4ssPriority: candidate.modType === 'ue4ss-mod' ? this._nextUe4ssPriority() : null,
      sourceArchive: null,
      files,
      packages: this._listPackages(libDir, files),
      warnings: [],
      // A switched-off add-on is in the game all the same (enabled=0).
      deployed: candidate.active || isAddon ? [...candidate.files] : [],
      origin: { type: 'local', adopted: true },
      updateInfo: null,
    };
    // An inactive UE4SS folder stays where it is (it is off: no enabled.txt,
    // no mods.txt line); enabling deploys the library copy over it. Adopting
    // never deletes anything in the game.
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

  // Orphaned library entries, each with what adopting it would do:
  //   effect.action 'new'       — installs as a new mod
  //                 'archive'   — older than the installed mod of the same
  //                               title: goes to its version vault only
  //                 'replace' / 'reinstall' — REPLACES the installed mod
  //                               (effect.replaces; needs an explicit tick)
  // A stray copy of a ZCSDK Runtime part is never adoptable: it comes back
  // as { runtimeCopy: true } — "an old ZCSDK Runtime copy, safe to clean"
  // (cleanRuntimeCopy).
  scanOrphanLibraries() {
    const known = new Set(this.store.mods.map((m) => m.id));
    const orphans = [];
    try {
      for (const dirent of fs.readdirSync(this.store.libraryDir, { withFileTypes: true })) {
        if (!dirent.isDirectory() || known.has(dirent.name)) continue;
        const abs = path.join(this.store.libraryDir, dirent.name);
        try {
          const info = classifyFolder(abs, this._orphanFallbackName(abs));
          if (!info.modType || info.modType === 'ue4ss-runtime') continue;
          const title = (info.meta && info.meta.title) || info.name;
          const version = (info.meta && info.meta.version) || null;
          if (isZcsdkRuntimeInfo(info)) {
            orphans.push({
              id: `orphan:${dirent.name}`, dirName: dirent.name, name: title, version,
              modType: info.modType, fileCount: info.payload.length, runtimeCopy: true,
            });
            continue;
          }
          orphans.push({
            id: `orphan:${dirent.name}`,
            dirName: dirent.name,
            name: info.name,
            version,
            modType: info.modType,
            fileCount: info.payload.length,
            effect: this._orphanEffect(info),
          });
        } catch (_) {}
      }
    } catch (_) {}
    return orphans;
  }

  // The name an orphaned library entry is offered and adopted under when its
  // files carry no metadata (libraryFallbackName — never its hex folder id).
  // A root-level UE4SS mod deploys into a folder of that name, and two UE4SS
  // mods can never share one: a taken name gets " 2", " 3", …
  _orphanFallbackName(abs) {
    const base = libraryFallbackName(abs);
    let info = null;
    try { info = classifyFolder(abs, base); } catch (_) {}
    if (!info || info.modType !== 'ue4ss-mod' || info.folder || info.meta && info.meta.title) return base;
    const taken = new Set(this.store.mods.filter((m) => m.modType === 'ue4ss-mod')
      .map((m) => this.ue4ssFolderOf(m).toLowerCase()));
    if (!taken.has(safeName(base).toLowerCase())) return base;
    for (let n = 2; n < 1000; n++) {
      if (!taken.has(safeName(`${base} ${n}`).toLowerCase())) return `${base} ${n}`;
    }
    return base;
  }

  _orphanEffect(info) {
    const existing = this._findSameMod(info, null);
    if (!existing) return { action: 'new' };
    const incoming = (info.meta && info.meta.version) || null;
    const cmp = compareVersions(incoming, existing.version);
    const base = { installedId: existing.id, installedName: existing.name, installedVersion: existing.version || null, installedEnabled: !!existing.enabled, incoming };
    if (cmp < 0) return { action: 'archive', ...base };
    return { action: cmp === 0 ? 'reinstall' : 'replace', replaces: true, ...base };
  }

  // opts.allowReplace: the user ticked an entry that replaces an installed
  // mod after being told so — without it such an adoption is refused.
  async adoptOrphan(dirName, opts = {}) {
    if (!/^[0-9a-f]+$/i.test(dirName)) throw new Error('Not a library entry.');
    const abs = path.join(this.store.libraryDir, dirName);
    if (!fs.existsSync(abs)) throw new Error('That library entry is gone.');
    if (this.store.getMod(dirName)) throw new Error('That library entry belongs to an installed mod.');
    // The entry's folder is its storage id: the mod is named from its files.
    const fallbackName = this._orphanFallbackName(abs);
    const info = classifyFolder(abs, fallbackName);
    if (isZcsdkRuntimeInfo(info)) {
      throw new Error('That entry is an old copy of the ZCSDK Runtime — it can only be cleaned up, not adopted (Settings → ZCSDK Runtime installs the runtime).');
    }
    const effect = info.modType && info.modType !== 'ue4ss-runtime' ? this._orphanEffect(info) : { action: 'new' };
    if (effect.replaces && !opts.allowReplace) {
      throw new Error(`Adopting it would replace your installed “${effect.installedName}”${effect.installedVersion ? ` v${effect.installedVersion}` : ''} — tick it explicitly to do that.`);
    }
    const res = await this.install(abs, { skipFomod: true, fallbackName });
    const mod = res.multi ? res.mods[0] : res;
    fs.rmSync(abs, { recursive: true, force: true }); // superseded by the fresh copy
    return this.store.getMod(mod.id);
  }

  // Delete an orphaned library entry that is a stray copy of a ZCSDK Runtime
  // part (no record here). The explicit "Clean up" action in the Import
  // dialog; nothing in the game is touched.
  cleanRuntimeCopy(dirName) {
    if (!/^[0-9a-f]+$/i.test(dirName)) throw new Error('Not a library entry.');
    const abs = path.join(this.store.libraryDir, dirName);
    if (!fs.existsSync(abs)) throw new Error('That library entry is gone.');
    if (this.store.getMod(dirName)) throw new Error('That library entry belongs to an installed mod — it was not removed.');
    const info = classifyFolder(abs, dirName);
    if (!isZcsdkRuntimeInfo(info)) throw new Error('That library entry is not a ZCSDK Runtime copy — it was not removed.');
    fs.rmSync(abs, { recursive: true, force: true });
    log('info', `removed an old ZCSDK Runtime copy from the mod archive: library/${dirName} (${(info.meta && info.meta.title) || info.name}${info.meta && info.meta.version ? ` v${info.meta.version}` : ''})`);
    return { name: (info.meta && info.meta.title) || info.name, version: (info.meta && info.meta.version) || null };
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
      const key = om.modType === 'zcu-addon' ? this._vaultKey(om) : `${om.modType}-${safeName(om.name || '').toLowerCase()}`;
      if (existingKeys.has(key)) { results.skipped.push(om.name); continue; }
      // The ZCSDK Runtime comes from Settings → ZCSDK Runtime only.
      if (isZcsdkRuntimeRecord(om)) { results.skipped.push(om.name); continue; }
      const src = path.join(dataDir, 'library', om.id);
      if (!fs.existsSync(src)) { results.errors.push(`${om.name}: library folder missing in the old data`); continue; }
      try {
        const res = await this.install(src, {
          skipFomod: true,
          origin: om.origin && om.origin.type !== 'local' ? om.origin : undefined,
          version: om.version || undefined,
          metaOverride: { title: om.name },
          keepGameFiles: opts.keepGameFiles,
          // The library copy sits at the folder root: the folder comes from
          // the old record. A UE4SS mod keeps the folder it had there (older
          // data: where the old builds put it — its display name).
          ue4ssKeep: om.modType === 'ue4ss-mod' ? {
            ue4ssFolder: om.ue4ssFolder || safeName(om.name || 'Mod'),
            ue4ssOwnFolder: om.ue4ssOwnFolder || null,
            ue4ssFolderNoticeDismissed: om.ue4ssFolderNoticeDismissed || null,
          } : undefined,
          addonFolder: om.modType === 'zcu-addon' ? (om.addonFolder || undefined) : undefined,
          addonRoot: om.modType === 'zcu-addon' && om.addonRoot === 'mods' ? 'mods' : undefined,
          // A mod that was off comes back off, never deployed first (an
          // add-on only waiting for ZC Unlocked keeps waiting).
          keep: { enabled: !!om.enabled || !!om.needsZcu },
        });
        const mod = res.multi ? res.mods[0] : res;
        if (mod.keptGameFiles) results.kept.push(om.name);
        const stored = this.store.getMod(mod.id);
        if (om.origin) stored.origin = { ...om.origin };
        if (typeof om.eaCompatible === 'boolean') stored.eaCompatible = om.eaCompatible;
        if (om.launchers) stored.launchers = om.launchers;
        if (om.installedBuild) stored.installedBuild = om.installedBuild;
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
      if (isZcsdkRuntimeInfo(info)) { results.skipped.push(info.name); continue; }
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
    const BUILTIN = UE4SS_BUILTIN;
    const entries = [];

    // Manager-installed UE4SS mods (enabled only) — scan their canonical library copies.
    const managedDirNames = new Set();
    for (const mod of this.store.mods) {
      if (mod.modType !== 'ue4ss-mod') continue;
      managedDirNames.add(this.ue4ssFolderOf(mod).toLowerCase());
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
        // A bare ZC Unlocked add-on pack is not a UE4SS mod (UE4SS never runs it).
        if (bareAddonPackIni(dir)) continue;
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
    // The ZCSDK Runtime's parts are one dependency, not duplicates to tidy up.
    const BUILTIN = new Set([...UE4SS_BUILTIN, ...ZCSDK_PART_SET]);
    let modsTxt = '';
    try { modsTxt = fs.readFileSync(path.join(modsDir, 'mods.txt'), 'utf8'); } catch (_) {}
    const managedByDir = new Map();
    for (const mod of this.store.mods) {
      if (mod.modType === 'ue4ss-mod') managedByDir.set(this.ue4ssFolderOf(mod).toLowerCase(), mod);
    }

    const nodes = [];
    for (const dirent of fs.readdirSync(modsDir, { withFileTypes: true })) {
      if (!dirent.isDirectory()) continue;
      const lower = dirent.name.toLowerCase();
      if (BUILTIN.has(lower)) continue;
      const dir = path.join(modsDir, dirent.name);
      // Bare ZC Unlocked add-on packs: their duplicates are reported by
      // addonDuplicateGroups (add-on identity), not as UE4SS mods.
      if (bareAddonPackIni(dir)) continue;
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
      if (m.modType === 'ue4ss-mod' || m.modType === 'gfp' || m.modType === 'zcu-addon') continue;
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
    const base = { installed: false, healthy: false, active: false, updateAvailable: false, parts: {}, signatures: null, sigsMissing: false, neededBy, bundled: bundledInfo, available };
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
      const managed = this.store.mods.find((m) => m.modType === 'ue4ss-mod' && this.ue4ssFolderOf(m).toLowerCase() === name.toLowerCase()) || null;
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
    return { ...base, installed, active, healthy, updateAvailable, parts, signatures, sigsMissing, message };
  }

  // Install (or refresh) the ZCSDK Runtime from a zip holding its two UE4SS mod
  // folders. Existing managed copies — including adopted dev copies whose
  // on-disk files drifted from the library — are vaulted and replaced by name,
  // so no duplicate folders appear; UE4SS start-order slots are kept. The only
  // path that may replace the runtime's parts; if it fails, the previous
  // runtime is put back as it was. A UE4SS_Signatures\ folder in the package
  // (v0.10+; see findZcsdkSigDir) goes to Win64\ue4ss\UE4SS_Signatures\ (see
  // ZCSDK_SIGS_REL); a package without one leaves the signature files already
  // placed as they are.
  async installZcsdkRuntime(zipPath, version) {
    if (!this.gamePath()) throw new Error('Set the game folder first (Settings).');
    if (!this.ue4ssStatus().installed) throw new Error('Install UE4SS first — the ZCSDK Runtime is a pair of UE4SS mods.');
    this._assertGameClosed('installing the ZCSDK Runtime');
    const zcsdk = require('./zcsdk');
    // install() takes only the two mod folders out of the package; stage it
    // once more for its signature files (before anything is replaced, so an
    // unreadable package changes nothing).
    const sigStage = path.join(this.store.stagingDir, `zcsdk-sigs-${newId()}`);
    this._runtimeOp += 1;
    try {
      await extractArchive(zipPath, sigStage, this.store.settings.sevenZipPath);
      const sigSrc = findZcsdkSigDir(sigStage);
      const sigDirOurs = this._zcsdkSignaturesRecord().createdDir;
      const names = new Set(zcsdk.PARTS.map((n) => n.toLowerCase()));
      const existing = this.store.mods.filter((m) => m.modType === 'ue4ss-mod' && names.has(this.ue4ssFolderOf(m).toLowerCase()));
      const keep = new Map(existing.map((m) => [this.ue4ssFolderOf(m).toLowerCase(), m.ue4ssPriority]));
      const caps = existing.map((m) => this._captureForReplace(m));
      const before = new Set(this.store.mods.map((m) => m.id));
      let mods;
      try {
        for (const cap of caps) {
          // force: a dev copy on disk may differ from the library. The
          // signature files stay while the parts are swapped
          // (_installZcsdkSignatures below decides what happens to them).
          this.uninstall(cap.record.id, true, { keepZcsdkSigs: true });
          cap.removed = true;
        }
        const res = await this.install(zipPath, {
          skipFomod: true, version: version || undefined,
          origin: { type: 'local', bundled: 'zcsdk-runtime' },
          keepFor: (name) => {
            const prio = keep.get(safeName(name).toLowerCase());
            return prio != null ? { ue4ssPriority: prio } : null;
          },
        });
        mods = (res.multi ? res.mods : [res]).filter((m) => m && m.id);
        const got = new Set(mods.map((m) => this.ue4ssFolderOf(m).toLowerCase()));
        if (!zcsdk.PARTS.every((n) => got.has(n.toLowerCase()))) {
          throw new Error(`The runtime package did not contain both ${zcsdk.PARTS.join(' and ')}.`);
        }
        const off = mods.filter((m) => !this.store.getMod(m.id).enabled);
        if (off.length) throw new Error(`${off.map((m) => m.name).join(' and ')} could not be switched on.`);
      } catch (err) {
        this._restoreReplaced(caps, before);
        // No part left at all (nothing to put back): its signatures go too.
        if (!this.store.mods.some((m) => this._isZcsdkPart(m))) this._removeZcsdkSignatures();
        throw new Error(`${err.message}${caps.length ? ' The previous ZCSDK Runtime was put back as it was.' : ''}`);
      }
      this.store.save();
      this._syncUe4ssModsTxt();
      let signatures;
      try {
        signatures = this._installZcsdkSignatures(sigSrc, version, sigDirOurs);
      } catch (err) {
        throw new Error(`The ZCSDK Runtime's mods were installed, but its UE4SS signature files could not be placed in ue4ss\\UE4SS_Signatures (${err.message}) — without them UE4SS mods do not run on the current game build. Install the runtime again.`);
      }
      return { mods: mods.map((m) => this.store.getMod(m.id)), replaced: existing.length, signatures, status: this.zcsdkStatus() };
    } finally {
      this._runtimeOp -= 1;
      fs.rmSync(sigStage, { recursive: true, force: true });
    }
  }

  // Settings → ZCSDK Runtime → Remove: both parts go together (never one of
  // them alone). The UI confirms first, listing the SDK mods that stop
  // working. Parts this app did not install (no record here) are left alone
  // and reported.
  removeZcsdkRuntime() {
    if (!this.gamePath()) throw new Error('Set the game folder first (Settings).');
    this._assertGameClosed('removing the ZCSDK Runtime');
    const recs = this.store.mods.filter((m) => isZcsdkRuntimeRecord(m));
    const sigsBefore = this.zcsdkSignatureNames().length;
    this._runtimeOp += 1;
    const removed = [];
    try {
      for (const r of recs) {
        if (!this.store.getMod(r.id)) continue;
        this.uninstall(r.id, true);
        removed.push(r.name);
      }
      // Its UE4SS signature files go with it (the last part's uninstall
      // already did this; also when no part was left on record).
      if (!this.store.mods.some((m) => isZcsdkRuntimeRecord(m))) this._removeZcsdkSignatures();
    } finally {
      this._runtimeOp -= 1;
    }
    const st = this.zcsdkStatus();
    const leftover = Object.entries(st.parts || {}).filter(([, p]) => p.present).map(([n]) => n);
    const signaturesRemoved = Math.max(0, sigsBefore - this.zcsdkSignatureNames().length);
    return { removed, leftover, signaturesRemoved, dependents: this.runtimeDependents().map((m) => m.name), status: st };
  }

  // Does this runtime package (lib/zcsdk.js descriptor) ship UE4SS signature
  // files? Every release from ZCSDK_SIGS_SINCE on does.
  zcsdkPackageHasSignatures(pkg) {
    return !!(pkg && pkg.version) && require('./zcsdk').compareRuntimeVersions(pkg.version, ZCSDK_SIGS_SINCE) >= 0;
  }

  // Self-heal: what to do when installed SDK mods need the runtime and it is
  // missing, incomplete or switched off. pkg = the package an install would
  // use now (lib/zcsdk.js availableRuntime) or null.
  //   { action: 'none' }                 — nothing needed / nothing possible
  //   { action: 'enable', ids }          — this app's own parts are there (and
  //                                         not older than pkg): switch them on
  //                                         / redeploy their missing files
  //   { action: 'install' }              — reinstall from pkg
  zcsdkHealPlan(pkg) {
    const deps = this.runtimeDependents();
    if (!deps.length || !this.gamePath()) return { action: 'none', reason: 'not needed' };
    if (!this.ue4ssStatus().installed) return { action: 'none', reason: 'UE4SS is not installed' };
    const zcsdk = require('./zcsdk');
    const recs = zcsdk.PARTS.map((n) => this.store.mods.find((m) => m.modType === 'ue4ss-mod' && this.ue4ssFolderOf(m).toLowerCase() === n.toLowerCase()) || null);
    const st = this.zcsdkStatus();
    const filesMissing = (r) => (r.deployed || []).some((rel) => !fs.existsSync(this.gameAbs(rel)));
    const broken = recs.some((r) => r && (!r.enabled || filesMissing(r)));
    // Its UE4SS signature files are missing and the package would bring them
    // (a runtime from before this app placed them, or a file deleted by hand):
    // without them UE4SS mods do not run on the current game build.
    const sigsFixable = st.sigsMissing && this.zcsdkPackageHasSignatures(pkg);
    if (st.installed && st.active && !broken && !sigsFixable) return { action: 'none', reason: 'healthy', dependents: deps.length };
    const wants = [pkg && pkg.bridge, pkg && pkg.loader];
    const usable = recs.every((r, i) => r && !this.storedCopyMissing(r)
      && (!wants[i] || !r.version || zcsdk.compareRuntimeVersions(r.version, wants[i]) >= 0));
    if (usable && !sigsFixable) return { action: 'enable', ids: recs.map((r) => r.id), reason: st.message, dependents: deps.length };
    return { action: 'install', reason: st.message, dependents: deps.length, hadRecords: recs.some(Boolean), sigsMissing: sigsFixable };
  }

  // The 'enable' heal: switch this app's runtime parts back on and redeploy
  // any of their files that went missing. A part whose files in the game were
  // changed outside Mod Command (a newer runtime build deployed by the Mod
  // SDK, or by hand) is never overwritten with the stored copy: it is left as
  // it is and listed in `skipped`. Returns { fixed, skipped } (names).
  healZcsdkParts(ids) {
    this._assertGameClosed('restoring the ZCSDK Runtime');
    const fixed = [];
    const skipped = [];
    this._runtimeOp += 1;
    try {
      for (const id of ids) {
        const r = this.store.getMod(id);
        if (!r) continue;
        const repair = !r.enabled || (r.deployed || []).some((rel) => !fs.existsSync(this.gameAbs(rel)));
        if (!repair) continue;
        const d = r.enabled ? this._deploymentDrift(r, { hash: true }) : this._targetDrift(r);
        if (d.changed.length || d.foreign.length) {
          skipped.push(r.name);
          log('warn', `ZCSDK Runtime self-heal skipped ${r.name}: its files in the game were changed outside Mod Command (${this._driftList(d)}) — left as they are`);
          continue;
        }
        if (!r.enabled) this._setEnabledCore(r.id, true);
        else this._deployMod(r, { skipIdentical: true });
        fixed.push(r.name);
      }
    } finally {
      this._runtimeOp -= 1;
    }
    this.store.save();
    this._syncUe4ssModsTxt();
    return { fixed, skipped };
  }

  // The ZCSDK Runtime parts this app has records of whose files in the game
  // were changed outside Mod Command (present, but not the stored bytes).
  // The silent self-heal reinstall leaves such a runtime alone.
  zcsdkPartsChangedOutside() {
    const out = [];
    for (const r of this.store.mods.filter((m) => isZcsdkRuntimeRecord(m))) {
      if (this.storedCopyMissing(r)) continue;
      const d = r.enabled ? this._deploymentDrift(r, { hash: true }) : this._targetDrift(r);
      if (d.changed.length || d.foreign.length) out.push({ name: r.name, files: [...d.changed, ...d.foreign] });
    }
    return out;
  }

  // Is this library entry a part of the ZCSDK Runtime?
  _isZcsdkPart(mod) {
    return isZcsdkRuntimeRecord(mod);
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

  // The same for a game-relative path (a mod's deployed list).
  _zcsdkOwnedGameRel(rel) {
    const win64 = WIN64_REL.toLowerCase() + path.sep;
    const l = String(rel).split(/[\\/]+/).join(path.sep);
    if (!l.toLowerCase().startsWith(win64)) return null;
    return this._zcsdkOwnedSig(l.slice(win64.length));
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
    // Nor are the ZCSDK Runtime's own signature files (placed by its
    // installer, unchanged since): never snapshotted, replaced or removed as
    // UE4SS's — a UE4SS restore leaves them where they are.
    const owned = new Set(this.zcsdkSignatureNames().map((n) => path.join('ue4ss', 'UE4SS_Signatures', n).toLowerCase()));
    return [...seen.values()].filter((rel) => !this._ue4ssSdkGenerated(rel) && !owned.has(rel.toLowerCase()));
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
      version = execFileSync(p, ['--version'], { encoding: 'utf8', timeout: 10000, windowsHide: true }).trim();
    } catch (_) {}
    return { found: true, path: p, version };
  }

  auditDeployedFiles() {
    // Verify every enabled mod's deployed files still exist.
    const missing = [];
    for (const m of this.store.mods.filter((x) => this._isDeployed(x))) {
      for (const rel of m.deployed || []) {
        if (!fs.existsSync(this.gameAbs(rel))) missing.push({ modId: m.id, modName: m.name, file: rel });
      }
    }
    return missing;
  }
}

module.exports = { ModEngine, GAME_UNKNOWN_MESSAGE, isZcsdkRuntimeRecord, classifyFolder, libraryFallbackName, parseAddonIni, setAddonIniEnabled, addonIniNormalized, addonKeyOf, ZCU_REL, ZCU_ADDONS_REL, zcsdkMeta, isSidecar, compareVersions, mergeModsTxt, mergeUe4ssSettings, MODS_REL, LOGIC_MODS_REL, WIN64_REL, UE4SS_MODS_REL, GAME_MODS_REL };

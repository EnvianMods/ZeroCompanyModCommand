'use strict';
// Config file discovery + safe read/save for the Config Editor (INI editor).

const fs = require('fs');
const path = require('path');

const EDITABLE_EXTS = new Set(['.ini', '.json', '.txt', '.cfg', '.toml', '.yml', '.yaml', '.lua']);

// Inside a UE4SS mod folder, which files count as "config"? Mods keep their
// settings next to the code that reads them: DLL mods in dlls\ (ZCUnlocked
// ships dlls\settings.ini), Lua mods in Scripts\ (Scripts\config.lua) or a
// settings folder (MXM\settings.lua, ModSettings\settings.lua). So every
// folder is scanned; plain data/config extensions always count, and a .lua
// counts only when its NAME says config — main.lua, ui.lua and the like are
// code, not settings.
const CONFIG_LUA_NAME = /^(config|settings?|options?|conf|prefs?|preferences|user[-_]?config|user[-_]?settings)\b/i;
const SKIP_NAMES = new Set(['enabled.txt', 'modinfo.json', 'mods.txt', 'mods.json']);
function isModConfigFile(name) {
  const lower = name.toLowerCase();
  const ext = path.extname(lower);
  if (SKIP_NAMES.has(lower) || lower.endsWith('.md') || lower.endsWith('.log')) return false;
  if (ext === '.lua') return CONFIG_LUA_NAME.test(path.basename(lower, ext));
  return EDITABLE_EXTS.has(ext);
}

function savedConfigDir() {
  return path.join(process.env.LOCALAPPDATA || '', 'SWZeroCompany', 'Saved', 'Config', 'Windows');
}

function entry(group, label, filePath, canCreate, note) {
  let exists = false;
  let size = 0;
  let mtime = null;
  try {
    const st = fs.statSync(filePath);
    exists = st.isFile();
    size = st.size;
    mtime = st.mtimeMs;
  } catch (_) {}
  return { group, label, path: filePath, exists, canCreate: !!canCreate, size, mtime, note: note || null };
}

// Enumerate everything the editor offers. Also serves as the allow-list for read/save.
function listConfigFiles(gamePath, customPaths) {
  const out = [];
  const saved = savedConfigDir();

  // UE per-user override configs — created on demand; Engine.ini is the classic mod target.
  out.push(entry('Game configuration', 'Engine.ini', path.join(saved, 'Engine.ini'), true,
    'User engine overrides — many performance/tweak mods ask for entries here'));
  out.push(entry('Game configuration', 'GameUserSettings.ini', path.join(saved, 'GameUserSettings.ini'), true,
    'Graphics and game settings the game writes'));
  out.push(entry('Game configuration', 'Input.ini', path.join(saved, 'Input.ini'), true,
    'User input binding overrides'));
  out.push(entry('Game configuration', 'Scalability.ini', path.join(saved, 'Scalability.ini'), true,
    'Per-quality-level scalability overrides'));

  if (gamePath) {
    const ue4ssRoot = path.join(gamePath, 'SWZeroCompany', 'Binaries', 'Win64', 'ue4ss');
    out.push(entry('UE4SS', 'UE4SS-settings.ini', path.join(ue4ssRoot, 'UE4SS-settings.ini'), false,
      'UE4SS runtime settings'));
    out.push(entry('UE4SS', 'Mods/mods.txt', path.join(ue4ssRoot, 'Mods', 'mods.txt'), false,
      'UE4SS mod load order (Name : 1 enables)'));

    // Config-ish files inside each UE4SS mod folder (every subfolder, 4 deep —
    // dlls\ and Scripts\ included, see isModConfigFile).
    const modsDir = path.join(ue4ssRoot, 'Mods');
    try {
      for (const dirent of fs.readdirSync(modsDir, { withFileTypes: true })) {
        if (!dirent.isDirectory() || dirent.name.toLowerCase() === 'shared') continue;
        const modDir = path.join(modsDir, dirent.name);
        const stack = [{ dir: modDir, depth: 0 }];
        while (stack.length) {
          const { dir, depth } = stack.pop();
          let children = [];
          try { children = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { continue; }
          for (const child of children) {
            const childPath = path.join(dir, child.name);
            if (child.isDirectory()) {
              if (depth < 4) stack.push({ dir: childPath, depth: depth + 1 });
              continue;
            }
            if (!isModConfigFile(child.name)) continue;
            out.push(entry(`Mod: ${dirent.name}`, path.relative(modDir, childPath), childPath, false));
          }
        }
      }
    } catch (_) {}
  }

  for (const p of customPaths || []) {
    out.push(entry('Custom', path.basename(p), p, false, path.dirname(p)));
  }
  return out;
}

function assertAllowed(filePath, gamePath, customPaths) {
  const allowed = new Set(listConfigFiles(gamePath, customPaths).map((e) => path.resolve(e.path).toLowerCase()));
  if (!allowed.has(path.resolve(filePath).toLowerCase())) {
    throw new Error('That file is not in the editable configuration list.');
  }
}

function readConfig(filePath, gamePath, customPaths) {
  assertAllowed(filePath, gamePath, customPaths);
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null; // creatable slot
    throw err;
  }
}

// Saves with a one-time .zcbak of the original file (first save only).
function saveConfig(filePath, content, gamePath, customPaths) {
  assertAllowed(filePath, gamePath, customPaths);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const backup = filePath + '.zcbak';
  if (fs.existsSync(filePath) && !fs.existsSync(backup)) {
    fs.copyFileSync(filePath, backup);
  }
  fs.writeFileSync(filePath, content, 'utf8');
  return { backedUp: fs.existsSync(backup) };
}

module.exports = { listConfigFiles, readConfig, saveConfig, isModConfigFile, EDITABLE_EXTS };

'use strict';
// Steam installation + game detection for STAR WARS: Zero Company (AppID 2075800).

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const APP_ID = '2075800';
const GAME_DIR_NAME = 'Star Wars Zero Company';
const GAME_EXE_REL = path.join('SWZeroCompany', 'Binaries', 'Win64', 'SWZeroCompany.exe');

function findSteamRoot() {
  // Registry first, then common paths.
  try {
    const out = execFileSync('reg', ['query', 'HKCU\\Software\\Valve\\Steam', '/v', 'SteamPath'], { encoding: 'utf8' });
    const m = out.match(/SteamPath\s+REG_SZ\s+(.+)/i);
    if (m) {
      const p = m[1].trim().replace(/\//g, '\\');
      if (fs.existsSync(p)) return p;
    }
  } catch (_) { /* registry key missing */ }
  const guesses = [
    'C:\\Program Files (x86)\\Steam',
    'C:\\Program Files\\Steam',
  ];
  for (const g of guesses) if (fs.existsSync(g)) return g;
  return null;
}

function parseLibraryFolders(steamRoot) {
  const libs = [path.join(steamRoot, 'steamapps')];
  const vdf = path.join(steamRoot, 'steamapps', 'libraryfolders.vdf');
  try {
    const text = fs.readFileSync(vdf, 'utf8');
    const re = /"path"\s+"([^"]+)"/g;
    let m;
    while ((m = re.exec(text)) !== null) {
      const lib = path.join(m[1].replace(/\\\\/g, '\\'), 'steamapps');
      if (fs.existsSync(lib) && !libs.includes(lib)) libs.push(lib);
    }
  } catch (_) { /* no vdf */ }
  return libs;
}

function readAppManifest(steamappsDir) {
  const manifest = path.join(steamappsDir, `appmanifest_${APP_ID}.acf`);
  if (!fs.existsSync(manifest)) return null;
  try {
    const text = fs.readFileSync(manifest, 'utf8');
    const get = (key) => {
      const m = text.match(new RegExp(`"${key}"\\s+"([^"]*)"`));
      return m ? m[1] : null;
    };
    return {
      manifestPath: manifest,
      installdir: get('installdir'),
      buildId: get('buildid'),
      stateFlags: get('StateFlags'),
      name: get('name'),
    };
  } catch (_) {
    return null;
  }
}

// Returns { found, gamePath, buildId, manifest, exePath, source }
function detectGame(configuredPath) {
  // 1. Configured path wins if it looks valid.
  if (configuredPath && isValidGamePath(configuredPath)) {
    const result = {
      found: true,
      gamePath: configuredPath,
      exePath: path.join(configuredPath, GAME_EXE_REL),
      buildId: null,
      manifest: null,
      source: 'configured',
    };
    attachManifest(result);
    return result;
  }
  // 2. Steam scan.
  const steamRoot = findSteamRoot();
  if (steamRoot) {
    for (const lib of parseLibraryFolders(steamRoot)) {
      const man = readAppManifest(lib);
      const dirName = man && man.installdir ? man.installdir : GAME_DIR_NAME;
      const candidate = path.join(lib, 'common', dirName);
      if (isValidGamePath(candidate)) {
        return {
          found: true,
          gamePath: candidate,
          exePath: path.join(candidate, GAME_EXE_REL),
          buildId: man ? man.buildId : null,
          manifest: man,
          source: 'steam',
        };
      }
    }
  }
  return { found: false, gamePath: null, exePath: null, buildId: null, manifest: null, source: null };
}

function attachManifest(result) {
  // Locate the manifest for a configured path by scanning libraries.
  const steamRoot = findSteamRoot();
  if (!steamRoot) return;
  for (const lib of parseLibraryFolders(steamRoot)) {
    const man = readAppManifest(lib);
    if (!man) continue;
    const candidate = path.join(lib, 'common', man.installdir || GAME_DIR_NAME);
    if (path.resolve(candidate).toLowerCase() === path.resolve(result.gamePath).toLowerCase()) {
      result.manifest = man;
      result.buildId = man.buildId;
      return;
    }
  }
}

function isValidGamePath(p) {
  try {
    return fs.existsSync(path.join(p, GAME_EXE_REL));
  } catch (_) {
    return false;
  }
}

module.exports = { APP_ID, GAME_EXE_REL, detectGame, isValidGamePath };

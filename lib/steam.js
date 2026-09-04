'use strict';
// Steam installation + game detection for STAR WARS: Zero Company (AppID 2075800).
// Works on Windows and on Linux/Steam Deck, where the Windows game runs under Proton.

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const APP_ID = '2075800';
const GAME_DIR_NAME = 'Star Wars Zero Company';
const GAME_EXE_REL = path.join('SWZeroCompany', 'Binaries', 'Win64', 'SWZeroCompany.exe');

function findSteamRoot() {
  if (process.platform === 'linux') {
    const home = os.homedir();
    const guesses = [
      path.join(home, '.local', 'share', 'Steam'),                                   // native (incl. Steam Deck)
      path.join(home, '.steam', 'steam'),                                            // classic symlink
      path.join(home, '.steam', 'root'),
      path.join(home, '.var', 'app', 'com.valvesoftware.Steam', '.local', 'share', 'Steam'), // flatpak
    ];
    for (const g of guesses) {
      try { if (fs.existsSync(path.join(g, 'steamapps'))) return g; } catch (_) {}
    }
    return null;
  }
  // Windows: registry first, then common paths.
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

// Fallback build identity when no Steam manifest covers the install (EA App,
// manual copies): a short fingerprint of the game exe. Changes whenever the exe
// does, which is what the "installed under a different build" warning needs.
function buildFingerprint(gamePath) {
  try {
    const st = fs.statSync(path.join(gamePath, GAME_EXE_REL));
    return 'local-' + crypto.createHash('sha1')
      .update(`${st.size}:${Math.floor(st.mtimeMs)}`)
      .digest('hex').slice(0, 8);
  } catch (_) { return null; }
}

// Proton state for a Linux install: has the game's compat prefix been created?
function protonInfo(steamRoot) {
  if (process.platform !== 'linux' || !steamRoot) return null;
  for (const lib of parseLibraryFolders(steamRoot)) {
    const compat = path.join(lib, 'compatdata', APP_ID);
    try { if (fs.existsSync(compat)) return { compatdata: compat }; } catch (_) {}
  }
  return { compatdata: null };
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

// Returns { found, gamePath, buildId, manifest, exePath, source, launcher, proton }
// launcher: 'steam' | 'ea' | 'manual' — how the install is owned/updated.
// buildId: Steam manifest buildid, else a local exe fingerprint ('local-…').
function detectGame(configuredPath) {
  const finish = (result) => {
    if (result.found) {
      if (!result.launcher) {
        if (result.manifest) result.launcher = 'steam';
        else {
          const ea = require('./ea');
          result.launcher = ea.isEAInstall(result.gamePath) ? 'ea' : 'manual';
        }
      }
      if (!result.buildId) result.buildId = buildFingerprint(result.gamePath);
      result.proton = protonInfo(findSteamRoot());
    }
    return result;
  };

  // 1. Configured path wins if it looks valid.
  if (configuredPath && isValidGamePath(configuredPath)) {
    const result = {
      found: true,
      gamePath: configuredPath,
      exePath: path.join(configuredPath, GAME_EXE_REL),
      buildId: null,
      manifest: null,
      source: 'configured',
      launcher: null,
    };
    attachManifest(result);
    return finish(result);
  }
  // 2. Steam scan.
  const steamRoot = findSteamRoot();
  if (steamRoot) {
    for (const lib of parseLibraryFolders(steamRoot)) {
      const man = readAppManifest(lib);
      const dirName = man && man.installdir ? man.installdir : GAME_DIR_NAME;
      const candidate = path.join(lib, 'common', dirName);
      if (isValidGamePath(candidate)) {
        return finish({
          found: true,
          gamePath: candidate,
          exePath: path.join(candidate, GAME_EXE_REL),
          buildId: man ? man.buildId : null,
          manifest: man,
          source: 'steam',
          launcher: 'steam',
        });
      }
    }
  }
  // 3. EA App scan (Windows only — the EA App does not exist on Linux).
  const ea = require('./ea');
  const eaHit = ea.detectEAGame();
  if (eaHit) {
    return finish({
      found: true,
      gamePath: eaHit,
      exePath: path.join(eaHit, GAME_EXE_REL),
      buildId: null,
      manifest: null,
      source: 'ea',
      launcher: 'ea',
    });
  }
  return { found: false, gamePath: null, exePath: null, buildId: null, manifest: null, source: null, launcher: null, proton: null };
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

module.exports = { APP_ID, GAME_EXE_REL, detectGame, isValidGamePath, buildFingerprint };

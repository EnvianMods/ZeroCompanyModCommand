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
    const out = execFileSync('reg', ['query', 'HKCU\\Software\\Valve\\Steam', '/v', 'SteamPath'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
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
  // A path shaped like <library>/steamapps/common/<game> carries its manifest
  // right next to it — covers libraries Steam's own config doesn't list
  // (moved drives, secondary installs).
  const parentCommon = path.dirname(result.gamePath);
  const steamappsDir = path.dirname(parentCommon);
  if (path.basename(parentCommon).toLowerCase() === 'common'
    && path.basename(steamappsDir).toLowerCase() === 'steamapps') {
    const man = readAppManifest(steamappsDir);
    if (man) {
      result.manifest = man;
      result.buildId = man.buildId;
      return;
    }
  }
  // Otherwise scan the libraries Steam knows about.
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

// ---------------------------------------------------------------- update freeze
// Opt-in protection against the game auto-updating overnight and breaking a
// modded playthrough. Two levers, both reversible:
//  1. AutoUpdateBehavior "1" in the appmanifest — Steam's own "only update
//     this game when I launch it" setting.
//  2. The appmanifest file is made read-only, so Steam cannot mark an update
//     as pending behind the user's back.
// While frozen, the manager launches the game exe directly instead of
// steam://run (a Steam-initiated launch is what triggers the update check).
// Honest limits: Steam can still force an update if the game is launched from
// the Steam UI itself, and online features may require the current build.
// Only Steam installs are supported — the EA App has no per-game mechanism
// (its own Settings → Downloads → automatic game updates toggle is global).

function _manifestFor(configuredPath) {
  const det = detectGame(configuredPath);
  return det.found && det.manifest ? det.manifest.manifestPath : null;
}

function updateFreezeStatus(configuredPath) {
  const manifestPath = _manifestFor(configuredPath);
  if (!manifestPath) return { supported: false, frozen: false, behavior: null };
  let frozen = false;
  let behavior = null;
  try {
    const st = fs.statSync(manifestPath);
    frozen = (st.mode & 0o200) === 0; // owner-write bit off = read-only
    const m = fs.readFileSync(manifestPath, 'utf8').match(/"AutoUpdateBehavior"\s+"(\d)"/);
    behavior = m ? m[1] : null;
  } catch (_) {}
  return { supported: true, frozen, behavior, manifestPath };
}

function setUpdateFreeze(configuredPath, freeze) {
  const manifestPath = _manifestFor(configuredPath);
  if (!manifestPath) {
    throw new Error('Update freezing needs a Steam install (no appmanifest found). EA App users: disable automatic game updates in the EA App settings instead.');
  }
  try { fs.chmodSync(manifestPath, 0o644); } catch (_) {}
  let text = fs.readFileSync(manifestPath, 'utf8');
  const desired = freeze ? '1' : '0';
  if (/"AutoUpdateBehavior"\s+"\d"/.test(text)) {
    text = text.replace(/"AutoUpdateBehavior"\s+"\d"/, `"AutoUpdateBehavior"\t\t"${desired}"`);
  } else {
    text = text.replace(/("StateFlags"\s+"\d+")/, `$1\n\t"AutoUpdateBehavior"\t\t"${desired}"`);
  }
  fs.writeFileSync(manifestPath, text);
  if (freeze) fs.chmodSync(manifestPath, 0o444);
  return updateFreezeStatus(configuredPath);
}

// Is Zero Company running right now? Everything that takes mods out of the
// game or puts them back asks first (the game has UE4SS's dlls and every
// mounted pak loaded). The answer is one of
//   'running' | 'not-running' | 'unknown'
// and 'unknown' (the check could not finish) must be treated as running by
// anything that changes files — a check that fails must never let a change
// through under a running game.
//
// Windows, primary: the game's own exe files. Windows never lets a running
// image be opened for writing (ERROR_SHARING_VIOLATION -> EBUSY), so trying
// to open each exe of THIS install read-write and closing it again (nothing
// is written) answers instantly, spawns nothing and only counts a copy
// started from this folder: one locked exe = running; every exe present and
// openable = not running. Access denied (EPERM/EACCES, e.g. a protected
// folder) or no exe found = no answer from this check.
// Secondary (Windows, when the lock check has no answer): one PowerShell CIM
// query for the game's processes by name with their image paths (a match
// whose path cannot be read counts as running). Linux/Proton: ps (a Proton
// game shows up under its .exe name; Wine does not lock exe files). A probe
// that fails or times out answers 'unknown'.
// Results are cached for a few seconds (one operation asks several times);
// { force: true } skips the cache ("Check again").
const GAME_PROCESS_NAMES = ['SWZeroCompany.exe', 'SWZeroCompany-Win64-Shipping.exe'];
const GAME_EXE_CANDIDATES = [
  'SWZeroCompany.exe',                                                              // launcher stub
  GAME_EXE_REL,                                                                     // the game itself
  path.join('SWZeroCompany', 'Binaries', 'Win64', 'SWZeroCompany-Win64-Shipping.exe'), // Unreal's usual name
];
const GAME_RUNNING_CACHE_MS = 3000;
const PROCESS_QUERY_TIMEOUT_MS = 8000;
let _gameRunningCache = null; // { key, at, result }
let _gameRunningLog = null;   // (level, message) — main.js wires its log
// Tests: replace a probe ({ lockCheck, processQuery } -> functions with the
// same contract) or force the platform.
let _probeOverrides = {};

function _lockCheck(gamePath) {
  let present = 0;
  let inconclusive = null;
  for (const rel of GAME_EXE_CANDIDATES) {
    const exe = path.join(gamePath, rel);
    if (!fs.existsSync(exe)) continue;
    present += 1;
    let fd = null;
    try {
      fd = fs.openSync(exe, 'r+'); // read-write open only; nothing is written
    } catch (err) {
      if (err && err.code === 'EBUSY') return { state: 'running', detail: `${rel} is in use` };
      inconclusive = `${rel}: ${err && err.code ? err.code : err}`;
    } finally {
      if (fd !== null) { try { fs.closeSync(fd); } catch (_) {} }
    }
  }
  if (inconclusive) return { state: 'unknown', detail: inconclusive };
  if (!present) return { state: 'unknown', detail: 'no game exe found' };
  return { state: 'not-running', detail: `${present} exe file${present === 1 ? '' : 's'} not in use` };
}

function _processQueryWin(gamePath) {
  const filter = GAME_PROCESS_NAMES.map((n) => `Name='${n}'`).join(' OR ');
  // "#ok" proves the query itself finished (an empty answer is then real).
  const script = `$ErrorActionPreference='Stop'; Get-CimInstance Win32_Process -Filter "${filter}" | ForEach-Object { 'P|' + $_.ExecutablePath }; '#ok'`;
  const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
    { encoding: 'utf8', timeout: PROCESS_QUERY_TIMEOUT_MS, windowsHide: true });
  const lines = out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (!lines.includes('#ok')) return { state: 'unknown', detail: 'process query gave no answer' };
  const procs = lines.filter((l) => l.startsWith('P|')).map((l) => l.slice(2));
  if (!procs.length) return { state: 'not-running', detail: 'no game process' };
  if (!gamePath) return { state: 'running', detail: 'game process found' };
  const root = path.resolve(gamePath).toLowerCase() + path.sep;
  for (const p of procs) {
    if (!p) return { state: 'running', detail: 'game process found (path not readable)' };
    if (path.resolve(p).toLowerCase().startsWith(root)) return { state: 'running', detail: `game process ${p}` };
  }
  return { state: 'not-running', detail: 'game running from another folder only' };
}

function _processQueryPosix() {
  const out = execFileSync('ps', ['-A', '-o', 'args='], { encoding: 'utf8', timeout: PROCESS_QUERY_TIMEOUT_MS, windowsHide: true });
  const hit = out.split(/\n/).some((l) => /swzerocompany(?:-win64-shipping)?\.exe/i.test(l));
  return { state: hit ? 'running' : 'not-running', detail: hit ? 'game process found' : 'no game process' };
}

function gameRunningState(gamePath, { force = false } = {}) {
  const platform = _probeOverrides.platform || process.platform;
  const key = `${platform}|${gamePath ? path.resolve(gamePath).toLowerCase() : ''}`;
  const now = Date.now();
  if (!force && _gameRunningCache && _gameRunningCache.key === key && now - _gameRunningCache.at < GAME_RUNNING_CACHE_MS) {
    return { ..._gameRunningCache.result, cached: true };
  }
  const t0 = Date.now();
  const steps = [];
  let result = null;
  const run = (method, fn) => {
    const s = Date.now();
    let r;
    try { r = fn(); } catch (err) {
      r = { state: 'unknown', detail: err && err.code === 'ETIMEDOUT' ? `timed out after ${Date.now() - s} ms` : `failed: ${err && err.message ? err.message.split(/\r?\n/)[0] : err}` };
    }
    if (!r || !['running', 'not-running', 'unknown'].includes(r.state)) r = { state: 'unknown', detail: 'no answer' };
    steps.push(`${method} ${r.state} in ${Date.now() - s} ms (${r.detail})`);
    return { ...r, method };
  };
  if (platform === 'win32') {
    if (gamePath) result = run('exe-lock', () => (_probeOverrides.lockCheck || _lockCheck)(gamePath));
    if (!result || result.state === 'unknown') result = run('process-query', () => (_probeOverrides.processQuery || _processQueryWin)(gamePath));
  } else {
    result = run('ps', () => (_probeOverrides.processQuery || _processQueryPosix)(gamePath));
  }
  const out = { state: result.state, method: result.method, ms: Date.now() - t0, detail: steps.join('; ') };
  _gameRunningCache = { key, at: Date.now(), result: out };
  if (_gameRunningLog) {
    try { _gameRunningLog(out.state === 'unknown' ? 'warn' : 'info', `game-running check: ${out.state} via ${out.method} in ${out.ms} ms — ${out.detail}`); } catch (_) {}
  }
  return out;
}

// Legacy boolean form: 'unknown' counts as running (the safe answer).
function isGameRunning(gamePath, opts) {
  return gameRunningState(gamePath, opts).state !== 'not-running';
}

function _setGameRunningLog(fn) { _gameRunningLog = typeof fn === 'function' ? fn : null; }
function _setGameRunningProbes(overrides) { _probeOverrides = overrides || {}; _gameRunningCache = null; }
function _clearGameRunningCache() { _gameRunningCache = null; }

module.exports = {
  APP_ID, GAME_EXE_REL, detectGame, isValidGamePath, buildFingerprint,
  updateFreezeStatus, setUpdateFreeze, isGameRunning, gameRunningState,
  _setGameRunningLog, _setGameRunningProbes, _clearGameRunningCache,
};

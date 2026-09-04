'use strict';
// EA App support: detect the EA-launcher edition of STAR WARS: Zero Company,
// and evaluate per-mod EA compatibility so Steam and EA users can share mods
// with clear expectations.
//
// Compatibility comes from two layers (modinfo wins over the community list):
//  1. A mod's own modinfo.json:  "eaCompatible": false   or   "launchers": ["steam"]
//  2. An owner-curated community list, fetched live like the featured roster:
//     ea-compat.json in the EnvianMods/SWZeroCompanyFeaturedAuthors repo:
//       { "incompatible": [{ "nexusModId": 123, "note": "uses Steam achievements API" }],
//         "compatible":   [{ "nexusModId": 456 }] }
//     Edit with owner-tools update-ea-compat.js — updates every launcher live.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const GAME_DIR_NAME = 'STAR WARS Zero Company';
const GAME_EXE_REL = path.join('SWZeroCompany', 'Binaries', 'Win64', 'SWZeroCompany.exe');

const REMOTE_COMPAT_URL = 'https://raw.githubusercontent.com/EnvianMods/SWZeroCompanyFeaturedAuthors/main/ea-compat.json';
const FALLBACK_COMPAT = { incompatible: [], compatible: [] };
const REMOTE_TTL_MS = 30 * 60 * 1000;

// An EA App install carries the __Installer folder (installerdata.xml inside)
// that EA's installer framework leaves in every game directory.
function isEAInstall(gamePath) {
  try {
    return fs.existsSync(path.join(gamePath, '__Installer'))
      || fs.existsSync(path.join(gamePath, 'installerdata.xml'))
      || fs.existsSync(path.join(gamePath, '__Installer', 'installerdata.xml'));
  } catch (_) { return false; }
}

function regQuery(key, value) {
  try {
    const out = execFileSync('reg', ['query', key, '/v', value], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const m = out.match(/REG_SZ\s+(.+)/i);
    return m ? m[1].trim() : null;
  } catch (_) { return null; }
}

// Locate the EA App edition of the game (Windows only).
function detectEAGame() {
  if (process.platform !== 'win32') return null;
  const candidates = [];
  // Registry: the game's own install key, both hives EA uses.
  for (const hive of ['HKLM\\SOFTWARE\\EA Games', 'HKLM\\SOFTWARE\\WOW6432Node\\EA Games']) {
    const p = regQuery(`${hive}\\${GAME_DIR_NAME}`, 'Install Dir');
    if (p) candidates.push(p.replace(/[\\/]+$/, ''));
  }
  // Common EA App library locations across drives (both dir-name casings seen in the wild).
  const drives = ['C:', 'D:', 'E:', 'F:', 'G:'];
  for (const d of drives) {
    for (const name of [GAME_DIR_NAME, 'Star Wars Zero Company']) {
      candidates.push(path.join(d, '\\', 'Program Files', 'EA Games', name));
      candidates.push(path.join(d, '\\', 'EA Games', name));
    }
  }
  for (const c of candidates) {
    try {
      if (fs.existsSync(path.join(c, GAME_EXE_REL)) && isEAInstall(c)) return c;
    } catch (_) {}
  }
  return null;
}

// Is the EA App itself installed? (informational; best-effort)
function eaAppPresent() {
  if (process.platform !== 'win32') return false;
  return !!(regQuery('HKLM\\SOFTWARE\\Electronic Arts\\EA Desktop', 'InstallLocation')
    || regQuery('HKLM\\SOFTWARE\\WOW6432Node\\Electronic Arts\\EA Desktop', 'InstallLocation')
    || fs.existsSync('C:\\Program Files\\Electronic Arts\\EA Desktop'));
}

// ---------------------------------------------------------------- compat list

let compatCache = { data: null, at: 0 };

// Synchronous read of the last-known list (baked fallback until a fetch lands).
function compatSync() {
  return compatCache.data || FALLBACK_COMPAT;
}

async function refreshCompat() {
  const now = Date.now();
  if (compatCache.data && now - compatCache.at < REMOTE_TTL_MS) return compatCache.data;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 6000);
    const res = await fetch(REMOTE_COMPAT_URL, { signal: controller.signal, cache: 'no-store' });
    clearTimeout(timer);
    if (res.ok) {
      const json = await res.json();
      const clean = (arr) => Array.isArray(arr)
        ? arr.filter((e) => e && Number.isInteger(e.nexusModId))
            .map((e) => ({ nexusModId: e.nexusModId, note: typeof e.note === 'string' ? e.note.slice(0, 200) : null }))
            .slice(0, 500)
        : [];
      compatCache = { data: { incompatible: clean(json.incompatible), compatible: clean(json.compatible) }, at: now };
    }
  } catch (_) { /* offline or 404 — keep whatever we have */ }
  return compatSync();
}

// Per-mod EA compatibility verdict.
// Returns { status: 'incompatible'|'compatible'|'unknown', note, source } —
// source is 'modinfo' (the author said so) or 'community' (the curated list).
function evaluateMod(mod, compat) {
  // 1. The mod's own declaration wins.
  if (mod.eaCompatible === false) return { status: 'incompatible', note: 'The mod author marked this Steam-only.', source: 'modinfo' };
  if (mod.eaCompatible === true) return { status: 'compatible', note: null, source: 'modinfo' };
  if (Array.isArray(mod.launchers) && mod.launchers.length) {
    const list = mod.launchers.map((l) => String(l).toLowerCase());
    return list.includes('ea')
      ? { status: 'compatible', note: null, source: 'modinfo' }
      : { status: 'incompatible', note: `The mod author supports: ${list.join(', ')}.`, source: 'modinfo' };
  }
  // 2. Community list, keyed by the mod's Nexus identity.
  const nexusId = mod.origin && mod.origin.type === 'nexus' ? mod.origin.modId : null;
  if (nexusId != null && compat) {
    const hit = (compat.incompatible || []).find((e) => e.nexusModId === nexusId);
    if (hit) return { status: 'incompatible', note: hit.note || 'Reported not to work on the EA App edition.', source: 'community' };
    const ok = (compat.compatible || []).find((e) => e.nexusModId === nexusId);
    if (ok) return { status: 'compatible', note: ok.note || null, source: 'community' };
  }
  return { status: 'unknown', note: null, source: null };
}

module.exports = { isEAInstall, detectEAGame, eaAppPresent, compatSync, refreshCompat, evaluateMod, FALLBACK_COMPAT };

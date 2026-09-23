'use strict';
// Launcher self-update check. The owner publishes launcher-version.json to the
// SWZeroCompanyFeaturedAuthors repo (owner-tools/update-launcher-version):
//   {
//     "latest": "1.2.0", "url": "https://www.nexusmods.com/...", "notes": "...",
//     "sdk": { "url": "<where to get the Mod SDK>", "updateUrl": "<sdk-version.json>" }
//   }
// Every installed launcher compares `latest` against its own version and shows
// an update banner when it's behind. The url can point anywhere — the Nexus mod
// page today, a GitHub releases page later — so the distribution channel can
// move without shipping a launcher update.
//
// The optional `sdk` block is the SAME idea for the SEPARATE Zero Company Mod
// SDK download: Mod Command hard-codes no destination for it either, it reads
// this block (see lib/sdk-link.js and docs/SDK_LINK.md). Both halves flip from
// GitHub to Nexus at launch by editing this one published file. Note that
// `info` below is built from KNOWN KEYS ONLY, so a launcher that shipped before
// a key existed simply ignores it — which is what makes adding one safe.

const VERSION_URL = 'https://raw.githubusercontent.com/EnvianMods/SWZeroCompanyFeaturedAuthors/main/launcher-version.json';
// Test-harness override, the same shape as main.js's ZC_DATA_DIR. Read at call
// time so a harness can point the check at a local fixture server.
function versionUrl() { return process.env.ZC_LAUNCHER_VERSION_URL || VERSION_URL; }
const CURRENT_VERSION = require('../package.json').version;

let cache = { info: null, at: 0 };
const TTL_MS = 60 * 60 * 1000;

function isNewer(latest, current) {
  const a = String(latest).replace(/^v/i, '').split('.').map((n) => parseInt(n, 10) || 0);
  const b = String(current).replace(/^v/i, '').split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    if ((a[i] || 0) > (b[i] || 0)) return true;
    if ((a[i] || 0) < (b[i] || 0)) return false;
  }
  return false;
}

function httpsOrNull(v) {
  return typeof v === 'string' && /^https:\/\//.test(v) ? v : null;
}

// The optional `sdk` block. Both fields are optional strings and both must be
// https://; anything else is ignored rather than trusted. A block with neither
// usable field is null, so callers only ever test one thing.
function parseSdkBlock(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const url = httpsOrNull(raw.url);
  const updateUrl = httpsOrNull(raw.updateUrl);
  if (!url && !updateUrl) return null;
  return { url, updateUrl };
}

// Returns { available, current, latest, url, notes, sdk } — never throws.
// `force` skips the TTL (the on-demand "check now" path and the harness).
async function checkLauncherUpdate({ force = false } = {}) {
  const base = { available: false, current: CURRENT_VERSION, latest: null, url: null, notes: null, sdk: null };
  const now = Date.now();
  if (!force && cache.info && now - cache.at < TTL_MS) return cache.info;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 6000);
    const res = await fetch(versionUrl(), { signal: controller.signal, cache: 'no-store' });
    clearTimeout(timer);
    if (res.ok) {
      const json = await res.json();
      if (json && json.latest) {
        const info = {
          available: isNewer(json.latest, CURRENT_VERSION),
          current: CURRENT_VERSION,
          latest: String(json.latest),
          url: httpsOrNull(json.url),
          notes: typeof json.notes === 'string' ? json.notes.slice(0, 300) : null,
          sdk: parseSdkBlock(json.sdk),
        };
        cache = { info, at: now };
        return info;
      }
    }
  } catch (_) { /* offline or not published — no banner */ }
  cache = { info: base, at: now };
  return base;
}

// The last answer we have, without touching the network — for the synchronous
// readers (sdk-link's status()). Null until the first check lands.
function cachedInfo() { return cache.info; }

module.exports = { checkLauncherUpdate, cachedInfo, isNewer, parseSdkBlock, CURRENT_VERSION };

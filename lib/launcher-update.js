'use strict';
// Launcher self-update check. The owner publishes launcher-version.json to the
// SWZeroCompanyFeaturedAuthors repo (owner-tools/update-launcher-version):
//   { "latest": "1.2.0", "url": "https://www.nexusmods.com/...", "notes": "..." }
// Every installed launcher compares that against its own version and shows an
// update banner when it's behind. The url can point anywhere — the Nexus mod
// page today, a GitHub releases page later — so the distribution channel can
// move without shipping a launcher update.

const VERSION_URL = 'https://raw.githubusercontent.com/EnvianMods/SWZeroCompanyFeaturedAuthors/main/launcher-version.json';
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

// Returns { available, current, latest, url, notes } — never throws.
async function checkLauncherUpdate() {
  const base = { available: false, current: CURRENT_VERSION, latest: null, url: null, notes: null };
  const now = Date.now();
  if (cache.info && now - cache.at < TTL_MS) return cache.info;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 6000);
    const res = await fetch(VERSION_URL, { signal: controller.signal, cache: 'no-store' });
    clearTimeout(timer);
    if (res.ok) {
      const json = await res.json();
      if (json && json.latest) {
        const info = {
          available: isNewer(json.latest, CURRENT_VERSION),
          current: CURRENT_VERSION,
          latest: String(json.latest),
          url: typeof json.url === 'string' && /^https:\/\//.test(json.url) ? json.url : null,
          notes: typeof json.notes === 'string' ? json.notes.slice(0, 300) : null,
        };
        cache = { info, at: now };
        return info;
      }
    }
  } catch (_) { /* offline or not published — no banner */ }
  cache = { info: base, at: now };
  return base;
}

module.exports = { checkLauncherUpdate, isNewer, CURRENT_VERSION };

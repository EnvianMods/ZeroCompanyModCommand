'use strict';
// The ZCSDK Runtime — two UE4SS mods (ZCSDKBridge + ZCSDKLoader) that content
// mods built with the Zero Company Mod SDK need at play time. The runtime finds
// each such mod's <Mod>.zcsdk.lua manifest next to its paks, loads the mod's
// pruned asset registry so the game can enumerate the new content, and grants
// the manifest's items once per save.
//
// Two sources, newest wins:
//  1. GitHub — EnvianMods/ZCSDK-Runtime-Release. The SDK publishes every
//     runtime build there (its tools/publish-runtime.py): a Release carrying
//     ZCSDKRuntime_v<x.y>.zip plus latest.json at the repo root
//     ({version, bridge, loader, asset, url, published}). Mod Command reads
//     latest.json at startup and on demand and downloads the release zip, so a
//     runtime update no longer waits for a Mod Command release.
//  2. Bundled — tools/ZCSDKRuntime.zip + tools/zcsdk-runtime.json ship with
//     the app (extraResources) as the offline fallback.

const fs = require('fs');
const path = require('path');

const RUNTIME_ZIP = 'ZCSDKRuntime.zip';
const RUNTIME_INFO = 'zcsdk-runtime.json';
const RELEASE_REPO = 'EnvianMods/ZCSDK-Runtime-Release';
const LATEST_URL = `https://raw.githubusercontent.com/${RELEASE_REPO}/main/latest.json`;
const RELEASES_URL = `https://github.com/${RELEASE_REPO}/releases`;

// UE4SS mod folder names the runtime consists of (both must be present).
const PARTS = ['ZCSDKBridge', 'ZCSDKLoader'];

const TTL_MS = 60 * 60 * 1000;   // a successful check is reused for an hour
const RETRY_MS = 5 * 60 * 1000;  // a failed check is retried after five minutes
let remote = { info: null, at: 0, ok: false };

function toolsDirs() {
  return [
    path.join(__dirname, '..', 'tools'),
    process.resourcesPath ? path.join(process.resourcesPath, 'tools') : null,
  ].filter(Boolean);
}

function str(v, max = 40) {
  return typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null;
}

// Numeric dotted compare ("0.10" > "0.9"); a missing version sorts lowest.
function compareRuntimeVersions(a, b) {
  if (!a && !b) return 0;
  if (!a) return -1;
  if (!b) return 1;
  const parse = (v) => String(v).replace(/^v/i, '').split('.').map((n) => parseInt(n, 10) || 0);
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] || 0) - (y[i] || 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}

// { source:'bundled', zip, version, bridge, loader, size } for the package
// shipped in tools/, or null when this build ships without one.
function bundledRuntime() {
  for (const dir of toolsDirs()) {
    const zip = path.join(dir, RUNTIME_ZIP);
    let exists = false;
    try { exists = fs.existsSync(zip); } catch (_) {}
    if (!exists) continue;
    let info = {};
    try { info = JSON.parse(fs.readFileSync(path.join(dir, RUNTIME_INFO), 'utf8')); } catch (_) {}
    return {
      source: 'bundled',
      zip,
      version: str(info.version),
      bridge: str(info.bridge),
      loader: str(info.loader),
      size: fs.statSync(zip).size,
    };
  }
  return null;
}

// Read latest.json from the release repo → { source:'github', version, bridge,
// loader, url, asset, published } or null. Never throws; cached (an hour after
// a good answer, five minutes after a failure). `force` re-reads now.
async function latestRuntime(opts = {}) {
  const now = Date.now();
  const fresh = remote.at && now - remote.at < (remote.ok ? TTL_MS : RETRY_MS);
  if (!opts.force && fresh) return remote.info;
  let info = null;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    const res = await fetch(LATEST_URL, {
      signal: controller.signal, cache: 'no-store',
      headers: { 'User-Agent': 'zero-company-mod-command' },
    });
    clearTimeout(timer);
    if (res.ok) {
      const json = await res.json();
      const version = str(json && json.version);
      const url = str(json && json.url, 400);
      // Only ever download from the release repo itself.
      if (version && url && new RegExp(`^https://github\.com/${RELEASE_REPO}/releases/download/.+\.zip$`, 'i').test(url)) {
        info = {
          source: 'github',
          version,
          bridge: str(json.bridge),
          loader: str(json.loader),
          url,
          asset: str(json.asset, 120) || `ZCSDKRuntime_v${version}.zip`,
          published: str(json.published),
        };
      }
    }
  } catch (_) { /* offline or rate-limited — the bundled copy still works */ }
  remote = { info, at: now, ok: !!info };
  return info;
}

// The last fetched GitHub descriptor, without touching the network.
function remoteRuntime() {
  return remote.info;
}

// The package an install would use right now: the GitHub release when it is
// known and newer than the bundled copy, else the bundled copy (offline, or
// already the same version). Synchronous — reads the cached remote answer — so
// state building stays synchronous.
function availableRuntime() {
  const bundled = bundledRuntime();
  const gh = remote.info;
  if (gh && (!bundled || compareRuntimeVersions(gh.version, bundled.version) > 0)) return gh;
  return bundled;
}

module.exports = {
  bundledRuntime, latestRuntime, remoteRuntime, availableRuntime, compareRuntimeVersions,
  PARTS, RUNTIME_ZIP, RELEASE_REPO, RELEASES_URL, LATEST_URL,
};

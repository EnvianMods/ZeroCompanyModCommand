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
//     ({version, bridge, loader, asset, url, published, sha256, size}). Mod
//     Command reads latest.json at startup and on demand and downloads the
//     release zip, so a runtime update no longer waits for a Mod Command release.
//  2. Bundled — tools/ZCSDKRuntime.zip + tools/zcsdk-runtime.json ship with
//     the app (extraResources) as the offline fallback.
//
// Integrity: the runtime is a native DLL loaded into the game, so a zip is
// only extracted after it matched the SHA-256 and size published for it.
// latest.json carries `sha256` + `size` from Runtime 0.15.1 on (required from
// then on, and for every entry once a hashed one was seen); the bundled copy
// carries the pin build/fetch-tools.js wrote into zcsdk-runtime.json. The
// download URL is pinned to the release repo (host, path, tag = v<version>,
// file name = asset) after WHATWG URL normalization, and only that normalized
// href is ever fetched.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const RUNTIME_ZIP = 'ZCSDKRuntime.zip';
const RUNTIME_INFO = 'zcsdk-runtime.json';
const RELEASE_REPO = 'EnvianMods/ZCSDK-Runtime-Release';
const LATEST_URL = `https://raw.githubusercontent.com/${RELEASE_REPO}/main/latest.json`;
// From this runtime version on, latest.json must carry sha256 + size.
const HASH_REQUIRED_FROM = '0.15.1';
const VERSION_RE = /^\d+(\.\d+){0,3}$/;
const SHA256_RE = /^[0-9a-f]{64}$/;
const ASSET_RE = /^ZCSDKRuntime_v[\d.]+(_manual)?\.zip$/;
const RUNTIME_PATH = /^\/EnvianMods\/ZCSDK-Runtime-Release\/releases\/download\/v[\d.]+\/ZCSDKRuntime_v[\d.]+(_manual)?\.zip$/;

// UE4SS mod folder names the runtime consists of (both must be present).
const PARTS = ['ZCSDKBridge', 'ZCSDKLoader'];

const TTL_MS = 60 * 60 * 1000;   // a successful check is reused for an hour
const RETRY_MS = 5 * 60 * 1000;  // a failed check is retried after five minutes
let remote = { info: null, at: 0, ok: false };
// Anti-downgrade: once a hashed latest.json was seen, hashless entries are
// refused. main.js wires this to settings.zcsdkHashSeen (configure()).
let hashPolicy = { seen: false, onSeen: null, warn: null };

function configure(opts = {}) {
  if ('hashSeen' in opts) hashPolicy.seen = !!opts.hashSeen;
  if ('onHashSeen' in opts) hashPolicy.onSeen = typeof opts.onHashSeen === 'function' ? opts.onHashSeen : null;
  if ('warn' in opts) hashPolicy.warn = typeof opts.warn === 'function' ? opts.warn : null;
}

function warn(msg) {
  try { if (hashPolicy.warn) hashPolicy.warn(msg); else console.warn(msg); } catch (_) {}
}

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

// The pinned download URL for a runtime zip, or null. `raw` is parsed with
// WHATWG URL (so `..`, `%2e%2e` and backslashes are normalized before the
// check), must be https://github.com with no port, credentials, query or
// fragment, and its path must be a release asset of the runtime repo. With
// `version` the tag must be v<version>; with `asset` the file name must be it.
// Returns the rebuilt href — the only string that may be downloaded.
function runtimeUrl(raw, expect = {}) {
  if (typeof raw !== 'string' || !raw || raw.length > 400) return null;
  let u;
  try { u = new URL(raw); } catch (_) { return null; }
  if (u.protocol !== 'https:' || u.hostname !== 'github.com' || u.port || u.username || u.password || u.search || u.hash) return null;
  if (/[?#]/.test(raw)) return null; // an empty "?" or "#" still marks a URL that is not a plain asset link
  if (!RUNTIME_PATH.test(u.pathname)) return null; // pathname is already dot-segment-normalized by URL
  const segs = u.pathname.split('/');
  const tag = segs[segs.length - 2];
  const file = segs[segs.length - 1];
  if (expect.version != null && tag !== `v${expect.version}`) return null;
  if (expect.asset != null && file !== expect.asset) return null;
  return `https://github.com${u.pathname}`;
}

// A pinned SHA-256 (lowercase) or null when absent; undefined when present
// but malformed (the entry is then refused).
function pinSha(v) {
  if (v === undefined || v === null) return null;
  if (typeof v !== 'string') return undefined;
  const h = v.trim().toLowerCase();
  return SHA256_RE.test(h) ? h : undefined;
}
function pinSize(v) {
  if (v === undefined || v === null) return null;
  return Number.isSafeInteger(v) && v > 0 ? v : undefined;
}

function short(h) { return h ? `${String(h).slice(0, 12)}…` : 'none'; }

function integrityError(version, expected, got) {
  const e = new Error(`ZCSDK Runtime ${version ? `${version} ` : ''}failed its integrity check (expected ${expected}, got ${got}).`);
  e.code = 'ZCSDK_INTEGRITY';
  return e;
}

// Throws unless `file` has exactly `size` bytes and the SHA-256 `sha256`
// (compared lowercase). Resolves to the file's digest.
async function verifyRuntimeZip(file, pin = {}) {
  const sha = pinSha(pin.sha256);
  const size = pinSize(pin.size);
  if (!sha || !size) throw integrityError(pin.version, 'a published SHA-256 and size', 'none');
  let st;
  try { st = fs.statSync(file); } catch (_) { throw integrityError(pin.version, `${size} bytes`, 'no file'); }
  if (!st.isFile() || st.size !== size) throw integrityError(pin.version, `${size} bytes`, `${st.isFile() ? st.size : 0} bytes`);
  const got = await new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(file).on('error', reject).on('data', (c) => h.update(c)).on('end', () => resolve(h.digest('hex')));
  });
  if (got !== sha) throw integrityError(pin.version, short(sha), short(got));
  return got;
}

// Verifies a bundled package against its zcsdk-runtime.json pin. A bundled
// zip shipped before pins existed (no sha256/size) keeps working; the result
// is then { pinned:false } so the caller can log it. A pin that is malformed
// or does not match throws.
async function verifyBundledRuntime(pkg) {
  if (!pkg || !pkg.zip) throw new Error('No bundled ZCSDK Runtime package.');
  if (pkg.sha256 === undefined || pkg.size === undefined) throw integrityError(pkg.version, 'a valid pin in zcsdk-runtime.json', 'a malformed one');
  if (!pkg.sha256 && !pkg.size) return { pinned: false };
  await verifyRuntimeZip(pkg.zip, pkg);
  return { pinned: true };
}

// { source:'bundled', zip, version, bridge, loader, sha256, size, fileSize }
// for the package shipped in tools/, or null when this build ships without
// one. sha256/size are the pin from zcsdk-runtime.json (null when it has
// none, undefined when malformed); fileSize is the zip on disk.
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
      sha256: pinSha(info.sha256),
      size: pinSize(info.size),
      fileSize: fs.statSync(zip).size,
    };
  }
  return null;
}

// Checks one parsed latest.json → the entry, or null (with a warning). Rules:
// version is dotted digits; asset is ZCSDKRuntime_v<version>.zip; url is the
// pinned release asset for that tag and file; sha256/size are required from
// HASH_REQUIRED_FROM on (and for any version once a hashed entry was seen)
// and must be well formed whenever present.
function parseLatest(json, policy = hashPolicy) {
  if (!json || typeof json !== 'object') return null;
  const version = str(json.version);
  if (!version || !VERSION_RE.test(version)) { warn('ZCSDK Runtime latest.json refused: no valid version'); return null; }
  const asset = json.asset === undefined || json.asset === null ? `ZCSDKRuntime_v${version}.zip` : json.asset;
  if (typeof asset !== 'string' || !ASSET_RE.test(asset) || asset !== `ZCSDKRuntime_v${version}.zip`) { warn(`ZCSDK Runtime latest.json ${version} refused: unexpected asset name`); return null; }
  const url = runtimeUrl(json.url, { version, asset });
  if (!url) { warn(`ZCSDK Runtime latest.json ${version} refused: the download URL is not a release asset of ${RELEASE_REPO} for v${version}`); return null; }
  const sha256 = pinSha(json.sha256);
  const size = pinSize(json.size);
  if (sha256 === undefined || size === undefined) { warn(`ZCSDK Runtime latest.json ${version} refused: malformed sha256 or size`); return null; }
  const hashed = !!(sha256 && size);
  if (!hashed && (sha256 || size)) { warn(`ZCSDK Runtime latest.json ${version} refused: sha256 and size must come together`); return null; }
  if (!hashed && compareRuntimeVersions(version, HASH_REQUIRED_FROM) >= 0) { warn(`ZCSDK Runtime latest.json ${version} refused: no sha256/size (required from ${HASH_REQUIRED_FROM} on)`); return null; }
  if (!hashed && policy.seen) { warn(`ZCSDK Runtime latest.json ${version} refused: no sha256/size, and a hashed entry was seen before`); return null; }
  return {
    source: 'github',
    version,
    bridge: str(json.bridge),
    loader: str(json.loader),
    url,
    asset,
    sha256,
    size,
    published: str(json.published),
  };
}

// Read latest.json from the release repo → { source:'github', version, bridge,
// loader, url, asset, sha256, size, published } or null. Never throws; cached
// (an hour after a good answer, five minutes after a failure). `force`
// re-reads now.
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
      info = parseLatest(await res.json());
      if (info && info.sha256 && !hashPolicy.seen) {
        hashPolicy.seen = true;
        try { if (hashPolicy.onSeen) hashPolicy.onSeen(); } catch (_) {}
      }
    }
  } catch (_) { /* offline or rate-limited — the bundled copy still works */ }
  remote = { info, at: now, ok: !!info };
  return info;
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

// Would installing bundled package `b` move the installed runtime `inst`
// ({ installed, version, bridge, loader }) back? True when any version both
// sides know is older in `b`. `strict` (the fallback paths) also counts as a
// downgrade what cannot be ruled out: an installed version `b` does not
// state, or an installed runtime with no known version at all.
function isRuntimeDowngrade(b, inst, strict) {
  if (!inst || !inst.installed) return false;
  let compared = 0;
  for (const k of ['version', 'bridge', 'loader']) {
    if (!inst[k]) continue;
    if (!b || !b[k]) { if (strict) return true; continue; }
    compared++;
    if (compareRuntimeVersions(b[k], inst[k]) < 0) return true;
  }
  return strict && compared === 0;
}

// What the player has now, for messages: "0.15", else "runtime (ZCSDKLoader 1.8.53)".
function installedLabel(inst) {
  if (inst && inst.version) return inst.version;
  if (inst && inst.loader) return `runtime (ZCSDKLoader ${inst.loader})`;
  return 'runtime';
}

// Picks and checks the zip an install extracts. `download(pkg)` fetches a
// GitHub package and resolves to its path. A GitHub download is verified
// against its sha256/size before anything else; on a mismatch it is deleted.
// `installed` ({ installed, version, bridge, loader }) is the runtime in the
// game now. Fallback rules (a failed download or a failed check):
//  - the bundled copy is never installed over a newer (or unknown) installed
//    runtime — nothing is installed and the current runtime is kept;
//  - after a failed integrity check only a PINNED bundled copy that verifies
//    is used (an unpinned one serves only the offline / no-GitHub path).
// A direct bundled install (offline) refuses a proven downgrade too.
// Resolves to { zipPath, version, source, downloaded, integrityFailed,
// fallback, reason, pinned }; `downloaded` (when set) is the caller's to
// delete after the install. Throws when nothing acceptable is left (err.kept
// = true when the installed runtime was kept).
async function prepareRuntimeZip(pkg, { download, bundled = bundledRuntime, installed = null, log = () => {} } = {}) {
  if (!pkg) throw new Error('No ZCSDK Runtime package is available.');
  const kept = (message, code) => {
    const err = new Error(message);
    err.code = code;
    err.kept = true;
    return err;
  };
  // → { ok:true, ...pick } | { ok:false, why:'none'|'downgrade'|'unpinned'|'bad' }
  const useBundled = async (why, given, { requirePin = false, strict = true } = {}) => {
    const b = given || (typeof bundled === 'function' ? bundled() : bundled);
    if (!b) return { ok: false, why: 'none' };
    if (isRuntimeDowngrade(b, installed, strict)) {
      log('warn', `ZCSDK Runtime: the bundled ${b.version || 'copy'} (ZCSDKLoader ${b.loader || '?'}) was not used${why ? ` (${why})` : ''}: it is not newer than the installed ${installedLabel(installed)}, which was kept`);
      return { ok: false, why: 'downgrade' };
    }
    if (requirePin && !(b.sha256 && b.size)) {
      log('error', `ZCSDK Runtime: the bundled ${b.version || 'copy'} was not used${why ? ` (${why})` : ''}: it has no SHA-256 pin`);
      return { ok: false, why: 'unpinned' };
    }
    try {
      const v = await verifyBundledRuntime(b);
      if (!v.pinned) log('warn', `ZCSDK Runtime: the bundled ${b.version || 'copy'} has no SHA-256 pin in zcsdk-runtime.json (built before pins existed); installing it unverified`);
      return { ok: true, zipPath: b.zip, version: b.version, source: 'bundled', pinned: v.pinned };
    } catch (e) {
      log('error', `ZCSDK Runtime: the bundled ${b.version || 'copy'} was not used${why ? ` (${why})` : ''}: ${e.message}`);
      return { ok: false, why: 'bad' };
    }
  };
  const pick = ({ ok, why, ...r }) => r;
  if (pkg.source !== 'github') {
    const r = await useBundled(null, pkg, { strict: false });
    if (r.why === 'downgrade') throw kept(`The bundled ZCSDK Runtime ${pkg.version || ''} is older than your installed ${installedLabel(installed)}, which was kept.`.replace('Runtime  ', 'Runtime '), 'ZCSDK_DOWNGRADE');
    if (!r.ok) {
      const err = new Error(`The bundled ZCSDK Runtime ${pkg.version ? `${pkg.version} ` : ''}failed its integrity check and was not installed.`);
      err.code = 'ZCSDK_INTEGRITY';
      throw err;
    }
    return { ...pick(r), downloaded: null, integrityFailed: false, fallback: false, reason: null };
  }
  let file = null;
  try {
    file = await download(pkg);
  } catch (e) {
    const r = await useBundled('fallback after a failed download');
    if (r.why === 'downgrade') throw kept(`Could not download ZCSDK Runtime ${pkg.version} from GitHub: ${String(e.message).replace(/\.?$/, '.')} Your installed ${installedLabel(installed)} was kept.`, 'ZCSDK_DOWNLOAD');
    if (!r.ok) throw new Error(`Could not download ZCSDK Runtime ${pkg.version} from GitHub: ${e.message}`);
    return { ...pick(r), downloaded: null, integrityFailed: false, fallback: true, reason: e.message };
  }
  try {
    await verifyRuntimeZip(file, pkg);
  } catch (e) {
    try { fs.rmSync(file, { force: true }); } catch (_) {}
    log('error', `ZCSDK Runtime ${pkg.version} from GitHub refused: ${e.message} The download was deleted; nothing was extracted.`);
    const r = await useBundled('fallback after a failed integrity check', null, { requirePin: true });
    if (!r.ok && installed && installed.installed) {
      throw kept(`The ZCSDK Runtime download failed its integrity check. Your installed ${installedLabel(installed)} was kept.`, 'ZCSDK_INTEGRITY');
    }
    if (!r.ok) {
      const err = new Error('The ZCSDK Runtime download from GitHub failed its integrity check and was not installed.');
      err.code = 'ZCSDK_INTEGRITY';
      throw err;
    }
    return { ...pick(r), downloaded: null, integrityFailed: true, fallback: true, reason: e.message };
  }
  return { zipPath: file, version: pkg.version, source: 'github', pinned: true, downloaded: file, integrityFailed: false, fallback: false, reason: null };
}

module.exports = {
  bundledRuntime, latestRuntime, availableRuntime, compareRuntimeVersions,
  configure, parseLatest, runtimeUrl, verifyRuntimeZip, verifyBundledRuntime, prepareRuntimeZip, isRuntimeDowngrade,
  PARTS, RUNTIME_ZIP, RELEASE_REPO, LATEST_URL, HASH_REQUIRED_FROM, ASSET_RE, RUNTIME_PATH,
  _resetForTests() { remote = { info: null, at: 0, ok: false }; hashPolicy = { seen: false, onSeen: null, warn: null }; },
};

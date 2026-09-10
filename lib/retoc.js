'use strict';
// retoc (trumank/retoc) — the IoStore container tool used to list the files
// inside pak/utoc mods for conflict detection. A copy ships in tools/ (0.1.5);
// this module checks GitHub for a newer release and can install it into the
// app's data folder (<dataDir>/tools/retoc.exe), which retocPath() prefers
// over the bundled copy — so a new retoc never has to wait for a Mod Command
// release. Windows only (the tool is Windows-only in this app).

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO = 'trumank/retoc';
const TTL_MS = 60 * 60 * 1000;
const RETRY_MS = 5 * 60 * 1000;
let cache = { info: null, at: 0, ok: false };

async function ghJson(url) {
  const res = await fetch(url, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'zero-company-mod-command' } });
  if (!res.ok) throw new Error(`GitHub replied ${res.status} ${res.statusText}.`);
  return res.json();
}

// "retoc_cli 0.1.5" / "retoc 0.1.4" / "v0.1.5" → "0.1.5"
function parseVersion(text) {
  const m = /(\d+\.\d+(?:\.\d+)?)/.exec(String(text || ''));
  return m ? m[1] : null;
}
function compareVersions(a, b) {
  const pa = String(a || '').split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b || '').split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}

// { tag, version, name, url, size, publishedAt } for the newest release with a
// Windows zip, or null. Cached (1 h after success, 5 min after failure).
async function refreshLatest(force) {
  const now = Date.now();
  const fresh = cache.at && now - cache.at < (cache.ok ? TTL_MS : RETRY_MS);
  if (!force && fresh) return cache.info;
  let info = null;
  try {
    const rel = await ghJson(`https://api.github.com/repos/${REPO}/releases/latest`);
    const asset = (rel.assets || []).find((a) => /windows/i.test(a.name) && /\.zip$/i.test(a.name));
    if (asset) {
      info = { tag: rel.tag_name, version: parseVersion(rel.tag_name), name: asset.name, url: asset.browser_download_url, size: asset.size, publishedAt: asset.updated_at || rel.published_at };
    }
  } catch (_) {}
  cache = { info, at: now, ok: !!info };
  return info;
}
function cachedLatest() { return cache.info; }

// { installed, latest, latestDate, available }
function updateInfo(installedVersionText, latest = cache.info) {
  const installed = parseVersion(installedVersionText);
  const out = { installed, latest: latest ? latest.version : null, latestDate: latest ? latest.publishedAt : null, available: false };
  if (installed && latest && latest.version && compareVersions(latest.version, installed) > 0) out.available = true;
  return out;
}

// Where a user-updated copy lives; retocPath() looks here before tools/.
function userDir(dataDir) { return path.join(dataDir, 'tools'); }
function userExe(dataDir) { return path.join(userDir(dataDir), 'retoc.exe'); }

// Download the latest Windows zip and place retoc.exe (+ the Oodle dll from
// the bundled tools folder when present) under <dataDir>/tools. Returns
// { path, version, tag }. `download(url, destDir, name, onProgress)` is the
// app's shared downloader.
async function installLatest(dataDir, bundledToolsDir, download, onProgress) {
  const latest = await refreshLatest(true);
  if (!latest) throw new Error('Could not read the latest retoc release from GitHub.');
  const zip = await download(latest.url, path.join(os.tmpdir(), 'zc-retoc'), latest.name, onProgress);
  const extract = fs.mkdtempSync(path.join(os.tmpdir(), 'zc-retoc-x-'));
  try {
    // System32\tar.exe is bsdtar and reads zips (a GNU tar earlier on PATH cannot).
    const tar = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
    const r = spawnSync(tar, ['-xf', zip, '-C', extract], { stdio: 'ignore' });
    if (r.status !== 0) throw new Error('extracting the retoc zip failed');
    const found = walk(extract).find((f) => /(^|[\\/])retoc(_cli)?\.exe$/i.test(f));
    if (!found) throw new Error('the retoc zip held no retoc.exe');
    const dir = userDir(dataDir);
    fs.mkdirSync(dir, { recursive: true });
    const dest = userExe(dataDir);
    fs.copyFileSync(found, dest + '.new');
    fs.renameSync(dest + '.new', dest);
    const oodle = path.join(bundledToolsDir || '', 'oo2core_9_win64.dll');
    if (bundledToolsDir && fs.existsSync(oodle) && !fs.existsSync(path.join(dir, 'oo2core_9_win64.dll'))) fs.copyFileSync(oodle, path.join(dir, 'oo2core_9_win64.dll'));
    return { path: dest, version: latest.version, tag: latest.tag, asset: latest.name, publishedAt: latest.publishedAt };
  } finally {
    fs.rmSync(extract, { recursive: true, force: true });
    fs.rmSync(zip, { force: true });
  }
}

function walk(root) {
  const out = [];
  const stack = [root];
  while (stack.length) {
    const d = stack.pop();
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) stack.push(p); else out.push(p);
    }
  }
  return out;
}

module.exports = { REPO, refreshLatest, cachedLatest, updateInfo, parseVersion, compareVersions, userExe, userDir, installLatest };

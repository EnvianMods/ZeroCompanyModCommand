'use strict';
// UE4SS runtime downloads from GitHub (UE4SS-RE/RE-UE4SS).
// Zero Company is a UE 5.5/5.6-era build, so the default pick is the rolling
// experimental release; every published release is also listed so a user who
// has frozen game updates can install whichever UE4SS build matches their
// game build (Settings → UE4SS → ⧗ Versions).

const REPO = 'UE4SS-RE/RE-UE4SS';

async function ghJson(url) {
  const res = await fetch(url, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'zero-company-mod-command' },
  });
  if (!res.ok) throw new Error(`GitHub replied ${res.status} ${res.statusText}.`);
  return res.json();
}

function pickAsset(release) {
  const assets = release.assets || [];
  // Main runtime zip: "UE4SS_v3.x.zip" / "UE4SS_Standard_v2.x.zip" — not zDEV
  // (debug symbols), zCustomGameConfigs, or the Xinput variant.
  const asset = assets.find((a) => /^UE4SS.*\.zip$/i.test(a.name) && !/xinput/i.test(a.name))
    || assets.find((a) => /\.zip$/i.test(a.name) && !/^z/i.test(a.name));
  if (!asset) return null;
  return {
    name: asset.name,
    url: asset.browser_download_url,
    size: asset.size,
    tag: release.tag_name,
    releaseName: release.name || release.tag_name,
    prerelease: !!release.prerelease,
    // A rolling release keeps its original published date; the asset's own
    // timestamp says when the build actually changed.
    publishedAt: asset.updated_at || release.published_at,
  };
}

// The default pick: the rolling experimental build, else the latest stable.
// Returns { name, url, size, tag, releaseName, prerelease, publishedAt }.
async function latestRuntime() {
  const candidates = [];
  try {
    candidates.push(await ghJson(`https://api.github.com/repos/${REPO}/releases/tags/experimental-latest`));
  } catch (_) { /* tag may not exist */ }
  try {
    candidates.push(await ghJson(`https://api.github.com/repos/${REPO}/releases/latest`));
  } catch (_) {}
  for (const release of candidates) {
    const asset = pickAsset(release);
    if (asset) return asset;
  }
  throw new Error('Could not find a UE4SS runtime zip in the latest GitHub releases.');
}

// One specific release by tag (e.g. "v3.0.1", "experimental-latest").
async function runtimeByTag(tag) {
  if (!/^[A-Za-z0-9._-]{1,60}$/.test(String(tag || ''))) throw new Error('Invalid UE4SS release tag.');
  const release = await ghJson(`https://api.github.com/repos/${REPO}/releases/tags/${encodeURIComponent(tag)}`);
  const asset = pickAsset(release);
  if (!asset) throw new Error(`Release ${tag} has no UE4SS runtime zip.`);
  return asset;
}

// Every release that carries a runtime zip, newest build first; the default
// pick is flagged `recommended`. Drafts and the old "experimental" archive
// release (a grab-bag of dev builds) are skipped.
async function listRuntimes(limit = 30) {
  const releases = await ghJson(`https://api.github.com/repos/${REPO}/releases?per_page=${Math.min(100, Math.max(1, limit))}`);
  const list = [];
  for (const r of releases) {
    if (r.draft || r.tag_name === 'experimental') continue;
    const asset = pickAsset(r);
    if (asset) list.push(asset);
  }
  list.sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt));
  const rec = list.find((a) => a.tag === 'experimental-latest') || list.find((a) => !a.prerelease) || list[0];
  for (const a of list) a.recommended = rec ? a.tag === rec.tag : false;
  return list;
}

// The build a runtime zip's name encodes: "UE4SS_v3.0.1-1127-g2bfa839f.zip" →
// "v3.0.1-1127-g2bfa839f" (git describe: tag, commits since, short hash). The
// rolling experimental-latest release keeps its tag but its asset name changes
// with every CI build, so this is how two experimental installs are told apart.
function buildIdOf(assetName) {
  const m = /^UE4SS(?:_Standard|_Xinput)?_(v[0-9][^/\\]*?)\.zip$/i.exec(String(assetName || ''));
  return m ? m[1] : null;
}
function shortBuild(assetName) {
  const id = buildIdOf(assetName);
  if (!id) return null;
  const g = /-(g[0-9a-f]{6,})$/i.exec(id);
  return g ? g[1] : id;
}

// Cached default pick (the rolling build), refreshed at most hourly — the
// Settings card and the update check compare the installed build against it
// without a network call per state build.
let latestCache = { asset: null, at: 0, ok: false };
const LATEST_TTL_MS = 60 * 60 * 1000;
const LATEST_RETRY_MS = 5 * 60 * 1000;
async function refreshLatest(force) {
  const now = Date.now();
  const fresh = latestCache.at && now - latestCache.at < (latestCache.ok ? LATEST_TTL_MS : LATEST_RETRY_MS);
  if (!force && fresh) return latestCache.asset;
  let asset = null;
  try { asset = await latestRuntime(); } catch (_) {}
  latestCache = { asset, at: now, ok: !!asset };
  return asset;
}
function cachedLatest() { return latestCache.asset; }

// Is the installed runtime (settings.ue4ssInstalled record) behind the newest
// build of its own channel? Compares build ids, never dates.
//   { known, available, current, currentBuild, latest, latestBuild, latestDate, tag }
function updateInfo(installedRecord, latest = latestCache.asset) {
  const rec = installedRecord || null;
  const out = { known: !!(rec && rec.asset), available: false, current: rec ? rec.asset : null, currentBuild: rec ? shortBuild(rec.asset) : null,
    latest: latest ? latest.name : null, latestBuild: latest ? shortBuild(latest.name) : null, latestDate: latest ? latest.publishedAt : null, tag: latest ? latest.tag : null };
  if (!rec || !rec.asset || !latest) return out;
  // Same channel (the rolling tag, or the same stable tag) and a different build → update.
  if (rec.tag === latest.tag && buildIdOf(rec.asset) !== buildIdOf(latest.name)) out.available = true;
  // On an older stable while the rolling build is the recommended pick → update too.
  if (rec.tag !== latest.tag && latest.tag === 'experimental-latest' && rec.tag !== 'experimental-latest') out.available = false; // a deliberate stable pick is respected
  return out;
}

module.exports = { latestRuntime, runtimeByTag, listRuntimes, pickAsset, buildIdOf, shortBuild, refreshLatest, cachedLatest, updateInfo, REPO };

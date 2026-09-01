'use strict';
// UE4SS runtime download from GitHub (UE4SS-RE/RE-UE4SS).
// Zero Company is a UE 5.5/5.6-era build, so prefer the rolling experimental release.

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
  // Main runtime zip: "UE4SS_v3.x.zip" — not zDEV (debug symbols) or zCustomGameConfigs.
  const asset = assets.find((a) => /^UE4SS.*\.zip$/i.test(a.name))
    || assets.find((a) => /\.zip$/i.test(a.name) && !/^z/i.test(a.name));
  if (!asset) return null;
  return {
    name: asset.name,
    url: asset.browser_download_url,
    size: asset.size,
    tag: release.tag_name,
    releaseName: release.name || release.tag_name,
    publishedAt: release.published_at,
  };
}

// Find the best UE4SS build to install. Returns { name, url, size, tag, ... }
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

module.exports = { latestRuntime, REPO };

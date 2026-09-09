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

module.exports = { latestRuntime, runtimeByTag, listRuntimes, pickAsset, REPO };

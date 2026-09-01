'use strict';
// GitHub as a curated mod source ("The Forge"). Only repos on the owner-controlled
// allowlist are shown or installable. The allowlist lives in the same owner repo
// as the featured roster (github-mods.json) so it updates for every installed
// launcher live; a baked-in fallback covers offline/first-run. Only archive
// release assets (.zip/.7z/.rar) are ever considered — installer binaries are
// ignored — and installation still passes through the mod classifier, which
// refuses anything that isn't recognizable mod content.

const FALLBACK_ALLOWLIST = ['Sternab/ZeroCompanyMandoWardrobe'];
const ALLOWLIST_URL = 'https://raw.githubusercontent.com/EnvianMods/SWZeroCompanyFeaturedAuthors/main/github-mods.json';

const TTL_MS = 10 * 60 * 1000;
let allowlistCache = { repos: null, at: 0 };
const repoCache = new Map(); // fullName -> { at, card }

async function gh(url) {
  const res = await fetch(url, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'zero-company-mod-command' },
  });
  if (res.status === 403 || res.status === 429) {
    throw new Error('GitHub rate limit reached. Try again in a few minutes.');
  }
  return res;
}

async function getAllowlist() {
  const now = Date.now();
  if (allowlistCache.repos && now - allowlistCache.at < TTL_MS) return allowlistCache.repos;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 6000);
    const res = await fetch(ALLOWLIST_URL, { signal: controller.signal, cache: 'no-store' });
    clearTimeout(timer);
    if (res.ok) {
      const json = await res.json();
      const repos = Array.isArray(json.allowedRepos)
        ? json.allowedRepos.map((r) => String(r).trim()).filter((r) => /^[\w.-]+\/[\w.-]+$/.test(r)).slice(0, 50)
        : null;
      if (repos) {
        allowlistCache = { repos, at: now };
        return repos;
      }
    }
  } catch (_) { /* offline or not published yet */ }
  return allowlistCache.repos || FALLBACK_ALLOWLIST;
}

const ARCHIVE_RE = /\.(zip|7z|rar)$/i;
const JUNK_RE = /setup|installer|\.exe$|\.msi$|\.appimage$|\.deb$|\.rpm$|\.dmg$|\.sha256$|\.sig$|source.?code/i;

function pickAsset(release) {
  const assets = (release.assets || []).filter((a) => ARCHIVE_RE.test(a.name) && !JUNK_RE.test(a.name));
  assets.sort((a, b) => {
    const az = a.name.toLowerCase().endsWith('.zip') ? 0 : 1;
    const bz = b.name.toLowerCase().endsWith('.zip') ? 0 : 1;
    return az - bz || a.size - b.size;
  });
  return assets[0] || null;
}

// Repo card + latest installable release, cached per repo.
async function repoCard(fullName) {
  const cached = repoCache.get(fullName);
  if (cached && Date.now() - cached.at < TTL_MS) return cached.card;
  let card = null;
  const res = await gh(`https://api.github.com/repos/${fullName}`);
  if (res.ok) {
    const r = await res.json();
    card = {
      source: 'github',
      fullName: r.full_name,
      name: r.name,
      author: r.owner ? r.owner.login : '?',
      summary: r.description || '',
      stars: r.stargazers_count || 0,
      updatedAt: r.pushed_at || r.updated_at,
      url: r.html_url,
      archived: !!r.archived,
      release: null,
    };
    const rel = await gh(`https://api.github.com/repos/${fullName}/releases/latest`);
    if (rel.status === 200) {
      const release = await rel.json();
      const asset = pickAsset(release);
      if (asset) {
        card.release = {
          tag: release.tag_name,
          assetName: asset.name,
          assetUrl: asset.browser_download_url,
          size: asset.size,
          publishedAt: release.published_at,
        };
      }
    }
  }
  repoCache.set(fullName, { at: Date.now(), card });
  return card;
}

// The Forge listing: every allowlisted repo, search-filtered and sorted.
async function listCurated({ query, sort = 'stars' } = {}) {
  const allow = await getAllowlist();
  const results = await Promise.allSettled(allow.map((r) => repoCard(r)));
  let cards = results
    .filter((r) => r.status === 'fulfilled' && r.value)
    .map((r) => r.value);
  if (query && query.trim()) {
    const q = query.trim().toLowerCase();
    cards = cards.filter((c) =>
      c.name.toLowerCase().includes(q) || c.author.toLowerCase().includes(q) || c.summary.toLowerCase().includes(q));
  }
  cards.sort((a, b) => (sort === 'updated'
    ? new Date(b.updatedAt) - new Date(a.updatedAt)
    : b.stars - a.stars));
  return { totalCount: cards.length, mods: cards, allowlistCount: allow.length };
}

// Fresh release info for update checks / installs (bypasses nothing — same cache).
async function latestReleaseFor(fullName) {
  const card = await repoCard(fullName);
  return card ? card.release : null;
}

module.exports = { listCurated, latestReleaseFor, getAllowlist, FALLBACK_ALLOWLIST };

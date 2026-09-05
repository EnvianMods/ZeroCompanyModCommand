'use strict';
// Nexus Mods API client + nxm:// link handling.
// Game domain on Nexus: starwarszerocompany

const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');

const API = 'https://api.nexusmods.com/v1';
const GAME_DOMAIN = 'starwarszerocompany';

// nxm://starwarszerocompany/mods/9/files/42?key=...&expires=...&user_id=...
function parseNxm(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch (_) {
    throw new Error(`That is not a usable Nexus Mods link: ${raw}`);
  }
  if (url.protocol !== 'nxm:') throw new Error('Not an nxm:// link.');
  const m = url.pathname.match(/^\/mods\/(\d+)\/files\/(\d+)$/);
  const game = url.host;
  if (!m) throw new Error(`That is not a usable Nexus Mods link: ${raw}`);
  if (game.toLowerCase() !== GAME_DOMAIN) {
    throw new Error(`That link is for a different game (${game}), not Star Wars: Zero Company.`);
  }
  return {
    game,
    modId: Number(m[1]),
    fileId: Number(m[2]),
    key: url.searchParams.get('key'),
    expires: url.searchParams.get('expires'),
    userId: url.searchParams.get('user_id'),
  };
}

async function apiGet(pathname, apiKey) {
  const res = await fetch(`${API}${pathname}`, {
    headers: {
      apikey: apiKey,
      'Application-Name': 'zero-company-mod-command',
      'Application-Version': '1.8.0',
    },
  });
  if (res.status === 401) throw new Error('Nexus Mods rejected the API key. Check it in Settings.');
  if (res.status === 429) throw new Error('Nexus Mods rate limit reached. Try again later.');
  if (!res.ok) throw new Error(`Nexus Mods replied ${res.status} ${res.statusText}.`);
  return res.json();
}

// Validate a key; returns { name, isPremium }
async function validateKey(apiKey) {
  const user = await apiGet('/users/validate.json', apiKey);
  return { name: user.name, isPremium: !!user.is_premium };
}

async function modInfo(modId, apiKey) {
  return apiGet(`/games/${GAME_DOMAIN}/mods/${modId}.json`, apiKey);
}

async function fileInfo(modId, fileId, apiKey) {
  return apiGet(`/games/${GAME_DOMAIN}/mods/${modId}/files/${fileId}.json`, apiKey);
}

// Resolve a CDN download URL. Non-premium users need key+expires from the nxm link
// (produced by the "Mod Manager Download" button on the website).
async function downloadLink(link, apiKey) {
  let pathname = `/games/${GAME_DOMAIN}/mods/${link.modId}/files/${link.fileId}/download_link.json`;
  if (link.key && link.expires) {
    pathname += `?key=${encodeURIComponent(link.key)}&expires=${encodeURIComponent(link.expires)}`;
  }
  const list = await apiGet(pathname, apiKey);
  if (!Array.isArray(list) || !list.length || !list[0].URI) {
    throw new Error('Nexus Mods returned no download link. Non-premium downloads must start from the "Mod Manager Download" button on the website.');
  }
  return list[0].URI;
}

async function downloadToFile(uri, destDir, suggestedName, onProgress) {
  fs.mkdirSync(destDir, { recursive: true });
  const res = await fetch(uri);
  if (!res.ok || !res.body) throw new Error(`Download failed: ${res.status} ${res.statusText}`);
  let name = suggestedName;
  if (!name) {
    // Prefer the server's own filename; fall back to the URL path.
    const cd = res.headers.get('content-disposition') || '';
    const m = cd.match(/filename\*?=(?:UTF-8''|")?([^";]+)/i);
    if (m) { try { name = decodeURIComponent(m[1].trim().replace(/"$/, '')); } catch (_) { name = m[1].trim(); } }
  }
  if (!name) {
    try { name = decodeURIComponent(path.basename(new URL(uri).pathname)); } catch (_) {}
  }
  if (!name || !/\.[A-Za-z0-9]{2,4}$/.test(name)) name = (name || 'download') + '.zip';
  name = name.replace(/[\\/:*?"<>|]+/g, '_');
  const dest = path.join(destDir, name);
  const total = Number(res.headers.get('content-length')) || 0;
  let received = 0;
  const counter = new (require('stream').Transform)({
    transform(chunk, _enc, cb) {
      received += chunk.length;
      if (onProgress) onProgress(received, total);
      cb(null, chunk);
    },
  });
  await pipeline(Readable.fromWeb(res.body), counter, fs.createWriteStream(dest));
  return dest;
}

// ---------------------------------------------------------------- browsing (GraphQL v2, works without an API key)

const SORTS = {
  downloads: { downloads: { direction: 'DESC' } },
  endorsements: { endorsements: { direction: 'DESC' } },
  newest: { createdAt: { direction: 'DESC' } },
  updated: { updatedAt: { direction: 'DESC' } },
  name: { name: { direction: 'ASC' } },
};

async function gqlMods(filter, sort, count, offset) {
  const body = {
    query: `query Mods($filter: ModsFilter, $sort: [ModsSort!], $count: Int, $offset: Int) {
      mods(filter: $filter, sort: $sort, count: $count, offset: $offset) {
        totalCount
        nodes {
          modId name summary author version downloads endorsements
          pictureUrl thumbnailUrl updatedAt createdAt adult
          modCategory { name }
        }
      }
    }`,
    variables: { filter, sort, count, offset },
  };
  const res = await fetch(`${API.replace('/v1', '')}/v2/graphql`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Application-Name': 'zero-company-mod-command' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Nexus Mods replied ${res.status} ${res.statusText}.`);
  const json = await res.json();
  if (json.errors && json.errors.length) throw new Error(`Nexus Mods query failed: ${json.errors[0].message}`);
  const mods = (json.data.mods.nodes || []).map((n) => ({
    modId: n.modId,
    name: n.name,
    summary: n.summary || '',
    author: n.author,
    version: n.version,
    downloads: n.downloads,
    endorsements: n.endorsements,
    picture: n.thumbnailUrl || n.pictureUrl || null,
    category: n.modCategory ? n.modCategory.name : null,
    updatedAt: n.updatedAt,
    adult: !!n.adult,
    url: `https://www.nexusmods.com/${GAME_DOMAIN}/mods/${n.modId}`,
  }));
  return { totalCount: json.data.mods.totalCount, mods };
}

async function browseMods({ query, category, sort, offset = 0, count = 24 } = {}) {
  const filter = { gameDomainName: { value: GAME_DOMAIN, op: 'EQUALS' } };
  if (query && query.trim()) filter.name = { value: query.trim(), op: 'WILDCARD' };
  if (category) filter.categoryName = { value: category, op: 'EQUALS' };
  return gqlMods(filter, [SORTS[sort] || SORTS.downloads], count, offset);
}

// All Zero Company mods by the given authors (for the promoted/featured strip).
async function modsByAuthors(authors) {
  const clean = [...new Set((authors || []).map((a) => String(a).trim()).filter(Boolean))];
  if (!clean.length) return [];
  const results = await Promise.allSettled(clean.map((author) =>
    gqlMods(
      { gameDomainName: { value: GAME_DOMAIN, op: 'EQUALS' }, author: { value: author, op: 'EQUALS' } },
      [SORTS.updated], 20, 0,
    )));
  const byId = new Map();
  for (const r of results) {
    if (r.status !== 'fulfilled') continue;
    for (const mod of r.value.mods) byId.set(mod.modId, mod);
  }
  return [...byId.values()].sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
}

// v1: md5 lookup — identifies a file that matches a Nexus-hosted download.
// Only matches when the local file IS the uploaded file (e.g. a bare pak that
// was uploaded as-is); extracted archive contents usually won't match. Returns
// { modId, modName, version, fileId, fileName } or null.
async function md5Lookup(filePath, apiKey) {
  const crypto = require('crypto');
  const fs = require('fs');
  const md5 = await new Promise((resolve, reject) => {
    const hash = crypto.createHash('md5');
    fs.createReadStream(filePath)
      .on('data', (d) => hash.update(d))
      .on('end', () => resolve(hash.digest('hex')))
      .on('error', reject);
  });
  const res = await fetch(`${API}/games/${GAME_DOMAIN}/mods/md5_search/${md5}.json`, {
    headers: { apikey: apiKey, 'Application-Name': 'zero-company-mod-command' },
  });
  if (res.status === 404) return null; // no match
  if (!res.ok) return null;            // best-effort: treat API trouble as no match
  const results = await res.json();
  const hit = Array.isArray(results) && results[0];
  if (!hit || !hit.mod) return null;
  return {
    modId: hit.mod.mod_id,
    modName: hit.mod.name,
    version: hit.mod.version || null,
    fileId: hit.file_details ? hit.file_details.file_id : null,
    fileName: hit.file_details ? hit.file_details.file_name : null,
  };
}

// v1: list a mod's downloadable files (works for all accounts; links need premium or nxm key).
async function filesList(modId, apiKey) {
  const data = await apiGet(`/games/${GAME_DOMAIN}/mods/${modId}/files.json`, apiKey);
  return data.files || [];
}

// The site's MAIN-category file, newest first.
function pickPrimaryFile(files) {
  const usable = files.filter((f) => f.category_name && f.category_name !== 'ARCHIVED' && f.category_name !== 'OLD_VERSION');
  const main = usable.filter((f) => f.is_primary || f.category_name === 'MAIN');
  const pool = main.length ? main : usable;
  pool.sort((a, b) => (b.uploaded_timestamp || 0) - (a.uploaded_timestamp || 0));
  return pool[0] || null;
}

module.exports = {
  GAME_DOMAIN, parseNxm, validateKey, modInfo, fileInfo, downloadLink, downloadToFile,
  browseMods, modsByAuthors, filesList, pickPrimaryFile, md5Lookup,
};

'use strict';
// OWNER TOOL — announces a new launcher version to every installed launcher by
// pushing launcher-version.json to EnvianMods/SWZeroCompanyFeaturedAuthors.
// Run this AFTER uploading the new build to the download page.
//
// Usage:
//   node update-launcher-version.js 1.2.0 https://www.nexusmods.com/starwarszerocompany/mods/<id>?tab=files
//   node update-launcher-version.js 1.2.0 <url> --notes "The Forge + mod update checks"
//   node update-launcher-version.js --show
//
// Auth: same token.txt / GITHUB_TOKEN as the other owner tools.

const fs = require('fs');
const path = require('path');

const OWNER = 'EnvianMods';
const REPO = 'SWZeroCompanyFeaturedAuthors';
const FILE = 'launcher-version.json';
const API = `https://api.github.com/repos/${OWNER}/${REPO}/contents/${FILE}`;
const RAW = `https://raw.githubusercontent.com/${OWNER}/${REPO}/main/${FILE}`;

function getToken() {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN.trim();
  const tokenFile = path.join(__dirname, 'token.txt');
  if (fs.existsSync(tokenFile)) return fs.readFileSync(tokenFile, 'utf8').trim();
  return null;
}

async function gh(url, options = {}) {
  const token = getToken();
  return fetch(url, {
    ...options,
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'zc-launcher-version-tool',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(options.headers || {}),
    },
  });
}

(async () => {
  const args = process.argv.slice(2);
  if (args.includes('--show')) {
    const res = await fetch(RAW, { cache: 'no-store' });
    if (res.status === 404) { console.log('No launcher-version.json published yet — no update banners are shown.'); return; }
    console.log('Currently published:', JSON.stringify(await res.json(), null, 2));
    return;
  }

  const notesIdx = args.indexOf('--notes');
  const notes = notesIdx !== -1 ? args[notesIdx + 1] || '' : '';
  const positional = args.filter((a, i) => !a.startsWith('--') && i !== notesIdx + 1);
  const [version, url] = positional;

  if (!version || !/^\d+\.\d+\.\d+$/.test(version)) {
    console.error('Usage: node update-launcher-version.js <version like 1.2.0> <download url> [--notes "..."]');
    process.exit(1);
  }
  if (!url || !/^https:\/\//.test(url)) {
    console.error('A https:// download URL is required (the Nexus mod page, or later your GitHub releases page).');
    process.exit(1);
  }
  if (!getToken()) {
    console.error('No GitHub token found. Set GITHUB_TOKEN or put the token in token.txt next to this script.');
    process.exit(1);
  }

  const body = JSON.stringify({
    latest: version,
    url,
    notes: notes || null,
    publishedAt: new Date().toISOString(),
  }, null, 2) + '\n';
  console.log('Announcing:\n' + body);

  let sha;
  const current = await gh(API);
  if (current.status === 200) sha = (await current.json()).sha;
  else if (current.status !== 404) {
    console.error(`GitHub replied ${current.status}:`, await current.text());
    process.exit(1);
  }

  const put = await gh(API, {
    method: 'PUT',
    body: JSON.stringify({
      message: `Announce launcher v${version}`,
      content: Buffer.from(body, 'utf8').toString('base64'),
      ...(sha ? { sha } : {}),
    }),
  });
  if (!put.ok) {
    console.error(`Publish failed (${put.status}):`, await put.text());
    process.exit(1);
  }
  console.log('Published. Every launcher older than v' + version + ' now shows the update banner (within ~an hour, or on next start).');
})().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });

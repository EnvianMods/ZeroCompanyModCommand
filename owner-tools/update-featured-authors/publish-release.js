'use strict';
// OWNER TOOL — one-command launcher release to GitHub:
//   1. creates a GitHub Release (tag vX.Y.Z) on the launcher repo
//   2. uploads the shipping zip as a release asset
//   3. announces the version to every installed launcher (launcher-version.json)
//
// Usage (run after `npm run dist` and zipping, or point at the archive copy):
//   node publish-release.js 1.2.0 "G:\...\release\ZeroCompanyModCommand-v1.2.0.zip" --notes "What's new"
//   node publish-release.js --show          (list existing releases)
//
// Requirements: the GitHub token (token.txt / GITHUB_TOKEN) needs Contents
// read/write on BOTH repos below.

const fs = require('fs');
const path = require('path');

const OWNER = 'EnvianMods';
const LAUNCHER_REPO = 'ZeroCompanyModCommand';   // create at github.com/new (public)
const API = `https://api.github.com/repos/${OWNER}/${LAUNCHER_REPO}`;

function getToken() {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN.trim();
  const tokenFile = path.join(__dirname, 'token.txt');
  if (fs.existsSync(tokenFile)) return fs.readFileSync(tokenFile, 'utf8').trim();
  return null;
}

async function gh(url, options = {}) {
  return fetch(url, {
    ...options,
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'zc-release-tool',
      Authorization: `Bearer ${getToken()}`,
      ...(options.headers || {}),
    },
  });
}

(async () => {
  const args = process.argv.slice(2);
  if (!getToken()) {
    console.error('No GitHub token found (token.txt or GITHUB_TOKEN). It needs Contents read/write on', `${OWNER}/${LAUNCHER_REPO}`, 'and the roster repo.');
    process.exit(1);
  }

  if (args.includes('--show')) {
    const res = await gh(`${API}/releases?per_page=10`);
    if (!res.ok) { console.error(`GitHub replied ${res.status} — does ${OWNER}/${LAUNCHER_REPO} exist and does the token cover it?`); process.exit(1); }
    for (const r of await res.json()) {
      console.log('-', r.tag_name, '|', r.name, '|', (r.assets || []).map((a) => a.name).join(', ') || 'no assets');
    }
    return;
  }

  const notesIdx = args.indexOf('--notes');
  const notes = notesIdx !== -1 ? args[notesIdx + 1] || '' : '';
  const positional = args.filter((a, i) => !a.startsWith('--') && i !== notesIdx + 1);
  const [version, zipPath] = positional;
  if (!version || !/^\d+\.\d+\.\d+$/.test(version) || !zipPath || !fs.existsSync(zipPath)) {
    console.error('Usage: node publish-release.js <version like 1.2.0> <path-to-zip> [--notes "..."]');
    process.exit(1);
  }

  // 1. create the release
  console.log(`Creating release v${version} on ${OWNER}/${LAUNCHER_REPO}…`);
  const createRes = await gh(`${API}/releases`, {
    method: 'POST',
    body: JSON.stringify({
      tag_name: `v${version}`,
      name: `Zero Company Mod Command v${version}`,
      body: notes || `Release v${version}. See CHANGELOG.md for details.`,
    }),
  });
  if (!createRes.ok) {
    console.error(`Release creation failed (${createRes.status}):`, (await createRes.text()).slice(0, 400));
    console.error(`Is the repo created (github.com/${OWNER}/${LAUNCHER_REPO}) and the token scoped to it?`);
    process.exit(1);
  }
  const release = await createRes.json();

  // 2. upload the zip asset
  const assetName = path.basename(zipPath);
  console.log(`Uploading ${assetName} (${(fs.statSync(zipPath).size / 1048576).toFixed(1)} MB)…`);
  const uploadUrl = release.upload_url.replace(/\{.*\}$/, '') + `?name=${encodeURIComponent(assetName)}`;
  const uploadRes = await gh(uploadUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/zip' },
    body: fs.readFileSync(zipPath),
  });
  if (!uploadRes.ok) {
    console.error(`Asset upload failed (${uploadRes.status}):`, (await uploadRes.text()).slice(0, 400));
    process.exit(1);
  }
  console.log('Release published:', release.html_url);

  // 3. announce to installed launchers
  console.log('Announcing to installed launchers…');
  const { spawnSync } = require('child_process');
  const announce = spawnSync(process.execPath, [
    path.join(__dirname, 'update-launcher-version.js'),
    version, release.html_url,
    ...(notes ? ['--notes', notes] : []),
  ], { stdio: 'inherit' });
  process.exit(announce.status || 0);
})().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });

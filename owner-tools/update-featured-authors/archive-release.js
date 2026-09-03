'use strict';
// OWNER TOOL — pushes a version archive to the GitHub archive repo
// (EnvianMods/ZeroCompanyModCommandArchive), replacing the local
// "Envian Mods and Projects" copy step. Each version becomes a GitHub Release
// (tag vX.Y.Z) whose assets are the shipping zip + source snapshot (kept out of
// git history so the repo stays lean); CHANGELOG.md and README.md in the repo
// are synced from the project on every run.
//
// Usage:
//   node archive-release.js <version> [--notes "..."] <file1.zip> [file2.zip ...]
//   node archive-release.js --show
//
// Example:
//   node archive-release.js 1.0.0 --notes "First public release" ^
//     "..\..\release\ZeroCompanyModCommand-v1.0.0.zip" "path\to\source-v1.0.0.zip"
//
// Auth: token.txt / GITHUB_TOKEN with Contents read/write on the archive repo.

const fs = require('fs');
const path = require('path');

const OWNER = 'EnvianMods';
const REPO = 'ZeroCompanyModCommandArchive';
const API = `https://api.github.com/repos/${OWNER}/${REPO}`;
const PROJECT_ROOT = path.join(__dirname, '..', '..');

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
      'User-Agent': 'zc-archive-tool',
      Authorization: `Bearer ${getToken()}`,
      ...(options.headers || {}),
    },
  });
}

// Create or update a repo file (contents API needs the current sha to update).
async function putFile(repoPath, content, message) {
  let sha;
  const current = await gh(`${API}/contents/${repoPath}`);
  if (current.status === 200) sha = (await current.json()).sha;
  const res = await gh(`${API}/contents/${repoPath}`, {
    method: 'PUT',
    body: JSON.stringify({
      message,
      content: Buffer.from(content, 'utf8').toString('base64'),
      ...(sha ? { sha } : {}),
    }),
  });
  return res.ok;
}

(async () => {
  if (!getToken()) {
    console.error(`No GitHub token found. It needs Contents read/write on ${OWNER}/${REPO}.`);
    process.exit(1);
  }

  const args = process.argv.slice(2);
  if (args.includes('--show')) {
    const res = await gh(`${API}/releases?per_page=20`);
    if (!res.ok) { console.error(`GitHub replied ${res.status} — does ${OWNER}/${REPO} exist and does the token cover it?`); process.exit(1); }
    const releases = await res.json();
    if (!releases.length) console.log('No archived versions yet.');
    for (const r of releases) {
      console.log('-', r.tag_name, '|', (r.assets || []).map((a) => `${a.name} (${(a.size / 1048576).toFixed(1)} MB)`).join(', ') || 'no assets');
    }
    return;
  }

  const notesIdx = args.indexOf('--notes');
  const notes = notesIdx !== -1 ? args[notesIdx + 1] || '' : '';
  const positional = args.filter((a, i) => !a.startsWith('--') && i !== notesIdx + 1);
  const [version, ...files] = positional;
  if (!version || !/^\d+\.\d+\.\d+$/.test(version) || !files.length) {
    console.error('Usage: node archive-release.js <version> [--notes "..."] <file.zip> [more files...]');
    process.exit(1);
  }
  for (const f of files) {
    if (!fs.existsSync(f)) { console.error('File not found:', f); process.exit(1); }
  }

  // 1. release (reuse if the tag already exists so re-runs can add assets)
  let release;
  const existing = await gh(`${API}/releases/tags/v${version}`);
  if (existing.status === 200) {
    release = await existing.json();
    console.log(`Release v${version} already exists — adding assets to it.`);
  } else {
    const createRes = await gh(`${API}/releases`, {
      method: 'POST',
      body: JSON.stringify({
        tag_name: `v${version}`,
        name: `Archive v${version}`,
        body: notes || `Version archive for Zero Company Mod Command v${version}.`,
      }),
    });
    if (!createRes.ok) {
      console.error(`Release creation failed (${createRes.status}):`, (await createRes.text()).slice(0, 300));
      console.error(`Is github.com/${OWNER}/${REPO} created and the token scoped to it?`);
      process.exit(1);
    }
    release = await createRes.json();
  }

  // 2. upload assets
  const have = new Set((release.assets || []).map((a) => a.name));
  for (const f of files) {
    const name = path.basename(f);
    if (have.has(name)) { console.log(`skip ${name} (already uploaded)`); continue; }
    console.log(`Uploading ${name} (${(fs.statSync(f).size / 1048576).toFixed(1)} MB)…`);
    const uploadUrl = release.upload_url.replace(/\{.*\}$/, '') + `?name=${encodeURIComponent(name)}`;
    const res = await gh(uploadUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/zip' },
      body: fs.readFileSync(f),
    });
    if (!res.ok) { console.error(`Upload of ${name} failed (${res.status}):`, (await res.text()).slice(0, 300)); process.exit(1); }
  }

  // 3. sync repo docs from the project
  const changelog = fs.readFileSync(path.join(PROJECT_ROOT, 'CHANGELOG.md'), 'utf8');
  await putFile('CHANGELOG.md', changelog, `Sync changelog for v${version}`);
  const readme = [
    '# Zero Company Mod Command — Version Archive',
    '',
    'Automated archive of every released version of',
    '[Zero Company Mod Command](https://www.nexusmods.com/starwarszerocompany/mods) by Envian Mods.',
    '',
    'Each **Release** on this repo holds one version: the shipping zip exactly as',
    'uploaded to Nexus Mods, plus the full source snapshot it was built from.',
    'See CHANGELOG.md for version history.',
    '',
    'Pushed automatically by the release tooling (owner-tools/archive-release).',
    '',
  ].join('\n');
  await putFile('README.md', readme, 'Sync archive README');

  console.log(`Archived v${version}:`, release.html_url);
})().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });

'use strict';
// OWNER TOOL — pushes a version archive of ANY Envian Mods project to its
// GitHub archive repo. Each version becomes a GitHub Release (tag vX.Y.Z)
// whose assets are the files you pass (shipping zip, source snapshot, …) —
// kept out of git history so the repo stays lean. A changelog can be synced
// into the repo alongside a generated README.
//
// Usage:
//   node archive-release.js [--repo Owner/Name] <version> [options] <file1> [file2 ...]
//   node archive-release.js [--repo Owner/Name] --show
//
// Options:
//   --repo Owner/Name       target archive repo
//                           (default: EnvianMods/ZeroCompanyModCommandArchive)
//   --title "Project Name"  project name for the repo README (default: from repo name)
//   --notes "..."           release notes
//   --changelog <path>      CHANGELOG.md to sync into the repo (default: auto-detect
//                           for Zero Company Mod Command; skipped when not found)
//
// Examples:
//   node archive-release.js 1.1.0 build.zip source.zip --notes "..."
//   node archive-release.js --repo EnvianMods/PZLifestyleArchive --title "Envians Lifestyle Music Pack" 2.0.0 pack.zip
//
// Auth: archive-token.txt (preferred) or token.txt next to this script, or
// GITHUB_TOKEN — needs Contents read/write on the target repo.

const fs = require('fs');
const path = require('path');

const DEFAULT_REPO = 'EnvianMods/ZeroCompanyModCommandArchive';
const DEFAULT_CHANGELOG_HOMES = [
  path.join(__dirname, '..', '..'),
  'G:\\SteamLibrary\\steamapps\\common\\Star Wars Zero Company\\ZeroCompanyModManager',
];

function getToken() {
  for (const f of ['archive-token.txt', 'token.txt']) {
    const tokenFile = path.join(__dirname, f);
    if (fs.existsSync(tokenFile)) {
      const t = fs.readFileSync(tokenFile, 'utf8').trim();
      if (t) return t;
    }
  }
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN.trim();
  return null;
}

function parseArgs(argv) {
  const out = { files: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--show') out.flags.show = true;
    else if (['--repo', '--title', '--notes', '--changelog'].includes(a)) out.flags[a.slice(2)] = argv[++i] || '';
    else if (!out.version && /^\d+\.\d+\.\d+$/.test(a)) out.version = a;
    else out.files.push(a);
  }
  return out;
}

(async () => {
  const { version, files, flags } = parseArgs(process.argv.slice(2));
  const repo = flags.repo || DEFAULT_REPO;
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) { console.error('Bad --repo (expected Owner/Name):', repo); process.exit(1); }
  const API = `https://api.github.com/repos/${repo}`;
  const projectTitle = flags.title
    || (repo.endsWith('Archive') ? repo.split('/')[1].replace(/Archive$/, '') : repo.split('/')[1])
      .replace(/([a-z])([A-Z])/g, '$1 $2');

  if (!getToken()) {
    console.error(`No GitHub token found. It needs Contents read/write on ${repo}.`);
    process.exit(1);
  }
  const gh = (url, options = {}) => fetch(url, {
    ...options,
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'envian-archive-tool',
      Authorization: `Bearer ${getToken()}`,
      ...(options.headers || {}),
    },
  });
  const putFile = async (repoPath, content, message) => {
    let sha;
    const current = await gh(`${API}/contents/${repoPath}`);
    if (current.status === 200) sha = (await current.json()).sha;
    const res = await gh(`${API}/contents/${repoPath}`, {
      method: 'PUT',
      body: JSON.stringify({ message, content: Buffer.from(content, 'utf8').toString('base64'), ...(sha ? { sha } : {}) }),
    });
    return res.ok;
  };

  if (flags.show) {
    const res = await gh(`${API}/releases?per_page=30`);
    if (!res.ok) { console.error(`GitHub replied ${res.status} — does ${repo} exist and does the token cover it?`); process.exit(1); }
    const releases = await res.json();
    if (!releases.length) console.log(`No archived versions in ${repo} yet.`);
    for (const r of releases) {
      console.log('-', r.tag_name, '|', (r.assets || []).map((a) => `${a.name} (${(a.size / 1048576).toFixed(1)} MB)`).join(', ') || 'no assets');
    }
    return;
  }

  if (!version || !files.length) {
    console.error('Usage: node archive-release.js [--repo Owner/Name] <version> [--title "..."] [--notes "..."] [--changelog path] <file> [more files...]');
    process.exit(1);
  }
  for (const f of files) {
    if (!fs.existsSync(f)) { console.error('File not found:', f); process.exit(1); }
  }

  // 1. release (reuse if the tag exists so re-runs can add missing assets)
  let release;
  const existing = await gh(`${API}/releases/tags/v${version}`);
  if (existing.status === 200) {
    release = await existing.json();
    console.log(`Release v${version} already exists in ${repo} — adding assets to it.`);
  } else {
    const createRes = await gh(`${API}/releases`, {
      method: 'POST',
      body: JSON.stringify({
        tag_name: `v${version}`,
        name: `Archive v${version}`,
        body: flags.notes || `Version archive for ${projectTitle} v${version}.`,
      }),
    });
    if (!createRes.ok) {
      console.error(`Release creation failed (${createRes.status}):`, (await createRes.text()).slice(0, 300));
      console.error(`Is github.com/${repo} created and the token scoped to it?`);
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

  // 3. sync docs
  let changelogPath = flags.changelog;
  if (!changelogPath && repo === DEFAULT_REPO) {
    const home = DEFAULT_CHANGELOG_HOMES.find((p) => fs.existsSync(path.join(p, 'CHANGELOG.md')));
    if (home) changelogPath = path.join(home, 'CHANGELOG.md');
  }
  if (changelogPath && fs.existsSync(changelogPath)) {
    await putFile('CHANGELOG.md', fs.readFileSync(changelogPath, 'utf8'), `Sync changelog for v${version}`);
  } else if (flags.changelog) {
    console.log('Changelog not found at', flags.changelog, '— skipped.');
  }
  const readme = [
    `# ${projectTitle} — Version Archive`,
    '',
    `Automated archive of every released version of **${projectTitle}** by Envian Mods.`,
    '',
    'Each **Release** on this repo holds one version, with the shipped file(s) and',
    'source snapshot as release assets. Pushed automatically by the Envian Mods',
    'archive tooling.',
    '',
  ].join('\n');
  await putFile('README.md', readme, 'Sync archive README');

  console.log(`Archived ${projectTitle} v${version}:`, release.html_url);
})().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });

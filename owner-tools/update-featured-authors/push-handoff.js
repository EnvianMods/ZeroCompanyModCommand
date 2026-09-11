'use strict';
// OWNER TOOL — pushes the local internal working notes (HANDOFF.md) to the
// PRIVATE archive repo at docs/HANDOFF.md on branch main.
//
// WHY: HANDOFF.md is deliberately NOT tracked in the public repo (it is in
// .gitignore) so it can never end up inside GitHub's automatic
// "Source code (zip/tar.gz)" assets of a public tag. The handoff still needs a
// durable off-machine home, so it lives in the archive repo instead. Run this
// after every HANDOFF edit — those edits are no longer git commits.
//
// Usage:
//   node push-handoff.js                 push the local HANDOFF.md
//   node push-handoff.js --show          print what is currently in the archive
//   node push-handoff.js --file <path>   push a specific file
//
// Options:
//   --repo Owner/Name   target archive repo
//                       (default: EnvianMods/ZeroCompanyModCommandArchive)
//   --branch <name>     target branch (default: main)
//   --path <repo path>  target path in the repo (default: docs/HANDOFF.md)
//   --file <path>       local file to push (default: HANDOFF.md at the repo root)
//   --message "..."     commit message (default: "HANDOFF <YYYY-MM-DD HH:mm>")
//   --show              show the archived copy's size/sha and whether it matches
//
// Auth: archive-token.txt (preferred) or token.txt next to this script, or
// GITHUB_TOKEN — needs Contents read/write on the target repo. Same precedence
// as archive-release.js. Never print the token.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DEFAULT_REPO = 'EnvianMods/ZeroCompanyModCommandArchive';
const DEFAULT_BRANCH = 'main';
const DEFAULT_REPO_PATH = 'docs/HANDOFF.md';
const DEFAULT_HANDOFF_HOMES = [
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

// GitHub's Contents API "sha" is the git blob sha1 of the raw bytes.
function blobSha(buf) {
  return crypto.createHash('sha1').update(`blob ${buf.length}\0`).update(buf).digest('hex');
}

function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function parseArgs(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--show') flags.show = true;
    else if (['--repo', '--branch', '--path', '--file', '--message'].includes(a)) flags[a.slice(2)] = argv[++i] || '';
  }
  return flags;
}

function findHandoff(flags) {
  if (flags.file) return path.resolve(flags.file);
  for (const home of DEFAULT_HANDOFF_HOMES) {
    const p = path.join(home, 'HANDOFF.md');
    if (fs.existsSync(p)) return p;
  }
  return null;
}

(async () => {
  const flags = parseArgs(process.argv.slice(2));
  const repo = flags.repo || DEFAULT_REPO;
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) { console.error('Bad --repo (expected Owner/Name):', repo); process.exit(1); }
  const branch = flags.branch || DEFAULT_BRANCH;
  const repoPath = (flags.path || DEFAULT_REPO_PATH).replace(/^\/+/, '');
  const API = `https://api.github.com/repos/${repo}`;

  if (!getToken()) {
    console.error(`No GitHub token found (archive-token.txt / token.txt / GITHUB_TOKEN). It needs Contents read/write on ${repo}.`);
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

  const localPath = findHandoff(flags);
  if (!localPath || !fs.existsSync(localPath)) {
    console.error('Local HANDOFF.md not found. Looked in:', DEFAULT_HANDOFF_HOMES.join(', '), '— pass --file <path>.');
    process.exit(1);
  }
  const content = fs.readFileSync(localPath); // raw bytes: keeps CRLF exactly as on disk
  const localSha = blobSha(content);

  // current state in the archive repo
  const current = await gh(`${API}/contents/${encodeURI(repoPath)}?ref=${encodeURIComponent(branch)}`);
  let remote = null;
  if (current.status === 200) {
    remote = await current.json();
  } else if (current.status !== 404) {
    console.error(`GitHub replied ${current.status} for ${repo}/${repoPath}@${branch}:`, (await current.text()).slice(0, 300));
    process.exit(1);
  }

  if (flags.show) {
    console.log(`local  ${localPath}`);
    console.log(`       ${content.length} bytes, blob sha ${localSha}`);
    if (!remote) console.log(`archive ${repo}:${repoPath}@${branch} — not present yet`);
    else {
      console.log(`archive ${repo}:${repoPath}@${branch}`);
      console.log(`       ${remote.size} bytes, sha ${remote.sha}`);
      console.log(remote.sha === localSha ? '       MATCHES the local file' : '       DIFFERS from the local file');
    }
    return;
  }

  if (remote && remote.sha === localSha) {
    console.log(`unchanged — ${repo}:${repoPath}@${branch} already holds this exact HANDOFF.md (${content.length} bytes, sha ${localSha}).`);
    return;
  }

  const message = flags.message || `HANDOFF ${stamp()}`;
  const res = await gh(`${API}/contents/${encodeURI(repoPath)}`, {
    method: 'PUT',
    body: JSON.stringify({
      message,
      branch,
      content: content.toString('base64'),
      ...(remote ? { sha: remote.sha } : {}),
    }),
  });
  if (!res.ok) {
    console.error(`Push failed (${res.status}):`, (await res.text()).slice(0, 400));
    console.error(`Does github.com/${repo} exist with branch ${branch}, and is the token scoped to it?`);
    process.exit(1);
  }
  const out = await res.json();
  console.log(`${remote ? 'Updated' : 'Created'} ${repo}:${repoPath}@${branch} — ${content.length} bytes, sha ${out.content && out.content.sha}`);
  console.log('commit:', out.commit && out.commit.html_url);
})().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });

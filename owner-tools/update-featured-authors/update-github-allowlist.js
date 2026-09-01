'use strict';
// OWNER TOOL — updates the curated GitHub mod allowlist ("The Forge") for every
// installed launcher, live, by pushing github-mods.json to the
// EnvianMods/SWZeroCompanyFeaturedAuthors repo. Do NOT ship with the launcher.
//
// Usage:
//   node update-github-allowlist.js Sternab/ZeroCompanyMandoWardrobe Owner/OtherRepo
//   node update-github-allowlist.js --dry-run Owner/Repo
//   node update-github-allowlist.js --show
//
// Auth: same GitHub token as the featured-authors tool (GITHUB_TOKEN env or
// token.txt next to this script).

const fs = require('fs');
const path = require('path');

const OWNER = 'EnvianMods';
const REPO = 'SWZeroCompanyFeaturedAuthors';
const FILE = 'github-mods.json';
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
      'User-Agent': 'zc-forge-allowlist-tool',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(options.headers || {}),
    },
  });
}

(async () => {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const show = args.includes('--show');
  const repos = args.filter((a) => !a.startsWith('--')).map((a) => a.trim()).filter(Boolean);

  if (show) {
    const res = await fetch(RAW, { cache: 'no-store' });
    if (res.status === 404) { console.log('No github-mods.json published yet — launchers use the baked-in fallback.'); return; }
    console.log('Currently published:', JSON.stringify(await res.json(), null, 2));
    return;
  }

  if (!repos.length) {
    console.error('Usage: node update-github-allowlist.js [--dry-run] <Owner/Repo> [Owner/Repo...]');
    process.exit(1);
  }
  const bad = repos.filter((r) => !/^[\w.-]+\/[\w.-]+$/.test(r));
  if (bad.length) {
    console.error('These are not Owner/Repo names:', bad.join(', '));
    process.exit(1);
  }

  // Sanity-check each repo exists before publishing.
  for (const r of repos) {
    const res = await gh(`https://api.github.com/repos/${r}`);
    console.log(`${res.status === 200 ? 'ok    ' : 'MISSING'} ${r}`);
    if (res.status !== 200) { console.error('Fix the repo name and retry.'); process.exit(1); }
  }

  const body = JSON.stringify({
    allowedRepos: repos,
    updatedAt: new Date().toISOString(),
    note: 'Curated GitHub mod allowlist for Zero Company Mod Command (The Forge).',
  }, null, 2) + '\n';
  console.log('New allowlist file:\n' + body);

  if (dryRun) { console.log('--dry-run: nothing was published.'); return; }
  if (!getToken()) {
    console.error('No GitHub token found. Set GITHUB_TOKEN or put the token in token.txt next to this script.');
    process.exit(1);
  }

  let sha;
  const current = await gh(API);
  if (current.status === 200) sha = (await current.json()).sha;
  else if (current.status !== 404) {
    console.error(`GitHub replied ${current.status} while checking the current file:`, await current.text());
    process.exit(1);
  }

  const put = await gh(API, {
    method: 'PUT',
    body: JSON.stringify({
      message: `Update Forge allowlist: ${repos.length} repo(s)`,
      content: Buffer.from(body, 'utf8').toString('base64'),
      ...(sha ? { sha } : {}),
    }),
  });
  if (!put.ok) {
    console.error(`Publish failed (${put.status}):`, await put.text());
    process.exit(1);
  }
  console.log('Published. Live at:', RAW);
  console.log('Launchers pick it up within ~15 minutes, or immediately on restart.');
})().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });

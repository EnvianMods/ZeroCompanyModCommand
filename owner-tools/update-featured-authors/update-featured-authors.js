'use strict';
// OWNER TOOL — updates the Featured Transmissions roster for EVERY installed
// launcher, live, by pushing featured.json to the EnvianMods/Assets repo.
// Do NOT ship this folder with the launcher.
//
// Usage:
//   node update-featured-authors.js SmexyXey EnvianMN
//   node update-featured-authors.js --dry-run SmexyXey EnvianMN
//   node update-featured-authors.js --show          (print the currently published roster)
//
// Auth: a GitHub personal access token with write access to
// EnvianMods/SWZeroCompanyFeaturedAuthors, taken from the GITHUB_TOKEN
// environment variable or a token.txt file next to this script (one line).
// Create one at:
//   github.com → Settings → Developer settings → Fine-grained tokens
//   Repository access: EnvianMods/SWZeroCompanyFeaturedAuthors
//   Permissions: Contents → Read and write

const fs = require('fs');
const path = require('path');

const OWNER = 'EnvianMods';
const REPO = 'SWZeroCompanyFeaturedAuthors';
const FILE = 'featured.json';
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
  const res = await fetch(url, {
    ...options,
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'zc-featured-roster-tool',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(options.headers || {}),
    },
  });
  return res;
}

(async () => {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const show = args.includes('--show');
  const authors = args.filter((a) => !a.startsWith('--')).map((a) => a.trim()).filter(Boolean);

  if (show) {
    const res = await fetch(RAW, { cache: 'no-store' });
    if (res.status === 404) { console.log('No featured.json published yet — launchers use the baked-in fallback.'); return; }
    console.log('Currently published:', JSON.stringify(await res.json(), null, 2));
    return;
  }

  if (!authors.length) {
    console.error('Usage: node update-featured-authors.js [--dry-run] <AuthorName> [AuthorName...]');
    process.exit(1);
  }

  const payload = {
    promotedAuthors: authors,
    updatedAt: new Date().toISOString(),
    note: 'Featured Transmissions roster for Zero Company Mod Command. Edit via owner-tools/update-featured-authors.',
  };
  const body = JSON.stringify(payload, null, 2) + '\n';
  console.log('New roster file:\n' + body);

  if (dryRun) { console.log('--dry-run: nothing was published.'); return; }

  if (!getToken()) {
    console.error('No GitHub token found. Set the GITHUB_TOKEN environment variable or put the token in token.txt next to this script.');
    process.exit(1);
  }

  // Existing file sha is required by the API when updating.
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
      message: `Update featured roster: ${authors.join(', ')}`,
      content: Buffer.from(body, 'utf8').toString('base64'),
      ...(sha ? { sha } : {}),
    }),
  });
  if (!put.ok) {
    console.error(`Publish failed (${put.status}):`, await put.text());
    process.exit(1);
  }
  console.log('Published. Live at:', RAW);
  console.log('Launchers pick it up within ~15 minutes (GitHub raw cache ~5 min + launcher cache 10 min), or immediately on restart.');
})().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });

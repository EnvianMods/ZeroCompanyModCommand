'use strict';
// OWNER TOOL — updates the community EA-compatibility list for every installed
// launcher, live, by pushing ea-compat.json to the
// EnvianMods/SWZeroCompanyFeaturedAuthors repo. Do NOT ship with the launcher.
//
// The list bridges Steam and EA App players: a mod flagged here shows an
// "EA: not compatible" chip in every launcher (a hard warning for EA users,
// an FYI for Steam users sharing setups). A mod's own modinfo.json wins over
// this list.
//
// Usage:
//   node update-ea-compat.js --bad 123 "uses Steam achievements API" --bad 456 --good 789 "verified by EA testers"
//   node update-ea-compat.js --show
//   node update-ea-compat.js --dry-run --bad 123
//
// Numbers are Nexus mod ids (nexusmods.com/starwarszerocompany/mods/<id>).
// Each run REPLACES the whole list — pass every entry you want live.
// Auth: GITHUB_TOKEN env or token.txt next to this script (roster repo token).

const fs = require('fs');
const path = require('path');

const OWNER = 'EnvianMods';
const REPO = 'SWZeroCompanyFeaturedAuthors';
const FILE = 'ea-compat.json';
const API = `https://api.github.com/repos/${OWNER}/${REPO}/contents/${FILE}`;
const RAW = `https://raw.githubusercontent.com/${OWNER}/${REPO}/main/${FILE}`;

function getToken() {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN.trim();
  const tokenFile = path.join(__dirname, 'token.txt');
  if (fs.existsSync(tokenFile)) return fs.readFileSync(tokenFile, 'utf8').trim();
  return null;
}

function parseEntries(args) {
  const incompatible = [];
  const compatible = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] !== '--bad' && args[i] !== '--good') continue;
    const target = args[i] === '--bad' ? incompatible : compatible;
    const id = Number(args[i + 1]);
    if (!Number.isInteger(id) || id <= 0) {
      throw new Error(`${args[i]} needs a Nexus mod id, got: ${args[i + 1]}`);
    }
    i += 1;
    let note = null;
    if (args[i + 1] && !args[i + 1].startsWith('--')) { note = args[i + 1].slice(0, 200); i += 1; }
    target.push({ nexusModId: id, ...(note ? { note } : {}) });
  }
  return { incompatible, compatible };
}

(async () => {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const show = args.includes('--show');

  if (show) {
    const res = await fetch(RAW, { cache: 'no-store' });
    if (res.status === 404) { console.log('No ea-compat.json published yet — launchers use the empty baked-in fallback.'); return; }
    console.log('Currently published:', JSON.stringify(await res.json(), null, 2));
    return;
  }

  const { incompatible, compatible } = parseEntries(args);
  if (!incompatible.length && !compatible.length) {
    console.error('Usage: node update-ea-compat.js [--dry-run] --bad <nexusModId> ["note"] [--good <nexusModId> ["note"]] ...');
    process.exit(1);
  }

  const body = JSON.stringify({
    incompatible,
    compatible,
    updatedAt: new Date().toISOString(),
    note: 'Community EA App compatibility list for Zero Company Mod Command. modinfo.json declarations override this.',
  }, null, 2) + '\n';
  console.log('New compat file:\n' + body);

  if (dryRun) { console.log('--dry-run: nothing was published.'); return; }
  if (!getToken()) {
    console.error('No GitHub token found. Set GITHUB_TOKEN or put the token in token.txt next to this script.');
    process.exit(1);
  }

  const gh = (url, options = {}) => fetch(url, {
    ...options,
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'zc-ea-compat-tool',
      Authorization: `Bearer ${getToken()}`,
      ...(options.headers || {}),
    },
  });

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
      message: `Update EA compat list: ${incompatible.length} incompatible, ${compatible.length} compatible`,
      content: Buffer.from(body, 'utf8').toString('base64'),
      ...(sha ? { sha } : {}),
    }),
  });
  if (!put.ok) {
    console.error(`Publish failed (${put.status}):`, await put.text());
    process.exit(1);
  }
  console.log('Published. Live at:', RAW);
  console.log('Launchers pick it up within ~30 minutes, or immediately on restart.');
})().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });

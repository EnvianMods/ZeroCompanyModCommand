'use strict';
// OWNER TOOL — announces a new launcher version to every installed launcher by
// pushing launcher-version.json to EnvianMods/SWZeroCompanyFeaturedAuthors.
// Run this AFTER uploading the new build to the download page.
//
// The file carries TWO things, because Mod Command hard-codes no download
// destination for either half:
//   latest/url/notes/publishedAt — MOD COMMAND's own update announcement
//   sdk: { url, updateUrl }      — where to get the Zero Company Mod SDK, and
//                                  where the SDK publishes sdk-version.json
// The `sdk` block is PRESERVED on every write unless you override it, so
// announcing a launcher version can never silently drop the SDK's download
// link. At launch both halves flip from GitHub to the Nexus pages by editing
// this one file.
//
// Usage:
//   node update-launcher-version.js 1.2.0 https://www.nexusmods.com/starwarszerocompany/mods/<id>?tab=files
//   node update-launcher-version.js 1.2.0 <url> --notes "The Forge + mod update checks"
//   node update-launcher-version.js 1.2.0 <url> --sdk-url <page> --sdk-update-url <sdk-version.json>
//   node update-launcher-version.js --sdk-only --sdk-url <page> [--sdk-update-url <url>]
//   node update-launcher-version.js --show
//   ... any of the above with --dry-run to print the body and publish nothing.
//
// Auth: same token.txt / GITHUB_TOKEN as the other owner tools.

const fs = require('fs');
const path = require('path');

const OWNER = 'EnvianMods';
const REPO = 'SWZeroCompanyFeaturedAuthors';
const FILE = 'launcher-version.json';
const API = `https://api.github.com/repos/${OWNER}/${REPO}/contents/${FILE}`;
// The same env override lib/launcher-update.js honours, so a dry run can be
// pointed at a local fixture instead of the live file.
const RAW = process.env.ZC_LAUNCHER_VERSION_URL
  || `https://raw.githubusercontent.com/${OWNER}/${REPO}/main/${FILE}`;

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

// Flags that take a value; everything else starting with -- is a bare flag and
// anything left over is positional. (The old index arithmetic could not tell a
// flag's value from a positional once there was more than one such flag.)
const VALUED = { '--notes': 'notes', '--sdk-url': 'sdkUrl', '--sdk-update-url': 'sdkUpdateUrl' };

function parseArgs(argv) {
  const out = { flags: new Set(), positional: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (Object.prototype.hasOwnProperty.call(VALUED, a)) { out[VALUED[a]] = argv[++i]; continue; }
    if (a.startsWith('--')) { out.flags.add(a); continue; }
    out.positional.push(a);
  }
  return out;
}

// THE function that must not drop anything. Takes the CURRENTLY PUBLISHED
// object (or null when nothing is published yet) and returns the exact body to
// write. Pure, exported, and unit-testable without touching GitHub.
//
//   * the `sdk` block is carried through untouched unless --sdk-url /
//     --sdk-update-url override a field
//   * --sdk-only rewrites ONLY `sdk` and leaves every other key — including
//     any key this tool does not know about — exactly as published
function buildBody(current, opts = {}) {
  const cur = current && typeof current === 'object' && !Array.isArray(current) ? current : {};
  const had = cur.sdk && typeof cur.sdk === 'object' && !Array.isArray(cur.sdk) ? cur.sdk : null;

  let sdk = had ? { ...had } : null;
  if (opts.sdkUrl !== undefined || opts.sdkUpdateUrl !== undefined) {
    sdk = {
      url: opts.sdkUrl !== undefined ? opts.sdkUrl : (had && had.url) || null,
      updateUrl: opts.sdkUpdateUrl !== undefined ? opts.sdkUpdateUrl : (had && had.updateUrl) || null,
    };
  }

  let out;
  if (opts.sdkOnly) {
    out = { ...cur };
    if (sdk) out.sdk = sdk; else delete out.sdk;
  } else {
    out = {
      latest: opts.version,
      url: opts.url,
      notes: opts.notes || null,
      publishedAt: (opts.now || new Date()).toISOString(),
    };
    if (sdk) out.sdk = sdk;
  }
  return JSON.stringify(out, null, 2) + '\n';
}

async function readCurrent() {
  const res = await fetch(RAW, { cache: 'no-store' });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`could not read the published ${FILE} (${res.status})`);
  try { return await res.json(); } catch (_) { return null; }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const dryRun = args.flags.has('--dry-run');
  const sdkOnly = args.flags.has('--sdk-only');

  if (args.flags.has('--show')) {
    const current = await readCurrent();
    if (!current) { console.log('No launcher-version.json published yet — no update banners are shown.'); return; }
    console.log('Currently published:', JSON.stringify(current, null, 2));
    console.log('SDK block:', current.sdk
      ? `url=${current.sdk.url || '(none)'} updateUrl=${current.sdk.updateUrl || '(none)'}`
      : '(none) — the Get-the-SDK page shows no download button.');
    return;
  }

  for (const [flag, key] of [['--sdk-url', 'sdkUrl'], ['--sdk-update-url', 'sdkUpdateUrl']]) {
    if (args[key] !== undefined && !/^https:\/\//.test(String(args[key]))) {
      console.error(`${flag} needs a https:// URL.`);
      process.exit(1);
    }
  }

  const [version, url] = args.positional;
  if (sdkOnly) {
    if (args.sdkUrl === undefined && args.sdkUpdateUrl === undefined) {
      console.error('--sdk-only needs --sdk-url and/or --sdk-update-url.');
      process.exit(1);
    }
    if (version) {
      console.error('--sdk-only rewrites ONLY the sdk block — drop the version/url arguments.');
      process.exit(1);
    }
  } else {
    if (!version || !/^\d+\.\d+\.\d+$/.test(version)) {
      console.error('Usage: node update-launcher-version.js <version like 1.2.0> <download url> [--notes "..."] [--sdk-url <url>] [--sdk-update-url <url>]');
      console.error('       node update-launcher-version.js --sdk-only --sdk-url <url> [--sdk-update-url <url>]');
      process.exit(1);
    }
    if (!url || !/^https:\/\//.test(url)) {
      console.error('A https:// download URL is required (the Nexus mod page, or later your GitHub releases page).');
      process.exit(1);
    }
  }
  if (!dryRun && !getToken()) {
    console.error('No GitHub token found. Set GITHUB_TOKEN or put the token in token.txt next to this script.');
    process.exit(1);
  }

  // Read before write: the published sdk block rides through every launcher
  // announcement untouched.
  const current = await readCurrent();
  const body = buildBody(current, {
    version, url, notes: args.notes, sdkOnly,
    sdkUrl: args.sdkUrl, sdkUpdateUrl: args.sdkUpdateUrl,
  });
  console.log(`${dryRun ? 'DRY RUN — would publish' : (sdkOnly ? 'Rewriting the sdk block only' : 'Announcing')}:\n` + body);
  if (dryRun) { console.log('--dry-run: nothing was sent to GitHub.'); return; }

  let sha;
  const head = await gh(API);
  if (head.status === 200) sha = (await head.json()).sha;
  else if (head.status !== 404) {
    console.error(`GitHub replied ${head.status}:`, await head.text());
    process.exit(1);
  }

  const put = await gh(API, {
    method: 'PUT',
    body: JSON.stringify({
      message: sdkOnly ? 'Point the SDK download at a new page' : `Announce launcher v${version}`,
      content: Buffer.from(body, 'utf8').toString('base64'),
      ...(sha ? { sha } : {}),
    }),
  });
  if (!put.ok) {
    console.error(`Publish failed (${put.status}):`, await put.text());
    process.exit(1);
  }
  console.log(sdkOnly
    ? 'Published. Every launcher picks the new SDK download link up within ~an hour, or on next start.'
    : 'Published. Every launcher older than v' + version + ' now shows the update banner (within ~an hour, or on next start).');
}

module.exports = { buildBody, parseArgs };

if (require.main === module) {
  main().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
}

'use strict';
// Fetches the tools that the build-from-source package leaves out (Nexus's file
// scan holds packages that carry binaries or nested archives). Run by
// `npm run build-exe` before electron-builder; every step is optional — the
// app works without any of them, with the matching feature reporting itself
// as unavailable in Diagnostics.
//   tools/7-Zip/7z.exe + 7z.dll  — .7z/.rar mod archives (7-Zip 25.01, LGPL)
//   tools/retoc.exe              — lists files inside pak/iostore mods (retoc 0.1.5)
//   tools/ZCSDKRuntime.zip       — offline copy of the newest ZCSDK Runtime
//   tools/licenses/              — license texts for the above; refreshed on
//                                  every run so a fresh build always ships them
// Windows only; on other platforms it exits without doing anything.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const zcsdk = require('../lib/zcsdk');

const ROOT = path.resolve(__dirname, '..');
const TOOLS = path.join(ROOT, 'tools');
const LICENSES = path.join(TOOLS, 'licenses');
const SEVEN_ZIP_MSI = 'https://www.7-zip.org/a/7z2501-x64.msi';
const RETOC_ZIP = 'https://github.com/trumank/retoc/releases/download/v0.1.5/retoc_cli-x86_64-pc-windows-msvc.zip';
const ZCSDK_LATEST = 'https://raw.githubusercontent.com/EnvianMods/ZCSDK-Runtime-Release/main/latest.json';

const log = (m) => console.log('  ' + m);

async function download(url, dest) {
  const res = await fetch(url, { redirect: 'follow', headers: { 'User-Agent': 'zero-company-mod-command-build' } });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  fs.writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
}

// Windows ships bsdtar as System32\tar.exe; it reads zips. Named explicitly
// because a GNU tar earlier on PATH cannot.
const TAR = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');

async function sevenZip() {
  const dir = path.join(TOOLS, '7-Zip');
  if (fs.existsSync(path.join(dir, '7z.exe'))) return log('7-Zip: already present');
  log('7-Zip 25.01: downloading the official MSI…');
  const msi = path.join(os.tmpdir(), 'zc-7z2501-x64.msi');
  const extract = path.join(os.tmpdir(), 'zc-7z-extract');
  await download(SEVEN_ZIP_MSI, msi);
  fs.rmSync(extract, { recursive: true, force: true });
  // Administrative install = unpack the MSI into a folder; installs nothing.
  const r = spawnSync('msiexec.exe', ['/a', msi, '/qn', `TARGETDIR=${extract}`], { stdio: 'ignore' });
  const src = path.join(extract, 'Files', '7-Zip');
  if (r.status !== 0 || !fs.existsSync(path.join(src, '7z.exe'))) throw new Error('MSI unpack failed');
  fs.mkdirSync(dir, { recursive: true });
  for (const f of ['7z.exe', '7z.dll', 'License.txt']) fs.copyFileSync(path.join(src, f), path.join(dir, f));
  fs.writeFileSync(path.join(dir, 'BUNDLED.txt'), `7-Zip 25.01 (x64) command-line build, unmodified, unpacked from ${SEVEN_ZIP_MSI} by build/fetch-tools.js.\r\nLicense: GNU LGPL + unRAR restriction + BSD 3-clause (see License.txt).\r\n`);
  fs.rmSync(extract, { recursive: true, force: true });
  fs.rmSync(msi, { force: true });
  log('7-Zip: ok');
}

// The release zip holds LICENSE, README.md and retoc.exe; only retoc.exe and
// LICENSE are taken (the zip is fetched again if either is missing).
async function retoc() {
  const exe = path.join(TOOLS, 'retoc.exe');
  const lic = path.join(LICENSES, 'retoc-LICENSE.txt');
  if (fs.existsSync(exe) && fs.existsSync(lic)) return log('retoc: already present');
  log('retoc 0.1.5: downloading the GitHub release…');
  const zip = path.join(os.tmpdir(), 'zc-retoc.zip');
  const extract = path.join(os.tmpdir(), 'zc-retoc-extract');
  await download(RETOC_ZIP, zip);
  fs.rmSync(extract, { recursive: true, force: true });
  fs.mkdirSync(extract, { recursive: true });
  const r = spawnSync(TAR, ['-xf', zip, '-C', extract, 'retoc.exe', 'LICENSE'], { stdio: 'ignore' });
  fs.rmSync(zip, { force: true });
  try {
    if (r.status !== 0 || !fs.existsSync(path.join(extract, 'retoc.exe'))) throw new Error('extract failed');
    if (!fs.existsSync(exe)) fs.copyFileSync(path.join(extract, 'retoc.exe'), exe);
    fs.mkdirSync(LICENSES, { recursive: true });
    fs.copyFileSync(path.join(extract, 'LICENSE'), lic);
  } finally {
    fs.rmSync(extract, { recursive: true, force: true });
  }
  log('retoc: ok');
}

// Re-downloaded whenever latest.json names a different version than the one
// recorded in zcsdk-runtime.json; an unreachable latest.json keeps the copy
// already in tools/. latest.json goes through the app's own checks
// (lib/zcsdk.js parseLatest: pinned URL, asset name, sha256 + size required
// from Runtime 0.15.1 on). The download is verified against that sha256/size
// before it replaces tools/ZCSDKRuntime.zip, and the SHA-256 and size of the
// final file are written into zcsdk-runtime.json as the bundled copy's pin.
async function zcsdkRuntime(tools = TOOLS) {
  const zip = path.join(tools, 'ZCSDKRuntime.zip');
  const info = path.join(tools, 'zcsdk-runtime.json');
  let have = null;
  let havePin = false;
  if (fs.existsSync(zip)) {
    try {
      const cur = JSON.parse(fs.readFileSync(info, 'utf8'));
      have = cur.version || null;
      havePin = /^[0-9a-f]{64}$/.test(cur.sha256 || '') && Number.isSafeInteger(cur.size);
    } catch (_) {}
  }
  log('ZCSDK Runtime: reading latest.json…');
  let j;
  try {
    const res = await fetch(ZCSDK_LATEST, { headers: { 'User-Agent': 'zero-company-mod-command-build' } });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    j = zcsdk.parseLatest(await res.json(), { seen: false });
    if (!j) throw new Error('unexpected latest.json');
  } catch (e) {
    if (fs.existsSync(zip)) return log(`ZCSDK Runtime: kept the copy in tools/ (${have || 'unknown version'}); latest.json unreadable: ${e.message}`);
    throw e;
  }
  const writeInfo = async () => {
    const st = fs.statSync(zip);
    const sha256 = await sha256File(zip);
    fs.writeFileSync(info, JSON.stringify({
      version: j.version, bridge: j.bridge || null, loader: j.loader || null, file: 'ZCSDKRuntime.zip',
      sha256, size: st.size,
      source: `EnvianMods/ZCSDK-Runtime-Release v${j.version} asset ${j.asset} (offline fallback, fetched by build/fetch-tools.js; the app installs the newest release from that repo when online)`,
    }, null, 2) + '\n');
  };
  if (have && have === String(j.version)) {
    if (havePin) return log(`ZCSDK Runtime: already present (${have})`);
    if (!j.sha256) return log(`ZCSDK Runtime: already present (${have}, no pin: latest.json publishes no sha256 for it)`);
    try {
      await zcsdk.verifyRuntimeZip(zip, j);
      await writeInfo();
      return log(`ZCSDK Runtime: already present (${have}); pinned to the published sha256`);
    } catch (e) {
      log(`ZCSDK Runtime: the copy in tools/ does not match the published sha256 (${e.message}); downloading it again`);
    }
  }
  log(`ZCSDK Runtime: downloading ${j.version}${have ? ` (replacing ${have})` : ''}…`);
  const part = zip + '.part';
  try {
    await download(j.url, part);
    // Checked before the rename: a bad download never replaces the good copy.
    if (j.sha256) await zcsdk.verifyRuntimeZip(part, j);
    fs.renameSync(part, zip);
  } finally {
    fs.rmSync(part, { force: true });
  }
  await writeInfo();
  log(`ZCSDK Runtime: ok (${j.version}${j.sha256 ? ', sha256 verified' : ', no published sha256; pinned to the downloaded file'})`);
}

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(file).on('error', reject).on('data', (c) => h.update(c)).on('end', () => resolve(h.digest('hex')));
  });
}

// Keeps tools/licenses/ complete: 7-Zip's own License.txt is copied (it also
// stays beside 7z.exe), and the ZCSDK Runtime gets a source note, since its
// release publishes no separate license file. retoc's LICENSE comes from its
// zip in retoc() above.
function licenses() {
  fs.mkdirSync(LICENSES, { recursive: true });
  const sevenLic = path.join(TOOLS, '7-Zip', 'License.txt');
  if (fs.existsSync(sevenLic)) fs.copyFileSync(sevenLic, path.join(LICENSES, '7-Zip-License.txt'));
  else log('licenses: tools/7-Zip/License.txt missing');
  if (fs.existsSync(path.join(TOOLS, 'ZCSDKRuntime.zip'))) {
    fs.writeFileSync(path.join(LICENSES, 'ZCSDK-Runtime.txt'), [
      'ZCSDK Runtime (ZCSDKBridge + ZCSDKLoader), offline copy in ZCSDKRuntime.zip',
      '(version recorded in zcsdk-runtime.json).',
      'Source: https://github.com/EnvianMods/ZCSDK-Runtime-Release',
      'By EnvianMods, the author of Zero Company Mod Command. The release does not',
      'publish a separate license file.',
      '',
    ].join('\r\n'));
  }
  const missing = ['retoc-LICENSE.txt', '7-Zip-License.txt'].filter((f) => !fs.existsSync(path.join(LICENSES, f)));
  log(missing.length ? `licenses: missing ${missing.join(', ')}` : 'licenses: ok');
}

async function main() {
  if (process.platform !== 'win32') { console.log('fetch-tools: Windows only, nothing to do.'); return; }
  fs.mkdirSync(TOOLS, { recursive: true });
  console.log('Fetching the bundled tools that are not shipped in the source package…');
  for (const [name, step] of [['7-Zip', sevenZip], ['retoc', retoc], ['ZCSDK Runtime', zcsdkRuntime], ['licenses', licenses]]) {
    try { await step(); } catch (e) { log(`${name}: skipped (${e.message}) — the app still works without it`); }
  }
}

if (require.main === module) main();

module.exports = { zcsdkRuntime };

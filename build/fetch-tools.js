'use strict';
// Fetches the tools that the build-from-source package leaves out (Nexus's file
// scan holds packages that carry binaries or nested archives). Run by
// `npm run build-exe` before electron-builder; every step is optional — the
// app works without any of them, with the matching feature reporting itself
// as unavailable in Diagnostics.
//   tools/7-Zip/7z.exe + 7z.dll  — .7z/.rar mod archives (7-Zip 25.01, LGPL)
//   tools/retoc.exe              — lists files inside pak/iostore mods (retoc 0.1.5)
//   tools/ZCSDKRuntime.zip       — offline copy of the newest ZCSDK Runtime
//   tools/oo2core_9_win64.dll    — copied from the game folder when present
// Windows only; on other platforms it exits without doing anything.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const TOOLS = path.join(ROOT, 'tools');
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

async function retoc() {
  const exe = path.join(TOOLS, 'retoc.exe');
  if (fs.existsSync(exe)) return log('retoc: already present');
  log('retoc 0.1.5: downloading the GitHub release…');
  const zip = path.join(os.tmpdir(), 'zc-retoc.zip');
  await download(RETOC_ZIP, zip);
  const r = spawnSync(TAR, ['-xf', zip, '-C', TOOLS, 'retoc.exe'], { stdio: 'ignore' });
  fs.rmSync(zip, { force: true });
  if (r.status !== 0 || !fs.existsSync(exe)) throw new Error('extract failed');
  log('retoc: ok');
}

async function zcsdkRuntime() {
  const zip = path.join(TOOLS, 'ZCSDKRuntime.zip');
  if (fs.existsSync(zip)) return log('ZCSDK Runtime: already present');
  log('ZCSDK Runtime: reading latest.json…');
  const j = await fetch(ZCSDK_LATEST, { headers: { 'User-Agent': 'zero-company-mod-command-build' } }).then((r) => r.json());
  if (!j || !j.version || !/^https:\/\/github\.com\/EnvianMods\/ZCSDK-Runtime-Release\/releases\/download\/.+\.zip$/i.test(j.url || '')) throw new Error('unexpected latest.json');
  await download(j.url, zip);
  fs.writeFileSync(path.join(TOOLS, 'zcsdk-runtime.json'), JSON.stringify({
    version: j.version, bridge: j.bridge || null, loader: j.loader || null, file: 'ZCSDKRuntime.zip',
    source: `EnvianMods/ZCSDK-Runtime-Release ${j.version} (fetched by build/fetch-tools.js)`,
  }, null, 2) + '\n');
  log(`ZCSDK Runtime: ok (${j.version})`);
}

function oodle() {
  const dest = path.join(TOOLS, 'oo2core_9_win64.dll');
  if (fs.existsSync(dest)) return;
  const rel = path.join('SWZeroCompany', 'Binaries', 'Win64', 'oo2core_9_win64.dll');
  const roots = [
    process.env['ProgramFiles(x86)'] ? path.join(process.env['ProgramFiles(x86)'], 'Steam', 'steamapps', 'common', 'Star Wars Zero Company') : null,
    ...'CDEFGH'.split('').flatMap((d) => [`${d}:\\SteamLibrary\\steamapps\\common\\Star Wars Zero Company`, `${d}:\\Games\\steamapps\\common\\Star Wars Zero Company`]),
  ].filter(Boolean);
  for (const root of roots) {
    const p = path.join(root, rel);
    if (fs.existsSync(p)) { fs.copyFileSync(p, dest); return log('Oodle dll: copied from the game folder'); }
  }
}

(async () => {
  if (process.platform !== 'win32') { console.log('fetch-tools: Windows only, nothing to do.'); return; }
  fs.mkdirSync(TOOLS, { recursive: true });
  console.log('Fetching the bundled tools that are not shipped in the source package…');
  for (const [name, step] of [['7-Zip', sevenZip], ['retoc', retoc], ['ZCSDK Runtime', zcsdkRuntime], ['Oodle', oodle]]) {
    try { await step(); } catch (e) { log(`${name}: skipped (${e.message}) — the app still works without it`); }
  }
})();

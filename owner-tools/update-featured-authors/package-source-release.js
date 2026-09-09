'use strict';
// OWNER TOOL — builds the NEXUS release package: the app's source plus Build.bat,
// with every binary left out (Nexus's automated scan quarantines exe/dll files
// and nested archives for days; unsigned Electron exes never clear it quickly).
// Users run Build.bat, which installs the build dependencies with npm, fetches
// the excluded tools (7-Zip, retoc, ZCSDK Runtime) from their official sources
// and produces the same portable exe we ship on GitHub.
//
// Usage: node package-source-release.js [--version 1.0.3] [--out <zipPath>]
//   version defaults to RELEASE_VERSION.txt (the PUBLIC number).
//   Output: release/ZeroCompanyModCommand-Source-v<version>.zip
// Needs: PowerShell (robocopy for the snapshot) and tools/7-Zip/7z.exe to zip.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const REPO = path.resolve(__dirname, '..', '..');
const arg = (flag, dflt) => { const i = process.argv.indexOf(flag); return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : dflt; };
const version = arg('--version', fs.readFileSync(path.join(REPO, 'RELEASE_VERSION.txt'), 'utf8').trim());
const internal = require(path.join(REPO, 'package.json')).version;
const out = path.resolve(arg('--out', path.join(REPO, 'release', `ZeroCompanyModCommand-Source-v${version}.zip`)));
const sevenZip = path.join(REPO, 'tools', '7-Zip', '7z.exe');
if (!fs.existsSync(sevenZip)) { console.error('tools/7-Zip/7z.exe is missing.'); process.exit(1); }

const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'zc-source-'));
const root = path.join(stage, `ZeroCompanyModCommand-Source-v${version}`);
fs.mkdirSync(root);

// Folders and files that never ship: dev state, secrets, build output, and
// every binary (fetched by Build.bat instead).
const XD = ['node_modules', 'release', 'data', '.git', 'zcbak', 'owner-tools', 'docs', '7-Zip'];
const XF = ['*token*.txt', 'nexus-key.txt', '*.exe', '*.dll', 'ZCSDKRuntime.zip', 'zcsdk-runtime.json', 'BUNDLED.txt', 'HANDOFF.md', 'DESCRIPTION.txt', 'NEXUS_DESCRIPTION.bbcode', '*.log', 'Thumbs.db', '.DS_Store'];
const rc = spawnSync('robocopy', [REPO, root, '/E', '/XD', ...XD, '/XF', ...XF, '/NFL', '/NDL', '/NJH', '/NJS'], { stdio: 'inherit' });
if (rc.status >= 8) { console.error('robocopy failed'); process.exit(1); }

fs.writeFileSync(path.join(root, 'README-BUILD.txt'), [
  `ZERO COMPANY MOD COMMAND v${version} - BUILD FROM SOURCE`,
  'A dedicated mod manager & launcher for STAR WARS: Zero Company, by Envian Mods',
  '',
  'This package is the full source of the launcher plus a one-click build script.',
  'It contains no executables, so it clears Nexus\'s file scan; you build the exe',
  'yourself in a couple of minutes and get exactly the build we publish on GitHub',
  `(release v${internal}: https://github.com/EnvianMods/ZeroCompanyModCommand/releases).`,
  '',
  'HOW TO BUILD',
  '1. Install Node.js LTS from https://nodejs.org/ (accept the defaults). Once only.',
  '2. Unzip this package anywhere - for example Documents\\ZeroCompanyModCommand.',
  '3. Double-click Build.bat. It installs the build dependencies (about 150 MB, once),',
  '   fetches the bundled tools from their official sources (7-Zip, retoc, the',
  '   ZCSDK Runtime) and builds ZeroCompanyModCommand.exe into this folder.',
  '4. Run ZeroCompanyModCommand.exe. Your mods and settings live in',
  '   %APPDATA%\\ZeroCompanyModCommand, so rebuilding or updating never touches them.',
  '',
  'UPDATING LATER',
  'Unzip the new package over the old folder (or into a fresh one) and run Build.bat',
  'again. The launcher also shows an update banner when a new version is out.',
  '',
  'PREFER A READY-MADE EXE?',
  'The identical portable exe and a Linux AppImage are on the GitHub release page above.',
  '',
  'WHAT BUILD.BAT DOWNLOADS',
  '- Electron + electron-builder via npm (the app framework and packager)',
  '- 7-Zip 25.01 (https://www.7-zip.org/, LGPL) for .7z/.rar mod archives',
  '- retoc 0.1.5 (https://github.com/trumank/retoc) to list files inside pak mods',
  '- the newest ZCSDK Runtime (https://github.com/EnvianMods/ZCSDK-Runtime-Release)',
  'Everything else is in this folder. See README.md for the full feature list and',
  'CHANGELOG.md for what changed.',
  '',
].join('\r\n'));

fs.mkdirSync(path.dirname(out), { recursive: true });
fs.rmSync(out, { force: true });
execFileSync(sevenZip, ['a', '-tzip', '-mx=5', '-r', out, path.join(stage, '*')], { stdio: 'ignore' });

// Prove the package is binary-free before it goes anywhere near Nexus.
const listing = execFileSync(sevenZip, ['l', '-ba', out], { encoding: 'utf8' });
const bad = listing.split(/\r?\n/).filter((l) => /\.(exe|dll|zip|7z|rar|msi|sys|scr|com)\s*$/i.test(l.trim()));
if (bad.length) { console.error('Binaries or nested archives found in the package:\n' + bad.join('\n')); process.exit(1); }
const files = listing.split(/\r?\n/).filter((l) => l.trim() && !/\sD[.A-Z]{4}\s/.test(l)).length;
fs.rmSync(stage, { recursive: true, force: true });
console.log(`${path.basename(out)} — public ${version} / internal ${internal}, ${files} files, ${(fs.statSync(out).size / 1048576).toFixed(1)} MB, no binaries.`);
console.log('Upload with: node upload-nexus-file.js ' + version + ' "' + out + '" --name "Zero Company Mod Command (build from source)" --no-primary --update --archive-old --description "..."');

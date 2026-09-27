'use strict';
// Builds release/ZeroCompanyModCommand-Uninstall.exe from build/uninstaller/Uninstall.cs
// with the C# compiler that ships with Windows itself (.NET Framework 4.8's
// csc.exe, C# 5) — no SDK, no download, no NuGet. Run by `npm run build-exe`
// and `npm run build` after fetch-tools; on its own: `npm run build-uninstaller`.
// Windows only; elsewhere it says so and exits 0 (the Linux build has no
// uninstaller).

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(__dirname, 'uninstaller', 'Uninstall.cs');
const MANIFEST = path.join(__dirname, 'uninstaller', 'app.manifest');
const ICON = path.join(__dirname, 'icon.ico');
const OUT_DIR = path.join(ROOT, 'release');
const OUT = path.join(OUT_DIR, 'ZeroCompanyModCommand-Uninstall.exe');
const REFS = ['System.dll', 'System.Core.dll', 'System.Drawing.dll', 'System.Windows.Forms.dll', 'System.Web.Extensions.dll'];

const log = (m) => console.log('  ' + m);

function findCsc() {
  const win = process.env.SystemRoot || process.env.windir || 'C:\\Windows';
  for (const fw of ['Framework64', 'Framework']) {
    const csc = path.join(win, 'Microsoft.NET', fw, 'v4.0.30319', 'csc.exe');
    if (fs.existsSync(csc)) return csc;
  }
  return null;
}

function compile(csc, withIcon) {
  const args = [
    '/nologo', '/noconfig', '/target:winexe', '/optimize+', '/platform:anycpu',
    `/out:${OUT}`, `/win32manifest:${MANIFEST}`,
    ...REFS.map((r) => `/reference:${r}`),
  ];
  if (withIcon) args.push(`/win32icon:${ICON}`);
  args.push(SRC);
  return spawnSync(csc, args, { encoding: 'utf8', windowsHide: true });
}

function main() {
  console.log('Uninstaller (ZeroCompanyModCommand-Uninstall.exe)');
  if (process.platform !== 'win32') {
    log('skipped: the uninstaller is a Windows program (the Linux build has none).');
    return 0;
  }
  const csc = findCsc();
  if (!csc) {
    log('skipped: .NET Framework 4.x csc.exe was not found under %WINDIR%\\Microsoft.NET.');
    return 0;
  }
  fs.mkdirSync(OUT_DIR, { recursive: true });
  let r = compile(csc, fs.existsSync(ICON));
  const output = `${r.stdout || ''}${r.stderr || ''}`.trim();
  if (r.status !== 0 && /CS7065|CS1616|win32icon|icon/i.test(output)) {
    log('csc rejected build/icon.ico; building without an icon.');
    log(output.split(/\r?\n/).slice(0, 3).join('\n  '));
    r = compile(csc, false);
  }
  if (r.status !== 0) {
    console.error(`${r.stdout || ''}${r.stderr || ''}`.trim());
    console.error('  FAILED: csc exited with ' + r.status);
    return 1;
  }
  const warnings = `${r.stdout || ''}${r.stderr || ''}`.trim();
  if (warnings) log(warnings.split(/\r?\n/).join('\n  '));
  const size = fs.statSync(OUT).size;
  log(`built ${path.relative(ROOT, OUT)} (${(size / 1024).toFixed(1)} KB) with ${csc}`);
  return 0;
}

process.exitCode = main();

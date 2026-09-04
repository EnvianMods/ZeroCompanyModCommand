'use strict';
// Archive extraction: .zip natively (extract-zip), .7z/.rar via a 7-Zip CLI if present.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const extractZip = require('extract-zip');

function findSevenZip(configured) {
  const candidates = [
    configured,
    'C:\\Program Files\\7-Zip\\7z.exe',
    'C:\\Program Files (x86)\\7-Zip\\7z.exe',
    // Linux (p7zip / 7-Zip official): whichever variant the distro ships.
    '/usr/bin/7z', '/usr/bin/7za', '/usr/bin/7zz', '/usr/local/bin/7zz',
  ].filter(Boolean);
  for (const c of candidates) {
    try { if (fs.existsSync(c)) return c; } catch (_) {}
  }
  // PATH lookup
  for (const name of ['7z', '7za', '7zz']) {
    try {
      execFileSync(name, ['--help'], { stdio: 'ignore' });
      return name;
    } catch (_) {}
  }
  return null;
}

// Post-extraction safety pass: symlinks/junctions are removed (a link inside an
// archive can point anywhere on disk), and every entry must resolve inside the
// destination — an archive that slips a file outside it is rejected outright.
function validateExtraction(destDir) {
  const rootReal = fs.realpathSync(destDir);
  const stack = [destDir];
  while (stack.length) {
    const dir = stack.pop();
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        fs.rmSync(abs, { recursive: true, force: true });
        continue;
      }
      const real = fs.realpathSync(abs);
      if (real !== rootReal && !real.startsWith(rootReal + path.sep)) {
        throw new Error(`The archive tried to place "${entry.name}" outside the extraction folder — install refused.`);
      }
      if (entry.isDirectory()) stack.push(abs);
    }
  }
}

async function extractArchive(archivePath, destDir, sevenZipPath) {
  const ext = path.extname(archivePath).toLowerCase();
  fs.mkdirSync(destDir, { recursive: true });
  if (ext === '.zip') {
    // Windows' built-in bsdtar handles zips extract-zip chokes on (it can hang
    // forever on some archives). Fall back to extract-zip if tar is missing.
    try {
      execFileSync('tar', ['-xf', archivePath, '-C', destDir], { stdio: 'ignore', timeout: 120000 });
      validateExtraction(destDir);
      return;
    } catch (err) {
      if (/outside the extraction folder/.test(err.message)) throw err;
      /* tar unavailable or failed — try the JS extractor */
    }
    await extractZip(archivePath, { dir: destDir });
    validateExtraction(destDir);
    return;
  }
  if (ext === '.7z' || ext === '.rar') {
    const sz = findSevenZip(sevenZipPath);
    if (!sz) {
      throw new Error(
        `${ext} archives need 7-Zip. Install 7-Zip or set its path in Settings, or extract the archive yourself and install the folder.`
      );
    }
    execFileSync(sz, ['x', '-y', `-o${destDir}`, archivePath], { stdio: 'ignore' });
    validateExtraction(destDir);
    return;
  }
  throw new Error(`Unsupported archive type "${ext}" (file: ${path.basename(archivePath)}). Use .zip, .7z, .rar, or install a folder.`);
}

module.exports = { extractArchive, findSevenZip, validateExtraction };

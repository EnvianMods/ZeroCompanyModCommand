'use strict';
// Mod-archive location handling. The archive (library/backups/versions plus a
// mirrored manifest) lives in the GAME folder by default so mods survive app
// updates and deletions; settings.storageDir overrides with a custom path.

const fs = require('fs');
const path = require('path');

const ARCHIVE_DIR_NAME = 'ModCommandArchive';
// Pre-1.9.0 default name; found in place, it is renamed to the new name on startup.
const LEGACY_ARCHIVE_DIR_NAME = 'ZeroCompanyModArchive';

function resolveStorageRoot(settings, dataDir) {
  if (settings.storageDir) return settings.storageDir;
  if (settings.gamePath) return path.join(settings.gamePath, ARCHIVE_DIR_NAME);
  return dataDir;
}

function countFilesRec(dir) {
  let n = 0;
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) n += countFilesRec(path.join(dir, entry.name));
      else n += 1;
    }
  } catch (_) {}
  return n;
}

// Copy-verify-delete each archive entry from one root to another. Merges; an
// entry that already exists at the destination is never clobbered (the source
// copy stays put in that case).
function migrateStorage(fromRoot, toRoot) {
  let moved = 0;
  if (path.resolve(fromRoot) === path.resolve(toRoot)) return { moved };
  for (const sub of ['library', 'backups', 'versions']) {
    const src = path.join(fromRoot, sub);
    if (!fs.existsSync(src)) continue;
    const dst = path.join(toRoot, sub);
    fs.mkdirSync(dst, { recursive: true });
    for (const entry of fs.readdirSync(src)) {
      const s = path.join(src, entry);
      const d = path.join(dst, entry);
      if (fs.existsSync(d)) continue;
      fs.cpSync(s, d, { recursive: true });
      if (countFilesRec(s) === countFilesRec(d)) {
        fs.rmSync(s, { recursive: true, force: true });
        moved += 1;
      }
    }
    try { if (!fs.readdirSync(src).length) fs.rmSync(src, { recursive: true, force: true }); } catch (_) {}
  }
  return { moved };
}

// One-time, non-destructive move of a pre-1.9.0 app-data folder (next to the
// portable exe, or under Electron's userData) into the per-user app-data
// location: copy everything but the scratch staging dir, verify the file
// count, then rename the old folder aside as a dated backup. Returns true
// when a migration happened; false when there was nothing to do, the target
// is already populated, or the copy could not be verified (old folder kept).
function migrateLegacyDataDir(legacyDir, newDir) {
  try {
    if (!legacyDir || !fs.existsSync(path.join(legacyDir, 'manager-data.json'))) return false;
    if (fs.existsSync(path.join(newDir, 'manager-data.json'))) return false;
    fs.mkdirSync(newDir, { recursive: true });
    fs.cpSync(legacyDir, newDir, { recursive: true, filter: (src) => path.basename(src) !== 'staging' });
    const expected = countFilesRec(legacyDir) - countFilesRec(path.join(legacyDir, 'staging'));
    if (countFilesRec(newDir) < expected) return false;
    fs.renameSync(legacyDir, `${legacyDir}.migrated-${new Date().toISOString().slice(0, 10)}`);
    return true;
  } catch (_) { return false; }
}

module.exports = { ARCHIVE_DIR_NAME, LEGACY_ARCHIVE_DIR_NAME, resolveStorageRoot, migrateStorage, migrateLegacyDataDir, countFilesRec };

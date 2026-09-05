'use strict';
// Portable JSON data store. Lives in <appRoot>/data/manager-data.json so the
// whole manager (settings + mod library) can be moved as one folder.

const fs = require('fs');
const path = require('path');

const DEFAULTS = {
  settings: {
    gamePath: null,
    retocPath: null,
    sevenZipPath: null,
    reducedMotion: false,
    closeOnLaunch: false,
    nexusApiKey: null,
    customConfigFiles: [],
    // First-run setup assistant: shown once until finished/skipped (or until
    // both the API key and the nxm handler are already in place).
    onboarded: false,
    // Custom mod-archive location; null = auto (<game>\ZeroCompanyModArchive).
    storageDir: null,
    // One-time automatic existing-mods scan after the first game connection.
    firstScanDone: false,
  },
  // mods: [{ id, name, version, modType, enabled, installedAt, installedBuild,
  //          loadPriority, sourceArchive, files: [{ libraryRelative, destination, size }] }]
  mods: [],
  // profiles: [{ id, name, savedAt, entries: [{ modId, enabled }], order: [modId] }]
  profiles: [],
  // Snapshot of the pak load order taken just before the last Apply, for rollback.
  lastOrderBackup: null, // { at, order: [modId] }
};

class Store {
  constructor(dataDir) {
    dataDir = path.resolve(dataDir);
    this.dataDir = dataDir;
    this.file = path.join(dataDir, 'manager-data.json');
    this.stagingDir = path.join(dataDir, 'staging');
    fs.mkdirSync(this.stagingDir, { recursive: true });
    this.data = this._load();
    // Mod storage (library/backups/versions) starts beside the settings and is
    // re-pointed by setStorageRoot() once the game folder is known — the
    // default archive home is <game>\ZeroCompanyModArchive so the mods survive
    // app updates and deletions.
    this.setStorageRoot(dataDir);
  }

  // Point the mod archive at a folder (creates the subdirs). The settings file
  // itself stays in dataDir so the app can find its configuration first.
  setStorageRoot(root) {
    this.storageRoot = path.resolve(root);
    this.libraryDir = path.join(this.storageRoot, 'library');
    this.backupsDir = path.join(this.storageRoot, 'backups');
    this.versionsDir = path.join(this.storageRoot, 'versions');
    for (const d of [this.storageRoot, this.libraryDir, this.backupsDir, this.versionsDir]) {
      fs.mkdirSync(d, { recursive: true });
    }
  }

  _load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      return {
        settings: { ...DEFAULTS.settings, ...(raw.settings || {}) },
        mods: Array.isArray(raw.mods) ? raw.mods : [],
        profiles: Array.isArray(raw.profiles) ? raw.profiles : [],
        lastOrderBackup: raw.lastOrderBackup || null,
      };
    } catch (_) {
      return JSON.parse(JSON.stringify(DEFAULTS));
    }
  }

  save() {
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    fs.renameSync(tmp, this.file);
    // Mirror the manifest into the archive itself, so a fresh install pointed
    // at (or finding) the archive can restore everything — names, origins,
    // enabled states, priorities, profiles.
    if (this.storageRoot && this.storageRoot !== this.dataDir) {
      try {
        // Guard: an EMPTY store must never clobber a mirror that can still be
        // restored (a fresh install saves settings before the auto-restore
        // runs). "Restorable" = the mirror lists a mod whose library folder is
        // still present; a legitimately emptied library updates the mirror.
        if (!this.data.mods.length) {
          const mirrorFile = path.join(this.storageRoot, 'manager-data.json');
          if (fs.existsSync(mirrorFile)) {
            const mirror = JSON.parse(fs.readFileSync(mirrorFile, 'utf8'));
            const restorable = (mirror.mods || []).some((m) =>
              fs.existsSync(path.join(this.libraryDir, m.id)));
            if (restorable) return;
          }
        }
        fs.writeFileSync(path.join(this.storageRoot, 'manager-data.json'), JSON.stringify(this.data, null, 2));
      } catch (_) { /* archive drive briefly unavailable — next save retries */ }
    }
  }

  get settings() { return this.data.settings; }
  get mods() { return this.data.mods; }
  get profiles() { return this.data.profiles; }

  getMod(id) { return this.data.mods.find((m) => m.id === id) || null; }

  addMod(mod) { this.data.mods.push(mod); this.save(); }

  removeMod(id) {
    this.data.mods = this.data.mods.filter((m) => m.id !== id);
    this.save();
  }

  modLibraryDir(id) { return path.join(this.libraryDir, id); }

  // Originals of game files a game-folder mod replaced, kept for restore.
  modBackupsDir(id) { return path.join(this.backupsDir, 'gamefiles', id); }

  // Archived versions of a mod (the version vault), keyed by mod identity.
  modVaultDir(key) { return path.join(this.versionsDir, key); }

  nextLoadPriority(types) {
    const prios = this.data.mods
      .filter((m) => types.includes(m.modType))
      .map((m) => m.loadPriority || 0);
    return (prios.length ? Math.max(...prios) : 0) + 1;
  }
}

module.exports = { Store };

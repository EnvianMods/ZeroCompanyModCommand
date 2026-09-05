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
    this.libraryDir = path.join(dataDir, 'library');
    this.stagingDir = path.join(dataDir, 'staging');
    this.backupsDir = path.join(dataDir, 'backups');
    this.versionsDir = path.join(dataDir, 'versions');
    for (const d of [dataDir, this.libraryDir, this.stagingDir, this.backupsDir, this.versionsDir]) {
      fs.mkdirSync(d, { recursive: true });
    }
    this.data = this._load();
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

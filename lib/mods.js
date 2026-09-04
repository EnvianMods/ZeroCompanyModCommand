'use strict';
// Mod engine: classification, install, deploy, load order, conflicts, UE4SS.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { extractArchive } = require('./archive');

const PAKS_REL = path.join('SWZeroCompany', 'Content', 'Paks');
const MODS_REL = path.join(PAKS_REL, '~mods');
const LOGIC_MODS_REL = path.join(PAKS_REL, 'LogicMods');
const WIN64_REL = path.join('SWZeroCompany', 'Binaries', 'Win64');
const UE4SS_MODS_REL = path.join(WIN64_REL, 'ue4ss', 'Mods');

const PAK_EXTS = new Set(['.pak', '.utoc', '.ucas']);

// Markers of the manager-owned block inside UE4SS's mods.txt.
const UE4SS_BLOCK_BEGIN = '; === Zero Company Mod Command start order (managed block) ===';
const UE4SS_BLOCK_END = '; === end managed start order ===';

function newId() { return crypto.randomBytes(8).toString('hex'); }

function sha256File(absPath) {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(absPath));
  return hash.digest('hex');
}

function safeName(name) {
  return String(name).replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60) || 'Mod';
}

function walkFiles(root) {
  const out = [];
  const stack = [''];
  while (stack.length) {
    const rel = stack.pop();
    const abs = path.join(root, rel);
    for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
      const childRel = rel ? path.join(rel, entry.name) : entry.name;
      if (entry.isDirectory()) stack.push(childRel);
      else out.push(childRel);
    }
  }
  return out;
}

// ---------------------------------------------------------------- inspection

// Classify an extracted/staged folder. Returns { modType, name, payload, warnings }
// payload: [{ sourceRelative, kind }]
function classifyFolder(root, fallbackName) {
  const files = walkFiles(root);
  const warnings = [];
  const lower = files.map((f) => f.toLowerCase());

  // UE4SS runtime: dwmapi.dll next to a ue4ss folder
  const dwmapiIdx = lower.findIndex((f) => path.basename(f) === 'dwmapi.dll');
  if (dwmapiIdx !== -1) {
    const dwmDir = path.dirname(files[dwmapiIdx]);
    const hasUe4ssDir = files.some((f) => {
      const rel = path.relative(dwmDir === '.' ? '' : dwmDir, f);
      return !rel.startsWith('..') && rel.toLowerCase().startsWith('ue4ss' + path.sep);
    });
    if (hasUe4ssDir) {
      const baseDir = dwmDir === '.' ? '' : dwmDir;
      const payload = files
        .filter((f) => (baseDir ? f.startsWith(baseDir + path.sep) : true))
        .map((f) => ({ sourceRelative: f, deployRelative: baseDir ? path.relative(baseDir, f) : f }));
      return { modType: 'ue4ss-runtime', name: 'UE4SS Runtime', payload, warnings };
    }
  }

  // LogicMods paks
  const logicPaks = files.filter((f) => {
    const parts = f.toLowerCase().split(path.sep);
    return parts.includes('logicmods') && PAK_EXTS.has(path.extname(f).toLowerCase());
  });
  if (logicPaks.length) {
    return {
      modType: 'logicmods',
      name: fallbackName,
      payload: logicPaks.map((f) => ({ sourceRelative: f, deployRelative: path.basename(f) })),
      warnings,
    };
  }

  // Pak / IoStore
  const pakFiles = files.filter((f) => PAK_EXTS.has(path.extname(f).toLowerCase()));
  if (pakFiles.length) {
    const hasIoStore = pakFiles.some((f) => ['.utoc', '.ucas'].includes(path.extname(f).toLowerCase()));
    // Optional metadata: a modinfo.json alongside the paks (title/version/author/description).
    // Lets tool-built packages carry a clean display name + version instead of the archive filename.
    // (Mirrors the UE4SS-mod branch below.) Falls back to the archive name if absent/malformed.
    let name = fallbackName;
    const meta = {};
    const mfRel = files.find((f) => path.basename(f).toLowerCase() === 'modinfo.json');
    if (mfRel) {
      try {
        const mf = JSON.parse(fs.readFileSync(path.join(root, mfRel), 'utf8'));
        if (mf && typeof mf.title === 'string' && mf.title.trim()) name = mf.title.trim().slice(0, 120);
        if (mf && typeof mf.version === 'string' && mf.version.trim()) meta.version = mf.version.trim().slice(0, 40);
        if (mf && typeof mf.author === 'string' && mf.author.trim()) meta.author = mf.author.trim().slice(0, 120);
        if (mf && typeof mf.description === 'string' && mf.description.trim()) meta.description = mf.description.trim().slice(0, 500);
        // Launcher compatibility declared by the author (Steam vs EA App).
        if (mf && typeof mf.eaCompatible === 'boolean') meta.eaCompatible = mf.eaCompatible;
        if (mf && Array.isArray(mf.launchers)) meta.launchers = mf.launchers.map((l) => String(l).toLowerCase()).slice(0, 4);
      } catch { /* malformed manifest: keep the archive name */ }
    }
    // Group by basename to keep .pak/.utoc/.ucas triples together.
    const skipped = files.length - pakFiles.length - (mfRel ? 1 : 0);
    if (skipped > 0) warnings.push(`${skipped} non-pak file(s) in the archive were ignored.`);
    return {
      modType: hasIoStore ? 'iostore' : 'pak',
      name,
      meta,
      payload: pakFiles.map((f) => ({ sourceRelative: f, deployRelative: path.basename(f) })),
      warnings,
    };
  }

  // UE4SS script/dll mod: a folder containing Scripts/main.lua or dlls/main.dll
  const luaMain = files.find((f) => /(^|\\|\/)scripts[\\\/]main\.lua$/i.test(f));
  const dllMain = files.find((f) => /(^|\\|\/)dlls[\\\/]main\.dll$/i.test(f));
  const marker = luaMain || dllMain;
  if (marker) {
    // The mod folder is the parent of Scripts/ (or dlls/).
    const modDir = path.dirname(path.dirname(marker));
    const baseDir = modDir === '.' ? '' : modDir;
    const modName = baseDir ? path.basename(baseDir) : fallbackName;
    const payload = files
      .filter((f) => (baseDir ? f.startsWith(baseDir + path.sep) : true))
      .map((f) => ({ sourceRelative: f, deployRelative: baseDir ? path.relative(baseDir, f) : f }));
    // Optional friendly display title: a modinfo.json in the mod folder with
    // { "title": "..." }. Deploy still uses safeName(name) for the folder, so the
    // on-disk name stays filesystem-safe. Falls back to the sanitized folder name.
    let displayName = safeName(modName);
    const meta = {};
    try {
      const mfAbs = path.join(root, baseDir, 'modinfo.json');
      if (fs.existsSync(mfAbs)) {
        const mf = JSON.parse(fs.readFileSync(mfAbs, 'utf8'));
        if (mf && typeof mf.title === 'string' && mf.title.trim()) {
          displayName = mf.title.trim().slice(0, 120);
        }
        if (mf && typeof mf.version === 'string' && mf.version.trim()) meta.version = mf.version.trim().slice(0, 40);
        if (mf && typeof mf.author === 'string' && mf.author.trim()) meta.author = mf.author.trim().slice(0, 120);
        if (mf && typeof mf.description === 'string' && mf.description.trim()) meta.description = mf.description.trim().slice(0, 500);
        if (mf && typeof mf.eaCompatible === 'boolean') meta.eaCompatible = mf.eaCompatible;
        if (mf && Array.isArray(mf.launchers)) meta.launchers = mf.launchers.map((l) => String(l).toLowerCase()).slice(0, 4);
      }
    } catch { /* malformed manifest: keep the folder name */ }
    return { modType: 'ue4ss-mod', name: displayName, meta, payload, warnings };
  }

  // Game-folder replacement mod: files laid out against the game root
  // (SWZeroCompany/... or Engine/...), e.g. replacement movies. Deployed over
  // the game's own files — originals are backed up and restored on disable.
  const GAME_ROOTS = new Set(['swzerocompany', 'engine']);
  // The game-root folder may sit at the archive top or one wrapper folder down.
  const gameRootDepth = (f) => {
    const parts = f.split(path.sep);
    if (GAME_ROOTS.has(parts[0])) return 0;
    if (parts.length > 1 && GAME_ROOTS.has(parts[1])) return 1;
    return -1;
  };
  if (lower.some((f) => gameRootDepth(f) !== -1)) {
    const payload = [];
    for (let i = 0; i < files.length; i++) {
      const depth = gameRootDepth(lower[i]);
      if (depth === -1) continue;
      const deployRelative = depth === 0 ? files[i] : files[i].split(path.sep).slice(1).join(path.sep);
      payload.push({ sourceRelative: files[i], deployRelative });
    }
    const skipped = files.length - payload.length;
    if (skipped > 0) warnings.push(`${skipped} file(s) outside SWZeroCompany/Engine were ignored.`);
    return { modType: 'gamefolder', name: fallbackName, payload, warnings };
  }

  return { modType: null, name: fallbackName, payload: [], warnings: ['No recognizable mod files found (.pak/.utoc/.ucas, UE4SS runtime, a UE4SS Scripts mod, or game-folder replacement files).'] };
}

class ModEngine {
  constructor(store) {
    this.store = store;
    // Live FOMOD wizard sessions: sessionId -> { root, stagingDir, sourceArchive, info }
    this._fomodSessions = new Map();
  }

  gamePath() {
    return this.store.settings.gamePath;
  }

  gameAbs(rel) {
    return path.join(this.gamePath(), rel);
  }

  ensureGameDirs() {
    fs.mkdirSync(this.gameAbs(MODS_REL), { recursive: true });
    fs.mkdirSync(this.gameAbs(LOGIC_MODS_REL), { recursive: true });
  }

  // ------------------------------------------------------------- install

  // sourcePath = archive file or folder. Returns the installed mod record, or a
  // { pendingFomod } handle when the archive ships a FOMOD installer script —
  // the wizard's answers come back through completeFomod()/cancelFomod().
  async install(sourcePath, opts = {}) {
    if (!this.gamePath()) throw new Error('Set the game folder first (Settings).');
    const stat = fs.statSync(sourcePath);
    let root = sourcePath;
    let stagingDir = null;
    let sourceArchive = null;
    if (stat.isFile()) {
      const ext = path.extname(sourcePath).toLowerCase();
      stagingDir = path.join(this.store.stagingDir, newId());
      if (PAK_EXTS.has(ext)) {
        // Loose pak/utoc/ucas — stage it plus any same-name siblings.
        fs.mkdirSync(stagingDir, { recursive: true });
        const dir = path.dirname(sourcePath);
        const base = path.basename(sourcePath, ext);
        for (const sib of fs.readdirSync(dir)) {
          const sibExt = path.extname(sib).toLowerCase();
          if (path.basename(sib, sibExt) === base && PAK_EXTS.has(sibExt)) {
            fs.copyFileSync(path.join(dir, sib), path.join(stagingDir, sib));
          }
        }
      } else {
        sourceArchive = path.basename(sourcePath);
        await extractArchive(sourcePath, stagingDir, this.store.settings.sevenZipPath);
      }
      root = stagingDir;
    }
    try {
      const fallbackName = safeName(path.basename(sourcePath).replace(/\.(zip|7z|rar|pak|utoc|ucas)$/i, ''));

      // FOMOD-scripted archive: hand the script to the renderer's wizard instead
      // of guessing at the folders. The script is read, never executed.
      if (!opts.skipFomod) {
        const fomod = require('./fomod');
        const detected = fomod.detect(root);
        if (detected) {
          const sessionId = newId();
          this._fomodSessions.set(sessionId, {
            root, stagingDir, sourceArchive,
            fomodBase: detected.baseDir,
            info: detected.info,
            fallbackName,
          });
          stagingDir = null; // keep the extracted files alive for the wizard
          return {
            pendingFomod: true, sessionId,
            moduleXml: detected.moduleXml,
            info: detected.info,
            name: (detected.info && detected.info.name) || fallbackName,
          };
        }
      }

      return this._installFromFolder(root, { fallbackName, sourceArchive, metaOverride: opts.metaOverride });
    } finally {
      if (stagingDir) fs.rmSync(stagingDir, { recursive: true, force: true });
    }
  }

  // Classify an on-disk folder and bring it into the library as a managed mod.
  _installFromFolder(root, { fallbackName, sourceArchive, metaOverride }) {
    const info = classifyFolder(root, fallbackName);
    if (!info.modType) throw new Error(info.warnings.join(' '));

    if (info.modType === 'ue4ss-runtime') {
      return this._installUe4ssRuntime(root, info);
    }

    const id = newId();
    const libDir = this.store.modLibraryDir(id);
    fs.mkdirSync(libDir, { recursive: true });
    const files = [];
    for (const p of info.payload) {
      const src = path.join(root, p.sourceRelative);
      const dst = path.join(libDir, p.deployRelative);
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.copyFileSync(src, dst);
      files.push({ libraryRelative: p.deployRelative, size: fs.statSync(dst).size, sha256: sha256File(dst) });
    }

    const meta = { ...(info.meta || {}), ...(metaOverride || {}) };
    const ordered = ['pak', 'iostore'].includes(info.modType);
    const mod = {
      id,
      name: (metaOverride && metaOverride.title) || info.name,
      version: meta.version || null,
      author: meta.author || null,
      description: meta.description || null,
      eaCompatible: typeof meta.eaCompatible === 'boolean' ? meta.eaCompatible : null,
      launchers: meta.launchers || null,
      modType: info.modType,
      enabled: false,
      installedAt: new Date().toISOString(),
      installedBuild: this.currentBuildId(),
      loadPriority: ordered ? this.store.nextLoadPriority(['pak', 'iostore']) : null,
      ue4ssPriority: info.modType === 'ue4ss-mod' ? this._nextUe4ssPriority() : null,
      sourceArchive,
      files,
      packages: this._listPackages(libDir, files),
      warnings: info.warnings,
      deployed: [],
      deployedHashes: {},
      backups: [],
      // Where the mod came from; installers with richer knowledge overwrite this.
      // {type:'local'} | {type:'nexus',modId,fileId,version} | {type:'github',repo,tag}
      origin: { type: 'local' },
      updateInfo: null,
    };
    this.store.addMod(mod);
    this.setEnabled(id, true);
    return this.store.getMod(id);
  }

  // ------------------------------------------------------------- FOMOD sessions

  fomodSession(sessionId) {
    const s = this._fomodSessions.get(sessionId);
    if (!s) throw new Error('That guided install is no longer active.');
    return s;
  }

  // Materialize the wizard's answers (source→destination copy list, already
  // priority-ordered) into a plain folder, then install it like any other mod.
  // Every path is re-checked here — group rules on screen are not trusted.
  async completeFomod(sessionId, selections) {
    const session = this.fomodSession(sessionId);
    const fomod = require('./fomod');
    const matDir = path.join(this.store.stagingDir, `fomod-${newId()}`);
    try {
      fomod.materialize(session.root, session.fomodBase, selections, matDir);
      const metaOverride = {};
      if (session.info) {
        if (session.info.name) metaOverride.title = session.info.name;
        if (session.info.version) metaOverride.version = session.info.version;
        if (session.info.author) metaOverride.author = session.info.author;
        if (session.info.description) metaOverride.description = session.info.description;
      }
      return this._installFromFolder(matDir, {
        fallbackName: (session.info && session.info.name) ? safeName(session.info.name) : session.fallbackName,
        sourceArchive: session.sourceArchive,
        metaOverride,
      });
    } finally {
      fs.rmSync(matDir, { recursive: true, force: true });
      this.cancelFomod(sessionId);
    }
  }

  cancelFomod(sessionId) {
    const s = this._fomodSessions.get(sessionId);
    if (!s) return;
    this._fomodSessions.delete(sessionId);
    if (s.stagingDir) fs.rmSync(s.stagingDir, { recursive: true, force: true });
  }

  _installUe4ssRuntime(root, info) {
    const win64 = this.gameAbs(WIN64_REL);
    if (!fs.existsSync(win64)) throw new Error('Game Win64 folder not found.');
    for (const p of info.payload) {
      const dst = path.join(win64, p.deployRelative);
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.copyFileSync(path.join(root, p.sourceRelative), dst);
    }
    fs.mkdirSync(path.join(win64, 'ue4ss', 'Mods'), { recursive: true });
    return { id: null, name: 'UE4SS Runtime', modType: 'ue4ss-runtime', enabled: true, runtime: true };
  }

  // Best-effort asset-path listing via `retoc list <utoc> --path` (for conflict detection).
  // Paths are printed relative to the engine binary dir, prefixed "../../../".
  _listPackages(libDir, files) {
    const retoc = this.retocPath();
    if (!retoc) return [];
    const packages = new Set();
    for (const f of files) {
      if (path.extname(f.libraryRelative).toLowerCase() !== '.utoc') continue;
      try {
        const out = execFileSync(retoc, ['list', path.join(libDir, f.libraryRelative), '--path'], {
          encoding: 'utf8', timeout: 60000, maxBuffer: 128 * 1024 * 1024,
          stdio: ['ignore', 'pipe', 'ignore'],
        });
        for (const line of out.split(/\r?\n/)) {
          const idx = line.indexOf('../../../');
          if (idx === -1) continue;
          const assetPath = line.slice(idx + '../../../'.length).trim();
          if (assetPath) packages.add(assetPath.toLowerCase());
        }
      } catch (_) { /* retoc list failed on this container — skip */ }
    }
    return [...packages];
  }

  // Re-scan asset paths for mods that were installed while retoc was unavailable.
  refreshPackages() {
    if (!this.retocPath()) return 0;
    let updated = 0;
    for (const mod of this.store.mods) {
      if (mod.modType !== 'iostore' || (mod.packages && mod.packages.length)) continue;
      const pkgs = this._listPackages(this.store.modLibraryDir(mod.id), mod.files);
      if (pkgs.length) {
        mod.packages = pkgs;
        updated += 1;
      }
    }
    if (updated) this.store.save();
    return updated;
  }

  retocPath() {
    const configured = this.store.settings.retocPath;
    const candidates = [
      configured,
      path.join(__dirname, '..', 'tools', 'retoc.exe'),
      // Packaged builds ship tools/ next to the asar via extraResources.
      process.resourcesPath ? path.join(process.resourcesPath, 'tools', 'retoc.exe') : null,
    ].filter(Boolean);
    for (const c of candidates) {
      try { if (fs.existsSync(c)) return c; } catch (_) {}
    }
    return null;
  }

  // ------------------------------------------------------------- deploy

  _pakPrefix(mod) {
    const prio = String(mod.loadPriority || 0).padStart(3, '0');
    return `pakchunk99-P${prio}_${safeName(mod.name)}_`;
  }

  _deployMod(mod) {
    this.ensureGameDirs();
    const libDir = this.store.modLibraryDir(mod.id);
    const deployed = [];
    const hashes = {};
    // Deployed files are byte-identical library copies — reuse the install-time
    // hash where recorded (pre-1.1.0 installs have none; hash on the fly).
    const libHash = (f) => f.sha256 || sha256File(path.join(libDir, f.libraryRelative));
    if (mod.modType === 'pak' || mod.modType === 'iostore') {
      const prefix = this._pakPrefix(mod);
      for (const f of mod.files) {
        const base = path.basename(f.libraryRelative, path.extname(f.libraryRelative));
        const ext = path.extname(f.libraryRelative);
        const suffix = safeName(base) === safeName(mod.name) ? '' : safeName(base);
        const destRel = path.join(MODS_REL, `${prefix}${suffix}${ext}`.replace(/_(?=\.)/, ''));
        const dst = this.gameAbs(destRel);
        fs.copyFileSync(path.join(libDir, f.libraryRelative), dst);
        deployed.push(destRel);
        hashes[destRel] = libHash(f);
      }
    } else if (mod.modType === 'logicmods') {
      for (const f of mod.files) {
        const destRel = path.join(LOGIC_MODS_REL, path.basename(f.libraryRelative));
        const dst = this.gameAbs(destRel);
        fs.copyFileSync(path.join(libDir, f.libraryRelative), dst);
        deployed.push(destRel);
        hashes[destRel] = libHash(f);
      }
    } else if (mod.modType === 'ue4ss-mod') {
      const modDirRel = path.join(UE4SS_MODS_REL, safeName(mod.name));
      for (const f of mod.files) {
        const destRel = path.join(modDirRel, f.libraryRelative);
        const dst = this.gameAbs(destRel);
        fs.mkdirSync(path.dirname(dst), { recursive: true });
        fs.copyFileSync(path.join(libDir, f.libraryRelative), dst);
        deployed.push(destRel);
        hashes[destRel] = libHash(f);
      }
      // enabled.txt makes UE4SS load the mod without a mods.txt entry
      const enabledTxtRel = path.join(modDirRel, 'enabled.txt');
      const enabledTxt = this.gameAbs(enabledTxtRel);
      if (!fs.existsSync(enabledTxt)) fs.writeFileSync(enabledTxt, '');
      deployed.push(enabledTxtRel);
      // enabled.txt is a marker the user may legitimately touch — no hash.
    } else if (mod.modType === 'gamefolder') {
      // Replacement-style mod: the original of every game file it overwrites is
      // kept in the manager's backups and restored when the mod is disabled.
      const backupDir = this.store.modBackupsDir(mod.id);
      mod.backups = mod.backups || [];
      for (const f of mod.files) {
        const destRel = f.libraryRelative; // game-root-relative by construction
        const dst = this.gameAbs(destRel);
        if (fs.existsSync(dst) && !mod.backups.includes(destRel)) {
          const bak = path.join(backupDir, destRel);
          fs.mkdirSync(path.dirname(bak), { recursive: true });
          fs.copyFileSync(dst, bak);
          mod.backups.push(destRel);
        }
        fs.mkdirSync(path.dirname(dst), { recursive: true });
        fs.copyFileSync(path.join(libDir, f.libraryRelative), dst);
        deployed.push(destRel);
        hashes[destRel] = libHash(f);
      }
    }
    mod.deployed = deployed;
    mod.deployedHashes = hashes;
  }

  // force=true skips the ownership check (used after the user confirms, and for
  // internal redeploys where the files were verified moments earlier).
  _undeployMod(mod, force) {
    if (!force) {
      // SHA-256 ownership check: a deployed file that changed outside the
      // manager is someone else's data now — stop instead of deleting it.
      const changed = [];
      for (const rel of mod.deployed || []) {
        const expected = mod.deployedHashes && mod.deployedHashes[rel];
        if (!expected) continue;
        const abs = this.gameAbs(rel);
        if (!fs.existsSync(abs)) continue;
        try { if (sha256File(abs) !== expected) changed.push(rel); } catch (_) {}
      }
      if (changed.length) {
        const err = new Error(
          `VERIFY_CHANGED::${mod.name}::${changed.join('|')}`);
        err.verifyChanged = changed;
        throw err;
      }
    }
    for (const rel of mod.deployed || []) {
      const abs = this.gameAbs(rel);
      try { fs.rmSync(abs, { force: true }); } catch (_) {}
    }
    if (mod.modType === 'gamefolder') {
      // Put the original game files back.
      const backupDir = this.store.modBackupsDir(mod.id);
      for (const rel of mod.backups || []) {
        const bak = path.join(backupDir, rel);
        if (!fs.existsSync(bak)) continue;
        const dst = this.gameAbs(rel);
        try {
          fs.mkdirSync(path.dirname(dst), { recursive: true });
          fs.copyFileSync(bak, dst);
        } catch (_) {}
      }
    }
    if (mod.modType === 'ue4ss-mod') {
      // Remove the (now empty) mod folder tree.
      const dir = this.gameAbs(path.join(UE4SS_MODS_REL, safeName(mod.name)));
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
    }
    mod.deployed = [];
    mod.deployedHashes = {};
  }

  setEnabled(id, enabled, force) {
    const mod = this.store.getMod(id);
    if (!mod) throw new Error('That mod is no longer installed.');
    if (enabled === mod.enabled) return mod;
    if (enabled) this._deployMod(mod);
    else this._undeployMod(mod, force);
    mod.enabled = enabled;
    this.store.save();
    if (mod.modType === 'ue4ss-mod') this._syncUe4ssModsTxt();
    return mod;
  }

  uninstall(id, force) {
    const mod = this.store.getMod(id);
    if (!mod) throw new Error('That mod is no longer installed.');
    if (mod.enabled) this._undeployMod(mod, force);
    fs.rmSync(this.store.modLibraryDir(id), { recursive: true, force: true });
    fs.rmSync(this.store.modBackupsDir(id), { recursive: true, force: true });
    this.store.removeMod(id);
    if (mod.modType === 'ue4ss-mod') this._syncUe4ssModsTxt();
  }

  rename(id, name) {
    const mod = this.store.getMod(id);
    if (!mod) throw new Error('That mod is no longer installed.');
    if (!name || name.length > 120) throw new Error('Use a name between 1 and 120 characters.');
    const wasEnabled = mod.enabled;
    if (wasEnabled) this._undeployMod(mod);
    mod.name = name;
    if (wasEnabled) this._deployMod(mod);
    this.store.save();
    if (mod.modType === 'ue4ss-mod') this._syncUe4ssModsTxt();
    return mod;
  }

  // Mark a mod as verified against the current game build (clears the
  // "installed under a different build" warning until the game updates again).
  confirmBuild(id) {
    const mod = this.store.getMod(id);
    if (!mod) throw new Error('That mod is no longer installed.');
    mod.installedBuild = this.currentBuildId();
    this.store.save();
    return mod;
  }

  // New order = array of mod ids (pak/iostore only), first = lowest priority.
  applyLoadOrder(orderedIds) {
    const orderable = this.store.mods.filter((m) => ['pak', 'iostore'].includes(m.modType));
    const idSet = new Set(orderable.map((m) => m.id));
    if (orderedIds.length !== orderable.length || orderedIds.some((i) => !idSet.has(i))) {
      throw new Error('The order must list every installed pak mod exactly once.');
    }
    // Verify every file that will move BEFORE touching anything, so a failed
    // ownership check cannot leave the order half-applied.
    const changed = [];
    orderedIds.forEach((id, idx) => {
      const mod = this.store.getMod(id);
      if (!mod.enabled || mod.loadPriority === idx + 1) return;
      for (const rel of mod.deployed || []) {
        const expected = mod.deployedHashes && mod.deployedHashes[rel];
        if (!expected) continue;
        const abs = this.gameAbs(rel);
        if (!fs.existsSync(abs)) continue;
        try { if (sha256File(abs) !== expected) changed.push(`${mod.name}: ${rel}`); } catch (_) {}
      }
    });
    if (changed.length) {
      throw new Error(`These deployed files were changed outside the manager — reorder stopped to protect them: ${changed.join(', ')}`);
    }
    // Snapshot the outgoing order for one-step rollback.
    this.store.data.lastOrderBackup = {
      at: new Date().toISOString(),
      order: [...orderable].sort((a, b) => (a.loadPriority || 0) - (b.loadPriority || 0)).map((m) => m.id),
    };
    orderedIds.forEach((id, idx) => {
      const mod = this.store.getMod(id);
      const newPrio = idx + 1;
      if (mod.loadPriority !== newPrio) {
        const wasEnabled = mod.enabled;
        if (wasEnabled) this._undeployMod(mod, true); // verified above
        mod.loadPriority = newPrio;
        if (wasEnabled) this._deployMod(mod);
      }
    });
    this.store.save();
  }

  // Winner preview for a drafted order: which conflict pairs exist, who wins
  // now, and who would win after — shown for review before anything moves.
  previewLoadOrder(orderedIds) {
    const prio = new Map(orderedIds.map((id, i) => [id, i + 1]));
    const pairs = [];
    for (const c of this.conflicts()) {
      if (!prio.has(c.aId) || !prio.has(c.bId)) continue;
      const a = this.store.getMod(c.aId);
      const b = this.store.getMod(c.bId);
      const newWinner = prio.get(c.bId) > prio.get(c.aId) ? b : a;
      pairs.push({
        aName: a.name, bName: b.name,
        certainty: c.certainty,
        packageCount: c.packageCount, fileCount: c.fileCount,
        oldWinnerName: this.store.getMod(c.winnerId).name,
        newWinnerName: newWinner.name,
        changed: newWinner.id !== c.winnerId,
      });
    }
    const moved = orderedIds.filter((id, idx) => {
      const m = this.store.getMod(id);
      return m && m.loadPriority !== idx + 1;
    }).length;
    return { pairs, changedCount: pairs.filter((p) => p.changed).length, movedCount: moved };
  }

  // One-step undo of the last applied order (applying makes the outgoing order
  // the new backup, so rollback of a rollback is redo).
  rollbackLoadOrder() {
    const backup = this.store.data.lastOrderBackup;
    if (!backup || !Array.isArray(backup.order)) throw new Error('No earlier load order to roll back to.');
    const orderable = this.store.mods
      .filter((m) => ['pak', 'iostore'].includes(m.modType))
      .sort((a, b) => (a.loadPriority || 0) - (b.loadPriority || 0));
    const known = new Set(orderable.map((m) => m.id));
    const restored = backup.order.filter((id) => known.has(id));
    const extras = orderable.filter((m) => !restored.includes(m.id)).map((m) => m.id);
    this.applyLoadOrder([...restored, ...extras]);
    return { restoredAt: backup.at, appended: extras.length };
  }

  // Startup recovery: an enabled mod whose deployed files went missing (deleted
  // by hand, a game update, a cleanup tool) is redeployed from its library copy.
  repairDeployments() {
    const repaired = [];
    for (const mod of this.store.mods.filter((m) => m.enabled)) {
      const missing = (mod.deployed || []).some((rel) => !fs.existsSync(this.gameAbs(rel)));
      if (!missing) continue;
      try {
        this._undeployMod(mod, true);
        this._deployMod(mod);
        repaired.push(mod.name);
      } catch (_) { /* leave it for diagnostics to report */ }
    }
    if (repaired.length) this.store.save();
    return repaired;
  }

  // Suggest an order for pak/iostore mods: broad mods (many assets) first,
  // targeted patches (few assets) later so the focused mod wins where they overlap.
  // Mods with equal/unknown asset counts keep their current relative order.
  suggestLoadOrder() {
    const current = this.store.mods
      .filter((m) => ['pak', 'iostore'].includes(m.modType))
      .sort((a, b) => (a.loadPriority || 0) - (b.loadPriority || 0));
    const count = (m) => (m.packages || []).length;
    const suggested = [...current].sort((a, b) => count(b) - count(a)); // stable in V8
    const orderedIds = suggested.map((m) => m.id);
    const changed = current.some((m, i) => m.id !== orderedIds[i]);
    // Note which confirmed conflicts this ordering decides.
    const decisions = [];
    for (const c of this.conflicts()) {
      if (c.certainty !== 'confirmed') continue;
      const ai = orderedIds.indexOf(c.aId);
      const bi = orderedIds.indexOf(c.bId);
      if (ai === -1 || bi === -1) continue;
      const winner = this.store.getMod(orderedIds[Math.max(ai, bi)]);
      const loser = this.store.getMod(orderedIds[Math.min(ai, bi)]);
      decisions.push(`${winner.name} overrides ${loser.name} (${c.packageCount} shared asset${c.packageCount === 1 ? '' : 's'})`);
    }
    return {
      orderedIds,
      changed,
      rationale: 'Broad mods first, targeted patches later — the more focused mod wins where they overlap.',
      decisions,
    };
  }

  // Replace an installed mod with a new version, preserving its name, enabled
  // state, load priority, and origin (caller refreshes the origin's version/tag).
  async replaceInPlace(id, sourcePath) {
    const old = this.store.getMod(id);
    if (!old) throw new Error('That mod is no longer installed.');
    const keep = {
      name: old.name,
      enabled: old.enabled,
      loadPriority: old.loadPriority,
      origin: old.origin,
    };
    this.uninstall(id);
    const installed = await this.install(sourcePath);
    if (!installed.id) return installed; // runtime install — nothing to restore
    const mod = this.store.getMod(installed.id);
    if (keep.name && mod.name !== keep.name) this.rename(mod.id, keep.name);
    if (keep.loadPriority != null && ['pak', 'iostore'].includes(mod.modType)) {
      const m = this.store.getMod(mod.id);
      const wasEnabled = m.enabled;
      if (wasEnabled) this._undeployMod(m);
      m.loadPriority = keep.loadPriority;
      if (wasEnabled) this._deployMod(m);
    }
    if (!keep.enabled) this.setEnabled(mod.id, false);
    const final = this.store.getMod(mod.id);
    final.origin = keep.origin;
    final.updateInfo = null;
    this.store.save();
    return final;
  }

  // Current game build identity: Steam manifest buildid where a manifest
  // covers the install, else a local exe fingerprint (EA App / manual copies).
  currentBuildId() {
    try {
      if (!this.gamePath()) return null;
      const steam = require('./steam');
      const det = steam.detectGame(this.gamePath());
      return det.found ? det.buildId : null;
    } catch (_) { return null; }
  }

  _nextUe4ssPriority() {
    const prios = this.store.mods
      .filter((m) => m.modType === 'ue4ss-mod')
      .map((m) => m.ue4ssPriority || 0);
    return (prios.length ? Math.max(...prios) : 0) + 1;
  }

  // ------------------------------------------------------------- UE4SS start order (mods.txt)
  // UE4SS reads mods.txt top-down in two passes: DLL mods start while the
  // runtime initializes, Lua mods once the scripting runtime exists. Order
  // therefore matters WITHIN each pass. The manager owns one marked block,
  // placed just before the runtime's Keybinds entry with its warning attached;
  // everything else in the file is preserved untouched.

  _modsTxtAbs() { return this.gameAbs(path.join(UE4SS_MODS_REL, 'mods.txt')); }

  ue4ssPassOf(mod) {
    const libDir = this.store.modLibraryDir(mod.id);
    return fs.existsSync(path.join(libDir, 'dlls', 'main.dll')) ? 'dll' : 'lua';
  }

  _readModsTxt() {
    try {
      const raw = fs.readFileSync(this._modsTxtAbs(), 'utf8');
      return { lines: raw.split(/\r?\n/), eol: raw.includes('\r\n') ? '\r\n' : '\n', exists: true };
    } catch (_) {
      return {
        lines: ['; Created by Zero Company Mod Command', '; Built-in keybinds, do not move up!', 'Keybinds : 1', ''],
        eol: '\r\n',
        exists: false,
      };
    }
  }

  // Enabled UE4SS mods in start order (DLL-pass mods sort ahead of Lua-pass
  // mods by default; within a pass the saved priority, then install time).
  _managedUe4ssMods() {
    return this.store.mods
      .filter((m) => m.modType === 'ue4ss-mod' && m.enabled)
      .sort((a, b) => (a.ue4ssPriority || 1e9) - (b.ue4ssPriority || 1e9)
        || String(a.installedAt).localeCompare(String(b.installedAt)));
  }

  ue4ssOrderState() {
    const managed = this._managedUe4ssMods().map((m) => ({
      id: m.id,
      name: m.name,
      dirName: safeName(m.name),
      pass: this.ue4ssPassOf(m),
      priority: m.ue4ssPriority || null,
    }));
    const { lines, exists } = this._readModsTxt();
    const applied = lines.includes(UE4SS_BLOCK_BEGIN);
    // Entries the manager does not own (runtime built-ins, hand-added mods) — display-only.
    const managedDirs = new Set(managed.map((m) => m.dirName.toLowerCase()));
    const others = [];
    let inBlock = false;
    for (const line of lines) {
      if (line === UE4SS_BLOCK_BEGIN) { inBlock = true; continue; }
      if (line === UE4SS_BLOCK_END) { inBlock = false; continue; }
      if (inBlock) continue;
      const m = line.match(/^\s*([^;#\s][^:]*?)\s*:\s*([01])\s*$/);
      if (m && !managedDirs.has(m[1].trim().toLowerCase())) {
        others.push({ name: m[1].trim(), enabled: m[2] === '1' });
      }
    }
    return { managed, others, applied, modsTxtExists: exists };
  }

  // New order = every ENABLED UE4SS mod exactly once (any mix of passes; the
  // runtime applies each pass in this relative order).
  applyUe4ssOrder(orderedIds) {
    const eligible = this._managedUe4ssMods();
    const idSet = new Set(eligible.map((m) => m.id));
    if (orderedIds.length !== eligible.length || orderedIds.some((i) => !idSet.has(i))) {
      throw new Error('The start order must list every enabled UE4SS mod exactly once.');
    }
    orderedIds.forEach((id, idx) => { this.store.getMod(id).ue4ssPriority = idx + 1; });
    this._syncUe4ssModsTxt(true);
    this.store.save();
  }

  // Rewrite the managed block from current state. Until the first Apply the
  // block doesn't exist and deploys keep using enabled.txt markers alone;
  // pass force=true to create it (the first Apply does).
  _syncUe4ssModsTxt(force) {
    if (!this.gamePath()) return;
    if (!fs.existsSync(this.gameAbs(UE4SS_MODS_REL))) return;
    const { lines, eol } = this._readModsTxt();
    const hasBlock = lines.includes(UE4SS_BLOCK_BEGIN);
    if (!hasBlock && !force) return;
    const managed = this._managedUe4ssMods();
    const managedDirs = new Set(managed.map((m) => safeName(m.name).toLowerCase()));
    // Drop the old block, plus any bare entries for managed mods elsewhere in
    // the file — a hand-placed managed entry moves into the block.
    const kept = [];
    let inBlock = false;
    for (const line of lines) {
      if (line === UE4SS_BLOCK_BEGIN) { inBlock = true; continue; }
      if (line === UE4SS_BLOCK_END) { inBlock = false; continue; }
      if (inBlock) continue;
      const m = line.match(/^\s*([^;#\s][^:]*?)\s*:\s*[01]\s*$/);
      if (m && managedDirs.has(m[1].trim().toLowerCase())) continue;
      kept.push(line);
    }
    const block = [UE4SS_BLOCK_BEGIN, ...managed.map((m) => `${safeName(m.name)} : 1`), UE4SS_BLOCK_END];
    // Insert before the Keybinds entry, keeping its warning comment attached.
    let insertAt = kept.findIndex((l) => /^\s*Keybinds\s*:/i.test(l));
    if (insertAt > 0) {
      const prev = kept[insertAt - 1];
      if (/^\s*;/.test(prev) && /keybind|do not/i.test(prev)) insertAt -= 1;
    }
    if (insertAt === -1) insertAt = kept.length;
    kept.splice(insertAt, 0, ...block);
    fs.writeFileSync(this._modsTxtAbs(), kept.join(eol));
    // The block is authoritative — retire redundant enabled.txt markers (and
    // prune them from deploy records so startup recovery doesn't re-create them).
    let pruned = false;
    for (const m of managed) {
      const rel = path.join(UE4SS_MODS_REL, safeName(m.name), 'enabled.txt');
      try { fs.rmSync(this.gameAbs(rel), { force: true }); } catch (_) {}
      if (m.deployed && m.deployed.includes(rel)) {
        m.deployed = m.deployed.filter((r) => r !== rel);
        if (m.deployedHashes) delete m.deployedHashes[rel];
        pruned = true;
      }
    }
    if (pruned) this.store.save();
  }

  // ------------------------------------------------------------- profiles

  saveProfile(name) {
    if (!name || name.length > 60) throw new Error('Use a profile name between 1 and 60 characters.');
    const orderable = this.store.mods
      .filter((m) => ['pak', 'iostore'].includes(m.modType))
      .sort((a, b) => (a.loadPriority || 0) - (b.loadPriority || 0));
    const profile = {
      id: newId(),
      name,
      savedAt: new Date().toISOString(),
      entries: this.store.mods.map((m) => ({ modId: m.id, modName: m.name, enabled: m.enabled })),
      order: orderable.map((m) => m.id),
    };
    // Overwrite an existing profile with the same name.
    this.store.data.profiles = this.store.profiles.filter((p) => p.name.toLowerCase() !== name.toLowerCase());
    this.store.data.profiles.push(profile);
    this.store.save();
    return profile;
  }

  applyProfile(id) {
    const profile = this.store.profiles.find((p) => p.id === id);
    if (!profile) throw new Error('That profile no longer exists.');
    const warnings = [];
    const known = new Set(this.store.mods.map((m) => m.id));
    for (const entry of profile.entries) {
      if (!known.has(entry.modId)) {
        warnings.push(`"${entry.modName || entry.modId}" is no longer installed — skipped.`);
        continue;
      }
      const mod = this.store.getMod(entry.modId);
      if (mod.enabled !== entry.enabled) this.setEnabled(mod.id, entry.enabled);
    }
    // Restore order: profile order first (existing mods only), new mods appended in current order.
    const orderable = this.store.mods
      .filter((m) => ['pak', 'iostore'].includes(m.modType))
      .sort((a, b) => (a.loadPriority || 0) - (b.loadPriority || 0));
    const inProfile = profile.order.filter((mid) => orderable.some((m) => m.id === mid));
    const extras = orderable.filter((m) => !inProfile.includes(m.id)).map((m) => m.id);
    if (extras.length) warnings.push(`${extras.length} mod(s) installed after this profile was saved were placed last.`);
    this.applyLoadOrder([...inProfile, ...extras]);
    return { profile, warnings };
  }

  deleteProfile(id) {
    this.store.data.profiles = this.store.profiles.filter((p) => p.id !== id);
    this.store.save();
  }

  // ------------------------------------------------------------- adoption of existing mods

  // Find mod content in the game's deploy locations that no managed mod owns.
  // Returns candidates: { id, kind: 'pak-group'|'logicmods-group'|'ue4ss-folder',
  //                       name, modType, location, files: [game-relative], active }
  scanUnmanaged() {
    if (!this.gamePath()) return [];
    const candidates = [];
    const owned = new Set();
    for (const m of this.store.mods) {
      for (const rel of m.deployed || []) owned.add(path.resolve(this.gameAbs(rel)).toLowerCase());
    }

    // Pak-style locations: group loose pak/utoc/ucas by basename.
    for (const [locRel, kind, defaultType] of [[MODS_REL, 'pak-group', 'pak'], [LOGIC_MODS_REL, 'logicmods-group', 'logicmods']]) {
      const dir = this.gameAbs(locRel);
      if (!fs.existsSync(dir)) continue;
      const groups = new Map();
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isFile()) continue;
        const ext = path.extname(entry.name).toLowerCase();
        if (!PAK_EXTS.has(ext)) continue;
        const abs = path.resolve(path.join(dir, entry.name));
        if (owned.has(abs.toLowerCase())) continue;
        const base = path.basename(entry.name, ext);
        if (!groups.has(base)) groups.set(base, []);
        groups.get(base).push(path.join(locRel, entry.name));
      }
      for (const [base, files] of groups) {
        const hasIoStore = files.some((f) => ['.utoc', '.ucas'].includes(path.extname(f).toLowerCase()));
        candidates.push({
          id: `${kind}:${base}`,
          kind,
          name: base.replace(/^pakchunk99-P\d+_/i, ''),
          modType: kind === 'logicmods-group' ? 'logicmods' : (hasIoStore ? 'iostore' : 'pak'),
          location: locRel,
          files,
          active: true,
        });
      }
    }

    // UE4SS mod folders not managed and not built-in.
    const modsDir = this.gameAbs(UE4SS_MODS_REL);
    if (fs.existsSync(modsDir)) {
      const BUILTIN = new Set([
        'shared', 'bpmodloadermod', 'bpml_genericfunctions', 'consolecommandsmod',
        'consoleenablermod', 'splitscreenmod', 'linetracemod', 'actordumpermod',
        'jsbluaprofilermod', 'keybinds',
      ]);
      let modsTxt = '';
      try { modsTxt = fs.readFileSync(path.join(modsDir, 'mods.txt'), 'utf8'); } catch (_) {}
      const managedDirs = new Set(this.store.mods
        .filter((m) => m.modType === 'ue4ss-mod')
        .map((m) => safeName(m.name).toLowerCase()));
      for (const dirent of fs.readdirSync(modsDir, { withFileTypes: true })) {
        if (!dirent.isDirectory()) continue;
        const lower = dirent.name.toLowerCase();
        if (BUILTIN.has(lower) || managedDirs.has(lower)) continue;
        const dir = path.join(modsDir, dirent.name);
        const hasPayload = fs.existsSync(path.join(dir, 'Scripts', 'main.lua')) || fs.existsSync(path.join(dir, 'dlls', 'main.dll'));
        if (!hasPayload) continue;
        const active = fs.existsSync(path.join(dir, 'enabled.txt')) ||
          new RegExp(`^\\s*${dirent.name}\\s*:\\s*1\\s*$`, 'mi').test(modsTxt);
        candidates.push({
          id: `ue4ss-folder:${dirent.name}`,
          kind: 'ue4ss-folder',
          name: dirent.name,
          modType: 'ue4ss-mod',
          location: path.join(UE4SS_MODS_REL, dirent.name),
          files: walkFiles(dir).map((f) => path.join(UE4SS_MODS_REL, dirent.name, f)),
          active,
        });
      }
    }
    return candidates;
  }

  // Bring an unmanaged candidate under management: library gets the canonical
  // copy; the already-deployed game files are claimed in place (nothing moves,
  // so the game setup is untouched mid-adoption).
  adopt(candidate) {
    const id = newId();
    const libDir = this.store.modLibraryDir(id);
    fs.mkdirSync(libDir, { recursive: true });
    const files = [];
    for (const rel of candidate.files) {
      const src = this.gameAbs(rel);
      const libraryRelative = candidate.kind === 'ue4ss-folder'
        ? path.relative(path.join(UE4SS_MODS_REL, candidate.name), rel)
        : path.basename(rel);
      const dst = path.join(libDir, libraryRelative);
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.copyFileSync(src, dst);
      files.push({ libraryRelative, size: fs.statSync(dst).size, sha256: sha256File(dst) });
    }
    const ordered = ['pak', 'iostore'].includes(candidate.modType);
    const mod = {
      id,
      name: safeName(candidate.name),
      version: null,
      eaCompatible: null,
      launchers: null,
      modType: candidate.modType,
      enabled: candidate.active,
      installedAt: new Date().toISOString(),
      installedBuild: this.currentBuildId(),
      loadPriority: ordered ? this.store.nextLoadPriority(['pak', 'iostore']) : null,
      ue4ssPriority: candidate.modType === 'ue4ss-mod' ? this._nextUe4ssPriority() : null,
      sourceArchive: null,
      files,
      packages: this._listPackages(libDir, files),
      warnings: [],
      deployed: candidate.active ? [...candidate.files] : [],
      origin: { type: 'local', adopted: true },
      updateInfo: null,
    };
    // An inactive UE4SS folder is tidied away (the library now holds the copy);
    // enabling later redeploys it.
    if (!candidate.active && candidate.kind === 'ue4ss-folder') {
      try { fs.rmSync(this.gameAbs(path.join(UE4SS_MODS_REL, candidate.name)), { recursive: true, force: true }); } catch (_) {}
    }
    this.store.addMod(mod);
    return this.store.getMod(id);
  }

  // Attach an update source to a mod after the fact (manual link or md5 match).
  setOrigin(id, origin) {
    const mod = this.store.getMod(id);
    if (!mod) throw new Error('That mod is no longer installed.');
    mod.origin = origin;
    mod.updateInfo = null;
    this.store.save();
    return mod;
  }

  // ------------------------------------------------------------- UE4SS hook scan

  // Static scan of UE4SS Lua mods for hook registrations that can collide:
  //  - RegisterHook / RegisterCustomEvent on the same UFunction path
  //    (callbacks stack, but mods that alter params/return values fight)
  //  - RegisterKeyBind on the same key (+modifiers) — both fire on one press
  // Covers manager-installed mods AND unmanaged folders in the game's ue4ss/Mods.
  scanUe4ssHooks() {
    const empty = { entries: [], conflicts: [] };
    if (!this.gamePath()) return empty;
    const BUILTIN = new Set([
      'shared', 'bpmodloadermod', 'bpml_genericfunctions', 'consolecommandsmod',
      'consoleenablermod', 'splitscreenmod', 'linetracemod', 'actordumpermod',
      'jsbluaprofilermod', 'keybinds',
    ]);
    const entries = [];

    // Manager-installed UE4SS mods (enabled only) — scan their canonical library copies.
    const managedDirNames = new Set();
    for (const mod of this.store.mods) {
      if (mod.modType !== 'ue4ss-mod') continue;
      managedDirNames.add(safeName(mod.name).toLowerCase());
      if (!mod.enabled) continue;
      const found = this._scanLuaDir(this.store.modLibraryDir(mod.id));
      entries.push({ name: mod.name, modId: mod.id, managed: true, ...found });
    }

    // Unmanaged mods living directly in the game's ue4ss/Mods folder.
    const modsDir = this.gameAbs(UE4SS_MODS_REL);
    if (fs.existsSync(modsDir)) {
      let modsTxt = '';
      try { modsTxt = fs.readFileSync(path.join(modsDir, 'mods.txt'), 'utf8'); } catch (_) {}
      for (const dirent of fs.readdirSync(modsDir, { withFileTypes: true })) {
        if (!dirent.isDirectory()) continue;
        const lower = dirent.name.toLowerCase();
        if (BUILTIN.has(lower) || managedDirNames.has(lower)) continue;
        const dir = path.join(modsDir, dirent.name);
        const viaEnabledTxt = fs.existsSync(path.join(dir, 'enabled.txt'));
        const viaModsTxt = new RegExp(`^\\s*${dirent.name}\\s*:\\s*1\\s*$`, 'mi').test(modsTxt);
        if (!viaEnabledTxt && !viaModsTxt) continue; // inactive
        const found = this._scanLuaDir(dir);
        entries.push({ name: dirent.name, modId: null, managed: false, ...found });
      }
    }

    // Collide hooks and keybinds across entries.
    const conflicts = [];
    const collide = (kind, pick) => {
      const map = new Map();
      for (const e of entries) {
        for (const item of pick(e)) {
          const key = item.toLowerCase();
          if (!map.has(key)) map.set(key, { display: item, entries: new Set() });
          map.get(key).entries.add(e);
        }
      }
      for (const { display, entries: who } of map.values()) {
        if (who.size < 2) continue;
        conflicts.push({
          kind,
          key: display,
          members: [...who].map((e) => ({ name: e.name, modId: e.modId, managed: e.managed })),
        });
      }
    };
    collide('hook', (e) => e.hooks);
    collide('keybind', (e) => e.keybinds);
    return { entries, conflicts };
  }

  _scanLuaDir(root) {
    const hooks = [];
    const keybinds = [];
    let luaFiles = 0;
    let files = [];
    try { files = walkFiles(root); } catch (_) {}
    for (const rel of files) {
      if (path.extname(rel).toLowerCase() !== '.lua') continue;
      luaFiles += 1;
      let src = '';
      try { src = fs.readFileSync(path.join(root, rel), 'utf8'); } catch (_) { continue; }
      // Strip Lua comments so documented examples don't count.
      src = src.replace(/--\[\[[\s\S]*?\]\]/g, '').replace(/--[^\n]*/g, '');
      for (const re of [/RegisterHook\s*\(\s*["']([^"']+)["']/g, /RegisterCustomEvent\s*\(\s*["']([^"']+)["']/g]) {
        let m;
        while ((m = re.exec(src)) !== null) hooks.push(m[1]);
      }
      const keyRe = /RegisterKeyBind\s*\(\s*Key\.([A-Z0-9_]+)\s*(?:,\s*\{([^}]*)\})?/g;
      let km;
      while ((km = keyRe.exec(src)) !== null) {
        const mods = (km[2] || '').match(/ModifierKey\.([A-Z_]+)/g) || [];
        const combo = [...mods.map((x) => x.replace('ModifierKey.', '')), km[1]].join('+');
        keybinds.push(combo);
      }
    }
    return { hooks: [...new Set(hooks)], keybinds: [...new Set(keybinds)], luaFiles };
  }

  // Identity keys for a UE4SS mod folder: its modinfo.json title (survives across
  // versions) AND a hash of its entry script/dll (catches identical copies even
  // without a manifest). Two folders sharing EITHER key are the same mod.
  _modIdentityKeys(dir) {
    const keys = [];
    try {
      const mf = path.join(dir, 'modinfo.json');
      if (fs.existsSync(mf)) {
        const j = JSON.parse(fs.readFileSync(mf, 'utf8'));
        if (j && typeof j.title === 'string' && j.title.trim()) keys.push('title:' + j.title.trim().toLowerCase());
      }
    } catch (_) {}
    for (const rel of ['Scripts/main.lua', 'dlls/main.dll']) {
      const f = path.join(dir, rel.split('/').join(path.sep));
      if (fs.existsSync(f)) {
        try { keys.push('hash:' + crypto.createHash('sha1').update(fs.readFileSync(f)).digest('hex')); } catch (_) {}
        break;
      }
    }
    return keys;
  }

  // Detect the SAME UE4SS mod active under more than one folder in ue4ss/Mods
  // (e.g. a manager-installed copy plus a leftover from a manual / one-click
  // install under a different folder name). Two active copies load and run at
  // once — double hooks/loops — and cause frame stutter. Folders are grouped by
  // shared identity key (title or identical script), so a copy with a manifest
  // and one without still match if their scripts are identical.
  // Returns [{ members: [{ folder, managed, modId, name }] }].
  scanDuplicateMods() {
    if (!this.gamePath()) return [];
    const modsDir = this.gameAbs(UE4SS_MODS_REL);
    if (!fs.existsSync(modsDir)) return [];
    const BUILTIN = new Set([
      'shared', 'bpmodloadermod', 'bpml_genericfunctions', 'consolecommandsmod',
      'consoleenablermod', 'splitscreenmod', 'linetracemod', 'actordumpermod',
      'jsbluaprofilermod', 'keybinds',
    ]);
    let modsTxt = '';
    try { modsTxt = fs.readFileSync(path.join(modsDir, 'mods.txt'), 'utf8'); } catch (_) {}
    const managedByDir = new Map();
    for (const mod of this.store.mods) {
      if (mod.modType === 'ue4ss-mod') managedByDir.set(safeName(mod.name).toLowerCase(), mod);
    }

    const nodes = [];
    for (const dirent of fs.readdirSync(modsDir, { withFileTypes: true })) {
      if (!dirent.isDirectory()) continue;
      const lower = dirent.name.toLowerCase();
      if (BUILTIN.has(lower)) continue;
      const dir = path.join(modsDir, dirent.name);
      const active = fs.existsSync(path.join(dir, 'enabled.txt')) ||
        new RegExp(`^\\s*${dirent.name}\\s*:\\s*1\\s*$`, 'mi').test(modsTxt);
      if (!active) continue;
      const keys = this._modIdentityKeys(dir);
      if (!keys.length) continue;
      const mod = managedByDir.get(lower);
      nodes.push({ folder: dirent.name, managed: !!mod, modId: mod ? mod.id : null, name: mod ? mod.name : dirent.name, keys });
    }

    // Union-find: merge nodes that share any identity key.
    const parent = nodes.map((_, i) => i);
    const find = (x) => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
    const keyToNode = new Map();
    nodes.forEach((n, i) => {
      for (const k of n.keys) {
        if (keyToNode.has(k)) parent[find(i)] = find(keyToNode.get(k));
        else keyToNode.set(k, i);
      }
    });
    const comps = new Map();
    nodes.forEach((n, i) => { const r = find(i); if (!comps.has(r)) comps.set(r, []); comps.get(r).push(n); });

    const dups = [];
    for (const members of comps.values()) {
      if (members.length > 1) {
        dups.push({ members: members.map((m) => ({ folder: m.folder, managed: m.managed, modId: m.modId, name: m.name })) });
      }
    }
    return dups;
  }

  // ------------------------------------------------------------- status

  // Pairwise incompatibility report between ENABLED mods.
  // Returns [{ aId, bId, winnerId, packageCount, fileCount, samples: [asset paths],
  //            certainty: 'confirmed'|'suspected' }]
  // 'confirmed' = overlapping asset paths proven via retoc; 'suspected' = matching
  // deploy filenames or unscanned containers that may overlap.
  conflicts(hookReport) {
    const enabled = this.store.mods.filter((m) => m.enabled);
    const pairs = new Map(); // "aId|bId" -> pair record

    const pairOf = (a, b) => {
      const [x, y] = a.id < b.id ? [a, b] : [b, a];
      const key = `${x.id}|${y.id}`;
      if (!pairs.has(key)) {
        pairs.set(key, { aId: x.id, bId: y.id, packageCount: 0, fileCount: 0, hookCount: 0, samples: [], sampleSet: new Set(), certainty: 'suspected' });
      }
      return pairs.get(key);
    };

    // 1. Confirmed: overlapping asset paths (retoc-scanned IoStore containers).
    const byPackage = new Map();
    for (const m of enabled) {
      for (const p of m.packages || []) {
        if (!byPackage.has(p)) byPackage.set(p, []);
        byPackage.get(p).push(m);
      }
    }
    for (const [assetPath, mods] of byPackage) {
      if (mods.length < 2) continue;
      for (let i = 0; i < mods.length; i++) {
        for (let j = i + 1; j < mods.length; j++) {
          const pair = pairOf(mods[i], mods[j]);
          pair.packageCount += 1;
          pair.certainty = 'confirmed';
          if (pair.samples.length < 8 && !pair.sampleSet.has(assetPath)) {
            pair.sampleSet.add(assetPath);
            pair.samples.push(assetPath);
          }
        }
      }
    }

    // 2. Suspected: same original container/file basenames (legacy paks, unscanned
    //    containers, LogicMods paks with equal names). UE4SS mods deploy into their
    //    own folders (every one ships Scripts/main.lua), so filename collisions are
    //    meaningless for them — their real conflicts are hooks, handled below.
    const byFile = new Map();
    for (const m of enabled) {
      if (m.modType === 'ue4ss-mod') continue;
      for (const f of m.files || []) {
        // Game-folder mods conflict on the exact game path they replace, not on
        // a shared basename — two different-folder files never collide.
        const key = m.modType === 'gamefolder'
          ? `gamefolder:${f.libraryRelative.toLowerCase()}`
          : `${m.modType}:${path.basename(f.libraryRelative).toLowerCase()}`;
        if (!byFile.has(key)) byFile.set(key, []);
        byFile.get(key).push(m);
      }
    }
    for (const [key, mods] of byFile) {
      const unique = [...new Set(mods)];
      if (unique.length < 2) continue;
      for (let i = 0; i < unique.length; i++) {
        for (let j = i + 1; j < unique.length; j++) {
          const pair = pairOf(unique[i], unique[j]);
          pair.fileCount += 1;
          const label = key.startsWith('gamefolder:')
            ? `both replace: ${key.split(':')[1]}`
            : `same file name: ${key.split(':')[1]}`;
          if (pair.samples.length < 8 && !pair.sampleSet.has(label)) {
            pair.sampleSet.add(label);
            pair.samples.push(label);
          }
        }
      }
    }

    // 3. UE4SS hook/keybind collisions between two manager-installed mods.
    for (const c of (hookReport ? hookReport.conflicts : [])) {
      const managed = c.members.filter((m) => m.modId).map((m) => this.store.getMod(m.modId)).filter(Boolean);
      for (let i = 0; i < managed.length; i++) {
        for (let j = i + 1; j < managed.length; j++) {
          const pair = pairOf(managed[i], managed[j]);
          pair.hookCount += 1;
          const label = c.kind === 'keybind' ? `UE4SS keybind: ${c.key}` : `UE4SS hook: ${c.key}`;
          if (pair.samples.length < 8 && !pair.sampleSet.has(label)) {
            pair.sampleSet.add(label);
            pair.samples.push(label);
          }
        }
      }
    }

    // Winner = the mod that deploys later (higher load priority), else newest install.
    const out = [];
    for (const pair of pairs.values()) {
      const a = this.store.getMod(pair.aId);
      const b = this.store.getMod(pair.bId);
      let winner;
      if (a.loadPriority != null && b.loadPriority != null) {
        winner = b.loadPriority > a.loadPriority ? b : a;
      } else {
        winner = (b.installedAt || '') > (a.installedAt || '') ? b : a;
      }
      delete pair.sampleSet;
      out.push({ ...pair, winnerId: winner.id, memberIds: [pair.aId, pair.bId] });
    }
    // Confirmed conflicts first, then by overlap size.
    out.sort((x, y) =>
      (x.certainty === y.certainty
        ? (y.packageCount + y.fileCount + y.hookCount) - (x.packageCount + x.fileCount + x.hookCount)
        : x.certainty === 'confirmed' ? -1 : 1));
    return out;
  }

  ue4ssStatus() {
    if (!this.gamePath()) return { installed: false, healthy: false, message: 'Game not located.' };
    const win64 = this.gameAbs(WIN64_REL);
    const dwmapi = fs.existsSync(path.join(win64, 'dwmapi.dll'));
    const dll = fs.existsSync(path.join(win64, 'ue4ss', 'UE4SS.dll'));
    const modsDir = fs.existsSync(path.join(win64, 'ue4ss', 'Mods'));
    const installed = dwmapi || dll;
    const healthy = dwmapi && dll && modsDir;
    let message = 'Not installed (only needed for Lua/DLL mods).';
    if (installed && !healthy) message = 'Incomplete layout: dwmapi.dll, ue4ss/UE4SS.dll, or ue4ss/Mods is missing.';
    if (healthy) message = 'Runtime present and healthy.';
    return { installed, healthy, message };
  }

  retocStatus() {
    const p = this.retocPath();
    if (!p) return { found: false, path: null, version: null };
    let version = null;
    try {
      version = execFileSync(p, ['--version'], { encoding: 'utf8', timeout: 10000 }).trim();
    } catch (_) {}
    return { found: true, path: p, version };
  }

  auditDeployedFiles() {
    // Verify every enabled mod's deployed files still exist.
    const missing = [];
    for (const m of this.store.mods.filter((x) => x.enabled)) {
      for (const rel of m.deployed || []) {
        if (!fs.existsSync(this.gameAbs(rel))) missing.push({ modId: m.id, modName: m.name, file: rel });
      }
    }
    return missing;
  }
}

module.exports = { ModEngine, classifyFolder, MODS_REL, LOGIC_MODS_REL, WIN64_REL, UE4SS_MODS_REL };

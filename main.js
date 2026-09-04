'use strict';
const { app, BrowserWindow, ipcMain, dialog, shell, safeStorage } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

const { Store } = require('./lib/store');
const steam = require('./lib/steam');
const { ModEngine, MODS_REL, LOGIC_MODS_REL, WIN64_REL, UE4SS_MODS_REL } = require('./lib/mods');
const { findSevenZip } = require('./lib/archive');
const nexus = require('./lib/nexus');
const ue4ssDl = require('./lib/ue4ss');
const configs = require('./lib/configs');
const { getPromotedAuthors } = require('./lib/featured');
const github = require('./lib/github');
const ea = require('./lib/ea');
const { checkLauncherUpdate } = require('./lib/launcher-update');

// Data lives next to the portable exe, or in ./data when running from source.
function resolveDataDir() {
  if (process.env.ZC_DATA_DIR) return process.env.ZC_DATA_DIR; // test harness override
  if (process.env.PORTABLE_EXECUTABLE_DIR) {
    return path.join(process.env.PORTABLE_EXECUTABLE_DIR, 'ZeroCompanyModCommand-data');
  }
  if (app.isPackaged) return path.join(app.getPath('userData'), 'data');
  return path.join(__dirname, 'data');
}

const store = new Store(resolveDataDir());
const engine = new ModEngine(store);
let win = null;

// ---------------------------------------------------------- Nexus API key at rest
// The key is kept encrypted with the OS user's credentials (DPAPI on Windows)
// via Electron safeStorage. Plaintext is only the fallback when the OS store is
// unavailable; a legacy plaintext key is migrated on startup.

function nexusKey() {
  const s = store.settings;
  if (s.nexusApiKeyEncrypted) {
    try {
      if (safeStorage.isEncryptionAvailable()) {
        return safeStorage.decryptString(Buffer.from(s.nexusApiKeyEncrypted, 'base64'));
      }
    } catch (_) { /* wrong OS user / corrupted blob — treat as no key */ }
    return null;
  }
  return s.nexusApiKey || null;
}

function storeNexusKey(key) {
  if (key && safeStorage.isEncryptionAvailable()) {
    store.settings.nexusApiKeyEncrypted = safeStorage.encryptString(key).toString('base64');
    store.settings.nexusApiKey = null;
  } else {
    store.settings.nexusApiKeyEncrypted = null;
    store.settings.nexusApiKey = key || null;
  }
  store.save();
}

function migrateNexusKey() {
  const s = store.settings;
  if (s.nexusApiKey && !s.nexusApiKeyEncrypted && safeStorage.isEncryptionAvailable()) {
    storeNexusKey(s.nexusApiKey);
  }
}

// ---------------------------------------------------------- single instance / nxm

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
}

function nxmFromArgv(argv) {
  return argv.find((a) => typeof a === 'string' && a.startsWith('nxm://')) || null;
}

app.on('second-instance', (_e, argv) => {
  if (win) {
    if (win.isMinimized()) win.restore();
    win.focus();
  }
  const url = nxmFromArgv(argv);
  if (url) handleNxm(url);
});

// Sends push events (toasts, state refreshes, progress) to the renderer.
function sendEvent(payload) {
  if (win && !win.isDestroyed()) win.webContents.send('zc-event', payload);
}

// A download that turned out to carry a FOMOD script: hand the wizard job to
// the renderer (its answers come back through fomod-complete, with the origin
// riding the engine session).
function forwardFomod(result, sourceLabel) {
  sendEvent({
    type: 'fomod-pending',
    job: {
      sessionId: result.sessionId, moduleXml: result.moduleXml,
      info: result.info, name: result.name, source: sourceLabel,
    },
  });
}

// engine.install result → array of installed mod records (empty for pendingFomod).
function installedMods(res) {
  if (res.pendingFomod) return [];
  return res.multi ? res.mods : [res];
}

const protocolArgs = () => {
  // Portable builds must register the on-disk exe, not the temp-extracted one.
  if (process.env.PORTABLE_EXECUTABLE_FILE) return { exe: process.env.PORTABLE_EXECUTABLE_FILE, args: [] };
  if (app.isPackaged) return { exe: process.execPath, args: [] };
  return { exe: process.execPath, args: [app.getAppPath()] };
};

async function handleNxm(rawUrl) {
  try {
    const link = nexus.parseNxm(rawUrl);
    const apiKey = nexusKey();
    if (!apiKey) throw new Error('A Nexus Mods API key is required. Add one in Settings.');
    sendEvent({ type: 'toast', message: `Nexus download requested (mod ${link.modId})…` });
    let info = null;
    try { info = await nexus.modInfo(link.modId, apiKey); } catch (_) {}
    // Authoritative filename from the file API — CDN URLs aren't reliable for it.
    let fileName = null;
    try { fileName = (await nexus.fileInfo(link.modId, link.fileId, apiKey)).file_name || null; } catch (_) {}
    const uri = await nexus.downloadLink(link, apiKey);
    const dest = await nexus.downloadToFile(uri, store.stagingDir, fileName, (got, total) => {
      sendEvent({ type: 'progress', label: info ? info.name : `mod ${link.modId}`, received: got, total });
    });
    try {
      // Same Nexus mod already installed? This is an update — replace in place
      // (all entries, when the archive holds several mods).
      const existing = store.mods.some((m) => m.origin && m.origin.type === 'nexus' && m.origin.modId === link.modId);
      const origin = { type: 'nexus', modId: link.modId, fileId: link.fileId, version: info ? info.version : null };
      const version = info ? info.version : null;
      if (existing) {
        const res = await engine.replaceOrigin({ type: 'nexus', modId: link.modId }, dest, origin, version);
        if (res.pendingFomod) {
          forwardFomod(res, info ? info.name : `mod ${link.modId}`);
        } else {
          const names = installedMods(res).map((m) => m.name).join('”, “');
          sendEvent({ type: 'toast', message: `Updated “${names}” to ${version ? 'v' + version : 'the latest version'}.` });
        }
      } else {
        const res = await engine.install(dest, { origin, version });
        if (res.pendingFomod) {
          forwardFomod(res, info ? info.name : `mod ${link.modId}`);
        } else {
          const mods = installedMods(res);
          if (mods.length === 1 && mods[0].id && info && info.name) {
            try { engine.rename(mods[0].id, info.name); } catch (_) {}
          }
          const label = mods.length === 1
            ? `Installed “${info && info.name ? info.name : mods[0].name}” from Nexus Mods.`
            : `Installed ${mods.length} mods from “${info && info.name ? info.name : path.basename(dest)}” — each is its own entry.`;
          sendEvent({ type: 'toast', message: label });
        }
      }
    } finally {
      fs.rmSync(dest, { force: true });
    }
    sendEvent({ type: 'state', state: fullState() });
  } catch (err) {
    sendEvent({ type: 'toast', kind: 'error', message: err.message });
  }
}

// ---------------------------------------------------------- update checks

async function checkForUpdates() {
  const results = { checked: 0, updates: 0, errors: [] };
  for (const mod of store.mods) {
    const origin = mod.origin;
    if (!origin || origin.type === 'local') continue;
    results.checked += 1;
    try {
      if (origin.type === 'nexus' && nexusKey()) {
        const info = await nexus.modInfo(origin.modId, nexusKey());
        const latest = info.version || null;
        if (latest && origin.version && latest !== origin.version) {
          mod.updateInfo = {
            available: true, latest, current: origin.version,
            auto: !!(nexusUser && nexusUser.isPremium), source: 'nexus',
            url: `https://www.nexusmods.com/${nexus.GAME_DOMAIN}/mods/${origin.modId}?tab=files`,
          };
          results.updates += 1;
        } else {
          mod.updateInfo = null;
        }
      } else if (origin.type === 'github') {
        const release = await github.latestReleaseFor(origin.repo);
        if (release && origin.tag && release.tag !== origin.tag) {
          mod.updateInfo = {
            available: true, latest: release.tag, current: origin.tag,
            auto: true, source: 'github',
            url: `https://github.com/${origin.repo}/releases`,
          };
          results.updates += 1;
        } else {
          mod.updateInfo = null;
        }
      }
    } catch (err) {
      results.errors.push(`${mod.name}: ${err.message}`);
    }
  }
  store.settings.lastUpdateCheck = new Date().toISOString();
  store.save();
  return results;
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 980,
    minHeight: 640,
    backgroundColor: '#05080f',
    autoHideMenuBar: true,
    title: 'Zero Company Mod Command',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadFile(path.join(__dirname, 'src', 'index.html'));
}

app.whenReady().then(() => {
  // Move a legacy plaintext Nexus key into the OS-encrypted store.
  try { migrateNexusKey(); } catch (_) {}
  try { eaAppDetected = ea.eaAppPresent(); } catch (_) {}
  // EA-compat community list: fetch now and refresh every 30 minutes; a state
  // push follows so freshly flagged mods surface without a restart.
  const refreshCompat = () => ea.refreshCompat().then(() => sendEvent({ type: 'state', state: fullState() })).catch(() => {});
  setTimeout(refreshCompat, 3000);
  setInterval(() => refreshCompat(), 30 * 60 * 1000);
  // Auto-detect game on first run.
  if (!store.settings.gamePath) {
    const det = steam.detectGame(null);
    if (det.found) {
      store.settings.gamePath = det.gamePath;
      store.save();
    }
  }
  createWindow();
  // Handle an nxm:// link this instance was launched with.
  const url = nxmFromArgv(process.argv);
  if (url) win.webContents.once('did-finish-load', () => handleNxm(url));
  // Launcher self-update banner.
  win.webContents.once('did-finish-load', async () => {
    const info = await checkLauncherUpdate();
    if (info.available) sendEvent({ type: 'launcher-update', info });
  });
  // Startup recovery: redeploy enabled mods whose deployed files went missing.
  win.webContents.once('did-finish-load', () => {
    if (!store.settings.gamePath) return;
    try {
      const repaired = engine.repairDeployments();
      if (repaired.length) {
        sendEvent({ type: 'state', state: fullState() });
        sendEvent({ type: 'toast', kind: 'warn', message: `Recovered missing deployed files for: ${repaired.join(', ')}.` });
      }
    } catch (_) {}
  });
  // Background update check, at most once per 12 hours.
  win.webContents.once('did-finish-load', async () => {
    const last = store.settings.lastUpdateCheck ? Date.parse(store.settings.lastUpdateCheck) : 0;
    if (Date.now() - last < 12 * 60 * 60 * 1000) return;
    if (!store.mods.some((m) => m.origin && m.origin.type !== 'local')) return;
    try {
      const results = await checkForUpdates();
      if (results.updates > 0) {
        sendEvent({ type: 'state', state: fullState() });
        sendEvent({ type: 'toast', kind: 'warn', message: `${results.updates} mod update(s) available — see the Hangar Bay.` });
      }
    } catch (_) {}
  });
});

app.on('window-all-closed', () => app.quit());

// ------------------------------------------------------------------ helpers

let nexusUser = null; // cached result of the last successful key validation
let eaAppDetected = false; // probed once at startup (reg.exe is too slow per-state)
const promotedCache = { mods: null, at: 0, authors: [] };

function fullState() {
  const detection = steam.detectGame(store.settings.gamePath);
  const ue4ssHooks = store.settings.gamePath ? engine.scanUe4ssHooks() : { entries: [], conflicts: [] };
  const conflicts = store.settings.gamePath ? engine.conflicts(ue4ssHooks) : [];
  const { exe, args } = protocolArgs();
  // Per-mod EA-compat verdicts from the last-fetched community list + modinfo.
  const compat = ea.compatSync();
  const modCompat = {};
  for (const m of store.mods) modCompat[m.id] = ea.evaluateMod(m, compat);
  return {
    settings: { ...store.settings, nexusApiKey: undefined, nexusApiKeyEncrypted: undefined, hasNexusKey: !!nexusKey() },
    profiles: store.profiles,
    lastOrderBackup: store.data.lastOrderBackup
      ? { at: store.data.lastOrderBackup.at }
      : null,
    nexus: {
      hasKey: !!nexusKey(),
      keyEncrypted: !!store.settings.nexusApiKeyEncrypted,
      user: nexusUser,
      nxmRegistered: app.isDefaultProtocolClient('nxm', exe, args),
    },
    detection: {
      found: detection.found,
      gamePath: detection.gamePath,
      buildId: detection.buildId,
      source: detection.source,
      launcher: detection.launcher,
      proton: detection.proton,
    },
    platform: process.platform,
    eaAppPresent: eaAppDetected,
    modCompat,
    ue4ssOrder: store.settings.gamePath ? engine.ue4ssOrderState() : { managed: [], others: [], applied: false },
    mods: store.mods,
    conflicts,
    ue4ssHooks,
    ue4ss: engine.ue4ssStatus(),
    retoc: engine.retocStatus(),
    sevenZip: !!findSevenZip(store.settings.sevenZipPath),
    appId: steam.APP_ID,
    paths: {
      mods: MODS_REL,
      logicMods: LOGIC_MODS_REL,
      win64: WIN64_REL,
      ue4ssMods: UE4SS_MODS_REL,
      library: store.libraryDir,
    },
  };
}

function ok(data) { return { ok: true, data }; }
function fail(err) { return { ok: false, error: err && err.message ? err.message : String(err) }; }

const handlers = {
  'get-state': async () => fullState(),

  'browse-game-path': async () => {
    const res = await dialog.showOpenDialog(win, {
      title: 'Locate the Star Wars Zero Company folder',
      properties: ['openDirectory'],
      defaultPath: store.settings.gamePath || 'G:\\SteamLibrary\\steamapps\\common',
    });
    if (res.canceled || !res.filePaths.length) return fullState();
    const p = res.filePaths[0];
    if (!steam.isValidGamePath(p)) {
      throw new Error('That folder does not contain SWZeroCompany\\Binaries\\Win64\\SWZeroCompany.exe.');
    }
    store.settings.gamePath = p;
    store.save();
    return fullState();
  },

  'browse-tool-path': async (_e, { key, title, filterName }) => {
    const res = await dialog.showOpenDialog(win, {
      title,
      properties: ['openFile'],
      filters: [{ name: filterName, extensions: ['exe'] }],
    });
    if (!res.canceled && res.filePaths.length) {
      store.settings[key] = res.filePaths[0];
      store.save();
    }
    return fullState();
  },

  'save-settings': async (_e, patch) => {
    delete patch.promotedAuthors; // owner-controlled (lib/featured.js), not a user setting
    Object.assign(store.settings, patch);
    store.save();
    return fullState();
  },

  'install-mods': async () => {
    const res = await dialog.showOpenDialog(win, {
      title: 'Install mods (archives or extracted folders)',
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: 'Mod archives', extensions: ['zip', '7z', 'rar', 'pak', 'utoc', 'ucas'] },
        { name: 'All files', extensions: ['*'] },
      ],
    });
    if (res.canceled || !res.filePaths.length) return { state: fullState(), results: [] };
    return installPaths(res.filePaths);
  },

  'install-folder': async () => {
    const res = await dialog.showOpenDialog(win, {
      title: 'Install a mod from an extracted folder',
      properties: ['openDirectory'],
    });
    if (res.canceled || !res.filePaths.length) return { state: fullState(), results: [] };
    return installPaths(res.filePaths);
  },

  'install-dropped': async (_e, paths) => installPaths(paths),

  'set-mod-enabled': async (_e, { id, enabled, force }) => { engine.setEnabled(id, enabled, force); return fullState(); },
  'uninstall-mod': async (_e, { id, force }) => { engine.uninstall(id, force); return fullState(); },
  'rename-mod': async (_e, { id, name }) => { engine.rename(id, name); return fullState(); },
  'apply-load-order': async (_e, { orderedIds }) => { engine.applyLoadOrder(orderedIds); return fullState(); },
  'preview-load-order': async (_e, { orderedIds }) => engine.previewLoadOrder(orderedIds),
  'rollback-load-order': async () => { engine.rollbackLoadOrder(); return fullState(); },
  'apply-ue4ss-order': async (_e, { orderedIds }) => { engine.applyUe4ssOrder(orderedIds); return fullState(); },
  'confirm-mod-build': async (_e, { id }) => { engine.confirmBuild(id); return fullState(); },

  'fomod-complete': async (_e, { sessionId, selections }) => {
    const mod = await engine.completeFomod(sessionId, selections);
    return { state: fullState(), name: mod.name, modType: mod.modType, warnings: mod.warnings || [] };
  },
  'fomod-cancel': async (_e, { sessionId }) => { engine.cancelFomod(sessionId); return true; },
  'fomod-image': async (_e, { sessionId, path: rel }) => {
    const session = engine.fomodSession(sessionId);
    const fomod = require('./lib/fomod');
    return fomod.readImage(session.root, session.fomodBase, rel);
  },

  'launch-game': async () => {
    const detection = steam.detectGame(store.settings.gamePath);
    if (!detection.found) throw new Error('Game not located. Set the game folder in Settings.');
    if (detection.launcher === 'ea') {
      // EA App edition: no steam:// route. Launch the exe directly (the EA App
      // background service handles online features when it is running).
      if (process.platform !== 'win32') throw new Error('The EA App edition can only be launched on Windows.');
      const child = spawn(detection.exePath, [], { detached: true, stdio: 'ignore', cwd: path.dirname(detection.exePath) });
      child.unref();
    } else {
      // Prefer a Steam launch so overlay/cloud saves work (also correct under
      // Proton on Linux/Steam Deck — Steam applies the configured launch options).
      await shell.openExternal(`steam://run/${steam.APP_ID}`);
    }
    if (store.settings.closeOnLaunch) setTimeout(() => app.quit(), 1500);
    return fullState();
  },

  'launch-game-direct': async () => {
    const detection = steam.detectGame(store.settings.gamePath);
    if (!detection.found) throw new Error('Game not located. Set the game folder in Settings.');
    if (process.platform === 'linux') {
      throw new Error('The game is a Windows build — on Linux, launch it through Steam (Proton) instead.');
    }
    const child = spawn(detection.exePath, [], { detached: true, stdio: 'ignore', cwd: path.dirname(detection.exePath) });
    child.unref();
    if (store.settings.closeOnLaunch) setTimeout(() => app.quit(), 1500);
    return fullState();
  },

  'open-managed-path': async (_e, { kind }) => {
    const map = {
      game: store.settings.gamePath,
      mods: store.settings.gamePath && path.join(store.settings.gamePath, MODS_REL),
      logicMods: store.settings.gamePath && path.join(store.settings.gamePath, LOGIC_MODS_REL),
      ue4ssMods: store.settings.gamePath && path.join(store.settings.gamePath, UE4SS_MODS_REL),
      library: store.libraryDir,
      data: store.dataDir,
    };
    const p = map[kind];
    if (!p || !fs.existsSync(p)) throw new Error('That folder does not exist yet.');
    await shell.openPath(p);
    return true;
  },

  'open-external': async (_e, { url }) => {
    if (!/^https:\/\/(www\.)?(nexusmods\.com|github\.com|discord\.gg)\//.test(url)) throw new Error('Blocked URL.');
    await shell.openExternal(url);
    return true;
  },

  'launcher-update-status': async () => checkLauncherUpdate(),

  'run-diagnostics': async () => diagnostics(),

  'suggest-load-order': async () => engine.suggestLoadOrder(),

  'save-profile': async (_e, { name }) => { engine.saveProfile(name); return fullState(); },
  'apply-profile': async (_e, { id }) => {
    const { profile, warnings } = engine.applyProfile(id);
    return { state: fullState(), profileName: profile.name, warnings };
  },
  'delete-profile': async (_e, { id }) => { engine.deleteProfile(id); return fullState(); },

  'set-nexus-key': async (_e, { key }) => {
    const trimmed = (key || '').trim();
    if (!trimmed) throw new Error('The API key is empty.');
    const user = await nexus.validateKey(trimmed); // throws on a bad key
    storeNexusKey(trimmed);
    nexusUser = user;
    return fullState();
  },
  'clear-nexus-key': async () => {
    store.settings.nexusApiKey = null;
    store.settings.nexusApiKeyEncrypted = null;
    store.save();
    nexusUser = null;
    return fullState();
  },
  'validate-nexus-key': async () => {
    if (!nexusKey()) throw new Error('A Nexus Mods API key is required. Add one in Settings.');
    nexusUser = await nexus.validateKey(nexusKey());
    return fullState();
  },
  'register-nxm': async () => {
    const { exe, args } = protocolArgs();
    if (process.platform === 'linux') {
      // Linux: a .desktop entry with the nxm scheme handler, made default via xdg-mime.
      const { execFileSync } = require('child_process');
      const appsDir = path.join(app.getPath('home'), '.local', 'share', 'applications');
      fs.mkdirSync(appsDir, { recursive: true });
      const target = process.env.APPIMAGE || exe;
      const desktop = [
        '[Desktop Entry]', 'Type=Application', 'Name=Zero Company Mod Command',
        `Exec="${target}" %u`, 'Terminal=false', 'NoDisplay=true',
        'MimeType=x-scheme-handler/nxm;', '',
      ].join('\n');
      fs.writeFileSync(path.join(appsDir, 'zero-company-mod-command.desktop'), desktop);
      try { execFileSync('xdg-mime', ['default', 'zero-company-mod-command.desktop', 'x-scheme-handler/nxm'], { stdio: 'ignore' }); } catch (_) {}
      try { execFileSync('update-desktop-database', [appsDir], { stdio: 'ignore' }); } catch (_) {}
      app.setAsDefaultProtocolClient('nxm');
      return fullState();
    }
    const okReg = app.setAsDefaultProtocolClient('nxm', exe, args);
    if (!okReg) throw new Error('Windows refused the nxm:// handler registration.');
    // Friendly name for browser "Open …?" dialogs (AssocQueryString checks the
    // FriendlyAppName value before falling back to exe metadata).
    try {
      const { execFileSync } = require('child_process');
      const set = (key, value, data) => execFileSync('reg',
        ['add', key, ...(value ? ['/v', value] : ['/ve']), '/d', data, '/f'], { stdio: 'ignore' });
      // Browser "Open …?" dialogs pull the name from these (which one varies by
      // browser/version) or from the exe's FileDescription.
      set('HKCU\\Software\\Classes\\nxm', null, 'URL:Mod Command Link');
      set('HKCU\\Software\\Classes\\nxm', 'FriendlyTypeName', 'in Mod Command');
      set('HKCU\\Software\\Classes\\nxm\\shell\\open', 'FriendlyAppName', 'in Mod Command');
      set('HKCU\\Software\\Classes\\nxm\\shell\\open\\command', 'FriendlyAppName', 'in Mod Command');
      set('HKCU\\Software\\Classes\\nxm\\Application', 'ApplicationName', 'in Mod Command');
      set('HKCU\\Software\\Classes\\nxm\\Application', 'ApplicationDescription', 'Zero Company Mod Command');
    } catch (_) { /* cosmetic only */ }
    return fullState();
  },
  'unregister-nxm': async () => {
    const { exe, args } = protocolArgs();
    app.removeAsDefaultProtocolClient('nxm', exe, args);
    return fullState();
  },

  'nexus-browse': async (_e, opts) => {
    const result = await nexus.browseMods(opts || {});
    // Premium accounts can pull download links straight from the API.
    if (nexusKey() && !nexusUser) {
      try { nexusUser = await nexus.validateKey(nexusKey()); } catch (_) {}
    }
    return { ...result, hasKey: !!nexusKey(), isPremium: !!(nexusUser && nexusUser.isPremium) };
  },

  'nexus-promoted': async () => {
    // Session cache — the featured pool rarely changes.
    const now = Date.now();
    if (promotedCache.mods && now - promotedCache.at < 5 * 60 * 1000) return promotedCache;
    const roster = await getPromotedAuthors();
    const mods = await nexus.modsByAuthors(roster);
    // When the roster can't fill all 3 slots, backfill from the game's top mods.
    let fillers = [];
    if (mods.length < 3) {
      try {
        const top = await nexus.browseMods({ sort: 'downloads', count: 12 });
        const promotedIds = new Set(mods.map((m) => m.modId));
        fillers = top.mods.filter((m) => !promotedIds.has(m.modId));
      } catch (_) { /* strip just shows what it has */ }
    }
    Object.assign(promotedCache, { mods, fillers, at: now, authors: roster });
    return promotedCache;
  },

  'nexus-install-remote': async (_e, { modId, name }) => {
    const apiKey = nexusKey();
    if (!apiKey) throw new Error('A Nexus Mods API key is required. Add one in Settings.');
    if (!nexusUser) {
      try { nexusUser = await nexus.validateKey(apiKey); } catch (err) { throw new Error(err.message); }
    }
    if (!nexusUser.isPremium) {
      // Nexus policy: non-premium downloads must start on the website. The
      // "Mod Manager Download" button sends an nxm:// link straight back to us.
      await shell.openExternal(`https://www.nexusmods.com/${nexus.GAME_DOMAIN}/mods/${modId}?tab=files`);
      return { opened: 'website' };
    }
    const files = await nexus.filesList(modId, apiKey);
    const file = nexus.pickPrimaryFile(files);
    if (!file) throw new Error('That mod has no downloadable main file.');
    const uri = await nexus.downloadLink({ modId, fileId: file.file_id }, apiKey);
    const dest = await nexus.downloadToFile(uri, store.stagingDir, file.file_name, (got, total) => {
      sendEvent({ type: 'progress', label: name || `mod ${modId}`, received: got, total });
    });
    try {
      const origin = { type: 'nexus', modId, fileId: file.file_id, version: file.version || null };
      const res = await engine.install(dest, { origin, version: file.version || null });
      if (res.pendingFomod) {
        forwardFomod(res, name || `mod ${modId}`);
        return { pendingFomod: true, state: fullState() };
      }
      const mods = installedMods(res);
      if (mods.length === 1 && mods[0].id && name) {
        try { engine.rename(mods[0].id, name); } catch (_) {}
      }
      return { installed: true, count: mods.length, state: fullState() };
    } finally {
      fs.rmSync(dest, { force: true });
    }
  },

  'config-list': async () =>
    configs.listConfigFiles(store.settings.gamePath, store.settings.customConfigFiles || []),

  'config-read': async (_e, { path: filePath }) => ({
    content: configs.readConfig(filePath, store.settings.gamePath, store.settings.customConfigFiles || []),
  }),

  'config-save': async (_e, { path: filePath, content }) => {
    const result = configs.saveConfig(filePath, content, store.settings.gamePath, store.settings.customConfigFiles || []);
    return { ...result, list: configs.listConfigFiles(store.settings.gamePath, store.settings.customConfigFiles || []) };
  },

  'config-add-custom': async () => {
    const res = await dialog.showOpenDialog(win, {
      title: 'Add a config file to the Datapad',
      properties: ['openFile'],
      filters: [
        { name: 'Config files', extensions: ['ini', 'json', 'txt', 'cfg'] },
        { name: 'All files', extensions: ['*'] },
      ],
    });
    if (!res.canceled && res.filePaths.length) {
      const custom = store.settings.customConfigFiles || [];
      const p = res.filePaths[0];
      if (!custom.some((c) => path.resolve(c).toLowerCase() === path.resolve(p).toLowerCase())) {
        custom.push(p);
        store.settings.customConfigFiles = custom;
        store.save();
      }
    }
    return configs.listConfigFiles(store.settings.gamePath, store.settings.customConfigFiles || []);
  },

  'config-remove-custom': async (_e, { path: filePath }) => {
    store.settings.customConfigFiles = (store.settings.customConfigFiles || [])
      .filter((c) => path.resolve(c).toLowerCase() !== path.resolve(filePath).toLowerCase());
    store.save();
    return configs.listConfigFiles(store.settings.gamePath, store.settings.customConfigFiles || []);
  },

  'config-open-folder': async (_e, { path: filePath }) => {
    await shell.showItemInFolder(filePath);
    return true;
  },

  'scan-unmanaged': async () => engine.scanUnmanaged(),

  'adopt-mods': async (_e, { ids }) => {
    const candidates = engine.scanUnmanaged().filter((c) => ids.includes(c.id));
    const results = [];
    for (const candidate of candidates) {
      try {
        const mod = engine.adopt(candidate);
        let identified = null;
        // Try to reattach a Nexus identity via md5 (only matches files that were
        // uploaded to Nexus as-is; extracted contents usually won't).
        if (nexusKey() && mod.modType !== 'ue4ss-mod') {
          for (const f of mod.files.slice(0, 4)) {
            try {
              const hit = await nexus.md5Lookup(
                path.join(store.modLibraryDir(mod.id), f.libraryRelative), nexusKey());
              if (hit) {
                engine.setOrigin(mod.id, { type: 'nexus', modId: hit.modId, fileId: hit.fileId, version: hit.version, adopted: true });
                const stored = store.getMod(mod.id);
                stored.version = hit.version;
                if (hit.modName) { try { engine.rename(mod.id, hit.modName); } catch (_) {} }
                store.save();
                identified = hit;
                break;
              }
            } catch (_) {}
          }
        }
        results.push({ ok: true, name: store.getMod(mod.id).name, identified: identified ? identified.modName : null });
      } catch (err) {
        results.push({ ok: false, name: candidate.name, error: err.message });
      }
    }
    return { results, state: fullState() };
  },

  'link-origin': async (_e, { id, type, ref }) => {
    const mod = store.getMod(id);
    if (!mod) throw new Error('That mod is no longer installed.');
    if (type === 'nexus') {
      const m = String(ref).match(/mods\/(\d+)/) || String(ref).match(/^(\d+)$/);
      if (!m) throw new Error('Enter a Nexus mod ID or mod page URL.');
      const modId = Number(m[1]);
      if (!nexusKey()) throw new Error('A Nexus Mods API key is required. Add one in Settings.');
      const info = await nexus.modInfo(modId, nexusKey());
      // Assume the installed copy is current; future version bumps get flagged.
      engine.setOrigin(id, { type: 'nexus', modId, fileId: null, version: info.version || null, linked: true });
      const stored = store.getMod(id);
      stored.version = info.version || null;
      store.save();
      return { linked: info.name || `mod ${modId}`, state: fullState() };
    }
    if (type === 'github') {
      if (!/^[\w.-]+\/[\w.-]+$/.test(String(ref))) throw new Error('Pick a repository from the curated list.');
      const release = await github.latestReleaseFor(String(ref));
      engine.setOrigin(id, { type: 'github', repo: String(ref), tag: release ? release.tag : null, linked: true });
      const stored = store.getMod(id);
      if (release) { stored.version = release.tag; store.save(); }
      return { linked: String(ref), state: fullState() };
    }
    throw new Error('Unknown source type.');
  },

  'github-browse': async (_e, opts) => github.listCurated(opts || {}),

  'github-install': async (_e, { fullName }) => {
    const release = await github.latestReleaseFor(fullName);
    if (!release) throw new Error('That repository has no installable release.');
    const choice = await dialog.showMessageBox(win, {
      type: 'warning',
      buttons: ['Install', 'Cancel'],
      defaultId: 0,
      cancelId: 1,
      title: 'Install from GitHub?',
      message: `Install ${release.assetName} (${(release.size / 1048576).toFixed(1)} MB)?`,
      detail: `From ${fullName} — release ${release.tag}.\n\nGitHub mods aren't moderated. This repo is on the curated list, but install only from authors you trust.`,
    });
    if (choice.response !== 0) return { cancelled: true };
    const dest = await nexus.downloadToFile(release.assetUrl, store.stagingDir, release.assetName, (got, total) => {
      sendEvent({ type: 'progress', label: fullName, received: got, total });
    });
    try {
      const res = await engine.install(dest, {
        origin: { type: 'github', repo: fullName, tag: release.tag },
        version: release.tag,
      });
      if (res.pendingFomod) {
        forwardFomod(res, fullName);
        return { pendingFomod: true, state: fullState() };
      }
      return { installed: true, count: installedMods(res).length, state: fullState() };
    } finally {
      fs.rmSync(dest, { force: true });
    }
  },

  'check-updates': async () => {
    const results = await checkForUpdates();
    return { results, state: fullState() };
  },

  'update-mod': async (_e, { id }) => {
    const mod = store.getMod(id);
    if (!mod || !mod.updateInfo || !mod.updateInfo.available) throw new Error('No update is available for that mod.');
    const origin = mod.origin;
    if (origin.type === 'github') {
      const release = await github.latestReleaseFor(origin.repo);
      if (!release) throw new Error('The new release has no installable archive.');
      const dest = await nexus.downloadToFile(release.assetUrl, store.stagingDir, release.assetName, (got, total) => {
        sendEvent({ type: 'progress', label: mod.name, received: got, total });
      });
      try {
        const res = await engine.replaceOrigin(
          { type: 'github', repo: origin.repo }, dest,
          { type: 'github', repo: origin.repo, tag: release.tag }, release.tag);
        if (res.pendingFomod) { forwardFomod(res, mod.name); return { pendingFomod: true, state: fullState() }; }
      } finally {
        fs.rmSync(dest, { force: true });
      }
      return { updated: true, state: fullState() };
    }
    if (origin.type === 'nexus') {
      if (nexusUser && nexusUser.isPremium) {
        const files = await nexus.filesList(origin.modId, nexusKey());
        const file = nexus.pickPrimaryFile(files);
        if (!file) throw new Error('The updated mod has no downloadable main file.');
        const uri = await nexus.downloadLink({ modId: origin.modId, fileId: file.file_id }, nexusKey());
        const dest = await nexus.downloadToFile(uri, store.stagingDir, file.file_name, (got, total) => {
          sendEvent({ type: 'progress', label: mod.name, received: got, total });
        });
        try {
          const newVersion = file.version || mod.updateInfo.latest;
          const res = await engine.replaceOrigin(
            { type: 'nexus', modId: origin.modId }, dest,
            { type: 'nexus', modId: origin.modId, fileId: file.file_id, version: newVersion }, newVersion);
          if (res.pendingFomod) { forwardFomod(res, mod.name); return { pendingFomod: true, state: fullState() }; }
        } finally {
          fs.rmSync(dest, { force: true });
        }
        return { updated: true, state: fullState() };
      }
      // Free account: route through the website; the nxm link replaces in place.
      await shell.openExternal(mod.updateInfo.url);
      return { opened: 'website' };
    }
    throw new Error('That mod has no update source.');
  },

  'install-ue4ss': async () => {
    if (!store.settings.gamePath) throw new Error('Locate the game folder in Settings first.');
    const asset = await ue4ssDl.latestRuntime();
    sendEvent({ type: 'toast', message: `Downloading ${asset.name} (${(asset.size / 1048576).toFixed(1)} MB) from GitHub…` });
    const dest = await nexus.downloadToFile(asset.url, store.stagingDir, asset.name, (got, total) => {
      sendEvent({ type: 'progress', label: 'UE4SS runtime', received: got, total });
    });
    try {
      const result = await engine.install(dest);
      if (result.modType !== 'ue4ss-runtime') {
        throw new Error('The downloaded archive did not contain a UE4SS runtime layout.');
      }
    } finally {
      fs.rmSync(dest, { force: true });
    }
    return { state: fullState(), version: asset.releaseName };
  },
};

async function installPaths(paths) {
  const results = [];
  for (const p of paths) {
    try {
      const res = await engine.install(p);
      if (res.pendingFomod) {
        // The renderer runs the guided steps and finishes via fomod-complete.
        results.push({
          source: path.basename(p), ok: true, pendingFomod: true,
          sessionId: res.sessionId, moduleXml: res.moduleXml, info: res.info, name: res.name,
        });
        continue;
      }
      for (const mod of installedMods(res)) {
        results.push({ source: path.basename(p), ok: true, name: mod.name, modType: mod.modType, warnings: mod.warnings || [] });
      }
      if (res.multi) {
        for (const e of res.errors || []) results.push({ source: path.basename(p), ok: false, error: e });
        results.push({
          source: path.basename(p), ok: true, note: true,
          name: path.basename(p), modType: 'multi',
          message: `${res.mods.length} mods found in one archive — each installed as its own entry.`,
        });
      }
    } catch (err) {
      results.push({ source: path.basename(p), ok: false, error: err.message });
    }
  }
  return { state: fullState(), results };
}

function diagnostics() {
  const items = [];
  const add = (level, title, message) => items.push({ level, title, message });
  // Pick up asset lists for IoStore mods installed while retoc was unavailable.
  try {
    const rescanned = engine.refreshPackages();
    if (rescanned) add('info', 'Package scan', `Scanned asset lists for ${rescanned} previously unscanned mod(s).`);
  } catch (_) {}
  const detection = steam.detectGame(store.settings.gamePath);
  if (detection.found) {
    add('good', 'Game installation', `Valid Zero Company layout at ${detection.gamePath}`);
    const launcherLabel = { steam: 'Steam', ea: 'EA App', manual: 'manual / unknown' }[detection.launcher] || 'unknown';
    add(detection.launcher === 'manual' ? 'info' : 'good', 'Game launcher',
      `${launcherLabel} edition${detection.launcher === 'ea' ? (eaAppDetected ? ' (EA App detected on this system)' : ' (EA App itself not detected — launches go directly to the exe)') : ''}`);
    if (detection.manifest) {
      add('good', 'Steam manifest', `Build ID ${detection.buildId}`);
    } else {
      add(detection.buildId ? 'info' : 'warning', 'Game build',
        detection.buildId
          ? `No Steam manifest — tracking the game build by exe fingerprint (${detection.buildId}).`
          : 'Build identity unavailable — compatibility cannot be assessed.');
    }
    // Mods installed under a different game build than the one on disk now.
    const stale = store.mods.filter((m) => m.installedBuild && detection.buildId && m.installedBuild !== detection.buildId);
    if (stale.length) {
      add('warning', 'Game build changed',
        `${stale.length} mod(s) were installed under a different game build and may be incompatible: ` +
        `${stale.map((m) => m.name).join(', ')}. If a mod still works, use its build chip in the Hangar Bay to mark it verified.`);
    } else if (detection.buildId) {
      add('good', 'Game build', 'Every mod was installed (or verified) under the current game build.');
    }
    // EA App compatibility flags.
    const compat = ea.compatSync();
    const flagged = store.mods
      .map((m) => ({ m, v: ea.evaluateMod(m, compat) }))
      .filter((x) => x.v.status === 'incompatible');
    if (detection.launcher === 'ea') {
      const active = flagged.filter((x) => x.m.enabled);
      if (active.length) {
        for (const { m, v } of active) {
          add('warning', 'EA compatibility', `"${m.name}" is flagged as not working on the EA App edition (${v.source === 'modinfo' ? 'per its author' : 'community report'}${v.note ? `: ${v.note}` : ''}).`);
        }
      } else {
        add('good', 'EA compatibility', flagged.length
          ? `No enabled mod is flagged EA-incompatible (${flagged.length} disabled mod(s) are).`
          : 'No installed mod is flagged as EA-incompatible.');
      }
    } else if (flagged.length) {
      add('info', 'EA compatibility', `${flagged.length} installed mod(s) are flagged as Steam-only — relevant if you share your setup with EA App players: ${flagged.map((x) => x.m.name).join(', ')}.`);
    }
    const modsDir = path.join(detection.gamePath, MODS_REL);
    add(fs.existsSync(modsDir) ? 'good' : 'info', '~mods folder',
      fs.existsSync(modsDir) ? 'Present' : 'Created on first packaged-mod install');
  } else {
    add('error', 'Game installation', 'Not detected. Locate the game folder in Settings (Steam and EA App installs are both scanned).');
  }
  // Linux / Proton / Steam Deck.
  if (process.platform === 'linux') {
    const compatdata = detection.proton && detection.proton.compatdata;
    add(compatdata ? 'good' : 'warning', 'Proton prefix',
      compatdata
        ? `Compat prefix present (${compatdata}).`
        : 'No compatdata prefix for the game yet — run the game once through Steam to create it.');
    const ue4ssState = engine.ue4ssStatus();
    if (ue4ssState.installed) {
      add('info', 'Proton DLL override',
        'UE4SS needs its loader DLL to win over the built-in one under Proton. In Steam → Zero Company → Properties → Launch Options, set: WINEDLLOVERRIDES="dwmapi=n,b" %command% (the manager never edits launch options itself).');
    }
    add('info', 'Steam Deck', 'On Steam Deck, run the manager in Desktop Mode; mods deployed here work in Gaming Mode.');
  }
  const ue4ss = engine.ue4ssStatus();
  add(ue4ss.healthy ? 'good' : (ue4ss.installed ? 'warning' : 'info'), 'UE4SS runtime', ue4ss.message);
  const retoc = engine.retocStatus();
  add(retoc.found ? 'good' : 'info', 'retoc',
    retoc.found ? `Found at ${retoc.path}${retoc.version ? ` (${retoc.version})` : ''}` : 'Not found (optional — used for IoStore package inspection).');
  add(findSevenZip(store.settings.sevenZipPath) ? 'good' : 'info', '7-Zip',
    findSevenZip(store.settings.sevenZipPath) ? 'Available for .7z/.rar archives' : 'Not found — only .zip archives can be installed.');
  const missing = store.settings.gamePath ? engine.auditDeployedFiles() : [];
  if (missing.length) {
    add('warning', 'Deployed files', `${missing.length} deployed file(s) are missing: ${missing.map((m) => m.file).join(', ')}`);
  } else {
    add('good', 'Deployed files', 'All enabled mods are fully deployed.');
  }
  const duplicates = store.settings.gamePath ? engine.scanDuplicateMods() : [];
  if (duplicates.length) {
    for (const dup of duplicates) {
      const list = dup.members
        .map((m) => `"${m.folder}" (${m.managed ? 'managed' : 'unmanaged'})`)
        .join(' and ');
      add('warning', 'Duplicate mod',
        `The same mod is active under ${dup.members.length} folders: ${list}. ` +
        `Both load at once (double hooks/loops) and can cause frame stutter — keep one and disable/delete the rest.`);
    }
  } else if (store.settings.gamePath) {
    add('good', 'Duplicate mods', 'No mod is installed under more than one active folder.');
  }
  const hookReport = store.settings.gamePath ? engine.scanUe4ssHooks() : { entries: [], conflicts: [] };
  const conflicts = store.settings.gamePath ? engine.conflicts(hookReport) : [];
  const confirmed = conflicts.filter((c) => c.certainty === 'confirmed').length;
  add(conflicts.length ? 'warning' : 'good', 'Conflicts',
    conflicts.length
      ? `${conflicts.length} conflicting mod pair(s) (${confirmed} confirmed by asset overlap) — details below.`
      : 'No incompatibilities detected between enabled mods.');
  if (hookReport.entries.length) {
    const totalHooks = hookReport.entries.reduce((n, e) => n + e.hooks.length, 0);
    const totalKeys = hookReport.entries.reduce((n, e) => n + e.keybinds.length, 0);
    add(hookReport.conflicts.length ? 'warning' : 'good', 'UE4SS hooks',
      hookReport.conflicts.length
        ? `${hookReport.conflicts.length} shared hook/keybind target(s) across active UE4SS mods — see the hook report below.`
        : `${hookReport.entries.length} active UE4SS mod(s) scanned (${totalHooks} hooks, ${totalKeys} keybinds) — no shared targets.`);
  }
  return { items, generatedAt: new Date().toISOString() };
}

for (const [channel, fn] of Object.entries(handlers)) {
  ipcMain.handle(channel, async (event, payload) => {
    try {
      return ok(await fn(event, payload));
    } catch (err) {
      return fail(err);
    }
  });
}

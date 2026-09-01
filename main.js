'use strict';
const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
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
const { checkLauncherUpdate } = require('./lib/launcher-update');

// Data lives next to the portable exe, or in ./data when running from source.
function resolveDataDir() {
  if (process.env.PORTABLE_EXECUTABLE_DIR) {
    return path.join(process.env.PORTABLE_EXECUTABLE_DIR, 'ZeroCompanyModCommand-data');
  }
  if (app.isPackaged) return path.join(app.getPath('userData'), 'data');
  return path.join(__dirname, 'data');
}

const store = new Store(resolveDataDir());
const engine = new ModEngine(store);
let win = null;

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

const protocolArgs = () => {
  // Portable builds must register the on-disk exe, not the temp-extracted one.
  if (process.env.PORTABLE_EXECUTABLE_FILE) return { exe: process.env.PORTABLE_EXECUTABLE_FILE, args: [] };
  if (app.isPackaged) return { exe: process.execPath, args: [] };
  return { exe: process.execPath, args: [app.getAppPath()] };
};

async function handleNxm(rawUrl) {
  try {
    const link = nexus.parseNxm(rawUrl);
    const apiKey = store.settings.nexusApiKey;
    if (!apiKey) throw new Error('A Nexus Mods API key is required. Add one in Settings.');
    sendEvent({ type: 'toast', message: `Nexus download requested (mod ${link.modId})…` });
    let info = null;
    try { info = await nexus.modInfo(link.modId, apiKey); } catch (_) {}
    const uri = await nexus.downloadLink(link, apiKey);
    const dest = await nexus.downloadToFile(uri, store.stagingDir, null, (got, total) => {
      sendEvent({ type: 'progress', label: info ? info.name : `mod ${link.modId}`, received: got, total });
    });
    try {
      // Same Nexus mod already installed? This is an update — replace in place.
      const existing = store.mods.find((m) => m.origin && m.origin.type === 'nexus' && m.origin.modId === link.modId);
      const origin = { type: 'nexus', modId: link.modId, fileId: link.fileId, version: info ? info.version : null };
      if (existing) {
        const mod = await engine.replaceInPlace(existing.id, dest);
        if (mod.id) {
          const stored = store.getMod(mod.id);
          stored.origin = origin;
          stored.version = info ? info.version : null;
          store.save();
        }
        sendEvent({ type: 'toast', message: `Updated “${mod.name}” to ${info && info.version ? 'v' + info.version : 'the latest version'}.` });
      } else {
        const mod = await engine.install(dest);
        if (mod.id) {
          if (info && info.name) { try { engine.rename(mod.id, info.name); } catch (_) {} }
          const stored = store.getMod(mod.id);
          if (stored) {
            stored.version = info ? info.version : null;
            stored.origin = origin;
            store.save();
          }
        }
        sendEvent({ type: 'toast', message: `Installed “${info && info.name ? info.name : path.basename(dest)}” from Nexus Mods.` });
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
      if (origin.type === 'nexus' && store.settings.nexusApiKey) {
        const info = await nexus.modInfo(origin.modId, store.settings.nexusApiKey);
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
const promotedCache = { mods: null, at: 0, authors: [] };

function fullState() {
  const detection = steam.detectGame(store.settings.gamePath);
  const ue4ssHooks = store.settings.gamePath ? engine.scanUe4ssHooks() : { entries: [], conflicts: [] };
  const conflicts = store.settings.gamePath ? engine.conflicts(ue4ssHooks) : [];
  const { exe, args } = protocolArgs();
  return {
    settings: { ...store.settings, nexusApiKey: undefined, hasNexusKey: !!store.settings.nexusApiKey },
    profiles: store.profiles,
    nexus: {
      hasKey: !!store.settings.nexusApiKey,
      user: nexusUser,
      nxmRegistered: app.isDefaultProtocolClient('nxm', exe, args),
    },
    detection: {
      found: detection.found,
      gamePath: detection.gamePath,
      buildId: detection.buildId,
      source: detection.source,
    },
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

  'set-mod-enabled': async (_e, { id, enabled }) => { engine.setEnabled(id, enabled); return fullState(); },
  'uninstall-mod': async (_e, { id }) => { engine.uninstall(id); return fullState(); },
  'rename-mod': async (_e, { id, name }) => { engine.rename(id, name); return fullState(); },
  'apply-load-order': async (_e, { orderedIds }) => { engine.applyLoadOrder(orderedIds); return fullState(); },

  'launch-game': async () => {
    const detection = steam.detectGame(store.settings.gamePath);
    if (!detection.found) throw new Error('Game not located. Set the game folder in Settings.');
    // Prefer a Steam launch so overlay/cloud saves work.
    await shell.openExternal(`steam://run/${steam.APP_ID}`);
    if (store.settings.closeOnLaunch) setTimeout(() => app.quit(), 1500);
    return fullState();
  },

  'launch-game-direct': async () => {
    const detection = steam.detectGame(store.settings.gamePath);
    if (!detection.found) throw new Error('Game not located. Set the game folder in Settings.');
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
    store.settings.nexusApiKey = trimmed;
    store.save();
    nexusUser = user;
    return fullState();
  },
  'clear-nexus-key': async () => {
    store.settings.nexusApiKey = null;
    store.save();
    nexusUser = null;
    return fullState();
  },
  'validate-nexus-key': async () => {
    if (!store.settings.nexusApiKey) throw new Error('A Nexus Mods API key is required. Add one in Settings.');
    nexusUser = await nexus.validateKey(store.settings.nexusApiKey);
    return fullState();
  },
  'register-nxm': async () => {
    const { exe, args } = protocolArgs();
    const okReg = app.setAsDefaultProtocolClient('nxm', exe, args);
    if (!okReg) throw new Error('Windows refused the nxm:// handler registration.');
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
    if (store.settings.nexusApiKey && !nexusUser) {
      try { nexusUser = await nexus.validateKey(store.settings.nexusApiKey); } catch (_) {}
    }
    return { ...result, hasKey: !!store.settings.nexusApiKey, isPremium: !!(nexusUser && nexusUser.isPremium) };
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
    const apiKey = store.settings.nexusApiKey;
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
      const mod = await engine.install(dest);
      if (mod.id) {
        if (name) { try { engine.rename(mod.id, name); } catch (_) {} }
        const stored = store.getMod(mod.id);
        if (stored) {
          stored.version = file.version || null;
          stored.origin = { type: 'nexus', modId, fileId: file.file_id, version: file.version || null };
          store.save();
        }
      }
    } finally {
      fs.rmSync(dest, { force: true });
    }
    return { installed: true, state: fullState() };
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
      const mod = await engine.install(dest);
      if (mod.id) {
        const stored = store.getMod(mod.id);
        stored.origin = { type: 'github', repo: fullName, tag: release.tag };
        stored.version = release.tag;
        store.save();
      }
    } finally {
      fs.rmSync(dest, { force: true });
    }
    return { installed: true, state: fullState() };
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
        const updated = await engine.replaceInPlace(id, dest);
        const stored = store.getMod(updated.id);
        stored.origin = { type: 'github', repo: origin.repo, tag: release.tag };
        stored.version = release.tag;
        store.save();
      } finally {
        fs.rmSync(dest, { force: true });
      }
      return { updated: true, state: fullState() };
    }
    if (origin.type === 'nexus') {
      if (nexusUser && nexusUser.isPremium) {
        const files = await nexus.filesList(origin.modId, store.settings.nexusApiKey);
        const file = nexus.pickPrimaryFile(files);
        if (!file) throw new Error('The updated mod has no downloadable main file.');
        const uri = await nexus.downloadLink({ modId: origin.modId, fileId: file.file_id }, store.settings.nexusApiKey);
        const dest = await nexus.downloadToFile(uri, store.stagingDir, file.file_name, (got, total) => {
          sendEvent({ type: 'progress', label: mod.name, received: got, total });
        });
        try {
          const updated = await engine.replaceInPlace(id, dest);
          const stored = store.getMod(updated.id);
          stored.origin = { type: 'nexus', modId: origin.modId, fileId: file.file_id, version: file.version || mod.updateInfo.latest };
          stored.version = file.version || mod.updateInfo.latest;
          store.save();
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
      const mod = await engine.install(p);
      results.push({ source: path.basename(p), ok: true, name: mod.name, modType: mod.modType, warnings: mod.warnings || [] });
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
    add(detection.buildId ? 'good' : 'warning', 'Steam manifest',
      detection.buildId ? `Build ID ${detection.buildId}` : 'Build ID unavailable — compatibility cannot be assessed.');
    const modsDir = path.join(detection.gamePath, MODS_REL);
    add(fs.existsSync(modsDir) ? 'good' : 'info', '~mods folder',
      fs.existsSync(modsDir) ? 'Present' : 'Created on first packaged-mod install');
  } else {
    add('error', 'Game installation', 'Not detected. Locate the game folder in Settings.');
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

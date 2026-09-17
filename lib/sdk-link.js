'use strict';
/* =======================================================================
   sdk-link.js — Mod Command's LINK to a separately installed
   Zero Company Mod SDK.

   Mod Command carries NO SDK panel of its own. The panel, its renderer, its
   styles and every line that touches the SDK's CLI live in the SDK, at
   <sdk>/tools/sdk-ui/. This file is the whole of the host's side:

     1. find an SDK folder (configured, or detected next to the install)
     2. read <sdk>/tools/sdk-ui/manifest.json and check the contract
     3. require() the manifest's cliModule OUT OF THAT FOLDER and register
        its handler map on our ipcMain, with OUR settings store and OUR
        window for the folder picker
     4. host the SDK's own page in a WebContentsView over the content area

   That is what lets the SDK ship on its own cadence: a user updates the SDK
   alone and Mod Command hosts the new panel with no Mod Command release.

   TRUST, stated plainly: step 3 executes JavaScript from a folder the USER
   chose, in the main process, with full Node privileges. That is the same
   trust as running the SDK's own zcmod-build.js — which the panel does
   anyway — but it is a real boundary and docs/SDK_LINK.md says so. We check
   the manifest's shape and the contract number; we do NOT and cannot
   sandbox the module.

   Nothing here may throw into the host. Every entry point is wrapped, a
   failure becomes { linked: false, error } on the Settings card, and Mod
   Command carries on without a Forge view.
   ======================================================================= */

const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { ipcMain, WebContentsView } = require('electron');

// The ONE embed contract this host speaks. An SDK whose manifest says
// anything else is refused by number, not by guesswork.
const HOST_CONTRACT = 1;

const UI_REL = path.join('tools', 'sdk-ui');
const MANIFEST_REL = path.join(UI_REL, 'manifest.json');

// Set by configure() from main.js.
let ctx = null;

// Everything the link owns while it is up.
let state = {
  sdkPath: null,        // the validated SDK root
  manifest: null,       // the parsed, checked manifest
  cli: null,            // the required module
  channels: [],         // channels we registered and must remove on unlink
  view: null,           // the WebContentsView hosting the SDK page
  visible: false,
  bounds: null,         // last rect the renderer measured
  error: null,          // why the last link attempt failed
};

function configure(c) { ctx = c; }

function logLine(level, msg) {
  try { ctx.log(level, `sdk-link: ${msg}`); } catch (_) { /* never fatal */ }
}

// ------------------------------------------------------------ versions

// "1.9.12" vs "1.10.0" — numeric, segment by segment, missing segments are 0.
// Anything non-numeric compares as 0 rather than throwing.
function cmpVersion(a, b) {
  const pa = String(a || '0').split('.');
  const pb = String(b || '0').split('.');
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = parseInt(pa[i], 10) || 0;
    const y = parseInt(pb[i], 10) || 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

// ------------------------------------------------------------ discovery

function isSdkFolder(dir) {
  try { return !!dir && fs.existsSync(path.join(dir, MANIFEST_REL)); } catch (_) { return false; }
}

// Folders named ZeroCompanyModSDK* sitting beside a given folder.
function siblingSdks(nextTo) {
  const out = [];
  try {
    const parent = path.dirname(nextTo);
    for (const entry of fs.readdirSync(parent, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (!/^ZeroCompanyModSDK/i.test(entry.name)) continue;
      out.push(path.join(parent, entry.name));
    }
  } catch (_) { /* unreadable parent is simply no candidate */ }
  return out;
}

// Where an SDK installer would have left a breadcrumb. Neither file is
// required to exist; both are read best-effort and never trusted for
// anything but a path we then validate like any other.
function installerSdks() {
  const out = [];
  const files = [];
  if (process.env.APPDATA) {
    // The standalone SDK UI's own settings file: it remembers the SDK folder
    // the user pointed it at.
    files.push({ file: path.join(process.env.APPDATA, 'zero-company-mod-sdk-ui', 'sdk-ui-settings.json'), key: 'sdkPath' });
  }
  if (process.env.ProgramData) {
    files.push({ file: path.join(process.env.ProgramData, 'ZeroCompanyModSDK', 'install.json'), key: 'sdkPath' });
  }
  for (const f of files) {
    try {
      const j = JSON.parse(fs.readFileSync(f.file, 'utf8'));
      if (j && typeof j[f.key] === 'string' && j[f.key]) out.push(j[f.key]);
    } catch (_) { /* absent or malformed: not a candidate */ }
  }
  return out;
}

// Every place worth looking, most specific first. Deduplicated, and only the
// ones that actually carry tools/sdk-ui/manifest.json come back.
function detectCandidates() {
  const raw = [];
  const configured = ctx && ctx.getSdkPath();
  if (configured) raw.push(configured);
  raw.push(...installerSdks());
  try { raw.push(...siblingSdks(ctx.appDir)); } catch (_) {}
  try {
    const gp = ctx.getGamePath();
    if (gp) raw.push(...siblingSdks(gp), path.join(gp, 'ZeroCompanyModSDK'));
  } catch (_) {}

  const seen = new Set();
  const found = [];
  for (const dir of raw) {
    let full;
    try { full = path.resolve(dir); } catch (_) { continue; }
    const key = full.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    if (isSdkFolder(full)) found.push(full);
  }
  return found;
}

// ------------------------------------------------------------ manifest

// Reads and CHECKS the manifest. Throws with a message meant for the
// Settings card — every failure here is a user-visible sentence.
function readManifest(sdkPath) {
  const file = path.join(sdkPath, MANIFEST_REL);
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); }
  catch (_) { throw new Error(`No SDK UI at ${file} — is that the ZeroCompanyModSDK folder?`); }

  let m;
  try { m = JSON.parse(raw); }
  catch (err) { throw new Error(`${file} is not valid JSON: ${err.message}`); }

  const contract = Number(m.contract);
  if (!Number.isFinite(contract)) throw new Error(`${file} has no numeric "contract".`);
  if (contract !== HOST_CONTRACT) {
    throw new Error(contract > HOST_CONTRACT
      ? `That SDK needs a newer Mod Command (SDK UI contract ${contract}, this build speaks ${HOST_CONTRACT}). Update Mod Command.`
      : `That SDK is too old to embed (SDK UI contract ${contract}, this build speaks ${HOST_CONTRACT}). Update the SDK.`);
  }

  const need = String(m.minModCommand || '0');
  if (cmpVersion(ctx.hostVersion, need) < 0) {
    throw new Error(`That SDK needs Mod Command ${need} or newer — this is ${ctx.hostVersion}.`);
  }

  for (const key of ['entry', 'preload', 'cliModule']) {
    if (typeof m[key] !== 'string' || !m[key]) throw new Error(`${file} has no "${key}".`);
    // Keep every declared path INSIDE tools/sdk-ui: a manifest must not be
    // able to point the host's require() or preload somewhere else entirely.
    const abs = path.resolve(sdkPath, UI_REL, m[key]);
    const root = path.resolve(sdkPath, UI_REL);
    if (abs !== root && !abs.startsWith(root + path.sep)) {
      throw new Error(`${file}: "${key}" points outside tools/sdk-ui.`);
    }
    if (!fs.existsSync(abs)) throw new Error(`${file}: "${key}" → ${abs} does not exist.`);
  }

  return {
    contract,
    name: String(m.name || 'Zero Company Mod SDK'),
    sdkUiVersion: String(m.sdkUiVersion || 'dev'),
    minModCommand: need,
    entry: path.resolve(sdkPath, UI_REL, m.entry),
    preload: path.resolve(sdkPath, UI_REL, m.preload),
    cliModule: path.resolve(sdkPath, UI_REL, m.cliModule),
  };
}

// ------------------------------------------------------------ handlers

function ok(data) { return { ok: true, data }; }
function fail(err) { return { ok: false, error: err && err.message ? err.message : String(err) }; }

// Register the SDK's OWN handler map. The channels are namespaced and
// versioned by the SDK (`sdk:1:doctor`, …), which is exactly why they are
// safe to drop into a host that already owns a hundred of its own.
function registerSdkHandlers() {
  const map = state.cli.createHandlers({
    // The SDK folder and the "show CLI command" toggle live in OUR store.
    getSettings: () => ctx.getSdkSettings(),
    setSettings: (patch) => ctx.setSdkSettings(patch || {}),
    browseFolder: (title, defaultPath) => ctx.browseFolder(title, defaultPath),
    // Streaming job lines go to the hosted view, never to the host renderer.
    sendEvent: (payload) => {
      try {
        if (state.view && !state.view.webContents.isDestroyed()) {
          state.view.webContents.send(state.cli.EVENT_CHANNEL, payload);
        }
      } catch (_) { /* a closed view just stops receiving */ }
    },
    openPath: (p) => ctx.openPath(p),
  });

  for (const [channel, fn] of Object.entries(map)) {
    try { ipcMain.removeHandler(channel); } catch (_) {}
    ipcMain.handle(channel, async (event, payload) => {
      try { return ok(await fn(event, payload)); }
      catch (err) {
        logLine('error', `${channel}: ${err && err.message ? err.message : err}`);
        return fail(err);
      }
    });
    state.channels.push(channel);
  }
  logLine('info', `registered ${state.channels.length} SDK channel(s) (contract ${state.manifest.contract})`);
}

function unregisterSdkHandlers() {
  for (const channel of state.channels) {
    try { ipcMain.removeHandler(channel); } catch (_) {}
  }
  state.channels = [];
}

// ------------------------------------------------------------ the view

function destroyView() {
  if (!state.view) return;
  try {
    if (ctx.window && !ctx.window.isDestroyed()) ctx.window.contentView.removeChildView(state.view);
  } catch (_) {}
  try { state.view.webContents.close(); } catch (_) {}
  state.view = null;
  state.visible = false;
}

function createView() {
  const view = new WebContentsView({
    webPreferences: {
      // The SDK's OWN preload, by absolute path into the linked folder.
      preload: state.manifest.preload,
      contextIsolation: true,
      nodeIntegration: false,
      // The SDK preload only uses contextBridge + ipcRenderer, so the whole
      // hosted page can run sandboxed. Everything privileged happens in the
      // handler map, in this process.
      sandbox: true,
      backgroundThrottling: false,
    },
  });
  view.setBackgroundColor('#05080f');

  const wc = view.webContents;
  // The hosted page is local, and it stays local: no popups, no navigation
  // away from the SDK folder. (A link the SDK wants opened goes through the
  // `open-path` handler, which is ours.)
  wc.setWindowOpenHandler(() => ({ action: 'deny' }));
  wc.on('will-navigate', (e, url) => {
    const base = pathToFileURL(path.join(state.sdkPath, UI_REL)).href.toLowerCase();
    if (!String(url).toLowerCase().startsWith(base)) e.preventDefault();
  });
  wc.on('render-process-gone', (_e, details) => {
    logLine('error', `hosted SDK view gone: ${details && details.reason}`);
  });

  ctx.window.contentView.addChildView(view);
  state.view = view;
  // Off-screen until the Forge view is opened and the renderer measures it.
  applyBounds();

  const url = `${pathToFileURL(state.manifest.entry).href}?embedded=1`;
  wc.loadURL(url);
  logLine('info', `hosting ${url}`);
  return view;
}

// A View with no bounds yet, or a hidden one, is parked at 0×0 rather than
// removed, so the page keeps its state (console buffer, doctor rows) across
// view switches.
function applyBounds() {
  if (!state.view) return;
  const r = state.visible && state.bounds ? state.bounds : { x: 0, y: 0, width: 0, height: 0 };
  try { state.view.setBounds(r); } catch (_) {}
  try { if (typeof state.view.setVisible === 'function') state.view.setVisible(!!(state.visible && state.bounds)); } catch (_) {}
}

// ------------------------------------------------------------ link / unlink

function teardown() {
  try { if (state.cli && typeof state.cli.cancelJob === 'function') state.cli.cancelJob(); } catch (_) {}
  unregisterSdkHandlers();
  destroyView();
  if (state.cli && state.manifest) {
    // Drop the module from the require cache so a relink to a DIFFERENT
    // folder (or the same folder after an SDK update) loads that folder's
    // code, not the copy we already ran.
    try { delete require.cache[require.resolve(state.manifest.cliModule)]; } catch (_) {}
  }
  state = {
    sdkPath: null, manifest: null, cli: null, channels: [],
    view: null, visible: false, bounds: null, error: state.error,
  };
}

// Link a folder. Returns the same status object the Settings card renders.
// NEVER throws: a bad folder becomes { linked: false, error }.
function link(sdkPath, { remember = true } = {}) {
  teardown();
  state.error = null;
  if (!sdkPath) {
    if (remember) ctx.setSdkPath(null);
    return status();
  }
  try {
    const full = path.resolve(sdkPath);
    const manifest = readManifest(full);
    // eslint-disable-next-line global-require, import/no-dynamic-require
    const cli = require(manifest.cliModule);
    if (typeof cli.createHandlers !== 'function') {
      throw new Error(`${manifest.cliModule} exports no createHandlers(ctx).`);
    }
    if (Number(cli.CONTRACT) !== HOST_CONTRACT) {
      throw new Error(`${path.basename(manifest.cliModule)} says contract ${cli.CONTRACT}, the manifest says ${manifest.contract}.`);
    }
    state.sdkPath = full;
    state.manifest = manifest;
    state.cli = cli;
    registerSdkHandlers();
    createView();
    if (remember) ctx.setSdkPath(full);
    logLine('info', `linked ${full} (${manifest.name} ${manifest.sdkUiVersion})`);
  } catch (err) {
    state.error = err && err.message ? err.message : String(err);
    logLine('warn', `link failed: ${state.error}`);
    teardown();
  }
  return status();
}

function unlink() {
  teardown();
  state.error = null;
  ctx.setSdkPath(null);
  logLine('info', 'unlinked');
  return status();
}

// Try every candidate in order and keep the first that links.
function detect() {
  const candidates = detectCandidates();
  for (const dir of candidates) {
    const s = link(dir);
    if (s.linked) return { ...s, candidates };
  }
  return { ...status(), candidates, error: state.error || (candidates.length
    ? 'Found an SDK folder but could not link it.'
    : 'No Zero Company Mod SDK found next to Mod Command or the game.') };
}

// Link whatever is configured, at startup. Silent on failure by design: a
// missing SDK is the normal case for a player.
function restore() {
  const configured = ctx.getSdkPath();
  if (!configured) return status();
  return link(configured, { remember: false });
}

function status() {
  return {
    linked: !!state.cli,
    sdkPath: state.sdkPath || ctx.getSdkPath() || null,
    // The checkout the SDK's CLI runs against. Normally the same folder; a
    // developer can point the panel at another one without unlinking.
    cliPath: (() => { try { return ctx.getSdkSettings().sdkPath || null; } catch (_) { return null; } })(),
    error: state.error || null,
    hostContract: HOST_CONTRACT,
    hostVersion: ctx.hostVersion,
    manifest: state.manifest ? {
      name: state.manifest.name,
      contract: state.manifest.contract,
      sdkUiVersion: state.manifest.sdkUiVersion,
      minModCommand: state.manifest.minModCommand,
    } : null,
  };
}

// ------------------------------------------------------------ view control

// The renderer measures its own content area and hands us the rect; that way
// the host's CSS stays the single source of truth for the layout, and a
// window resize is just another measurement.
function setBounds(rect) {
  if (!rect) return { ok: false };
  const r = {
    x: Math.max(0, Math.round(rect.x || 0)),
    y: Math.max(0, Math.round(rect.y || 0)),
    width: Math.max(0, Math.round(rect.width || 0)),
    height: Math.max(0, Math.round(rect.height || 0)),
  };
  state.bounds = r;
  applyBounds();
  return { ok: true, bounds: r };
}

function setVisible(visible, rect) {
  state.visible = !!visible;
  if (rect) return setBounds(rect);
  applyBounds();
  if (state.visible && state.view) {
    try { state.view.webContents.focus(); } catch (_) {}
  }
  return { ok: true, visible: state.visible };
}

function openDevTools() {
  if (!state.view) return { ok: false };
  try { state.view.webContents.openDevTools({ mode: 'detach' }); } catch (_) {}
  return { ok: true };
}

module.exports = {
  HOST_CONTRACT,
  configure, link, unlink, detect, restore, status,
  setBounds, setVisible, openDevTools, teardown,
  detectCandidates, cmpVersion, readManifest,
};

'use strict';
/* =======================================================================
   sdk-cli.js — the ONE place either host talks to the Zero Company Mod SDK.

   SHARED MODULE: this file is copied VERBATIM between the two A/B hosts —
     Host A (integrated)  ZeroCompanyModManager/lib/sdk-cli.js
     Host B (standalone)  ZeroCompanyModSDK/tools/sdk-ui/lib/sdk-cli.js
   Keep the copies byte-identical. It is plain Node: no `electron` require,
   so it stays testable and so neither host's chrome leaks into the other.

   The five SDK verbs it wraps:
     doctor   python tools/doctor.py --json
     list     the templates/ folders (fallback: zcmod-build.js --new --list)
     new      node tools/zcmod-build.js --new <recipe> <Name> --out <mods>
     check    node tools/zcmod-build.js <def> --check
     build    node tools/zcmod-build.js <def> --gates --layout gfp
     deploy   node tools/zcmod-build.js <def> --deploy-only --layout gfp

   NOTE (mock scope): doctor is read through `--json` rather than by scraping
   the `[ ok ]/[warn]/[FAIL]` text rows — doctor.py pads its label column to
   the widest label OF THAT RUN, so the text is not a stable parse target.
   The --json payload carries the same rows with the same three states.
   ======================================================================= */

const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

// The SDK dev tree. Configurable in either host's settings; this is the default.
const DEFAULT_SDK_PATH = 'G:\\Envian Mods and Projects\\Zero Company Projects\\ZeroCompanyModSDK';
const GAME_PROCESS = 'SWZeroCompany.exe';

// ---------------------------------------------------------------- runtimes

let _node = null;
// zcmod-build.js is a Node script and the SDK's gates shell out to `python`.
// Prefer a real `node` on PATH; fall back to this Electron binary in Node mode
// so a packaged host still works without a separate Node install.
function nodeCmd() {
  if (_node) return _node;
  const probe = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['node'], { encoding: 'utf8' });
  if (probe.status === 0 && String(probe.stdout || '').trim()) {
    _node = { cmd: String(probe.stdout).trim().split(/\r?\n/)[0], env: null, label: 'node' };
  } else {
    _node = { cmd: process.execPath, env: { ELECTRON_RUN_AS_NODE: '1' }, label: 'electron --node' };
  }
  return _node;
}

function pythonCmd() {
  for (const c of ['python', 'py', 'python3']) {
    const probe = spawnSync(process.platform === 'win32' ? 'where' : 'which', [c], { encoding: 'utf8' });
    if (probe.status === 0 && String(probe.stdout || '').trim()) return c;
  }
  return 'python';
}

// ---------------------------------------------------------------- paths

function sdkRoot(sdkPath) { return path.resolve(sdkPath || DEFAULT_SDK_PATH); }
function toolsDir(sdkPath) { return path.join(sdkRoot(sdkPath), 'tools'); }
function modsDir(sdkPath) { return path.join(sdkRoot(sdkPath), 'mods'); }
function buildDir(sdkPath) { return path.join(sdkRoot(sdkPath), 'build'); }
function templatesDir(sdkPath) { return path.join(sdkRoot(sdkPath), 'templates'); }
function builderJs(sdkPath) { return path.join(toolsDir(sdkPath), 'zcmod-build.js'); }
function modDef(sdkPath, name) { return path.join(modsDir(sdkPath), name, `${name}.json`); }

function assertSdk(sdkPath) {
  const root = sdkRoot(sdkPath);
  if (!fs.existsSync(builderJs(sdkPath))) {
    throw new Error(`Not an SDK folder: ${root}\\tools\\zcmod-build.js does not exist. Set the SDK folder in Forge Settings.`);
  }
  return root;
}

// The exact command line, for the console and the "show CLI command" toggle.
function commandLine(cmd, args) {
  const q = (s) => (/[\s"]/.test(s) ? `"${s}"` : s);
  return `${q(path.basename(cmd))} ${args.map(q).join(' ')}`;
}

// ---------------------------------------------------------------- capture

// One-shot run, buffered. Used for the fast verbs (doctor, list, new, mods).
function capture(cmd, args, cwd, extraEnv, timeoutMs = 120000) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, {
        cwd, windowsHide: true,
        env: extraEnv ? { ...process.env, ...extraEnv } : process.env,
      });
    } catch (err) {
      resolve({ code: -1, stdout: '', stderr: String(err && err.message ? err.message : err) });
      return;
    }
    let stdout = '', stderr = '', done = false;
    const finish = (code) => { if (!done) { done = true; clearTimeout(t); resolve({ code, stdout, stderr }); } };
    const t = setTimeout(() => { try { child.kill(); } catch (_) {} finish(-2); }, timeoutMs);
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('error', (err) => { stderr += String(err.message || err); finish(-1); });
    child.on('close', (code) => finish(code == null ? -1 : code));
  });
}

// ---------------------------------------------------------------- doctor

async function doctor(sdkPath) {
  const root = assertSdk(sdkPath);
  const py = pythonCmd();
  const args = ['tools/doctor.py', '--json'];
  const r = await capture(py, args, root, null, 180000);
  const command = commandLine(py, args);
  const text = (r.stdout || '').trim();
  let payload = null;
  try {
    // doctor --json writes ONLY the object to stdout; be forgiving anyway.
    const first = text.indexOf('{');
    if (first >= 0) payload = JSON.parse(text.slice(first));
  } catch (_) { /* fall through to the error path */ }
  if (!payload) {
    return {
      ready: false, rows: [], deployed: [], counts: { ok: 0, warn: 0, fail: 0 },
      exitCode: r.code, command,
      error: r.code === -1
        ? `Could not run ${py} — Python 3.8+ must be on PATH for the SDK's doctor and gates.`
        : `doctor.py produced no JSON (exit ${r.code}). ${(r.stderr || text).slice(0, 300)}`,
    };
  }
  // doctor.py's states are "ok" | "warn" | "FAIL"; normalise the last one.
  const rows = (payload.rows || []).map((x) => ({
    status: String(x.status || '').toLowerCase() === 'fail' ? 'fail' : String(x.status || 'ok').toLowerCase(),
    text: `${x.label}${x.detail ? '  —  ' + x.detail : ''}`,
    label: x.label, detail: x.detail,
  }));
  const counts = {
    ok: rows.filter((x) => x.status === 'ok').length,
    warn: rows.filter((x) => x.status === 'warn').length,
    fail: rows.filter((x) => x.status === 'fail').length,
  };
  return {
    ready: !!payload.ready, summary: payload.summary || '', rows, counts,
    deployed: payload.deployedMods || [],
    conflicts: payload.deployedConflicts || null,
    runtime: payload.runtime || null,
    exitCode: r.code, command,
  };
}

// ---------------------------------------------------------------- templates

const RUNTIME_RE = /ZCSDK Runtime/i;

// Per-template README (generated by tools/make_templates.py) — the blurb sits
// after the first "): " of the "Scaffolded from …" paragraph, and the first
// section is always "## What to change first" whose item 2 is the only
// recipe-specific instruction. That item is the "what to change first" copy.
function readTemplateReadme(file) {
  let md = '';
  try { md = fs.readFileSync(file, 'utf8'); } catch (_) { return null; }
  const out = { runtime: RUNTIME_RE.test(md), blurb: '', changeFirst: '' };
  const scaf = md.split(/\r?\n/).find((l) => /^Scaffolded from/.test(l));
  if (scaf) {
    // "Scaffolded from the … recipe **cost** (the SDK's proven `cost_mod.json`): <blurb>."
    // The parenthetical is present in most but not all of them.
    const m = /^Scaffolded from .*?recipe \*\*[^*]+\*\*(?:\s*\([^)]*\))?:\s*/.exec(scaf);
    out.blurb = stripMd((m ? scaf.slice(m[0].length) : scaf).trim().replace(/\.$/, ''));
  }
  const sec = md.split(/^##\s+/m).find((s) => /^What to change first/i.test(s));
  if (sec) {
    const item = sec.split(/\r?\n/).find((l) => /^2\.\s+/.test(l.trim()));
    const first = sec.split(/\r?\n/).find((l) => /^1\.\s+/.test(l.trim()));
    out.changeFirst = stripMd((item || first || '').replace(/^\s*\d+\.\s+/, ''));
  }
  return out;
}

function stripMd(s) {
  return String(s || '').replace(/\*\*(.+?)\*\*/g, '$1').replace(/`([^`]+)`/g, '$1').trim();
}

// Parse `node tools/zcmod-build.js --new --list`:
//   "  cost           <blurb>[  [needs the ZCSDK Runtime]]  (templates/cost/…)"
function parseRecipeList(stdout) {
  const items = [];
  for (const raw of String(stdout || '').split(/\r?\n/)) {
    const m = /^ {2}([A-Za-z0-9][A-Za-z0-9-]*)\s{1,}(.+)$/.exec(raw);
    if (!m) continue;
    let rest = m[2];
    const runtime = /\[needs the ZCSDK Runtime\]/.test(rest);
    rest = rest.replace(/\s*\[needs the ZCSDK Runtime\]/, '');
    const src = /\(([^)]*)\)\s*$/.exec(rest);
    if (src) rest = rest.slice(0, src.index);
    items.push({ id: m[1], name: m[1], blurb: rest.trim(), runtime, changeFirst: '', source: src ? src[1] : '' });
  }
  return items;
}

async function templates(sdkPath) {
  assertSdk(sdkPath);
  const dir = templatesDir(sdkPath);
  let items = [];
  let source = 'templates';
  let note = '';
  if (fs.existsSync(dir)) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const readme = readTemplateReadme(path.join(dir, entry.name, 'README.md'));
      items.push({
        id: entry.name, name: entry.name,
        blurb: (readme && readme.blurb) || '',
        runtime: !!(readme && readme.runtime),
        changeFirst: (readme && readme.changeFirst) || '',
        source: `templates/${entry.name}`,
      });
    }
    items.sort((a, b) => a.id.localeCompare(b.id));
  }
  if (!items.length) {
    // Old checkouts have no templates/ — fall back to the CLI's own list.
    const n = nodeCmd();
    const args = ['tools/zcmod-build.js', '--new', '--list'];
    const r = await capture(n.cmd, args, sdkRoot(sdkPath), n.env, 60000);
    items = parseRecipeList(r.stdout);
    source = 'cli';
    if (!items.length) note = `No templates/ folder and --new --list returned nothing (exit ${r.code}). ${(r.stderr || '').slice(0, 200)}`;
    else note = 'This SDK checkout has no templates/ — recipe list read from zcmod-build.js --new --list.';
  }
  return { source, items, note };
}

// ---------------------------------------------------------------- workbench

// The recipe a scaffold came from is recorded in the generated description:
//   `… from the "cost" recipe (cost_mod.json). …`
function recipeFromDescription(desc) {
  const m = /from the ["“]([a-z0-9-]+)["”] recipe/i.exec(String(desc || ''));
  return m ? m[1] : '';
}

function mods(sdkPath) {
  assertSdk(sdkPath);
  const root = modsDir(sdkPath);
  if (!fs.existsSync(root)) return [];
  const out = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    // <sdk>/mods/<Name>/<Name>.json is what --new writes; accept any single
    // *.json in the folder so a hand-renamed def still shows up.
    const dir = path.join(root, entry.name);
    let jsons = [];
    try { jsons = fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.json')); } catch (_) { continue; }
    if (!jsons.length) continue;
    const pick = jsons.includes(`${entry.name}.json`) ? `${entry.name}.json` : jsons[0];
    const file = path.join(dir, pick);
    let def = {};
    let broken = '';
    try { def = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (err) { broken = err.message; }
    const modName = def.modName || entry.name;
    out.push({
      name: entry.name, dir, json: file, defFile: pick,
      modName, version: def.version || '', description: def.description || '',
      recipe: recipeFromDescription(def.description), broken,
      lastBuild: readFootprint(sdkPath, modName),
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

// build/<Mod>.footprint.json is written LAST by zcmod-build.js, so its presence
// means that build reached the end. `builtByAt` is absent on pre-1.28.52 stamps.
function readFootprint(sdkPath, modName) {
  const f = path.join(buildDir(sdkPath), `${modName}.footprint.json`);
  try {
    const j = JSON.parse(fs.readFileSync(f, 'utf8'));
    return {
      file: f, builtAt: j.builtAt || j.builtByAt || '', sdk: j.sdk || '',
      version: j.version || '', defPath: j.defPath || '',
      replaces: (j.replaces || []).length, adds: (j.adds || []).length, netnew: (j.netnew || []).length,
    };
  } catch (_) { return null; }
}

async function newMod(sdkPath, recipe, name) {
  assertSdk(sdkPath);
  if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(String(name || ''))) throw new Error(`Bad mod name "${name}".`);
  if (!/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(String(recipe || ''))) throw new Error(`Bad recipe "${recipe}".`);
  const dest = path.join(modsDir(sdkPath), name);
  if (fs.existsSync(dest)) throw new Error(`${dest} already exists — pick another name.`);
  const n = nodeCmd();
  const args = ['tools/zcmod-build.js', '--new', recipe, name, '--out', modsDir(sdkPath)];
  const r = await capture(n.cmd, args, sdkRoot(sdkPath), n.env, 120000);
  const lines = [`$ ${commandLine(n.cmd, args)}`]
    .concat(String(r.stdout || '').split(/\r?\n/))
    .concat(String(r.stderr || '').split(/\r?\n/))
    .filter((l) => l.trim() !== '');
  if (r.code !== 0) throw new Error(`--new ${recipe} ${name} failed (exit ${r.code}): ${(r.stderr || r.stdout || '').trim().slice(0, 300)}`);
  return { lines, dir: dest, json: modDef(sdkPath, name) };
}

// ---------------------------------------------------------------- jobs

// One job at a time, by design: the SDK build is a single-tenant cook that
// writes build/_stage, and two of them would race.
let current = null;

const JOBS = {
  check: { args: () => ['--check'], label: 'CHECK' },
  build: { args: () => ['--gates', '--layout', 'gfp'], label: 'BUILD' },
  deploy: { args: () => ['--deploy-only', '--layout', 'gfp'], label: 'DEPLOY' },
};

// `[zcmod] gates: verify_intent PASS | verify_pak WARN (no overrides) | …`
// The token after the gate name is the state; the rest is free-text detail.
function parseGates(line) {
  const body = /^\[zcmod\] gates:\s*(.+)$/.exec(line);
  if (!body) return null;
  const first = body[1];
  // The SECOND gates line is the count roll-up ("3 PASS, 0 FAIL, …") — skip it.
  if (/^\d+\s+PASS,/.test(first)) return null;
  const gates = [];
  for (const part of first.split(' | ')) {
    const m = /^(\S+)\s+(PASS|FAIL|WARN|SKIPPED|n\/a)\b(.*)$/.exec(part.trim());
    if (!m) continue;
    gates.push({ name: m[1], result: m[2] === 'n/a' ? 'n/a' : m[2], detail: m[3].trim() });
  }
  return gates.length ? gates : null;
}

function gameRunning() {
  if (process.platform !== 'win32') return false;
  const r = spawnSync('tasklist', ['/FI', `IMAGENAME eq ${GAME_PROCESS}`], { encoding: 'utf8', windowsHide: true });
  return String(r.stdout || '').toLowerCase().includes(GAME_PROCESS.toLowerCase());
}

// Streams a long CLI run line by line. `emit(payload)` goes straight to the
// renderer over the host's own event channel.
function startJob(sdkPath, kind, modName, emit, showCommand) {
  if (current) throw new Error('A job is already running.');
  const spec = JOBS[kind];
  if (!spec) throw new Error(`Unknown job "${kind}".`);
  const def = modDef(sdkPath, modName);
  if (!fs.existsSync(def)) throw new Error(`No mod-def at ${def}.`);
  const root = assertSdk(sdkPath);
  const n = nodeCmd();
  const rel = path.relative(root, def).split(path.sep).join('/');
  const args = ['tools/zcmod-build.js', rel, ...spec.args()];
  const command = commandLine(n.cmd, args);

  emit({ type: 'sdk-line', line: `[zcmod-ui] ${spec.label} ${modName} — started ${new Date().toLocaleTimeString()}` });
  if (showCommand) emit({ type: 'sdk-line', line: `$ ${command}` });

  const child = spawn(n.cmd, args, {
    cwd: root, windowsHide: true,
    env: n.env ? { ...process.env, ...n.env } : process.env,
  });
  current = { child, kind, mod: modName, cancelled: false };

  let gates = null;
  const pump = (stream) => {
    let buf = '';
    stream.on('data', (d) => {
      buf += d.toString();
      const parts = buf.split(/\r?\n/);
      buf = parts.pop();
      for (const line of parts) {
        emit({ type: 'sdk-line', line });
        const g = parseGates(line);
        if (g) { gates = g; emit({ type: 'sdk-gates', gates: g }); }
      }
    });
    stream.on('end', () => { if (buf.trim()) emit({ type: 'sdk-line', line: buf }); });
  };
  pump(child.stdout);
  pump(child.stderr);

  child.on('error', (err) => {
    emit({ type: 'sdk-line', line: `ERROR: could not start ${n.label}: ${err.message}` });
  });
  child.on('close', (code) => {
    const cancelled = current && current.cancelled;
    current = null;
    const ok = code === 0 && !cancelled;
    const banner = cancelled ? `CANCELLED — ${spec.label} ${modName}`
      : ok ? `SUCCESS — ${spec.label} ${modName}`
        : `FAILED — ${spec.label} ${modName} (exit ${code})`;
    emit({ type: 'sdk-line', line: `[zcmod-ui] ${banner}` });
    emit({ type: 'sdk-done', ok, code, banner, kind, mod: modName, gates });
  });
  return { command, kind, mod: modName };
}

function cancelJob() {
  if (!current) return { killed: false };
  current.cancelled = true;
  try {
    if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(current.child.pid), '/T', '/F'], { windowsHide: true });
    else current.child.kill('SIGTERM');
  } catch (_) { /* the close handler still fires */ }
  return { killed: true };
}

function jobRunning() { return !!current; }

// ---------------------------------------------------------------- handlers

// Both hosts register exactly these channels; only `ctx` differs (each host
// keeps the SDK path in its own settings store and opens its own folder
// picker). The host wraps the return value in its own { ok, data } envelope.
function createHandlers(ctx) {
  const P = () => ctx.getSettings().sdkPath || DEFAULT_SDK_PATH;
  const emit = (payload) => ctx.sendEvent(payload);
  return {
    'sdk-get-settings': async () => ctx.getSettings(),
    'sdk-set-settings': async (_e, patch) => ctx.setSettings(patch || {}),
    'sdk-browse-path': async () => {
      const dir = await ctx.browseFolder('Locate the Zero Company Mod SDK folder', P());
      if (!dir) return { sdkPath: null };
      if (!fs.existsSync(path.join(dir, 'tools', 'zcmod-build.js'))) {
        throw new Error('That folder has no tools\\zcmod-build.js — pick the ZeroCompanyModSDK checkout.');
      }
      const settings = ctx.setSettings({ sdkPath: dir });
      return { sdkPath: dir, settings };
    },
    'sdk-doctor': async () => doctor(P()),
    'sdk-templates': async () => templates(P()),
    'sdk-mods': async () => mods(P()),
    'sdk-new-mod': async (_e, { recipe, name }) => newMod(P(), recipe, name),
    'sdk-run': async (_e, { kind, mod }) => {
      if (kind === 'deploy' && gameRunning()) {
        throw new Error(`${GAME_PROCESS} is running — close the game before deploying.`);
      }
      return startJob(P(), kind, mod, emit, !!ctx.getSettings().showCommand);
    },
    'sdk-cancel': async () => cancelJob(),
    'sdk-game-running': async () => ({ running: gameRunning() }),
    'sdk-open-path': async (_e, { mod, what }) => {
      let target;
      if (what === 'sdk') target = sdkRoot(P());
      else if (what === 'json') target = modDef(P(), mod);
      else if (what === 'folder') target = path.join(modsDir(P()), mod);
      else throw new Error(`Unknown open target "${what}".`);
      if (!fs.existsSync(target)) throw new Error(`${target} does not exist.`);
      await ctx.openPath(target);
      return { opened: target };
    },
    // Host B's "Deployed" view reuses doctor's deployed-mod rows.
    'sdk-deployed': async () => {
      const d = await doctor(P());
      return { deployed: d.deployed, conflicts: d.conflicts, runtime: d.runtime, ready: d.ready, error: d.error };
    },
  };
}

module.exports = {
  DEFAULT_SDK_PATH, GAME_PROCESS,
  sdkRoot, modsDir, buildDir, templatesDir, modDef, assertSdk, commandLine,
  nodeCmd, pythonCmd,
  doctor, templates, mods, newMod, readFootprint, recipeFromDescription,
  parseRecipeList, parseGates, startJob, cancelJob, jobRunning, gameRunning,
  createHandlers,
};

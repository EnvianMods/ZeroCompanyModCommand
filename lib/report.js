'use strict';
// Support-report builder: one copyable text block holding everything a bug
// report needs, with personal data scrubbed before it ever reaches the
// clipboard — user-profile paths, the username, the machine name, and the
// install locations are replaced with placeholders. The Nexus API key is
// never part of the inputs at all.

const os = require('os');
const path = require('path');

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

// Build a scrubber for this machine's identifying strings.
function makeSanitizer({ gamePath, dataDir } = {}) {
  const rules = [];
  const home = os.homedir();
  // Longest first, so <game> wins over <home> when one contains the other.
  if (gamePath) rules.push([gamePath, '<game>']);
  if (dataDir) rules.push([dataDir, '<manager-data>']);
  if (home) rules.push([home, '<home>']);
  const user = process.env.USERNAME || process.env.USER || (home ? path.basename(home) : null);
  if (user && user.length > 1) rules.push([user, '<user>']);
  const host = os.hostname();
  if (host && host.length > 1) rules.push([host, '<machine>']);
  return (text) => {
    let out = String(text);
    for (const [needle, repl] of rules) {
      for (const variant of new Set([needle, needle.replace(/\\/g, '/'), needle.replace(/\//g, '\\')])) {
        out = out.replace(new RegExp(escapeRe(variant), 'gi'), repl);
      }
    }
    return out;
  };
}

function line(label, value) { return `${label}: ${value}`; }

// data: everything pre-gathered by the caller (no engine calls in here, so
// the builder is unit-testable without Electron).
function buildReport(data) {
  const {
    appVersion, platform, osRelease, generatedAt,
    detection = {}, eaAppPresent,
    settings = {}, hasNexusKey, keyEncrypted,
    mods = [], modCompat = {},
    conflicts = [], hookConflicts = [], duplicates = [], missingDeployed = [],
    ue4ssStatus = {}, retoc = {}, sevenZip,
    diagItems = [],
    logText = '',
    paths = {},
  } = data;

  const s = [];
  s.push('=== ZERO COMPANY MOD COMMAND — SUPPORT REPORT ===');
  s.push(line('Generated', generatedAt || new Date().toISOString()));
  s.push(line('App version', appVersion || '?'));
  s.push(line('Platform', `${platform} (${osRelease || '?'})`));
  s.push('');

  s.push('--- Game ---');
  s.push(line('Detected', detection.found ? 'yes' : 'NO'));
  if (detection.found) {
    s.push(line('Launcher', detection.launcher || 'unknown'));
    s.push(line('Build', detection.buildId || 'unknown'));
    s.push(line('Path', detection.gamePath || ''));
    if (platform === 'linux') s.push(line('Proton prefix', detection.proton && detection.proton.compatdata ? 'present' : 'MISSING'));
    if (detection.launcher === 'ea') s.push(line('EA App detected', eaAppPresent ? 'yes' : 'no'));
  }
  s.push('');

  s.push('--- Tools ---');
  s.push(line('UE4SS', ue4ssStatus.message || 'unknown'));
  s.push(line('retoc', retoc.found ? (retoc.version || 'found') : 'not found'));
  s.push(line('7-Zip', sevenZip ? 'available' : 'not found'));
  s.push(line('Nexus key', hasNexusKey ? (keyEncrypted ? 'stored (encrypted at rest)' : 'stored') : 'none'));
  s.push(line('Reduced motion', settings.reducedMotion ? 'on' : 'off'));
  s.push(line('Close on launch', settings.closeOnLaunch ? 'on' : 'off'));
  s.push('');

  s.push(`--- Mods (${mods.length}) ---`);
  for (const m of mods) {
    const bits = [
      m.enabled ? '[x]' : '[ ]',
      m.name,
      `(${m.modType}${m.version ? ` v${m.version}` : ''})`,
    ];
    if (m.origin && m.origin.type === 'nexus') bits.push(`nexus:${m.origin.modId}`);
    else if (m.origin && m.origin.type === 'github') bits.push(`github:${m.origin.repo}`);
    else bits.push('local');
    if (m.loadPriority != null) bits.push(`pak-prio:${m.loadPriority}`);
    if (m.ue4ssPriority != null) bits.push(`ue4ss-prio:${m.ue4ssPriority}`);
    if (m.installedBuild) bits.push(`build:${m.installedBuild}`);
    const compat = modCompat[m.id];
    if (compat && compat.status !== 'unknown') bits.push(`ea:${compat.status}`);
    if (m.updateInfo && m.updateInfo.available) bits.push(`UPDATE→${m.updateInfo.latest}`);
    s.push('  ' + bits.join(' '));
    for (const w of m.warnings || []) s.push(`      warning: ${w}`);
  }
  s.push('');

  s.push(`--- Conflicts (${conflicts.length} pair(s)) ---`);
  for (const c of conflicts) {
    s.push(`  [${c.certainty}] ${c.aName || c.aId} <-> ${c.bName || c.bId}: ` +
      `${c.packageCount || 0} asset(s), ${c.fileCount || 0} file name(s), ${c.hookCount || 0} hook(s)`);
  }
  if (hookConflicts.length) {
    s.push(`--- UE4SS hook/keybind collisions (${hookConflicts.length}) ---`);
    for (const h of hookConflicts) {
      s.push(`  [${h.kind}] ${h.key} — ${(h.members || []).map((m) => m.name).join(', ')}`);
    }
  }
  if (duplicates.length) {
    s.push(`--- Duplicate mods (${duplicates.length}) ---`);
    for (const d of duplicates) s.push('  ' + (d.members || []).map((m) => m.folder).join(' == '));
  }
  if (missingDeployed.length) {
    s.push(`--- Missing deployed files (${missingDeployed.length}) ---`);
    for (const f of missingDeployed) s.push(`  ${f.modName}: ${f.file}`);
  }
  s.push('');

  s.push('--- Health scan ---');
  for (const item of diagItems) s.push(`  [${item.level}] ${item.title}: ${item.message}`);
  s.push('');

  s.push('--- Session log (most recent last) ---');
  s.push(logText || '(empty)');
  s.push('');
  s.push('=== END OF REPORT — paths, usernames and machine names are scrubbed ===');

  return makeSanitizer(paths)(s.join('\n'));
}

module.exports = { buildReport, makeSanitizer };

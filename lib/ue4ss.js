'use strict';
// UE4SS for Zero Company comes from ONE place: "UE4SS for Star Wars Zero
// Company" on Nexus Mods (mod 9) — the UE4SS build published for this game,
// with its signatures, loader settings and helpers. Mod Command never installs
// or updates the stock upstream build from GitHub (UE4SS-RE/RE-UE4SS): it has
// none of that, and after a game patch it often does nothing at all.
//
// This module:
//   - reads mod 9's file list anonymously through GraphQL v2 (works signed out)
//     and picks the file an install/update uses (the primary MAIN file);
//   - says whether the installed runtime is that Nexus build, the stock build,
//     or of unknown origin (classifyInstall), from the install record the app
//     keeps plus file fingerprints on disk;
//   - says whether a Nexus install is behind mod 9's current main file.
// Downloading goes through lib/nexus.js (premium: API; free: the embedded
// Nexus page's Mod Manager Download → nxm://), wired up in main.js.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
// The app's one outbound door for Nexus requests: it adds the name/version/
// User-Agent headers the Nexus Mods API policy requires and applies the shared
// rate limiter. The api-router GraphQL call below is a Nexus request like any
// other, so it goes through it too.
const { nexusFetch } = require('./nexus-http');

const NEXUS_GAME_ID = 9987;
const NEXUS_MOD_ID = 9;
const NEXUS_NAME = 'UE4SS for Star Wars Zero Company';
// ZC_NEXUS_ROUTER_BASE is a test seam only (point the client at a local mock),
// matching lib/nexus.js's ZC_NEXUS_API_BASE; unset it is the live endpoint.
const NEXUS_GQL = `${process.env.ZC_NEXUS_ROUTER_BASE || 'https://api-router.nexusmods.com'}/graphql`;
const NEXUS_URL = `https://www.nexusmods.com/starwarszerocompany/mods/${NEXUS_MOD_ID}?tab=files`;

// Mod 9's page is read at most hourly (the app's update-check cadence); a
// failed read is retried after five minutes.
const LATEST_TTL_MS = 60 * 60 * 1000;
const LATEST_RETRY_MS = 5 * 60 * 1000;
let nexusCache = { info: null, files: [], at: 0, ok: false };

async function gql(query) {
  const res = await nexusFetch(NEXUS_GQL, {
    kind: 'v2',
    background: true,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  });
  if (!res.ok) throw new Error(`Nexus GraphQL ${res.status}`);
  const json = await res.json();
  if (json.errors) throw new Error(json.errors[0].message);
  return json.data;
}

// The runtime files on mod 9 — the page also carries a small "UE4SS
// Diagnostic Tool", which is not the runtime and never an install candidate.
function isRuntimeFile(f) {
  return f && ['MAIN', 'OLD_VERSION', 'UPDATE'].includes(f.category) && !/diagnos/i.test(`${f.name} ${f.description || ''}`);
}

function toInfo(f, page) {
  return {
    source: 'nexus', modId: NEXUS_MOD_ID, fileId: f.fileId, uid: f.uid, name: f.name,
    version: f.version || null, category: f.category,
    publishedAt: f.date ? new Date(f.date * 1000).toISOString() : null,
    size: Number(f.sizeInBytes) || 0, fileDescription: (f.description || '').slice(0, 200),
    modName: page.modName, modVersion: page.modVersion, testedBuild: page.testedBuild, url: NEXUS_URL,
  };
}

// The file an install or update uses: { source:'nexus', modId, fileId, uid,
// name, version, publishedAt, size, fileDescription, modName, modVersion,
// testedBuild, url } — or null when the page could not be read.
async function refreshNexusLatest(force) {
  const now = Date.now();
  const fresh = nexusCache.at && now - nexusCache.at < (nexusCache.ok ? LATEST_TTL_MS : LATEST_RETRY_MS);
  if (!force && fresh) return nexusCache.info;
  let info = null;
  let list = [];
  try {
    const files = await gql(`{ modFiles(modId:${NEXUS_MOD_ID}, gameId:${NEXUS_GAME_ID}){ uid fileId name version category date sizeInBytes primary description } }`);
    const runtime = ((files && files.modFiles) || []).filter(isRuntimeFile);
    const main = runtime
      .filter((f) => f.category === 'MAIN')
      .sort((a, b) => (b.primary - a.primary) || (b.date - a.date) || (b.fileId - a.fileId))[0];
    if (main) {
      const page = { modName: null, modVersion: null, testedBuild: null };
      try {
        const mods = await gql(`{ mods(filter:{gameId:{value:"${NEXUS_GAME_ID}", op:EQUALS}, modId:{value:"${NEXUS_MOD_ID}", op:EQUALS}}, count:1){ nodes { name version description } } }`);
        const n = mods && mods.mods && mods.mods.nodes && mods.mods.nodes[0];
        if (n) {
          page.modName = n.name || null;
          page.modVersion = n.version || null;
          const m = /build\s+(\d{7,9})/i.exec(n.description || '');
          page.testedBuild = m ? m[1] : null;
        }
      } catch (_) {}
      info = toInfo(main, page);
      // Every runtime file the page lists, newest first — ⧗ Versions offers the
      // older ones to a user whose game is frozen on an older build.
      list = runtime.sort((a, b) => (b.date - a.date) || (b.fileId - a.fileId)).map((f) => toInfo(f, page));
    }
  } catch (_) { /* offline / API change — reported as "could not be read" */ }
  nexusCache = { info, files: list, at: now, ok: !!info };
  return info;
}
function cachedNexusLatest() { return nexusCache.info; }
function cachedNexusFiles() { return nexusCache.files; }

// ----------------------------------------------------------- fingerprints
// What is on disk, independent of what the app remembers installing:
//   dllVersion  — UE4SS.dll's VS_FIXEDFILEINFO file version ("3.0.1.1092");
//                 null when the DLL has no version resource (stock builds often don't)
//   dllMd5      — MD5 of ue4ss\UE4SS.dll
//   signatures  — .lua files in ue4ss\UE4SS_Signatures. The Nexus build ships
//                 some and the stock release zip has none — but the Zero
//                 Company Mod SDK generates its own there too, so signatures
//                 are never evidence of the Nexus build (only none = not Nexus).
//   layout      — 'ue4ss-dir' (dwmapi.dll + ue4ss\UE4SS.dll), 'flat' (UE4SS.dll
//                 beside the exe: pre-3.x stock layout), or null
// Cached by the DLL's size + modified + changed times, so a state refresh
// never re-hashes 15 MB. (The change time matters: files extracted from a zip
// keep its 2-second DOS timestamps, so two builds can share size AND mtime.)
let fpCache = { key: null, value: null };

function peFileVersion(buf) {
  // VS_FIXEDFILEINFO starts with the signature 0xFEEF04BD (little-endian).
  const sig = Buffer.from([0xbd, 0x04, 0xef, 0xfe]);
  const at = buf.indexOf(sig);
  if (at < 0 || at + 16 > buf.length) return null;
  const ms = buf.readUInt32LE(at + 8);
  const ls = buf.readUInt32LE(at + 12);
  const v = [ms >>> 16, ms & 0xffff, ls >>> 16, ls & 0xffff];
  return v.every((n) => n === 0) ? null : v.join('.');
}

function fingerprint(win64, opts = {}) {
  const out = { layout: null, dllVersion: null, dllMd5: null, signatures: 0, settingsIni: false };
  if (!win64) return out;
  const dll = path.join(win64, 'ue4ss', 'UE4SS.dll');
  const flatDll = path.join(win64, 'UE4SS.dll');
  let target = null;
  if (fs.existsSync(dll)) { out.layout = 'ue4ss-dir'; target = dll; }
  else if (fs.existsSync(flatDll)) { out.layout = 'flat'; target = flatDll; }
  if (!fs.existsSync(path.join(win64, 'dwmapi.dll')) && out.layout === 'ue4ss-dir') out.layout = 'ue4ss-dir-no-loader';
  const sigDir = path.join(win64, 'ue4ss', 'UE4SS_Signatures');
  // opts.ignoreSignatures: file names that are not the UE4SS build's (the ZCSDK
  // Runtime's own signature files, placed by Mod Command) and are not counted.
  const ignore = new Set([...(opts.ignoreSignatures || [])].map((n) => String(n).toLowerCase()));
  try { out.signatures = fs.readdirSync(sigDir).filter((f) => /\.lua$/i.test(f) && !ignore.has(f.toLowerCase())).length; } catch (_) {}
  out.settingsIni = fs.existsSync(path.join(win64, 'ue4ss', 'UE4SS-settings.ini'));
  if (!target) return out;
  try {
    const st = fs.statSync(target);
    const key = `${target}|${st.size}|${st.mtimeMs}|${st.ctimeMs}|${st.ino}`;
    if (fpCache.key !== key) {
      const buf = fs.readFileSync(target);
      fpCache = { key, value: { dllVersion: peFileVersion(buf), dllMd5: crypto.createHash('md5').update(buf).digest('hex') } };
    }
    Object.assign(out, fpCache.value);
  } catch (_) {}
  return out;
}

// The asset names the stock GitHub releases use ("UE4SS_v3.0.1-1127-g2bfa839f.zip")
// — only to recognise an install record older builds of this app wrote.
function stockBuildOf(assetName) {
  const m = /^UE4SS(?:_Standard|_Xinput)?_(v[0-9][^/\\]*?)\.zip$/i.exec(String(assetName || ''));
  return m ? m[1] : null;
}

// Which UE4SS is installed?
//   status       engine.ue4ssStatus()
//   record       settings.ue4ssInstalled (what Mod Command last put there)
//   fp           fingerprint(win64)
//   knownNexus   settings.ue4ssNexusFingerprints — { <UE4SS.dll md5>: { fileId, version } }
//                for every Nexus build this app has installed
// → { origin: 'none'|'nexus'|'stock'|'unknown', switchable, label, reason, build }
// The Nexus build is trusted only through Mod Command's own install record or
// a UE4SS.dll MD5 it recorded for a Nexus install. Files in UE4SS_Signatures
// prove nothing (the Zero Company Mod SDK generates its own there), so a
// UE4SS with no record and signatures present is "unknown", not "nexus".
function classifyInstall(status, record, fp, knownNexus) {
  if (!status || !status.installed) return { origin: 'none', switchable: false, label: 'not installed', reason: null, build: null };
  const rec = record || null;
  const known = (fp && fp.dllMd5 && knownNexus && knownNexus[fp.dllMd5]) || null;
  const recStock = rec && (rec.source === 'github' || (!rec.source && (stockBuildOf(rec.asset) || /^(v\d|experimental)/i.test(String(rec.tag || '')))));
  if (rec && rec.source === 'nexus') {
    // Installed by Mod Command from Nexus. If UE4SS.dll changed since then
    // (someone dropped another build over it), the record no longer describes it.
    if (rec.dllMd5 && fp && fp.dllMd5 && rec.dllMd5 !== fp.dllMd5 && !known) {
      return {
        origin: 'unknown', switchable: true, label: 'changed outside Mod Command',
        reason: 'UE4SS.dll no longer matches the Nexus build Mod Command installed — another UE4SS was copied over it.',
        build: fp.dllVersion,
      };
    }
    return { origin: 'nexus', switchable: false, label: `Nexus v${rec.version || '?'}`, reason: null, build: rec.version || null };
  }
  if (known) {
    return { origin: 'nexus', switchable: false, label: `Nexus v${known.version || '?'}`, reason: 'Recognised by its UE4SS.dll as a Nexus build this app installed before.', build: known.version || null, recognised: known };
  }
  if (recStock) {
    return {
      origin: 'stock', switchable: true, label: 'stock build',
      reason: `Installed by an older Mod Command from GitHub (UE4SS-RE/RE-UE4SS${stockBuildOf(rec.asset) ? `, ${stockBuildOf(rec.asset)}` : ''}) — the general-purpose UE4SS, not the build published for this game.`,
      build: stockBuildOf(rec.asset) || rec.tag || (fp && fp.dllVersion) || null,
    };
  }
  if (fp && fp.layout === 'flat') {
    return { origin: 'stock', switchable: true, label: 'stock build (old flat layout)', reason: 'An old stock UE4SS with the flat layout (UE4SS.dll beside the game exe) — it predates UE 5.6 and has no Zero Company signatures.', build: fp.dllVersion };
  }
  if (fp && fp.signatures === 0) {
    return {
      origin: 'stock', switchable: true, label: 'stock build',
      reason: `No Zero Company signatures in ue4ss\\UE4SS_Signatures — this is the general-purpose UE4SS${fp.dllVersion ? ` (UE4SS.dll ${fp.dllVersion})` : ''}, not the build published for this game.`,
      build: fp.dllVersion,
    };
  }
  return {
    origin: 'unknown', switchable: true, label: 'unknown origin',
    reason: `Mod Command has no record of installing this UE4SS${fp && fp.dllVersion ? ` (UE4SS.dll ${fp.dllVersion})` : ''} and cannot tell which build it is — it may be the stock build or a copy of the Nexus build placed by hand (signature files alone do not say: the Mod SDK writes them too). Switching installs the Nexus build so it can be kept up to date.`,
    build: fp ? fp.dllVersion : null,
  };
}

// Is a Nexus install behind mod 9's current main file? Nexus file ids only
// grow, so a higher id on the page is a newer upload. Anything other than a
// Nexus install has no "update" — it has the switch (see classifyInstall).
function updateInfo(installedRecord, nexusLatest = nexusCache.info) {
  const rec = installedRecord && installedRecord.source === 'nexus' ? installedRecord : null;
  const out = {
    source: rec ? 'nexus' : null, available: false,
    current: rec ? String(rec.fileId) : null,
    currentBuild: rec ? (rec.version ? `v${rec.version}` : `file ${rec.fileId}`) : null,
    latest: null, latestBuild: null, latestDate: null,
    nexus: nexusLatest ? { fileId: nexusLatest.fileId, version: nexusLatest.version, date: nexusLatest.publishedAt, testedBuild: nexusLatest.testedBuild, modName: nexusLatest.modName, url: nexusLatest.url, size: nexusLatest.size } : null,
  };
  if (nexusLatest) {
    out.latest = String(nexusLatest.fileId);
    out.latestBuild = nexusLatest.version ? `v${nexusLatest.version}` : `file ${nexusLatest.fileId}`;
    out.latestDate = nexusLatest.publishedAt;
  }
  if (rec && rec.fileId && nexusLatest && Number(nexusLatest.fileId) > Number(rec.fileId)) out.available = true;
  return out;
}

module.exports = {
  refreshNexusLatest, cachedNexusLatest, cachedNexusFiles, updateInfo,
  fingerprint, classifyInstall, peFileVersion, stockBuildOf,
  NEXUS_GAME_ID, NEXUS_MOD_ID, NEXUS_NAME, NEXUS_URL,
};

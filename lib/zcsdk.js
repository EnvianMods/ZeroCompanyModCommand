'use strict';
// The bundled ZCSDK Runtime — two UE4SS mods (ZCSDKBridge + ZCSDKLoader) that
// content mods built with the Zero Company Mod SDK need at play time. The
// runtime finds each such mod's <Mod>.zcsdk.lua manifest next to its paks,
// loads the mod's pruned asset registry so the game can enumerate the new
// content, and grants the manifest's items once per save.
//
// Shipped in tools/ next to retoc (extraResources in packaged builds) so the
// install is one click and works offline. tools/zcsdk-runtime.json carries the
// bundled version numbers for the Settings card.

const fs = require('fs');
const path = require('path');

const RUNTIME_ZIP = 'ZCSDKRuntime.zip';
const RUNTIME_INFO = 'zcsdk-runtime.json';

// UE4SS mod folder names the runtime consists of (both must be present).
const PARTS = ['ZCSDKBridge', 'ZCSDKLoader'];

function toolsDirs() {
  return [
    path.join(__dirname, '..', 'tools'),
    process.resourcesPath ? path.join(process.resourcesPath, 'tools') : null,
  ].filter(Boolean);
}

// { zip, version, bridge, loader, size } for the bundled package, or null when
// this build ships without one.
function bundledRuntime() {
  for (const dir of toolsDirs()) {
    const zip = path.join(dir, RUNTIME_ZIP);
    let exists = false;
    try { exists = fs.existsSync(zip); } catch (_) {}
    if (!exists) continue;
    let info = {};
    try { info = JSON.parse(fs.readFileSync(path.join(dir, RUNTIME_INFO), 'utf8')); } catch (_) {}
    return {
      zip,
      version: typeof info.version === 'string' ? info.version : null,
      bridge: typeof info.bridge === 'string' ? info.bridge : null,
      loader: typeof info.loader === 'string' ? info.loader : null,
      size: fs.statSync(zip).size,
    };
  }
  return null;
}

module.exports = { bundledRuntime, PARTS, RUNTIME_ZIP };

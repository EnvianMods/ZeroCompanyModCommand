'use strict';
// =====================================================================
//  NEXUS MODS APPLICATION IDENTIFICATION
// =====================================================================
//
//  Every request this app sends to a Nexus Mods host (nexusmods.com and
//  every subdomain, nexus-cdn.com) carries BOTH of these headers:
//
//      Application-Name:    Zero Company Mod Command
//      Application-Version: 1.0.12      <- the release's public version
//
//  The version is the public version number shown on the app's Nexus Mods
//  page and in the release file names (ZeroCompanyModCommand-v1.0.12.zip).
//  It is read from RELEASE_VERSION.txt, which ships inside the app and is
//  bumped in the same commit as every release. If that file were ever
//  missing, the build's package.json version is sent instead — the header is
//  never empty and never left out.
//
//  Where they are attached:
//   * lib/nexus-http.js nexusFetch() — the only door for the app's own API
//     traffic: the v1 REST API, the v2 GraphQL API, api-router (UE4SS page),
//     the OAuth token/revoke endpoints and CDN downloads.
//   * lib/nexus-http.js addIdentityToWebSession() — the Electron sessions
//     (the app window and the embedded Nexus Mods panel) add both headers to
//     every request they make to a Nexus Mods host.
// =====================================================================

const fs = require('fs');
const path = require('path');

const APPLICATION_NAME = 'Zero Company Mod Command';

const VERSION_RE = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

function readPublicVersion() {
  try {
    const v = fs.readFileSync(path.join(__dirname, '..', 'RELEASE_VERSION.txt'), 'utf8').trim();
    if (VERSION_RE.test(v)) return v;
  } catch (_) {}
  return String(require('../package.json').version);
}

const APPLICATION_VERSION = readPublicVersion();

// The exact header block, as sent.
const NEXUS_APPLICATION_HEADERS = Object.freeze({
  'Application-Name': APPLICATION_NAME,
  'Application-Version': APPLICATION_VERSION,
});

module.exports = { APPLICATION_NAME, APPLICATION_VERSION, NEXUS_APPLICATION_HEADERS, readPublicVersion };

'use strict';
// The single outbound door for everything this app sends to Nexus Mods.
//
// Every request to any *.nexusmods.com host goes through nexusFetch(): the v1
// REST API and the v2 GraphQL API (lib/nexus.js), the api-router GraphQL used
// for the UE4SS page (lib/ue4ss.js), the OAuth token and revoke calls
// (lib/nexus-oauth.js) and the CDN download stream. That is what makes the
// application identification headers Nexus's API policy requires impossible to
// forget — there is nowhere else a request can leave from.
//
// This module requires none of the three at load time, so there is no cycle:
// lib/nexus.js registers the application name and version here when it loads
// (the version string lives on exactly one line, in lib/nexus.js, because that
// is the line a release bump edits).

// ------------------------------------------------------------ identification

// Set by lib/nexus.js at load. Never left blank and never borrowed from
// another app: Nexus uses these to tell traffic apart.
let identity = null;

// The registered application name, the version, and a User-Agent that names
// the app and where it lives.
function setAppIdentity({ name, version } = {}) {
  if (!name || !version) throw new Error('nexus-http: the application name and version are both required.');
  identity = {
    'Application-Name': String(name),
    'Application-Version': String(version),
    'User-Agent': `ZeroCompanyModCommand/${version} (+https://github.com/EnvianMods/ZeroCompanyModCommand)`,
  };
  return identity;
}

function appHeaders() {
  // Deferred to call time (never at load) so lib/nexus.js can require this
  // module: by the time any request is sent, everything has finished loading.
  if (!identity) require('./nexus');
  if (!identity) throw new Error('nexus-http: the application identification headers are not set.');
  return identity;
}

// Case-insensitive merge: our identification always wins over a caller's, so
// no call site can accidentally blank it or send a borrowed one.
function mergeHeaders(given) {
  const mine = appHeaders();
  const taken = new Set(Object.keys(mine).map((k) => k.toLowerCase()));
  const out = {};
  if (given) {
    const pairs = typeof given.entries === 'function' ? [...given.entries()] : Object.entries(given);
    for (const [k, v] of pairs) if (!taken.has(String(k).toLowerCase())) out[k] = v;
  }
  return { ...out, ...mine };
}

// ------------------------------------------------------------ hosts

// Is this URL one of Nexus Mods' own hosts? Used by the shared downloader,
// which also fetches GitHub release assets — those are not Nexus traffic and
// must not carry Nexus identification or consume Nexus's queue.
function isNexusUrl(url) {
  try {
    return /(^|\.)nexusmods\.com$/i.test(new URL(String(url)).hostname);
  } catch (_) {
    return false;
  }
}

// ------------------------------------------------------------ the request

// nexusFetch(url, init) — a plain fetch() with the identification headers
// added. `init.kind` says which API this is ('v1' | 'v2' | 'cdn' | 'oauth'),
// which the rate limiter uses; `init.background` marks a request made by a
// background job rather than by something the user pressed.
async function nexusFetch(url, init = {}) {
  const { kind, background, ...rest } = init;
  return fetch(url, { ...rest, headers: mergeHeaders(init.headers) });
}

module.exports = { nexusFetch, setAppIdentity, appHeaders, isNexusUrl };

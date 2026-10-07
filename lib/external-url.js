'use strict';
// The one list of places Mod Command will open in the user's browser.
//
// main.js's 'open-external' handler refuses anything this says no to, and
// lib/launcher-update.js drops a published SDK "Get" url this says no to while
// parsing it, so the renderer is never handed a link it could not open (it
// shows its "could not be fetched" line instead). Widening this list is an owner
// decision: it changes what a published file can send users to.

const ALLOWED_EXTERNAL = /^https:\/\/(www\.|next\.)?(nexusmods\.com|github\.com|discord\.gg)\//;

function isAllowedExternalUrl(url) {
  return typeof url === 'string' && ALLOWED_EXTERNAL.test(url);
}

// May the embedded Nexus panel follow a window.open / target=_blank link to
// this address itself? Only a real Nexus Mods page: http(s) on nexusmods.com
// or one of its subdomains, decided on the parsed host (a prefix test would
// also let "https://nexusmods.com.example.net/" or "https://nexusmods.com@x/" in).
function isNexusPageUrl(url) {
  if (typeof url !== 'string') return false;
  let u;
  try { u = new URL(url); } catch (_) { return false; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
  if (u.username || u.password) return false;
  return /^(?:[a-z0-9-]+\.)*nexusmods\.com$/i.test(u.hostname);
}

// A plain http(s) web address (the hosted SDK workbench may open any web page
// in the browser, but never a file:, a custom protocol or a program).
function isWebUrl(url) {
  if (typeof url !== 'string') return false;
  try { const u = new URL(url); return u.protocol === 'https:' || u.protocol === 'http:'; } catch (_) { return false; }
}

module.exports = { isAllowedExternalUrl, isNexusPageUrl, isWebUrl };

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

module.exports = { isAllowedExternalUrl };

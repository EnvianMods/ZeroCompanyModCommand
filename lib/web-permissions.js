'use strict';
// Web permission policy for every session the app uses.
//
// Electron GRANTS every permission request by default — camera, microphone,
// geolocation, notifications, MIDI, HID/serial/USB, clipboard-read, screen
// capture, opening external protocol handlers, and so on. The Nexus website
// panel (<webview partition="persist:nexus">) is remote content that carries
// dozens of third-party ad and tracking frames, so each of those would be
// handed all of that without a prompt. Here both sessions are switched to
// deny-by-default with a short allow-list of what the pages genuinely use:
//
//   persist:nexus (the Nexus website panel)
//     clipboard-sanitized-write — the site's own "copy" buttons, nexusmods.com
//                                 frames only (an ad writing to the clipboard
//                                 is the "paste this command" lure)
//     fullscreen                — video players in mod pages, nexusmods.com
//                                 and YouTube embeds only (needs a user click)
//     Everything else is denied. Cloudflare Turnstile / the challenge page need
//     none of these (verified: the file-page challenge still passes by itself
//     and the sign-in widget still renders). Third-party cookies — which the
//     Turnstile frame does use — are not a permission and are unaffected.
//     openExternal is never granted: an nxm:// link is handed straight to the
//     app's own install pipeline (onNxm) and never goes out to the OS; any
//     other external protocol (steam:, ms-*:, mailto:, …) is refused.
//
//   default session (the app's own UI and the hosted SDK workbench, file://)
//     clipboard-sanitized-write — "Copy support report" and the SDK's copy
//                                 buttons (navigator.clipboard.writeText)
//     Everything else is denied.
//
// Devices (HID / serial / USB / Bluetooth) are refused on both: the device
// permission handler says no and any chooser event is cancelled rather than
// left to Electron's "pick the first device" default.
//
// Denials are logged once per (session, permission, origin) at debug level so a
// future breakage ("the site stopped working after an update") is diagnosable
// from the support report. Only the origin is logged — never a path or query.

const NEXUS_PARTITION = 'persist:nexus';

function hostOf(u) {
  try { return new URL(String(u)).hostname.toLowerCase(); } catch (_) { return ''; }
}

function hostIs(host, domain) {
  return host === domain || host.endsWith(`.${domain}`);
}

const isNexusHost = (h) => hostIs(h, 'nexusmods.com');
const isVideoHost = (h) => hostIs(h, 'youtube.com') || hostIs(h, 'youtube-nocookie.com');

// Only scheme + host (+ port) ever reaches the log.
function originOf(u) {
  const s = String(u || '');
  if (/^file:/i.test(s)) return 'file://';
  try {
    const x = new URL(s);
    if (x.origin && x.origin !== 'null') return x.origin;
    return `${x.protocol}`;
  } catch (_) { return '(unknown)'; }
}

// The URL of the frame that asked. Electron passes requestingUrl in details
// (request handler) and requestingOrigin / details.requestingUrl (check handler).
function requester(origin, details) {
  return (details && (details.requestingUrl || details.securityOrigin)) || origin || '';
}

// ------------------------------------------------------------------ policies
// Each policy: (permission, requestingUrl) -> boolean.
function nexusAllows(permission, url) {
  const h = hostOf(url);
  switch (permission) {
    case 'clipboard-sanitized-write': return isNexusHost(h);
    case 'fullscreen': return isNexusHost(h) || isVideoHost(h);
    default: return false;
  }
}

function appAllows(permission, url) {
  const local = /^file:/i.test(String(url || ''));
  switch (permission) {
    case 'clipboard-sanitized-write': return local;
    default: return false;
  }
}

// ------------------------------------------------------------------- install
function makeDenyLogger(label, log) {
  const seen = new Set();
  return (permission, url, extra = '') => {
    const origin = originOf(url);
    const key = `${permission} ${origin} ${extra}`;
    if (seen.has(key) || seen.size > 500) return;
    seen.add(key);
    try { log('debug', `permissions: denied ${permission} to ${origin} in the ${label}${extra ? ` (${extra})` : ''}`); } catch (_) {}
  };
}

function lockDevices(ses) {
  ses.setDevicePermissionHandler(() => false);
  if (typeof ses.setBluetoothPairingHandler === 'function' && process.platform !== 'darwin') {
    ses.setBluetoothPairingHandler((_details, callback) => callback({ confirmed: false }));
  }
  const cancel = (e, _details, callback) => { e.preventDefault(); try { callback(); } catch (_) {} };
  ses.on('select-hid-device', cancel);
  ses.on('select-serial-port', (e, _ports, _wc, callback) => { e.preventDefault(); try { callback(''); } catch (_) {} });
  ses.on('select-usb-device', cancel);
}

// onNxm(url): the app's nxm:// install entry point. An nxm:// link that reached
// the OS-handoff stage (e.g. from a frame, where will-navigate does not fire) is
// routed there in-process instead.
function applyPolicy(ses, label, allows, { log = () => {}, onNxm = null } = {}) {
  const denied = makeDenyLogger(label, log);

  ses.setPermissionRequestHandler((_wc, permission, callback, details = {}) => {
    if (permission === 'openExternal') {
      const ext = String(details.externalURL || '');
      if (onNxm && /^nxm:\/\//i.test(ext)) {
        try { onNxm(ext); } catch (_) {}
      } else {
        denied(permission, requester('', details), `external ${originOf(ext).replace(/\/\/$/, '')}`);
      }
      return callback(false);
    }
    const url = requester('', details);
    const ok = allows(permission, url);
    if (!ok) denied(permission, url);
    callback(ok);
  });

  ses.setPermissionCheckHandler((_wc, permission, requestingOrigin, details = {}) => {
    const url = requester(requestingOrigin, details);
    const ok = allows(permission, url);
    if (!ok) denied(permission, url, 'check');
    return ok;
  });

  lockDevices(ses);
}

// Idempotent per session object is not required — call once after app 'ready'.
function configureWebPermissions(session, { log, onNxm } = {}) {
  applyPolicy(session.fromPartition(NEXUS_PARTITION), 'Nexus panel', nexusAllows, { log, onNxm });
  applyPolicy(session.defaultSession, 'app window', appAllows, { log });
}

// Bluetooth device choosers are a webContents event, not a session one.
function lockWebContentsDevices(contents) {
  contents.on('select-bluetooth-device', (e, _devices, callback) => { e.preventDefault(); try { callback(''); } catch (_) {} });
}

module.exports = {
  configureWebPermissions, lockWebContentsDevices,
  nexusAllows, appAllows, originOf, hostOf,
};

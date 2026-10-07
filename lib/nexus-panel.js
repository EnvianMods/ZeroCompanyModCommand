'use strict';
// The embedded Nexus Mods panel (<webview partition="persist:nexus">), seen
// from the main process: a short record of what happened in it, for the log
// and the support report, and the signals the renderer cannot read itself.
//
// Nothing here changes what the panel shows or does: the page is displayed as
// Nexus serves it. This module only observes (state changes, error responses)
// and reports. Log lines carry origin + path only — never a query string,
// never a cookie value.
//
// Signed in? The renderer reads the page (src/app.js nexusPageState). The
// session's cookies fill in only when the page says neither: the www site's
// account cookies `member_id` (a positive number; a guest is member 0) and
// `pass_hash`. Cloudflare's and the users site's session cookies
// (cf_clearance, __cf_bm, nexusmods_session, nexusmods_session_refresh) are set
// for anonymous visitors too and never count. Cookie values are tested here
// for shape only and are never logged, returned or stored.

const NEXUS_COOKIE_HOSTS = ['nexusmods.com'];

const AUTH_COOKIES = [
  { name: 'member_id', valid: (v) => /^[1-9]\d*$/.test(v) },
  { name: 'pass_hash', valid: (v) => v.length >= 8 && !/^0+$/.test(v) },
];

function domainMatches(domain, hosts = NEXUS_COOKIE_HOSTS) {
  const d = String(domain || '').toLowerCase().replace(/^\./, '');
  return hosts.some((h) => d === h || d.endsWith('.' + h));
}

// cookies: Electron Cookie objects. The NAME of the first account cookie
// present, or null.
function authCookieSignal(cookies, hosts = NEXUS_COOKIE_HOSTS) {
  for (const rule of AUTH_COOKIES) {
    const hit = (cookies || []).find((c) => c && c.name === rule.name
      && domainMatches(c.domain, hosts) && rule.valid(String(c.value || '')));
    if (hit) return rule.name;
  }
  return null;
}

function originPath(u) {
  try { const x = new URL(u); return `${x.origin}${x.pathname}`; } catch (_) { return String(u || '').split(/[?#]/)[0].slice(0, 120); }
}
function originOf(u) {
  try { return new URL(u).origin; } catch (_) { return '?'; }
}

// A page counts as partly blocked when this many Nexus subresources were
// refused (4xx) during one page load.
const BLOCKED_THRESHOLD = 6;

const REPORT_SESSIONS = 3;

function createPanelDiary({ log = () => {} } = {}) {
  let current = null;
  const history = []; // closed sessions, newest first
  const subErrors = new Map(); // webContentsId -> Map(origin -> Map(status -> n))

  function fresh(info = {}) {
    return {
      openedAt: new Date().toISOString(), closedAt: null,
      target: info.target ? originPath(info.target) : null,
      view: !!info.view,
      signedIn: null, signal: null, challenges: 0, challengesPassed: 0,
      signInVisited: false, oops: 0, blocked: 0, nxm: 0, subErrors: {},
    };
  }
  function rec() { if (!current) current = fresh(); return current; }
  function keep(r) { history.unshift(r); history.length = Math.min(history.length, REPORT_SESSIONS); }

  function event(kind, d = {}) {
    if (kind === 'open') {
      if (current) keep(current);
      current = fresh(d);
      log('info', `nexus panel: opened ${current.view ? 'to view' : 'for a download'} ${current.target || ''}`);
      return current;
    }
    const r = rec();
    switch (kind) {
      case 'close':
        r.closedAt = new Date().toISOString();
        log('info', `nexus panel: closed (${summaryLine(r)})`);
        keep(r); current = null;
        break;
      case 'signed-in': {
        const val = d.state === 'in' ? true : (d.state === 'out' ? false : null);
        if (val !== r.signedIn || (d.signal || null) !== r.signal) {
          r.signedIn = val; r.signal = d.signal || null;
          log('info', `nexus panel: signed-in ${val === true ? 'YES' : (val === false ? 'NO' : 'unknown')}`
            + `${d.signal ? ` (${d.signal})` : ''}${d.url ? ` on ${originPath(d.url)}` : ''}`);
        }
        break;
      }
      case 'challenge':
        r.challenges += 1;
        log('info', `nexus panel: Cloudflare check shown on ${originPath(d.url)}`);
        break;
      case 'challenge-passed':
        r.challengesPassed += 1;
        log('info', `nexus panel: Cloudflare check passed (now ${originPath(d.url)})`);
        break;
      case 'signin-page':
        if (!r.signInVisited) log('info', `nexus panel: sign-in page visited (${originPath(d.url)})`);
        r.signInVisited = true;
        break;
      case 'oops':
        r.oops += 1;
        log('warn', `nexus panel: Nexus error page ("Something went wrong") on ${originPath(d.url)}`);
        break;
      case 'blocked':
        r.blocked += 1;
        log('warn', `nexus panel: page partly blocked — ${d.count || '?'} Nexus subresource(s) refused on ${originPath(d.url)}`);
        break;
      case 'nxm':
        r.nxm += 1;
        log('info', `nexus panel: nxm link caught${d.modId ? ` (mod ${d.modId}${d.fileId ? ` file ${d.fileId}` : ''})` : ''}`);
        break;
      default:
        break;
    }
    return r;
  }

  // A subresource response of 400+ from the panel (webRequest.onCompleted).
  function subresource(webContentsId, url, status) {
    const o = originOf(url);
    let m = subErrors.get(webContentsId);
    if (!m) { m = new Map(); subErrors.set(webContentsId, m); }
    let s = m.get(o);
    if (!s) { s = new Map(); m.set(o, s); }
    s.set(status, (s.get(status) || 0) + 1);
  }

  // What the panel's current page load saw: { errors: {origin: {status: n}},
  // refusedNexus }. `reset` starts a new page load.
  function pageErrors(webContentsId, { reset = false } = {}) {
    const m = subErrors.get(webContentsId);
    const errors = {};
    let refusedNexus = 0;
    if (m) {
      for (const [o, s] of m) {
        errors[o] = Object.fromEntries(s);
        if (/(^|\.)nexusmods\.com$/i.test(o.replace(/^https?:\/\//, '').replace(/:\d+$/, ''))) {
          for (const [st, n] of s) if (st >= 400 && st < 500) refusedNexus += n;
        }
      }
    }
    if (reset) {
      subErrors.delete(webContentsId);
      const r = current || history[0];
      if (r) {
        for (const [o, byStatus] of Object.entries(errors)) {
          const t = r.subErrors[o] || (r.subErrors[o] = {});
          for (const [st, n] of Object.entries(byStatus)) t[st] = (t[st] || 0) + n;
        }
      }
    }
    return { errors, refusedNexus };
  }

  function summaryLine(r) {
    if (!r) return 'no panel session';
    return [
      `signed in: ${r.signedIn === true ? 'yes' : (r.signedIn === false ? 'no' : 'unknown')}${r.signal ? ` (${r.signal})` : ''}`,
      `sign-in page: ${r.signInVisited ? 'visited' : 'no'}`,
      `checks: ${r.challenges} shown / ${r.challengesPassed} passed`,
      `error pages: ${r.oops}`, `partly blocked: ${r.blocked}`,
      `nxm caught: ${r.nxm}`,
    ].join(' · ');
  }

  function sessionLines(r, label) {
    const errs = r.subErrors || {};
    const origins = Object.keys(errs);
    return [
      `${label}: ${r.openedAt}${r.closedAt ? ` → ${r.closedAt}` : ' (still open)'}${r.view ? ' (page view)' : ' (download)'}`,
      `  Opened for: ${r.target || '?'}`,
      `  Signed in: ${r.signedIn === true ? 'yes' : (r.signedIn === false ? 'no' : 'unknown')}${r.signal ? ` — signal: ${r.signal}` : ''}`,
      `  Sign-in page visited: ${r.signInVisited ? 'yes' : 'no'}`,
      `  Cloudflare checks: ${r.challenges} shown, ${r.challengesPassed} passed`,
      `  Nexus error pages ("Something went wrong"): ${r.oops}; partly blocked pages: ${r.blocked}`,
      `  nxm links caught: ${r.nxm}`,
      `  Subresource errors: ${origins.length ? origins.map((o) => `${o} ${Object.entries(errs[o]).map(([st, n]) => `${st}×${n}`).join(' ')}`).join('; ') : 'none'}`,
    ];
  }

  function reportLines() {
    const sessions = [current, ...history].filter(Boolean).slice(0, REPORT_SESSIONS);
    const lines = [];
    if (!sessions.length) lines.push('Panel sessions: none this run');
    sessions.forEach((r, i) => lines.push(...sessionLines(r, i ? `Earlier panel session ${i}` : 'Last panel session')));
    return lines;
  }

  return { event, subresource, pageErrors, reportLines, summaryLine, get current() { return current; }, get history() { return history.slice(); } };
}

module.exports = { AUTH_COOKIES, NEXUS_COOKIE_HOSTS, BLOCKED_THRESHOLD, domainMatches, authCookieSignal, originPath, createPanelDiary };

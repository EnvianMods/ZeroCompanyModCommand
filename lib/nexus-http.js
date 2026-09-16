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

const { log } = require('./log');

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

// The ZC_NEXUS_*_BASE test seams (see lib/nexus.js) point the client at a
// local mock. Its host counts as a Nexus host so tests exercise exactly the
// routing production uses. Unset — every shipped build — this is empty.
function seamHosts() {
  const out = new Set();
  for (const name of ['ZC_NEXUS_API_BASE', 'ZC_NEXUS_ROUTER_BASE', 'ZC_NEXUS_OAUTH_BASE']) {
    const v = process.env[name];
    if (!v) continue;
    try { out.add(new URL(v).host.toLowerCase()); } catch (_) {}
  }
  return out;
}

// Is this URL one of Nexus Mods' own hosts? Used by the shared downloader,
// which also fetches GitHub release assets — those are not Nexus traffic and
// must not carry Nexus identification or consume Nexus's queue.
function isNexusUrl(url) {
  try {
    const u = new URL(String(url));
    if (/(^|\.)nexusmods\.com$/i.test(u.hostname)) return true;
    return seamHosts().has(u.host.toLowerCase());
  } catch (_) {
    return false;
  }
}

// ------------------------------------------------------------ rate limiting
//
// Nexus tells us exactly how much of the quota is left; the app reads it and
// behaves accordingly instead of guessing.
//
//  * Every v1 response carries the six x-rl-* headers. They are parsed into
//    the shared quota state below, which Settings displays and which every
//    background job consults before it starts a long loop.
//  * A request that the last response said there is no quota for is NOT sent.
//  * A 429 is answered by honouring Retry-After, never by hammering.
//  * The v2 GraphQL endpoints send no quota headers, so the 429/Retry-After
//    and 5xx rules are all that apply there — but they do apply.

const MAX_IN_FLIGHT = 2;          // simultaneous requests to Nexus, app-wide
const BACKGROUND_GAP_MS = 250;    // minimum spacing between background v1 calls
const MAX_RETRY_WAIT_MS = 60_000; // the longest a user-initiated call will wait
const SERVER_ERROR_RETRY_MS = 2_000;
// What a background job leaves untouched so the user's own actions still work.
const RESERVE_HOURLY = 50;
const RESERVE_DAILY = 200;

const quota = {
  hourly: { limit: null, remaining: null, resetAt: null },
  daily: { limit: null, remaining: null, resetAt: null },
  updatedAt: 0,
};

// "2026-09-16 16:00:00 +0000" (and the bare form, which Nexus states in UTC).
function parseResetAt(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\s*([+-])(\d{2}):?(\d{2}))?/.exec(s);
  if (m) {
    let t = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
    if (m[7]) t -= (((+m[8]) * 60 + (+m[9])) * 60_000) * (m[7] === '-' ? -1 : 1);
    return t;
  }
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : t;
}

// Retry-After is either a number of seconds or an HTTP date. Returns ms.
function parseRetryAfter(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  if (/^\d+$/.test(s)) return Number(s) * 1000;
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : Math.max(0, t - Date.now());
}

const num = (v) => {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

function hhmm(at) {
  const d = new Date(at);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

// Thrown instead of sending a request there is no quota for, and instead of
// waiting out a long 429. `retryAt` is when it is worth trying again.
class QuotaExceededError extends Error {
  constructor(retryAt) {
    super(`Nexus Mods request limit reached — try again after ${hhmm(retryAt)}.`);
    this.name = 'QuotaExceededError';
    this.quota = true;
    this.retryAt = retryAt;
  }
}

// Read the six x-rl-* headers off a v1 response. Crossing a reserve, or
// running a window dry, is logged once (never the token, never the
// Authorization header — nothing here touches either).
function noteQuota(headers) {
  const before = { hourly: quota.hourly.remaining, daily: quota.daily.remaining };
  let seen = false;
  for (const [win, prefix] of [['hourly', 'x-rl-hourly'], ['daily', 'x-rl-daily']]) {
    const limit = num(headers.get(`${prefix}-limit`));
    const remaining = num(headers.get(`${prefix}-remaining`));
    const resetAt = parseResetAt(headers.get(`${prefix}-reset`));
    if (limit == null && remaining == null && resetAt == null) continue;
    seen = true;
    quota[win] = { limit, remaining, resetAt };
  }
  if (!seen) return;
  quota.updatedAt = Date.now();
  // Only the transitions are worth a line: the first reading, dropping below
  // the user's reserve, and running the window dry.
  const crossed = (win, reserve) => {
    const was = before[win];
    const now = quota[win].remaining;
    if (now == null) return false;
    if (was == null) return true;
    return (was >= reserve && now < reserve) || (was !== 0 && now === 0);
  };
  if (crossed('hourly', RESERVE_HOURLY)) {
    log('info', `nexus quota: ${quota.hourly.remaining} of ${quota.hourly.limit} requests left this hour`
      + `${quota.hourly.resetAt ? ` (resets ${hhmm(quota.hourly.resetAt)})` : ''}`
      + `${liveRemaining('hourly') < RESERVE_HOURLY ? ' — background jobs stand down, the rest is reserved for you' : ''}`);
  }
  if (crossed('daily', RESERVE_DAILY)) {
    log('info', `nexus quota: ${quota.daily.remaining} of ${quota.daily.limit} requests left today`
      + `${liveRemaining('daily') < RESERVE_DAILY ? ' — background jobs stand down, the rest is reserved for you' : ''}`);
  }
}

// A snapshot for the UI/IPC. Null fields mean "not known yet".
function quotaState() {
  return {
    hourly: { ...quota.hourly },
    daily: { ...quota.daily },
    updatedAt: quota.updatedAt,
    known: quota.updatedAt > 0,
  };
}

// A window whose reset has passed tells us nothing any more.
function liveRemaining(win) {
  const q = quota[win];
  if (q.remaining == null) return null;
  if (q.resetAt && q.resetAt <= Date.now()) return null;
  return q.remaining;
}

// Refuse to send a v1 request the last response said there is no room for.
function assertQuota() {
  for (const win of ['hourly', 'daily']) {
    if (liveRemaining(win) === 0) throw new QuotaExceededError(quota[win].resetAt);
  }
}

// How many v1 requests a background job may make right now while leaving the
// user's reserve intact. null = unknown (nothing fetched yet) — the job runs
// and the first response tells it where it stands.
function backgroundBudget() {
  const h = liveRemaining('hourly');
  const d = liveRemaining('daily');
  if (h == null && d == null) return null;
  const budgets = [];
  if (h != null) budgets.push(h - RESERVE_HOURLY);
  if (d != null) budgets.push(d - RESERVE_DAILY);
  return Math.max(0, Math.min(...budgets));
}

// Should a background loop keep going? Returns { ok, reason, retryAt }.
function backgroundAllowed() {
  const h = liveRemaining('hourly');
  const d = liveRemaining('daily');
  if (h != null && h < RESERVE_HOURLY) {
    return { ok: false, retryAt: quota.hourly.resetAt, reason: `hourly quota down to ${h}, below the ${RESERVE_HOURLY} reserved for you` };
  }
  if (d != null && d < RESERVE_DAILY) {
    return { ok: false, retryAt: quota.daily.resetAt, reason: `daily quota down to ${d}, below the ${RESERVE_DAILY} reserved for you` };
  }
  return { ok: true, retryAt: null, reason: null };
}

// May a background job that will need `count` v1 requests start at all? It may
// not if the quota is already inside the user's reserve, nor if the job is
// simply too big for what is spare. Returns { ok, reason, retryAt }; an unknown
// quota (nothing fetched yet) is a yes, and the first response settles it.
function backgroundPlan(count) {
  const allowed = backgroundAllowed();
  if (!allowed.ok) return allowed;
  const budget = backgroundBudget();
  if (budget != null && Number(count) > budget) {
    return {
      ok: false,
      retryAt: quota.hourly.resetAt,
      reason: `it needs ${count} requests and only ${budget} are spare above the ${RESERVE_HOURLY} reserved for you`,
    };
  }
  return { ok: true, retryAt: null, reason: null };
}

// ------------------------------------------------------------ the queue

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let inFlight = 0;
const waiting = [];
let lastBackgroundAt = 0;

function acquire() {
  if (inFlight < MAX_IN_FLIGHT) { inFlight += 1; return Promise.resolve(); }
  return new Promise((res) => waiting.push(res));
}

function release() {
  const next = waiting.shift();
  if (next) next();      // the slot passes straight to the next waiter
  else inFlight -= 1;
}

// A background request waits out the minimum gap since the last one, so a loop
// over the whole catalog never arrives as a burst.
async function backgroundGap() {
  const due = lastBackgroundAt + BACKGROUND_GAP_MS - Date.now();
  if (due > 0) await sleep(due);
  lastBackgroundAt = Date.now();
}

// ------------------------------------------------------------ the request

// nexusFetch(url, init) — fetch() plus the identification headers, the shared
// queue and the rate-limit rules. `init.kind` says which API this is
// ('v1' | 'v2' | 'cdn' | 'oauth'); `init.background` marks a request made by a
// background job rather than by something the user pressed, and background
// requests never wait — they abort so their job can reschedule itself.
async function nexusFetch(url, init = {}) {
  const { kind = 'other', background = false, ...rest } = init;
  const opts = { ...rest, headers: mergeHeaders(init.headers) };
  if (kind === 'v1') assertQuota(); // before queueing: never occupy a slot we cannot use
  await acquire();
  try {
    return await send(url, opts, { kind, background });
  } finally {
    release();
  }
}

async function send(url, opts, ctx) {
  let retried = false;
  for (;;) {
    if (ctx.background) await backgroundGap();
    if (ctx.kind === 'v1') assertQuota();
    const res = await fetch(url, opts);
    if (ctx.kind === 'v1') noteQuota(res.headers);

    if (res.status === 429) {
      const waitMs = parseRetryAfter(res.headers.get('retry-after'));
      // No Retry-After: fall back to the hourly reset if we know it.
      const reset = quota.hourly.resetAt;
      const retryAt = waitMs != null
        ? Date.now() + waitMs
        : (reset && reset > Date.now() ? reset : Date.now() + MAX_RETRY_WAIT_MS);
      // Background jobs never wait; nor does a second 429, nor a wait the user
      // would not sit through.
      if (ctx.background || retried || waitMs == null || waitMs > MAX_RETRY_WAIT_MS) {
        log('info', `nexus rate limit: 429${waitMs != null ? ` with Retry-After ${Math.ceil(waitMs / 1000)}s` : ''}`
          + ` — ${ctx.background ? 'background job standing down' : 'giving up'} until ${hhmm(retryAt)}`);
        throw new QuotaExceededError(retryAt);
      }
      log('info', `nexus rate limit: 429 with Retry-After ${Math.ceil(waitMs / 1000)}s — waiting once, then retrying`);
      await sleep(waitMs);
      retried = true;
      continue;
    }

    // One retry on a server-side failure, then the caller hears about it.
    if (res.status >= 500 && res.status <= 599 && !retried) {
      log('info', `nexus: ${res.status} from ${new URL(url).host} — one retry in ${SERVER_ERROR_RETRY_MS / 1000}s`);
      await sleep(SERVER_ERROR_RETRY_MS);
      retried = true;
      continue;
    }
    return res;
  }
}

// Tests only: forget what the last response said about the quota.
function resetQuotaForTests() {
  quota.hourly = { limit: null, remaining: null, resetAt: null };
  quota.daily = { limit: null, remaining: null, resetAt: null };
  quota.updatedAt = 0;
  lastBackgroundAt = 0;
}

module.exports = {
  nexusFetch, setAppIdentity, appHeaders, isNexusUrl,
  QuotaExceededError, quotaState, backgroundAllowed, backgroundBudget, backgroundPlan,
  parseResetAt, parseRetryAfter, hhmm,
  MAX_IN_FLIGHT, BACKGROUND_GAP_MS, MAX_RETRY_WAIT_MS, RESERVE_HOURLY, RESERVE_DAILY,
  resetQuotaForTests,
};

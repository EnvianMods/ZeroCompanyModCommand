'use strict';
// Nexus Mods OAuth 2.0 sign-in (Authorization Code + PKCE, RFC 7636).
//
// Nexus Mods forbids third-party apps from asking users for their personal API
// key; a mod manager is a PUBLIC client, so it signs in with the authorization
// code flow, PKCE S256, and NO client secret. The user's browser does the
// login — this app never sees a password, only the tokens Nexus issues.
// Reference: https://modding.wiki/en/api/oauth2-guide
//
// Nothing in here is Electron-specific (the caller opens the browser and stores
// the tokens), and it adds no npm dependency: node's own crypto/http/fetch.

const crypto = require('crypto');
const http = require('http');

// ---------------------------------------------------------------- constants

// PLACEHOLDER CLIENT ID — Nexus Mods issues the real one by email to the app
// author, together with the registered redirect URI below. SWAP THIS ONE LINE
// when the real id arrives (or set ZC_NEXUS_OAUTH_CLIENT_ID to test sooner).
const DEFAULT_CLIENT_ID = 'zero_company_mod_command';

// Endpoints, from https://users.nexusmods.com/.well-known/openid-configuration
const DEFAULT_BASE = 'https://users.nexusmods.com';
const PATHS = {
  authorize: '/oauth/authorize',
  token: '/oauth/token',
  revoke: '/oauth/revoke',
  userinfo: '/oauth/userinfo',
};

// Desktop clients take the callback on a loopback listener. The port and path
// are FIXED because the redirect URI has to be registered with Nexus verbatim —
// it can never be chosen at runtime.
const REDIRECT_HOST = '127.0.0.1';
const REDIRECT_PORT = 47831;
const REDIRECT_PATH = '/callback';
const REDIRECT_URI = `http://${REDIRECT_HOST}:${REDIRECT_PORT}${REDIRECT_PATH}`;

// scopes_supported: ["public", "openid", "mod_file:quarantine"]. The published
// guide's sample sends an empty scope, so that is the fallback if the token
// endpoint ever objects to the explicit pair.
const SCOPE = 'public openid';
const SCOPE_FALLBACK = '';

// The user has to finish the browser half in five minutes.
const CALLBACK_TIMEOUT_MS = 5 * 60 * 1000;

// Access tokens are RS256 JWTs signed by Nexus's user service. Verifying them
// locally is what lets the app trust the username/premium flag it shows without
// a round trip.
const NEXUS_JWT_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAs/57oX8HW8xC+W/etH7J
PgoSTiGPKZa6Gq3/K/7GgrpJcZhPdr9MTGocb2uLzQBJW+u1XpSgyeKH4JCxxeHF
3zcUtb7SUg3KnxlR5QUmOnqBvbUuL4opUpfgWUGltASduYqZBJD2WTK8Hvwh9X1v
ACeqp1zgorZm3f0J2H15TDbzIp9ihCFuthJUFumdzvrt/WvimW2fiyqndTNQwe5h
XM8hj8cemdWQXCd99qnj7UQkpu+yNisVMHQCsAqXITe6Ehp6IY9eCd4DJKjDvyLc
3vbY8UL+bcVK5tYAKemZ56uw3q1YdcyqGlItyLi4j4EISdBQaCCqT7YZUhMYzhUd
1QIDAQAB
-----END PUBLIC KEY-----
`;

const PREMIUM_ROLES = new Set(['premium', 'lifetimepremium']);
const JWT_ISSUER = 'nexus-user-service';
const CLOCK_SKEW_S = 60;

// Everything swappable in one place: the env overrides exist so the flow can be
// pointed at a local mock server in tests, and so the owner can try a real
// client id without a rebuild.
const config = {
  clientId: process.env.ZC_NEXUS_OAUTH_CLIENT_ID || DEFAULT_CLIENT_ID,
  base: process.env.ZC_NEXUS_OAUTH_BASE || DEFAULT_BASE,
  redirectUri: REDIRECT_URI,
  scope: SCOPE,
  publicKey: NEXUS_JWT_PUBLIC_KEY,
  callbackTimeoutMs: CALLBACK_TIMEOUT_MS,
};

function configure(patch) {
  Object.assign(config, patch || {});
  return config;
}

const endpoint = (name) => `${String(config.base).replace(/\/+$/, '')}${PATHS[name]}`;

// ---------------------------------------------------------------- PKCE

const b64url = (buf) => Buffer.from(buf).toString('base64')
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

// RFC 7636 wants 43-128 chars; 48 random bytes base64url to 64.
function makeVerifier(bytes = 48) {
  return b64url(crypto.randomBytes(bytes));
}

function challengeFor(verifier) {
  return b64url(crypto.createHash('sha256').update(String(verifier), 'ascii').digest());
}

function randomState() {
  return b64url(crypto.randomBytes(24));
}

function buildAuthorizeUrl({ state, codeChallenge, clientId, redirectUri, scope } = {}) {
  const url = new URL(endpoint('authorize'));
  url.searchParams.set('client_id', clientId || config.clientId);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', scope === undefined ? config.scope : scope);
  url.searchParams.set('redirect_uri', redirectUri || config.redirectUri);
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('code_challenge', codeChallenge);
  return url.toString();
}

// ---------------------------------------------------------------- loopback callback

const DONE_PAGE = (title, body) => `<!doctype html><html><head><meta charset="utf-8">`
  + `<title>${title}</title><style>body{font:15px/1.6 system-ui,sans-serif;background:#10131a;color:#d8e2f0;`
  + `display:flex;align-items:center;justify-content:center;height:100vh;margin:0;text-align:center}`
  + `div{max-width:30rem;padding:2rem}b{color:#ffd76a}</style></head>`
  + `<body><div><p><b>${title}</b></p><p>${body}</p></div></body></html>`;

// Single-use loopback listener, bound to 127.0.0.1 ONLY so nothing off-machine
// can reach it. Resolves { code } when a request arrives on REDIRECT_PATH whose
// `state` matches; a mismatched state is rejected and the wait continues to its
// timeout, so a stray/forged callback can neither finish nor cancel the flow.
// The reply page never echoes the code.
function startCallbackServer({ state, timeoutMs, port = REDIRECT_PORT, path: cbPath = REDIRECT_PATH } = {}) {
  return new Promise((resolve, reject) => {
    const server = http.createServer();
    let settle = null;
    let timer = null;
    const result = new Promise((res, rej) => { settle = { res, rej }; });

    const finish = (fn, arg) => {
      if (!settle) return;
      const s = settle;
      settle = null;
      if (timer) { clearTimeout(timer); timer = null; }
      fn === 'res' ? s.res(arg) : s.rej(arg);
    };

    server.on('request', (req, res) => {
      let url;
      try { url = new URL(req.url, `http://${REDIRECT_HOST}:${port}`); } catch (_) { url = null; }
      const reply = (code, title, body) => {
        res.writeHead(code, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(DONE_PAGE(title, body));
      };
      if (!url || url.pathname !== cbPath) {
        reply(404, 'Not found', 'This page belongs to Zero Company Mod Command’s sign-in.');
        return;
      }
      const gotState = url.searchParams.get('state') || '';
      if (!safeEqual(gotState, String(state))) {
        reply(400, 'Sign-in could not be verified', 'That response did not match the sign-in this app started. Close this tab and try again from the app.');
        return;
      }
      const err = url.searchParams.get('error');
      if (err) {
        reply(400, 'Sign-in was not completed', 'Nexus Mods declined the request. Close this tab and try again from the app.');
        finish('rej', new Error(`Nexus Mods declined the sign-in (${err}).`));
        return;
      }
      const code = url.searchParams.get('code');
      if (!code) {
        reply(400, 'Sign-in was not completed', 'No authorization code came back. Close this tab and try again from the app.');
        finish('rej', new Error('Nexus Mods sent no authorization code.'));
        return;
      }
      reply(200, 'Signed in', 'You can close this tab and return to Zero Company Mod Command.');
      finish('res', { code });
    });

    server.on('error', (err) => {
      if (err && err.code === 'EADDRINUSE') {
        reject(new Error(`Port ${port} is already in use, so the Nexus sign-in cannot receive its reply. Close whatever is using port ${port} (another copy of this app?) and try again.`));
      } else {
        reject(new Error(`The sign-in listener could not start: ${err.message}`));
      }
      finish('rej', err);
    });

    // 127.0.0.1 only — never 0.0.0.0.
    server.listen(port, REDIRECT_HOST, () => {
      timer = setTimeout(() => {
        finish('rej', new Error('The Nexus Mods sign-in timed out — the browser step was not finished in time. Press Sign in again when you are ready.'));
      }, timeoutMs || config.callbackTimeoutMs);
      if (timer.unref) timer.unref();
      resolve({
        port,
        redirectUri: `http://${REDIRECT_HOST}:${port}${cbPath}`,
        result,
        cancel(reason) { finish('rej', new Error(reason || 'The Nexus Mods sign-in was cancelled.')); },
        close() {
          finish('rej', new Error('The Nexus Mods sign-in was cancelled.'));
          try { server.close(); } catch (_) {}
        },
      });
    });
    result.catch(() => {}); // a rejection nobody has awaited yet must not go unhandled
  });
}

function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length || !ba.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

// ---------------------------------------------------------------- token endpoint

function tokensFrom(json) {
  if (!json || !json.access_token) throw new Error('Nexus Mods returned no access token.');
  const now = Date.now();
  return {
    access_token: json.access_token,
    refresh_token: json.refresh_token || null,
    expires_at: now + (Number(json.expires_in) || 0) * 1000,
    obtained_at: now,
  };
}

// POST the form. A 4xx is the "you are no longer authorized" signal on refresh,
// so it is flagged for the caller. The body is never logged — it carries tokens.
async function postForm(params) {
  const res = await fetch(endpoint('token'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams(params).toString(),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_) {}
  if (!res.ok) {
    const err = new Error(`Nexus Mods rejected the sign-in (${res.status}${json && json.error ? ` ${json.error}` : ''}).`);
    err.status = res.status;
    err.oauthError = (json && json.error) || null;
    err.clientError = res.status >= 400 && res.status < 500;
    throw err;
  }
  return tokensFrom(json);
}

// Some deployments reject an explicit scope on the token call; the guide's own
// sample sends none. Try the real scope, fall back once.
async function postFormWithScope(params) {
  try {
    return await postForm({ ...params, scope: config.scope });
  } catch (err) {
    if (err.clientError && config.scope !== SCOPE_FALLBACK) {
      return postForm({ ...params, scope: SCOPE_FALLBACK });
    }
    throw err;
  }
}

async function exchangeCode({ code, codeVerifier, clientId, redirectUri } = {}) {
  return postFormWithScope({
    grant_type: 'authorization_code',
    client_id: clientId || config.clientId,
    redirect_uri: redirectUri || config.redirectUri,
    code,
    code_verifier: codeVerifier,
  });
}

async function refreshTokens(refreshToken, { clientId } = {}) {
  try {
    return await postForm({
      grant_type: 'refresh_token',
      client_id: clientId || config.clientId,
      refresh_token: refreshToken,
    });
  } catch (err) {
    // 4xx here means the grant is gone — the user revoked the app, or the
    // refresh token expired. The caller must treat that as signed out.
    if (err.clientError) err.revoked = true;
    throw err;
  }
}

// Best-effort: a failure here must never block signing out locally.
async function revoke(token, { clientId } = {}) {
  if (!token) return false;
  try {
    const res = await fetch(endpoint('revoke'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token, client_id: clientId || config.clientId }).toString(),
    });
    return res.ok;
  } catch (_) {
    return false;
  }
}

// ---------------------------------------------------------------- the access token itself

function b64urlDecode(part) {
  const pad = part.length % 4 ? '='.repeat(4 - (part.length % 4)) : '';
  return Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64');
}

// Verify the RS256 signature against Nexus's public key and check the claims.
// A token that fails is REFUSED — the app would otherwise be trusting a
// username and premium flag that anyone could have written.
function decodeAndVerifyJwt(token, { ignoreExpiry = false, publicKey } = {}) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) throw new Error('That Nexus Mods access token is not a readable JWT.');
  const [h, p, s] = parts;
  let header;
  let payload;
  try {
    header = JSON.parse(b64urlDecode(h).toString('utf8'));
    payload = JSON.parse(b64urlDecode(p).toString('utf8'));
  } catch (_) {
    throw new Error('That Nexus Mods access token could not be decoded.');
  }
  if (!header || header.alg !== 'RS256') throw new Error('That Nexus Mods access token is not signed with RS256.');
  let ok = false;
  try {
    ok = crypto.verify('RSA-SHA256', Buffer.from(`${h}.${p}`, 'ascii'),
      publicKey || config.publicKey, b64urlDecode(s));
  } catch (_) {
    ok = false;
  }
  if (!ok) throw new Error('That Nexus Mods access token failed signature verification.');
  if (payload.iss && payload.iss !== JWT_ISSUER) throw new Error('That Nexus Mods access token came from an unexpected issuer.');
  if (!ignoreExpiry && payload.exp && Number(payload.exp) + CLOCK_SKEW_S < Math.floor(Date.now() / 1000)) {
    throw new Error('That Nexus Mods access token has expired.');
  }
  return payload;
}

// { id, name, isPremium, roles } from a verified token.
function userFromToken(token, opts) {
  const payload = decodeAndVerifyJwt(token, opts);
  const u = payload.user || {};
  const roles = Array.isArray(u.membership_roles) ? u.membership_roles.map((r) => String(r).toLowerCase()) : [];
  return {
    id: u.id != null ? u.id : (payload.sub != null ? Number(payload.sub) : null),
    name: u.username || u.name || null,
    isPremium: roles.some((r) => PREMIUM_ROLES.has(r)),
    roles,
  };
}

module.exports = {
  // constants the app and its docs quote
  DEFAULT_CLIENT_ID, DEFAULT_BASE, PATHS, SCOPE, SCOPE_FALLBACK,
  REDIRECT_HOST, REDIRECT_PORT, REDIRECT_PATH, REDIRECT_URI, CALLBACK_TIMEOUT_MS,
  NEXUS_JWT_PUBLIC_KEY,
  // configuration
  config, configure, endpoint,
  // PKCE + authorize
  makeVerifier, challengeFor, randomState, buildAuthorizeUrl,
  // loopback
  startCallbackServer,
  // token endpoint
  exchangeCode, refreshTokens, revoke, tokensFrom,
  // the token itself
  decodeAndVerifyJwt, userFromToken,
};

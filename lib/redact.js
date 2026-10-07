'use strict';
// Secret redaction — the ONE scrubber every outbound text path runs through:
// the session log (lib/log.js), the support report (lib/report.js) and the
// error text an IPC call hands back to the renderer (main.js fail()).
//
// What it removes:
//   - any secret registered at runtime (the Nexus OAuth access and refresh
//     tokens), wherever it appears, verbatim;
//   - `apikey` / `Authorization` header values ("Authorization: Bearer …",
//     "apikey=…", JSON `"apikey":"…"`);
//   - the whole query string of every http(s):// and nxm:// URL — nxm links
//     carry a short-lived `key=`/`expires=`/`user_id=`, and the Nexus CDN's
//     download URLs are signed in their query (md5/expires/st/e…). The host
//     and path stay, which is all a bug report ever needs;
//   - loose `key=` / `expires=` / `user_id=` / `token=` pairs outside a URL
//     (e.g. a bare "download_link.json?key=…" path);
//   - the Nexus ACCOUNT NAME: once registered (registerAccountName, from the
//     sign-in), every whole-word occurrence becomes its masked form
//     (maskAccountName: the first 2 characters + "***"), so the log and the
//     support report can say an account is signed in without naming it.
// It is deliberately blunt: a log line losing a harmless ?tab=files is fine;
// a log line keeping a signed link is not.

const MASK = '<redacted>';
const MIN_SECRET_LEN = 6;
const secrets = new Set();
const accountNames = new Set();

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

// Remember a live secret so any later text containing it verbatim is masked.
function registerSecret(value) {
  const v = typeof value === 'string' ? value.trim() : '';
  if (v.length >= MIN_SECRET_LEN) secrets.add(v);
}

// "Envian" -> "En***". Short names keep less: 1-2 characters -> first + "***".
function maskAccountName(name) {
  const n = String(name == null ? '' : name).trim();
  if (!n) return '?';
  return `${n.slice(0, n.length > 2 ? 2 : 1)}***`;
}

// Remember the Nexus account name so any later text naming it is masked.
function registerAccountName(name) {
  const n = typeof name === 'string' ? name.trim() : '';
  if (n.length >= 3) accountNames.add(n);
}

const URL_QUERY_RE = /\b((?:https?|nxm):\/\/[^\s"'<>?#]*)\?[^\s"'<>#]+/gi; // `+`: an already-masked "?<redacted>" is left alone
const HEADER_RE = /(["']?\b(?:apikey|api[-_]key|authorization|x-api-key)\b["']?\s*[:=]\s*["']?)(?:Bearer\s+)?[^\s"',;}&]+/gi;
const PARAM_RE = /([?&\s]\b(?:key|expires|user_id|token|access_token|refresh_token|signature|md5|st)=)[^&\s"'<>#]+/gi;

function redactSecrets(text) {
  if (text == null) return text;
  let out = String(text);
  for (const s of secrets) out = out.replace(new RegExp(escapeRe(s), 'g'), MASK);
  for (const n of accountNames) {
    out = out.replace(new RegExp(`(^|[^A-Za-z0-9_.-])${escapeRe(n)}(?![A-Za-z0-9_-])`, 'gi'), (_m, pre) => `${pre}${maskAccountName(n)}`);
  }
  out = out.replace(URL_QUERY_RE, `$1?${MASK}`);
  out = out.replace(HEADER_RE, `$1${MASK}`);
  out = out.replace(PARAM_RE, `$1${MASK}`);
  return out;
}

module.exports = { redactSecrets, registerSecret, maskAccountName, registerAccountName, MASK };

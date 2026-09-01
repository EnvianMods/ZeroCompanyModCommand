'use strict';
// Featured-creator roster for the Holonet promo strip.
//
// This is OWNER-CONTROLLED, not a user setting. Two layers:
//
//  1. FALLBACK_AUTHORS — baked into the launcher; changes ship with launcher updates.
//  2. REMOTE_ROSTER_URL — optional live override. Point this at a JSON file YOU
//     control (e.g. a GitHub Gist raw URL or a raw file in your repo) shaped like:
//         { "promotedAuthors": ["SmexyXey", "EnvianMN"] }
//     Every installed launcher fetches it at runtime, so editing that one file
//     updates the roster for everyone WITHOUT shipping a launcher update.
//     Leave null to use the baked-in list only.

const FALLBACK_AUTHORS = ['SmexyXey', 'EnvianMN'];
// Owner-hosted roster: edit with owner-tools/update-featured-authors (pushes
// featured.json to the EnvianMods/SWZeroCompanyFeaturedAuthors repo). Falls back
// to FALLBACK_AUTHORS until that file exists or when offline.
const REMOTE_ROSTER_URL = 'https://raw.githubusercontent.com/EnvianMods/SWZeroCompanyFeaturedAuthors/main/featured.json';

let remoteCache = { authors: null, at: 0 };
const REMOTE_TTL_MS = 10 * 60 * 1000;

async function getPromotedAuthors() {
  if (!REMOTE_ROSTER_URL) return FALLBACK_AUTHORS;
  const now = Date.now();
  if (remoteCache.authors && now - remoteCache.at < REMOTE_TTL_MS) return remoteCache.authors;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 6000);
    const res = await fetch(REMOTE_ROSTER_URL, { signal: controller.signal, cache: 'no-store' });
    clearTimeout(timer);
    if (res.ok) {
      const json = await res.json();
      const authors = Array.isArray(json.promotedAuthors)
        ? json.promotedAuthors.map((a) => String(a).trim()).filter(Boolean).slice(0, 20)
        : null;
      if (authors && authors.length) {
        remoteCache = { authors, at: now };
        return authors;
      }
    }
  } catch (_) { /* offline or bad file — fall back */ }
  return remoteCache.authors || FALLBACK_AUTHORS;
}

module.exports = { getPromotedAuthors, FALLBACK_AUTHORS };

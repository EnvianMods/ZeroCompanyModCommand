'use strict';
// Nexus FILE-NAME index: every mod in the game's catalog -> the stems of its
// uploaded files. An adopted mod is named after the ARCHIVE it came from
// ("ZCUnlocked"), which is often nothing like the Nexus page title ("Full
// Customization Mod-Mandalorian Padawan and more") but always matches a file's
// display name. This index is how a bare local name finds its page.
//
// Cached on disk. The catalog walk is anonymous (GraphQL); the per-mod file
// list is the keyed v1 API, so it is fetched only for mods that are new or
// whose updatedAt changed since the cached entry — a repeat scan within the
// TTL costs no keyed calls at all.
const fs = require('fs');
const path = require('path');
const nexus = require('./nexus');

const TTL_MS = 24 * 60 * 60 * 1000;

// "ZCUnlocked 34 1.3.5.1 ….zip" / "Walkmod 1.1" / "ZCUnlocked By SmexyXey"
// all reduce to a bare lowercase alnum stem ("zcunlocked", "walkmod").
function stem(s) {
  return String(s || '').toLowerCase()
    .replace(/\bby\s+.+$/, '')
    .replace(/\.(zip|7z|rar|pak)$/i, '')
    .replace(/\d+(?:\.\d+)*/g, '')
    .replace(/[^a-z0-9]+/g, '');
}

function stemsMatch(have, want) {
  if (!have || !want) return false;
  if (have === want) return true;
  const shorter = have.length <= want.length ? have : want;
  return shorter.length >= 5 && (have.includes(want) || want.includes(have));
}

class FileIndex {
  constructor(file) {
    this.file = file;
    this.entries = {};   // modId -> { modId, name, author, version, updatedAt, stems[] }
    this.builtAt = 0;
    this._load();
  }

  _load() {
    try {
      const j = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.entries = j.entries || {};
      this.builtAt = j.builtAt || 0;
    } catch (_) { /* no index yet */ }
  }

  _save() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify({ builtAt: this.builtAt, entries: this.entries }));
    } catch (_) { /* best-effort cache */ }
  }

  fresh() { return this.builtAt > 0 && (Date.now() - this.builtAt) < TTL_MS; }
  size() { return Object.keys(this.entries).length; }

  // Bring the index up to date. onProgress(done, total) fires per catalog mod.
  // Returns true when the index is usable afterwards.
  async refresh(apiKey, onProgress, { force = false } = {}) {
    if (this.fresh() && !force) return true;
    if (!apiKey) return this.size() > 0;
    let all;
    try { all = await nexus.catalog(); } catch (_) { return this.size() > 0; }
    let done = 0;
    for (const m of all) {
      const key = String(m.modId);
      const prev = this.entries[key];
      if (!prev || prev.updatedAt !== m.updatedAt) {
        let stems = prev ? prev.stems : [];
        try {
          const files = await nexus.filesList(m.modId, apiKey);
          stems = [...new Set(files.flatMap((f) => [stem(f.name), stem(f.file_name)]).filter((s) => s.length >= 4))];
        } catch (_) { /* keep the previous stems, if any */ }
        this.entries[key] = { modId: m.modId, name: m.name, author: m.author || '', version: m.version || null, updatedAt: m.updatedAt, stems };
      } else {
        Object.assign(prev, { name: m.name, author: m.author || '', version: m.version || null });
      }
      done += 1;
      if (onProgress) onProgress(done, all.length);
    }
    const live = new Set(all.map((m) => String(m.modId)));
    for (const k of Object.keys(this.entries)) if (!live.has(k)) delete this.entries[k];
    this.builtAt = Date.now();
    this._save();
    return true;
  }

  // Catalog mods with an uploaded file named like `localName`, exact stem
  // matches first. Each hit carries `exact` so callers can rank an identical
  // file name ("ZCUnlocked" == "ZCUnlocked") above a merely similar one.
  find(localName) {
    const want = stem(localName);
    if (want.length < 4) return [];
    const out = [];
    for (const e of Object.values(this.entries)) {
      if (e.stems.includes(want)) out.push({ ...e, exact: true });
      else if (e.stems.some((h) => stemsMatch(h, want))) out.push({ ...e, exact: false });
    }
    return out.sort((a, b) => Number(b.exact) - Number(a.exact));
  }
}

module.exports = { FileIndex, stem, stemsMatch };

'use strict';
// FOMOD guided-installer support. The installer script is READ, never executed:
// ModuleConfig.xml goes to the renderer's wizard (parsed there with DOMParser),
// the chosen source→destination copies come back here, and every path is
// re-validated before a byte is written.

const fs = require('fs');
const path = require('path');

const IMAGE_EXTS = new Map([
  ['.png', 'image/png'], ['.jpg', 'image/jpeg'], ['.jpeg', 'image/jpeg'],
  ['.gif', 'image/gif'], ['.webp', 'image/webp'], ['.bmp', 'image/bmp'],
]);
const IMAGE_MAX_BYTES = 4 * 1024 * 1024;

// A relative path from an installer script: no absolute paths, no drive
// letters, no parent-directory escapes. Returns the normalized form.
function safeRel(rel, label) {
  const cleaned = String(rel || '').replace(/[\\/]+/g, path.sep).replace(/^[\\/]+|[\\/]+$/g, '');
  if (/^[A-Za-z]:/.test(cleaned) || path.isAbsolute(cleaned)) {
    throw new Error(`The installer script used an absolute ${label} path — install refused.`);
  }
  const norm = path.normalize(cleaned);
  if (norm === '..' || norm.startsWith('..' + path.sep)) {
    throw new Error(`The installer script tried to reach outside the archive (${label}) — install refused.`);
  }
  return norm === '.' ? '' : norm;
}

// Case-insensitive lookup of one path segment inside a directory.
function findEntry(dir, name) {
  try {
    for (const entry of fs.readdirSync(dir)) {
      if (entry.toLowerCase() === name.toLowerCase()) return entry;
    }
  } catch (_) {}
  return null;
}

// Resolve a script-relative path against the on-disk extraction, segment by
// segment and case-insensitively (scripts routinely disagree with the archive
// about case). Returns the absolute path, or null when a segment is missing.
function resolveInsensitive(base, rel) {
  let cur = base;
  for (const seg of rel.split(path.sep)) {
    if (!seg) continue;
    const found = findEntry(cur, seg);
    if (!found) return null;
    cur = path.join(cur, found);
  }
  return cur;
}

function parseInfoXml(xml) {
  const pick = (tag) => {
    const m = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i'));
    if (!m) return null;
    const text = m[1]
      .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
      .replace(/<[^>]+>/g, '')
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'").replace(/&amp;/g, '&')
      .trim();
    return text || null;
  };
  return {
    name: pick('Name'),
    author: pick('Author'),
    version: pick('Version'),
    description: pick('Description'),
  };
}

// Look for fomod/ModuleConfig.xml at the extraction root or one wrapper folder
// down. Returns { baseDir, moduleXml, info } or null.
function detect(root) {
  const candidates = [''];
  try {
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (entry.isDirectory()) candidates.push(entry.name);
    }
  } catch (_) { return null; }
  for (const base of candidates) {
    const baseAbs = path.join(root, base);
    const fomodDir = findEntry(baseAbs, 'fomod');
    if (!fomodDir) continue;
    const fomodAbs = path.join(baseAbs, fomodDir);
    const configName = findEntry(fomodAbs, 'ModuleConfig.xml');
    if (!configName) continue;
    let moduleXml;
    try { moduleXml = fs.readFileSync(path.join(fomodAbs, configName), 'utf8'); } catch (_) { continue; }
    let info = {};
    const infoName = findEntry(fomodAbs, 'info.xml');
    if (infoName) {
      try { info = parseInfoXml(fs.readFileSync(path.join(fomodAbs, infoName), 'utf8')); } catch (_) {}
    }
    return { baseDir: base, moduleXml, info };
  }
  return null;
}

function copyTree(srcDir, dstDir) {
  fs.mkdirSync(dstDir, { recursive: true });
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    const src = path.join(srcDir, entry.name);
    const dst = path.join(dstDir, entry.name);
    if (entry.isSymbolicLink()) continue; // already stripped at extraction; belt & braces
    if (entry.isDirectory()) copyTree(src, dst);
    else fs.copyFileSync(src, dst);
  }
}

// Apply the wizard's copy list (already priority-ordered, later entries win)
// into destRoot. Sources resolve inside the extracted archive; destinations
// stay inside destRoot — both are enforced here, not in the UI.
function materialize(root, baseDir, selections, destRoot) {
  if (!Array.isArray(selections) || !selections.length) {
    throw new Error('The guided install selected no files.');
  }
  fs.mkdirSync(destRoot, { recursive: true });
  const scriptBase = path.join(root, safeRel(baseDir, 'base'));
  for (const sel of selections) {
    const srcRel = safeRel(sel.source, 'source');
    if (!srcRel) throw new Error('The installer script used an empty source path — install refused.');
    const dstRel = safeRel(sel.destination != null ? sel.destination : sel.source, 'destination');
    const srcAbs = resolveInsensitive(scriptBase, srcRel);
    if (!srcAbs) throw new Error(`The installer script references "${sel.source}", which is not in the archive.`);
    const stat = fs.statSync(srcAbs);
    const dstAbs = path.join(destRoot, dstRel);
    if (stat.isDirectory()) {
      copyTree(srcAbs, dstAbs);
    } else {
      // An empty destination for a file means "archive layout": keep the source path.
      const fileDst = dstRel ? dstAbs : path.join(destRoot, srcRel);
      fs.mkdirSync(path.dirname(fileDst), { recursive: true });
      fs.copyFileSync(srcAbs, fileDst);
    }
  }
}

// Option image for the wizard, as a data URL. PNG/JPEG/GIF/WebP/BMP up to 4 MB;
// anything else returns null and the option simply shows without a picture.
function readImage(root, baseDir, rel) {
  let srcRel;
  try { srcRel = safeRel(rel, 'image'); } catch (_) { return null; }
  const abs = resolveInsensitive(path.join(root, safeRel(baseDir, 'base')), srcRel);
  if (!abs) return null;
  const mime = IMAGE_EXTS.get(path.extname(abs).toLowerCase());
  if (!mime) return null;
  try {
    if (fs.statSync(abs).size > IMAGE_MAX_BYTES) return null;
    return `data:${mime};base64,${fs.readFileSync(abs).toString('base64')}`;
  } catch (_) { return null; }
}

module.exports = { detect, materialize, readImage, safeRel };

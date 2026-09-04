'use strict';
// Upload a release zip to the Nexus mod page via the v3 API (personal API key).
// Flow (proven 2026-09-03 for the v1.0.0 upload):
//   GET  /v3/games/<domain>/mods/<id>            -> global mod id ("uid")
//   POST /v3/uploads {size_bytes, filename, md5} -> {id, presigned_url}
//   PUT  bytes -> presigned_url  (Content-Disposition attachment, Content-MD5
//        base64, Content-Type application/octet-stream — signed; zip fails)
//   POST /v3/uploads/<id>/finalise
//   GET  /v3/uploads/<id> until state=available
//   POST /v3/mod-files {upload_id, mod_id(global), name, version,
//        file_category:"main", primary_mod_manager_download:true}
//
// Usage: node upload-nexus-file.js <version> <zipPath> [--mod-id 121]
//        [--name "Zero Company Mod Command"] [--category main|optional]
//        [--no-primary] [--dry-run]
// The Windows zip stays the main + primary Mod Manager Download; extra
// platform files (e.g. the Linux AppImage) go up as --category optional --no-primary.
// API key: nexus-key.txt beside this script, env NEXUS_API_KEY, or the dev
// store's plaintext nexusApiKey (pre-1.1.0 stores only — 1.1.0 encrypts it).

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const GAME_DOMAIN = 'starwarszerocompany';
const V3 = 'https://api.nexusmods.com/v3';

function arg(flag, dflt) {
  const i = process.argv.indexOf(flag);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}

function findKey() {
  const keyFile = path.join(__dirname, 'nexus-key.txt');
  if (fs.existsSync(keyFile)) return fs.readFileSync(keyFile, 'utf8').trim();
  if (process.env.NEXUS_API_KEY) return process.env.NEXUS_API_KEY.trim();
  try {
    const store = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'data', 'manager-data.json'), 'utf8'));
    if (store.settings && store.settings.nexusApiKey) return store.settings.nexusApiKey;
    if (store.settings && store.settings.nexusApiKeyEncrypted) {
      console.error('The dev store key is encrypted (v1.1.0+). Put the key in nexus-key.txt beside this script, or set NEXUS_API_KEY.');
    }
  } catch (_) {}
  return null;
}

async function api(method, pathname, apiKey, body) {
  const res = await fetch(`${V3}${pathname}`, {
    method,
    headers: {
      apikey: apiKey,
      'Content-Type': 'application/json',
      'Application-Name': 'zero-company-mod-command-owner-tools',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${pathname} -> ${res.status} ${res.statusText}: ${text.slice(0, 300)}`);
  try {
    const json = JSON.parse(text);
    // v3 wraps payloads as { data: ... } — unwrap when that's all there is.
    return json && json.data !== undefined && Object.keys(json).length === 1 ? json.data : json;
  } catch (_) { return text; }
}

(async () => {
  const [version, zipPath] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  const modId = Number(arg('--mod-id', '121'));
  const fileName = arg('--name', null);
  const dryRun = process.argv.includes('--dry-run');
  if (!version || !zipPath) {
    console.error('Usage: node upload-nexus-file.js <version> <zipPath> [--mod-id 121] [--name "..."] [--dry-run]');
    process.exit(1);
  }
  const apiKey = findKey();
  if (!apiKey) { console.error('No Nexus API key found (nexus-key.txt, NEXUS_API_KEY, or pre-1.1.0 dev store).'); process.exit(1); }

  const data = fs.readFileSync(zipPath);
  const md5hex = crypto.createHash('md5').update(data).digest('hex');
  const md5b64 = Buffer.from(md5hex, 'hex').toString('base64');
  const basename = path.basename(zipPath);
  console.log(`file: ${basename} (${(data.length / 1048576).toFixed(1)} MB), md5 ${md5hex}`);

  const mod = await api('GET', `/games/${GAME_DOMAIN}/mods/${modId}`, apiKey);
  // Response shape: { data: { id: "<global>", game_scoped_id: "<modId>", game_id } }
  const globalId = mod.data ? mod.data.id : (mod.uid || mod.id);
  if (!globalId) throw new Error(`could not read the global mod id from: ${JSON.stringify(mod).slice(0, 200)}`);
  console.log(`mod ${modId} -> global id ${globalId}`);
  if (dryRun) { console.log('dry-run: stopping before upload.'); return; }

  // Files over 100 MiB must go through the multipart flow (50 MiB parts).
  const SINGLE_PART_MAX = 100 * 1024 * 1024;
  let upload;
  if (data.length > SINGLE_PART_MAX) {
    upload = await api('POST', '/uploads/multipart', apiKey, {
      size_bytes: data.length, filename: basename, md5: md5hex,
    });
    const partSize = upload.part_size_bytes;
    const urls = upload.part_presigned_urls;
    console.log(`multipart upload id ${upload.id}: ${urls.length} part(s) of ≤${(partSize / 1048576).toFixed(0)} MB`);
    const etags = [];
    for (let i = 0; i < urls.length; i++) {
      const chunk = data.subarray(i * partSize, Math.min((i + 1) * partSize, data.length));
      const put = await fetch(urls[i], { method: 'PUT', body: chunk });
      if (!put.ok) throw new Error(`PUT part ${i + 1} -> ${put.status} ${put.statusText}: ${(await put.text()).slice(0, 300)}`);
      etags.push({ part_number: i + 1, etag: (put.headers.get('etag') || '').replace(/"/g, '') });
      process.stdout.write(`part ${i + 1}/${urls.length} done\n`);
    }
    // S3 CompleteMultipartUpload via the presigned completion URL (XML body
    // listing every part's ETag), then the normal v3 finalise.
    const xml = '<CompleteMultipartUpload>'
      + etags.map((e) => `<Part><PartNumber>${e.part_number}</PartNumber><ETag>"${e.etag}"</ETag></Part>`).join('')
      + '</CompleteMultipartUpload>';
    const complete = await fetch(upload.complete_presigned_url, { method: 'POST', body: xml });
    const completeText = await complete.text();
    if (!complete.ok || /<Error>/.test(completeText)) {
      throw new Error(`multipart completion failed (${complete.status}): ${completeText.slice(0, 300)}`);
    }
    await api('POST', `/uploads/${upload.id}/finalise`, apiKey);
  } else {
    upload = await api('POST', '/uploads', apiKey, {
      size_bytes: data.length, filename: basename, md5: md5hex,
    });
    console.log(`upload id ${upload.id}, pushing bytes…`);
    const put = await fetch(upload.presigned_url, {
      method: 'PUT',
      headers: {
        'Content-Disposition': `attachment; filename="${basename}"`,
        'Content-MD5': md5b64,
        'Content-Type': 'application/octet-stream',
      },
      body: data,
    });
    if (!put.ok) throw new Error(`PUT presigned -> ${put.status} ${put.statusText}: ${(await put.text()).slice(0, 300)}`);
    await api('POST', `/uploads/${upload.id}/finalise`, apiKey);
  }
  process.stdout.write('finalised, waiting for scan');
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 5000));
    const status = await api('GET', `/uploads/${upload.id}`, apiKey);
    const state = status.state || status.status;
    process.stdout.write('.');
    if (state === 'available') { console.log(' available'); break; }
    if (i === 59) throw new Error(`upload never became available (last state: ${state})`);
  }

  const file = await api('POST', '/mod-files', apiKey, {
    upload_id: upload.id,
    mod_id: globalId,
    name: fileName || basename.replace(/\.zip$/i, ''),
    version,
    file_category: arg('--category', 'main'),
    primary_mod_manager_download: !process.argv.includes('--no-primary'),
  });
  console.log('mod file created:', JSON.stringify(file).slice(0, 300));
  console.log(`done — https://www.nexusmods.com/${GAME_DOMAIN}/mods/${modId}?tab=files`);
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });

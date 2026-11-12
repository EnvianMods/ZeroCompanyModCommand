'use strict';
// ZCSDK Runtime download integrity (2026-11-12 security review M1, L8, L9):
// SHA-256 + size checks before anything is extracted, the pinned release URL,
// the asset-name pin, the anti-downgrade rule, the bundled-copy pin written
// by build/fetch-tools.js, and download file names that can never leave the
// download folder. Temp files only; `fetch` is stubbed (no network).
// Run: node --test test/*.test.js
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const Z = require('../lib/zcsdk');
const nexus = require('../lib/nexus');
const fetchTools = require('../build/fetch-tools');

const REPO = 'https://github.com/EnvianMods/ZCSDK-Runtime-Release/releases/download';
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'zc-rtint-'));
const quiet = () => Z.configure({ warn: () => {} });

function zipFile(dir, name = 'rt.zip', bytes = Buffer.from('PK\x03\x04 fake runtime zip ' + 'x'.repeat(200))) {
  const f = path.join(dir, name);
  fs.writeFileSync(f, bytes);
  return { file: f, bytes, sha256: sha(bytes), size: bytes.length };
}

function entry(version, extra = {}) {
  return {
    version, bridge: '0.7.3', loader: '1.8.54',
    asset: `ZCSDKRuntime_v${version}.zip`,
    url: `${REPO}/v${version}/ZCSDKRuntime_v${version}.zip`,
    published: '2026-11-12T00:00:00Z',
    ...extra,
  };
}
const H = { sha256: 'a'.repeat(64), size: 1234 };

async function withFetch(impl, fn) {
  const real = globalThis.fetch;
  globalThis.fetch = impl;
  try { return await fn(); } finally { globalThis.fetch = real; }
}
const jsonRes = (obj) => new Response(JSON.stringify(obj), { status: 200, headers: { 'content-type': 'application/json' } });

// ---- (a) verifyRuntimeZip ---------------------------------------------------

test('verifyRuntimeZip: the right sha256 + size pass; an uppercase hash is the same hash', async () => {
  const d = tmp();
  const z = zipFile(d);
  assert.strictEqual(await Z.verifyRuntimeZip(z.file, { sha256: z.sha256, size: z.size }), z.sha256);
  assert.strictEqual(await Z.verifyRuntimeZip(z.file, { sha256: z.sha256.toUpperCase(), size: z.size }), z.sha256);
});

test('verifyRuntimeZip: a one-byte flip, a wrong size or a missing pin throws', async () => {
  const d = tmp();
  const z = zipFile(d);
  const flipped = Buffer.from(z.bytes); flipped[10] ^= 1;
  fs.writeFileSync(z.file, flipped);
  await assert.rejects(Z.verifyRuntimeZip(z.file, { version: '0.15.1', sha256: z.sha256, size: z.size }),
    /ZCSDK Runtime 0\.15\.1 failed its integrity check \(expected [0-9a-f]{12}…, got [0-9a-f]{12}…\)\./);
  fs.writeFileSync(z.file, z.bytes);
  await assert.rejects(Z.verifyRuntimeZip(z.file, { sha256: z.sha256, size: z.size + 1 }), /integrity check/);
  await assert.rejects(Z.verifyRuntimeZip(z.file, { sha256: null, size: z.size }), /integrity check/);
  await assert.rejects(Z.verifyRuntimeZip(path.join(d, 'missing.zip'), { sha256: z.sha256, size: z.size }), /no file/);
});

// ---- (a) latest.json gate + anti-downgrade ---------------------------------

test('latest.json 0.15.1 without sha256 → latestRuntime() is null (offline); 0.15 without fields is accepted', async () => {
  Z._resetForTests(); quiet();
  await withFetch(async () => jsonRes(entry('0.15.1')), async () => {
    assert.strictEqual(await Z.latestRuntime({ force: true }), null);
  });
  await withFetch(async () => jsonRes(entry('0.15')), async () => {
    const info = await Z.latestRuntime({ force: true });
    assert.ok(info);
    assert.strictEqual(info.version, '0.15');
    assert.strictEqual(info.sha256, null);
  });
  await withFetch(async () => jsonRes(entry('0.15.1', H)), async () => {
    const info = await Z.latestRuntime({ force: true });
    assert.strictEqual(info.sha256, H.sha256);
    assert.strictEqual(info.size, H.size);
  });
});

test('latest.json: malformed sha256/size, or only one of them, is refused at any version', () => {
  quiet();
  const p = { seen: false };
  assert.strictEqual(Z.parseLatest(entry('0.15.1', { sha256: 'z'.repeat(64), size: 5 }), p), null);
  assert.strictEqual(Z.parseLatest(entry('0.15.1', { sha256: 'a'.repeat(63), size: 5 }), p), null);
  assert.strictEqual(Z.parseLatest(entry('0.15.1', { sha256: H.sha256, size: '5' }), p), null);
  assert.strictEqual(Z.parseLatest(entry('0.15.1', { sha256: H.sha256, size: -1 }), p), null);
  assert.strictEqual(Z.parseLatest(entry('0.14', { sha256: H.sha256 }), p), null);
  assert.strictEqual(Z.parseLatest(entry('0.14', { size: 5 }), p), null);
  assert.strictEqual(Z.parseLatest(entry('0.15.1', { sha256: H.sha256.toUpperCase(), size: H.size }), p).sha256, H.sha256);
});

test('after zcsdkHashSeen, hashless entries are refused (0.16, and an older 0.14 too)', async () => {
  Z._resetForTests(); quiet();
  let saved = 0;
  Z.configure({ hashSeen: false, onHashSeen: () => { saved++; } });
  await withFetch(async () => jsonRes(entry('0.15.1', H)), () => Z.latestRuntime({ force: true }));
  assert.strictEqual(saved, 1, 'the first hashed latest.json persists zcsdkHashSeen');
  await withFetch(async () => jsonRes(entry('0.16')), async () => {
    assert.strictEqual(await Z.latestRuntime({ force: true }), null);
  });
  await withFetch(async () => jsonRes(entry('0.14')), async () => {
    assert.strictEqual(await Z.latestRuntime({ force: true }), null);
  });
  // A fresh start with the persisted setting refuses them as well.
  Z._resetForTests(); quiet();
  Z.configure({ hashSeen: true });
  assert.strictEqual(Z.parseLatest(entry('0.14')), null);
  assert.ok(Z.parseLatest(entry('0.16', H)));
  Z._resetForTests();
});

// ---- (a) the install path: verify before extracting ------------------------

test('wrong hash: the download is deleted, never installed, and only a bundled copy whose pin verifies is used', async () => {
  const d = tmp();
  const good = zipFile(d, 'bundled.zip');
  const pkg = { source: 'github', ...entry('0.15.1', { sha256: 'b'.repeat(64), size: 99 }) };
  const installs = [];
  const install = (zip) => installs.push(zip);
  let dl = null;
  const download = async () => { dl = zipFile(d, 'ZCSDKRuntime_v0.15.1.zip', Buffer.from('tampered')).file; return dl; };

  // 1. A bundled copy whose pin verifies → it is installed instead.
  const bundledOk = { source: 'bundled', zip: good.file, version: '0.15.1', sha256: good.sha256, size: good.size };
  const prep = await Z.prepareRuntimeZip(pkg, { download, bundled: bundledOk });
  install(prep.zipPath);
  assert.strictEqual(fs.existsSync(dl), false, 'the bad download is deleted');
  assert.strictEqual(prep.integrityFailed, true);
  assert.strictEqual(prep.fallback, true);
  assert.strictEqual(prep.source, 'bundled');
  assert.strictEqual(prep.downloaded, null);
  assert.deepStrictEqual(installs, [good.file]);

  // 2. A bundled copy whose pin does not verify → nothing is installed.
  installs.length = 0;
  const bundledBad = { ...bundledOk, sha256: 'c'.repeat(64) };
  await assert.rejects(
    Z.prepareRuntimeZip(pkg, { download, bundled: bundledBad }).then((p) => install(p.zipPath)),
    /The ZCSDK Runtime download from GitHub failed its integrity check and was not installed\./);
  assert.strictEqual(fs.existsSync(dl), false);
  assert.deepStrictEqual(installs, []);

  // 3. No bundled copy → refused, nothing installed.
  await assert.rejects(Z.prepareRuntimeZip(pkg, { download, bundled: null }), (e) => e.code === 'ZCSDK_INTEGRITY');
  assert.deepStrictEqual(installs, []);
});

test('good hash: the download itself is installed; the bundled pin is checked on bundled installs', async () => {
  const d = tmp();
  const z = zipFile(d, 'ZCSDKRuntime_v0.15.1.zip');
  const pkg = { source: 'github', ...entry('0.15.1', { sha256: z.sha256, size: z.size }) };
  const prep = await Z.prepareRuntimeZip(pkg, { download: async () => z.file, bundled: null });
  assert.strictEqual(prep.zipPath, z.file);
  assert.strictEqual(prep.downloaded, z.file);
  assert.strictEqual(prep.source, 'github');

  // Bundled install (self-heal path): a matching pin passes, a wrong one refuses,
  // a pre-pin zip (no sha256/size) still works with a log line.
  const b = zipFile(d, 'bundled.zip');
  const ok = await Z.prepareRuntimeZip({ source: 'bundled', zip: b.file, version: '0.15.1', sha256: b.sha256, size: b.size });
  assert.strictEqual(ok.zipPath, b.file);
  await assert.rejects(Z.prepareRuntimeZip({ source: 'bundled', zip: b.file, version: '0.15.1', sha256: 'd'.repeat(64), size: b.size }),
    /bundled ZCSDK Runtime 0\.15\.1 failed its integrity check/);
  const logs = [];
  const legacy = await Z.prepareRuntimeZip({ source: 'bundled', zip: b.file, version: '0.13', sha256: null, size: null }, { log: (lvl, m) => logs.push(m) });
  assert.strictEqual(legacy.pinned, false);
  assert.ok(logs.some((m) => /no SHA-256 pin/.test(m)));
});

test('a failed download (not an integrity failure) falls back to a verified bundled copy', async () => {
  const d = tmp();
  const b = zipFile(d, 'bundled.zip');
  const pkg = { source: 'github', ...entry('0.15.1', H) };
  const prep = await Z.prepareRuntimeZip(pkg, {
    download: async () => { throw new Error('ECONNRESET'); },
    bundled: { source: 'bundled', zip: b.file, version: '0.15', sha256: b.sha256, size: b.size },
  });
  assert.strictEqual(prep.fallback, true);
  assert.strictEqual(prep.integrityFailed, false);
  assert.strictEqual(prep.zipPath, b.file);
});

// ---- (a) QA 11-12: a fallback never downgrades the installed runtime --------

const INSTALLED_015 = { installed: true, version: '0.15', bridge: '0.7.2', loader: '1.8.53' };
const bundled013 = (z, pin) => ({ source: 'bundled', zip: z.file, version: '0.13', bridge: '0.6.0', loader: '1.8.32', ...(pin ? { sha256: z.sha256, size: z.size } : { sha256: null, size: null }) });

test('installed 0.15 + 0.15.1 hash mismatch + bundled 0.13 → nothing installed, 0.15 kept (pinned or not)', async () => {
  const d = tmp();
  const b = zipFile(d, 'bundled.zip');
  const pkg = { source: 'github', ...entry('0.15.1', { sha256: 'b'.repeat(64), size: 99 }) };
  for (const pin of [false, true]) {
    let dl = null;
    const installs = [];
    const download = async () => { dl = zipFile(d, 'ZCSDKRuntime_v0.15.1.zip', Buffer.from('tampered')).file; return dl; };
    await assert.rejects(
      Z.prepareRuntimeZip(pkg, { download, bundled: bundled013(b, pin), installed: INSTALLED_015 }).then((p) => installs.push(p.zipPath)),
      (e) => e.kept === true && e.code === 'ZCSDK_INTEGRITY' && e.message === 'The ZCSDK Runtime download failed its integrity check. Your installed 0.15 was kept.');
    assert.deepStrictEqual(installs, [], `pinned=${pin}`);
    assert.strictEqual(fs.existsSync(dl), false);
  }
});

test('installed 0.15 + a plain download failure + bundled 0.13 → nothing installed, 0.15 kept', async () => {
  const d = tmp();
  const b = zipFile(d, 'bundled.zip');
  const pkg = { source: 'github', ...entry('0.15.1', H) };
  const installs = [];
  await assert.rejects(
    Z.prepareRuntimeZip(pkg, { download: async () => { throw new Error('ECONNRESET'); }, bundled: bundled013(b, true), installed: INSTALLED_015 })
      .then((p) => installs.push(p.zipPath)),
    (e) => e.kept === true && /^Could not download ZCSDK Runtime 0\.15\.1 from GitHub: ECONNRESET\. Your installed 0\.15 was kept\.$/.test(e.message));
  assert.deepStrictEqual(installs, []);
});

test('nothing installed + hash mismatch + pinned bundled → the bundled copy installs; unpinned → refused', async () => {
  const d = tmp();
  const b = zipFile(d, 'bundled.zip');
  const pkg = { source: 'github', ...entry('0.15.1', { sha256: 'b'.repeat(64), size: 99 }) };
  const download = async () => zipFile(d, 'ZCSDKRuntime_v0.15.1.zip', Buffer.from('tampered')).file;
  const none = { installed: false, version: null, bridge: null, loader: null };
  const prep = await Z.prepareRuntimeZip(pkg, { download, bundled: bundled013(b, true), installed: none });
  assert.strictEqual(prep.zipPath, b.file);
  assert.strictEqual(prep.integrityFailed, true);
  assert.strictEqual(prep.pinned, true);
  // After an integrity failure an unpinned bundle is never used, even with nothing installed.
  await assert.rejects(Z.prepareRuntimeZip(pkg, { download, bundled: bundled013(b, false), installed: none }),
    /The ZCSDK Runtime download from GitHub failed its integrity check and was not installed\./);
  // A plain download failure with nothing installed may still use the unpinned bundle (offline path).
  const off = await Z.prepareRuntimeZip(pkg, { download: async () => { throw new Error('offline'); }, bundled: bundled013(b, false), installed: none });
  assert.strictEqual(off.zipPath, b.file);
  assert.strictEqual(off.pinned, false);
});

test('fallback over an installed runtime: a same-or-newer pinned bundle is used; unknown installed versions are kept', async () => {
  const d = tmp();
  const b = zipFile(d, 'bundled.zip');
  const pkg = { source: 'github', ...entry('0.15.1', { sha256: 'b'.repeat(64), size: 99 }) };
  const download = async () => zipFile(d, 'ZCSDKRuntime_v0.15.1.zip', Buffer.from('tampered')).file;
  const bundled015 = { source: 'bundled', zip: b.file, version: '0.15', bridge: '0.7.2', loader: '1.8.53', sha256: b.sha256, size: b.size };
  const same = await Z.prepareRuntimeZip(pkg, { download, bundled: bundled015, installed: INSTALLED_015 });
  assert.strictEqual(same.zipPath, b.file);
  // Installed parts with no version info (hand-deployed): a fallback cannot rule out a downgrade.
  await assert.rejects(Z.prepareRuntimeZip(pkg, { download, bundled: bundled015, installed: { installed: true } }),
    (e) => e.kept === true && /Your installed runtime was kept\./.test(e.message));
  // A newer loader on disk than the bundle's, with an older-looking record: still a downgrade.
  await assert.rejects(Z.prepareRuntimeZip(pkg, { download, bundled: bundled015, installed: { installed: true, version: '0.14', loader: '1.8.54' } }),
    (e) => e.kept === true);
  // Direct bundled install (offline): a proven downgrade is refused, an unknown one is allowed (repairs a dev copy).
  await assert.rejects(Z.prepareRuntimeZip(bundled013(b, false), { installed: INSTALLED_015 }),
    (e) => e.kept === true && e.code === 'ZCSDK_DOWNGRADE' && /older than your installed 0\.15, which was kept/.test(e.message));
  assert.strictEqual((await Z.prepareRuntimeZip(bundled013(b, false), { installed: { installed: true } })).zipPath, b.file);
  // The shape main.js passes (the runtime version is not on disk; parts' versions are).
  await assert.rejects(Z.prepareRuntimeZip(pkg, { download, bundled: bundled013(b, true), installed: { installed: true, version: null, bridge: '0.7.2', loader: '1.8.53' } }),
    (e) => e.kept === true && e.message === 'The ZCSDK Runtime download failed its integrity check. Your installed runtime (ZCSDKLoader 1.8.53) was kept.');
  assert.strictEqual(Z.isRuntimeDowngrade(bundled015, INSTALLED_015, true), false);
  assert.strictEqual(Z.isRuntimeDowngrade({ version: '0.13' }, null, true), false);
});

// ---- (b) L8: the pinned URL -------------------------------------------------

test('runtimeUrl: dot segments, %2e%2e, other hosts, credentials, query/fragment and http are refused', () => {
  const bad = [
    `${REPO}/v0.15.1/../../../evil/x/releases/download/v1/ZCSDKRuntime_v1.zip`,
    `${REPO}/v0.15.1/%2e%2e/%2e%2e/%2e%2e/evil/x/releases/download/v1/ZCSDKRuntime_v1.zip`,
    `${REPO}/v0.15.1/%2E%2E/%2E%2E/%2E%2E/evil/x/releases/download/v1/ZCSDKRuntime_v1.zip`,
    'https://github.com/EnvianMods/ZCSDK-Runtime-Release/releases/download/v0.15.1\\..\\..\\..\\evil\\x\\releases\\download\\v1\\ZCSDKRuntime_v1.zip',
    'http://github.com/EnvianMods/ZCSDK-Runtime-Release/releases/download/v0.15.1/ZCSDKRuntime_v0.15.1.zip',
    'https://github.com.evil.io/EnvianMods/ZCSDK-Runtime-Release/releases/download/v0.15.1/ZCSDKRuntime_v0.15.1.zip',
    'https://githubXcom/EnvianMods/ZCSDK-Runtime-Release/releases/download/v0.15.1/ZCSDKRuntime_v0.15.1.zip',
    'https://user@github.com/EnvianMods/ZCSDK-Runtime-Release/releases/download/v0.15.1/ZCSDKRuntime_v0.15.1.zip',
    'https://github.com:8443/EnvianMods/ZCSDK-Runtime-Release/releases/download/v0.15.1/ZCSDKRuntime_v0.15.1.zip',
    `${REPO}/v0.15.1/ZCSDKRuntime_v0.15.1.zip?x=1`,
    `${REPO}/v0.15.1/ZCSDKRuntime_v0.15.1.zip?`,
    `${REPO}/v0.15.1/ZCSDKRuntime_v0.15.1.zip#a`,
    'https://github.com/other-owner/ZCSDK-Runtime-Release/releases/download/v0.15.1/ZCSDKRuntime_v0.15.1.zip',
    `${REPO}/v0.15.1/evil.zip`,
    `${REPO}/v0.15.1/ZCSDKRuntime_v0.15.1.zip.exe`,
    'not a url', '', null, 42,
  ];
  for (const u of bad) assert.strictEqual(Z.runtimeUrl(u), null, String(u));
});

test('runtimeUrl: the real asset URL gives its href; a tag/version or file/asset mismatch is refused', () => {
  const good = `${REPO}/v0.15.1/ZCSDKRuntime_v0.15.1.zip`;
  assert.strictEqual(Z.runtimeUrl(good), good);
  assert.strictEqual(Z.runtimeUrl(good, { version: '0.15.1', asset: 'ZCSDKRuntime_v0.15.1.zip' }), good);
  assert.strictEqual(Z.runtimeUrl('https://GITHUB.com/EnvianMods/ZCSDK-Runtime-Release/releases/download/v0.15.1/ZCSDKRuntime_v0.15.1.zip'), good);
  assert.strictEqual(Z.runtimeUrl(good, { version: '0.15.2' }), null);
  assert.strictEqual(Z.runtimeUrl(good, { asset: 'ZCSDKRuntime_v0.15.zip' }), null);
  assert.strictEqual(Z.runtimeUrl(`${REPO}/v0.15.1/ZCSDKRuntime_v0.15.1_manual.zip`), `${REPO}/v0.15.1/ZCSDKRuntime_v0.15.1_manual.zip`);
  // latest.json: the stored url is the normalized href; a mismatched tag refuses the entry.
  quiet();
  assert.strictEqual(Z.parseLatest(entry('0.15.1', H), { seen: false }).url, good);
  assert.strictEqual(Z.parseLatest(entry('0.15.1', { ...H, url: `${REPO}/v0.15/ZCSDKRuntime_v0.15.1.zip` }), { seen: false }), null);
  assert.strictEqual(Z.parseLatest(entry('0.15.1', { ...H, url: `${REPO}/v0.15.1/../v0.15.1/ZCSDKRuntime_v0.15.1.zip` }), { seen: false }).url, good);
});

// ---- (c) L9: the asset name -------------------------------------------------

test('latest.json: a hostile asset name refuses the whole entry', () => {
  quiet();
  for (const asset of ['..\\..\\evil.zip', '../evil.zip', 'C:\\x\\ZCSDKRuntime_v1.zip', 'ZCSDKRuntime_v0.15.1.zip.exe',
    'ZCSDKRuntime_v0.15.1.zip ', 'ZCSDKRuntime_v0.15.zip', 'ZCSDKRuntime_v0.15.1_manual.zip', 42, '']) {
    assert.strictEqual(Z.parseLatest(entry('0.15.1', { ...H, asset }), { seen: false }), null, JSON.stringify(asset));
  }
  assert.strictEqual(Z.parseLatest(entry('0.15.1', H), { seen: false }).asset, 'ZCSDKRuntime_v0.15.1.zip');
});

async function dl(suggestedName, headers = {}) {
  const dir = tmp();
  const dest = await withFetch(async () => new Response(Buffer.from('zipbytes'), { status: 200, headers }),
    () => nexus.downloadToFile('https://downloads.example.invalid/some/file.zip', dir, suggestedName));
  return { dir, dest };
}
const inside = (dir, f) => path.dirname(path.resolve(f)) === path.resolve(dir);

test('downloadToFile: suggested names with ..\\ or ../ land inside destDir', async () => {
  for (const name of ['..\\..\\x.zip', '../x.zip', '..\\..\\..\\Windows\\x.zip', 'C:\\x\\y.zip', '/etc/x.zip']) {
    const { dir, dest } = await dl(name);
    assert.ok(inside(dir, dest), `${name} → ${dest}`);
    assert.ok(fs.existsSync(dest));
    assert.strictEqual(fs.readdirSync(path.dirname(dir)).includes('x.zip'), false);
  }
});

test('downloadToFile: a Content-Disposition filename="..\\..\\a.zip" lands inside destDir', async () => {
  for (const cd of ['attachment; filename="..\\..\\a.zip"', 'attachment; filename="../../a.zip"', "attachment; filename*=UTF-8''..%2F..%2Fa.zip", "attachment; filename*=UTF-8''..%5C..%5Ca.zip"]) {
    const { dir, dest } = await dl(null, { 'content-disposition': cd });
    assert.ok(inside(dir, dest), `${cd} → ${dest}`);
  }
});

// ---- (a) build/fetch-tools.js: the bundled pin ------------------------------

test('fetch-tools: a .part with a bad hash is deleted and tools/ZCSDKRuntime.zip is unchanged', async () => {
  const tools = tmp();
  const old = zipFile(tools, 'ZCSDKRuntime.zip', Buffer.from('old 0.15 runtime'));
  fs.writeFileSync(path.join(tools, 'zcsdk-runtime.json'), JSON.stringify({ version: '0.15' }));
  const latest = entry('0.15.1', { sha256: 'e'.repeat(64), size: 8 });
  const log = console.log; console.log = () => {};
  const warn = console.warn; console.warn = () => {};
  try {
    await withFetch(async (u) => (String(u).endsWith('latest.json') ? jsonRes(latest) : new Response(Buffer.from('tampered'))), async () => {
      await assert.rejects(fetchTools.zcsdkRuntime(tools), /integrity check/);
    });
  } finally { console.log = log; console.warn = warn; }
  assert.strictEqual(fs.existsSync(path.join(tools, 'ZCSDKRuntime.zip.part')), false);
  assert.deepStrictEqual(fs.readFileSync(old.file), old.bytes);
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(tools, 'zcsdk-runtime.json'), 'utf8')).version, '0.15');
});

test('fetch-tools: a good download replaces the zip and writes its sha256 + size pin; a hostile latest.json is refused', async () => {
  const tools = tmp();
  const bytes = Buffer.from('new 0.15.1 runtime zip');
  const latest = entry('0.15.1', { sha256: sha(bytes), size: bytes.length });
  const log = console.log; console.log = () => {};
  const warn = console.warn; console.warn = () => {};
  try {
    await withFetch(async (u) => (String(u).endsWith('latest.json') ? jsonRes(latest) : new Response(bytes)), () => fetchTools.zcsdkRuntime(tools));
    const info = JSON.parse(fs.readFileSync(path.join(tools, 'zcsdk-runtime.json'), 'utf8'));
    assert.strictEqual(info.version, '0.15.1');
    assert.strictEqual(info.sha256, sha(bytes));
    assert.strictEqual(info.size, bytes.length);
    assert.deepStrictEqual(fs.readFileSync(path.join(tools, 'ZCSDKRuntime.zip')), bytes);
    // Hostile URL in latest.json: refused; with no copy in tools/ the step fails.
    const t2 = tmp();
    await withFetch(async () => jsonRes(entry('0.15.1', { ...latest, url: `${REPO}/v0.15.1/%2e%2e/%2e%2e/%2e%2e/x/releases/download/v0.15.1/ZCSDKRuntime_v0.15.1.zip` })),
      async () => { await assert.rejects(fetchTools.zcsdkRuntime(t2), /unexpected latest\.json/); });
    assert.strictEqual(fs.existsSync(path.join(t2, 'ZCSDKRuntime.zip')), false);
  } finally { console.log = log; console.warn = warn; }
});

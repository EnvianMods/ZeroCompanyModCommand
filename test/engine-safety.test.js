'use strict';
// lib/mods.js file-safety rules: profiles with kept original pak names, the
// keep-names rollback record, ZC Unlocked add-ons next to copies the player
// put in the game themselves.
// Fake game + data in a temp folder only (never the real game or %APPDATA%).
// Run: node --test test/*.test.js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { Store } = require('../lib/store');
const M = require('../lib/mods');

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zcv-d-test-'));
  const inside = (p) => path.resolve(p).toLowerCase().startsWith(root.toLowerCase() + path.sep);
  const game = path.join(root, 'game');
  const win64 = path.join(game, M.WIN64_REL);
  fs.mkdirSync(path.join(win64, 'ue4ss', 'Mods'), { recursive: true });
  fs.mkdirSync(path.join(game, M.MODS_REL), { recursive: true });
  fs.mkdirSync(path.join(game, M.GAME_MODS_REL), { recursive: true });
  fs.writeFileSync(path.join(win64, 'SWZeroCompany.exe'), 'MZ dummy');
  fs.writeFileSync(path.join(win64, 'dwmapi.dll'), 'MZ dwm');
  fs.writeFileSync(path.join(win64, 'ue4ss', 'UE4SS.dll'), 'MZ ue4ss');
  fs.writeFileSync(path.join(game, M.UE4SS_MODS_REL, 'mods.txt'), 'Keybinds : 1\r\n');
  const store = new Store(path.join(root, 'data'));
  store.settings.gamePath = game;
  store.save();
  // Sandbox guard: everything stays inside the temp fixture.
  assert.ok(inside(store.settings.gamePath) && inside(store.libraryDir) && inside(store.stagingDir), 'fixture escaped');
  const engine = new M.ModEngine(store);
  engine.gameRunning = () => 'not-running';
  assert.ok(inside(engine.gamePath()));
  let seq = 0;
  const src = (files) => {
    seq += 1;
    const dir = path.join(root, 'src', `s${seq}`);
    for (const [rel, body] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
      fs.writeFileSync(path.join(dir, rel), body);
    }
    return dir;
  };
  const cleanup = () => { if (inside(path.join(root, 'x'))) fs.rmSync(root, { recursive: true, force: true }); };
  return { root, game, store, engine, src, cleanup, abs: (rel) => path.join(game, rel) };
}
const mi = (title, version = '1.0') => JSON.stringify({ title, version, author: 'Tester' });
const zcuFiles = {
  'ue4ss/Mods/ZCUnlocked/dlls/main.dll': 'MZ zcu',
  'ue4ss/Mods/ZCUnlocked/modinfo.json': JSON.stringify({ title: 'ZC Unlocked', version: '1.4.73' }),
};
const pack = (folder) => ({
  [`${folder}/addon.ini`]: `[addon]\r\nname=${folder}\r\nversion=1.0\r\n`,
  [`${folder}/050_ZCA_${folder}_P.pak`]: `PAK-${folder}`,
});

test('a profile switches mods off before it switches others on (kept original pak names)', async () => {
  const f = fixture();
  try {
    const { engine } = f;
    const b = await engine.install(f.src({ 'Same_P.pak': 'B'.repeat(100), 'modinfo.json': mi('Bee') }));
    const a = await engine.install(f.src({ 'Same_P.pak': 'A'.repeat(100), 'modinfo.json': mi('Ay') }));
    engine.setEnabled(a.id, false);
    engine.setKeepOriginalPakNames(true);
    assert.ok(engine.store.getMod(b.id).enabled && !engine.store.getMod(a.id).enabled);
    engine.saveProfile('Bee on');
    const profile = engine.store.profiles.find((p) => p.name === 'Bee on');
    assert.deepStrictEqual(profile.entries.map((e) => e.modId), [b.id, a.id], 'Bee is listed (and switched on) first');
    engine.setEnabled(b.id, false);
    engine.setEnabled(a.id, true);
    const res = await engine.applyProfile(profile.id);
    assert.ok(engine.store.getMod(b.id).enabled, 'Bee on');
    assert.ok(!engine.store.getMod(a.id).enabled, 'Ay off');
    assert.strictEqual(fs.readFileSync(f.abs(path.join(M.MODS_REL, 'Same_P.pak')), 'utf8'), 'B'.repeat(100));
    assert.ok(Array.isArray(res.warnings));
  } finally { f.cleanup(); }
});

test('keep-names switch: a mod that cannot be put back keeps its full file list for the start-up repair', async () => {
  const f = fixture();
  try {
    const { engine } = f;
    const one = await engine.install(f.src({ 'One_P.pak': '1'.repeat(64), 'modinfo.json': mi('One') }));
    const two = await engine.install(f.src({ 'Two_P.pak': '2'.repeat(64), 'modinfo.json': mi('Two') }));
    const before = [...engine.store.getMod(one.id).deployed];
    const real = engine._deployMod.bind(engine);
    let calls = 0;
    engine._deployMod = (mod, opts = {}) => {
      calls += 1;
      // Two's move to original names fails; One's way back fails too.
      if (mod.id === two.id && opts.originalNames === true) throw new Error('disk full');
      if (mod.id === one.id && opts.originalNames === false) throw new Error('disk full');
      return real(mod, opts);
    };
    assert.throws(() => engine.setKeepOriginalPakNames(true), /every pak mod was left under its load-order names/);
    assert.ok(calls > 0);
    assert.strictEqual(engine.keepOriginalPakNames(), false);
    assert.deepStrictEqual(engine.store.getMod(one.id).deployed, before, 'One still lists its load-order files');
  } finally { f.cleanup(); }
});

test('a waiting ZC Unlocked add-on never deploys over a copy already in its folder', async () => {
  const f = fixture();
  try {
    const { engine } = f;
    const addon = await engine.install(f.src(pack('MyPack')));
    const rec = engine.store.getMod(addon.id);
    assert.strictEqual(rec.modType, 'zcu-addon');
    assert.ok(rec.needsZcu && !(rec.deployed || []).length, 'waits for ZC Unlocked');
    // The player puts a copy of the pack in ZC Unlocked's addons folder.
    const handIni = f.abs(path.join(M.ZCU_ADDONS_REL, 'MyPack', 'addon.ini'));
    fs.mkdirSync(path.dirname(handIni), { recursive: true });
    fs.writeFileSync(handIni, '[addon]\r\nname=MyPack (mine)\r\nversion=9.9\r\n');
    fs.writeFileSync(path.join(path.dirname(handIni), 'notes.txt'), 'mine');
    await engine.install(f.src(zcuFiles));
    engine._deployWaitingAddons();
    assert.strictEqual(fs.readFileSync(handIni, 'utf8'), '[addon]\r\nname=MyPack (mine)\r\nversion=9.9\r\n', 'hand-placed addon.ini untouched');
    const after = engine.store.getMod(addon.id);
    assert.ok(!(after.deployed || []).length, 'nothing of the entry deployed');
    assert.throws(() => engine.setEnabled(addon.id, true), /does not manage/);
    assert.ok(fs.existsSync(path.join(path.dirname(handIni), 'notes.txt')));
  } finally { f.cleanup(); }
});

test('an add-on that cannot come back on never force-deletes a file the player changed', async () => {
  const f = fixture();
  try {
    const { engine } = f;
    await engine.install(f.src(zcuFiles));
    assert.ok(engine.zcuPresent());
    const addon = await engine.install(f.src(pack('Kit')));
    const rec = engine.store.getMod(addon.id);
    assert.ok(rec.enabled && rec.deployed.length, 'deployed');
    engine.setEnabled(addon.id, false); // stays in the game with enabled=0
    const pakRel = rec.deployed.find((r) => /\.pak$/i.test(r));
    assert.ok(pakRel && fs.existsSync(f.abs(pakRel)));
    // A second copy of the pack, placed by the player, and ZC Unlocked gone.
    const bare = f.abs(path.join(M.UE4SS_MODS_REL, 'Kit'));
    fs.mkdirSync(bare, { recursive: true });
    fs.writeFileSync(path.join(bare, 'addon.ini'), '[addon]\r\nname=Kit\r\nversion=1.0\r\n');
    fs.rmSync(f.abs(path.join(M.ZCU_REL, 'dlls', 'main.dll')));
    assert.ok(!engine.zcuPresent());
    // The player edits the deployed pak.
    fs.writeFileSync(f.abs(pakRel), 'EDITED BY THE PLAYER');
    assert.throws(() => engine.setEnabled(addon.id, true), /ZC Unlocked/);
    assert.strictEqual(fs.readFileSync(f.abs(pakRel), 'utf8'), 'EDITED BY THE PLAYER', 'the edited file stays');
  } finally { f.cleanup(); }
});

const zcuAt = (version, settings) => ({
  'ue4ss/Mods/ZCUnlocked/dlls/main.dll': 'MZ zcu',
  'ue4ss/Mods/ZCUnlocked/modinfo.json': JSON.stringify({ title: 'ZC Unlocked', version }),
  ...(settings ? { 'ue4ss/Mods/ZCUnlocked/dlls/settings.ini': settings } : {}),
});
// A pack the player put straight in ue4ss\Mods\<folder> (layout 2).
function handPack(f, folder, version) {
  const dir = f.abs(path.join(M.UE4SS_MODS_REL, folder));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'addon.ini'), `[addon]\r\nname=${folder}\r\nversion=${version}\r\n`);
  fs.writeFileSync(path.join(dir, `050_ZCA_${folder}_P.pak`), `HAND-${folder}-${version}`);
  return dir;
}
const packV = (folder, version) => ({
  [`${folder}/addon.ini`]: `[addon]\r\nname=${folder}\r\nversion=${version}\r\n`,
  [`${folder}/050_ZCA_${folder}_P.pak`]: `PAK-${folder}-${version}`,
});

test('updating a hand-placed add-on: when neither the update nor the put-back works, nothing is deleted', async () => {
  const f = fixture();
  try {
    const { engine } = f;
    await engine.install(f.src(zcuFiles));
    const dir = handPack(f, 'Kit', '1.0');
    engine._installFromFolder = () => { throw new Error('disk full (update)'); };
    const realDeploy = engine._deployMod.bind(engine);
    engine._deployMod = () => { throw new Error('disk full (put back)'); };
    await assert.rejects(engine.install(f.src(packV('Kit', '1.1'))), /keeps managing that copy/);
    engine._deployMod = realDeploy;
    const rec = engine.store.mods.find((m) => m.modType === 'zcu-addon');
    assert.ok(rec, 'the adoption record stays');
    assert.ok((rec.deployed || []).length, 'it still lists its files, so the start-up repair puts them back');
    const vault = engine.store.modVaultDir(engine._vaultKey(rec));
    const entries = fs.existsSync(vault) ? fs.readdirSync(vault) : [];
    assert.ok(entries.length >= 1, 'the previous version is kept in the vault');
    assert.ok(fs.existsSync(path.join(engine.store.modLibraryDir(rec.id), 'addon.ini')), 'the stored copy stays');
    // …and the repair brings the files back from it.
    engine.repairDeployments();
    assert.ok(fs.existsSync(path.join(dir, 'addon.ini')), 'repaired');
  } finally { f.cleanup(); }
});

test('updating a hand-placed add-on: a failed update that is put back keeps any earlier version history', async () => {
  const f = fixture();
  try {
    const { engine } = f;
    await engine.install(f.src(zcuFiles));
    const dir = handPack(f, 'Kit', '1.0');
    let earlier = null;
    const realCap = engine._captureForReplace.bind(engine);
    engine._captureForReplace = (mod) => {
      // An older entry of the same add-on left history under the same key.
      earlier = path.join(engine.store.modVaultDir(engine._vaultKey(mod)), 'earlier-entry');
      fs.mkdirSync(earlier, { recursive: true });
      fs.writeFileSync(path.join(earlier, 'marker.txt'), 'history');
      return realCap(mod);
    };
    engine._installFromFolder = () => { throw new Error('disk full (update)'); };
    await assert.rejects(engine.install(f.src(packV('Kit', '1.1'))), /Could not update the copy/);
    assert.ok(!engine.store.mods.some((m) => m.modType === 'zcu-addon'), 'the adoption record is dropped (the copy is back as it was)');
    assert.strictEqual(fs.readFileSync(path.join(dir, '050_ZCA_Kit_P.pak'), 'utf8'), 'HAND-Kit-1.0', 'the copy is back');
    assert.ok(fs.existsSync(path.join(earlier, 'marker.txt')), 'earlier version history is not deleted');
  } finally { f.cleanup(); }
});

test('reinstall from stored copies refuses to overwrite a copy Mod Command does not manage', async () => {
  const f = fixture();
  try {
    const { engine } = f;
    await engine.install(f.src(zcuFiles));
    const old = await engine.install(f.src({ '050_ZCA_Kit_P.pak': 'PAK-Kit' }));
    assert.ok(engine.isZcaPakEntry(engine.store.getMod(old.id)));
    fs.writeFileSync(path.join(engine.store.modLibraryDir(old.id), 'addon.ini'), '[addon]\r\nname=Kit\r\nversion=1.0\r\n');
    const hand = f.abs(path.join(M.ZCU_ADDONS_REL, 'Kit', 'addon.ini'));
    fs.mkdirSync(path.dirname(hand), { recursive: true });
    fs.writeFileSync(hand, '[addon]\r\nname=Kit (mine)\r\nversion=7\r\n');
    const count = engine.store.mods.length;
    await assert.rejects(engine.reinstallAsAddon([old.id], null), /does not manage/);
    assert.strictEqual(fs.readFileSync(hand, 'utf8'), '[addon]\r\nname=Kit (mine)\r\nversion=7\r\n');
    assert.ok(engine.store.getMod(old.id), 'the old entry stays');
    assert.strictEqual(engine.store.mods.length, count, 'no stray entry');
  } finally { f.cleanup(); }
});

test('an add-on copy never takes over files another managed mod put in its folder', async () => {
  const f = fixture();
  try {
    const { engine } = f;
    await engine.install(f.src({ ...zcuFiles, 'ue4ss/Mods/ZCUnlocked/addons/Sample/sample.txt': 'shipped by ZC Unlocked' }));
    const dir = f.abs(path.join(M.ZCU_ADDONS_REL, 'Sample'));
    assert.ok(fs.existsSync(path.join(dir, 'sample.txt')));
    fs.writeFileSync(path.join(dir, 'addon.ini'), '[addon]\r\nname=Sample\r\nversion=1.0\r\n');
    fs.writeFileSync(path.join(dir, '050_ZCA_Sample_P.pak'), 'PAK');
    const c = engine.addonCopies().find((x) => x.folder === 'Sample');
    const cand = engine._addonCandidate(c);
    assert.ok(cand, 'offered');
    assert.ok(!cand.files.some((r) => /sample\.txt$/i.test(r)), cand.files.join(','));
    assert.ok(cand.files.some((r) => /addon\.ini$/i.test(r)));
  } finally { f.cleanup(); }
});

test('a hand-placed ue4ss\\Mods\\<Pack> this ZC Unlocked does not load is updated into ZCUnlocked\\addons, and it says so', async () => {
  for (const [label, zcu] of [['ZC Unlocked older than 1.4.73', zcuAt('1.4.5')], ['addons_mods=0', zcuAt('1.4.74', '[Creator]\r\naddons=1\r\naddons_mods=0\r\n')]]) {
    const f = fixture();
    try {
      const { engine } = f;
      await engine.install(f.src(zcu));
      const dir = handPack(f, 'Kit', '1.0');
      const res = await engine.install(f.src(packV('Kit', '1.1')));
      const msg = (res.addonAdopted && res.addonAdopted.message) || '';
      assert.match(msg, /not loaded/, `${label}: ${msg}`);
      assert.match(msg, /ZCUnlocked\\addons\\Kit/, label);
      assert.ok(fs.existsSync(f.abs(path.join(M.ZCU_ADDONS_REL, 'Kit', 'addon.ini'))), `${label}: moved to ZCUnlocked\\addons`);
      assert.ok(!fs.existsSync(path.join(dir, 'addon.ini')), `${label}: no second copy left in ue4ss\\Mods`);
      assert.strictEqual(engine.store.mods.filter((m) => m.modType === 'zcu-addon').length, 1, label);
    } finally { f.cleanup(); }
  }
  // 1.4.73+ with addons_mods on: updated in place, nothing moves.
  const f = fixture();
  try {
    await f.engine.install(f.src(zcuAt('1.4.74')));
    const dir = handPack(f, 'Kit', '1.0');
    const res = await f.engine.install(f.src(packV('Kit', '1.1')));
    assert.doesNotMatch(res.addonAdopted.message, /not loaded/);
    assert.ok(fs.existsSync(path.join(dir, 'addon.ini')), 'updated in place');
  } finally { f.cleanup(); }
});

test('kept original pak names: a hand-placed identical file is used but stays the player\'s', async () => {
  const f = fixture();
  try {
    const { engine } = f;
    engine.setKeepOriginalPakNames(true);
    const hand = f.abs(path.join(M.MODS_REL, 'Same_P.pak'));
    fs.writeFileSync(hand, 'S'.repeat(100));
    const mod = await engine.install(f.src({ 'Same_P.pak': 'S'.repeat(100), 'modinfo.json': mi('Same') }));
    const rec = engine.store.getMod(mod.id);
    assert.ok(rec.enabled);
    assert.ok(!(rec.deployed || []).some((r) => /Same_P\.pak$/i.test(r)), 'not recorded as the mod\'s file');
    assert.ok((rec.warnings || []).some((w) => /your own copy/.test(w)), 'said on the row');
    engine.setEnabled(mod.id, false);
    assert.ok(fs.existsSync(hand), 'switching the mod off keeps it');
    engine.setEnabled(mod.id, true);
    engine.uninstall(mod.id);
    assert.ok(fs.existsSync(hand), 'removing the mod keeps it');
  } finally { f.cleanup(); }
});

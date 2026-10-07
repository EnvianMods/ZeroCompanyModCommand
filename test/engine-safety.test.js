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

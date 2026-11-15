'use strict';
// A UE4SS mod archive with files beside the mod folder: the install note names
// the files it left out (it used to give only a count). Temp folder only.
// Run: node --test test/*.test.js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const M = require('../lib/mods');

function tree(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zc-skip-'));
  for (const f of files) {
    fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true });
    fs.writeFileSync(path.join(root, f), 'x');
  }
  return root;
}

test('UE4SS mod: files outside the mod folder are named in the warning', () => {
  const root = tree(['ZCUnlocked/Scripts/main.lua', 'ZCUnlocked/enabled.txt', 'readme.txt', 'docs/install.txt']);
  const g = M.classifyFolder(root, 'ZCUnlocked');
  assert.strictEqual(g.modType, 'ue4ss-mod');
  const w = g.warnings.find((m) => /outside the mod folder were ignored/.test(m));
  assert.ok(w, JSON.stringify(g.warnings));
  assert.match(w, /^2 file\(s\) outside the mod folder were ignored: /);
  assert.ok(w.includes('readme.txt') && w.includes('docs/install.txt'), w);
});

test('UE4SS mod: more than four ignored files are summarized', () => {
  const root = tree(['Mod/Scripts/main.lua', 'a.txt', 'b.txt', 'c.txt', 'd.txt', 'e.txt', 'f.txt']);
  const w = M.classifyFolder(root, 'Mod').warnings.find((m) => /outside the mod folder/.test(m));
  assert.match(w, /^6 file\(s\) outside the mod folder were ignored: .+ and 2 more\.$/);
});

test('UE4SS mod: nothing outside the mod folder → no warning', () => {
  const root = tree(['Mod/Scripts/main.lua', 'Mod/enabled.txt']);
  assert.ok(!M.classifyFolder(root, 'Mod').warnings.some((m) => /outside the mod folder/.test(m)));
});

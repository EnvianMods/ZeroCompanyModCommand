'use strict';
// Install button: a mod with more than one current MAIN file lets the user
// pick instead of taking the newest.
// Run: node --test test/*.test.js
const test = require('node:test');
const assert = require('node:assert');

const nexus = require('../lib/nexus');

const file = (id, category, ts, extra = {}) => ({
  file_id: id, name: `File ${id}`, file_name: `f${id}.zip`, version: `1.${id}`,
  category_name: category, uploaded_timestamp: ts, size_kb: 2048, ...extra,
});

test('mainFileChoices keeps only MAIN files, newest first', () => {
  const files = [
    file(1, 'MAIN', 100),
    file(2, 'OPTIONAL', 400),
    file(3, 'MAIN', 300),
    file(4, 'OLD_VERSION', 500),
    file(5, 'ARCHIVED', 600),
    file(6, 'UPDATE', 700),
  ];
  assert.deepStrictEqual(nexus.mainFileChoices(files).map((f) => f.file_id), [3, 1]);
});

test('mainFileChoices: one main file means no choice', () => {
  const files = [file(1, 'MAIN', 100), file(2, 'OPTIONAL', 200), file(3, 'OLD_VERSION', 300)];
  assert.strictEqual(nexus.mainFileChoices(files).length, 1);
  assert.strictEqual(nexus.pickPrimaryFile(files).file_id, 1);
});

test('mainFileChoices tolerates missing input and timestamps', () => {
  assert.deepStrictEqual(nexus.mainFileChoices(undefined), []);
  assert.deepStrictEqual(nexus.mainFileChoices([]), []);
  const out = nexus.mainFileChoices([file(1, 'MAIN', undefined), file(2, 'MAIN', 50)]);
  assert.deepStrictEqual(out.map((f) => f.file_id), [2, 1]);
});

test('mainFileChoices does not reorder the caller\'s array', () => {
  const files = [file(1, 'MAIN', 100), file(2, 'MAIN', 200)];
  nexus.mainFileChoices(files);
  assert.deepStrictEqual(files.map((f) => f.file_id), [1, 2]);
});

test('versionRow maps a Nexus file record to a picker row', () => {
  assert.deepStrictEqual(nexus.versionRow(file(7, 'MAIN', 1700000000)), {
    fileId: 7,
    name: 'File 7',
    version: '1.7',
    category: 'MAIN',
    sizeKb: 2048,
    uploaded: new Date(1700000000 * 1000).toISOString(),
  });
});

test('versionRow fills gaps the way the picker expects', () => {
  assert.deepStrictEqual(
    nexus.versionRow({ file_id: 8, name: 'Bare', size: 12 }),
    { fileId: 8, name: 'Bare', version: null, category: 'MAIN', sizeKb: 12, uploaded: null },
  );
});

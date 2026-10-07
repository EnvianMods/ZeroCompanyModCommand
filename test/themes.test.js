'use strict';
// Settings -> Themes: persistence, default and fallback.
// Run: node --test test/
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');

const { Store } = require('../lib/store');
const themes = require('../lib/themes');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'zc-theme-test-'));
}

test('fresh settings default to the Mod Command theme', () => {
  const dir = tmpDir();
  const store = new Store(dir);
  assert.strictEqual(store.settings.theme, 'mod-command');
  assert.strictEqual(themes.DEFAULT_THEME, 'mod-command');
});

test('existing settings without a theme key get Mod Command', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'manager-data.json'), JSON.stringify({
    settings: { gamePath: 'C:\\FakeGame', closeOnLaunch: true }, mods: [], profiles: [],
  }));
  const store = new Store(dir);
  assert.strictEqual(store.settings.closeOnLaunch, true);
  assert.strictEqual(themes.normalizeTheme(store.settings.theme), 'mod-command');
});

test('a chosen theme survives a restart (reload from disk)', () => {
  const dir = tmpDir();
  const a = new Store(dir);
  a.settings.theme = 'bounty-hunter';
  a.save();
  const b = new Store(dir);
  assert.strictEqual(b.settings.theme, 'bounty-hunter');
  assert.strictEqual(themes.normalizeTheme(b.settings.theme), 'bounty-hunter');
});

test('unknown or malformed stored theme ids fall back to Mod Command', () => {
  for (const bad of ['neon', '', null, undefined, 42, {}, 'Bounty-Hunter', 'constructor', '__proto__']) {
    assert.strictEqual(themes.normalizeTheme(bad), 'mod-command', String(bad));
    assert.strictEqual(themes.isTheme(bad), false, String(bad));
  }
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'manager-data.json'), JSON.stringify({ settings: { theme: 'retired-theme' } }));
  const store = new Store(dir);
  assert.strictEqual(themes.normalizeTheme(store.settings.theme), 'mod-command');
  assert.strictEqual(themes.themeBackground(store.settings.theme), themes.THEMES['mod-command']);
});

// The early boot script (runs before the stylesheet) must apply the same rule.
function bootTheme(stored) {
  const attrs = {};
  const sandbox = {
    window: { zc: stored === undefined ? undefined : { theme: stored } },
    document: { documentElement: { setAttribute: (k, v) => { attrs[k] = v; } } },
  };
  vm.runInNewContext(read('src/theme-boot.js'), sandbox);
  return attrs['data-theme'];
}

test('theme-boot.js sets <html data-theme> with the same fallback', () => {
  assert.strictEqual(bootTheme(undefined), 'mod-command');
  assert.strictEqual(bootTheme(null), 'mod-command');
  assert.strictEqual(bootTheme('nope'), 'mod-command');
  assert.strictEqual(bootTheme('mod-command'), 'mod-command');
  assert.strictEqual(bootTheme('bounty-hunter'), 'bounty-hunter');
});

test('renderer, picker and stylesheet list exactly the themes main knows', () => {
  const ids = Object.keys(themes.THEMES);
  const boot = read('src/theme-boot.js');
  const app = read('src/app.js');
  const html = read('src/index.html');
  const css = read('src/styles.css');
  const appList = app.match(/const THEMES = \[([^\]]*)\]/)[1].match(/'([^']+)'/g).map((s) => s.slice(1, -1));
  const bootList = boot.match(/var themes = \[([^\]]*)\]/)[1].match(/'([^']+)'/g).map((s) => s.slice(1, -1));
  assert.deepStrictEqual(appList, ids);
  assert.deepStrictEqual(bootList, ids);
  assert.strictEqual(appList[0], themes.DEFAULT_THEME, 'first entry is the fallback');
  const select = html.match(/<select id="set-theme"[\s\S]*?<\/select>/)[0];
  const options = [...select.matchAll(/value="([^"]+)"/g)].map((m) => m[1]);
  assert.deepStrictEqual(options, ids);
  // theme-boot.js must run before the stylesheet so the first paint is right
  assert.ok(html.indexOf('theme-boot.js') < html.indexOf('styles.css'));
  // every non-default theme has its token block
  for (const id of ids.filter((t) => t !== themes.DEFAULT_THEME)) {
    assert.ok(css.includes(`:root[data-theme="${id}"]`), id);
  }
  // the window background matches each theme's --bg
  const rootBg = css.match(/:root \{[\s\S]*?--bg: (#[0-9a-f]{6});/i)[1];
  assert.strictEqual(themes.THEMES['mod-command'].toLowerCase(), rootBg.toLowerCase());
  const bhBg = css.match(/:root\[data-theme="bounty-hunter"\] \{[\s\S]*?--bg: (#[0-9a-f]{6});/i)[1];
  assert.strictEqual(themes.THEMES['bounty-hunter'].toLowerCase(), bhBg.toLowerCase());
});

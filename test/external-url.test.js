'use strict';
// lib/external-url.js: which pages the Nexus panel may open itself, and which
// addresses the app may hand to the user's browser.
// Run: node --test test/*.test.js
const test = require('node:test');
const assert = require('node:assert');
const { isAllowedExternalUrl, isNexusPageUrl, isWebUrl } = require('../lib/external-url');

test('Nexus panel popups: real Nexus Mods pages are followed in the panel', () => {
  for (const u of [
    'https://www.nexusmods.com/starwarszerocompany/mods/1?tab=files',
    'https://nexusmods.com/',
    'https://users.nexusmods.com/auth/sign_in',
    'http://www.nexusmods.com/x',
  ]) assert.ok(isNexusPageUrl(u), u);
});

test('Nexus panel popups: look-alike hosts and other schemes are refused', () => {
  for (const u of [
    'https://nexusmods.com.example.net/',
    'https://www.nexusmods.com.example.net/mods/1',
    'https://nexusmods.com@example.net/',
    'https://user:pw@www.nexusmods.com/',
    'https://evilnexusmods.com/',
    'file:///C:/Windows/notepad.exe',
    'javascript:alert(1)',
    'nxm://starwarszerocompany/mods/1/files/2',
    '',
    null,
  ]) assert.ok(!isNexusPageUrl(u), String(u));
});

test('open-external: Nexus (any of its hosts, the sign-in pages too), GitHub and Discord over https', () => {
  for (const u of [
    'https://www.nexusmods.com/starwarszerocompany/mods/1',
    'https://nexusmods.com/',
    'https://next.nexusmods.com/profile',
    'https://users.nexusmods.com/auth/sign_in?redirect_url=x',
    'https://users.nexusmods.com/account/profile',
    'https://github.com/EnvianMods/ZeroCompanyModCommand',
    'https://www.github.com/EnvianMods',
    'https://discord.gg/abc',
  ]) assert.ok(isAllowedExternalUrl(u), u);
});

test('open-external: look-alikes, credentials, other ports and schemes are refused', () => {
  for (const u of [
    'https://nexusmods.com.example.net/',
    'https://users.nexusmods.com.example.net/auth',
    'https://nexusmods.com@example.net/',
    'https://u:p@www.nexusmods.com/',
    'https://www.nexusmods.com:8443/',
    'http://www.nexusmods.com/',
    'https://gist.github.com/x',
    'https://github.com.example.net/',
    'https://evilnexusmods.com/',
    'file:///C:/x',
    'nxm://starwarszerocompany/mods/1/files/2',
    null,
  ]) assert.ok(!isAllowedExternalUrl(u), String(u));
});

test('SDK workbench openExternal: web pages only', () => {
  assert.ok(isWebUrl('https://example.com/docs'));
  assert.ok(isWebUrl('http://localhost:8080/'));
  for (const u of ['file:///C:/Windows/System32/calc.exe', 'ms-settings:privacy', 'steam://run/1', 'javascript:1', 'C:\\x.exe', '', undefined]) {
    assert.ok(!isWebUrl(u), String(u));
  }
});

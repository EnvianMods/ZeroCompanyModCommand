'use strict';
// Runs in <head>, before styles.css renders anything: puts the saved theme on
// <html data-theme> so the first paint is already in the right palette. The
// value comes from the preload (window.zc.theme, a synchronous settings read);
// app.js keeps it in step afterwards (Settings -> Theme applies live).
// "mod-command" is the default and the fallback for any unknown id.
(function () {
  var themes = ['mod-command', 'bounty-hunter'];
  var t = window.zc && window.zc.theme;
  document.documentElement.setAttribute('data-theme', themes.indexOf(t) >= 0 ? t : themes[0]);
})();

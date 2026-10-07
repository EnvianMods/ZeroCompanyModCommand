'use strict';
// Themes (Settings -> Theme). id -> the window background shown before the
// page paints, which matches that theme's --bg in src/styles.css. The page
// learns the theme from the preload's synchronous 'theme-sync' read
// (src/theme-boot.js sets <html data-theme> before the stylesheet renders),
// so no theme ever flashes the other. Keep this list in step with
// src/theme-boot.js, src/app.js and the Theme <select> in src/index.html.

const THEMES = Object.freeze({
  'mod-command': '#05080f',
  'bounty-hunter': '#15171a',
});
const DEFAULT_THEME = 'mod-command';

function isTheme(id) {
  return typeof id === 'string' && Object.prototype.hasOwnProperty.call(THEMES, id);
}

// Any stored value (missing key, older build, hand-edited file) -> a real theme.
function normalizeTheme(id) {
  return isTheme(id) ? id : DEFAULT_THEME;
}

function themeBackground(id) {
  return THEMES[normalizeTheme(id)];
}

module.exports = { THEMES, DEFAULT_THEME, isTheme, normalizeTheme, themeBackground };

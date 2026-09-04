'use strict';
// Session log: a lightweight in-memory record of what the manager did this
// session (installs, deploys, updates, errors). Feeds the support report —
// nothing is written to disk and nothing leaves the machine unsanitized.

const MAX_ENTRIES = 600;
const entries = [];

function log(level, message) {
  entries.push({
    at: new Date().toISOString(),
    level: String(level || 'info'),
    message: String(message).slice(0, 600),
  });
  if (entries.length > MAX_ENTRIES) entries.splice(0, entries.length - MAX_ENTRIES);
}

function logText(tail) {
  const slice = tail ? entries.slice(-tail) : entries;
  return slice.map((e) => `${e.at} [${e.level.toUpperCase()}] ${e.message}`).join('\n');
}

module.exports = { log, logText, entries, MAX_ENTRIES };

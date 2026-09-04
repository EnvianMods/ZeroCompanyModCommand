'use strict';
/* global window, document */

let state = null;
let pendingOrder = null; // array of ids while user is dragging (pak list)
let pendingUe4ssOrder = null; // array of ids while dragging the UE4SS start list

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

// ------------------------------------------------------------------ toasts

function toast(msg, kind = 'info', ms = 4500) {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = msg;
  $('#toast-stack').appendChild(el);
  setTimeout(() => el.remove(), ms);
}

// Electron has no window.prompt — this modal replaces it. Resolves the entered
// string, or null on cancel/Escape.
function zcPrompt(title, initial = '') {
  return new Promise((resolve) => {
    const modal = $('#prompt-modal');
    const input = $('#prompt-input');
    $('#prompt-title').textContent = title;
    input.value = initial;
    modal.classList.remove('hidden');
    input.focus();
    input.select();
    const done = (value) => {
      modal.classList.add('hidden');
      $('#prompt-ok').onclick = null;
      $('#prompt-cancel').onclick = null;
      input.onkeydown = null;
      resolve(value);
    };
    $('#prompt-ok').onclick = () => done(input.value.trim() || null);
    $('#prompt-cancel').onclick = () => done(null);
    input.onkeydown = (e) => {
      if (e.key === 'Enter') done(input.value.trim() || null);
      if (e.key === 'Escape') done(null);
    };
  });
}

async function call(fn, ...args) {
  const res = await window.zc[fn](...args);
  if (!res.ok) {
    toast(res.error, 'error', 6000);
    return null;
  }
  return res.data;
}

// Wraps calls that can hit the SHA-256 ownership check (disable/uninstall).
// A changed-outside-the-manager file stops the operation; the user decides.
async function verifiedCall(fn, args, actionLabel) {
  let res = await window.zc[fn](...args);
  if (!res.ok && typeof res.error === 'string' && res.error.startsWith('VERIFY_CHANGED::')) {
    const [, name, fileList] = res.error.split('::');
    const files = (fileList || '').split('|');
    const proceed = window.confirm(
      `${files.length} deployed file(s) of “${name}” were changed outside the manager:\n\n` +
      `${files.slice(0, 6).join('\n')}${files.length > 6 ? `\n… and ${files.length - 6} more` : ''}\n\n` +
      `${actionLabel} anyway? The changed files will be removed.`);
    if (!proceed) return null;
    res = await window.zc[fn](...args, true); // force
  }
  if (!res.ok) {
    toast(res.error, 'error', 6000);
    return null;
  }
  return res.data;
}

// ------------------------------------------------------------------ nav

$$('.nav-item').forEach((btn) => {
  btn.addEventListener('click', () => {
    $$('.nav-item').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    $$('.view').forEach((v) => v.classList.remove('active'));
    $(`#view-${btn.dataset.view}`).classList.add('active');
  });
});

// ------------------------------------------------------------------ render

const TYPE_LABEL = {
  pak: 'PAK', iostore: 'IOSTORE', logicmods: 'LOGICMODS', 'ue4ss-mod': 'UE4SS',
  gamefolder: 'GAMEFILES',
};

function render() {
  if (!state) return;
  document.body.classList.toggle('reduced-motion', !!state.settings.reducedMotion);

  // sidebar
  const det = state.detection;
  const pipEl = $('#game-status-pip');
  pipEl.classList.toggle('good', det.found);
  pipEl.classList.toggle('bad', !det.found);
  $('#game-status-text').textContent = det.found
    ? `Game located${det.buildId ? ` · build ${det.buildId}` : ''}`
    : 'Game not located';
  $('#btn-launch').disabled = !det.found;
  const launchSub = $('#btn-launch .launch-sub');
  if (launchSub) {
    launchSub.textContent = det.launcher === 'ea'
      ? 'EA App edition'
      : (state.platform === 'linux' ? 'via Steam · Proton' : 'via Steam');
  }
  const enabledCount = state.mods.filter((m) => m.enabled).length;
  $('#nav-mod-count').textContent = state.mods.length || '';
  $('#nav-conflict-count').textContent = state.conflicts.length || '';

  // dashboard
  $('#dash-game-status').textContent = det.found ? 'OPERATIONAL' : 'NOT DETECTED';
  $('#dash-game-status').className = `stat-value ${det.found ? 'good' : 'bad'}`;
  const launcherName = { steam: 'STEAM', ea: 'EA APP', manual: 'MANUAL' }[det.launcher] || '—';
  const platformTag = state.platform === 'linux' ? ' · LINUX/PROTON' : '';
  $('#dash-launcher').textContent = det.found ? launcherName + platformTag : '—';
  $('#dash-launcher').className = `stat-value ${det.launcher === 'ea' ? 'warn' : 'good'}`;
  $('#dash-build').textContent = det.buildId || '—';
  $('#dash-path').textContent = det.gamePath || 'Set the game folder in Settings';
  $('#dash-enabled').textContent = enabledCount;
  $('#dash-installed').textContent = state.mods.length;
  $('#dash-conflicts').textContent = state.conflicts.length;
  $('#dash-conflicts').className = `stat-value ${state.conflicts.length ? 'warn' : 'good'}`;
  const updateCount = state.mods.filter((m) => m.updateInfo && m.updateInfo.available).length;
  $('#dash-updates').textContent = updateCount ? `${updateCount} available` : 'Up to date';
  $('#dash-updates').className = `stat-value ${updateCount ? 'warn' : 'good'}`;
  $('#nav-update-count').textContent = updateCount ? `⬆${updateCount}` : '';
  $('#dash-ue4ss').textContent = state.ue4ss.healthy ? 'HEALTHY' : (state.ue4ss.installed ? 'INCOMPLETE' : 'NOT INSTALLED');
  $('#dash-ue4ss').className = `stat-value ${state.ue4ss.healthy ? 'good' : (state.ue4ss.installed ? 'warn' : 'dim')}`;
  $('#dash-retoc').textContent = state.retoc.found ? (state.retoc.version || 'FOUND') : 'NOT FOUND';
  $('#dash-retoc').className = `stat-value ${state.retoc.found ? 'good' : 'dim'}`;
  $('#dash-7z').textContent = state.sevenZip ? 'AVAILABLE' : 'NOT FOUND';
  $('#dash-7z').className = `stat-value ${state.sevenZip ? 'good' : 'dim'}`;

  renderMods();
  renderOrder();
  renderUe4ssOrder();
  renderSettings();
}

function renderMods() {
  const list = $('#mod-list');
  list.innerHTML = '';
  $('#mods-empty').classList.toggle('hidden', state.mods.length > 0);

  for (const mod of state.mods) {
    const row = document.createElement('div');
    row.className = `mod-row${mod.enabled ? '' : ' disabled'}`;

    const badge = document.createElement('span');
    badge.className = `mod-badge badge-${mod.modType}`;
    badge.textContent = TYPE_LABEL[mod.modType] || mod.modType;

    // Source badge: where the mod came from; click opens its page.
    const originType = mod.origin ? mod.origin.type : 'local';
    const srcBadge = document.createElement('button');
    srcBadge.className = `mod-badge src-badge src-${originType}`;
    if (originType === 'nexus') {
      srcBadge.textContent = '◈ NEXUS';
      srcBadge.title = `Nexus mod ${mod.origin.modId}${mod.origin.version ? ` · v${mod.origin.version}` : ''} — click to open the mod page`;
      srcBadge.addEventListener('click', () =>
        call('openExternal', `https://www.nexusmods.com/starwarszerocompany/mods/${mod.origin.modId}`));
    } else if (originType === 'github') {
      srcBadge.textContent = '⎇ GITHUB';
      srcBadge.title = `${mod.origin.repo}${mod.origin.tag ? ` · ${mod.origin.tag}` : ''} — click to open the repository`;
      srcBadge.addEventListener('click', () =>
        call('openExternal', `https://github.com/${mod.origin.repo}`));
    } else {
      srcBadge.textContent = 'LOCAL · link?';
      srcBadge.title = 'No update source — click to link this mod to its Nexus page or Forge repo so updates can be tracked';
      srcBadge.addEventListener('click', () => openLinkModal(mod));
    }

    const main = document.createElement('div');
    main.className = 'mod-main';
    const name = document.createElement('div');
    name.className = 'mod-name';
    name.textContent = mod.name;
    const meta = document.createElement('div');
    meta.className = 'mod-meta';
    const parts = [
      `${mod.files.length} file${mod.files.length === 1 ? '' : 's'}`,
      mod.loadPriority != null ? `priority ${mod.loadPriority}` : null,
      mod.sourceArchive || null,
      `installed ${new Date(mod.installedAt).toLocaleDateString()}`,
    ].filter(Boolean);
    meta.textContent = parts.join('  ·  ');
    main.append(name, meta);

    const myConflicts = state.conflicts.filter((c) => c.memberIds.includes(mod.id));
    const flag = document.createElement('button');
    flag.className = 'mod-conflict-flag';
    if (myConflicts.length) {
      flag.textContent = `⚠ ${myConflicts.length} conflict${myConflicts.length === 1 ? '' : 's'}`;
      flag.title = 'Show conflict details';
      flag.addEventListener('click', () => {
        const existing = row.nextElementSibling;
        if (existing && existing.classList.contains('conflict-expand')) {
          existing.remove();
          return;
        }
        $$('.conflict-expand').forEach((el) => el.remove());
        row.after(buildConflictPanel(mod, myConflicts));
      });
    } else {
      flag.classList.add('hidden');
    }

    // Build-compatibility chip: the game updated since this mod was installed/verified.
    let buildChip = null;
    const curBuild = state.detection && state.detection.buildId;
    if (mod.installedBuild && curBuild && mod.installedBuild !== curBuild) {
      buildChip = document.createElement('button');
      buildChip.className = 'mod-conflict-flag build-chip';
      buildChip.textContent = '⚠ game updated';
      buildChip.title = `Installed under game build ${mod.installedBuild}; the game is now ${curBuild}. ` +
        'The mod may be incompatible with the new build. Click to mark it verified on the current build.';
      buildChip.addEventListener('click', async () => {
        if (!window.confirm(`Mark “${mod.name}” as verified on the current game build (${curBuild})? Do this after testing that it still works.`)) return;
        const data = await call('confirmModBuild', mod.id);
        if (data) { state = data; render(); toast(`“${mod.name}” marked verified on build ${curBuild}.`); }
      });
    }

    // EA App compatibility chip — shown to both audiences so Steam users see
    // what their EA friends can't run, and EA users see it as a warning.
    let eaChip = null;
    const compat = (state.modCompat || {})[mod.id];
    const onEA = state.detection && state.detection.launcher === 'ea';
    if (compat && compat.status === 'incompatible') {
      eaChip = document.createElement('span');
      eaChip.className = `mod-badge ea-chip ${onEA ? 'ea-bad' : 'ea-note'}`;
      eaChip.textContent = onEA ? '✖ NOT EA-COMPATIBLE' : 'EA: NOT COMPATIBLE';
      eaChip.title = `${compat.note || 'Flagged as not working on the EA App edition of the game.'}` +
        ` (source: ${compat.source === 'modinfo' ? 'the mod author' : 'community compatibility list'})`;
    } else if (compat && compat.status === 'compatible' && onEA) {
      eaChip = document.createElement('span');
      eaChip.className = 'mod-badge ea-chip ea-ok';
      eaChip.textContent = '✓ EA';
      eaChip.title = compat.note || 'Confirmed working on the EA App edition.';
    }

    const toggle = document.createElement('input');
    toggle.type = 'checkbox';
    toggle.className = 'switch';
    toggle.checked = mod.enabled;
    toggle.title = mod.enabled ? 'Disable (undeploy)' : 'Enable (deploy)';
    toggle.addEventListener('change', async () => {
      if (toggle.checked && onEA && compat && compat.status === 'incompatible') {
        const go = window.confirm(
          `“${mod.name}” is flagged as not working on the EA App edition of the game` +
          `${compat.note ? `:\n\n${compat.note}` : '.'}\n\nEnable it anyway?`);
        if (!go) { toggle.checked = false; return; }
      }
      const data = toggle.checked
        ? await call('setModEnabled', mod.id, true)
        : await verifiedCall('setModEnabled', [mod.id, false], 'Disable');
      if (data) { state = data; render(); }
      else toggle.checked = !toggle.checked;
    });

    const actions = document.createElement('div');
    actions.className = 'mod-actions';
    const renameBtn = document.createElement('button');
    renameBtn.className = 'btn ghost tiny';
    renameBtn.textContent = 'Rename';
    renameBtn.addEventListener('click', async () => {
      const name2 = await zcPrompt('NEW DESIGNATION', mod.name);
      if (!name2 || name2 === mod.name) return;
      const data = await call('renameMod', mod.id, name2);
      if (data) { state = data; render(); toast(`Renamed to “${name2}”`); }
    });
    const delBtn = document.createElement('button');
    delBtn.className = 'btn danger tiny';
    delBtn.textContent = 'Uninstall';
    delBtn.addEventListener('click', async () => {
      const note = mod.modType === 'gamefolder'
        ? ' Replaced game files are restored from backup.'
        : '';
      if (!window.confirm(`Uninstall “${mod.name}”? Its files are removed from the game and the library.${note}`)) return;
      const data = await verifiedCall('uninstallMod', [mod.id], 'Uninstall');
      if (data) { state = data; render(); toast(`“${mod.name}” uninstalled`); }
    });
    actions.append(renameBtn, delBtn);

    // Update flag: auto-updatable gets a button; manual gets an open-page chip.
    let updateEl = null;
    if (mod.updateInfo && mod.updateInfo.available) {
      updateEl = document.createElement('button');
      updateEl.className = `update-flag ${mod.updateInfo.auto ? 'auto' : 'manual'}`;
      updateEl.textContent = mod.updateInfo.auto
        ? `⬆ Update to ${mod.updateInfo.latest}`
        : `⬆ ${mod.updateInfo.latest} on Nexus`;
      updateEl.title = mod.updateInfo.auto
        ? `Update from ${mod.updateInfo.current} to ${mod.updateInfo.latest}`
        : `v${mod.updateInfo.latest} is out (you have ${mod.updateInfo.current}). Opens the Files page — press "Mod Manager Download" and it updates in place.`;
      updateEl.addEventListener('click', async () => {
        updateEl.disabled = true;
        try {
          const res = await call('updateMod', mod.id);
          if (!res) return;
          if (res.updated) {
            state = res.state;
            render();
            toast(`“${mod.name}” updated to ${mod.updateInfo.latest}.`);
          } else if (res.opened === 'website') {
            toast('Files page opened — press “Mod Manager Download” and the update installs in place.', 'info', 9000);
          }
        } finally {
          updateEl.disabled = false;
          $('#progress-toast').classList.add('hidden');
        }
      });
    }

    row.append(badge, srcBadge, main, flag);
    if (eaChip) row.appendChild(eaChip);
    if (buildChip) row.appendChild(buildChip);
    if (updateEl) row.appendChild(updateEl);
    row.append(toggle, actions);
    list.appendChild(row);
  }

  const autoUpdatable = state.mods.filter((m) => m.updateInfo && m.updateInfo.available && m.updateInfo.auto);
  $('#btn-update-all').classList.toggle('hidden', autoUpdatable.length < 2);
}

$('#btn-check-updates').addEventListener('click', async () => {
  const btn = $('#btn-check-updates');
  btn.disabled = true;
  btn.textContent = '⟳ Checking…';
  try {
    const res = await call('checkUpdates');
    if (!res) return;
    state = res.state;
    render();
    const { checked, updates, errors } = res.results;
    if (!checked) toast('No mods have an update source (Nexus/GitHub installs are tracked).', 'info', 6000);
    else toast(updates ? `${updates} update(s) available.` : `All ${checked} tracked mod(s) are up to date.`, updates ? 'warn' : 'info', 6000);
    for (const e of errors.slice(0, 3)) toast(e, 'error', 6000);
  } finally {
    btn.disabled = false;
    btn.textContent = '⟳ Check updates';
  }
});

$('#btn-update-all').addEventListener('click', async () => {
  const targetIds = state.mods
    .filter((m) => m.updateInfo && m.updateInfo.available && m.updateInfo.auto)
    .map((m) => m.id);
  for (const id of targetIds) {
    // A multi-entry archive update replaces its siblings too — re-check
    // against the freshest state before asking for another update.
    const mod = state.mods.find((m) => m.id === id);
    if (!mod || !mod.updateInfo || !mod.updateInfo.available) continue;
    const res = await call('updateMod', id);
    if (res && res.updated) { state = res.state; toast(`“${mod.name}” updated.`); }
    else if (res && res.state) state = res.state;
  }
  $('#progress-toast').classList.add('hidden');
  render();
});

// ------------------------------------------------------------------ load order

function orderableMods() {
  return state.mods
    .filter((m) => ['pak', 'iostore'].includes(m.modType))
    .sort((a, b) => (a.loadPriority || 0) - (b.loadPriority || 0));
}

function renderOrder() {
  const list = $('#order-list');
  list.innerHTML = '';
  const mods = orderableMods();
  $('#order-empty').classList.toggle('hidden', mods.length > 0);
  const order = pendingOrder
    ? pendingOrder.map((id) => mods.find((m) => m.id === id)).filter(Boolean)
    : mods;

  order.forEach((mod, idx) => {
    const row = document.createElement('div');
    row.className = `order-row${mod.enabled ? '' : ' disabled-mod'}`;
    row.draggable = true;
    row.dataset.id = mod.id;

    const grip = document.createElement('span');
    grip.className = 'order-grip';
    grip.textContent = '⣿';
    const num = document.createElement('span');
    num.className = 'order-num';
    num.textContent = String(idx + 1).padStart(2, '0');
    const name = document.createElement('span');
    name.className = 'order-name';
    name.textContent = mod.name;
    const hint = document.createElement('span');
    hint.className = 'order-hint';
    hint.textContent = idx === order.length - 1 ? 'loads last — wins conflicts' : '';
    row.append(grip, num, name, hint);

    row.addEventListener('dragstart', (e) => {
      row.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', mod.id);
    });
    row.addEventListener('dragend', () => row.classList.remove('dragging'));
    list.appendChild(row);
  });

  $('#btn-apply-order').disabled = !pendingOrder;
  $('#btn-rollback-order').disabled = !(state && state.lastOrderBackup);
}

$('#order-list').addEventListener('dragover', onOrderDragOver);

function onOrderDragOver(e) {
  e.preventDefault();
  const dragging = $('#order-list .order-row.dragging');
  if (!dragging) return;
  const rows = $$('#order-list .order-row:not(.dragging)');
  let after = null;
  for (const row of rows) {
    const box = row.getBoundingClientRect();
    if (e.clientY < box.top + box.height / 2) { after = row; break; }
  }
  const list = $('#order-list');
  if (after) list.insertBefore(dragging, after);
  else list.appendChild(dragging);
  pendingOrder = $$('#order-list .order-row').map((r) => r.dataset.id);
  $$('#order-list .order-row').forEach((r, i) => {
    r.querySelector('.order-num').textContent = String(i + 1).padStart(2, '0');
    r.querySelector('.order-hint').textContent = i === $$('#order-list .order-row').length - 1 ? 'loads last — wins conflicts' : '';
  });
  $('#btn-apply-order').disabled = false;
}

$('#btn-suggest-order').addEventListener('click', async () => {
  const suggestion = await call('suggestLoadOrder');
  if (!suggestion) return;
  if (!suggestion.changed) {
    toast('Current order already matches the suggestion.');
    return;
  }
  pendingOrder = suggestion.orderedIds;
  renderOrder();
  toast(suggestion.rationale, 'info', 7000);
  for (const d of suggestion.decisions.slice(0, 4)) toast(d, 'warn', 8000);
  toast('Review the suggested order, then press Apply.', 'info', 7000);
});

// Review-before-apply: show which conflict winners the drafted order changes,
// then apply only on confirmation. The old order stays available for rollback.
$('#btn-apply-order').addEventListener('click', async () => {
  if (!pendingOrder) return;
  const preview = await call('previewLoadOrder', pendingOrder);
  if (!preview) return;
  const sub = $('#order-review-sub');
  sub.textContent = `${preview.movedCount} mod(s) move.` + (preview.pairs.length
    ? ` ${preview.changedCount ? `${preview.changedCount} conflict winner(s) change:` : 'No conflict winners change.'}`
    : ' No conflicts between orderable mods.');
  const list = $('#order-review-list');
  list.innerHTML = '';
  for (const p of preview.pairs) {
    const row = document.createElement('div');
    row.className = 'import-row order-review-row';
    const info = document.createElement('div');
    info.className = 'import-info';
    const name = document.createElement('div');
    name.className = 'import-name';
    name.textContent = `${p.aName} ↔ ${p.bName}`;
    const meta = document.createElement('div');
    meta.className = 'import-meta';
    const overlap = p.packageCount
      ? `${p.packageCount} shared asset${p.packageCount === 1 ? '' : 's'}`
      : `${p.fileCount} matching file${p.fileCount === 1 ? '' : 's'}`;
    meta.textContent = p.changed
      ? `${overlap} · winner changes: ${p.oldWinnerName} → ${p.newWinnerName}`
      : `${overlap} · winner stays: ${p.newWinnerName}`;
    if (p.changed) row.classList.add('winner-changes');
    info.append(name, meta);
    row.appendChild(info);
    list.appendChild(row);
  }
  $('#order-review-modal').classList.remove('hidden');
});

$('#btn-order-review-apply').addEventListener('click', async () => {
  $('#order-review-modal').classList.add('hidden');
  if (!pendingOrder) return;
  const data = await call('applyLoadOrder', pendingOrder);
  if (data) {
    state = data;
    pendingOrder = null;
    render();
    toast('Load order applied — deployed paks renumbered. “Undo last apply” restores the old order.');
  }
});

$('#btn-rollback-order').addEventListener('click', async () => {
  const data = await call('rollbackLoadOrder');
  if (data) {
    state = data;
    pendingOrder = null;
    render();
    toast('Previous load order restored. Pressing again re-applies the undone order.');
  }
});

// ------------------------------------------------------------------ UE4SS start order (mods.txt)

function renderUe4ssOrder() {
  const section = $('#ue4ss-order-section');
  const st = state.ue4ssOrder || { managed: [], others: [], applied: false };
  const show = st.managed.length > 0 || st.applied;
  section.classList.toggle('hidden', !show);
  if (!show) { pendingUe4ssOrder = null; return; }

  const list = $('#ue4ss-order-list');
  list.innerHTML = '';
  const order = pendingUe4ssOrder
    ? pendingUe4ssOrder.map((id) => st.managed.find((m) => m.id === id)).filter(Boolean)
    : st.managed;

  order.forEach((m, idx) => {
    const row = document.createElement('div');
    row.className = 'order-row ue4ss-row';
    row.draggable = true;
    row.dataset.id = m.id;
    const grip = document.createElement('span');
    grip.className = 'order-grip';
    grip.textContent = '⣿';
    const num = document.createElement('span');
    num.className = 'order-num';
    num.textContent = String(idx + 1).padStart(2, '0');
    const name = document.createElement('span');
    name.className = 'order-name';
    name.textContent = m.name;
    const pass = document.createElement('span');
    pass.className = `ue4ss-pass pass-${m.pass}`;
    pass.textContent = m.pass === 'dll' ? 'DLL PASS' : 'LUA PASS';
    pass.title = m.pass === 'dll'
      ? 'Starts while the UE4SS runtime initializes — before every Lua mod.'
      : 'Starts once the Lua scripting runtime exists.';
    row.append(grip, num, name, pass);
    row.addEventListener('dragstart', (e) => {
      row.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', m.id);
    });
    row.addEventListener('dragend', () => row.classList.remove('dragging'));
    list.appendChild(row);
  });

  // First apply opts in even without reordering; afterwards only a change arms it.
  $('#btn-apply-ue4ss-order').disabled = !(pendingUe4ssOrder || (!st.applied && st.managed.length));
  const notes = [];
  notes.push(st.applied
    ? 'Managed block active in mods.txt — entries live just before Keybinds, its warning kept attached.'
    : 'Applying writes a managed block into mods.txt (before the Keybinds entry) and retires the enabled.txt markers.');
  if (st.others.length) {
    notes.push(`Unmanaged entries preserved as-is: ${st.others.map((o) => `${o.name}${o.enabled ? '' : ' (off)'}`).join(', ')}.`);
  }
  $('#ue4ss-order-note').textContent = notes.join('  ');
}

$('#ue4ss-order-list').addEventListener('dragover', (e) => {
  e.preventDefault();
  const dragging = $('#ue4ss-order-list .order-row.dragging');
  if (!dragging) return;
  const rows = $$('#ue4ss-order-list .order-row:not(.dragging)');
  let after = null;
  for (const row of rows) {
    const box = row.getBoundingClientRect();
    if (e.clientY < box.top + box.height / 2) { after = row; break; }
  }
  const list = $('#ue4ss-order-list');
  if (after) list.insertBefore(dragging, after);
  else list.appendChild(dragging);
  pendingUe4ssOrder = $$('#ue4ss-order-list .order-row').map((r) => r.dataset.id);
  $$('#ue4ss-order-list .order-row').forEach((r, i) => {
    r.querySelector('.order-num').textContent = String(i + 1).padStart(2, '0');
  });
  $('#btn-apply-ue4ss-order').disabled = false;
});

$('#btn-apply-ue4ss-order').addEventListener('click', async () => {
  const st = state.ue4ssOrder || { managed: [] };
  const ids = pendingUe4ssOrder || st.managed.map((m) => m.id);
  if (!ids.length) return;
  const data = await call('applyUe4ssOrder', ids);
  if (data) {
    state = data;
    pendingUe4ssOrder = null;
    render();
    toast('UE4SS start order written to mods.txt (managed block, before Keybinds).');
  }
});

// ------------------------------------------------------------------ diagnostics

$('#btn-run-diag').addEventListener('click', runDiagnostics);

async function runDiagnostics() {
  const data = await call('runDiagnostics');
  if (!data) return;
  const icons = { good: '✔', info: 'ℹ', warning: '⚠', error: '✖' };
  const list = $('#diag-list');
  list.innerHTML = '';
  for (const item of data.items) {
    const row = document.createElement('div');
    row.className = `diag-row ${item.level}`;
    const icon = document.createElement('span');
    icon.className = 'diag-icon';
    icon.textContent = icons[item.level] || '·';
    const body = document.createElement('div');
    const title = document.createElement('div');
    title.className = 'diag-title';
    title.textContent = item.title;
    const msg = document.createElement('div');
    msg.className = 'diag-msg';
    msg.textContent = item.message;
    body.append(title, msg);
    row.append(icon, body);
    list.appendChild(row);
  }
  renderConflictDetail();
}

function modName(id) {
  const m = state.mods.find((x) => x.id === id);
  return m ? m.name : id;
}

function conflictSummaryText(c) {
  const parts = [];
  if (c.packageCount) parts.push(`${c.packageCount} overlapping asset${c.packageCount === 1 ? '' : 's'}`);
  if (c.fileCount) parts.push(`${c.fileCount} matching file name${c.fileCount === 1 ? '' : 's'}`);
  if (c.hookCount) parts.push(`${c.hookCount} shared UE4SS hook/keybind${c.hookCount === 1 ? '' : 's'}`);
  return parts.join(', ') || 'overlap';
}

// One conflict pair as a DOM row: names, certainty, overlap summary, samples, winner.
function buildConflictRow(c) {
  const row = document.createElement('div');
  row.className = `conflict-row ${c.certainty}`;

  const head = document.createElement('div');
  head.className = 'conflict-head';
  const badge = document.createElement('span');
  badge.className = `certainty-badge ${c.certainty}`;
  badge.textContent = c.certainty === 'confirmed' ? 'CONFIRMED' : 'SUSPECTED';
  badge.title = c.certainty === 'confirmed'
    ? 'These mods modify the same game assets (verified with retoc).'
    : 'These mods ship identically named files and may modify the same content.';
  const names = document.createElement('span');
  names.className = 'conflict-names';
  names.textContent = `${modName(c.aId)}  ↔  ${modName(c.bId)}`;
  head.append(badge, names);

  const summary = document.createElement('div');
  summary.className = 'conflict-summary';
  const hookOnly = c.hookCount && !c.packageCount && !c.fileCount;
  if (hookOnly) {
    // Hooks stack in UE4SS — there is no single winner; both callbacks run.
    summary.textContent = `${conflictSummaryText(c)} — both mods' callbacks run, in UE4SS load order (mods.txt)`;
  } else {
    const winner = document.createElement('span');
    winner.className = 'winner';
    winner.textContent = modName(c.winnerId);
    summary.append(
      document.createTextNode(`${conflictSummaryText(c)} — `),
      winner,
      document.createTextNode(' loads later and wins'),
    );
  }

  row.append(head, summary);

  if (c.samples && c.samples.length) {
    const list = document.createElement('div');
    list.className = 'conflict-samples';
    for (const s of c.samples) {
      const line = document.createElement('div');
      line.textContent = s;
      list.appendChild(line);
    }
    const hidden = c.packageCount + c.fileCount - c.samples.length;
    if (hidden > 0) {
      const more = document.createElement('div');
      more.className = 'dim';
      more.textContent = `… and ${hidden} more`;
      list.appendChild(more);
    }
    row.appendChild(list);
  }
  return row;
}

// Inline expansion under a Hangar Bay mod row.
function buildConflictPanel(mod, myConflicts) {
  const panel = document.createElement('div');
  panel.className = 'conflict-expand';
  for (const c of myConflicts) panel.appendChild(buildConflictRow(c));
  const hint = document.createElement('div');
  hint.className = 'conflict-hint dim';
  hint.textContent = 'Resolve by disabling one mod, or set which one wins in Load Order (later = wins).';
  panel.appendChild(hint);
  return panel;
}

function renderConflictDetail() {
  renderConflictMatrix();
  const box = $('#conflict-detail');
  box.innerHTML = '';
  if (state.conflicts.length) {
    const h = document.createElement('h3');
    h.textContent = 'CONFLICT REPORT';
    box.appendChild(h);
    for (const c of state.conflicts) box.appendChild(buildConflictRow(c));
  }
  renderUe4ssHookReport();
}

// Hook/keybind collisions across ALL active UE4SS mods, including unmanaged
// folders in the game's ue4ss/Mods (which the pairwise report can't cover).
function renderUe4ssHookReport() {
  const box = $('#ue4ss-hook-report');
  box.innerHTML = '';
  const report = state.ue4ssHooks;
  if (!report || !report.entries.length) return;

  const h = document.createElement('h3');
  h.textContent = 'UE4SS HOOK REPORT';
  box.appendChild(h);

  const summary = document.createElement('div');
  summary.className = 'diag-msg';
  const names = report.entries
    .map((e) => `${e.name}${e.managed ? '' : ' (unmanaged)'} — ${e.hooks.length} hook${e.hooks.length === 1 ? '' : 's'}, ${e.keybinds.length} keybind${e.keybinds.length === 1 ? '' : 's'}`);
  summary.textContent = `Scanned ${report.entries.length} active UE4SS mod(s): ${names.join(' · ')}`;
  box.appendChild(summary);

  if (!report.conflicts.length) {
    const ok = document.createElement('div');
    ok.className = 'diag-msg';
    ok.style.marginTop = '6px';
    ok.textContent = 'No shared hook or keybind targets — mods do not collide.';
    box.appendChild(ok);
    return;
  }

  for (const c of report.conflicts) {
    const row = document.createElement('div');
    row.className = 'conflict-row suspected';

    const head = document.createElement('div');
    head.className = 'conflict-head';
    const badge = document.createElement('span');
    badge.className = 'certainty-badge suspected';
    badge.textContent = c.kind === 'keybind' ? 'KEYBIND' : 'HOOK';
    badge.title = c.kind === 'keybind'
      ? 'Both mods bind this key — every callback fires on one press.'
      : 'Both mods hook this UFunction — callbacks stack; mods that change params/returns can fight.';
    const names2 = document.createElement('span');
    names2.className = 'conflict-names';
    names2.textContent = c.members.map((m) => m.name + (m.managed ? '' : ' (unmanaged)')).join('  ↔  ');
    head.append(badge, names2);

    const target = document.createElement('div');
    target.className = 'conflict-samples';
    const line = document.createElement('div');
    line.textContent = c.key;
    target.appendChild(line);

    const note = document.createElement('div');
    note.className = 'conflict-summary';
    note.textContent = c.kind === 'keybind'
      ? 'Rebind one mod’s key (edit its Scripts/main.lua) to avoid double-triggering.'
      : 'Callbacks run in UE4SS load order (mods.txt). Usually fine unless both alter the same values.';

    row.append(head, target, note);
    box.appendChild(row);
  }
}

// N×N grid of enabled mods; cells mark confirmed/suspected incompatibilities.
function renderConflictMatrix() {
  const box = $('#conflict-matrix');
  box.innerHTML = '';
  const mods = state.mods.filter((m) => m.enabled);
  if (mods.length < 2) return;
  const pairMap = new Map();
  for (const c of state.conflicts) {
    pairMap.set(`${c.aId}|${c.bId}`, c);
    pairMap.set(`${c.bId}|${c.aId}`, c);
  }

  const h = document.createElement('h3');
  h.textContent = 'COMPATIBILITY MATRIX';
  box.appendChild(h);

  const wrap = document.createElement('div');
  wrap.className = 'matrix-wrap';
  const table = document.createElement('table');
  table.className = 'matrix';

  const header = document.createElement('tr');
  header.appendChild(document.createElement('th'));
  for (const m of mods) {
    const th = document.createElement('th');
    th.className = 'matrix-col';
    const span = document.createElement('span');
    span.textContent = m.name.length > 18 ? m.name.slice(0, 17) + '…' : m.name;
    span.title = m.name;
    th.appendChild(span);
    header.appendChild(th);
  }
  table.appendChild(header);

  for (const rowMod of mods) {
    const tr = document.createElement('tr');
    const th = document.createElement('th');
    th.className = 'matrix-row';
    th.textContent = rowMod.name.length > 26 ? rowMod.name.slice(0, 25) + '…' : rowMod.name;
    th.title = rowMod.name;
    tr.appendChild(th);
    for (const colMod of mods) {
      const td = document.createElement('td');
      if (rowMod.id === colMod.id) {
        td.className = 'matrix-self';
        td.textContent = '·';
      } else {
        const c = pairMap.get(`${rowMod.id}|${colMod.id}`);
        if (c) {
          td.className = `matrix-hit ${c.certainty}`;
          td.textContent = c.certainty === 'confirmed' ? '✖' : '▲';
          const winner = modName(c.winnerId);
          td.title = `${modName(c.aId)} ↔ ${modName(c.bId)}: ${conflictSummaryText(c)} — ${winner} wins`;
        } else {
          td.className = 'matrix-clear';
          td.textContent = '✔';
          td.title = 'No overlap detected';
        }
      }
      tr.appendChild(td);
    }
    table.appendChild(tr);
  }
  wrap.appendChild(table);
  box.appendChild(wrap);

  const legend = document.createElement('div');
  legend.className = 'matrix-legend dim';
  legend.textContent = '✔ compatible · ▲ suspected overlap · ✖ confirmed asset overlap — hover a cell for details';
  box.appendChild(legend);
}

// ------------------------------------------------------------------ settings

function renderProfiles() {
  const sel = $('#profile-select');
  const current = sel.value;
  sel.innerHTML = '<option value="">— select —</option>';
  for (const p of state.profiles || []) {
    const opt = document.createElement('option');
    opt.value = p.id;
    const active = p.entries.filter((e) => e.enabled).length;
    opt.textContent = `${p.name} (${active} active)`;
    sel.appendChild(opt);
  }
  if ([...sel.options].some((o) => o.value === current)) sel.value = current;
}

$('#btn-profile-save').addEventListener('click', async () => {
  const name = await zcPrompt('PROFILE DESIGNATION');
  if (!name) return;
  const data = await call('saveProfile', name);
  if (data) { state = data; render(); toast(`Profile “${name}” saved (current mods + order).`); }
});
$('#btn-profile-apply').addEventListener('click', async () => {
  const id = $('#profile-select').value;
  if (!id) { toast('Select a profile first.', 'warn'); return; }
  const res = await call('applyProfile', id);
  if (res) {
    state = res.state;
    pendingOrder = null;
    render();
    toast(`Profile “${res.profileName}” deployed.`);
    for (const w of res.warnings) toast(w, 'warn', 7000);
  }
});
$('#btn-profile-delete').addEventListener('click', async () => {
  const sel = $('#profile-select');
  const id = sel.value;
  if (!id) { toast('Select a profile first.', 'warn'); return; }
  const name = sel.options[sel.selectedIndex].textContent;
  if (!window.confirm(`Delete profile ${name}? Installed mods are not affected.`)) return;
  const data = await call('deleteProfile', id);
  if (data) { state = data; render(); toast('Profile deleted.'); }
});

function renderSettings() {
  renderProfiles();
  // Nexus
  const nx = state.nexus || {};
  const keyStorage = nx.keyEncrypted ? ' · encrypted at rest' : '';
  $('#nexus-status').textContent = nx.hasKey
    ? (nx.user ? `Key valid — ${nx.user.name}${nx.user.isPremium ? ' (premium)' : ''}${keyStorage}` : `Key stored${keyStorage}`)
    : 'No key stored';
  $('#nxm-status').textContent = nx.nxmRegistered
    ? 'Registered — “Mod Manager Download” buttons install here'
    : 'Not registered';
  $('#btn-nxm-register').textContent = nx.nxmRegistered ? 'Unregister' : 'Register handler';
  // UE4SS
  $('#ue4ss-settings-status').textContent = state.ue4ss.message;
  $('#btn-install-ue4ss').textContent = state.ue4ss.healthy ? 'Reinstall latest' : 'Download & install';
  $('#set-game-path').textContent = state.settings.gamePath || 'Not set';
  $('#set-retoc-path').textContent = state.settings.retocPath || (state.retoc.found ? `Auto: ${state.retoc.path}` : 'Auto-detect (not found)');
  $('#set-7z-path').textContent = state.settings.sevenZipPath || (state.sevenZip ? 'Auto-detected' : 'Auto-detect (not found)');
  $('#chk-close-on-launch').checked = !!state.settings.closeOnLaunch;
  $('#chk-reduced-motion').checked = !!state.settings.reducedMotion;
}

$('#btn-browse-game').addEventListener('click', async () => {
  const data = await call('browseGamePath');
  if (data) { state = data; render(); }
});
$('#btn-browse-retoc').addEventListener('click', async () => {
  const data = await call('browseToolPath', { key: 'retocPath', title: 'Locate retoc.exe', filterName: 'retoc' });
  if (data) { state = data; render(); }
});
$('#btn-browse-7z').addEventListener('click', async () => {
  const data = await call('browseToolPath', { key: 'sevenZipPath', title: 'Locate 7z.exe', filterName: '7-Zip' });
  if (data) { state = data; render(); }
});
$('#btn-nexus-save').addEventListener('click', async () => {
  const key = $('#nexus-key-input').value;
  if (!key.trim()) { toast('Paste your Nexus API key first.', 'warn'); return; }
  const data = await call('setNexusKey', key);
  if (data) {
    state = data;
    $('#nexus-key-input').value = '';
    render();
    toast(`Nexus key validated — welcome, ${state.nexus.user.name}.`);
  }
});
$('#btn-nexus-clear').addEventListener('click', async () => {
  const data = await call('clearNexusKey');
  if (data) { state = data; render(); toast('Nexus key cleared.'); }
});
$('#btn-nxm-register').addEventListener('click', async () => {
  const registered = state.nexus && state.nexus.nxmRegistered;
  const data = await call(registered ? 'unregisterNxm' : 'registerNxm');
  if (data) {
    state = data;
    render();
    toast(registered ? 'nxm:// handler removed.' : 'nxm:// links now open in Mod Command.');
  }
});
$('#btn-install-ue4ss').addEventListener('click', async () => {
  const btn = $('#btn-install-ue4ss');
  btn.disabled = true;
  try {
    const res = await call('installUe4ss');
    if (res) {
      state = res.state;
      render();
      toast(`UE4SS installed (${res.version}). Lua/DLL mods are now supported.`);
    }
  } finally {
    btn.disabled = false;
    $('#progress-toast').classList.add('hidden');
  }
});
$('#chk-close-on-launch').addEventListener('change', (e) => saveSetting({ closeOnLaunch: e.target.checked }));
$('#chk-reduced-motion').addEventListener('change', (e) => saveSetting({ reducedMotion: e.target.checked }));

async function saveSetting(patch) {
  const data = await call('saveSettings', patch);
  if (data) { state = data; render(); }
}

// ------------------------------------------------------------------ actions

async function refreshState() {
  const data = await call('getState');
  if (data) { state = data; render(); }
}

function installResultsToToasts(payload) {
  if (!payload) return;
  state = payload.state;
  pendingOrder = null;
  pendingUe4ssOrder = null;
  render();
  for (const r of payload.results) {
    if (r.ok && r.pendingFomod) {
      fomodQueue.push(r);
    } else if (r.ok && r.note) {
      toast(r.message, 'info', 8000);
    } else if (r.ok) {
      toast(`Installed “${r.name}” (${TYPE_LABEL[r.modType] || r.modType})`);
      for (const w of r.warnings) toast(`${r.name}: ${w}`, 'warn', 6000);
    } else {
      toast(`${r.source}: ${r.error}`, 'error', 8000);
    }
  }
  processFomodQueue();
}

$$('[data-action="install-archive"]').forEach((b) =>
  b.addEventListener('click', async () => installResultsToToasts(await call('installMods'))));
$$('[data-action="install-folder"]').forEach((b) =>
  b.addEventListener('click', async () => installResultsToToasts(await call('installFolder'))));

$$('[data-open]').forEach((b) =>
  b.addEventListener('click', () => call('openManagedPath', b.dataset.open)));
$$('[data-url]').forEach((b) =>
  b.addEventListener('click', () => call('openExternal', b.dataset.url)));

$('#btn-launch').addEventListener('click', async () => {
  const data = await call('launchGame');
  if (data) toast('Launch signal sent to Steam. May the Force be with you.');
});
$('#btn-launch-direct').addEventListener('click', async () => {
  const data = await call('launchGameDirect');
  if (data) toast('Game launched directly.');
});

// ------------------------------------------------------------------ drag & drop install

let dragDepth = 0;
window.addEventListener('dragenter', (e) => {
  e.preventDefault();
  if (e.dataTransfer && [...e.dataTransfer.types].includes('Files')) {
    dragDepth += 1;
    $('#drop-overlay').classList.remove('hidden');
  }
});
window.addEventListener('dragleave', (e) => {
  e.preventDefault();
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) $('#drop-overlay').classList.add('hidden');
});
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', async (e) => {
  e.preventDefault();
  dragDepth = 0;
  $('#drop-overlay').classList.add('hidden');
  const paths = [...(e.dataTransfer ? e.dataTransfer.files : [])]
    .map((f) => window.zc.pathForFile(f))
    .filter(Boolean);
  if (!paths.length) return;
  installResultsToToasts(await call('installDropped', paths));
});

// ------------------------------------------------------------------ Holonet (Nexus browser)

const CATEGORIES = ['Gameplay', 'Outfits', 'User Interface', 'Miscellaneous', 'Characters', 'Visuals', 'Audio', 'Weapons', 'Utilities'];
const PAGE_SIZE = 24;
const browse = { mods: [], total: 0, offset: 0, loading: false, loaded: false, isPremium: false, hasKey: false };

for (const c of CATEGORIES) {
  const opt = document.createElement('option');
  opt.value = c;
  opt.textContent = c;
  $('#browse-category').appendChild(opt);
}

function browseParams() {
  return {
    query: $('#browse-search').value,
    category: $('#browse-category').value || null,
    sort: $('#browse-sort').value,
    count: PAGE_SIZE,
  };
}

async function loadBrowse(reset) {
  if (browse.loading) return;
  browse.loading = true;
  const statusEl = $('#browse-status');
  if (reset) {
    browse.offset = 0;
    browse.mods = [];
    $('#browse-grid').innerHTML = '';
    statusEl.classList.remove('hidden');
    statusEl.textContent = 'Contacting the holonet…';
  }
  try {
    const res = await window.zc.browseNexus({ ...browseParams(), offset: browse.offset });
    if (!res.ok) throw new Error(res.error);
    const { mods, totalCount, isPremium, hasKey } = res.data;
    browse.total = totalCount;
    browse.isPremium = isPremium;
    browse.hasKey = hasKey;
    browse.mods.push(...mods);
    browse.offset += mods.length;
    browse.loaded = true;
    statusEl.classList.add('hidden');
    for (const m of mods) $('#browse-grid').appendChild(buildBrowseCard(m));
    $('#browse-count').textContent = `${browse.mods.length} of ${totalCount} mod${totalCount === 1 ? '' : 's'}`;
    $('#tab-nexus-count').textContent = totalCount || '';
    $('#browse-more').classList.toggle('hidden', browse.offset >= totalCount);
    if (!totalCount) {
      statusEl.classList.remove('hidden');
      statusEl.textContent = 'No mods match that search.';
    }
  } catch (err) {
    statusEl.classList.remove('hidden');
    statusEl.textContent = `Holonet unreachable: ${err.message}`;
  } finally {
    browse.loading = false;
  }
}

function buildBrowseCard(m) {
  const card = document.createElement('div');
  card.className = 'browse-card';

  const pic = document.createElement('div');
  pic.className = 'browse-pic';
  const img = document.createElement('img');
  img.src = m.picture || 'assets/mod-placeholder.svg';
  img.loading = 'lazy';
  img.alt = '';
  img.addEventListener('error', () => { img.src = 'assets/mod-placeholder.svg'; }, { once: true });
  pic.appendChild(img);

  const body = document.createElement('div');
  body.className = 'browse-body';
  const name = document.createElement('div');
  name.className = 'browse-name';
  name.textContent = m.name;
  name.title = m.name;
  const meta = document.createElement('div');
  meta.className = 'browse-meta';
  meta.textContent = `${m.author}${m.version ? ` · v${m.version}` : ''}${m.category ? ` · ${m.category}` : ''}`;
  const stats = document.createElement('div');
  stats.className = 'browse-stats';
  stats.textContent = `⭳ ${(m.downloads || 0).toLocaleString()}   ♥ ${(m.endorsements || 0).toLocaleString()}   ${new Date(m.updatedAt).toLocaleDateString()}`;
  const summary = document.createElement('div');
  summary.className = 'browse-summary';
  summary.textContent = m.summary;
  body.append(name, meta, stats, summary);

  const actions = document.createElement('div');
  actions.className = 'browse-actions';
  const installBtn = document.createElement('button');
  installBtn.className = 'btn tiny primary';
  installBtn.textContent = '⭳ Install';
  installBtn.title = browse.isPremium
    ? 'Download and install directly'
    : 'Opens the mod’s Files tab — click “Mod Manager Download” there and it installs here automatically';
  installBtn.addEventListener('click', async () => {
    installBtn.disabled = true;
    try {
      const res = await call('installRemote', m.modId, m.name);
      if (!res) return;
      if (res.opened === 'website') {
        toast(`Files page opened for “${m.name}” — press “Mod Manager Download” and it will install here automatically.`, 'info', 9000);
      } else if (res.pendingFomod) {
        state = res.state;
        render();
        toast(`“${m.name}” ships a guided installer — answer its steps to finish.`, 'info', 8000);
      } else if (res.installed) {
        state = res.state;
        render();
        toast(res.count > 1
          ? `Installed ${res.count} mods from “${m.name}” — each is its own entry.`
          : `Installed “${m.name}” from the holonet.`);
      }
    } finally {
      installBtn.disabled = false;
    }
  });
  const pageBtn = document.createElement('button');
  pageBtn.className = 'btn ghost tiny';
  pageBtn.textContent = 'Page ↗';
  pageBtn.addEventListener('click', () => call('openExternal', m.url));
  actions.append(installBtn, pageBtn);

  card.append(pic, body, actions);
  return card;
}

// --------------------------------------------------- featured transmissions (promoted authors)

const featured = { pool: [], fillers: [], offset: 0, timer: null, loaded: false };
const FEATURED_SLOTS = 3;
const FEATURED_INTERVAL_MS = 6000;

async function loadFeatured() {
  featured.loaded = true;
  try {
    const res = await window.zc.promotedMods();
    if (!res.ok) return;
    featured.pool = res.data.mods || [];
    featured.fillers = res.data.fillers || [];
    $('#featured-authors').textContent = (res.data.authors || []).length
      ? `by ${res.data.authors.join(', ')}` : '';
    renderFeatured(true);
  } catch (_) { /* strip stays hidden */ }
}

function renderFeatured(resetTimer) {
  const strip = $('#featured-strip');
  const slots = $('#featured-slots');
  if (!featured.pool.length && !featured.fillers.length) {
    strip.classList.add('hidden');
    stopFeaturedTimer();
    return;
  }
  strip.classList.remove('hidden');
  slots.classList.remove('featured-fade-in');
  slots.innerHTML = '';

  // Promoted mods first, cycling when there are more than fit.
  const n = featured.pool.length;
  const promotedShown = Math.min(FEATURED_SLOTS, n);
  const usedIds = new Set();
  for (let i = 0; i < promotedShown; i++) {
    const mod = featured.pool[(featured.offset + i) % n];
    usedIds.add(mod.modId);
    slots.appendChild(buildFeaturedCard(mod, false));
  }
  // Blank slots get random top mods from the main listing.
  let blank = FEATURED_SLOTS - promotedShown;
  const available = featured.fillers.filter((m) => !usedIds.has(m.modId));
  while (blank > 0 && available.length) {
    const pick = available.splice(Math.floor(Math.random() * available.length), 1)[0];
    slots.appendChild(buildFeaturedCard(pick, true));
    blank -= 1;
  }

  void slots.offsetWidth; // restart the fade animation
  slots.classList.add('featured-fade-in');
  if (resetTimer) {
    stopFeaturedTimer();
    // Keep rotating while there is variety: extra promoted mods to page through,
    // or filler slots that reshuffle each tick.
    const hasVariety = n > FEATURED_SLOTS
      || (n < FEATURED_SLOTS && featured.fillers.length > FEATURED_SLOTS - n);
    if (hasVariety && !(state && state.settings.reducedMotion)) {
      featured.timer = setInterval(() => {
        featured.offset = n ? (featured.offset + FEATURED_SLOTS) % n : 0;
        renderFeatured(false);
      }, FEATURED_INTERVAL_MS);
    }
  }
}

function stopFeaturedTimer() {
  if (featured.timer) { clearInterval(featured.timer); featured.timer = null; }
}

function buildFeaturedCard(m, isFiller) {
  const card = buildBrowseCard(m);
  card.classList.add('featured-card');
  if (isFiller) card.classList.add('filler-card');
  const tag = document.createElement('div');
  tag.className = `featured-tag${isFiller ? ' filler' : ''}`;
  tag.textContent = isFiller ? 'TOP RATED' : 'PROMOTED';
  card.prepend(tag);
  return card;
}

$('#featured-strip')?.addEventListener('mouseenter', stopFeaturedTimer);
$('#featured-strip')?.addEventListener('mouseleave', () => renderFeatured(true));

let browseSearchTimer = null;
$('#browse-search').addEventListener('input', () => {
  clearTimeout(browseSearchTimer);
  browseSearchTimer = setTimeout(() => loadBrowse(true), 400);
});
$('#browse-category').addEventListener('change', () => loadBrowse(true));
$('#browse-sort').addEventListener('change', () => loadBrowse(true));
$('#browse-refresh').addEventListener('click', () => loadBrowse(true));
$('#browse-more').addEventListener('click', () => loadBrowse(false));

// --------------------------------------------------- The Forge (curated GitHub)

const forge = { mods: [], loaded: false, loading: false };

function setSourceTab(which) {
  $('#tab-nexus').classList.toggle('active', which === 'nexus');
  $('#tab-forge').classList.toggle('active', which === 'forge');
  $('#nexus-pane').classList.toggle('hidden', which !== 'nexus');
  $('#forge-pane').classList.toggle('hidden', which !== 'forge');
  if (which === 'forge' && !forge.loaded) loadForge();
}
$('#tab-nexus').addEventListener('click', () => setSourceTab('nexus'));
$('#tab-forge').addEventListener('click', () => setSourceTab('forge'));

async function loadForge() {
  if (forge.loading) return;
  forge.loading = true;
  const statusEl = $('#forge-status');
  statusEl.classList.remove('hidden');
  statusEl.textContent = 'Contacting the forge…';
  $('#forge-grid').innerHTML = '';
  try {
    const res = await window.zc.browseGithub({ query: $('#forge-search').value, sort: $('#forge-sort').value });
    if (!res.ok) throw new Error(res.error);
    forge.mods = res.data.mods;
    forge.loaded = true;
    statusEl.classList.add('hidden');
    for (const m of forge.mods) $('#forge-grid').appendChild(buildForgeCard(m));
    $('#forge-grid').appendChild(buildSuggestCard());
    $('#forge-count').textContent = `${forge.mods.length} curated repo${forge.mods.length === 1 ? '' : 's'}`;
    $('#tab-forge-count').textContent = res.data.allowlistCount || forge.mods.length || '';
    if (!forge.mods.length) statusEl.classList.remove('hidden'), statusEl.textContent = 'No curated repos match.';
  } catch (err) {
    statusEl.classList.remove('hidden');
    statusEl.textContent = `Forge unreachable: ${err.message}`;
  } finally {
    forge.loading = false;
  }
}

function buildForgeCard(m) {
  const card = document.createElement('div');
  card.className = 'browse-card forge-card';
  if (!m.release) card.classList.add('no-release');

  const tag = document.createElement('div');
  tag.className = 'featured-tag filler';
  tag.textContent = 'GITHUB';
  card.appendChild(tag);

  const body = document.createElement('div');
  body.className = 'browse-body';
  const name = document.createElement('div');
  name.className = 'browse-name';
  name.textContent = m.name;
  name.title = m.fullName;
  const meta = document.createElement('div');
  meta.className = 'browse-meta';
  meta.textContent = `${m.author}${m.release ? ` · ${m.release.tag}` : ' · no release yet'}`;
  const stats = document.createElement('div');
  stats.className = 'browse-stats';
  stats.textContent = `★ ${m.stars}   ${new Date(m.updatedAt).toLocaleDateString()}${m.release ? `   ${(m.release.size / 1048576).toFixed(1)} MB` : ''}`;
  const summary = document.createElement('div');
  summary.className = 'browse-summary';
  summary.textContent = m.summary;
  body.append(name, meta, stats, summary);

  const actions = document.createElement('div');
  actions.className = 'browse-actions';
  const installBtn = document.createElement('button');
  installBtn.className = 'btn tiny primary';
  if (m.release) {
    installBtn.textContent = '⭳ Install';
    installBtn.addEventListener('click', async () => {
      installBtn.disabled = true;
      try {
        const res = await call('installGithub', m.fullName);
        if (!res || res.cancelled) return;
        if (res.pendingFomod) {
          state = res.state;
          render();
          toast(`“${m.name}” ships a guided installer — answer its steps to finish.`, 'info', 8000);
        } else if (res.installed) {
          state = res.state;
          render();
          toast(res.count > 1
            ? `Installed ${res.count} mods from “${m.name}” — each is its own entry.`
            : `Installed “${m.name}” from the forge.`);
        }
      } finally {
        installBtn.disabled = false;
        $('#progress-toast').classList.add('hidden');
      }
    });
  } else {
    installBtn.textContent = 'No release';
    installBtn.disabled = true;
  }
  const pageBtn = document.createElement('button');
  pageBtn.className = 'btn ghost tiny';
  pageBtn.textContent = 'Repo ↗';
  pageBtn.addEventListener('click', () => call('openExternal', m.url));
  actions.append(installBtn, pageBtn);

  card.append(body, actions);
  return card;
}

function buildSuggestCard() {
  const card = document.createElement('div');
  card.className = 'suggest-card';
  const p = document.createElement('div');
  p.className = 'suggest-text';
  p.textContent = 'Made a mod?';
  const btn = document.createElement('button');
  btn.className = 'btn tiny';
  btn.textContent = 'Suggest it on Discord ↗';
  btn.addEventListener('click', () => call('openExternal', 'https://discord.gg/YNPCA6qRq3'));
  card.append(p, btn);
  return card;
}

let forgeSearchTimer = null;
$('#forge-search').addEventListener('input', () => {
  clearTimeout(forgeSearchTimer);
  forgeSearchTimer = setTimeout(() => loadForge(), 350);
});
$('#forge-sort').addEventListener('change', () => loadForge());
$('#forge-refresh').addEventListener('click', () => loadForge());

// Lazy-load the grid + featured strip the first time the view opens.
$('.nav-item[data-view="browse"]').addEventListener('click', () => {
  if (!browse.loaded) { loadBrowse(true); $('#tab-nexus-count').textContent = ''; }
  if (!featured.loaded) loadFeatured();
  if (!forge.loaded) loadForge(); // fills the tab count even before first visit
});

// ------------------------------------------------------------------ Datapad (config editor)

const cfg = {
  list: [], listLoaded: false,
  file: null,      // entry from config-list
  lines: [],       // file content as lines (single source of truth)
  eol: '\n',
  mode: 'structured',
  dirty: false,
};

async function loadConfigList() {
  const data = await call('configList');
  if (!data) return;
  cfg.list = data;
  cfg.listLoaded = true;
  renderConfigList();
}

function renderConfigList() {
  const box = $('#config-list');
  box.innerHTML = '';
  const groups = new Map();
  for (const e of cfg.list) {
    if (!groups.has(e.group)) groups.set(e.group, []);
    groups.get(e.group).push(e);
  }
  for (const [group, entries] of groups) {
    const h = document.createElement('div');
    h.className = 'config-group';
    h.textContent = group.toUpperCase();
    box.appendChild(h);
    for (const e of entries) {
      const row = document.createElement('button');
      row.className = 'config-file';
      if (cfg.file && cfg.file.path === e.path) row.classList.add('active');
      if (!e.exists) row.classList.add('missing');
      const name = document.createElement('span');
      name.className = 'config-file-name';
      name.textContent = e.label;
      row.appendChild(name);
      const badge = document.createElement('span');
      badge.className = 'config-file-badge';
      badge.textContent = e.exists ? `${(e.size / 1024).toFixed(1)} KB` : (e.canCreate ? 'create' : 'missing');
      row.appendChild(badge);
      if (e.note) row.title = e.note;
      row.addEventListener('click', () => openConfig(e));
      if (group === 'Custom') {
        row.addEventListener('contextmenu', async (ev) => {
          ev.preventDefault();
          if (!window.confirm(`Remove “${e.label}” from the Datapad list? The file itself is not deleted.`)) return;
          const list = await call('configRemoveCustom', e.path);
          if (list) { cfg.list = list; renderConfigList(); }
        });
        row.title = (e.note ? e.note + ' — ' : '') + 'right-click to remove from list';
      }
      box.appendChild(row);
    }
  }
}

function confirmDiscard() {
  return !cfg.dirty || window.confirm('Discard unsaved changes to the current file?');
}

async function openConfig(entry) {
  if (!confirmDiscard()) return;
  if (!entry.exists && !entry.canCreate) {
    toast('That file does not exist.', 'warn');
    return;
  }
  const data = await call('configRead', entry.path);
  if (!data) return;
  const content = data.content == null ? '' : data.content;
  cfg.file = entry;
  cfg.eol = content.includes('\r\n') ? '\r\n' : '\n';
  cfg.lines = content.split(/\r?\n/);
  cfg.dirty = false;
  cfg.mode = isIniFile(entry) ? 'structured' : 'raw';
  renderEditor();
  renderConfigList();
  if (data.content == null) {
    toast(`${entry.label} doesn't exist yet — it will be created when you save.`, 'info', 6000);
  }
}

function isIniFile(entry) {
  return /\.(ini|cfg)$/i.test(entry.path);
}

function setDirty(d) {
  cfg.dirty = d;
  $('#config-dirty').classList.toggle('hidden', !d);
  $('#btn-config-save').disabled = !d;
}

function syncFromRaw() {
  cfg.lines = $('#config-raw').value.split('\n');
}

function renderEditor() {
  const has = !!cfg.file;
  $('#config-toolbar').classList.toggle('hidden', !has);
  $('#config-placeholder').classList.toggle('hidden', has);
  $('#config-structured').classList.add('hidden');
  $('#config-raw').classList.add('hidden');
  if (!has) return;

  $('#config-filename').textContent = cfg.file.label;
  $('#config-filepath').textContent = cfg.file.path;
  setDirty(cfg.dirty);
  const iniCapable = isIniFile(cfg.file);
  $('#btn-config-mode').classList.toggle('hidden', !iniCapable);
  $('#btn-config-mode').textContent = cfg.mode === 'structured' ? 'Raw view' : 'Structured view';

  if (cfg.mode === 'structured' && iniCapable) {
    renderStructured();
    $('#config-structured').classList.remove('hidden');
  } else {
    $('#config-raw').value = cfg.lines.join('\n');
    $('#config-raw').classList.remove('hidden');
  }
}

// Line-preserving structured INI view: only values are editable; keys, comments,
// ordering and duplicate (+/-) keys stay exactly as they are in the file.
function renderStructured() {
  const box = $('#config-structured');
  box.innerHTML = '';
  let currentSectionEl = null;
  let kvCount = 0;
  let otherCount = 0;

  const makeSection = (title) => {
    const wrap = document.createElement('div');
    wrap.className = 'ini-section';
    const h = document.createElement('div');
    h.className = 'ini-section-title';
    h.textContent = title;
    wrap.appendChild(h);
    box.appendChild(wrap);
    return wrap;
  };

  cfg.lines.forEach((raw, idx) => {
    const sectionMatch = raw.match(/^\s*\[(.+)\]\s*$/);
    if (sectionMatch) {
      currentSectionEl = makeSection(`[${sectionMatch[1]}]`);
      return;
    }
    const eq = raw.indexOf('=');
    const trimmed = raw.trim();
    const isComment = trimmed.startsWith(';') || trimmed.startsWith('#');
    if (eq > 0 && !isComment && trimmed) {
      kvCount += 1;
      if (!currentSectionEl) currentSectionEl = makeSection('(no section)');
      const row = document.createElement('label');
      row.className = 'ini-row';
      const key = document.createElement('span');
      key.className = 'ini-key';
      key.textContent = raw.slice(0, eq).trim();
      key.title = key.textContent;
      const input = document.createElement('input');
      input.type = 'text';
      input.className = 'ini-value text-input';
      input.value = raw.slice(eq + 1);
      input.addEventListener('input', () => {
        cfg.lines[idx] = raw.slice(0, eq + 1) + input.value;
        setDirty(true);
      });
      row.append(key, input);
      currentSectionEl.appendChild(row);
    } else if (trimmed) {
      otherCount += 1;
    }
  });

  if (!kvCount) {
    const empty = document.createElement('div');
    empty.className = 'config-placeholder-inline dim';
    empty.textContent = cfg.lines.join('').trim()
      ? 'No key=value entries found — switch to Raw view to edit this file.'
      : 'Empty file — switch to Raw view to add content, or paste a mod\'s recommended settings there.';
    box.appendChild(empty);
  } else if (otherCount) {
    const note = document.createElement('div');
    note.className = 'config-placeholder-inline dim';
    note.textContent = `${otherCount} comment/other line(s) not shown — Raw view has the complete file.`;
    box.appendChild(note);
  }
}

$('#btn-config-mode').addEventListener('click', () => {
  if (cfg.mode === 'raw') syncFromRaw();
  cfg.mode = cfg.mode === 'structured' ? 'raw' : 'structured';
  renderEditor();
});
$('#config-raw').addEventListener('input', () => setDirty(true));
$('#btn-config-reload').addEventListener('click', () => {
  if (!cfg.file) return;
  const entry = cfg.file;
  cfg.dirty = false;
  openConfig(entry);
});
$('#btn-config-folder').addEventListener('click', () => cfg.file && call('configOpenFolder', cfg.file.path));
$('#btn-config-save').addEventListener('click', async () => {
  if (!cfg.file) return;
  if (cfg.mode === 'raw') syncFromRaw();
  const content = cfg.lines.join(cfg.eol);
  const res = await call('configSave', cfg.file.path, content);
  if (!res) return;
  cfg.list = res.list;
  const updated = cfg.list.find((e) => e.path === cfg.file.path);
  if (updated) cfg.file = updated;
  setDirty(false);
  renderConfigList();
  toast(`${cfg.file.label} saved${res.backedUp ? ' (original kept as .zcbak)' : ''}.`);
});
$('#btn-config-add').addEventListener('click', async () => {
  const list = await call('configAddCustom');
  if (list) { cfg.list = list; renderConfigList(); }
});
$('.nav-item[data-view="configs"]').addEventListener('click', () => {
  if (!cfg.listLoaded) loadConfigList();
});

// ------------------------------------------------------------------ import existing mods

$$('[data-close-modal]').forEach((b) =>
  b.addEventListener('click', () => $(`#${b.dataset.closeModal}`).classList.add('hidden')));

$('#btn-import').addEventListener('click', async () => {
  const candidates = await call('scanUnmanaged');
  if (!candidates) return;
  const list = $('#import-list');
  list.innerHTML = '';
  if (!candidates.length) {
    toast('No unmanaged mod files found — everything in the game is already under management.', 'info', 6000);
    return;
  }
  for (const c of candidates) {
    const row = document.createElement('label');
    row.className = 'import-row';
    const check = document.createElement('input');
    check.type = 'checkbox';
    check.checked = true;
    check.dataset.candidateId = c.id;
    const info = document.createElement('div');
    info.className = 'import-info';
    const name = document.createElement('div');
    name.className = 'import-name';
    name.textContent = c.name;
    const meta = document.createElement('div');
    meta.className = 'import-meta';
    meta.textContent = `${TYPE_LABEL[c.modType] || c.modType} · ${c.files.length} file${c.files.length === 1 ? '' : 's'} · ${c.location}${c.active ? '' : ' · currently inactive'}`;
    info.append(name, meta);
    row.append(check, info);
    list.appendChild(row);
  }
  $('#import-modal').classList.remove('hidden');
});

$('#btn-import-adopt').addEventListener('click', async () => {
  const ids = $$('#import-list input:checked').map((c) => c.dataset.candidateId);
  if (!ids.length) { toast('Select at least one mod to adopt.', 'warn'); return; }
  const btn = $('#btn-import-adopt');
  btn.disabled = true;
  try {
    const res = await call('adoptMods', ids);
    if (!res) return;
    state = res.state;
    render();
    $('#import-modal').classList.add('hidden');
    const ok = res.results.filter((r) => r.ok);
    const identified = ok.filter((r) => r.identified);
    toast(`Adopted ${ok.length} mod${ok.length === 1 ? '' : 's'}.${identified.length ? ` ${identified.length} identified on Nexus (updates now tracked).` : ''}`, 'info', 8000);
    for (const r of res.results.filter((x) => !x.ok)) toast(`${r.name}: ${r.error}`, 'error', 7000);
    const unlinked = ok.length - identified.length;
    if (unlinked > 0) toast(`${unlinked} adopted mod(s) have no update source — click their LOCAL badge to link one.`, 'info', 9000);
  } finally {
    btn.disabled = false;
  }
});

// ------------------------------------------------------------------ link update source

let linkTarget = null;
let linkSearchTimer = null;

async function openLinkModal(mod) {
  linkTarget = mod;
  $('#link-mod-name').textContent = `“${mod.name}”`;
  $('#link-nexus-search').value = '';
  $('#link-nexus-ref').value = '';
  $('#link-nexus-results').innerHTML = '';
  const sel = $('#link-github-repo');
  sel.innerHTML = '<option value="">— curated repos —</option>';
  $('#link-modal').classList.remove('hidden');
  try {
    const res = await window.zc.browseGithub({});
    if (res.ok) {
      for (const r of res.data.mods) {
        const opt = document.createElement('option');
        opt.value = r.fullName;
        opt.textContent = r.fullName;
        sel.appendChild(opt);
      }
    }
  } catch (_) {}
}

$('#link-nexus-search').addEventListener('input', () => {
  clearTimeout(linkSearchTimer);
  linkSearchTimer = setTimeout(async () => {
    const q = $('#link-nexus-search').value.trim();
    const box = $('#link-nexus-results');
    box.innerHTML = '';
    if (q.length < 2) return;
    const res = await window.zc.browseNexus({ query: q, sort: 'downloads', count: 5 });
    if (!res.ok) return;
    for (const m of res.data.mods) {
      const row = document.createElement('button');
      row.className = 'link-result';
      row.textContent = `${m.name} — ${m.author}${m.version ? ` · v${m.version}` : ''}`;
      row.addEventListener('click', () => doLink('nexus', String(m.modId)));
      box.appendChild(row);
    }
  }, 350);
});

async function doLink(type, ref) {
  if (!linkTarget) return;
  const res = await call('linkOrigin', linkTarget.id, type, ref);
  if (!res) return;
  state = res.state;
  render();
  $('#link-modal').classList.add('hidden');
  toast(`Linked to ${res.linked} — updates are now tracked.`);
}

$('#btn-link-nexus').addEventListener('click', () => {
  const ref = $('#link-nexus-ref').value.trim();
  if (!ref) { toast('Paste a Nexus mod URL or ID first.', 'warn'); return; }
  doLink('nexus', ref);
});
$('#btn-link-github').addEventListener('click', () => {
  const ref = $('#link-github-repo').value;
  if (!ref) { toast('Pick a curated repo first.', 'warn'); return; }
  doLink('github', ref);
});

// ------------------------------------------------------------------ FOMOD guided installer
// The installer script arrives as raw XML; it is parsed here (DOMParser), shown
// as the author's own steps, and only a source→destination copy list goes back.

const fomodQueue = [];
let fomodWiz = null; // active wizard state

function fomodParseFiles(el) {
  const out = [];
  for (const child of el.children) {
    const tag = child.tagName.toLowerCase();
    if (tag !== 'file' && tag !== 'folder') continue;
    out.push({
      source: child.getAttribute('source') || '',
      destination: child.getAttribute('destination'),
      priority: parseInt(child.getAttribute('priority') || '0', 10) || 0,
    });
  }
  return out;
}

function fomodParseDep(el) {
  const tag = el.tagName.toLowerCase();
  if (tag === 'dependencies' || tag === 'visible' || tag === 'moduledependencies') {
    const children = [...el.children].map(fomodParseDep).filter(Boolean);
    return { op: (el.getAttribute('operator') || 'And').toLowerCase(), children };
  }
  if (tag === 'flagdependency') {
    return { flag: el.getAttribute('flag') || '', value: el.getAttribute('value') || '' };
  }
  // File/game/tool version conditions have no meaning for Zero Company (no
  // plugin system) — reported and treated as unmet, mirroring what the page says.
  return { unsupported: tag };
}

function fomodEvalDep(dep, flags, warnings) {
  if (!dep) return true;
  if (dep.unsupported) {
    warnings.add(`Condition type "${dep.unsupported}" does not apply to Zero Company — treated as unmet.`);
    return false;
  }
  if (dep.children) {
    if (!dep.children.length) return true;
    return dep.op === 'or'
      ? dep.children.some((c) => fomodEvalDep(c, flags, warnings))
      : dep.children.every((c) => fomodEvalDep(c, flags, warnings));
  }
  return (flags.get(dep.flag) || '') === dep.value;
}

// Plugin type under current flags: Required | Recommended | Optional | NotUsable | CouldBeUsable
function fomodPluginType(plugin, flags, warnings) {
  const td = plugin.typeDescriptor;
  if (!td) return 'Optional';
  if (td.type) return td.type;
  for (const p of td.patterns || []) {
    if (fomodEvalDep(p.dep, flags, warnings)) return p.type;
  }
  return td.defaultType || 'Optional';
}

function fomodParseConfig(xmlText) {
  const doc = new DOMParser().parseFromString(xmlText, 'text/xml');
  if (doc.querySelector('parsererror')) throw new Error('The installer script is not valid XML.');
  const q = (root, sel) => root ? [...root.querySelectorAll(sel)] : [];
  const cfg = { moduleName: '', requiredFiles: [], steps: [], conditionalInstalls: [] };
  const nameEl = doc.querySelector('config > moduleName');
  cfg.moduleName = nameEl ? nameEl.textContent.trim() : '';

  const reqEl = doc.querySelector('config > requiredInstallFiles');
  if (reqEl) cfg.requiredFiles = fomodParseFiles(reqEl);

  for (const stepEl of q(doc, 'config > installSteps > installStep')) {
    const step = { name: stepEl.getAttribute('name') || '', visible: null, groups: [] };
    const visEl = stepEl.querySelector(':scope > visible');
    if (visEl) {
      // <visible> either wraps a <dependencies> block or holds conditions directly.
      const inner = visEl.querySelector(':scope > dependencies');
      step.visible = fomodParseDep(inner || visEl);
    }
    for (const groupEl of q(stepEl, ':scope > optionalFileGroups > group')) {
      const group = {
        name: groupEl.getAttribute('name') || '',
        type: groupEl.getAttribute('type') || 'SelectAny',
        plugins: [],
      };
      for (const plugEl of q(groupEl, ':scope > plugins > plugin')) {
        const imageEl = plugEl.querySelector(':scope > image');
        const plugin = {
          name: plugEl.getAttribute('name') || '',
          description: (plugEl.querySelector(':scope > description') || {}).textContent || '',
          image: imageEl ? imageEl.getAttribute('path') : null,
          files: [],
          conditionFlags: [],
          typeDescriptor: null,
        };
        const filesEl = plugEl.querySelector(':scope > files');
        if (filesEl) plugin.files = fomodParseFiles(filesEl);
        for (const flagEl of q(plugEl, ':scope > conditionFlags > flag')) {
          plugin.conditionFlags.push({ name: flagEl.getAttribute('name') || '', value: flagEl.textContent.trim() });
        }
        const tdEl = plugEl.querySelector(':scope > typeDescriptor');
        if (tdEl) {
          const typeEl = tdEl.querySelector(':scope > type');
          const depTypeEl = tdEl.querySelector(':scope > dependencyType');
          if (typeEl) plugin.typeDescriptor = { type: typeEl.getAttribute('name') || 'Optional' };
          else if (depTypeEl) {
            const dt = {
              defaultType: (depTypeEl.querySelector(':scope > defaultType') || { getAttribute: () => 'Optional' }).getAttribute('name') || 'Optional',
              patterns: [],
            };
            for (const patEl of q(depTypeEl, ':scope > patterns > pattern')) {
              const depEl = patEl.querySelector(':scope > dependencies');
              const tEl = patEl.querySelector(':scope > type');
              dt.patterns.push({
                dep: depEl ? fomodParseDep(depEl) : null,
                type: tEl ? (tEl.getAttribute('name') || 'Optional') : 'Optional',
              });
            }
            plugin.typeDescriptor = dt;
          }
        }
        group.plugins.push(plugin);
      }
      step.groups.push(group);
    }
    cfg.steps.push(step);
  }

  for (const patEl of q(doc, 'config > conditionalFileInstalls > patterns > pattern')) {
    const depEl = patEl.querySelector(':scope > dependencies');
    const filesEl = patEl.querySelector(':scope > files');
    cfg.conditionalInstalls.push({
      dep: depEl ? fomodParseDep(depEl) : null,
      files: filesEl ? fomodParseFiles(filesEl) : [],
    });
  }
  return cfg;
}

function processFomodQueue() {
  if (fomodWiz || !fomodQueue.length) return;
  const job = fomodQueue.shift();
  try {
    const cfg = fomodParseConfig(job.moduleXml);
    fomodWiz = {
      sessionId: job.sessionId,
      name: (job.info && job.info.name) || cfg.moduleName || job.name,
      cfg,
      answers: new Map(),   // stepIdx -> [Set(pluginIdx) per group]
      history: [],          // visited step indexes, in order
      warnings: new Set(),
      imageCache: new Map(),
    };
    const first = fomodNextStep(-1);
    if (first === -1) {
      // A script with no visible steps still installs its required files.
      fomodFinish();
      return;
    }
    fomodWiz.history.push(first);
    fomodRenderStep();
    $('#fomod-modal').classList.remove('hidden');
  } catch (err) {
    toast(`${job.source}: ${err.message} Falling back is not possible — install the archive folders manually.`, 'error', 9000);
    call('fomodCancel', job.sessionId);
    fomodWiz = null;
    processFomodQueue();
  }
}

// Flags produced by the selections on every step up to (not including) history position n.
function fomodFlagsUpTo(n) {
  const flags = new Map();
  for (let i = 0; i < n; i++) {
    const stepIdx = fomodWiz.history[i];
    const step = fomodWiz.cfg.steps[stepIdx];
    const sel = fomodWiz.answers.get(stepIdx);
    if (!sel) continue;
    step.groups.forEach((g, gi) => {
      for (const pi of sel[gi] || []) {
        for (const f of g.plugins[pi].conditionFlags) flags.set(f.name, f.value);
      }
    });
  }
  return flags;
}

function fomodNextStep(fromIdx) {
  const flags = fomodFlagsUpTo(fomodWiz ? fomodWiz.history.length : 0);
  for (let i = fromIdx + 1; i < fomodWiz.cfg.steps.length; i++) {
    if (fomodEvalDep(fomodWiz.cfg.steps[i].visible, flags, fomodWiz.warnings)) return i;
  }
  return -1;
}

function fomodShowDetail(plugin) {
  $('#fomod-detail-name').textContent = plugin ? plugin.name : '';
  $('#fomod-detail-desc').textContent = plugin ? (plugin.description || '').trim() : '';
  const imgBox = $('#fomod-detail-image');
  if (!plugin || !plugin.image) { imgBox.classList.add('hidden'); return; }
  const key = plugin.image;
  const cached = fomodWiz.imageCache.get(key);
  if (cached !== undefined) {
    if (cached) { $('#fomod-image').src = cached; imgBox.classList.remove('hidden'); }
    else imgBox.classList.add('hidden');
    return;
  }
  imgBox.classList.add('hidden');
  window.zc.fomodImage(fomodWiz.sessionId, key).then((res) => {
    const dataUrl = res.ok ? res.data : null;
    fomodWiz.imageCache.set(key, dataUrl);
    // Only show if this plugin is still the one under the cursor/selection.
    if (dataUrl && $('#fomod-detail-name').textContent === plugin.name) {
      $('#fomod-image').src = dataUrl;
      imgBox.classList.remove('hidden');
    }
  });
}

function fomodRenderStep() {
  const stepIdx = fomodWiz.history[fomodWiz.history.length - 1];
  const step = fomodWiz.cfg.steps[stepIdx];
  const flags = fomodFlagsUpTo(fomodWiz.history.length - 1);
  $('#fomod-title').textContent = `GUIDED INSTALL — ${fomodWiz.name.toUpperCase()}`;
  $('#fomod-stepname').textContent = step.name || `Step ${fomodWiz.history.length}`;
  $('#fomod-progress').textContent = `step ${fomodWiz.history.length}`;
  $('#btn-fomod-back').disabled = fomodWiz.history.length < 2;
  fomodShowDetail(null);

  // Restore this step's selections if the user has been here before; otherwise defaults.
  let saved = fomodWiz.answers.get(stepIdx);
  if (!saved) {
    saved = step.groups.map((g) => {
      const sel = new Set();
      const types = g.plugins.map((p) => fomodPluginType(p, flags, fomodWiz.warnings));
      if (g.type === 'SelectAll') {
        g.plugins.forEach((_, i) => sel.add(i));
      } else {
        types.forEach((t, i) => { if (t === 'Required' || t === 'Recommended') sel.add(i); });
        if ((g.type === 'SelectExactlyOne') && !sel.size) {
          const firstUsable = types.findIndex((t) => t !== 'NotUsable');
          if (firstUsable !== -1) sel.add(firstUsable);
        }
        if (g.type === 'SelectExactlyOne' || g.type === 'SelectAtMostOne') {
          // Radio semantics — keep only the first default.
          const first = [...sel][0];
          sel.clear();
          if (first !== undefined) sel.add(first);
        }
      }
      return sel;
    });
    fomodWiz.answers.set(stepIdx, saved);
  }

  const box = $('#fomod-groups');
  box.innerHTML = '';
  const TYPE_HINT = {
    SelectExactlyOne: 'choose one',
    SelectAtMostOne: 'choose one or none',
    SelectAtLeastOne: 'choose at least one',
    SelectAll: 'all required',
    SelectAny: 'choose any',
  };
  step.groups.forEach((g, gi) => {
    const wrap = document.createElement('div');
    wrap.className = 'fomod-group';
    const title = document.createElement('div');
    title.className = 'fomod-group-title';
    title.textContent = g.name;
    const hint = document.createElement('span');
    hint.className = 'fomod-group-hint dim';
    hint.textContent = ` — ${TYPE_HINT[g.type] || g.type}`;
    title.appendChild(hint);
    wrap.appendChild(title);

    const radio = g.type === 'SelectExactlyOne' || g.type === 'SelectAtMostOne';
    g.plugins.forEach((p, pi) => {
      const type = fomodPluginType(p, flags, fomodWiz.warnings);
      const row = document.createElement('label');
      row.className = 'fomod-option';
      const input = document.createElement('input');
      input.type = radio ? 'radio' : 'checkbox';
      if (radio) input.name = `fomod-g${gi}`;
      input.checked = saved[gi].has(pi);
      const locked = type === 'Required' || type === 'NotUsable' || g.type === 'SelectAll';
      input.disabled = locked;
      if (type === 'NotUsable') {
        row.classList.add('notusable');
        row.title = 'Unavailable — a condition this option needs is not met.';
        input.checked = false;
        saved[gi].delete(pi);
      }
      input.addEventListener('change', () => {
        if (radio) {
          saved[gi].clear();
          if (input.checked) saved[gi].add(pi);
          // Uncheck siblings visually (radio handles it, sets need syncing).
        } else if (input.checked) saved[gi].add(pi);
        else saved[gi].delete(pi);
        fomodShowDetail(p);
        // A changed answer can hide or reveal later steps — refresh the button.
        const last = fomodNextStep(stepIdx) === -1;
        $('#btn-fomod-next').textContent = last ? '⊕ Install' : 'Next →';
      });
      row.addEventListener('mouseenter', () => fomodShowDetail(p));
      const nameSpan = document.createElement('span');
      nameSpan.className = 'fomod-option-name';
      nameSpan.textContent = p.name;
      const typeTag = document.createElement('span');
      typeTag.className = `fomod-option-type t-${type.toLowerCase()}`;
      typeTag.textContent = type === 'Optional' ? '' : type.toUpperCase();
      row.append(input, nameSpan, typeTag);
      wrap.appendChild(row);
    });
    box.appendChild(wrap);
  });

  const warnBox = $('#fomod-warnings');
  if (fomodWiz.warnings.size) {
    warnBox.textContent = [...fomodWiz.warnings].join(' ');
    warnBox.classList.remove('hidden');
  } else {
    warnBox.classList.add('hidden');
  }

  const isLast = fomodNextStep(stepIdx) === -1;
  $('#btn-fomod-next').textContent = isLast ? '⊕ Install' : 'Next →';

  // Open with the first selected (or first) option's description showing,
  // instead of an empty pane waiting for a hover.
  const firstGroup = step.groups[0];
  if (firstGroup && firstGroup.plugins.length) {
    const sel = [...(saved[0] || [])][0];
    fomodShowDetail(firstGroup.plugins[sel !== undefined ? sel : 0]);
  }
}

function fomodValidateStep() {
  const stepIdx = fomodWiz.history[fomodWiz.history.length - 1];
  const step = fomodWiz.cfg.steps[stepIdx];
  const saved = fomodWiz.answers.get(stepIdx);
  for (let gi = 0; gi < step.groups.length; gi++) {
    const g = step.groups[gi];
    const n = saved[gi].size;
    if (g.type === 'SelectExactlyOne' && n !== 1) return `“${g.name}”: choose exactly one option.`;
    if (g.type === 'SelectAtMostOne' && n > 1) return `“${g.name}”: choose at most one option.`;
    if (g.type === 'SelectAtLeastOne' && n < 1) return `“${g.name}”: choose at least one option.`;
  }
  return null;
}

async function fomodFinish() {
  const files = [...fomodWiz.cfg.requiredFiles];
  for (const stepIdx of fomodWiz.history) {
    const step = fomodWiz.cfg.steps[stepIdx];
    const saved = fomodWiz.answers.get(stepIdx);
    if (!saved) continue;
    step.groups.forEach((g, gi) => {
      for (const pi of saved[gi] || []) files.push(...g.plugins[pi].files);
    });
  }
  const finalFlags = fomodFlagsUpTo(fomodWiz.history.length);
  for (const ci of fomodWiz.cfg.conditionalInstalls) {
    if (fomodEvalDep(ci.dep, finalFlags, fomodWiz.warnings)) files.push(...ci.files);
  }
  // Priority order: low first, so higher-priority copies land last and win.
  files.sort((a, b) => a.priority - b.priority);
  const selections = files.map((f) => ({ source: f.source, destination: f.destination }));
  const sessionId = fomodWiz.sessionId;
  const name = fomodWiz.name;
  $('#fomod-modal').classList.add('hidden');
  fomodWiz = null;
  const res = await call('fomodComplete', sessionId, selections);
  if (res) {
    state = res.state;
    pendingOrder = null;
    render();
    toast(`Installed “${res.name}” (${TYPE_LABEL[res.modType] || res.modType}) via guided install.`);
    for (const w of res.warnings || []) toast(`${res.name}: ${w}`, 'warn', 6000);
  } else {
    toast(`Guided install of “${name}” failed — nothing was deployed.`, 'error', 8000);
  }
  processFomodQueue();
}

$('#btn-fomod-next').addEventListener('click', () => {
  if (!fomodWiz) return;
  const problem = fomodValidateStep();
  if (problem) { toast(problem, 'warn', 6000); return; }
  const current = fomodWiz.history[fomodWiz.history.length - 1];
  const next = fomodNextStep(current);
  if (next === -1) { fomodFinish(); return; }
  fomodWiz.history.push(next);
  fomodRenderStep();
});

$('#btn-fomod-back').addEventListener('click', () => {
  if (!fomodWiz || fomodWiz.history.length < 2) return;
  // Back takes the newest answer away along with everything it decided; the
  // step returned to keeps its selections exactly as left.
  fomodWiz.history.pop();
  fomodRenderStep();
});

$('#btn-fomod-cancel').addEventListener('click', () => {
  if (!fomodWiz) return;
  const sessionId = fomodWiz.sessionId;
  $('#fomod-modal').classList.add('hidden');
  fomodWiz = null;
  call('fomodCancel', sessionId);
  toast('Guided install cancelled — nothing was installed.');
  processFomodQueue();
});

// ------------------------------------------------------------------ push events (nxm installs, download progress)

let launcherUpdateUrl = null;
function showLauncherBanner(info) {
  launcherUpdateUrl = info.url;
  $('#launcher-banner-text').textContent =
    `Launcher update available — v${info.latest} (you have v${info.current})${info.notes ? `: ${info.notes}` : ''}`;
  $('#launcher-banner').classList.remove('hidden');
}
$('#launcher-banner-get').addEventListener('click', () => {
  if (launcherUpdateUrl) call('openExternal', launcherUpdateUrl);
});
$('#launcher-banner-dismiss').addEventListener('click', () => $('#launcher-banner').classList.add('hidden'));

window.zc.onEvent((payload) => {
  if (payload.type === 'launcher-update') {
    showLauncherBanner(payload.info);
    return;
  }
  if (payload.type === 'fomod-pending') {
    // A Nexus/GitHub download turned out to be a guided installer.
    fomodQueue.push(payload.job);
    processFomodQueue();
    return;
  }
  if (payload.type === 'toast') {
    toast(payload.message, payload.kind || 'info', 7000);
  } else if (payload.type === 'state') {
    state = payload.state;
    pendingOrder = null;
    pendingUe4ssOrder = null;
    render();
  } else if (payload.type === 'progress') {
    const box = $('#progress-toast');
    box.classList.remove('hidden');
    const pct = payload.total ? Math.round((payload.received / payload.total) * 100) : null;
    $('#progress-label').textContent = pct !== null
      ? `Downloading ${payload.label} — ${pct}%`
      : `Downloading ${payload.label} — ${(payload.received / 1048576).toFixed(1)} MB`;
    $('#progress-fill').style.width = `${pct ?? 100}%`;
    if (payload.total && payload.received >= payload.total) {
      setTimeout(() => box.classList.add('hidden'), 1200);
    }
  }
});

// ------------------------------------------------------------------ boot

refreshState().then(() => runDiagnostics());

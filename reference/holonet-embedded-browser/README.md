# Holonet embedded browser — UNFAITHFUL reference (NOT shipped)

This folder is a **reference archive**, not part of the built app. It exists so we
can compare the shipped **faithful** Nexus download panel against a more
aggressive **"unfaithful"** full-browser treatment, and switch later if we decide
to.

## What ships (faithful) — for contrast
The live feature lives in the app, not here:
- `src/index.html` → `#nexus-dl-modal` (themed frame + `<webview partition="persist:nexus">`)
- `src/styles.css` → `.nexus-dl-*` rules
- `src/app.js` → `openNexusDownload()`, wired from the free-account install path
- `main.js` → `webviewTag: true` + the `web-contents-created` nxm:// interceptor
  that routes the "Mod Manager Download" link into `handleNxm()`

The faithful panel renders the **real Nexus page untouched** (ads, the free
countdown, everything) inside a themed frame. The user clicks the buttons; we only
catch the resulting `nxm://`. This is the ToS-defensible "your own browser, in a
window" interpretation.

## What this reference shows (unfaithful)
`index.html` is a self-contained demo (open it in a `webviewTag`-enabled Electron
window). It adds, on top of the same webview + nxm interception idea:
- a **full browser chrome**: back / forward / reload / home + an editable address
  bar, a "nexusmods.com only" domain lock, and an **Auto-download** toggle;
- a **re-skin injected into the live Nexus page** (`insertCSS`) that recolors it to
  the holo theme and **hides ad slots / the free-download furniture**;
- a placeholder for an **auto-advance** step that would click through the free
  download wait (intentionally left out — the re-skin already shows the intent).

## Why it is NOT shipped
Re-skinning a third-party site, hiding its ads, and auto-advancing its
ad-supported free download tier is a clear Nexus Terms-of-Service problem and
strips revenue Nexus relies on. Keep this as an evaluation artifact only. If the
policy calculus ever changes, the faithful panel can adopt pieces of this
deliberately and on the record.

Partition note: this demo uses `persist:nexus-ref` so it never touches the
shipped `persist:nexus` login session.

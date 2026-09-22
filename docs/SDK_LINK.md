# The SDK link

Mod Command ships **no Mod SDK panel**. If the Zero Company Mod SDK is
installed and pointed at from *Settings → ◆ SDK*, Mod Command **hosts the SDK's
own UI** in a fifth view called ◆ Forge. Nothing else changes: with no SDK
linked the Forge item is dimmed and opens "Get the SDK", and Mod Command is
otherwise exactly what it was.

The reason for the shape is release cadence. The SDK moves far faster than Mod
Command, and its UI is written against its own CLI. Hosting it instead of
copying it means **a new SDK needs no new Mod Command.**

Everything on the host's side lives in one file: `lib/sdk-link.js`.

---

## The manifest

The link reads `<sdk>/tools/sdk-ui/manifest.json`:

```json
{
  "contract": 1,
  "name": "Zero Company Mod SDK",
  "sdkUiVersion": "1.28.52",
  "entry": "src/index.html",
  "preload": "preload.js",
  "cliModule": "lib/sdk-cli.js",
  "minModCommand": "1.9.12",
  "updateUrl": "https://raw.githubusercontent.com/EnvianMods/ZCSDK/main/sdk-version.json"
}
```

| field | required | what the host does with it |
|---|---|---|
| `contract` | yes, numeric | must equal `HOST_CONTRACT` (currently **1**) |
| `name` | no | shown on the ◆ SDK card |
| `sdkUiVersion` | no | shown on the ◆ SDK card; `dev` if the SDK has no version |
| `entry` | yes | loaded as `file://…/<entry>?embedded=1` |
| `preload` | yes | set as the hosted view's preload, by absolute path |
| `cliModule` | yes | `require()`d, and its `createHandlers(ctx)` registered |
| `minModCommand` | no | compared against `package.json`'s `version` |
| `updateUrl` | no | where the SDK publishes `sdk-version.json`. **Absent ⇒ no check at all**, and the card says *"This SDK does not publish an update file."* See below. |

All four paths resolve relative to `tools/sdk-ui/`, and a path that resolves
**outside** that folder is refused — a manifest must not be able to aim the
host's `require()` or preload somewhere else in the tree.

## Version rules, and what a mismatch does

Two independent gates, both checked before anything is loaded:

* **contract** — an exact match. `contract > 1` means the SDK is newer than
  this host understands: *"That SDK needs a newer Mod Command … Update Mod
  Command."* `contract < 1` means the SDK is older: *"That SDK is too old to
  embed … Update the SDK."*
* **minModCommand** — `package.json`'s version must be greater than or equal
  to it, compared segment by segment as numbers: *"That SDK needs Mod Command
  2.0.0 or newer — this is 1.9.12."*

`sdkUiVersion` is **not** a gate. It is display only. The SDK is free to ship
any version it likes as long as the contract number holds.

**Every failure ends in the same place:** the ◆ SDK card shows the sentence, the
◆ Forge nav item stays dimmed, and the rest of Mod Command is untouched. Nothing in
`lib/sdk-link.js` is allowed to throw into the host — `link()` catches, tears
down whatever it had half-built, and returns `{ linked: false, error }`. Same
for a `cliModule` that loads but exports no `createHandlers`, or whose own
`CONTRACT` disagrees with its manifest.

## Finding an SDK

*Detect* tries, in order, and keeps the first folder that actually links:

1. the configured path, if any
2. `%APPDATA%\zero-company-mod-sdk-ui\sdk-ui-settings.json` → `sdkPath`
   (where the SDK's own standalone UI records the folder it was pointed at)
3. `%ProgramData%\ZeroCompanyModSDK\install.json` → `sdkPath`
   (reserved for the SDK's future installer)
4. folders named `ZeroCompanyModSDK*` **beside the Mod Command install**
5. folders named `ZeroCompanyModSDK*` beside the game folder, and
   `<game>\ZeroCompanyModSDK`

A candidate counts only if it carries `tools/sdk-ui/manifest.json`. Both
breadcrumb files are read best-effort; whatever they contain is treated as a
path to validate like any other, never as a reason to skip the checks.

## Hosting

```
WebContentsView
  preload:          <sdk>/tools/sdk-ui/preload.js   (absolute)
  contextIsolation: true
  nodeIntegration:  false
  sandbox:          true
  url:              file://<sdk>/tools/sdk-ui/src/index.html?embedded=1
```

Attached to the main window with `win.contentView.addChildView`. The renderer
measures `#content` and sends the rect (`sdk-link-view`), so the host's own CSS
stays the single source of truth for the layout; a window resize pushes a
`sdk-link-remeasure` event and the renderer measures again.

Leaving the Forge view does not destroy the view, it parks it at 0×0 and calls
`setVisible(false)` — so the SDK page keeps its console buffer, doctor rows and
scroll position across view switches. **Unlink** does destroy it: the job is
cancelled, every `sdk:1:*` handler is removed from `ipcMain`, the view is
closed and the module is dropped from `require.cache` so a later link to a
different folder loads that folder's code.

Navigation out of the SDK folder is blocked (`will-navigate`) and popups are
denied. Anything the SDK wants opened in the OS goes through its own
`sdk:1:open-path` handler, which is the host's code.

## The SDK update file

The SDK publishes one small JSON file and Mod Command reads it. The **URL is
in the manifest, not in Mod Command** — `updateUrl` — so the SDK can move its
own update file without a Mod Command release. Mod Command hard-codes nothing
about it.

```json
{
  "latest":        "1.29.0",
  "publicVersion": "1.0.0",
  "published":     "2026-09-17T00:00:00Z",
  "preferred":     "github",
  "nexus":  { "url": "https://www.nexusmods.com/starwarszerocompany/mods/163" },
  "github": { "url": "…/releases", "asset": "…zip", "download": "…" },
  "notes":  "one line"
}
```

| field | meaning |
|---|---|
| `latest` | the **internal** SDK version. This is the one that gets compared. |
| `publicVersion` | what the download is *called*. Display only. |
| `published` | ISO date. Display only. |
| `preferred` | `"nexus"` or `"github"`. **Absent means `github`.** |
| `nexus` / `github` | either may be absent or null. A `url` must be `https://`. |
| `notes` | one line, truncated at 300 characters. |

**Comparison.** `latest` versus the INSTALLED version, which is
`<sdk>/tools/version.json` → `"sdk"` — the SDK's own single version constant,
not any app's `package.json`. The comparator is the same three-segment numeric
one `lib/launcher-update.js` uses for Mod Command's own check; a tie is not an
update.

**Channel choice.** The button opens `preferred`'s url, and **falls back to the
other channel** when the preferred one has no url — so a file that says
`"preferred": "nexus"` but only fills in `github` still gets a working button.
The label is written from where the url *actually* points, never from
`preferred`, so it cannot say Nexus and open GitHub.

**Four states, and only one of them is loud:**

| state | when | what the UI does |
|---|---|---|
| `unsupported` | the manifest has no `updateUrl` | "This SDK does not publish an update file." |
| `unknown` | offline, 404, malformed JSON, no installed version | "update state unknown". **No toast, no error, ever.** |
| `current` | installed ≥ latest | "SDK 1.29.0 — up to date" |
| `update` | installed < latest | a `warn` badge on ◆ Forge and the line on the ◆ SDK card, with the Get button |

**Fetch and cadence, mirrored from the launcher check exactly:** one `fetch`
with `cache: 'no-store'`, an `AbortController` timeout of **6 s**, a
**60-minute** TTL, a check on `did-finish-load` and then every **60 minutes**
while the window is open — the same `UPDATE_CHECK_MS` the mod-update check
uses. The answer is cached in `settings.sdkUpdate` (`{ info, at }`), so the TTL
survives a restart. "Check now" passes `force: true` and skips the cache.
Nothing blocks the UI: the renderer paints from the cache and the background
check pushes a `sdk-update` event when it lands.

**One check, two consumers.** The implementation is in the **SDK's**
`lib/sdk-cli.js` (`sdk:1:check-update`), so the standalone SDK app gets the
same check from the same code. Mod Command runs it for its own badge and then
pushes the answer into the hosted page on the SDK's event channel, so the
panel's own Doctor line agrees with the host's badge without a second fetch.

## Settings keys

Five, in `data/manager-data.json`:

| key | meaning |
|---|---|
| `sdkPath` | the linked SDK folder. `null` = no SDK, no Forge view. |
| `sdkCliPath` | the checkout the SDK's CLI runs against. `null` = same as `sdkPath`. Separate so that pointing the panel at a second checkout — which a developer with more than one does — cannot tear down the link. |
| `sdkShowCommand` | the SDK panel's "show CLI command" toggle. |
| `sdkUpdate` | the update check's cached `{ info, at }`, so the 60-minute TTL survives a restart. |
| `sdkAssetLinks` | `{ sdk: { url, updateUrl }, at }` — the last `sdk` block the asset file ever carried, written every time a fetch yields one. It is what an **offline** Mod Command shows a Get button from. Never a default, only a memory: a fresh install that has never reached the network shows the dim line instead. |

`sdkShowCommand` and `sdkUpdate` are the **SDK's** settings. They live here only
because the SDK's handler map asks its host to store them.

## The security stance — say it plainly

`lib/sdk-link.js` **`require()`s JavaScript from a folder the user chose and
runs it in the main process with full Node privileges.** There is no sandbox
around that module and there cannot be one: it is a Node module by design, it
spawns `node` and `python`, and it writes into the game folder.

What that trusts: **whoever put the SDK on the disk.** The same trust the user
already extends by running `zcmod-build.js` — which is the entire point of the
panel — but through a folder picker instead of a shell, which makes it easier
to point at the wrong thing. Mitigations, and their limits:

* the manifest's shape and contract number are checked, and every declared
  path must stay inside `tools/sdk-ui` — this stops a *malformed* manifest, not
  a *malicious* SDK folder, which could simply put its payload in
  `lib/sdk-cli.js`
* detection only ever *offers* folders; linking is always the user's click
* the hosted **page** is sandboxed, context-isolated, has no Node, cannot
  navigate out of the SDK folder and cannot open popups. The privileged half is
  the module in the main process, not the page.
* nothing is auto-linked from the network, and no SDK is downloaded or updated
  by Mod Command

If that trust is ever not acceptable, the fix is not a tighter manifest check —
it is signing the SDK, or moving the CLI behind a process boundary. Neither is
in contract 1.

## Where the SDK comes from, and the ◆ Forge nav item

**Mod Command hard-codes no download destination — not for the SDK, and not
for itself.** There is no URL table in `lib/sdk-link.js`. Where to get the SDK
is *published*, in the asset repo file that already announces Mod Command's own
updates:

`https://raw.githubusercontent.com/EnvianMods/SWZeroCompanyFeaturedAuthors/main/launcher-version.json`

```json
{
  "latest": "1.0.8",
  "url": "…",
  "notes": "…",
  "publishedAt": "…",
  "sdk": {
    "url":       "https://github.com/EnvianMods/ZCSDK/releases/tag/v1.0.0",
    "updateUrl": "https://raw.githubusercontent.com/EnvianMods/ZCSDK/main/sdk-version.json"
  }
}
```

| field | meaning |
|---|---|
| `sdk` | optional. Absent or unusable ⇒ no Get button at all. |
| `sdk.url` | the page to send people to for the SDK download. Must be `https://`, else ignored. |
| `sdk.updateUrl` | where the SDK publishes `sdk-version.json`. Must be `https://`, else ignored. Advisory: the LINKED case still reads the manifest's own `updateUrl` (above), never this. |

**At launch this file flips both halves from GitHub to the Nexus pages** — Mod
Command's own `url` and the SDK's `sdk.url` — in one edit, for every installed
launcher, with no release of anything. That is the entire reason the table is
gone.

**The path.** `lib/launcher-update.js` fetches the file (one `fetch`,
`cache: 'no-store'`, 6 s `AbortController` timeout, 60-minute TTL) and builds
its answer **from known keys only**, so a launcher that shipped before a key
existed ignores it — which is what makes adding one safe. It parses `sdk` onto
`info.sdk`, or `null`. `main.js`'s `getAssetLinks()` answers, in order:

| source | where it came from |
|---|---|
| `asset-file` | the check that ran this session carried a block |
| `cache` | `settings.sdkAssetLinks` — the last block any fetch ever carried, saved every time one lands, so an **offline restart still has the last good link** |
| `none` | never fetched one and nothing was saved |

`lib/sdk-link.js` calls that through `ctx.getAssetLinks()` and puts the answer
on `status().links`:

```js
{ sdk: { url, updateUrl } | null, source: 'asset-file' | 'cache' | 'none' }
```

The check runs at startup and hourly, and each answer pushes a `sdk-links`
event, so a link the operator flips lands **without a restart**.

**One button, and its label is written from the url.** The host in the
published url decides what the control says — `nexusmods.com` → *"⇓ Get the
Zero Company Mod SDK on Nexus"*, `github.com` → *"… on GitHub"*, anything else
→ *"⇓ Get the Zero Company Mod SDK ↗"*, which claims nothing. It cannot say
Nexus and open GitHub. The ◆ SDK card's Get link is the same url and the same
rule. With **no url at all** the button is hidden and the pitch shows one dim
line — *"The download link could not be fetched — check your connection and try
again."* — while **Point Mod Command at an installed SDK** stays, because that
path needs no network.

> Note: `open-external` only opens `nexusmods.com`, `github.com` and
> `discord.gg`. A published url on any other host gets the neutral label and is
> refused at the door — deliberately, that allow-list is a security control.

**Publishing it.** `owner-tools/update-featured-authors/update-launcher-version.js`
reads the live file before every write and **carries the `sdk` block through**,
so announcing a launcher version can never silently drop the SDK's link.
`--sdk-url` / `--sdk-update-url` set it, `--sdk-only` rewrites *only* that block
and leaves `latest/url/notes/publishedAt` exactly as published, `--show` prints
it, and `--dry-run` prints the body it would PUT and sends nothing.

**The ◆ Forge nav item is always in the rail.** With no SDK linked it is
*dimmed* and opens the "Get the SDK" view — one paragraph on what the SDK is, a
table of what it needs on the machine (UE 5.6.x, MSVC + Windows SDK 10.0.26100,
.NET 4.8.1 Developer Pack, retoc, Node, Python 3.8+, the game), the one **Get**
button above, and **Point Mod Command at an installed SDK**, which jumps to the
◆ SDK card in Settings. Once an SDK is linked the same item stops being dim and
is the live Forge. A modder who has never heard of the SDK has to be able to
find out it exists; hiding the entry was the wrong answer.

## Known rough edges

* A `WebContentsView` floats **above** the host page, so a Mod Command modal or
  toast opened while the Forge view is showing would be covered by it. Today
  nothing opens a modal from that view.
* Focus and keyboard go to whichever of the two web contents was clicked last;
  the host's global shortcuts do not reach the hosted page.
* DevTools for the hosted page are separate from the host's. `sdk-link-devtools`
  opens them detached.
* The hosted page's CSP is the SDK's (`default-src 'self'`), not Mod Command's,
  and it is enforced against the SDK folder's own origin.

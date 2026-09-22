# The SDK link

Mod Command ships **no Mod SDK panel**. If the Zero Company Mod SDK is
installed and pointed at from *Settings → ◆ SDK*, Mod Command **hosts the SDK's
own UI** in a fifth view called ◆ Forge. Nothing else changes: with no SDK
linked there is no Forge nav item and Mod Command is exactly what it was.

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

**Every failure ends in the same place:** the ◆ SDK card shows the sentence, no
◆ Forge nav item appears, and the rest of Mod Command is untouched. Nothing in
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

Three, in `data/manager-data.json`:

| key | meaning |
|---|---|
| `sdkPath` | the linked SDK folder. `null` = no SDK, no Forge view. |
| `sdkCliPath` | the checkout the SDK's CLI runs against. `null` = same as `sdkPath`. Separate so that pointing the panel at a second checkout — which a developer with more than one does — cannot tear down the link. |
| `sdkShowCommand` | the SDK panel's "show CLI command" toggle. |
| `sdkUpdate` | the update check's cached `{ info, at }`, so the 60-minute TTL survives a restart. |

The last two are the **SDK's** settings. They live here only because the SDK's
handler map asks its host to store them.

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

`lib/sdk-link.js` holds `SDK_LINKS`, the **only** copy of either download URL:

```js
nexus:          'https://www.nexusmods.com/starwarszerocompany/mods/163'
githubReleases: 'https://github.com/EnvianMods/ZCSDK/releases'
```

They reach the renderer on `status().links`; a `null` channel hides its button,
so a channel can be added or retired by editing this table alone.

**The ◆ Forge nav item is always in the rail.** With no SDK linked it is
*dimmed* and opens the "Get the SDK" view — one paragraph on what the SDK is, a
table of what it needs on the machine (UE 5.6.x, MSVC + Windows SDK 10.0.26100,
.NET 4.8.1 Developer Pack, retoc, Node, Python 3.8+, the game), a primary
**Get it on Nexus** button, a secondary **GitHub release** link, and **Point Mod
Command at an installed SDK**, which jumps to the ◆ SDK card in Settings. Once
an SDK is linked the same item stops being dim and is the live Forge. A modder
who has never heard of the SDK has to be able to find out it exists; hiding the
entry was the wrong answer.

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

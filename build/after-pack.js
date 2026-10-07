'use strict';
// electron-builder afterPack hook: flips Electron fuses on the packaged binary
// (win-unpacked / linux-unpacked) before the portable exe / AppImage wraps it.
//
//   EnableCookieEncryption              ON  — the Nexus website panel's login
//     cookies (persist:nexus) are encrypted at rest with the OS key store
//     (DPAPI on Windows). Only the RELEASE build has this: a dev run
//     (`npx electron .`) uses the stock Electron binary and stores cookies
//     unencrypted.
//   EnableNodeOptionsEnvironmentVariable OFF — NODE_OPTIONS cannot inject code.
//   EnableNodeCliInspectArguments       OFF — no --inspect debugger attach.
//   RunAsNode                           LEFT ON, on purpose: the hosted Mod
//     SDK workbench (lib/sdk-link.js loads the SDK's own sdk-cli.js) runs its
//     Node build scripts with this exe + ELECTRON_RUN_AS_NODE=1 when the user
//     has no `node` on PATH. Turning the fuse off would break SDK builds there.
//
// Pinned to @electron/fuses 1.8.0 (CommonJS, fuse wire v1 — still the wire Electron 44 uses; it reads Electron 44's newer fuses as unnamed and leaves them alone).
const path = require('path');
const { flipFuses, FuseVersion, FuseV1Options } = require('@electron/fuses');

exports.default = async function afterPack(context) {
  const { electronPlatformName, appOutDir, packager } = context;
  const productFilename = packager.appInfo.productFilename;
  let exe;
  if (electronPlatformName === 'win32') exe = path.join(appOutDir, `${productFilename}.exe`);
  else if (electronPlatformName === 'darwin') exe = path.join(appOutDir, `${productFilename}.app`);
  else exe = path.join(appOutDir, packager.executableName);

  await flipFuses(exe, {
    version: FuseVersion.V1,
    resetAdHocDarwinSignature: electronPlatformName === 'darwin',
    [FuseV1Options.EnableCookieEncryption]: true,
    [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
    [FuseV1Options.EnableNodeCliInspectArguments]: false,
  });
  console.log(`  • fuses set on ${path.basename(exe)}: cookie encryption on, NODE_OPTIONS off, --inspect off (RunAsNode kept for the SDK)`);
};

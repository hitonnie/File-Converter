# File Converter — Windows desktop app

The website packaged as a Windows program with [Electron](https://www.electronjs.org/). Every
library and font is bundled, so the installed app works fully offline.

## Build

```bash
cd desktop
npm install
npm start          # run the app
npm run dist       # build dist/File-Converter-Setup-<version>.exe
```

`npm start` and `npm run dist` first run `scripts/prepare-app.js`, which copies the site into
`app/`, bundles the libraries and fonts from `node_modules`, and points the site at them
(`js/local-assets.js`). Change the site in the main folder, not in `app/`.

The installer is per-user (no admin rights needed), lets you choose the install folder, adds
Start Menu and desktop shortcuts, and registers an uninstaller.

## Building in the cloud

`.github/workflows/windows-installer.yml` builds the installer on GitHub's Windows machines. Run it
from the repository's **Actions** tab, or push a tag such as `v1.0.0` to attach the installer to a
GitHub release.

## Smart App Control and code signing

The installer is not code-signed. Windows SmartScreen shows an "unknown publisher" warning
(**More info → Run anyway**), and on PCs with **Smart App Control** turned on, Windows blocks
unsigned apps outright. That includes building the installer locally: electron-builder runs an
unsigned helper while creating the uninstaller, so `npm run dist` fails with `spawn UNKNOWN`.

To run everywhere, the installer and app must be signed with a certificate from a CA in Microsoft's
Trusted Root Program (for example Microsoft's Trusted Signing service). electron-builder supports
this through its `win.azureSignOptions` setting.

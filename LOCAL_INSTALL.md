# Local install guide

A focused guide for installing the current branch's build of the
Unabyss Obsidian plugin into a local Obsidian vault. For end-user /
release-channel install paths (Community Plugins store, BRAT), see
`README.md`.

## Prerequisites

- Obsidian Desktop installed.
- A vault you can test against (real or a throwaway one - recommended
  for first install since the plugin's `data.json` ends up under
  `.obsidian/plugins/unabyss/` and outbound sync starts pushing notes
  once you connect).
- `pnpm` available locally if you want to rebuild (the repo has
  `pnpm-lock.yaml` and uses `pnpm@11.1.3`).

## Option A - Drop-in install (fastest)

`main.js` is built on release tags (~16 KB, generated alongside
`manifest.json`), so you can install without any tooling after
downloading a GitHub release or running `pnpm run build` locally.

1. Find your vault path. In Obsidian: **Settings -> About -> Show
   vault folder** (or just remember where you created it). Call it
   `<vault>`.
2. Create the plugin folder:

   ```bash
   mkdir -p "<vault>/.obsidian/plugins/unabyss"
   ```

3. Copy the artefacts from this repository:

   ```bash
   cp main.js manifest.json logo-dark.svg logo-light.svg \
     "<vault>/.obsidian/plugins/unabyss/"
   ```

4. Open Obsidian, go to **Settings -> Community plugins**.
   - If you see "Restricted mode is on", click **Turn on community
     plugins** (Obsidian's safety prompt for third-party code).
5. In the same panel, scroll to **Installed plugins**, find
   **Unabyss**, and toggle it on. If it doesn't appear, hit the
   refresh icon next to "Installed plugins".
6. The plugin's settings tab will appear under **Community plugins ->
   Unabyss**. Configure per `README.md` (API base URL, include
   folders, export target folder, etc.).

If Obsidian was already open before you copied the files, either
restart it or use the **Reload app without saving** command from the
command palette so it picks up the new plugin directory.

## Option B - Rebuild from source before installing

Only needed if you've changed `src/**` since the last build, or you
want sourcemaps for debugging.

```bash
pnpm install
pnpm run build         # tsc -noEmit + production esbuild bundle
```

Then run the copy step from Option A.

## Option C - Live development symlink

If you'll iterate on the plugin and want changes to land in the vault
without re-copying:

1. Make sure the plugin folder does not already exist as a real
   directory, then symlink the repo folder in:

   ```bash
   ln -s "$(pwd)" "<vault>/.obsidian/plugins/unabyss"
   ```

2. Run the esbuild watcher so `main.js` rebuilds on save:

   ```bash
   pnpm install
   pnpm run dev
   ```

3. In Obsidian, install the **Hot Reload** community plugin (by
   `pjeby`) to auto-reload Unabyss on each rebuild - or just
   disable/enable the toggle under **Settings -> Community plugins**
   after each change.

Notes on this option:

- `.gitignore` ignores `data.json`, so your local OAuth tokens won't
  be staged accidentally.
- The symlink approach means Obsidian will write `data.json` directly
  into the repo working tree (still gitignored), so be aware if
  you're switching branches.

## Verifying the install

- Open Obsidian's developer console (`Ctrl/Cmd+Shift+I`). On enable,
  you should see no red errors from `plugin:unabyss`.
- In **Settings -> Community plugins -> Unabyss**, the settings tab
  should render with **Connect**, the outbound / inbound toggles, and
  the **Force full resync** button described in `README.md`.
- If you're pointing at a non-prod backend, set **API base URL** (under
  Advanced) before clicking **Connect** (the OAuth consent page is
  derived from this host as `https://app.<host>`).

## Uninstall / reset

```bash
rm -rf "<vault>/.obsidian/plugins/unabyss"
```

Then in Obsidian, **Settings -> Community plugins** -> refresh. If
you had connected, also click **Disconnect** before deleting the
folder (or revoke the session from the Unabyss web app's
connected-accounts page) so the refresh tokens are blacklisted
server-side - otherwise the leftover tokens in `data.json` remain
valid until expiry.

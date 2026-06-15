# Unabyss Obsidian Plugin

Two-way OAuth sync between your Obsidian vault and your Unabyss memory.

- Push your notes into Unabyss as incremental, change-aware deltas.
- Pull Unabyss-generated exports back into a folder you pick inside the vault.
- File-change-driven outbound sync with a 5-second debounce, plus an
  hourly safety-net timer that runs both directions regardless of
  events.

## Features

- OAuth 2.0 + PKCE connect / disconnect against the Unabyss backend.
- Manifest-first delta protocol: only files whose content hash the
  server doesn't already have are uploaded.
- Inbound puller: every export in `GET /api/exports/changed-since/`
  is mirrored as `<slugified-title>.md` in your chosen folder.
- Configurable behaviour when an export is deleted in Unabyss:
  leave the local file, delete it, or move it to a `Deleted/`
  subfolder.
- Per-direction enable / disable toggles - either direction can be
  turned off without uninstalling the plugin.
- Per-direction live progress indicator inside the settings tab.
- Force-full-resync button that wipes the local hash cache + inbound
  watermark and re-checks every file with the server.
- Per-note 1 MiB size cap (oversize notes are skipped with a notice).
- Local hash + mtime cache to skip re-hashing unchanged files.

## Installation

### Obsidian Community Plugins (recommended)

1. Open Obsidian -> Settings -> Community plugins -> Browse.
2. Search for **Unabyss**, click **Install**, then **Enable**.

### BRAT sideload (beta releases)

1. Install the [BRAT](https://github.com/TfTHacker/obsidian42-brat)
   community plugin.
2. Open Obsidian -> Settings -> Community plugins -> BRAT ->
   **Add Beta plugin** and paste this repository's URL.
3. Enable the **Unabyss** plugin in Settings -> Community plugins.

### Manual install

1. Clone this repository.
2. From the repository root run:

   ```bash
   pnpm install
   pnpm build
   ```

3. Copy `main.js`, `manifest.json`, and `styles.css` into
   `<vault>/.obsidian/plugins/unabyss/`
   (create the folder if it doesn't exist).
4. Enable the plugin in Settings -> Community plugins.

## Configuration

Open Settings -> Community plugins -> Unabyss.

| Setting                                  | Default                   | Notes |
|------------------------------------------|---------------------------|-------|
| API base URL                             | `https://api.unabyss.com` | Set to your self-hosted backend if applicable. The plugin opens `https://app.<host>` in your browser for the consent page; point at the API host you have if your deploy doesn't follow the `api.` / `app.` convention. |
| Account                                  | (empty until you connect) | Click **Connect** to start the OAuth PKCE flow. |
| Sync outbound                            | on                        | Master switch for the Obsidian -> Unabyss direction. When off, neither file-change events, the hourly timer, nor the manual button sends notes to Unabyss. |
| Include folders                          | (empty = whole vault)     | Vault folders included by outbound sync. Click **Add folder** to pick from a list of every folder in the vault. Empty = sync everything. |
| Sync inbound                             | on                        | Master switch for the Unabyss -> Obsidian direction. When off, the hourly timer skips inbound and the manual button refuses to run it. |
| Export target folder                     | (empty)                   | Vault folder where Unabyss exports are written. Inbound sync requires this to be set. Auto-completes vault folders as you type. |
| When an export is deleted in Unabyss     | Leave the local file alone | Choose between **Leave**, **Delete (system trash)**, and **Move to a `Deleted/` subfolder** inside your target folder. |
| Force full resync                        | -                         | Wipes the local manifest cache + inbound watermark and immediately runs an outbound sync so the server's hash-diff guard re-establishes the truth. |

## Usage

### First connect

1. Click **Connect** in the settings tab. Your browser opens the
   Unabyss consent page; sign in if needed and click **Allow**.
2. Obsidian focuses back to your vault. The settings tab now reads
   "Connected as `<your email>`".

### Outbound (Obsidian -> Unabyss)

- Once connected and with the include-folder list configured to your
  taste, every modify / create / delete on a markdown file kicks off a
  debounced outbound sync after **5 seconds** of quiet.
- Manual: **Settings -> Unabyss -> Sync now** (or the
  command palette: `Unabyss: Sync outbound now`).
- The hourly safety-net timer fires both directions regardless of
  file events, so the plugin recovers from missed events and external
  file-system writes.

### Inbound (Unabyss -> Obsidian)

- Pick an **Export target folder** in settings.
- Each export gets written as `<slug>.md` (e.g.
  `daily-summary-2026-01-15.md`). On slug collision with a different
  export, the plugin appends `-<first-6-of-uuid>` to the filename so
  no unrelated note is overwritten.
- Every written file carries a stable trailer line at the bottom:
  `<!-- unabyss-export-id: <uuid> -->`. Do not delete this line if
  you want the plugin to recognise the file as the same export on the
  next sync.
- Soft-deleted exports honour your **When an export is deleted in
  Unabyss** setting.
- Manual: **Settings -> Unabyss -> Sync now** or the
  command palette: `Unabyss: Sync inbound now`.

### Disconnecting

Click **Disconnect** in the settings tab. The plugin calls
`POST /api/oauth/revoke/` to blacklist its refresh tokens server-side
and clears the local `data.json` token entries. You can also revoke
from the Unabyss web app's connected-accounts page if your machine is
inaccessible.

## Security and threat model

This plugin stores OAuth tokens in
`<vault>/.obsidian/plugins/unabyss/data.json`, which is **plaintext
JSON on disk**.

- Anyone with read access to your vault folder can read these tokens
  and use them to access your Unabyss account until you click
  **Disconnect** (which revokes them server-side).
- Tokens are also synced by Obsidian Sync, iCloud, Dropbox, or any
  other sync layer you configure for your `.obsidian/` directory.
- If you suspect your tokens were leaked, click **Disconnect** in the
  plugin settings; the OAuth refresh tokens are blacklisted
  immediately on the server. You can also revoke from the Unabyss web
  app's connected accounts page.

OS-keychain integration is on the roadmap. If plaintext token storage
is unacceptable for your threat model, do not install this plugin yet.

## Troubleshooting

- **"Connect failed: state_mismatch"** - the browser tab took too
  long to complete the consent flow, or you opened multiple Connect
  tabs. Click Connect again.
- **"Authentication has expired"** - the refresh-token rotation
  failed. Click Disconnect (or Connect again, which clears the stale
  state).
- **Sync rejects notes with `hash_mismatch`** - this is the server
  rejecting a row whose content changed between the manifest scan
  and the body upload. Re-running Sync resolves it.
- **Inbound sync skips everything** - the **Export target folder**
  setting is empty. Pick a folder via the type-ahead in settings.
- **"Inbound target X exists but is not a folder"** - the chosen
  target path is a file. Pick a different folder.
- **Exports keep coming back after I delete them locally** - your
  **When an export is deleted in Unabyss** setting is "Leave"; the
  plugin won't touch local files even when the server soft-deletes
  the source export, but it will keep re-writing the file if the
  export is *not* deleted server-side. Delete the export in the web
  app first.

## Development

```bash
pnpm install
pnpm run dev        # esbuild watch mode
pnpm run typecheck  # tsc -noEmit
pnpm test           # jest unit suite
pnpm run build      # production bundle
```

The unit suite covers:

- PKCE S256 round-trip (`tests/oauth.test.ts`).
- Manifest cache load/save/clear semantics
  (`tests/manifestCache.test.ts`).
- Slugify + collision-suffix policy (`tests/slugify.test.ts`).
- Inbound watermark advancement on partial-page failure
  (`tests/syncInbound.test.ts`).

Anything that touches the Obsidian runtime (Vault, App, Plugin,
`requestUrl`) is dependency-injected at the call site, so the tests
do not require Electron.

## License

MIT.

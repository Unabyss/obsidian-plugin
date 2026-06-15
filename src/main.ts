/**
 * Plugin entry for the Unabyss Obsidian plugin (Phase 5 - feature complete).
 *
 * Responsibilities (Phase 5 superset of Phase 4):
 *
 *  - Load and persist settings + auth + manifest cache + inbound
 *    watermark to ``data.json``.
 *  - Register the ``obsidian://unabyss/auth-callback`` protocol
 *    handler so the OAuth PKCE flow can deep-link back into the
 *    plugin after the user clicks Allow in their browser.
 *  - Wire commands ("Sync now", "Sync outbound now", "Sync inbound
 *    now", "Force full resync") and the settings tab.
 *  - File-change driven outbound sync with a 5s debounce window
 *    (per ``OUTBOUND_DEBOUNCE_MS``). The handler walks every modify /
 *    create / delete on ``.md`` files inside the user's include scope.
 *  - Hourly safety-net timer (per ``SAFETY_NET_INTERVAL_MS``) that
 *    runs both directions regardless of file events.
 *  - Per-direction enable/disable toggles - when off, neither timer
 *    nor command engages that direction.
 *
 * Lifecycle: every owned resource is created in ``onload`` and
 * disposed in ``onunload`` (timer cleared, debounce cancelled,
 * protocol-handler registration auto-removed by Obsidian).
 */

import { Notice, Plugin, TAbstractFile, TFile, normalizePath } from "obsidian";
import { UnabyssApiClient } from "./apiClient";
import { EMPTY_MANIFEST_CACHE, ManifestCache, normalizeManifestCacheData } from "./manifestCache";
import { OAuthClient, revokeTokens } from "./oauth";
import { ProgressTracker } from "./progress";
import { UnabyssSettingTab } from "./settings";
import { runInboundSync } from "./syncInbound";
import { runOutboundSync } from "./syncOutbound";
import {
    AuthState,
    DEFAULT_EXPORT_FOLDER,
    DEFAULT_SETTINGS,
    ManifestCacheData,
    OAUTH_PROTOCOL_ACTION,
    OUTBOUND_DEBOUNCE_MS,
    PluginSettings,
    SAFETY_NET_INTERVAL_MS,
    SyncInboundReport,
    SyncOutboundReport,
} from "./types";

/**
 * On-disk shape of ``data.json``: plugin settings (with ``auth``
 * nested) plus the manifest cache. Kept flat so a hand-edit doesn't
 * require deep-merge logic on the next load.
 */
interface PluginData {
    settings: PluginSettings;
    manifestCache: ManifestCacheData;
}

export default class UnabyssPlugin extends Plugin {
    settings!: PluginSettings;
    readonly outboundProgress = new ProgressTracker("outbound");
    readonly inboundProgress = new ProgressTracker("inbound");

    private manifestCacheData: ManifestCacheData = { ...EMPTY_MANIFEST_CACHE };
    private manifestCache!: ManifestCache;
    private api: UnabyssApiClient | null = null;
    private oauthClient: OAuthClient = new OAuthClient();
    private settingTab: UnabyssSettingTab | null = null;
    private outboundDebounceTimer: number | null = null;
    private safetyNetIntervalHandle: number | null = null;
    private outboundInFlight = false;
    private inboundInFlight = false;
    private saveChain: Promise<void> = Promise.resolve();

    shouldShowConnectionBanner(): boolean {
        return Boolean(this.settings.auth) && !this.settings.bannerDismissed;
    }

    async dismissConnectionBanner(): Promise<void> {
        this.settings.bannerDismissed = true;
        await this.savePluginData();
        this.refreshSettingsTab();
    }

    async onload(): Promise<void> {
        await this.loadPluginData();
        this.manifestCache = new ManifestCache(this.manifestCacheData, async (data) => {
            this.manifestCacheData = data;
            await this.savePluginData();
        });
        this.rebuildApiClient();

        this.registerObsidianProtocolHandler(OAUTH_PROTOCOL_ACTION, async (params) => {
            await this.handleOAuthCallback(params);
        });

        this.addCommand({
            id: "sync-now",
            name: "Sync now (both directions)",
            callback: () => {
                this.runManualSync().catch((err) => {
                    new Notice(`Unabyss sync failed: ${describeError(err)}`);
                });
            },
        });

        this.addCommand({
            id: "sync-outbound",
            name: "Sync outbound now",
            callback: () => {
                this.runOutboundSync(true)
                    .then((report) => {
                        new Notice(
                            `Unabyss outbound \u2014 ${report.uploaded} uploaded, ` +
                                `${report.deleted} deleted, ${report.restored} restored.`,
                        );
                    })
                    .catch((err) => {
                        new Notice(`Unabyss outbound failed: ${describeError(err)}`);
                    });
            },
        });

        this.addCommand({
            id: "sync-inbound",
            name: "Sync inbound now",
            callback: () => {
                this.runInboundSync(true)
                    .then((report) => {
                        new Notice(
                            `Unabyss inbound \u2014 ${report.written} written, ` +
                                `${report.deleted} deleted, ${report.moved} moved.`,
                        );
                    })
                    .catch((err) => {
                        new Notice(`Unabyss inbound failed: ${describeError(err)}`);
                    });
            },
        });

        this.addCommand({
            id: "force-full-resync",
            name: "Force full resync",
            callback: () => {
                this.forceFullResync()
                    .then(() => new Notice("Unabyss: force full resync complete."))
                    .catch((err) => new Notice(`Force full resync failed: ${describeError(err)}`));
            },
        });

        this.settingTab = new UnabyssSettingTab(this.app, this);
        this.addSettingTab(this.settingTab);

        this.registerVaultWatcher();
        this.installSafetyNetTimer();
    }

    onunload(): void {
        this.oauthClient.abort();
        this.api = null;
        this.cancelOutboundDebounce();
        this.clearSafetyNetTimer();
    }

    async saveSettings(): Promise<void> {
        await this.savePluginData();
    }

    /**
     * Build a fresh {@link UnabyssApiClient} from the current settings
     * + auth state. Called on load, after the OAuth callback succeeds,
     * after the user edits the API base URL, and after disconnect.
     */
    rebuildApiClient(): void {
        if (!this.settings.auth) {
            this.api = null;
            return;
        }
        this.api = new UnabyssApiClient({
            apiBaseUrl: this.settings.apiBaseUrl,
            auth: this.settings.auth,
            saveAuth: async (next) => {
                this.settings.auth = next;
                await this.savePluginData();
            },
            clearAuth: async (reason) => {
                console.warn(`Unabyss: clearing auth (${reason}).`);
                await this.clearAuth();
            },
        });
    }

    async beginConnect(): Promise<void> {
        await this.oauthClient.beginAuthorize(this.settings.apiBaseUrl);
    }

    async disconnect(): Promise<void> {
        if (this.settings.auth) {
            try {
                await revokeTokens(this.settings.apiBaseUrl, this.settings.auth.accessToken);
            } catch (err) {
                console.warn("Unabyss: revoke call failed; clearing local tokens anyway.", err);
            }
        }
        await this.clearAuth();
    }

    /**
     * Wipe the manifest cache (paths + inbound watermark) and
     * immediately re-run outbound sync so the server's hash-diff
     * guard re-establishes the truth. If the user has outbound
     * disabled or isn't connected, the cache is still wiped.
     */
    async forceFullResync(): Promise<void> {
        this.manifestCache.clear();
        await this.manifestCache.flush();
        if (this.api && this.settings.outboundEnabled) {
            await this.runOutboundSync(true);
        }
    }

    /**
     * Manual ``Sync now`` from the settings tab / command palette:
     * runs both directions in sequence, honouring each direction's
     * enable toggle. Errors in one direction are surfaced but do not
     * block the other.
     */
    async runManualSync(): Promise<{ outbound: SyncOutboundReport | null; inbound: SyncInboundReport | null }> {
        type DirectionOutcome<T> =
            | { ok: true; report: T }
            | { ok: false; err: unknown };

        const outboundP: Promise<DirectionOutcome<SyncOutboundReport> | null> =
            this.settings.outboundEnabled
                ? this.runOutboundSync(true)
                      .then((report) => ({ ok: true as const, report }))
                      .catch((err: unknown) => ({ ok: false as const, err }))
                : Promise.resolve(null);

        const inboundP: Promise<DirectionOutcome<SyncInboundReport> | null> =
            this.settings.inboundEnabled
                ? this.runInboundSync(true)
                      .then((report) => ({ ok: true as const, report }))
                      .catch((err: unknown) => ({ ok: false as const, err }))
                : Promise.resolve(null);

        const [outboundSettled, inboundSettled] = await Promise.allSettled([outboundP, inboundP]);

        let outbound: SyncOutboundReport | null = null;
        let inbound: SyncInboundReport | null = null;

        if (outboundSettled.status === "fulfilled" && outboundSettled.value) {
            if (outboundSettled.value.ok) {
                outbound = outboundSettled.value.report;
            } else {
                new Notice(`Outbound failed: ${describeError(outboundSettled.value.err)}`);
            }
        } else if (outboundSettled.status === "rejected") {
            new Notice(`Outbound failed: ${describeError(outboundSettled.reason)}`);
        }

        if (inboundSettled.status === "fulfilled" && inboundSettled.value) {
            if (inboundSettled.value.ok) {
                inbound = inboundSettled.value.report;
            } else {
                new Notice(`Inbound failed: ${describeError(inboundSettled.value.err)}`);
            }
        } else if (inboundSettled.status === "rejected") {
            new Notice(`Inbound failed: ${describeError(inboundSettled.reason)}`);
        }

        if (outbound) {
            new Notice(
                `Outbound \u2014 ${outbound.uploaded} uploaded, ${outbound.deleted} deleted, ${outbound.restored} restored; embedding in Unabyss.`,
            );
        }
        if (inbound) {
            new Notice(
                `Inbound \u2014 ${inbound.written} written, ${inbound.deleted} deleted, ${inbound.moved} moved.`,
            );
        }
        return { outbound, inbound };
    }

    async runOutboundSync(force = false): Promise<SyncOutboundReport> {
        if (!force && !this.settings.outboundEnabled) {
            throw new Error("Outbound sync is disabled in settings.");
        }
        if (!this.api) {
            throw new Error("Connect to Unabyss before running outbound sync.");
        }
        if (this.outboundInFlight) {
            throw new Error("Outbound sync is already running.");
        }
        if (!this.settings.vaultId) {
            this.settings.vaultId = generateVaultId();
            await this.savePluginData();
        }
        this.outboundInFlight = true;
        this.outboundProgress.start("Scanning vault...");
        try {
            const report = await runOutboundSync({
                app: this.app,
                api: this.api,
                cache: this.manifestCache,
                vaultId: this.settings.vaultId,
                vaultDisplayName: this.app.vault.getName(),
                includeFolders: this.settings.includeFolders,
                progress: this.outboundProgress,
            });
            this.outboundProgress.succeed(
                `Outbound accepted - ${report.uploaded} uploaded, ${report.deleted} deleted; embedding in Unabyss.`,
            );
            this.settings.bannerDismissed = true;
            await this.savePluginData();
            return report;
        } catch (err) {
            this.outboundProgress.fail(describeError(err));
            throw err;
        } finally {
            this.outboundInFlight = false;
        }
    }

    async runInboundSync(force = false): Promise<SyncInboundReport> {
        if (!force && !this.settings.inboundEnabled) {
            throw new Error("Inbound sync is disabled in settings.");
        }
        if (!this.api) {
            throw new Error("Connect to Unabyss before running inbound sync.");
        }
        if (this.inboundInFlight) {
            throw new Error("Inbound sync is already running.");
        }
        await this.ensureExportTargetFolder();
        this.inboundInFlight = true;
        try {
            return await runInboundSync({
                app: this.app,
                api: this.api,
                cache: this.manifestCache,
                targetFolder: this.settings.exportTargetFolder,
                deleteBehaviour: this.settings.exportDeleteBehaviour,
                progress: this.inboundProgress,
            });
        } finally {
            this.inboundInFlight = false;
        }
    }

    /**
     * Reset the per-direction progress tracker when the user toggles a
     * direction off so a stale "Synced X notes" label doesn't keep
     * sticking around.
     */
    onDirectionToggleChanged(): void {
        if (!this.settings.outboundEnabled) {
            this.cancelOutboundDebounce();
            this.outboundProgress.reset();
        }
        if (!this.settings.inboundEnabled) {
            this.inboundProgress.reset();
        }
    }

    private registerVaultWatcher(): void {
        const handler = (file: TAbstractFile): void => {
            if (!this.settings.outboundEnabled) {
                return;
            }
            if (!(file instanceof TFile) || file.extension !== "md") {
                return;
            }
            if (!this.isInOutboundScope(file.path)) {
                return;
            }
            this.scheduleOutboundDebounce();
        };
        this.registerEvent(this.app.vault.on("modify", handler));
        this.registerEvent(this.app.vault.on("create", handler));
        this.registerEvent(this.app.vault.on("delete", handler));
        this.registerEvent(
            this.app.vault.on("rename", (file) => handler(file)),
        );
    }

    private installSafetyNetTimer(): void {
        this.clearSafetyNetTimer();
        const handle = window.setInterval(() => {
            this.runSafetyNetPass().catch((err) => {
                console.warn("Unabyss: safety-net pass failed", err);
            });
        }, SAFETY_NET_INTERVAL_MS);
        this.safetyNetIntervalHandle = handle;
        this.registerInterval(handle);
    }

    private clearSafetyNetTimer(): void {
        if (this.safetyNetIntervalHandle !== null) {
            window.clearInterval(this.safetyNetIntervalHandle);
            this.safetyNetIntervalHandle = null;
        }
    }

    private async runSafetyNetPass(): Promise<void> {
        if (!this.api) {
            return;
        }
        const outboundP =
            this.settings.outboundEnabled && !this.outboundInFlight
                ? this.runOutboundSync(false).catch((err) => {
                      console.warn("Unabyss safety-net outbound failed", err);
                  })
                : Promise.resolve();
        const inboundP =
            this.settings.inboundEnabled && !this.inboundInFlight
                ? this.ensureExportTargetFolder()
                      .then(() => this.runInboundSync(false))
                      .catch((err) => {
                          console.warn("Unabyss safety-net inbound failed", err);
                      })
                : Promise.resolve();
        await Promise.allSettled([outboundP, inboundP]);
    }

    private async ensureExportTargetFolder(): Promise<void> {
        if (this.settings.exportTargetFolder.trim()) {
            return;
        }
        this.settings.exportTargetFolder = DEFAULT_EXPORT_FOLDER;
        await this.savePluginData();
    }

    private scheduleOutboundDebounce(): void {
        if (this.outboundDebounceTimer !== null) {
            window.clearTimeout(this.outboundDebounceTimer);
        }
        this.outboundDebounceTimer = window.setTimeout(() => {
            this.outboundDebounceTimer = null;
            this.runOutboundSync(false).catch((err) => {
                console.warn("Unabyss debounced outbound failed", err);
            });
        }, OUTBOUND_DEBOUNCE_MS);
    }

    private cancelOutboundDebounce(): void {
        if (this.outboundDebounceTimer !== null) {
            window.clearTimeout(this.outboundDebounceTimer);
            this.outboundDebounceTimer = null;
        }
    }

    /**
     * Decide whether a file path falls inside the user's outbound
     * include-folder scope. Empty list = whole vault. Matches the
     * predicate logic in ``syncOutbound.buildIncludeFilter`` so a
     * file-change event only triggers a debounce when the file would
     * actually be picked up by the next sync.
     */
    private isInOutboundScope(filePath: string): boolean {
        const folders = this.settings.includeFolders
            .map((folder) => folder.trim())
            .filter((folder) => folder.length > 0)
            .map((folder) => normalizePath(folder));
        if (folders.length === 0) {
            return true;
        }
        const normalizedPath = normalizePath(filePath);
        return folders.some((prefix) => {
            if (prefix === "/" || prefix === "") {
                return true;
            }
            return normalizedPath === prefix || normalizedPath.startsWith(prefix + "/");
        });
    }

    private async loadPluginData(): Promise<void> {
        const raw = (await this.loadData()) as Partial<PluginData> | null;
        const incoming = raw ?? {};
        const settings: PluginSettings = {
            ...DEFAULT_SETTINGS,
            ...(incoming.settings ?? {}),
            includeFolders:
                incoming.settings && Array.isArray(incoming.settings.includeFolders)
                    ? [...incoming.settings.includeFolders]
                    : [...DEFAULT_SETTINGS.includeFolders],
            auth: incoming.settings?.auth ?? null,
        };
        if (!settings.vaultId) {
            settings.vaultId = generateVaultId();
        }
        this.settings = settings;
        this.manifestCacheData = normalizeManifestCacheData(incoming.manifestCache);
        await this.savePluginData();
    }

    private async savePluginData(): Promise<void> {
        const data: PluginData = {
            settings: this.settings,
            manifestCache: this.manifestCacheData,
        };
        this.saveChain = this.saveChain
            .catch(() => {})
            .then(() => this.saveData(data));
        return this.saveChain;
    }

    private async clearAuth(): Promise<void> {
        this.settings.auth = null;
        await this.savePluginData();
        this.rebuildApiClient();
        this.refreshSettingsTab();
    }

    private refreshSettingsTab(): void {
        this.settingTab?.display();
    }

    private async handleOAuthCallback(params: Record<string, string>): Promise<void> {
        try {
            const auth: AuthState = await this.oauthClient.handleCallback({
                code: params.code,
                state: params.state,
                error: params.error,
            });
            this.settings.auth = auth;
            await this.savePluginData();
            this.rebuildApiClient();
            this.refreshSettingsTab();
            new Notice(
                "Connected to Unabyss. Open settings and run Sync now to register this vault.",
            );
        } catch (err) {
            new Notice(`Connect failed: ${describeError(err)}`);
        }
    }
}

/**
 * Mint a fresh UUIDv4 for use as the plugin's stable ``vault_id``.
 *
 * The value is opaque to the server (per tech-decisions §Decision 3)
 * and lives in ``data.json``. ``crypto.randomUUID()`` is available
 * inside Electron's renderer for modern Obsidian versions; we fall
 * back to a manual v4 builder for the edge case where it isn't.
 */
function generateVaultId(): string {
    if (typeof crypto.randomUUID === "function") {
        return crypto.randomUUID();
    }
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
    return (
        hex.slice(0, 8) +
        "-" +
        hex.slice(8, 12) +
        "-" +
        hex.slice(12, 16) +
        "-" +
        hex.slice(16, 20) +
        "-" +
        hex.slice(20, 32)
    );
}

function describeError(err: unknown): string {
    if (err instanceof Error) {
        return err.message;
    }
    return String(err);
}

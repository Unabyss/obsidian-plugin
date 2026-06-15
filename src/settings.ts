/**
 * Settings tab for the Unabyss plugin (Phase 5).
 *
 * Adds onto the Phase 4 shell:
 *
 *  - Native folder picker for the include-folder list AND for the
 *    inbound exports target folder (``FolderSuggestModal`` pattern).
 *  - Per-direction enable / disable toggles.
 *  - "Delete behaviour when an export is deleted in Unabyss"
 *    dropdown (leave / delete / move).
 *  - Per-direction live progress indicator subscribed to the
 *    {@link ProgressTracker} owned by {@link UnabyssPlugin}.
 *  - Working "Force full resync" button that clears the local cache
 *    and immediately re-runs an outbound sync.
 *
 * The tab continues to delegate every action back to the host plugin
 * so authentication state, api client mutation, persistence, and
 * sync orchestration stay in one place.
 */

import {
    AbstractInputSuggest,
    App,
    Notice,
    PluginSettingTab,
    Setting,
    SuggestModal,
    TFolder,
} from "obsidian";
import type UnabyssPlugin from "./main";
import { DEFAULT_EXPORT_FOLDER } from "./types";
import { ProgressSnapshot } from "./progress";
import { ExportDeleteBehaviour } from "./types";

type SubscriptionDisposer = () => void;

export class UnabyssSettingTab extends PluginSettingTab {
    private readonly plugin: UnabyssPlugin;
    private readonly disposers: SubscriptionDisposer[] = [];

    constructor(app: App, plugin: UnabyssPlugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display(): void {
        this.unsubscribeAll();
        const { containerEl } = this;
        containerEl.empty();
        this.renderHeader(containerEl);
        this.renderConnectionBanner(containerEl);
        this.renderAccountSection(containerEl);
        this.renderOutboundSection(containerEl);
        this.renderInboundSection(containerEl);
        this.renderAdvancedSection(containerEl);
    }

    hide(): void {
        this.unsubscribeAll();
    }

    private renderHeader(containerEl: HTMLElement): void {
        const header = containerEl.createDiv({ cls: "unabyss-settings-header" });
        this.renderLogo(header);
        header.createDiv({ cls: "unabyss-settings-title", text: "Unabyss" });
    }

    /**
     * Renders the Unabyss mark as inline SVG that inherits the current
     * theme text colour, so the plugin ships no extra image assets and
     * adapts to light/dark automatically.
     */
    private renderLogo(parent: HTMLElement): void {
        const dotOpacities = [
            0.28, 0.26, 0.89, 0.65,
            0.56, 0.7, 0.88, 0.69,
            0.57, 0.26, 0.62, 0.5,
            0.74, 0.08, 0.13, 0.98,
        ];
        const coords = [4, 12, 20, 28];
        const svg = parent.createSvg("svg", {
            cls: "unabyss-settings-logo",
            attr: { viewBox: "0 0 32 32", width: 32, height: 32 },
        });
        let index = 0;
        for (const cy of coords) {
            for (const cx of coords) {
                svg.createSvg("circle", {
                    attr: {
                        cx,
                        cy,
                        r: 3,
                        fill: "currentColor",
                        "fill-opacity": dotOpacities[index],
                    },
                });
                index++;
            }
        }
    }

    private renderApiBaseUrl(containerEl: HTMLElement): void {
        new Setting(containerEl)
            .setName("API base URL")
            .setDesc(
                "Unabyss API origin. The plugin opens the matching consent page in your browser " +
                    "(api.<host> is rewritten to app.<host> automatically).",
            )
            .addText((text) => {
                text.setPlaceholder("https://api.unabyss.com")
                    .setValue(this.plugin.settings.apiBaseUrl)
                    .onChange(async (value) => {
                        const trimmed = value.trim() || "https://api.unabyss.com";
                        this.plugin.settings.apiBaseUrl = trimmed;
                        await this.plugin.saveSettings();
                        this.plugin.rebuildApiClient();
                    });
            });
    }

    private renderConnectionBanner(containerEl: HTMLElement): void {
        if (!this.plugin.shouldShowConnectionBanner()) {
            return;
        }
        const auth = this.plugin.settings.auth;
        const banner = containerEl.createDiv({ cls: "unabyss-connection-banner" });

        banner.createEl("p", {
            text:
                `Connected as ${auth?.userEmail || "(unknown)"}. Click Sync now to register this vault ` +
                "with Unabyss and start syncing.",
        });
        banner.createEl("p", {
            text: `Exports from Unabyss will be written to "${DEFAULT_EXPORT_FOLDER}" in this vault. ` +
                "Change the folder under Inbound settings.",
            cls: "setting-item-description",
        });

        const actions = banner.createDiv({ cls: "unabyss-connection-banner-actions" });

        const syncBtn = actions.createEl("button", { text: "Sync now" });
        syncBtn.classList.add("mod-cta");
        syncBtn.onclick = async () => {
            syncBtn.disabled = true;
            try {
                await this.plugin.runManualSync();
            } catch (err) {
                new Notice(`Sync failed: ${describeError(err)}`);
            } finally {
                syncBtn.disabled = false;
                this.display();
            }
        };

        const dismissBtn = actions.createEl("button", { text: "Dismiss" });
        dismissBtn.onclick = async () => {
            dismissBtn.disabled = true;
            try {
                await this.plugin.dismissConnectionBanner();
            } finally {
                dismissBtn.disabled = false;
            }
        };
    }

    private renderAccountSection(containerEl: HTMLElement): void {
        const auth = this.plugin.settings.auth;
        const setting = new Setting(containerEl).setName("Account");

        if (auth) {
            setting.setDesc(`Connected as ${auth.userEmail || "(unknown)"}`);
            setting.addButton((btn) =>
                btn.setButtonText("Disconnect").onClick(async () => {
                    btn.setDisabled(true);
                    try {
                        await this.plugin.disconnect();
                        new Notice("Disconnected from Unabyss.");
                    } catch (err) {
                        new Notice(`Disconnect failed: ${describeError(err)}`);
                    } finally {
                        btn.setDisabled(false);
                        this.display();
                    }
                }),
            );
        } else {
            setting.setDesc("Not connected.");
            setting.addButton((btn) =>
                btn.setCta().setButtonText("Connect").onClick(async () => {
                    btn.setDisabled(true);
                    try {
                        await this.plugin.beginConnect();
                        new Notice("Opened consent page in your browser.");
                    } catch (err) {
                        new Notice(`Connect failed: ${describeError(err)}`);
                    } finally {
                        btn.setDisabled(false);
                    }
                }),
            );
        }

        new Setting(containerEl)
            .setName("Sync now (both directions)")
            .setDesc("Run both enabled directions concurrently, same as the hourly timer fires.")
            .addButton((btn) =>
                btn
                    .setCta()
                    .setButtonText("Sync now")
                    .setDisabled(this.plugin.settings.auth === null)
                    .onClick(async () => {
                        btn.setDisabled(true);
                        try {
                            await this.plugin.runManualSync();
                        } catch (err) {
                            new Notice(`Sync failed: ${describeError(err)}`);
                        } finally {
                            btn.setDisabled(this.plugin.settings.auth === null);
                            this.display();
                        }
                    }),
            );

        this.renderCombinedSyncStatus(containerEl);
    }

    private renderOutboundSection(containerEl: HTMLElement): void {
        new Setting(containerEl).setName("Outbound sync").setHeading();

        new Setting(containerEl)
            .setName("Sync outbound")
            .setDesc(
                "When off, neither file-change events, the hourly timer, nor the manual button " +
                    "send notes to Unabyss.",
            )
            .addToggle((toggle) =>
                toggle.setValue(this.plugin.settings.outboundEnabled).onChange(async (value) => {
                    this.plugin.settings.outboundEnabled = value;
                    await this.plugin.saveSettings();
                    this.plugin.onDirectionToggleChanged();
                    this.display();
                }),
            );

        new Setting(containerEl)
            .setName("Include folders")
            .setDesc(
                "Vault-relative folder paths to sync. Leave empty to sync the whole vault. " +
                    "Use the picker to add folders one at a time.",
            )
            .addButton((btn) =>
                btn.setButtonText("Add folder").onClick(() => {
                    new FolderSuggestModal(this.app, async (folder) => {
                        const next = [...this.plugin.settings.includeFolders];
                        if (!next.includes(folder.path)) {
                            next.push(folder.path);
                            this.plugin.settings.includeFolders = next;
                            await this.plugin.saveSettings();
                            this.display();
                        }
                    }).open();
                }),
            );

        this.renderFolderChipList(containerEl, this.plugin.settings.includeFolders, async (next) => {
            this.plugin.settings.includeFolders = next;
            await this.plugin.saveSettings();
            this.display();
        });

    }

    private renderInboundSection(containerEl: HTMLElement): void {
        new Setting(containerEl).setName("Inbound sync").setHeading();

        new Setting(containerEl)
            .setName("Sync inbound")
            .setDesc(
                "When off, exports are not written back into the vault and the hourly timer " +
                    "skips this direction.",
            )
            .addToggle((toggle) =>
                toggle.setValue(this.plugin.settings.inboundEnabled).onChange(async (value) => {
                    this.plugin.settings.inboundEnabled = value;
                    await this.plugin.saveSettings();
                    this.plugin.onDirectionToggleChanged();
                    this.display();
                }),
            );

        new Setting(containerEl)
            .setName("Export target folder")
            .setDesc("Vault folder where Unabyss exports are written. Pick a folder to enable inbound sync.")
            .addText((text) => {
                const inputEl = text.inputEl;
                text.setPlaceholder(DEFAULT_EXPORT_FOLDER)
                    .setValue(this.plugin.settings.exportTargetFolder)
                    .onChange(async (value) => {
                        this.plugin.settings.exportTargetFolder = value.trim();
                        await this.plugin.saveSettings();
                    });
                new FolderInputSuggest(this.app, inputEl, async (folder) => {
                    this.plugin.settings.exportTargetFolder = folder.path;
                    await this.plugin.saveSettings();
                    this.display();
                });
            });

        new Setting(containerEl)
            .setName("When an export is deleted in Unabyss")
            .setDesc(
                "Controls what happens locally when Unabyss soft-deletes an export the plugin " +
                    "previously wrote into your vault.",
            )
            .addDropdown((dropdown) =>
                dropdown
                    .addOption("leave", "Leave the local file alone (default)")
                    .addOption("delete", "Delete the local file (system trash)")
                    .addOption("move", "Move to a Deleted/ subfolder")
                    .setValue(this.plugin.settings.exportDeleteBehaviour)
                    .onChange(async (value) => {
                        this.plugin.settings.exportDeleteBehaviour = value as ExportDeleteBehaviour;
                        await this.plugin.saveSettings();
                    }),
            );
    }

    private renderAdvancedSection(containerEl: HTMLElement): void {
        new Setting(containerEl).setName("Advanced").setHeading();
        this.renderApiBaseUrl(containerEl);
        new Setting(containerEl)
            .setName("Force full resync")
            .setDesc(
                "Clears the local manifest cache + inbound watermark, then runs an outbound sync " +
                    "so the server's hash-diff guard re-establishes the truth.",
            )
            .addButton((btn) =>
                btn
                    .setWarning()
                    .setButtonText("Force full resync")
                    .setDisabled(this.plugin.settings.auth === null)
                    .onClick(async () => {
                        btn.setDisabled(true);
                        try {
                            await this.plugin.forceFullResync();
                            new Notice("Force full resync complete.");
                        } catch (err) {
                            new Notice(`Force full resync failed: ${describeError(err)}`);
                        } finally {
                            btn.setDisabled(this.plugin.settings.auth === null);
                            this.display();
                        }
                    }),
            );
    }

    private renderFolderChipList(
        containerEl: HTMLElement,
        folders: string[],
        save: (next: string[]) => Promise<void>,
    ): void {
        if (folders.length === 0) {
            return;
        }
        const chipsRow = containerEl.createDiv({ cls: "unabyss-folder-chip-row" });
        for (const folder of folders) {
            const chip = chipsRow.createDiv({ cls: "unabyss-folder-chip" });
            chip.createSpan({ text: folder });
            const remove = chip.createEl("button", {
                text: "x",
                cls: "unabyss-folder-chip-remove",
            });
            remove.addEventListener("click", () => {
                const next = folders.filter((entry) => entry !== folder);
                void save(next);
            });
        }
    }

    private renderCombinedSyncStatus(containerEl: HTMLElement): void {
        const setting = new Setting(containerEl).setName("Sync status");
        const outboundEl = setting.descEl.createDiv();
        const inboundEl = setting.descEl.createDiv();

        const updateOutbound = (snapshot: ProgressSnapshot): void => {
            outboundEl.setText(`Outbound: ${formatProgress(snapshot)}`);
        };
        const updateInbound = (snapshot: ProgressSnapshot): void => {
            inboundEl.setText(`Inbound: ${formatProgress(snapshot)}`);
        };

        this.disposers.push(this.plugin.outboundProgress.subscribe(updateOutbound));
        this.disposers.push(this.plugin.inboundProgress.subscribe(updateInbound));
    }

    private unsubscribeAll(): void {
        for (const dispose of this.disposers) {
            dispose();
        }
        this.disposers.length = 0;
    }
}

function formatProgress(snapshot: ProgressSnapshot): string {
    const head = `${snapshot.label}`;
    if (snapshot.phase === "running" && snapshot.total > 0) {
        return `${head} (${snapshot.done}/${snapshot.total})`;
    }
    if (snapshot.phase === "error" && snapshot.error) {
        return `${head} - ${snapshot.error}`;
    }
    return head;
}

function describeError(err: unknown): string {
    if (err instanceof Error) {
        return err.message;
    }
    return String(err);
}

/**
 * Modal that suggests every folder in the vault. Used by the include-list
 * "Add folder" button. Mirrors the official ``FolderSuggestModal``
 * pattern (Obsidian's own UX for the "Move file to..." flow).
 */
class FolderSuggestModal extends SuggestModal<TFolder> {
    private readonly onChoose: (folder: TFolder) => void | Promise<void>;

    constructor(app: App, onChoose: (folder: TFolder) => void | Promise<void>) {
        super(app);
        this.onChoose = onChoose;
        this.setPlaceholder("Pick a vault folder...");
    }

    getSuggestions(query: string): TFolder[] {
        const folders: TFolder[] = [];
        const root = this.app.vault.getRoot();
        const walk = (folder: TFolder): void => {
            folders.push(folder);
            for (const child of folder.children) {
                if (child instanceof TFolder) {
                    walk(child);
                }
            }
        };
        walk(root);
        const needle = query.toLowerCase();
        return folders.filter((folder) => folder.path.toLowerCase().includes(needle));
    }

    renderSuggestion(folder: TFolder, el: HTMLElement): void {
        el.setText(folder.path === "/" ? "(vault root)" : folder.path);
    }

    onChooseSuggestion(folder: TFolder): void {
        Promise.resolve(this.onChoose(folder)).catch((err) => {
            console.warn("Unabyss: folder pick failed", err);
        });
    }
}

/**
 * Inline ``AbstractInputSuggest`` attached to the target-folder text
 * input so users can type-ahead instead of opening a separate modal.
 */
class FolderInputSuggest extends AbstractInputSuggest<TFolder> {
    private readonly inputEl: HTMLInputElement;

    constructor(app: App, inputEl: HTMLInputElement, onPick: (folder: TFolder) => Promise<void>) {
        super(app, inputEl);
        this.inputEl = inputEl;
        this.onSelect((folder) => {
            this.inputEl.value = folder.path;
            this.close();
            onPick(folder).catch((err) => {
                console.warn("Unabyss: folder suggest pick failed", err);
            });
        });
    }

    protected getSuggestions(query: string): TFolder[] {
        const folders: TFolder[] = [];
        const root = this.app.vault.getRoot();
        const walk = (folder: TFolder): void => {
            folders.push(folder);
            for (const child of folder.children) {
                if (child instanceof TFolder) {
                    walk(child);
                }
            }
        };
        walk(root);
        const needle = query.toLowerCase();
        return folders.filter((folder) => folder.path.toLowerCase().includes(needle));
    }

    renderSuggestion(folder: TFolder, el: HTMLElement): void {
        el.setText(folder.path === "/" ? "(vault root)" : folder.path);
    }
}

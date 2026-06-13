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
import { ProgressSnapshot, ProgressTracker } from "./progress";
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
        this.renderAuthState(containerEl);
        this.renderOutboundSection(containerEl);
        this.renderInboundSection(containerEl);
        this.renderSyncActions(containerEl);
        this.renderAdvancedSection(containerEl);
    }

    hide(): void {
        this.unsubscribeAll();
    }

    private renderHeader(containerEl: HTMLElement): void {
        const header = containerEl.createDiv({ cls: "unabyss-settings-header" });
        header.style.display = "flex";
        header.style.alignItems = "center";
        header.style.gap = "10px";
        header.style.marginBottom = "18px";

        const logo = header.createEl("img", { cls: "unabyss-settings-logo" });
        logo.alt = "Unabyss";
        logo.src = this.pluginLogoResourcePath();
        logo.style.width = "32px";
        logo.style.height = "32px";
        logo.style.flexShrink = "0";

        const title = header.createEl("h2", { text: "Unabyss" });
        title.style.margin = "0";
    }

    private pluginLogoResourcePath(): string {
        const logoFile = document.body.classList.contains("theme-dark")
            ? "logo-dark.svg"
            : "logo-light.svg";
        return this.app.vault.adapter.getResourcePath(
            `.obsidian/plugins/${this.plugin.manifest.id}/${logoFile}`,
        );
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

    private renderAuthState(containerEl: HTMLElement): void {
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
            return;
        }

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

    private renderOutboundSection(containerEl: HTMLElement): void {
        containerEl.createEl("h3", { text: "Obsidian \u2192 Unabyss (outbound)" });

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

        this.renderProgressRow(containerEl, "Outbound status", this.plugin.outboundProgress);
    }

    private renderInboundSection(containerEl: HTMLElement): void {
        containerEl.createEl("h3", { text: "Unabyss \u2192 Obsidian (inbound)" });

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
                text.setPlaceholder("Unabyss/Exports")
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

        this.renderProgressRow(containerEl, "Inbound status", this.plugin.inboundProgress);
    }

    private renderSyncActions(containerEl: HTMLElement): void {
        containerEl.createEl("h3", { text: "Manual sync" });

        new Setting(containerEl)
            .setName("Sync now (both directions)")
            .setDesc("Run both enabled directions in sequence, same as the hourly timer fires.")
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
    }

    private renderAdvancedSection(containerEl: HTMLElement): void {
        containerEl.createEl("h3", { text: "Advanced" });
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
        chipsRow.style.display = "flex";
        chipsRow.style.flexWrap = "wrap";
        chipsRow.style.gap = "8px";
        chipsRow.style.marginBottom = "12px";
        for (const folder of folders) {
            const chip = chipsRow.createDiv({ cls: "unabyss-folder-chip" });
            chip.style.padding = "4px 8px";
            chip.style.border = "1px solid var(--background-modifier-border)";
            chip.style.borderRadius = "4px";
            chip.style.display = "flex";
            chip.style.alignItems = "center";
            chip.style.gap = "6px";
            chip.createSpan({ text: folder });
            const remove = chip.createEl("button", { text: "x" });
            remove.style.background = "transparent";
            remove.style.border = "none";
            remove.style.cursor = "pointer";
            remove.addEventListener("click", async () => {
                const next = folders.filter((entry) => entry !== folder);
                await save(next);
            });
        }
    }

    private renderProgressRow(
        containerEl: HTMLElement,
        name: string,
        tracker: ProgressTracker,
    ): void {
        const setting = new Setting(containerEl).setName(name);
        const valueEl = setting.descEl.createSpan();
        const dispose = tracker.subscribe((snapshot) => {
            valueEl.setText(formatProgress(snapshot));
        });
        this.disposers.push(dispose);
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

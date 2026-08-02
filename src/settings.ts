/**
 * Settings tab for the Unabyss plugin (Phase 5).
 *
 * Dual-support Path B (Obsidian docs):
 *  - ``getSettingDefinitions()`` for Obsidian 1.13.0+ (search-indexed,
 *    declarative render; ``display()`` is skipped).
 *  - ``display()`` kept as the imperative fallback for older Obsidian.
 *
 * Both paths must stay in sync. Prefer ``refreshSettingsUi()`` over
 * calling ``display()`` / ``update()`` directly so each host picks the
 * right refresh.
 */

import {
    AbstractInputSuggest,
    App,
    Notice,
    PluginSettingTab,
    Setting,
    SettingDefinitionItem,
    SuggestModal,
    TFolder,
} from "obsidian";
import type UnabyssPlugin from "./main";
import { DEFAULT_EXPORT_FOLDER } from "./types";
import { ProgressSnapshot, formatProgress } from "./progress";
import { ExportDeleteBehaviour } from "./types";
import { renderUnabyssLogo } from "./logo";

type SubscriptionDisposer = () => void;

type ControlKey =
    | "apiBaseUrl"
    | "outboundEnabled"
    | "inboundEnabled"
    | "exportTargetFolder"
    | "exportDeleteBehaviour";

export class UnabyssSettingTab extends PluginSettingTab {
    plugin: UnabyssPlugin;
    private readonly disposers: SubscriptionDisposer[] = [];

    constructor(app: App, plugin: UnabyssPlugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    /**
     * Obsidian 1.13.0+: declarative definitions (search-indexed).
     * Keep this cheap — no I/O; side effects live in ``render`` / ``action``.
     */
    getSettingDefinitions(): SettingDefinitionItem[] {
        return [
            {
                name: "Unabyss",
                searchable: false,
                render: (setting) => {
                    const el = setting.settingEl;
                    el.empty();
                    el.addClass("unabyss-settings-header");
                    renderUnabyssLogo(el);
                    el.createDiv({ cls: "unabyss-settings-title", text: "Unabyss" });
                },
            },
            {
                name: "Get started",
                searchable: false,
                visible: () => this.plugin.shouldShowConnectionBanner(),
                render: (setting) => {
                    this.renderConnectionBannerInto(setting.settingEl);
                },
            },
            {
                name: "Account",
                render: (setting) => {
                    const auth = this.plugin.settings.auth;
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
                                    this.refreshSettingsUi();
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
                },
            },
            {
                name: "Sync now (both directions)",
                desc: "Run both enabled directions concurrently, same as the daily safety-net timer fires.",
                render: (setting) => {
                    setting.addButton((btn) =>
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
                                    this.refreshSettingsUi();
                                }
                            }),
                    );
                },
            },
            {
                name: "Sync status",
                searchable: false,
                render: (setting) => {
                    const outboundEl = setting.descEl.createDiv();
                    const inboundEl = setting.descEl.createDiv();
                    const updateOutbound = (snapshot: ProgressSnapshot): void => {
                        outboundEl.setText(`Outbound: ${formatProgress(snapshot)}`);
                    };
                    const updateInbound = (snapshot: ProgressSnapshot): void => {
                        inboundEl.setText(`Inbound: ${formatProgress(snapshot)}`);
                    };
                    const disposeOutbound = this.plugin.outboundProgress.subscribe(updateOutbound);
                    const disposeInbound = this.plugin.inboundProgress.subscribe(updateInbound);
                    return () => {
                        disposeOutbound();
                        disposeInbound();
                    };
                },
            },
            {
                type: "group",
                heading: "Outbound sync",
                items: [
                    {
                        name: "Sync outbound",
                        desc:
                            "When off, neither file-change events, the daily safety-net timer, nor the manual button " +
                            "send notes to Unabyss.",
                        control: { type: "toggle", key: "outboundEnabled" },
                    },
                ],
            },
            {
                type: "list",
                heading: "Include folders",
                emptyState: "Empty = sync the whole vault.",
                addItem: {
                    name: "Add folder",
                    action: () => {
                        new FolderSuggestModal(this.app, async (folder) => {
                            const next = [...this.plugin.settings.includeFolders];
                            if (!next.includes(folder.path)) {
                                next.push(folder.path);
                                this.plugin.settings.includeFolders = next;
                                await this.plugin.saveSettings();
                                this.refreshSettingsUi();
                            }
                        }).open();
                    },
                },
                onDelete: (index) => {
                    const next = [...this.plugin.settings.includeFolders];
                    next.splice(index, 1);
                    this.plugin.settings.includeFolders = next;
                    void this.plugin.saveSettings().then(() => this.refreshSettingsUi());
                },
                items: this.plugin.settings.includeFolders.map((path) => ({
                    name: path === "/" ? "(vault root)" : path,
                    searchable: false,
                })),
            },
            {
                type: "group",
                heading: "Inbound sync",
                items: [
                    {
                        name: "Sync inbound",
                        desc:
                            "When off, exports are not written back into the vault and the daily safety-net timer " +
                            "skips this direction.",
                        control: { type: "toggle", key: "inboundEnabled" },
                    },
                    {
                        name: "Export target folder",
                        desc: "Vault folder where Unabyss exports are written. Pick a folder to enable inbound sync.",
                        control: {
                            type: "folder",
                            key: "exportTargetFolder",
                            placeholder: DEFAULT_EXPORT_FOLDER,
                            includeRoot: true,
                        },
                    },
                    {
                        name: "When an export is deleted in Unabyss",
                        desc:
                            "Controls what happens locally when Unabyss soft-deletes an export the plugin " +
                            "previously wrote into your vault.",
                        control: {
                            type: "dropdown",
                            key: "exportDeleteBehaviour",
                            defaultValue: "leave",
                            options: {
                                leave: "Leave the local file alone (default)",
                                delete: "Delete the local file (system trash)",
                                move: "Move to a Deleted/ subfolder",
                            },
                        },
                    },
                ],
            },
            {
                type: "group",
                heading: "Advanced",
                items: [
                    {
                        name: "API base URL",
                        desc:
                            "Unabyss API origin. The plugin opens the matching consent page in your browser " +
                            "(api.<host> is rewritten to app.<host> automatically).",
                        control: {
                            type: "text",
                            key: "apiBaseUrl",
                            placeholder: "https://api.unabyss.com",
                        },
                    },
                    {
                        name: "Force full resync",
                        desc:
                            "Clears the local manifest cache + inbound watermark, then runs an outbound sync " +
                            "so the server's hash-diff guard re-establishes the truth.",
                        render: (setting) => {
                            setting.addButton((btn) =>
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
                                            this.refreshSettingsUi();
                                        }
                                    }),
                            );
                        },
                    },
                ],
            },
        ];
    }

    getControlValue(key: string): unknown {
        return (this.plugin.settings as unknown as Record<string, unknown>)[key];
    }

    /**
     * Persist through ``saveSettings()`` (keeps manifest cache in data.json)
     * and run side effects the imperative path also runs.
     */
    async setControlValue(key: string, value: unknown): Promise<void> {
        const settings = this.plugin.settings;
        switch (key as ControlKey) {
            case "apiBaseUrl": {
                const trimmed =
                    typeof value === "string" && value.trim()
                        ? value.trim()
                        : "https://api.unabyss.com";
                settings.apiBaseUrl = trimmed;
                await this.plugin.saveSettings();
                this.plugin.rebuildApiClient();
                return;
            }
            case "outboundEnabled":
                settings.outboundEnabled = Boolean(value);
                await this.plugin.saveSettings();
                this.plugin.onDirectionToggleChanged();
                return;
            case "inboundEnabled":
                settings.inboundEnabled = Boolean(value);
                await this.plugin.saveSettings();
                this.plugin.onDirectionToggleChanged();
                return;
            case "exportTargetFolder":
                settings.exportTargetFolder = typeof value === "string" ? value.trim() : "";
                await this.plugin.saveSettings();
                return;
            case "exportDeleteBehaviour":
                if (value === "leave" || value === "delete" || value === "move") {
                    settings.exportDeleteBehaviour = value;
                    await this.plugin.saveSettings();
                }
                return;
            default:
                return;
        }
    }

    /** Imperative fallback for Obsidian &lt; 1.13.0. */
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

    /** Prefer ``update()`` on 1.13+; fall back to ``display()`` on older hosts. */
    refreshSettingsUi(): void {
        if (typeof this.update === "function") {
            this.update();
            return;
        }
        this.display();
    }

    private renderHeader(containerEl: HTMLElement): void {
        const header = containerEl.createDiv({ cls: "unabyss-settings-header" });
        renderUnabyssLogo(header);
        header.createDiv({ cls: "unabyss-settings-title", text: "Unabyss" });
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
        this.renderConnectionBannerInto(containerEl.createDiv({ cls: "unabyss-connection-banner" }));
    }

    private renderConnectionBannerInto(banner: HTMLElement): void {
        banner.empty();
        banner.addClass("unabyss-connection-banner");
        const auth = this.plugin.settings.auth;

        banner.createEl("p", {
            text:
                `Connected as ${auth?.userEmail || "(unknown)"}. Click Sync now to register this vault ` +
                "with Unabyss and start syncing.",
        });
        banner.createEl("p", {
            text:
                `Exports from Unabyss will be written to "${DEFAULT_EXPORT_FOLDER}" in this vault. ` +
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
                this.refreshSettingsUi();
            }
        };

        const dismissBtn = actions.createEl("button", { text: "Dismiss" });
        dismissBtn.onclick = async () => {
            dismissBtn.disabled = true;
            try {
                await this.plugin.dismissConnectionBanner();
                this.refreshSettingsUi();
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
                        this.refreshSettingsUi();
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
            .setDesc("Run both enabled directions concurrently, same as the daily safety-net timer fires.")
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
                            this.refreshSettingsUi();
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
                "When off, neither file-change events, the daily safety-net timer, nor the manual button " +
                    "send notes to Unabyss.",
            )
            .addToggle((toggle) =>
                toggle.setValue(this.plugin.settings.outboundEnabled).onChange(async (value) => {
                    this.plugin.settings.outboundEnabled = value;
                    await this.plugin.saveSettings();
                    this.plugin.onDirectionToggleChanged();
                    this.refreshSettingsUi();
                }),
            );

        const includeFolders = containerEl.createDiv({ cls: "unabyss-include-folders" });
        new Setting(includeFolders)
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
                            this.refreshSettingsUi();
                        }
                    }).open();
                }),
            );

        this.renderFolderChipList(includeFolders, this.plugin.settings.includeFolders, async (next) => {
            this.plugin.settings.includeFolders = next;
            await this.plugin.saveSettings();
            this.refreshSettingsUi();
        });
    }

    private renderInboundSection(containerEl: HTMLElement): void {
        new Setting(containerEl).setName("Inbound sync").setHeading();

        new Setting(containerEl)
            .setName("Sync inbound")
            .setDesc(
                "When off, exports are not written back into the vault and the daily safety-net timer " +
                    "skips this direction.",
            )
            .addToggle((toggle) =>
                toggle.setValue(this.plugin.settings.inboundEnabled).onChange(async (value) => {
                    this.plugin.settings.inboundEnabled = value;
                    await this.plugin.saveSettings();
                    this.plugin.onDirectionToggleChanged();
                    this.refreshSettingsUi();
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
                    this.refreshSettingsUi();
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
                            this.refreshSettingsUi();
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
        const subContainer = containerEl.createDiv({ cls: "unabyss-folder-chip-subcontainer" });
        subContainer.createDiv({
            cls: "unabyss-folder-chip-subcontainer-title",
            text: "Selected folders",
        });
        const chipsRow = subContainer.createDiv({ cls: "unabyss-folder-chip-row" });
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

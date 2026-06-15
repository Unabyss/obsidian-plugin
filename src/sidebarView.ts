/**
 * Read-only Unabyss side panel.
 *
 * Docks in the right sidebar and mirrors the live state the user cares
 * about at a glance: connection status plus per-direction sync progress
 * (subscribed to the same {@link ProgressTracker}s the settings tab and
 * sync engines use). All mutating actions stay in the settings tab; this
 * view never writes.
 */

import { ItemView, WorkspaceLeaf } from "obsidian";
import type UnabyssPlugin from "./main";
import { renderUnabyssLogo, UNABYSS_ICON_ID } from "./logo";
import { ProgressSnapshot, formatProgress } from "./progress";

export const UNABYSS_VIEW_TYPE = "unabyss-sidebar";

type Disposer = () => void;

export class UnabyssSidebarView extends ItemView {
    private readonly plugin: UnabyssPlugin;
    private readonly disposers: Disposer[] = [];
    private outboundEl: HTMLElement | null = null;
    private inboundEl: HTMLElement | null = null;

    constructor(leaf: WorkspaceLeaf, plugin: UnabyssPlugin) {
        super(leaf);
        this.plugin = plugin;
    }

    getViewType(): string {
        return UNABYSS_VIEW_TYPE;
    }

    getDisplayText(): string {
        return "Unabyss";
    }

    getIcon(): string {
        return UNABYSS_ICON_ID;
    }

    async onOpen(): Promise<void> {
        this.render();
    }

    async onClose(): Promise<void> {
        this.teardown();
    }

    /** Re-render the static parts (called by the plugin on auth changes). */
    refreshStatus(): void {
        this.render();
    }

    private render(): void {
        this.teardown();
        const root = this.contentEl;
        root.empty();
        root.addClass("unabyss-sidebar");

        const header = root.createDiv({ cls: "unabyss-sidebar-header" });
        renderUnabyssLogo(header);
        header.createDiv({ cls: "unabyss-sidebar-title", text: "Unabyss" });

        const auth = this.plugin.settings.auth;
        const status = root.createDiv({ cls: "unabyss-sidebar-status" });
        status.createEl("div", {
            cls: "unabyss-sidebar-status-line",
            text: auth ? `Connected as ${auth.userEmail || "(unknown)"}` : "Not connected",
        });

        const progress = root.createDiv({ cls: "unabyss-sidebar-progress" });
        this.outboundEl = progress.createDiv({ cls: "unabyss-sidebar-progress-line" });
        this.inboundEl = progress.createDiv({ cls: "unabyss-sidebar-progress-line" });

        this.disposers.push(
            this.plugin.outboundProgress.subscribe((snapshot) =>
                this.renderProgressLine(this.outboundEl, "Outbound", snapshot),
            ),
        );
        this.disposers.push(
            this.plugin.inboundProgress.subscribe((snapshot) =>
                this.renderProgressLine(this.inboundEl, "Inbound", snapshot),
            ),
        );

        root.createEl("div", {
            cls: "unabyss-sidebar-hint",
            text: "Manage sync in Settings \u2192 Community plugins \u2192 Unabyss.",
        });
    }

    private renderProgressLine(
        el: HTMLElement | null,
        label: string,
        snapshot: ProgressSnapshot,
    ): void {
        if (!el) {
            return;
        }
        el.setText(`${label}: ${formatProgress(snapshot)}`);
    }

    private teardown(): void {
        for (const dispose of this.disposers) {
            dispose();
        }
        this.disposers.length = 0;
    }
}

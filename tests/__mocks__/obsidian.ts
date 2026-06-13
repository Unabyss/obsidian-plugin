/**
 * Test-time stub of the ``obsidian`` runtime module.
 *
 * Only the symbols actually reached by unit tests are implemented; the
 * rest are inert placeholders that exist so TypeScript ``import``
 * statements resolve. Tests that need vault behaviour build their own
 * tiny fakes per-file and inject them into the unit under test.
 */

export class TFile {
    path = "";
    name = "";
    extension = "md";
    stat = { mtime: 0, ctime: 0, size: 0 };
}

export class TFolder {
    path = "";
    name = "";
    children: Array<TFile | TFolder> = [];
}

export type TAbstractFile = TFile | TFolder;

export class Plugin {
    app: unknown = {};
    addCommand(): void {}
    addSettingTab(): void {}
    registerObsidianProtocolHandler(): void {}
    registerEvent(): void {}
    registerInterval(): void {}
    async loadData(): Promise<unknown> {
        return null;
    }
    async saveData(): Promise<void> {}
}

export class PluginSettingTab {
    containerEl = { empty: () => undefined, createEl: () => ({}) };
    constructor(_app: unknown, _plugin: unknown) {}
    display(): void {}
}

export class Setting {
    constructor(_containerEl: unknown) {}
    setName(): this {
        return this;
    }
    setDesc(): this {
        return this;
    }
    addText(): this {
        return this;
    }
    addButton(): this {
        return this;
    }
    addToggle(): this {
        return this;
    }
    addDropdown(): this {
        return this;
    }
    descEl = { createSpan: () => ({ setText: () => undefined }) };
}

export class SuggestModal<_T> {
    constructor(_app: unknown) {}
    setPlaceholder(): void {}
    open(): void {}
}

export class AbstractInputSuggest<_T> {
    constructor(_app: unknown, _inputEl: unknown) {}
    onSelect(): this {
        return this;
    }
    close(): void {}
}

export class Notice {
    constructor(_message?: string) {}
}

export const App = class {} as unknown;

export function normalizePath(path: string): string {
    return path.replace(/\\/g, "/").replace(/\/{2,}/g, "/");
}

export function requestUrl(): never {
    throw new Error("requestUrl is not available in unit tests; inject your own client.");
}

export type RequestUrlParam = unknown;
export type RequestUrlResponse = unknown;

export const Vault = class {} as unknown;

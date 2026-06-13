/**
 * Watermark advancement on partial inbound failure.
 *
 * The contract documented in ``syncInbound.ts``: the
 * ``exportsUpdatedAfter`` watermark only advances past a row that was
 * fully applied. If any row inside a page errors, the watermark
 * remains at whatever the last fully-applied page boundary was so the
 * next sync replays the failed rows.
 */

import { ManifestCache } from "../src/manifestCache";
import { runInboundSync } from "../src/syncInbound";
import {
    EMPTY_MANIFEST_CACHE,
    ExportRow,
    PaginatedResponse,
} from "../src/types";
import { TFile, TFolder } from "./__mocks__/obsidian";

type ApiStub = {
    getChangedExports: (
        updatedAfter: string,
        limit: number,
        offset: number,
    ) => Promise<PaginatedResponse<ExportRow>>;
};

function makeRow(id: string, title: string, updatedAt: string): ExportRow {
    return {
        id,
        title,
        topic_text: "",
        preset_slug: "",
        status: "completed",
        is_deleted: false,
        markdown: `# ${title}\n\nbody for ${id}`,
        created_at: updatedAt,
        updated_at: updatedAt,
    };
}

class FakeVault {
    files = new Map<string, TFile>();
    folders = new Map<string, TFolder>();
    createCalls: Array<{ path: string; data: string }> = [];

    constructor(rootFolders: string[]) {
        for (const folder of rootFolders) {
            this.addFolder(folder);
        }
    }

    addFolder(path: string): TFolder {
        const folder = new TFolder();
        folder.path = path;
        this.folders.set(path, folder);
        return folder;
    }

    getAbstractFileByPath(path: string): TFile | TFolder | null {
        return this.files.get(path) ?? this.folders.get(path) ?? null;
    }

    getRoot(): TFolder {
        return this.folders.get("/") ?? this.addFolder("/");
    }

    async createFolder(path: string): Promise<TFolder> {
        return this.addFolder(path);
    }

    async cachedRead(file: TFile): Promise<string> {
        return (file as TFile & { __body?: string }).__body ?? "";
    }

    async modify(file: TFile, data: string): Promise<void> {
        (file as TFile & { __body?: string }).__body = data;
    }

    async create(path: string, data: string): Promise<TFile> {
        this.createCalls.push({ path, data });
        if (this.failOnCreate?.test(path)) {
            throw new Error(`simulated create failure on ${path}`);
        }
        const file = new TFile();
        file.path = path;
        file.name = path.split("/").pop() ?? path;
        (file as TFile & { __body?: string }).__body = data;
        this.files.set(path, file);
        return file;
    }

    async trash(_file: TFile, _system: boolean): Promise<void> {}

    failOnCreate: RegExp | null = null;
}

function setupApp(vault: FakeVault) {
    return {
        vault,
        fileManager: { async renameFile() {} },
    } as unknown as Parameters<typeof runInboundSync>[0]["app"];
}

function setupCache(): { cache: ManifestCache } {
    const cache = new ManifestCache({ ...EMPTY_MANIFEST_CACHE }, async () => {
        /* persistence side-effects are uninteresting to these tests */
    });
    return { cache };
}

describe("runInboundSync watermark advancement", () => {
    it("advances the watermark to the highest updated_at of a fully-applied page", async () => {
        const vault = new FakeVault(["Exports"]);
        const app = setupApp(vault);
        const { cache } = setupCache();
        const rows = [
            makeRow("11111111-aaaa-bbbb-cccc-dddddddddddd", "Note A", "2026-01-01T00:00:00Z"),
            makeRow("22222222-aaaa-bbbb-cccc-dddddddddddd", "Note B", "2026-01-02T00:00:00Z"),
            makeRow("33333333-aaaa-bbbb-cccc-dddddddddddd", "Note C", "2026-01-03T00:00:00Z"),
        ];
        let calls = 0;
        const api: ApiStub = {
            async getChangedExports() {
                calls += 1;
                if (calls === 1) {
                    return { count: rows.length, next: null, previous: null, results: rows };
                }
                return { count: 0, next: null, previous: null, results: [] };
            },
        };

        const report = await runInboundSync({
            app,
            api: api as unknown as Parameters<typeof runInboundSync>[0]["api"],
            cache,
            targetFolder: "Exports",
            deleteBehaviour: "leave",
        });

        expect(report.errors).toHaveLength(0);
        expect(report.written).toEqual(3);
        expect(cache.getExportsWatermark()).toEqual("2026-01-03T00:00:00Z");
        expect(vault.createCalls.map((row) => row.path)).toEqual([
            "Exports/note-a.md",
            "Exports/note-b.md",
            "Exports/note-c.md",
        ]);
    });

    it("does NOT advance the watermark when a row inside the page errors", async () => {
        const vault = new FakeVault(["Exports"]);
        vault.failOnCreate = /note-b\.md$/u;
        const app = setupApp(vault);
        const { cache } = setupCache();

        const rows = [
            makeRow("11111111-aaaa-bbbb-cccc-dddddddddddd", "Note A", "2026-01-01T00:00:00Z"),
            makeRow("22222222-aaaa-bbbb-cccc-dddddddddddd", "Note B", "2026-01-02T00:00:00Z"),
            makeRow("33333333-aaaa-bbbb-cccc-dddddddddddd", "Note C", "2026-01-03T00:00:00Z"),
        ];
        const api: ApiStub = {
            async getChangedExports() {
                return { count: rows.length, next: null, previous: null, results: rows };
            },
        };

        const report = await runInboundSync({
            app,
            api: api as unknown as Parameters<typeof runInboundSync>[0]["api"],
            cache,
            targetFolder: "Exports",
            deleteBehaviour: "leave",
        });

        expect(report.errors).toHaveLength(1);
        expect(report.errors[0].title).toEqual("Note B");
        expect(report.written).toEqual(2);
        expect(cache.getExportsWatermark()).toEqual("");
    });

    it("appends the stable trailer line to every written export", async () => {
        const vault = new FakeVault(["Exports"]);
        const app = setupApp(vault);
        const { cache } = setupCache();
        const row = makeRow("uuid-abc", "Daily Log", "2026-01-01T00:00:00Z");
        const api: ApiStub = {
            async getChangedExports() {
                return { count: 1, next: null, previous: null, results: [row] };
            },
        };

        await runInboundSync({
            app,
            api: api as unknown as Parameters<typeof runInboundSync>[0]["api"],
            cache,
            targetFolder: "Exports",
            deleteBehaviour: "leave",
        });

        expect(vault.createCalls).toHaveLength(1);
        expect(vault.createCalls[0].data).toContain("<!-- unabyss-export-id: uuid-abc -->");
        expect(vault.createCalls[0].data.startsWith("# Daily Log")).toBe(true);
    });
});

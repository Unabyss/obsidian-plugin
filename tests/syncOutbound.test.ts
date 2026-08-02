/**
 * Outbound scan skips: blank / whitespace-only notes must never reach
 * ``notes/upload/`` (current API fails the whole batch on blank
 * content; future API soft-rejects them). Oversize notes stay skipped.
 */

import { ManifestCache } from "../src/manifestCache";
import { runOutboundSync } from "../src/syncOutbound";
import { EMPTY_MANIFEST_CACHE, NoteEnvelope } from "../src/types";
import { TFile } from "./__mocks__/obsidian";

type ApiStub = {
    postManifestChunk: jest.Mock;
    postNoteUpload: jest.Mock;
    postSyncFinalize: jest.Mock;
};

class FakeVault {
    files: TFile[] = [];

    getMarkdownFiles(): TFile[] {
        return this.files;
    }

    async cachedRead(file: TFile): Promise<string> {
        return (file as TFile & { __body?: string }).__body ?? "";
    }
}

function makeFile(path: string, body: string, mtime = 1): TFile {
    const file = new TFile();
    file.path = path;
    file.name = path.split("/").pop() ?? path;
    file.stat = { mtime, ctime: mtime, size: body.length };
    (file as TFile & { __body?: string }).__body = body;
    return file;
}

function makeApi(): ApiStub {
    return {
        postManifestChunk: jest.fn(async ({ hashes }: { hashes: string[] }) => ({
            missing_hashes: hashes,
        })),
        postNoteUpload: jest.fn(async ({ notes }: { notes: NoteEnvelope[] }) => ({
            accepted: notes.length,
            rejected: [],
        })),
        postSyncFinalize: jest.fn(async () => ({
            import_id: "imp-1",
            deleted: 0,
            restored: 0,
            status: "processing",
        })),
    };
}

describe("runOutboundSync blank-note skip", () => {
    it("skips empty and whitespace-only notes and still uploads real content", async () => {
        const vault = new FakeVault();
        vault.files = [
            makeFile("a.md", "hello"),
            makeFile("empty.md", ""),
            makeFile("spaces.md", "  \n\t  "),
            makeFile("b.md", "world"),
        ];
        const api = makeApi();
        const cache = new ManifestCache({ ...EMPTY_MANIFEST_CACHE }, async () => undefined);

        const report = await runOutboundSync({
            app: { vault } as never,
            api: api as never,
            cache,
            vaultId: "vault-1",
            vaultDisplayName: "Test",
            includeFolders: [],
        });

        expect(report.scanned).toBe(2);
        expect(report.skippedEmpty).toBe(2);
        expect(report.skippedOversize).toBe(0);
        expect(report.uploaded).toBe(2);

        const uploadedPaths = (api.postNoteUpload.mock.calls[0][0].notes as NoteEnvelope[]).map(
            (row) => row.vault_path,
        );
        expect(uploadedPaths.sort()).toEqual(["a.md", "b.md"]);

        const finalizeHashes = api.postSyncFinalize.mock.calls[0][0].hashes as string[];
        expect(finalizeHashes).toHaveLength(2);
    });

    it("does not put blank notes into the finalize hash set", async () => {
        const vault = new FakeVault();
        vault.files = [makeFile("only-empty.md", "")];
        const api = makeApi();
        const cache = new ManifestCache({ ...EMPTY_MANIFEST_CACHE }, async () => undefined);

        const report = await runOutboundSync({
            app: { vault } as never,
            api: api as never,
            cache,
            vaultId: "vault-1",
            vaultDisplayName: "Test",
            includeFolders: [],
        });

        expect(report.scanned).toBe(0);
        expect(report.skippedEmpty).toBe(1);
        expect(report.uploaded).toBe(0);
        expect(api.postNoteUpload).not.toHaveBeenCalled();
        expect(api.postSyncFinalize.mock.calls[0][0].hashes).toEqual([]);
    });
});

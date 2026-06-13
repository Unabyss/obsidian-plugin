/**
 * Manifest cache load / save / clear round-trips.
 *
 * The cache is the seam between the outbound scanner's "have I seen
 * this file before?" cheap path and the on-disk ``data.json``. A
 * regression here either over-uploads (cache thinks it has no entries
 * after a reload) or under-uploads (cache claims it knows about a
 * file it hasn't yet hashed).
 */

import {
    ManifestCache,
    normalizeManifestCacheData,
} from "../src/manifestCache";
import { EMPTY_MANIFEST_CACHE, ManifestCacheData } from "../src/types";

function makeCache(): { cache: ManifestCache; saved: ManifestCacheData[] } {
    const saved: ManifestCacheData[] = [];
    const cache = new ManifestCache({ ...EMPTY_MANIFEST_CACHE }, async (data) => {
        saved.push(data);
    });
    return { cache, saved };
}

describe("ManifestCache", () => {
    it("round-trips set -> snapshot -> normalize via persistence", async () => {
        const { cache, saved } = makeCache();
        cache.set("Notes/Daily.md", { contentHash: "aaaa", mtime: 42 });
        cache.setExportsWatermark("2026-01-01T00:00:00Z");
        await cache.flush();

        expect(saved).toHaveLength(1);
        const round = normalizeManifestCacheData(saved[0]);
        expect(round.paths["Notes/Daily.md"]).toEqual({ contentHash: "aaaa", mtime: 42 });
        expect(round.exportsUpdatedAfter).toEqual("2026-01-01T00:00:00Z");
    });

    it("clear wipes paths AND the watermark", async () => {
        const { cache, saved } = makeCache();
        cache.set("a.md", { contentHash: "abc", mtime: 1 });
        cache.setExportsWatermark("2026-01-02T00:00:00Z");
        await cache.flush();

        cache.clear();
        await cache.flush();

        const restored = normalizeManifestCacheData(saved[saved.length - 1]);
        expect(restored.paths).toEqual({});
        expect(restored.exportsUpdatedAfter).toEqual("");
    });

    it("set is a no-op when the existing entry matches exactly", async () => {
        const { cache, saved } = makeCache();
        cache.set("a.md", { contentHash: "abc", mtime: 1 });
        await cache.flush();
        const flushesAfterFirst = saved.length;

        cache.set("a.md", { contentHash: "abc", mtime: 1 });
        await cache.flush();
        expect(saved.length).toEqual(flushesAfterFirst);
    });

    it("retainOnly drops paths absent from the live set", async () => {
        const { cache, saved } = makeCache();
        cache.set("a.md", { contentHash: "1", mtime: 1 });
        cache.set("b.md", { contentHash: "2", mtime: 2 });
        await cache.flush();

        cache.retainOnly(["a.md"]);
        await cache.flush();

        const restored = normalizeManifestCacheData(saved[saved.length - 1]);
        expect(Object.keys(restored.paths)).toEqual(["a.md"]);
    });

    it("normalizes the legacy flat v1 cache shape", () => {
        const legacy = {
            "old.md": { contentHash: "deadbeef", mtime: 99 },
        };
        const normalized = normalizeManifestCacheData(legacy);
        expect(normalized.paths["old.md"]).toEqual({ contentHash: "deadbeef", mtime: 99 });
        expect(normalized.exportsUpdatedAfter).toEqual("");
    });

    it("setExportsWatermark refuses to rewind to an earlier value", () => {
        const { cache } = makeCache();
        cache.setExportsWatermark("2026-02-01T00:00:00Z");
        cache.setExportsWatermark("2026-01-15T00:00:00Z");
        expect(cache.getExportsWatermark()).toEqual("2026-02-01T00:00:00Z");
    });

    it("setExportsWatermark to empty string is treated as a reset", () => {
        const { cache } = makeCache();
        cache.setExportsWatermark("2026-02-01T00:00:00Z");
        cache.setExportsWatermark("");
        expect(cache.getExportsWatermark()).toEqual("");
    });
});

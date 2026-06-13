/**
 * Local manifest cache backing the manifest-first sync.
 *
 * Two responsibilities, persisted side-by-side in the plugin's
 * `data.json`:
 *
 *  - **Path index** (``ManifestPathIndex``): ``vault_path ->
 *    { content_hash, mtime }``. Lets the outbound scanner short-circuit
 *    rehashing files whose ``mtime`` matches.
 *  - **Exports watermark** (``exportsUpdatedAfter``): the latest
 *    ``updated_at`` we've successfully reconciled inbound from the
 *    Unabyss exports stream. Persisted so a fresh plugin boot resumes
 *    from the same offset instead of redoing every export ever.
 *
 * Mutations write through to disk via ``flush()`` so the caller can
 * batch many updates inside one sync pass. The server-side hash diff
 * remains the source of truth for outbound correctness; this cache is
 * a best-effort optimisation that ``clear()`` (Force full resync) can
 * wipe without risking divergence.
 */

import { EMPTY_MANIFEST_CACHE, ManifestCacheData, ManifestCacheEntry, ManifestPathIndex } from "./types";

export type ManifestCachePersistor = (data: ManifestCacheData) => Promise<void>;

/**
 * Normalise an arbitrary stored shape into the current
 * {@link ManifestCacheData} contract.
 *
 * Tolerates v1 (flat ``Record<path, entry>``) and v2 (the structured
 * shape) so users upgrading from Phase 4's plugin don't lose their
 * existing cache on the first Phase 5 boot.
 */
export function normalizeManifestCacheData(raw: unknown): ManifestCacheData {
    if (raw === null || raw === undefined) {
        return { paths: {}, exportsUpdatedAfter: "" };
    }
    if (typeof raw !== "object") {
        return { paths: {}, exportsUpdatedAfter: "" };
    }
    const record = raw as Record<string, unknown>;
    if (isStructuredShape(record)) {
        return {
            paths: normalizePathIndex(record.paths),
            exportsUpdatedAfter:
                typeof record.exportsUpdatedAfter === "string" ? record.exportsUpdatedAfter : "",
        };
    }
    return {
        paths: normalizePathIndex(record),
        exportsUpdatedAfter: "",
    };
}

function isStructuredShape(record: Record<string, unknown>): record is {
    paths?: unknown;
    exportsUpdatedAfter?: unknown;
} {
    return "paths" in record || "exportsUpdatedAfter" in record;
}

function normalizePathIndex(raw: unknown): ManifestPathIndex {
    if (!raw || typeof raw !== "object") {
        return {};
    }
    const next: ManifestPathIndex = {};
    for (const [path, value] of Object.entries(raw as Record<string, unknown>)) {
        if (!value || typeof value !== "object") {
            continue;
        }
        const candidate = value as Partial<ManifestCacheEntry>;
        if (typeof candidate.contentHash !== "string" || typeof candidate.mtime !== "number") {
            continue;
        }
        next[path] = { contentHash: candidate.contentHash, mtime: candidate.mtime };
    }
    return next;
}

export class ManifestCache {
    private paths: ManifestPathIndex;
    private exportsUpdatedAfter: string;
    private readonly persist: ManifestCachePersistor;
    private dirty = false;

    constructor(initial: ManifestCacheData, persist: ManifestCachePersistor) {
        this.paths = { ...initial.paths };
        this.exportsUpdatedAfter = initial.exportsUpdatedAfter;
        this.persist = persist;
    }

    get(path: string): ManifestCacheEntry | undefined {
        return this.paths[path];
    }

    set(path: string, entry: ManifestCacheEntry): void {
        const existing = this.paths[path];
        if (existing && existing.contentHash === entry.contentHash && existing.mtime === entry.mtime) {
            return;
        }
        this.paths[path] = { contentHash: entry.contentHash, mtime: entry.mtime };
        this.dirty = true;
    }

    /**
     * Drop entries whose path is no longer in ``presentPaths``. Called
     * at the end of an outbound pass so the cache doesn't grow forever
     * with files the user has since deleted from the vault.
     */
    retainOnly(presentPaths: Iterable<string>): void {
        const present = new Set(presentPaths);
        const next: ManifestPathIndex = {};
        for (const [path, entry] of Object.entries(this.paths)) {
            if (present.has(path)) {
                next[path] = entry;
            } else {
                this.dirty = true;
            }
        }
        this.paths = next;
    }

    /** Wipe every cached path. Wired to "Force full resync". */
    clear(): void {
        if (Object.keys(this.paths).length > 0) {
            this.paths = {};
            this.dirty = true;
        }
        if (this.exportsUpdatedAfter !== "") {
            this.exportsUpdatedAfter = "";
            this.dirty = true;
        }
    }

    getExportsWatermark(): string {
        return this.exportsUpdatedAfter;
    }

    /**
     * Advance the inbound watermark.
     *
     * Monotonic-by-default: a smaller watermark replaces a larger one
     * only if the caller passes an empty string (reset). This matches
     * the contract documented for ``syncInbound`` - the watermark
     * never rewinds on partial failure.
     */
    setExportsWatermark(value: string): void {
        if (value === this.exportsUpdatedAfter) {
            return;
        }
        if (value !== "" && this.exportsUpdatedAfter !== "" && value < this.exportsUpdatedAfter) {
            return;
        }
        this.exportsUpdatedAfter = value;
        this.dirty = true;
    }

    snapshot(): ManifestCacheData {
        return {
            paths: { ...this.paths },
            exportsUpdatedAfter: this.exportsUpdatedAfter,
        };
    }

    async flush(): Promise<void> {
        if (!this.dirty) {
            return;
        }
        await this.persist(this.snapshot());
        this.dirty = false;
    }
}

export { EMPTY_MANIFEST_CACHE };

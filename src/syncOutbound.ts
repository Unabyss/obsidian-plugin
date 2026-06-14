/**
 * Outbound sync engine (Obsidian -> Unabyss) - minimum-viable Phase 4
 * implementation.
 *
 * Flow per ``run()`` (manual "Sync now" button):
 *
 *   1. Walk every markdown file in the vault via
 *      ``app.vault.getMarkdownFiles()``.
 *   2. Apply the user's include-folder filter (empty list = whole vault).
 *   3. Hash each in-scope file with SHA-256 (matching the server's
 *      ``compute_hash(raw_bytes)``). Skip oversize files
 *      (> ``MAX_NOTE_BYTES``).
 *   4. Persist the computed hashes back into the local manifest cache.
 *   5. Chunk the hash set into ``MANIFEST_MAX_HASHES_PER_CHUNK`` batches
 *      and POST each to ``manifest-chunks/``.
 *   6. For every hash the server reports as missing, upload the body
 *      via ``notes/upload/`` in batches of
 *      ``NOTE_BODIES_MAX_PER_REQUEST``.
 *   7. POST the full hash set to ``sync-finalize/`` and accept the
 *      async embedding response.
 *
 * The manifest cache is best-effort. Files whose ``mtime`` matches the
 * cache row skip hash recomputation; the server-side hash diff is the
 * ultimate source of truth, so a stale or wiped cache produces extra
 * hashing work but never bad data.
 */

import { App, normalizePath, TFile } from "obsidian";
import { UnabyssApiClient } from "./apiClient";
import { ManifestCache } from "./manifestCache";
import { ProgressTracker } from "./progress";
import {
    MAX_NOTE_BYTES,
    MANIFEST_MAX_HASHES_PER_CHUNK,
    NOTE_BODIES_MAX_PER_REQUEST,
    NoteEnvelope,
    NoteUploadRejection,
    SyncOutboundReport,
} from "./types";

interface ScannedNote {
    path: string;
    content: string;
    contentHash: string;
    sizeBytes: number;
    mtime: number;
}

export interface OutboundSyncDeps {
    app: App;
    api: UnabyssApiClient;
    cache: ManifestCache;
    vaultId: string;
    vaultDisplayName: string;
    includeFolders: string[];
    progress?: ProgressTracker;
}

export async function runOutboundSync(deps: OutboundSyncDeps): Promise<SyncOutboundReport> {
    if (!deps.vaultId) {
        throw new Error("Outbound sync requires a vault_id. Connect to Unabyss first.");
    }
    const filter = buildIncludeFilter(deps.includeFolders);
    const allMarkdown = deps.app.vault.getMarkdownFiles();
    const inScope = allMarkdown.filter((file) => filter(file.path));

    deps.progress?.report({ label: "Hashing notes...", total: inScope.length, done: 0 });

    const scanned: ScannedNote[] = [];
    let skippedOversize = 0;
    let scannedCount = 0;
    for (const file of inScope) {
        const note = await scanNote(deps.app, deps.cache, file);
        scannedCount += 1;
        deps.progress?.report({ done: scannedCount });
        if (note === null) {
            skippedOversize += 1;
            continue;
        }
        scanned.push(note);
    }

    deps.cache.retainOnly(scanned.map((row) => row.path));
    await deps.cache.flush();

    const allHashes = uniqueHashes(scanned);
    deps.progress?.report({ label: "Diffing against server..." });
    const missing = await diffAgainstServer(deps.api, deps.vaultId, allHashes);
    deps.progress?.report({
        label: `Uploading ${missing.size} missing body(s)...`,
        total: missing.size,
        done: 0,
    });
    const uploadOutcome = await uploadMissingBodies(
        deps.api,
        deps.vaultId,
        scanned,
        missing,
        deps.progress,
    );
    deps.progress?.report({ label: "Finalising sync..." });
    const finalize = await deps.api.postSyncFinalize({
        vault_id: deps.vaultId,
        hashes: allHashes,
        vault_display_name: deps.vaultDisplayName || undefined,
    });
    deps.progress?.report({ label: "Sync accepted - embedding in Unabyss" });
    return {
        scanned: scanned.length,
        skippedOversize,
        uploaded: uploadOutcome.uploaded,
        rejected: uploadOutcome.rejected,
        deleted: finalize.deleted,
        restored: finalize.restored,
    };
}

async function scanNote(app: App, cache: ManifestCache, file: TFile): Promise<ScannedNote | null> {
    const cached = cache.get(file.path);
    if (cached && cached.mtime === file.stat.mtime) {
        const content = await app.vault.cachedRead(file);
        const sizeBytes = byteLength(content);
        if (sizeBytes > MAX_NOTE_BYTES) {
            return null;
        }
        return {
            path: file.path,
            content,
            contentHash: cached.contentHash,
            sizeBytes,
            mtime: file.stat.mtime,
        };
    }
    const content = await app.vault.cachedRead(file);
    const sizeBytes = byteLength(content);
    if (sizeBytes > MAX_NOTE_BYTES) {
        return null;
    }
    const contentHash = await computeSha256Hex(content);
    cache.set(file.path, { contentHash, mtime: file.stat.mtime });
    return {
        path: file.path,
        content,
        contentHash,
        sizeBytes,
        mtime: file.stat.mtime,
    };
}

/**
 * Build a predicate matching the user's include-folder list. Empty
 * list = include everything; otherwise vault-relative paths must be
 * under one of the listed folder prefixes (case-sensitive, matching
 * Obsidian's path semantics).
 */
function buildIncludeFilter(includeFolders: string[]): (path: string) => boolean {
    const normalized = includeFolders
        .map((folder) => folder.trim())
        .filter((folder) => folder.length > 0)
        .map((folder) => normalizePath(folder));
    if (normalized.length === 0) {
        return () => true;
    }
    return (path: string) => {
        const normalizedPath = normalizePath(path);
        return normalized.some((prefix) => {
            if (prefix === "/" || prefix === "") {
                return true;
            }
            return (
                normalizedPath === prefix ||
                normalizedPath.startsWith(prefix + "/")
            );
        });
    };
}

function uniqueHashes(rows: ScannedNote[]): string[] {
    const set = new Set<string>();
    for (const row of rows) {
        set.add(row.contentHash);
    }
    return [...set].sort();
}

async function diffAgainstServer(
    api: UnabyssApiClient,
    vaultId: string,
    allHashes: string[],
): Promise<Set<string>> {
    const missing = new Set<string>();
    for (let i = 0; i < allHashes.length; i += MANIFEST_MAX_HASHES_PER_CHUNK) {
        const chunk = allHashes.slice(i, i + MANIFEST_MAX_HASHES_PER_CHUNK);
        const response = await api.postManifestChunk({
            vault_id: vaultId,
            hashes: chunk,
        });
        for (const hash of response.missing_hashes ?? []) {
            missing.add(hash);
        }
    }
    if (allHashes.length === 0) {
        await api.postManifestChunk({ vault_id: vaultId, hashes: [] });
    }
    return missing;
}

interface UploadOutcome {
    uploaded: number;
    rejected: NoteUploadRejection[];
}

async function uploadMissingBodies(
    api: UnabyssApiClient,
    vaultId: string,
    scanned: ScannedNote[],
    missing: Set<string>,
    progress?: ProgressTracker,
): Promise<UploadOutcome> {
    if (missing.size === 0) {
        return { uploaded: 0, rejected: [] };
    }
    const envelopes: NoteEnvelope[] = [];
    const seen = new Set<string>();
    for (const row of scanned) {
        if (!missing.has(row.contentHash) || seen.has(row.contentHash)) {
            continue;
        }
        seen.add(row.contentHash);
        envelopes.push({
            vault_path: row.path,
            content: row.content,
            vault_id: vaultId,
            content_hash: row.contentHash,
        });
    }
    let uploaded = 0;
    const rejected: NoteUploadRejection[] = [];
    for (let i = 0; i < envelopes.length; i += NOTE_BODIES_MAX_PER_REQUEST) {
        const batch = envelopes.slice(i, i + NOTE_BODIES_MAX_PER_REQUEST);
        const response = await api.postNoteUpload({ notes: batch });
        uploaded += response.accepted ?? 0;
        for (const rejection of response.rejected ?? []) {
            rejected.push(rejection);
        }
        progress?.report({ done: uploaded });
    }
    return { uploaded, rejected };
}

function byteLength(content: string): number {
    return new TextEncoder().encode(content).byteLength;
}

async function computeSha256Hex(content: string): Promise<string> {
    const encoded = new TextEncoder().encode(content);
    const digest = await crypto.subtle.digest("SHA-256", encoded);
    return bytesToHex(new Uint8Array(digest));
}

function bytesToHex(bytes: Uint8Array): string {
    const HEX = "0123456789abcdef";
    let out = "";
    for (let i = 0; i < bytes.length; i++) {
        const byte = bytes[i];
        out += HEX[byte >> 4] + HEX[byte & 0x0f];
    }
    return out;
}

/**
 * Shared types for the Unabyss Obsidian plugin.
 *
 * The wire shapes here mirror the backend serializers documented in
 * `dev-docs/backend/obsidian-plugin/01/tech-decisions.md` so the
 * client and server stay byte-aligned without an OpenAPI codegen step.
 *
 * Persistence: every field marked "persisted" lands in
 * `<vault>/.obsidian/plugins/unabyss/data.json` as plaintext JSON
 * (see README threat model).
 */

export const DEFAULT_API_BASE_URL = "https://api.unabyss.com";
export const OAUTH_CLIENT_ID = "obsidian";
export const OAUTH_REDIRECT_URI = "obsidian://unabyss/auth-callback";
export const OAUTH_PROTOCOL_ACTION = "unabyss/auth-callback";

/**
 * Hard upper bounds enforced by the backend serializers. Kept in sync
 * with `OBSIDIAN_MANIFEST_MAX_HASHES_PER_CHUNK` and
 * `OBSIDIAN_NOTE_BODIES_MAX_PER_REQUEST` in `settings/base/integrations.py`.
 * Mirroring the value locally lets the plugin pre-chunk before hitting
 * a 400 from the server.
 */
export const MANIFEST_MAX_HASHES_PER_CHUNK = 1000;
export const NOTE_BODIES_MAX_PER_REQUEST = 100;

/**
 * Per-note size cap. Mirrors `_MAX_NOTE_BYTES = 1 MiB` in
 * `ingest/obsidian/services/obsidian_import.py`. Notes above this cap
 * are skipped client-side so the plugin never wastes a round-trip on
 * a row the server will reject.
 */
export const MAX_NOTE_BYTES = 1024 * 1024;

export interface AuthState {
    accessToken: string;
    refreshToken: string;
    userEmail: string;
}

/**
 * Behaviour when an export is soft-deleted on the server side.
 * Mirrors the requirements §Configuration choices.
 */
export type ExportDeleteBehaviour = "leave" | "delete" | "move";

/** Subfolder used when {@link ExportDeleteBehaviour} is "move". */
export const DELETED_EXPORTS_SUBFOLDER = "Deleted";

/**
 * Debounce window applied to Obsidian file-change events before kicking
 * off an outbound sync. Aligns with phases.md §"main.ts deltas".
 */
export const OUTBOUND_DEBOUNCE_MS = 5_000;

/**
 * Safety-net timer cadence. Runs both directions regardless of file
 * events so the plugin recovers from missed events / external writes.
 */
export const SAFETY_NET_INTERVAL_MS = 24 * 60 * 60 * 1_000;

/** Default inbound export folder when the user has not picked one yet. */
export const DEFAULT_EXPORT_FOLDER = "Unabyss Exports";

/**
 * Wire-format trailer appended to the bottom of every Unabyss export
 * we write into the vault so subsequent syncs can detect that a slug
 * collision is *the same* export (idempotent overwrite) versus a
 * collision with an unrelated user-authored note (suffix-on-write).
 */
export const EXPORT_TRAILER_PREFIX = "<!-- unabyss-export-id:";
export const EXPORT_TRAILER_SUFFIX = "-->";

export interface PluginSettings {
    apiBaseUrl: string;
    vaultId: string;
    includeFolders: string[];
    /** Vault-relative folder where inbound exports are written. */
    exportTargetFolder: string;
    /** Action to take when a synced export is deleted server-side. */
    exportDeleteBehaviour: ExportDeleteBehaviour;
    /** Master enable switch for the Obsidian -> Unabyss direction. */
    outboundEnabled: boolean;
    /** Master enable switch for the Unabyss -> Obsidian direction. */
    inboundEnabled: boolean;
    auth: AuthState | null;
    /** When true, hide the post-connection guidance banner in settings. */
    bannerDismissed: boolean;
}

export const DEFAULT_SETTINGS: PluginSettings = {
    apiBaseUrl: DEFAULT_API_BASE_URL,
    vaultId: "",
    includeFolders: [],
    exportTargetFolder: "",
    exportDeleteBehaviour: "leave",
    outboundEnabled: true,
    inboundEnabled: true,
    auth: null,
    bannerDismissed: false,
};

/**
 * One row inside the local manifest cache (`<vault_path,
 * content_hash, mtime>`). `mtime` is the Obsidian-reported
 * `stat.mtime` in milliseconds since epoch and lets us short-circuit
 * the hash recomputation on files that did not change.
 */
export interface ManifestCacheEntry {
    contentHash: string;
    mtime: number;
}

/** On-disk shape of the path -> hash cache, keyed by vault-relative path. */
export type ManifestPathIndex = Record<string, ManifestCacheEntry>;

/**
 * Full on-disk shape of the manifest cache. v1 was a flat
 * ``Record<path, entry>``; the cache now also persists the per-vault
 * inbound exports watermark used by ``syncInbound`` so a fresh plugin
 * boot resumes from the same offset.
 */
export interface ManifestCacheData {
    paths: ManifestPathIndex;
    /** ISO-8601 high-watermark for ``GET /api/exports/changed-since/``. */
    exportsUpdatedAfter: string;
}

export const EMPTY_MANIFEST_CACHE: ManifestCacheData = {
    paths: {},
    exportsUpdatedAfter: "",
};

export interface ManifestChunkRequest {
    vault_id: string;
    hashes: string[];
}

export interface ManifestChunkResponse {
    missing_hashes: string[];
}

export interface NoteEnvelope {
    vault_path: string;
    content: string;
    vault_id: string;
    content_hash: string;
}

export interface NoteUploadRequest {
    notes: NoteEnvelope[];
}

export interface NoteUploadRejection {
    vault_path: string;
    reason: string;
}

export interface NoteUploadResponse {
    accepted: number;
    rejected: NoteUploadRejection[];
}

export interface SyncFinalizeRequest {
    vault_id: string;
    hashes: string[];
    vault_display_name?: string;
}

export interface SyncFinalizeResponse {
    import_id: string;
    deleted: number;
    restored: number;
    status: string;
}

export interface VaultRow {
    vault_id: string;
    display_name: string;
    is_export_target: boolean;
    connected_at: string;
    last_synced_at: string | null;
    last_sync_error: string;
    notes_count: number;
    notes_soft_deleted_count: number;
}

export interface VaultListResponse {
    results: VaultRow[];
}

export interface ExportRow {
    id: string;
    title: string;
    topic_text: string;
    preset_slug: string;
    status: string;
    is_deleted: boolean;
    markdown: string;
    created_at: string;
    updated_at: string;
}

export interface PaginatedResponse<T> {
    count: number;
    next: string | null;
    previous: string | null;
    results: T[];
}

export interface TokenResponse {
    access: string;
    refresh: string;
}

export interface OAuthErrorBody {
    error: string;
    error_description?: string;
}

export interface UserMeResponse {
    email: string;
}

export interface SyncOutboundReport {
    scanned: number;
    skippedOversize: number;
    uploaded: number;
    rejected: NoteUploadRejection[];
    deleted: number;
    restored: number;
    lastSyncedAt?: string;
}

/** Per-row outcome surfaced from one inbound sync pass. */
export interface InboundFileOutcome {
    exportId: string;
    title: string;
    vaultPath: string;
    action: "written" | "skipped" | "deleted" | "moved";
    error?: string;
}

export interface SyncInboundReport {
    polled: number;
    written: number;
    deleted: number;
    moved: number;
    skipped: number;
    errors: InboundFileOutcome[];
    watermarkAdvancedTo: string;
}

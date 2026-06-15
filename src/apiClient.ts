/**
 * Typed HTTP client for the Unabyss backend.
 *
 * Wraps the manifest-first plugin endpoints
 * (`/api/ingest/obsidian/manifest-chunks/`, `.../notes/upload/`,
 * `.../sync-finalize/`), the dashboard endpoints
 * (`/api/ingest/obsidian/vaults/...`), the inbound exports listing
 * (`/api/exports/changed-since/`), and the JWT refresh endpoint
 * (`/api/auth/token/refresh/`).
 *
 * Authentication: every authenticated call attaches
 * ``Authorization: Bearer <access>``. On a 401 response, the client
 * runs `rotateRefreshToken` once, swaps in the new access/refresh
 * pair, and retries the original request. A second 401 propagates
 * upward so the caller can surface a "Reconnect" UI affordance.
 */

import { requestUrl, RequestUrlParam, RequestUrlResponse } from "obsidian";
import { normalizeApiBaseUrl, rotateRefreshToken } from "./oauth";
import {
    AuthState,
    ExportRow,
    ManifestChunkRequest,
    ManifestChunkResponse,
    NoteUploadRequest,
    NoteUploadResponse,
    PaginatedResponse,
    SyncFinalizeRequest,
    SyncFinalizeResponse,
    VaultListResponse,
    VaultRow,
} from "./types";

/** Saver hook so the apiClient can persist refreshed tokens without owning settings. */
export type AuthSaver = (auth: AuthState) => Promise<void>;

/** Reset hook called when refresh fails terminally so the plugin can prompt re-auth. */
export type AuthClearHook = (reason: string) => Promise<void>;

export class ApiError extends Error {
    status: number;
    bodyText: string;

    constructor(status: number, message: string, bodyText: string) {
        super(message);
        this.status = status;
        this.bodyText = bodyText;
        this.name = "ApiError";
    }
}

/** Thrown when the refresh-on-401 path also fails (the user must reconnect). */
export class AuthExpiredError extends Error {
    constructor(message = "Authentication has expired. Reconnect to continue syncing.") {
        super(message);
        this.name = "AuthExpiredError";
    }
}

export interface ApiClientOptions {
    apiBaseUrl: string;
    auth: AuthState;
    saveAuth: AuthSaver;
    clearAuth: AuthClearHook;
}

export class UnabyssApiClient {
    private apiBaseUrl: string;
    private auth: AuthState;
    private readonly saveAuth: AuthSaver;
    private readonly clearAuth: AuthClearHook;
    private refreshInFlight: Promise<void> | null = null;

    constructor(opts: ApiClientOptions) {
        this.apiBaseUrl = normalizeApiBaseUrl(opts.apiBaseUrl);
        this.auth = opts.auth;
        this.saveAuth = opts.saveAuth;
        this.clearAuth = opts.clearAuth;
    }

    updateBaseUrl(apiBaseUrl: string): void {
        this.apiBaseUrl = normalizeApiBaseUrl(apiBaseUrl);
    }

    updateAuth(auth: AuthState): void {
        this.auth = auth;
    }

    async postManifestChunk(body: ManifestChunkRequest): Promise<ManifestChunkResponse> {
        return this.requestJson<ManifestChunkResponse>({
            method: "POST",
            path: "/api/ingest/obsidian/manifest-chunks/",
            body,
        });
    }

    async postNoteUpload(body: NoteUploadRequest): Promise<NoteUploadResponse> {
        return this.requestJson<NoteUploadResponse>({
            method: "POST",
            path: "/api/ingest/obsidian/notes/upload/",
            body,
        });
    }

    async postSyncFinalize(body: SyncFinalizeRequest): Promise<SyncFinalizeResponse> {
        return this.requestJson<SyncFinalizeResponse>({
            method: "POST",
            path: "/api/ingest/obsidian/sync-finalize/",
            body,
        });
    }

    async listVaults(): Promise<VaultRow[]> {
        const response = await this.requestJson<VaultListResponse>({
            method: "GET",
            path: "/api/ingest/obsidian/vaults/",
        });
        return response.results ?? [];
    }

    async getChangedExports(updatedAfter: string, limit = 100, offset = 0): Promise<PaginatedResponse<ExportRow>> {
        const params = new URLSearchParams({
            updated_after: updatedAfter,
            limit: String(limit),
            offset: String(offset),
        });
        return this.requestJson<PaginatedResponse<ExportRow>>({
            method: "GET",
            path: `/api/exports/changed-since/?${params.toString()}`,
        });
    }

    private async requestJson<T>(opts: {
        method: "GET" | "POST" | "PUT" | "DELETE";
        path: string;
        body?: unknown;
    }): Promise<T> {
        const response = await this.sendWithRefresh(opts);
        return response.json as T;
    }

    private async sendWithRefresh(opts: {
        method: "GET" | "POST" | "PUT" | "DELETE";
        path: string;
        body?: unknown;
    }): Promise<RequestUrlResponse> {
        const initial = await this.sendOnce(opts);
        if (initial.status !== 401) {
            ensureSuccess(initial);
            return initial;
        }
        try {
            await this.refreshTokens();
        } catch {
            await this.clearAuth("refresh_failed");
            throw new AuthExpiredError();
        }
        const retried = await this.sendOnce(opts);
        if (retried.status === 401) {
            await this.clearAuth("retry_unauthorized");
            throw new AuthExpiredError();
        }
        ensureSuccess(retried);
        return retried;
    }

    private async sendOnce(opts: {
        method: "GET" | "POST" | "PUT" | "DELETE";
        path: string;
        body?: unknown;
    }): Promise<RequestUrlResponse> {
        const params: RequestUrlParam = {
            url: `${this.apiBaseUrl}${opts.path}`,
            method: opts.method,
            headers: {
                Authorization: `Bearer ${this.auth.accessToken}`,
            },
            throw: false,
        };
        if (opts.body !== undefined) {
            params.contentType = "application/json";
            params.body = JSON.stringify(opts.body);
        }
        return requestUrl(params);
    }

    /**
     * Serialize concurrent 401-driven refreshes so only one rotation
     * runs at a time. Concurrent callers await the same promise; once
     * it resolves, ``this.auth`` carries the new pair for every
     * waiting request.
     */
    private async refreshTokens(): Promise<void> {
        if (this.refreshInFlight) {
            return this.refreshInFlight;
        }
        this.refreshInFlight = (async () => {
            try {
                const tokens = await rotateRefreshToken(this.apiBaseUrl, this.auth.refreshToken);
                this.auth = {
                    ...this.auth,
                    accessToken: tokens.access,
                    refreshToken: tokens.refresh,
                };
                await this.saveAuth(this.auth);
            } finally {
                this.refreshInFlight = null;
            }
        })();
        return this.refreshInFlight;
    }
}

function ensureSuccess(response: RequestUrlResponse): void {
    if (response.status < 400) {
        return;
    }
    const body = describeApiError(response);
    throw new ApiError(response.status, body.message, body.text);
}

function describeApiError(response: RequestUrlResponse): { message: string; text: string } {
    const raw = response.text ?? "";
    let message = `HTTP ${response.status}`;
    try {
        const parsed = response.json as Record<string, unknown> | undefined;
        if (parsed) {
            const detail = parsed.detail;
            const error = parsed.error;
            if (typeof detail === "string") {
                message = detail;
            } else if (error && typeof error === "object" && "message" in error) {
                const innerMessage = (error as { message?: unknown }).message;
                if (typeof innerMessage === "string") {
                    message = innerMessage;
                }
            } else if (typeof error === "string") {
                message = error;
            }
        }
    } catch {
        /* swallow JSON parse errors; the HTTP-status message is fine */
    }
    return { message, text: raw };
}

/**
 * Backend detection: one plugin build, two Unabyss backends.
 *
 * The legacy app (Django at `api.unabyss.com`) and the new app (a single
 * Cloudflare Worker) speak the same sync protocol but different OAuth
 * dialects. The new app publishes RFC 8414 discovery metadata at
 * `/.well-known/oauth-authorization-server`; the legacy API host serves a
 * 404 there (its only discovery endpoint lives on the separate MCP vhost).
 * That asymmetry is the mode probe: metadata present means the OAuth-AS
 * dialect, anything else means legacy.
 *
 * The resolved {@link BackendProfile} is stamped into {@link AuthState} at
 * connect time, so tokens are always refreshed and revoked against the
 * backend that minted them. Auth saved by older plugin versions has no
 * profile; those tokens are legacy by construction, and
 * {@link resolveBackendProfile} says so.
 */

import { requestUrl } from "obsidian";
import { AuthState, BackendProfile } from "./types";

/**
 * Build the user-facing consent URL for the legacy backend.
 *
 * Convention (per user decision): when ``apiBaseUrl`` has an ``api.``
 * subdomain, swap it for ``app.`` to land on the frontend consent
 * route; otherwise fall back to the same origin (covers single-origin
 * deployments where API and frontend share a host).
 */
export function deriveConsentUrl(apiBaseUrl: string): string {
    try {
        const url = new URL(apiBaseUrl);
        if (url.hostname.startsWith("api.")) {
            url.hostname = "app." + url.hostname.slice("api.".length);
        }
        url.pathname = "/oauth/authorize";
        url.search = "";
        url.hash = "";
        return url.toString().replace(/\/$/, "");
    } catch {
        return apiBaseUrl.replace(/\/$/, "") + "/oauth/authorize";
    }
}

/** Strip the trailing slash so callers can always append `/api/...` cleanly. */
export function normalizeApiBaseUrl(apiBaseUrl: string): string {
    return apiBaseUrl.replace(/\/$/, "");
}

/** The legacy Django dialect, spelled out. */
export function legacyBackendProfile(apiBaseUrl: string): BackendProfile {
    const base = normalizeApiBaseUrl(apiBaseUrl);
    return {
        mode: "legacy",
        authorizationEndpoint: deriveConsentUrl(base),
        tokenEndpoint: `${base}/api/oauth/token/`,
        refreshEndpoint: `${base}/api/auth/token/refresh/`,
        revocationEndpoint: `${base}/api/oauth/revoke/`,
    };
}

/** Shape of the RFC 8414 metadata fields the plugin actually uses. */
interface AuthorizationServerMetadata {
    authorization_endpoint?: unknown;
    token_endpoint?: unknown;
    revocation_endpoint?: unknown;
}

function asHttpUrl(value: unknown): string | null {
    if (typeof value !== "string" || value.length === 0) {
        return null;
    }
    try {
        const url = new URL(value);
        return url.protocol === "https:" || url.protocol === "http:" ? value : null;
    } catch {
        return null;
    }
}

/** Fetch and validate the metadata; null when the host does not publish it. */
async function fetchMetadataProfile(base: string): Promise<BackendProfile | null> {
    let metadata: AuthorizationServerMetadata | undefined;
    try {
        const response = await requestUrl({
            url: `${base}/.well-known/oauth-authorization-server`,
            method: "GET",
            throw: false,
        });
        if (response.status === 200) {
            metadata = response.json as AuthorizationServerMetadata | undefined;
        }
    } catch {
        return null;
    }

    const authorizationEndpoint = asHttpUrl(metadata?.authorization_endpoint);
    const tokenEndpoint = asHttpUrl(metadata?.token_endpoint);
    if (!authorizationEndpoint || !tokenEndpoint) {
        return null;
    }
    return {
        mode: "oauth-as",
        authorizationEndpoint,
        tokenEndpoint,
        // The OAuth dialect refreshes through the token endpoint
        // (grant_type=refresh_token); only legacy has a separate route.
        refreshEndpoint: tokenEndpoint,
        // The new backend serves RFC 7009 revocation on its token endpoint
        // and advertises it that way; trust the metadata, fall back to the
        // token endpoint when the field is absent.
        revocationEndpoint: asHttpUrl(metadata?.revocation_endpoint) ?? tokenEndpoint,
    };
}

/**
 * Probe the backend once and return its profile.
 *
 * Failures of any kind — 404, HTML, malformed JSON, network error — fall
 * back to the legacy profile. That is the only backend that legitimately
 * lacks the metadata, and a mis-probe against the new backend fails
 * loudly one step later (its token endpoint does not exist under the
 * legacy path), where the user can simply retry Connect.
 */
export async function discoverBackend(apiBaseUrl: string): Promise<BackendProfile> {
    const base = normalizeApiBaseUrl(apiBaseUrl);
    return (await fetchMetadataProfile(base)) ?? legacyBackendProfile(base);
}

/**
 * The profile a stored token pair belongs to. Auth persisted before
 * dual-mode support carries none — those tokens came from the legacy
 * backend, so the legacy profile is the correct (not just safe) answer.
 */
export function resolveBackendProfile(
    apiBaseUrl: string,
    auth: AuthState | null,
): BackendProfile {
    return auth?.backend ?? legacyBackendProfile(apiBaseUrl);
}

/**
 * OAuth 2.0 + PKCE (S256) client for the Unabyss plugin.
 *
 * Drives the full PKCE dance against the Phase 1 backend
 * (`/api/oauth/authorize/`, `/api/oauth/token/`, `/api/oauth/revoke/`):
 *
 * 1. {@link beginAuthorize} mints a fresh code-verifier / code-challenge
 *    pair, stashes the verifier under `state`, and opens the user's
 *    browser at the frontend's consent URL.
 * 2. The user clicks "Allow" in the browser; the frontend redirects to
 *    {@link OAUTH_REDIRECT_URI}, which Obsidian's protocol handler
 *    routes back into {@link handleCallback}.
 * 3. {@link handleCallback} validates `state`, exchanges the code for an
 *    access/refresh JWT pair, fetches the user's email, and persists
 *    the {@link AuthState} via the supplied saver.
 *
 * The plaintext-on-disk token storage is intentional and documented in
 * the README's threat-model section (per requirements §NFR).
 */

import { Notice, requestUrl, RequestUrlResponse } from "obsidian";
import {
    AuthState,
    OAUTH_CLIENT_ID,
    OAUTH_REDIRECT_URI,
    OAuthErrorBody,
    TokenResponse,
    UserMeResponse,
} from "./types";

const PKCE_VERIFIER_BYTES = 32;
const PKCE_STATE_BYTES = 16;
const PKCE_METHOD = "S256";
const RESPONSE_TYPE = "code";
const GRANT_TYPE = "authorization_code";

interface PendingAuthorization {
    verifier: string;
    state: string;
    redirectUri: string;
    apiBaseUrl: string;
}

export interface AuthorizeCallbackParams {
    code?: string;
    state?: string;
    error?: string;
}

/**
 * Build the user-facing consent URL.
 *
 * Convention (per user decision): when ``apiBaseUrl`` has an ``api.``
 * subdomain, swap it for ``app.`` to land on the SvelteKit consent
 * route; otherwise fall back to the same origin (covers self-hosted
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

/**
 * Orchestrates one in-flight PKCE flow. Stateful inside the plugin
 * process; a new instance is created on every "Connect" click and
 * disposed once the callback runs (or on plugin unload).
 */
export class OAuthClient {
    private pending: PendingAuthorization | null = null;

    /**
     * Mint a verifier/challenge pair, persist the verifier in memory
     * keyed by ``state``, and open the user's browser at the consent
     * URL. Returns the URL so callers can override the open mechanism
     * during tests.
     */
    async beginAuthorize(apiBaseUrl: string): Promise<string> {
        const verifier = generatePkceVerifier();
        const challenge = await pkceChallenge(verifier);
        const state = randomBase64Url(PKCE_STATE_BYTES);
        const consentBase = deriveConsentUrl(apiBaseUrl);
        const params = new URLSearchParams({
            response_type: RESPONSE_TYPE,
            client_id: OAUTH_CLIENT_ID,
            redirect_uri: OAUTH_REDIRECT_URI,
            code_challenge: challenge,
            code_challenge_method: PKCE_METHOD,
            state: state,
        });
        const url = `${consentBase}?${params.toString()}`;
        this.pending = {
            verifier,
            state,
            redirectUri: OAUTH_REDIRECT_URI,
            apiBaseUrl: normalizeApiBaseUrl(apiBaseUrl),
        };
        window.open(url);
        return url;
    }

    /**
     * Handle the `obsidian://unabyss/auth-callback?code=...&state=...`
     * deep-link. Validates `state` against the pending request,
     * exchanges the code for tokens, fetches the user's email, and
     * returns the assembled {@link AuthState}. The caller is
     * responsible for persisting it via `Plugin.saveData()`.
     */
    async handleCallback(params: AuthorizeCallbackParams): Promise<AuthState> {
        if (!this.pending) {
            throw new OAuthFlowError(
                "no_pending_authorization",
                "No in-flight authorization. Click Connect first.",
            );
        }
        const pending = this.pending;
        this.pending = null;

        if (params.error) {
            throw new OAuthFlowError(params.error, `Authorization rejected: ${params.error}`);
        }
        if (!params.code) {
            throw new OAuthFlowError(
                "missing_code",
                "Authorization callback was missing the code parameter.",
            );
        }
        if (!params.state || params.state !== pending.state) {
            throw new OAuthFlowError(
                "state_mismatch",
                "Authorization callback state does not match. Restart the flow.",
            );
        }

        const tokens = await exchangeCodeForTokens({
            apiBaseUrl: pending.apiBaseUrl,
            code: params.code,
            codeVerifier: pending.verifier,
            redirectUri: pending.redirectUri,
        });
        const email = await fetchUserEmail(pending.apiBaseUrl, tokens.access);
        return {
            accessToken: tokens.access,
            refreshToken: tokens.refresh,
            userEmail: email,
        };
    }

    abort(): void {
        this.pending = null;
    }

    hasPending(): boolean {
        return this.pending !== null;
    }
}

/**
 * Refresh-token rotation against `/api/auth/token/refresh/` (the
 * existing simplejwt rotation endpoint, which honours the OAuth
 * `client_type` claim minted by Phase 1). The returned pair MUST
 * replace the stored access+refresh tokens; the old refresh token is
 * blacklisted server-side as part of rotation.
 */
export async function rotateRefreshToken(
    apiBaseUrl: string,
    refreshToken: string,
): Promise<TokenResponse> {
    const base = normalizeApiBaseUrl(apiBaseUrl);
    const response = await requestUrl({
        url: `${base}/api/auth/token/refresh/`,
        method: "POST",
        contentType: "application/json",
        body: JSON.stringify({ refresh: refreshToken }),
        throw: false,
    });
    assertOk(response, "refresh-token rotation");
    const body = response.json as Partial<TokenResponse> & { access?: string; refresh?: string };
    if (!body.access || !body.refresh) {
        throw new OAuthFlowError(
            "malformed_refresh_response",
            "Refresh endpoint returned no access/refresh pair.",
        );
    }
    return { access: body.access, refresh: body.refresh };
}

/**
 * Revoke every outstanding OAuth refresh token for ``(user, obsidian
 * client)`` against `/api/oauth/revoke/`. Idempotent server-side; a
 * second call after disconnect returns 204 with no effect.
 */
export async function revokeTokens(
    apiBaseUrl: string,
    accessToken: string,
): Promise<void> {
    const base = normalizeApiBaseUrl(apiBaseUrl);
    const response = await requestUrl({
        url: `${base}/api/oauth/revoke/`,
        method: "POST",
        contentType: "application/json",
        headers: { Authorization: `Bearer ${accessToken}` },
        body: JSON.stringify({ client_id: OAUTH_CLIENT_ID }),
        throw: false,
    });
    if (response.status >= 400) {
        const detail = describeError(response, "revoke");
        new Notice(detail);
    }
}

export class OAuthFlowError extends Error {
    code: string;

    constructor(code: string, message: string) {
        super(message);
        this.code = code;
        this.name = "OAuthFlowError";
    }
}

interface ExchangeOptions {
    apiBaseUrl: string;
    code: string;
    codeVerifier: string;
    redirectUri: string;
}

interface OAuthTokenEndpointResponse {
    access_token: string;
    refresh_token: string;
}

async function exchangeCodeForTokens(opts: ExchangeOptions): Promise<TokenResponse> {
    const response = await requestUrl({
        url: `${opts.apiBaseUrl}/api/oauth/token/`,
        method: "POST",
        contentType: "application/json",
        body: JSON.stringify({
            grant_type: GRANT_TYPE,
            code: opts.code,
            code_verifier: opts.codeVerifier,
            client_id: OAUTH_CLIENT_ID,
            redirect_uri: opts.redirectUri,
        }),
        throw: false,
    });
    if (response.status >= 400) {
        const body = response.json as OAuthErrorBody | undefined;
        const description = body?.error_description || body?.error || `HTTP ${response.status}`;
        throw new OAuthFlowError(body?.error || "token_exchange_failed", description);
    }
    const body = response.json as Partial<OAuthTokenEndpointResponse>;
    if (!body.access_token || !body.refresh_token) {
        throw new OAuthFlowError(
            "malformed_token_response",
            "Token endpoint returned no access/refresh pair.",
        );
    }
    return { access: body.access_token, refresh: body.refresh_token };
}

async function fetchUserEmail(apiBaseUrl: string, accessToken: string): Promise<string> {
    const response = await requestUrl({
        url: `${apiBaseUrl}/api/users/me/`,
        method: "GET",
        headers: { Authorization: `Bearer ${accessToken}` },
        throw: false,
    });
    if (response.status >= 400) {
        throw new OAuthFlowError(
            "fetch_user_failed",
            `Could not fetch user identity (HTTP ${response.status}).`,
        );
    }
    const body = response.json as Partial<UserMeResponse>;
    return body.email || "";
}

/** Exported for unit-test round-tripping (see `tests/oauth.test.ts`). */
export function generatePkceVerifier(): string {
    return randomBase64Url(PKCE_VERIFIER_BYTES);
}

/** Exported for unit-test round-tripping. */
export async function pkceChallenge(verifier: string): Promise<string> {
    const encoded = new TextEncoder().encode(verifier);
    const digest = await crypto.subtle.digest("SHA-256", encoded);
    return base64UrlEncode(new Uint8Array(digest));
}

/** Exported for unit-test round-tripping. */
export function base64UrlEncode(bytes: Uint8Array): string {
    let binary = "";
    for (let i = 0; i < bytes.byteLength; i++) {
        binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function randomBase64Url(byteLength: number): string {
    const buffer = new Uint8Array(byteLength);
    crypto.getRandomValues(buffer);
    return base64UrlEncode(buffer);
}

function assertOk(response: RequestUrlResponse, context: string): void {
    if (response.status >= 400) {
        const description = describeError(response, context);
        throw new OAuthFlowError("http_error", description);
    }
}

function describeError(response: RequestUrlResponse, context: string): string {
    const body = response.json as Partial<OAuthErrorBody> | undefined;
    if (body?.error_description) {
        return `${context} failed: ${body.error_description}`;
    }
    if (body?.error) {
        return `${context} failed: ${body.error}`;
    }
    return `${context} failed: HTTP ${response.status}`;
}

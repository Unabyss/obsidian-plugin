/**
 * OAuth 2.0 + PKCE (S256) client for the Unabyss plugin.
 *
 * Works against both Unabyss backends via a {@link BackendProfile}
 * resolved at connect time (see `backend.ts`):
 *
 * - **legacy** (Django): JSON token bodies at `/api/oauth/token/`,
 *   simplejwt refresh at `/api/auth/token/refresh/`, bearer-authed
 *   revoke at `/api/oauth/revoke/`.
 * - **oauth-as** (the new Cloudflare app): RFC-standard authorization
 *   server discovered from `/.well-known/oauth-authorization-server` -
 *   form-encoded token endpoint that also handles refresh
 *   (`grant_type=refresh_token`) and RFC 7009 revocation.
 *
 * The flow itself is unchanged:
 *
 * 1. {@link OAuthClient.beginAuthorize} probes the backend, mints a
 *    fresh code-verifier / code-challenge pair, and opens the user's
 *    browser at the consent URL.
 * 2. The user clicks "Allow"; the browser redirects to
 *    {@link OAUTH_REDIRECT_URI}, which Obsidian's protocol handler
 *    routes back into {@link OAuthClient.handleCallback}.
 * 3. {@link OAuthClient.handleCallback} validates `state`, exchanges
 *    the code for tokens in the backend's dialect, and returns an
 *    {@link AuthState} stamped with the profile so refresh and revoke
 *    always speak to the backend that minted the tokens.
 *
 * The plaintext-on-disk token storage is intentional and documented in
 * the README's threat-model section (per requirements §NFR).
 */

import { Notice, requestUrl, RequestUrlResponse } from "obsidian";
import { discoverBackend, normalizeApiBaseUrl } from "./backend";
import {
    AuthState,
    BackendProfile,
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
const GRANT_TYPE_CODE = "authorization_code";
const GRANT_TYPE_REFRESH = "refresh_token";

interface PendingAuthorization {
    verifier: string;
    state: string;
    redirectUri: string;
    apiBaseUrl: string;
    profile: BackendProfile;
}

export interface AuthorizeCallbackParams {
    code?: string;
    state?: string;
    error?: string;
}

/**
 * Orchestrates one in-flight PKCE flow. Stateful inside the plugin
 * process; a new instance is created on every "Connect" click and
 * disposed once the callback runs (or on plugin unload).
 */
export class OAuthClient {
    private pending: PendingAuthorization | null = null;

    /**
     * Probe the backend, mint a verifier/challenge pair, persist the
     * verifier in memory keyed by ``state``, and open the user's
     * browser at the consent URL. Returns the URL so callers can
     * override the open mechanism during tests.
     */
    async beginAuthorize(apiBaseUrl: string): Promise<string> {
        const profile = await discoverBackend(apiBaseUrl);
        const verifier = generatePkceVerifier();
        const challenge = await pkceChallenge(verifier);
        const state = randomBase64Url(PKCE_STATE_BYTES);
        const params = new URLSearchParams({
            response_type: RESPONSE_TYPE,
            client_id: OAUTH_CLIENT_ID,
            redirect_uri: OAUTH_REDIRECT_URI,
            code_challenge: challenge,
            code_challenge_method: PKCE_METHOD,
            state: state,
        });
        const url = `${profile.authorizationEndpoint}?${params.toString()}`;
        this.pending = {
            verifier,
            state,
            redirectUri: OAUTH_REDIRECT_URI,
            apiBaseUrl: normalizeApiBaseUrl(apiBaseUrl),
            profile,
        };
        window.open(url);
        return url;
    }

    /**
     * Handle the `obsidian://unabyss/auth-callback?code=...&state=...`
     * deep-link. Validates `state` against the pending request,
     * exchanges the code for tokens, and returns the assembled
     * {@link AuthState} (backend profile included). The caller is
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
            profile: pending.profile,
            code: params.code,
            codeVerifier: pending.verifier,
            redirectUri: pending.redirectUri,
        });
        const email = await fetchUserEmail(pending.apiBaseUrl, tokens.access);
        return {
            accessToken: tokens.access,
            refreshToken: tokens.refresh,
            userEmail: email,
            backend: pending.profile,
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
 * Refresh-token rotation in the profile's dialect. Legacy rotates
 * against the simplejwt endpoint with a JSON `{refresh}` body; the
 * OAuth-AS backend rotates through its token endpoint with a
 * form-encoded `grant_type=refresh_token` request. Either way the
 * returned pair MUST replace the stored access+refresh tokens; the old
 * refresh token is invalidated server-side as part of rotation.
 */
export async function rotateRefreshToken(
    profile: BackendProfile,
    refreshToken: string,
): Promise<TokenResponse> {
    if (profile.mode === "legacy") {
        const response = await requestUrl({
            url: profile.refreshEndpoint,
            method: "POST",
            contentType: "application/json",
            body: JSON.stringify({ refresh: refreshToken }),
            throw: false,
        });
        assertOk(response, "refresh-token rotation");
        const body = response.json as { access?: string; refresh?: string };
        if (!body.access || !body.refresh) {
            throw new OAuthFlowError(
                "malformed_refresh_response",
                "Refresh endpoint returned no access/refresh pair.",
            );
        }
        return { access: body.access, refresh: body.refresh };
    }

    const response = await requestUrl({
        url: profile.refreshEndpoint,
        method: "POST",
        contentType: "application/x-www-form-urlencoded",
        body: new URLSearchParams({
            grant_type: GRANT_TYPE_REFRESH,
            refresh_token: refreshToken,
            client_id: OAUTH_CLIENT_ID,
        }).toString(),
        throw: false,
    });
    assertOk(response, "refresh-token rotation");
    return parseOAuthTokenResponse(response, "malformed_refresh_response");
}

/**
 * Best-effort revocation on disconnect. Legacy revokes every
 * outstanding refresh token for ``(user, obsidian client)``; the
 * OAuth-AS backend takes an RFC 7009 request naming the refresh token,
 * which kills the grant's future (the short-lived access token simply
 * expires). Failures surface a Notice but never block the disconnect -
 * the caller clears local tokens regardless.
 */
export async function revokeTokens(profile: BackendProfile, auth: AuthState): Promise<void> {
    const request =
        profile.mode === "legacy"
            ? {
                  url: profile.revocationEndpoint,
                  method: "POST" as const,
                  contentType: "application/json",
                  headers: { Authorization: `Bearer ${auth.accessToken}` },
                  body: JSON.stringify({ client_id: OAUTH_CLIENT_ID }),
                  throw: false,
              }
            : {
                  url: profile.revocationEndpoint,
                  method: "POST" as const,
                  contentType: "application/x-www-form-urlencoded",
                  body: new URLSearchParams({
                      token: auth.refreshToken,
                      token_type_hint: "refresh_token",
                      client_id: OAUTH_CLIENT_ID,
                  }).toString(),
                  throw: false,
              };
    const response = await requestUrl(request);
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
    profile: BackendProfile;
    code: string;
    codeVerifier: string;
    redirectUri: string;
}

async function exchangeCodeForTokens(opts: ExchangeOptions): Promise<TokenResponse> {
    const fields = {
        grant_type: GRANT_TYPE_CODE,
        code: opts.code,
        code_verifier: opts.codeVerifier,
        client_id: OAUTH_CLIENT_ID,
        redirect_uri: opts.redirectUri,
    };
    // Same fields, different encoding: Django reads JSON, the OAuth-AS
    // token endpoint rejects anything but application/x-www-form-urlencoded.
    const response = await requestUrl(
        opts.profile.mode === "legacy"
            ? {
                  url: opts.profile.tokenEndpoint,
                  method: "POST",
                  contentType: "application/json",
                  body: JSON.stringify(fields),
                  throw: false,
              }
            : {
                  url: opts.profile.tokenEndpoint,
                  method: "POST",
                  contentType: "application/x-www-form-urlencoded",
                  body: new URLSearchParams(fields).toString(),
                  throw: false,
              },
    );
    if (response.status >= 400) {
        const body = response.json as OAuthErrorBody | undefined;
        const description = body?.error_description || body?.error || `HTTP ${response.status}`;
        throw new OAuthFlowError(body?.error || "token_exchange_failed", description);
    }
    return parseOAuthTokenResponse(response, "malformed_token_response");
}

function parseOAuthTokenResponse(response: RequestUrlResponse, errorCode: string): TokenResponse {
    const body = response.json as { access_token?: string; refresh_token?: string };
    if (!body.access_token || !body.refresh_token) {
        throw new OAuthFlowError(errorCode, "Token endpoint returned no access/refresh pair.");
    }
    return { access: body.access_token, refresh: body.refresh_token };
}

/**
 * Cosmetic identity lookup so settings can show which account is
 * connected. Both backends serve `/api/users/me/` (the new one ignores
 * the trailing slash). Deliberately non-fatal: an empty email must
 * never fail a connect that already holds valid tokens.
 */
async function fetchUserEmail(apiBaseUrl: string, accessToken: string): Promise<string> {
    try {
        const response = await requestUrl({
            url: `${apiBaseUrl}/api/users/me/`,
            method: "GET",
            headers: { Authorization: `Bearer ${accessToken}` },
            throw: false,
        });
        if (response.status >= 400) {
            return "";
        }
        const body = response.json as Partial<UserMeResponse>;
        return body.email || "";
    } catch {
        return "";
    }
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

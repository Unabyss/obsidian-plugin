/**
 * The two OAuth dialects, request by request.
 *
 * The riskiest difference between the backends is not the paths but the
 * encodings: Django reads JSON token bodies, while the new backend's
 * authorization server rejects anything that is not
 * `application/x-www-form-urlencoded` and expects `client_id` in the
 * body (public client, auth method "none"). These tests pin the exact
 * bytes each backend receives for connect, refresh, and revoke.
 */

import { webcrypto } from "node:crypto";

if (typeof globalThis.crypto === "undefined") {
    Object.defineProperty(globalThis, "crypto", { value: webcrypto, configurable: true });
}

const requestUrlMock = jest.fn();

jest.mock("obsidian", () => {
    const actual = jest.requireActual<Record<string, unknown>>("./__mocks__/obsidian");
    return { ...actual, requestUrl: (params: unknown) => requestUrlMock(params) };
});

import { legacyBackendProfile } from "../src/backend";
import { OAuthClient, revokeTokens, rotateRefreshToken } from "../src/oauth";
import { AuthState, BackendProfile } from "../src/types";

const OAUTH_AS_PROFILE: BackendProfile = {
    mode: "oauth-as",
    authorizationEndpoint: "https://app.unabyss.com/oauth/authorize",
    tokenEndpoint: "https://app.unabyss.com/oauth/token",
    refreshEndpoint: "https://app.unabyss.com/oauth/token",
    revocationEndpoint: "https://app.unabyss.com/oauth/token",
};

const LEGACY_PROFILE = legacyBackendProfile("https://api.unabyss.com");

const AUTH: AuthState = {
    accessToken: "access-1",
    refreshToken: "refresh-1",
    userEmail: "user@example.com",
};

function respondWith(status: number, json: unknown): void {
    requestUrlMock.mockResolvedValueOnce({ status, json, text: JSON.stringify(json) });
}

function sentRequest(call: number): { url: string; contentType?: string; body?: string } {
    return requestUrlMock.mock.calls[call][0];
}

beforeEach(() => {
    requestUrlMock.mockReset();
    (globalThis as Record<string, unknown>).window = { open: jest.fn() };
});

describe("refresh-token rotation", () => {
    it("legacy: JSON body against the simplejwt route", async () => {
        respondWith(200, { access: "access-2", refresh: "refresh-2" });

        const tokens = await rotateRefreshToken(LEGACY_PROFILE, "refresh-1");

        const sent = sentRequest(0);
        expect(sent.url).toBe("https://api.unabyss.com/api/auth/token/refresh/");
        expect(sent.contentType).toBe("application/json");
        expect(JSON.parse(sent.body ?? "")).toEqual({ refresh: "refresh-1" });
        expect(tokens).toEqual({ access: "access-2", refresh: "refresh-2" });
    });

    it("oauth-as: form-encoded refresh_token grant on the token endpoint", async () => {
        respondWith(200, { access_token: "access-2", refresh_token: "refresh-2" });

        const tokens = await rotateRefreshToken(OAUTH_AS_PROFILE, "refresh-1");

        const sent = sentRequest(0);
        expect(sent.url).toBe("https://app.unabyss.com/oauth/token");
        expect(sent.contentType).toBe("application/x-www-form-urlencoded");
        expect(Object.fromEntries(new URLSearchParams(sent.body))).toEqual({
            grant_type: "refresh_token",
            refresh_token: "refresh-1",
            client_id: "obsidian",
        });
        expect(tokens).toEqual({ access: "access-2", refresh: "refresh-2" });
    });

    it("oauth-as: a rotation missing the new refresh token is an error", async () => {
        respondWith(200, { access_token: "access-2" });

        await expect(rotateRefreshToken(OAUTH_AS_PROFILE, "refresh-1")).rejects.toThrow(
            /no access\/refresh pair/,
        );
    });
});

describe("revocation", () => {
    it("legacy: bearer-authed JSON revoke", async () => {
        respondWith(204, undefined);

        await revokeTokens(LEGACY_PROFILE, AUTH);

        const sent = sentRequest(0) as ReturnType<typeof sentRequest> & {
            headers?: Record<string, string>;
        };
        expect(sent.url).toBe("https://api.unabyss.com/api/oauth/revoke/");
        expect(sent.headers?.Authorization).toBe("Bearer access-1");
        expect(JSON.parse(sent.body ?? "")).toEqual({ client_id: "obsidian" });
    });

    it("oauth-as: RFC 7009 form body naming the refresh token", async () => {
        respondWith(200, undefined);

        await revokeTokens(OAUTH_AS_PROFILE, AUTH);

        const sent = sentRequest(0);
        expect(sent.url).toBe("https://app.unabyss.com/oauth/token");
        expect(sent.contentType).toBe("application/x-www-form-urlencoded");
        expect(Object.fromEntries(new URLSearchParams(sent.body))).toEqual({
            token: "refresh-1",
            token_type_hint: "refresh_token",
            client_id: "obsidian",
        });
    });
});

describe("connect flow per dialect", () => {
    async function runConnect(discovery: { status: number; json: unknown }): Promise<{
        auth: AuthState;
        authorizeUrl: string;
    }> {
        const client = new OAuthClient();

        requestUrlMock.mockResolvedValueOnce({
            status: discovery.status,
            json: discovery.json,
            text: "",
        });
        const authorizeUrl = await client.beginAuthorize("https://unabyss.example");

        const state = new URL(authorizeUrl).searchParams.get("state") ?? "";
        const auth = await client.handleCallback({ code: "code-1", state });
        return { auth, authorizeUrl };
    }

    it("oauth-as: form-encoded code exchange, profile stamped into auth", async () => {
        const metadata = {
            authorization_endpoint: "https://unabyss.example/oauth/authorize",
            token_endpoint: "https://unabyss.example/oauth/token",
            revocation_endpoint: "https://unabyss.example/oauth/token",
        };
        const exchange = { access_token: "access-1", refresh_token: "refresh-1" };
        const me = { email: "user@example.com" };

        // discovery -> exchange -> users/me
        const pending = runConnect({ status: 200, json: metadata });
        respondWith(200, exchange);
        respondWith(200, me);
        const { auth, authorizeUrl } = await pending;

        expect(authorizeUrl.startsWith("https://unabyss.example/oauth/authorize?")).toBe(true);

        const sent = sentRequest(1);
        expect(sent.url).toBe("https://unabyss.example/oauth/token");
        expect(sent.contentType).toBe("application/x-www-form-urlencoded");
        const fields = Object.fromEntries(new URLSearchParams(sent.body));
        expect(fields.grant_type).toBe("authorization_code");
        expect(fields.code).toBe("code-1");
        expect(fields.client_id).toBe("obsidian");
        expect(fields.redirect_uri).toBe("obsidian://unabyss/auth-callback");
        expect(fields.code_verifier).toBeTruthy();

        expect(auth.backend?.mode).toBe("oauth-as");
        expect(auth.userEmail).toBe("user@example.com");
    });

    it("legacy: JSON code exchange against the Django token route", async () => {
        const exchange = { access_token: "access-1", refresh_token: "refresh-1" };

        // discovery 404 -> exchange -> users/me
        const pending = runConnect({ status: 404, json: undefined });
        respondWith(200, exchange);
        respondWith(200, { email: "user@example.com" });
        const { auth } = await pending;

        const sent = sentRequest(1);
        expect(sent.url).toBe("https://unabyss.example/api/oauth/token/");
        expect(sent.contentType).toBe("application/json");
        expect(JSON.parse(sent.body ?? "")).toMatchObject({
            grant_type: "authorization_code",
            code: "code-1",
            client_id: "obsidian",
        });
        expect(auth.backend?.mode).toBe("legacy");
    });

    it("a failed identity lookup no longer fails the connect", async () => {
        const pending = runConnect({ status: 404, json: undefined });
        respondWith(200, { access_token: "access-1", refresh_token: "refresh-1" });
        respondWith(500, undefined);
        const { auth } = await pending;

        expect(auth.accessToken).toBe("access-1");
        expect(auth.userEmail).toBe("");
    });
});

/**
 * Backend detection: the contract that keeps one plugin build working
 * against both Unabyss backends through the Cloudflare migration.
 *
 * The probe is `/.well-known/oauth-authorization-server`: the new app
 * publishes it, the legacy API host 404s it. Everything ambiguous -
 * network failure, HTML, metadata missing its endpoints - must resolve
 * to legacy, because that is the only backend that legitimately lacks
 * the metadata and a wrong "legacy" verdict against the new app fails
 * loudly at the next step instead of silently corrupting state.
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

import {
    deriveConsentUrl,
    discoverBackend,
    legacyBackendProfile,
    resolveBackendProfile,
} from "../src/backend";
import { AuthState, BackendProfile } from "../src/types";

const CF_METADATA = {
    issuer: "https://app.unabyss.com",
    authorization_endpoint: "https://app.unabyss.com/oauth/authorize",
    token_endpoint: "https://app.unabyss.com/oauth/token",
    registration_endpoint: "https://app.unabyss.com/oauth/register",
    revocation_endpoint: "https://app.unabyss.com/oauth/token",
    code_challenge_methods_supported: ["S256"],
};

function respondWith(status: number, json: unknown): void {
    requestUrlMock.mockResolvedValueOnce({ status, json, text: JSON.stringify(json) });
}

beforeEach(() => {
    requestUrlMock.mockReset();
});

describe("discoverBackend", () => {
    it("reads the OAuth-AS profile from published metadata", async () => {
        respondWith(200, CF_METADATA);

        const profile = await discoverBackend("https://app.unabyss.com");

        expect(requestUrlMock).toHaveBeenCalledWith(
            expect.objectContaining({
                url: "https://app.unabyss.com/.well-known/oauth-authorization-server",
            }),
        );
        expect(profile).toEqual<BackendProfile>({
            mode: "oauth-as",
            authorizationEndpoint: "https://app.unabyss.com/oauth/authorize",
            tokenEndpoint: "https://app.unabyss.com/oauth/token",
            // Refresh has no dedicated route in this dialect; it is a grant type.
            refreshEndpoint: "https://app.unabyss.com/oauth/token",
            // The new backend serves RFC 7009 on the token endpoint and says so.
            revocationEndpoint: "https://app.unabyss.com/oauth/token",
        });
    });

    it("falls back to the token endpoint when revocation is not advertised", async () => {
        respondWith(200, { ...CF_METADATA, revocation_endpoint: undefined });

        const profile = await discoverBackend("https://app.unabyss.com");

        expect(profile.revocationEndpoint).toBe("https://app.unabyss.com/oauth/token");
    });

    it("resolves the legacy profile on a 404 probe", async () => {
        respondWith(404, undefined);

        const profile = await discoverBackend("https://api.unabyss.com");

        expect(profile).toEqual(legacyBackendProfile("https://api.unabyss.com"));
        expect(profile).toEqual<BackendProfile>({
            mode: "legacy",
            // The consent page lives on the app host, not the API host.
            authorizationEndpoint: "https://app.unabyss.com/oauth/authorize",
            tokenEndpoint: "https://api.unabyss.com/api/oauth/token/",
            refreshEndpoint: "https://api.unabyss.com/api/auth/token/refresh/",
            revocationEndpoint: "https://api.unabyss.com/api/oauth/revoke/",
        });
    });

    it("treats a 200 without usable endpoints as legacy", async () => {
        respondWith(200, { issuer: "https://api.unabyss.com" });

        const profile = await discoverBackend("https://api.unabyss.com");

        expect(profile.mode).toBe("legacy");
    });

    it("treats endpoints that are not http(s) URLs as legacy", async () => {
        respondWith(200, {
            authorization_endpoint: "javascript:alert(1)",
            token_endpoint: "https://app.unabyss.com/oauth/token",
        });

        const profile = await discoverBackend("https://api.unabyss.com");

        expect(profile.mode).toBe("legacy");
    });

    it("treats a network failure as legacy", async () => {
        requestUrlMock.mockRejectedValueOnce(new Error("offline"));

        const profile = await discoverBackend("https://api.unabyss.com");

        expect(profile.mode).toBe("legacy");
    });

    it("normalizes a trailing slash off the base URL before probing", async () => {
        respondWith(404, undefined);

        await discoverBackend("https://api.unabyss.com/");

        expect(requestUrlMock).toHaveBeenCalledWith(
            expect.objectContaining({
                url: "https://api.unabyss.com/.well-known/oauth-authorization-server",
            }),
        );
    });
});

describe("resolveBackendProfile", () => {
    const storedProfile: BackendProfile = {
        mode: "oauth-as",
        authorizationEndpoint: "https://app.unabyss.com/oauth/authorize",
        tokenEndpoint: "https://app.unabyss.com/oauth/token",
        refreshEndpoint: "https://app.unabyss.com/oauth/token",
        revocationEndpoint: "https://app.unabyss.com/oauth/token",
    };

    it("prefers the profile stamped into the stored auth", () => {
        const auth: AuthState = {
            accessToken: "a",
            refreshToken: "r",
            userEmail: "",
            backend: storedProfile,
        };
        expect(resolveBackendProfile("https://api.unabyss.com", auth)).toBe(storedProfile);
    });

    it("treats auth persisted before dual-mode support as legacy tokens", () => {
        const auth: AuthState = { accessToken: "a", refreshToken: "r", userEmail: "" };
        expect(resolveBackendProfile("https://api.unabyss.com", auth).mode).toBe("legacy");
    });

    it("treats a signed-out state as legacy for the default host", () => {
        expect(resolveBackendProfile("https://api.unabyss.com", null).mode).toBe("legacy");
    });
});

describe("deriveConsentUrl", () => {
    it("rewrites the api. host to app. for the legacy consent page", () => {
        expect(deriveConsentUrl("https://api.unabyss.com")).toBe(
            "https://app.unabyss.com/oauth/authorize",
        );
    });

    it("keeps a single-origin host as-is", () => {
        expect(deriveConsentUrl("https://next.unabyss.com")).toBe(
            "https://next.unabyss.com/oauth/authorize",
        );
    });
});

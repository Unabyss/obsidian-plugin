/**
 * PKCE S256 round-trip: the challenge MUST equal
 * ``base64url(SHA-256(verifier))`` and the verifier MUST satisfy the
 * RFC-7636 character + length bounds.
 *
 * These guarantees are the smallest correctness contract the backend
 * checks at ``/api/oauth/token/``; a regression in the helper would
 * silently break every Connect attempt.
 */

import { createHash, webcrypto } from "node:crypto";

if (typeof globalThis.crypto === "undefined") {
    Object.defineProperty(globalThis, "crypto", { value: webcrypto, configurable: true });
}

import {
    base64UrlEncode,
    generatePkceVerifier,
    pkceChallenge,
} from "../src/oauth";

const PKCE_CHARSET = /^[A-Za-z0-9\-_]+$/u;

function expectedChallenge(verifier: string): string {
    const digest = createHash("sha256").update(verifier).digest();
    return base64UrlEncode(new Uint8Array(digest));
}

describe("oauth pkce helpers", () => {
    it("verifier is RFC-7636 character-safe and at least 43 chars", () => {
        const verifier = generatePkceVerifier();
        expect(verifier.length).toBeGreaterThanOrEqual(43);
        expect(verifier).toMatch(PKCE_CHARSET);
    });

    it("each call mints a fresh verifier", () => {
        const a = generatePkceVerifier();
        const b = generatePkceVerifier();
        expect(a).not.toEqual(b);
    });

    it("challenge equals base64url(SHA-256(verifier))", async () => {
        const verifier = generatePkceVerifier();
        const actual = await pkceChallenge(verifier);
        expect(actual).toEqual(expectedChallenge(verifier));
    });

    it("known-vector RFC-7636 Appendix B round-trips", async () => {
        const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
        const expected = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
        const actual = await pkceChallenge(verifier);
        expect(actual).toEqual(expected);
    });
});

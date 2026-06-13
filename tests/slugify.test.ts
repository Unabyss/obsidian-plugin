/**
 * Slug + collision-suffix policy for inbound exports.
 *
 * The slug rules are conservative (lowercase ASCII alphanumerics +
 * dashes only) so the resulting filename round-trips through
 * Obsidian's path normaliser regardless of host filesystem. The
 * collision suffix MUST be deterministic so a second pass against an
 * unchanged server state writes back to the same on-disk path.
 */

import {
    buildCollisionPath,
    collisionSuffixFor,
    slugifyTitle,
    trailerLineFor,
} from "../src/syncInbound";

describe("slugifyTitle", () => {
    it("lowercases and dashifies a typical title", () => {
        expect(slugifyTitle("Hello World")).toEqual("hello-world");
    });

    it("collapses sequences of non-alphanumeric chars into a single dash", () => {
        expect(slugifyTitle("Foo   ---   Bar / Baz!")).toEqual("foo-bar-baz");
    });

    it("strips diacritics by collapsing them into dashes (lossy)", () => {
        const slug = slugifyTitle("\u00e9diteur \u00e0 La Mode");
        expect(slug).toEqual("diteur-la-mode");
    });

    it("returns an empty string for all-punctuation titles", () => {
        expect(slugifyTitle("!!!---???")).toEqual("");
    });

    it("truncates very long titles to 80 chars", () => {
        const slug = slugifyTitle("a".repeat(120));
        expect(slug.length).toEqual(80);
    });
});

describe("collision suffix", () => {
    it("uses the first 6 hex chars of the uuid stripped of dashes", () => {
        expect(collisionSuffixFor("11111111-2222-3333-4444-555555555555")).toEqual("111111");
    });

    it("handles uuids that have already been stripped of dashes", () => {
        expect(collisionSuffixFor("abcdef0123456789")).toEqual("abcdef");
    });
});

describe("buildCollisionPath", () => {
    it("inserts the suffix before the .md extension", () => {
        const path = buildCollisionPath("Folder/hello-world.md", "11111111-2222-3333-4444-555555555555");
        expect(path).toEqual("Folder/hello-world-111111.md");
    });

    it("handles paths without a folder prefix", () => {
        const path = buildCollisionPath("alone.md", "deadbeef-aaaa-bbbb-cccc-dddddddddddd");
        expect(path).toEqual("alone-deadbe.md");
    });
});

describe("trailer line", () => {
    it("returns a stable comment that identifies the export uuid", () => {
        expect(trailerLineFor("uuid-123")).toEqual("<!-- unabyss-export-id: uuid-123 -->");
    });
});

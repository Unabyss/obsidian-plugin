/**
 * Filename + collision-suffix policy for inbound exports.
 *
 * The filename preserves the export title's casing and spacing,
 * rewriting only characters Obsidian / the host OS forbid in note
 * names, and caps the name at 70 characters on a whole-word boundary.
 * The collision suffix MUST be deterministic so a second pass against
 * an unchanged server state writes back to the same on-disk path.
 */

import {
    buildCollisionPath,
    collisionSuffixFor,
    filenameFromTitle,
    trailerLineFor,
} from "../src/syncInbound";

describe("filenameFromTitle", () => {
    it("preserves the casing and spacing of a typical title", () => {
        expect(filenameFromTitle("Hello World")).toEqual("Hello World");
    });

    it("rewrites illegal filename characters as spaces and collapses runs", () => {
        expect(filenameFromTitle("Foo   ---   Bar / Baz!")).toEqual("Foo --- Bar Baz!");
    });

    it("keeps non-ASCII letters intact", () => {
        expect(filenameFromTitle("\u00e9diteur \u00e0 La Mode")).toEqual(
            "\u00e9diteur \u00e0 La Mode",
        );
    });

    it("returns an empty string for a title made only of illegal chars", () => {
        expect(filenameFromTitle("///???")).toEqual("");
    });

    it("strips a leading dot so the file is not hidden", () => {
        expect(filenameFromTitle(".hidden")).toEqual("hidden");
    });

    it("truncates long titles at the last whole word within 70 chars", () => {
        const title = "The quick brown fox jumps over the lazy dog while the slow tortoise watches keenly";
        const name = filenameFromTitle(title);
        expect(name.length).toBeLessThanOrEqual(70);
        expect(name).toEqual(
            "The quick brown fox jumps over the lazy dog while the slow tortoise",
        );
    });

    it("hard-cuts a single word longer than 70 chars", () => {
        const name = filenameFromTitle("a".repeat(120));
        expect(name.length).toEqual(70);
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

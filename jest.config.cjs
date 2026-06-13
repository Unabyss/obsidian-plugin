/**
 * Jest configuration for the Unabyss Obsidian plugin's unit tests.
 *
 * Tests live under ``tests/`` and target the side-effect-free helpers
 * (PKCE, manifest cache, slug + collision policy, inbound watermark
 * advancement). Anything that touches the Obsidian runtime (the App,
 * Plugin lifecycle, Vault, requestUrl) is dependency-injected at the
 * call site so the tests never need a real Electron host.
 *
 * The ``obsidian`` module is mocked via the ``moduleNameMapper`` shim
 * in ``tests/__mocks__/obsidian.ts``.
 */
module.exports = {
    preset: "ts-jest",
    testEnvironment: "node",
    rootDir: ".",
    testMatch: ["<rootDir>/tests/**/*.test.ts"],
    moduleNameMapper: {
        "^obsidian$": "<rootDir>/tests/__mocks__/obsidian.ts",
    },
    transform: {
        "^.+\\.ts$": ["ts-jest", { tsconfig: "<rootDir>/tests/tsconfig.json" }],
    },
};

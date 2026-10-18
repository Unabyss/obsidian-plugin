/**
 * Classifying the server's one-import-per-vault refusal. A finalize 409
 * with ``import_in_progress`` means "busy, retry later", not a failure:
 * the plugin keeps the pass's uploads and schedules a retry.
 */

import { ApiError, isImportInProgressError } from "../src/apiClient";

const IN_PROGRESS_BODY = JSON.stringify({
    existing_import_id: "339b4138-e065-4e90-93ac-cc6fd8d4d8a0",
    error: { message: "An import is already running for this vault", code: "import_in_progress" },
});

describe("isImportInProgressError", () => {
    it("recognises the sync-finalize 409", () => {
        const err = new ApiError(409, "An import is already running for this vault", IN_PROGRESS_BODY);
        expect(isImportInProgressError(err)).toBe(true);
    });

    it("ignores other 409s and other statuses", () => {
        const otherCode = JSON.stringify({ error: { message: "x", code: "conflict" } });
        expect(isImportInProgressError(new ApiError(409, "x", otherCode))).toBe(false);
        expect(isImportInProgressError(new ApiError(409, "x", "<html>"))).toBe(false);
        expect(isImportInProgressError(new ApiError(503, "x", IN_PROGRESS_BODY))).toBe(false);
    });

    it("ignores errors that are not API errors", () => {
        expect(isImportInProgressError(new Error("An import is already running for this vault"))).toBe(false);
        expect(isImportInProgressError(undefined)).toBe(false);
    });
});

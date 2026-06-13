/**
 * Inbound sync engine (Unabyss -> Obsidian).
 *
 * Polls ``GET /api/exports/changed-since/?updated_after=<watermark>``,
 * paginates through the response set, and writes each row into the
 * user-configured ``exportTargetFolder`` as
 * ``<slugify(title)>.md``. The bottom of every written file carries a
 * stable trailer line ``<!-- unabyss-export-id: <uuid> -->`` so the
 * next sync can recognise a same-slug existing file as the same export
 * (idempotent overwrite) versus an unrelated user-authored note
 * (suffix-on-write with ``-<first-6-of-uuid>``).
 *
 * Delete behaviour per export ``is_deleted=true`` row is governed by
 * the per-user ``exportDeleteBehaviour`` setting:
 *
 *  - ``leave``  : do nothing (default; the on-disk file is treated as
 *                 the user's now-detached copy).
 *  - ``delete`` : trash the export file if we own it (trailer matches).
 *  - ``move``   : relocate the file into ``Deleted/`` underneath the
 *                 target folder. The trailer stays so a subsequent
 *                 restore can find it again.
 *
 * Watermark: ``updated_after`` advances **only** after a page is fully
 * applied. A mid-page failure leaves the watermark at the boundary of
 * the last fully-applied page so the next pass retries the same rows.
 */

import { App, normalizePath, TFile, TFolder, Vault } from "obsidian";
import { UnabyssApiClient } from "./apiClient";
import { ManifestCache } from "./manifestCache";
import { ProgressTracker } from "./progress";
import {
    DELETED_EXPORTS_SUBFOLDER,
    EXPORT_TRAILER_PREFIX,
    EXPORT_TRAILER_SUFFIX,
    ExportDeleteBehaviour,
    ExportRow,
    InboundFileOutcome,
    SyncInboundReport,
} from "./types";

const INBOUND_PAGE_SIZE = 100;
const FALLBACK_WATERMARK = "1970-01-01T00:00:00Z";

export interface InboundSyncDeps {
    app: App;
    api: UnabyssApiClient;
    cache: ManifestCache;
    targetFolder: string;
    deleteBehaviour: ExportDeleteBehaviour;
    progress?: ProgressTracker;
}

export async function runInboundSync(deps: InboundSyncDeps): Promise<SyncInboundReport> {
    const target = normalizePath(deps.targetFolder.trim());
    if (!target) {
        throw new Error("Pick a vault folder for incoming exports before running inbound sync.");
    }
    await ensureFolderExists(deps.app.vault, target);

    const report: SyncInboundReport = {
        polled: 0,
        written: 0,
        deleted: 0,
        moved: 0,
        skipped: 0,
        errors: [],
        watermarkAdvancedTo: deps.cache.getExportsWatermark() || FALLBACK_WATERMARK,
    };

    deps.progress?.start("Polling exports...", 0);

    let pageOffset = 0;
    let pageCount = 0;
    const watermarkInitial = deps.cache.getExportsWatermark() || FALLBACK_WATERMARK;
    while (true) {
        const page = await deps.api.getChangedExports(watermarkInitial, INBOUND_PAGE_SIZE, pageOffset);
        const rows = page.results ?? [];
        if (rows.length === 0) {
            break;
        }
        pageCount += 1;
        deps.progress?.report({
            label: `Polling page ${pageCount}...`,
            total: report.polled + rows.length,
        });

        let pageHighest = "";
        let pageFailed = false;
        for (const row of rows) {
            const outcome = await applyExportRow(deps, target, row);
            report.polled += 1;
            absorbOutcome(report, outcome);
            if (outcome.error) {
                pageFailed = true;
            }
            if (!outcome.error && row.updated_at > pageHighest) {
                pageHighest = row.updated_at;
            }
            deps.progress?.report({
                label: outcome.error ? `Error on ${row.title}` : `Synced "${row.title}"`,
                done: report.polled,
            });
        }

        if (!pageFailed && pageHighest) {
            deps.cache.setExportsWatermark(pageHighest);
            report.watermarkAdvancedTo = pageHighest;
            await deps.cache.flush();
        } else if (pageFailed) {
            break;
        }

        if (rows.length < INBOUND_PAGE_SIZE) {
            break;
        }
        pageOffset += INBOUND_PAGE_SIZE;
    }

    if (report.errors.length === 0) {
        deps.progress?.succeed(
            `Inbound done - ${report.written} written, ${report.deleted} deleted, ${report.moved} moved.`,
        );
    } else {
        deps.progress?.fail(`${report.errors.length} row(s) failed; will retry next sync.`);
    }
    return report;
}

async function applyExportRow(
    deps: InboundSyncDeps,
    targetFolder: string,
    row: ExportRow,
): Promise<InboundFileOutcome> {
    try {
        if (row.is_deleted) {
            return await applyDeletion(deps, targetFolder, row);
        }
        return await applyUpsert(deps, targetFolder, row);
    } catch (err) {
        return {
            exportId: row.id,
            title: row.title,
            vaultPath: "",
            action: "skipped",
            error: describeError(err),
        };
    }
}

async function applyUpsert(
    deps: InboundSyncDeps,
    targetFolder: string,
    row: ExportRow,
): Promise<InboundFileOutcome> {
    const baseSlug = slugifyTitle(row.title) || "untitled";
    const primaryPath = joinPath(targetFolder, `${baseSlug}.md`);
    const ownPath = await locateOwnedExport(deps.app.vault, targetFolder, row.id);
    const targetPath = ownPath ?? (await resolveCollisionPath(deps.app.vault, primaryPath, row.id));
    const body = appendTrailer(row.markdown, row.id);

    const existing = deps.app.vault.getAbstractFileByPath(targetPath);
    if (existing && existing instanceof TFile) {
        await deps.app.vault.modify(existing, body);
    } else {
        await deps.app.vault.create(targetPath, body);
    }
    return {
        exportId: row.id,
        title: row.title,
        vaultPath: targetPath,
        action: "written",
    };
}

async function applyDeletion(
    deps: InboundSyncDeps,
    targetFolder: string,
    row: ExportRow,
): Promise<InboundFileOutcome> {
    if (deps.deleteBehaviour === "leave") {
        return {
            exportId: row.id,
            title: row.title,
            vaultPath: "",
            action: "skipped",
        };
    }
    const ownPath = await locateOwnedExport(deps.app.vault, targetFolder, row.id);
    if (!ownPath) {
        return {
            exportId: row.id,
            title: row.title,
            vaultPath: "",
            action: "skipped",
        };
    }
    const existing = deps.app.vault.getAbstractFileByPath(ownPath);
    if (!(existing instanceof TFile)) {
        return {
            exportId: row.id,
            title: row.title,
            vaultPath: ownPath,
            action: "skipped",
        };
    }
    if (deps.deleteBehaviour === "delete") {
        await deps.app.vault.trash(existing, true);
        return {
            exportId: row.id,
            title: row.title,
            vaultPath: ownPath,
            action: "deleted",
        };
    }
    const trashFolder = joinPath(targetFolder, DELETED_EXPORTS_SUBFOLDER);
    await ensureFolderExists(deps.app.vault, trashFolder);
    const movedPath = await resolveCollisionPath(
        deps.app.vault,
        joinPath(trashFolder, existing.name),
        row.id,
    );
    await deps.app.fileManager.renameFile(existing, movedPath);
    return {
        exportId: row.id,
        title: row.title,
        vaultPath: movedPath,
        action: "moved",
    };
}

function absorbOutcome(report: SyncInboundReport, outcome: InboundFileOutcome): void {
    switch (outcome.action) {
        case "written":
            report.written += 1;
            break;
        case "deleted":
            report.deleted += 1;
            break;
        case "moved":
            report.moved += 1;
            break;
        case "skipped":
            report.skipped += 1;
            break;
    }
    if (outcome.error) {
        report.errors.push(outcome);
    }
}

/**
 * Walk the export target folder (and the optional ``Deleted/``
 * subfolder) looking for a file whose body carries this export's
 * trailer. The lookup is O(N-files-in-target-folder), bounded by what
 * a user would realistically put there.
 */
async function locateOwnedExport(
    vault: Vault,
    targetFolder: string,
    exportId: string,
): Promise<string | null> {
    const folders = [targetFolder, joinPath(targetFolder, DELETED_EXPORTS_SUBFOLDER)];
    const trailer = trailerLineFor(exportId);
    for (const folder of folders) {
        const node = vault.getAbstractFileByPath(folder);
        if (!(node instanceof TFolder)) {
            continue;
        }
        for (const child of node.children) {
            if (!(child instanceof TFile) || child.extension !== "md") {
                continue;
            }
            const text = await vault.cachedRead(child);
            if (text.includes(trailer)) {
                return child.path;
            }
        }
    }
    return null;
}

function appendTrailer(body: string, exportId: string): string {
    const trailer = trailerLineFor(exportId);
    const trimmed = body.replace(/\s+$/u, "");
    return `${trimmed}\n\n${trailer}\n`;
}

export function trailerLineFor(exportId: string): string {
    return `${EXPORT_TRAILER_PREFIX} ${exportId} ${EXPORT_TRAILER_SUFFIX}`;
}

/**
 * Slugify an export title for use as a filename.
 *
 * Rules (kept simple to avoid pulling in a runtime dependency):
 *
 *  - Lowercase ASCII alphanumerics and dashes.
 *  - Non-ASCII letters and punctuation collapse to dashes.
 *  - Repeated dashes collapse to one; leading / trailing dashes drop.
 *  - Truncate to 80 characters so the final ``<slug>-<suffix>.md`` path
 *    fits comfortably inside Obsidian's ``normalizePath`` limit.
 */
export function slugifyTitle(title: string): string {
    const lowered = title.toLowerCase();
    const stripped = lowered.replace(/[^a-z0-9]+/gu, "-");
    const collapsed = stripped.replace(/-+/gu, "-").replace(/^-|-$/gu, "");
    return collapsed.slice(0, 80);
}

/**
 * Suffix policy for slug collisions.
 *
 * The collision target is "a different file already exists at this
 * vault-relative path that doesn't carry our trailer". The plugin
 * appends ``-<first-6-of-uuid>`` to the slug body (before ``.md``)
 * and rechecks. With 16^6 = ~16M possible suffixes and a slug that
 * already differs by title, a second collision is statistically
 * negligible; the function falls back to a UUID-only filename in the
 * pathological case rather than looping.
 */
export function buildCollisionPath(primaryPath: string, exportId: string): string {
    const ext = ".md";
    const dotIndex = primaryPath.lastIndexOf(".");
    const body = dotIndex === -1 ? primaryPath : primaryPath.slice(0, dotIndex);
    const suffix = collisionSuffixFor(exportId);
    return `${body}-${suffix}${ext}`;
}

export function collisionSuffixFor(exportId: string): string {
    const stripped = exportId.replace(/-/gu, "");
    return stripped.slice(0, 6) || exportId.slice(0, 6);
}

async function resolveCollisionPath(
    vault: Vault,
    desiredPath: string,
    exportId: string,
): Promise<string> {
    if (!vault.getAbstractFileByPath(desiredPath)) {
        return desiredPath;
    }
    const candidate = buildCollisionPath(desiredPath, exportId);
    if (!vault.getAbstractFileByPath(candidate)) {
        return candidate;
    }
    const ext = ".md";
    const dotIndex = candidate.lastIndexOf(".");
    const body = dotIndex === -1 ? candidate : candidate.slice(0, dotIndex);
    return `${body}-${exportId.slice(0, 8)}${ext}`;
}

function joinPath(folder: string, name: string): string {
    if (!folder || folder === "/") {
        return normalizePath(name);
    }
    return normalizePath(`${folder.replace(/\/$/u, "")}/${name}`);
}

async function ensureFolderExists(vault: Vault, folder: string): Promise<void> {
    if (!folder) {
        return;
    }
    const existing = vault.getAbstractFileByPath(folder);
    if (existing instanceof TFolder) {
        return;
    }
    if (existing) {
        throw new Error(`Inbound target "${folder}" exists but is not a folder.`);
    }
    await vault.createFolder(folder);
}

function describeError(err: unknown): string {
    if (err instanceof Error) {
        return err.message;
    }
    return String(err);
}

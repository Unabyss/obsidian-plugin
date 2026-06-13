/**
 * Minimal per-direction progress observable shared by the sync engines
 * and the settings tab.
 *
 * Each direction owns one {@link ProgressTracker} instance. The settings
 * tab subscribes to render live "uploaded / written" counters; the sync
 * engines call {@link ProgressTracker.report} as they advance. Reset on
 * each new pass so the indicator reflects the current run only.
 *
 * No third-party reactive primitive - a pub/sub of unknown size is
 * overkill for two consumers (settings tab + status notice). A flat
 * listener list plus an immutable snapshot is enough.
 */

export type SyncDirection = "outbound" | "inbound";

export type SyncPhase = "idle" | "running" | "ok" | "error";

export interface ProgressSnapshot {
    direction: SyncDirection;
    phase: SyncPhase;
    /** Total items planned for this pass (notes scanned / exports paged). */
    total: number;
    /** Items finalised so far. */
    done: number;
    /** Free-form status line ("Uploading bodies", "Polling page 3"). */
    label: string;
    /** Last error message when ``phase === "error"``. */
    error: string;
    /** Wall-clock of the last update. */
    updatedAt: number;
}

export type ProgressListener = (snapshot: ProgressSnapshot) => void;

const INITIAL_LABELS: Record<SyncDirection, string> = {
    outbound: "Idle.",
    inbound: "Idle.",
};

export class ProgressTracker {
    private snapshot: ProgressSnapshot;
    private readonly listeners = new Set<ProgressListener>();

    constructor(direction: SyncDirection) {
        this.snapshot = {
            direction,
            phase: "idle",
            total: 0,
            done: 0,
            label: INITIAL_LABELS[direction],
            error: "",
            updatedAt: Date.now(),
        };
    }

    get value(): ProgressSnapshot {
        return this.snapshot;
    }

    subscribe(listener: ProgressListener): () => void {
        this.listeners.add(listener);
        listener(this.snapshot);
        return () => {
            this.listeners.delete(listener);
        };
    }

    /**
     * Mark this direction as actively syncing and zero the counters.
     * Callers pass an initial label and (when known up-front) a total.
     */
    start(label: string, total = 0): void {
        this.update({
            phase: "running",
            label,
            total,
            done: 0,
            error: "",
        });
    }

    report(delta: Partial<Pick<ProgressSnapshot, "label" | "total" | "done">>): void {
        this.update(delta);
    }

    succeed(label: string): void {
        this.update({
            phase: "ok",
            label,
            error: "",
        });
    }

    fail(error: string): void {
        this.update({
            phase: "error",
            label: "Failed.",
            error,
        });
    }

    /**
     * Reset to the idle phase. Called when the user disables a direction
     * so stale "Synced X notes" labels don't keep showing.
     */
    reset(): void {
        this.snapshot = {
            ...this.snapshot,
            phase: "idle",
            label: INITIAL_LABELS[this.snapshot.direction],
            total: 0,
            done: 0,
            error: "",
            updatedAt: Date.now(),
        };
        this.emit();
    }

    private update(delta: Partial<ProgressSnapshot>): void {
        this.snapshot = {
            ...this.snapshot,
            ...delta,
            updatedAt: Date.now(),
        };
        this.emit();
    }

    private emit(): void {
        for (const listener of this.listeners) {
            listener(this.snapshot);
        }
    }
}

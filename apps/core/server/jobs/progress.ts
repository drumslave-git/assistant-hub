/**
 * Live intra-run progress for a background job — the "what it does right now"
 * channel shared by both scheduler primitives ({@link import("./idle-scheduler")}
 * and {@link import("./interval-scheduler")}).
 *
 * A pure type module (no `server-only`, no runtime): the schedulers set it from
 * the job body and the Jobs dashboard reads it, so a Client Component can
 * `import type` it. It is transient — it lives only in the scheduler singleton
 * for the duration of a run and is cleared back to `null` when the run settles.
 */

export interface JobProgress {
  /** Human "what it does now", e.g. "Describing photo" or "Consolidating user". */
  step: string;
  /** 1-based index of the item being worked on, when the run is a countable loop. */
  current?: number;
  /** Total items this run will process. Omit for indeterminate work. */
  total?: number;
}

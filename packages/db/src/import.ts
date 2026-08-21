import { Pool } from "pg";

/**
 * Plumbing shared by the one-shot v1-split import scripts
 * (`apps/core/store/import` and `apps/tg/store/import`): pools, batched
 * keyset copying, multi-row inserts, and the count-reconciliation report
 * PLAN.md's migration section requires after every rehearsal and at cutover.
 *
 * Deliberately NOT exported from the package root: the root is server-only
 * (app runtime); this subpath (`@assistant-hub/db/import`) runs in plain
 * Node via tsx. The per-table SQL stays in each app's script — explicit
 * column lists beat a clever generic copier for a one-shot tool whose only
 * job is to be verifiably right.
 */

/** Open source (v1) and target pools, run `fn`, always close both. */
export async function withPools<T>(
  v1Url: string,
  targetUrl: string,
  fn: (v1: Pool, target: Pool) => Promise<T>,
): Promise<T> {
  const v1 = new Pool({ connectionString: v1Url });
  const target = new Pool({ connectionString: targetUrl });
  try {
    return await fn(v1, target);
  } finally {
    await Promise.allSettled([v1.end(), target.end()]);
  }
}

/** `SELECT count(*)` with optional WHERE params. */
export async function countRows(pool: Pool, sql: string, values: unknown[] = []): Promise<number> {
  const res = await pool.query(sql, values);
  return Number(res.rows[0].count);
}

/**
 * Refuse to import into a store that already holds data — a rehearsal target
 * is created fresh every run, and a partially-filled target would make every
 * count reconciliation a lie.
 */
export async function requireEmptyTarget(target: Pool, tables: string[]): Promise<void> {
  for (const table of tables) {
    const n = await countRows(target, `SELECT count(*) AS count FROM "${table}"`);
    if (n > 0) {
      throw new Error(
        `target table "${table}" already holds ${n} row(s) — refusing to import. ` +
          `Drop and recreate the target database, then re-run.`,
      );
    }
  }
}

/** One page of a keyset scan: the query for a cursor position. */
export interface KeysetPage {
  text: string;
  values: unknown[];
}

/**
 * Copy a table in keyset batches: `page(cursor)` returns the SELECT for the
 * next batch (cursor = last row of the previous batch, null on the first),
 * `write(rows)` inserts it. Returns rows copied. Keyset, not OFFSET, so a
 * large mirror copies in O(n).
 */
export async function keysetCopy<Row extends Record<string, unknown>>(opts: {
  from: Pool;
  page: (cursor: Row | null) => KeysetPage;
  write: (rows: Row[]) => Promise<void>;
}): Promise<number> {
  let cursor: Row | null = null;
  let copied = 0;
  for (;;) {
    const { text, values } = opts.page(cursor);
    const res = await opts.from.query(text, values);
    const rows = res.rows as Row[];
    if (rows.length === 0) return copied;
    await opts.write(rows);
    copied += rows.length;
    cursor = rows[rows.length - 1];
  }
}

/**
 * Multi-row `INSERT INTO table (columns) VALUES ...`. `casts` appends an
 * explicit cast to a column's placeholders (`{ embedding: "::vector" }`) —
 * how vector and array payloads read from one database land typed in the
 * other. `overridingSystemValue` preserves identity ids verbatim.
 */
export async function insertBatch(
  pool: Pool,
  opts: {
    table: string;
    columns: string[];
    rows: unknown[][];
    casts?: Record<string, string>;
    overridingSystemValue?: boolean;
  },
): Promise<void> {
  if (opts.rows.length === 0) return;
  const cols = opts.columns.map((c) => `"${c}"`).join(", ");
  let p = 0;
  const tuples = opts.rows
    .map(
      (row) =>
        `(${opts.columns
          .map((col) => {
            p += 1;
            return `$${p}${opts.casts?.[col] ?? ""}`;
          })
          .join(", ")})`,
    )
    .join(", ");
  const overriding = opts.overridingSystemValue ? "OVERRIDING SYSTEM VALUE " : "";
  await pool.query(
    `INSERT INTO "${opts.table}" (${cols}) ${overriding}VALUES ${tuples}`,
    opts.rows.flat(),
  );
}

/**
 * After an identity-preserving copy, advance the identity sequence past the
 * copied ids so future inserts never collide.
 */
export async function syncIdentitySequence(pool: Pool, table: string, column = "id"): Promise<void> {
  await pool.query(
    `SELECT setval(pg_get_serial_sequence('"${table}"', '${column}'), ` +
      `(SELECT COALESCE(MAX("${column}"), 0) FROM "${table}"), true)`,
  );
}

/** One line of the reconciliation report. */
export interface CountPair {
  label: string;
  source: number;
  target: number;
}

/**
 * The verification harness's output: per-table-pair counts plus free-form
 * spot-check notes. `ok` only when every pair matches and no failure was
 * noted — the CLI exits non-zero otherwise.
 */
export class ImportReport {
  private pairs: CountPair[] = [];
  private notes: string[] = [];
  private failures: string[] = [];

  count(label: string, source: number, target: number): void {
    this.pairs.push({ label, source, target });
  }

  note(message: string): void {
    this.notes.push(message);
  }

  fail(message: string): void {
    this.failures.push(message);
  }

  /** Assert a spot check; a false condition records a failure, never throws. */
  check(condition: boolean, message: string): void {
    if (condition) {
      this.notes.push(`ok: ${message}`);
    } else {
      this.failures.push(`FAILED: ${message}`);
    }
  }

  get ok(): boolean {
    return this.failures.length === 0 && this.pairs.every((p) => p.source === p.target);
  }

  render(): string {
    const width = Math.max(20, ...this.pairs.map((p) => p.label.length));
    const lines = [
      "── row-count reconciliation ──",
      ...this.pairs.map((p) => {
        const status = p.source === p.target ? "ok" : "MISMATCH";
        return `${p.label.padEnd(width)}  source=${p.source}  target=${p.target}  ${status}`;
      }),
      "── spot checks ──",
      ...this.notes,
      ...this.failures,
      this.ok ? "VERIFICATION PASSED" : "VERIFICATION FAILED",
    ];
    return lines.join("\n");
  }
}

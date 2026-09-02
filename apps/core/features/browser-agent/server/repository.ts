import "server-only";

import { and, asc, desc, eq, sql } from "drizzle-orm";

import type { StoreDb } from "@/server/store/db";
import {
  browserAgentRuns,
  browserRunScreenshots,
  type BrowserAgentRunRow,
} from "../../../store/schema";

import type {
  BrowserAgentRun,
  BrowserAgentRunDetail,
  BrowserDownloadRecord,
  BrowserRunStatus,
  BrowserRunStep,
} from "../types";
import { getLiveState } from "./live-state";

/**
 * Typed persistence for browser-agent runs and their screenshots. Pure data
 * access — no policy, no browser, no trace recording (the service/runner own
 * those). Every function takes a {@link StoreDb} so it runs against the pool or
 * a test instance.
 */

/** Columns an enqueue sets. */
export interface InsertBrowserAgentRun {
  chatRef: string | null;
  threadId: number | null;
  createdByUserRef: string | null;
  isOwner: boolean;
  restricted: boolean;
  sourceUrls: string[];
  goal: string;
}

function mapRow(row: BrowserAgentRunRow): BrowserAgentRun {
  return {
    id: row.id,
    chatRef: row.chatRef,
    threadId: row.threadId,
    createdByUserRef: row.createdByUserRef,
    isOwner: row.isOwner,
    restricted: row.restricted,
    sourceUrls: row.sourceUrls ?? [],
    goal: row.goal,
    status: row.status as BrowserRunStatus,
    report: row.report,
    error: row.error,
    steps: row.steps,
    // The stored shape is looser than the client type: pre-2026-07-29 rows carry
    // `inline` and no `deliveredToChat`, which normalizes to false — accurate, since
    // every download of that era was kept on disk.
    downloads: (row.downloads ?? []).map((d) => ({
      sourceUrl: d.sourceUrl,
      filename: d.filename,
      sizeBytes: d.sizeBytes,
      deliveredToChat: d.deliveredToChat === true,
      ...(d.discarded === true ? { discarded: true } : {}),
    })),
    traceId: row.traceId,
    createdAt: row.createdAt.toISOString(),
    startedAt: row.startedAt?.toISOString() ?? null,
    finishedAt: row.finishedAt?.toISOString() ?? null,
  };
}

/** All runs (optionally scoped to one chat), newest first. */
export async function listBrowserAgentRuns(
  db: StoreDb,
  chatRef?: string,
): Promise<BrowserAgentRun[]> {
  const rows = await db.query.browserAgentRuns.findMany({
    where: chatRef ? eq(browserAgentRuns.chatRef, chatRef) : undefined,
    orderBy: [desc(browserAgentRuns.createdAt)],
  });
  return rows.map(mapRow);
}

/** One run by id, or null. */
export async function getBrowserAgentRun(
  db: StoreDb,
  id: string,
): Promise<BrowserAgentRun | null> {
  const row = await db.query.browserAgentRuns.findFirst({
    where: eq(browserAgentRuns.id, id),
  });
  return row ? mapRow(row) : null;
}

/** One run plus its activity feed, screenshot seqs, and live state, or null. */
export async function getBrowserAgentRunDetail(
  db: StoreDb,
  id: string,
): Promise<BrowserAgentRunDetail | null> {
  const row = await db.query.browserAgentRuns.findFirst({ where: eq(browserAgentRuns.id, id) });
  if (!row) return null;
  const run = mapRow(row);
  const shots = await db
    .select({ seq: browserRunScreenshots.seq })
    .from(browserRunScreenshots)
    .where(eq(browserRunScreenshots.runId, id))
    .orderBy(asc(browserRunScreenshots.seq));
  return {
    ...run,
    // `seq` is presentational, derived from stored order (1-based).
    activity: (row.activity ?? []).map((s, i): BrowserRunStep => ({ ...s, seq: i + 1 })),
    screenshotSeqs: shots.map((s) => s.seq),
    // Live state only makes sense while the run is in flight.
    live: run.status === "running" ? getLiveState(id) : null,
  };
}

/** Append one completed action to a run's activity feed. Returns the new length (seq). */
export async function appendBrowserRunStep(
  db: StoreDb,
  runId: string,
  step: Omit<BrowserRunStep, "seq">,
): Promise<void> {
  await db
    .update(browserAgentRuns)
    .set({
      activity: sql`${browserAgentRuns.activity} || ${JSON.stringify([step])}::jsonb`,
      steps: sql`${browserAgentRuns.steps} + 1`,
    })
    .where(eq(browserAgentRuns.id, runId));
}

/** Insert a queued run with an app-generated id. Returns the stored record. */
export async function insertBrowserAgentRun(
  db: StoreDb,
  id: string,
  values: InsertBrowserAgentRun,
): Promise<BrowserAgentRun> {
  const [row] = await db
    .insert(browserAgentRuns)
    .values({
      id,
      chatRef: values.chatRef,
      threadId: values.threadId,
      createdByUserRef: values.createdByUserRef,
      isOwner: values.isOwner,
      restricted: values.restricted,
      sourceUrls: values.sourceUrls,
      goal: values.goal,
      status: "queued",
    })
    .returning();
  return mapRow(row);
}

/** Queued runs, oldest-first — the runner's work queue. */
export async function listQueuedBrowserAgentRuns(db: StoreDb): Promise<BrowserAgentRun[]> {
  const rows = await db
    .select()
    .from(browserAgentRuns)
    .where(eq(browserAgentRuns.status, "queued"))
    .orderBy(asc(browserAgentRuns.createdAt));
  return rows.map(mapRow);
}

/**
 * Claim a queued run for execution: flip it to `running` and stamp `started_at`,
 * but only if it is still `queued`. Returns the claimed run, or null when another
 * worker (or a redeploy) already took it — the atomic guard against double-run.
 */
export async function claimBrowserAgentRun(
  db: StoreDb,
  id: string,
): Promise<BrowserAgentRun | null> {
  const [row] = await db
    .update(browserAgentRuns)
    .set({ status: "running", startedAt: new Date(), traceId: null })
    .where(and(eq(browserAgentRuns.id, id), eq(browserAgentRuns.status, "queued")))
    .returning();
  return row ? mapRow(row) : null;
}

/** Attach the execution trace id to a running run (for Debug drill-down). */
export async function setBrowserAgentRunTrace(
  db: StoreDb,
  id: string,
  traceId: string,
): Promise<void> {
  await db.update(browserAgentRuns).set({ traceId }).where(eq(browserAgentRuns.id, id));
}

/**
 * Settle a run as done or failed with its report/error and downloads. `steps` is
 * owned by {@link appendBrowserRunStep} (incremented per completed action), so it
 * is deliberately not written here — the count already reflects every step.
 */
export async function settleBrowserAgentRun(
  db: StoreDb,
  id: string,
  input: {
    status: Extract<BrowserRunStatus, "done" | "failed">;
    report?: string | null;
    error?: string | null;
    downloads: BrowserDownloadRecord[];
  },
): Promise<void> {
  await db
    .update(browserAgentRuns)
    .set({
      status: input.status,
      report: input.report ?? null,
      error: input.error ?? null,
      downloads: input.downloads,
      finishedAt: new Date(),
    })
    .where(eq(browserAgentRuns.id, id));
}

/**
 * Fail any run left `running` from a previous process (a crash/redeploy mid-run).
 * Called once at startup so a dead run never blocks the dashboard as "running"
 * forever. Returns how many were reset.
 */
export async function failStaleRunningRuns(db: StoreDb): Promise<number> {
  const rows = await db
    .update(browserAgentRuns)
    .set({
      status: "failed",
      error: "Interrupted by a server restart",
      finishedAt: new Date(),
    })
    .where(eq(browserAgentRuns.status, "running"))
    .returning({ id: browserAgentRuns.id });
  return rows.length;
}

/** Store one screenshot's bytes at the given capture sequence. */
export async function insertBrowserRunScreenshot(
  db: StoreDb,
  input: { runId: string; seq: number; url: string | null; title: string | null; data: Buffer },
): Promise<void> {
  await db.insert(browserRunScreenshots).values({
    runId: input.runId,
    seq: input.seq,
    url: input.url,
    title: input.title,
    data: input.data,
  });
}

/** One screenshot's bytes by (run, seq), or null. */
export async function getBrowserRunScreenshot(
  db: StoreDb,
  runId: string,
  seq: number,
): Promise<Buffer | null> {
  const row = await db.query.browserRunScreenshots.findFirst({
    where: and(eq(browserRunScreenshots.runId, runId), eq(browserRunScreenshots.seq, seq)),
    columns: { data: true },
  });
  return row?.data ?? null;
}

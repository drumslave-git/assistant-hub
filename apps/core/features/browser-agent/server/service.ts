import "server-only";

import { randomUUID } from "node:crypto";

import { getStoreDb, type StoreDb } from "@/server/store/db";

import type { BrowserAgentRun, BrowserAgentRunDetail } from "../types";
import {
  getBrowserAgentRunDetail,
  insertBrowserAgentRun,
  listBrowserAgentRuns,
  type InsertBrowserAgentRun,
} from "./repository";

/**
 * Browser-agent domain service — the boundary the MCP tool, the dashboard Server
 * Components, and the Route Handlers call. It owns enqueuing (the run row is the
 * queue) and reads; the runner (`runner.ts`) owns execution. Tracing lives in the
 * runner, where the work actually happens — enqueuing is a plain insert.
 */

/** Input to enqueue a run (chat-bound from a tool, or chat-less from the dashboard). */
export interface EnqueueBrowserRunInput {
  goal: string;
  chatRef: string | null;
  threadId?: number | null;
  createdByUserRef?: string | null;
  isOwner: boolean;
  /** Rule-driven group run, or rights lent to a non-owner (default false). */
  restricted?: boolean;
  /** Verbatim URLs of the triggering message (default none). */
  sourceUrls?: string[];
}

/**
 * Enqueue a browsing run. Returns the stored `queued` record; the caller signals
 * the runner to pick it up (so this stays a pure DB write, testable without the
 * runner singleton).
 */
export async function enqueueBrowserRun(
  input: EnqueueBrowserRunInput,
  db: StoreDb = getStoreDb(),
): Promise<BrowserAgentRun> {
  const values: InsertBrowserAgentRun = {
    chatRef: input.chatRef,
    threadId: input.threadId ?? null,
    createdByUserRef: input.createdByUserRef ?? null,
    isOwner: input.isOwner,
    restricted: input.restricted ?? false,
    sourceUrls: input.sourceUrls ?? [],
    goal: input.goal.trim(),
  };
  return insertBrowserAgentRun(db, randomUUID(), values);
}

/** All runs (optionally chat-scoped), newest first — for the dashboard. */
export async function getBrowserAgentRuns(
  chatRef?: string,
  db: StoreDb = getStoreDb(),
): Promise<BrowserAgentRun[]> {
  return listBrowserAgentRuns(db, chatRef);
}

/** One run plus its screenshot sequence numbers, or null. */
export async function getBrowserAgentRunView(
  id: string,
  db: StoreDb = getStoreDb(),
): Promise<BrowserAgentRunDetail | null> {
  return getBrowserAgentRunDetail(db, id);
}

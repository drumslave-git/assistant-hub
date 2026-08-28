import "server-only";

import { ApiError } from "@/lib/api-error";
import { FEATURES } from "@/lib/features";
import type { TraceTrigger } from "@/lib/trace";
import { listRemoteTools } from "@/server/mcp/http-client";
import { publishEvent } from "@/server/realtime/hub";
import { getStoreDb, type StoreDb } from "@/server/store/db";
import { withTrace } from "@/server/trace";
import { describeDiff, diffToolsets, hasDrift, type ToolsetDiff } from "./diff";
import {
  getToolConnectionById,
  recordDiscovery,
  replaceSnapshot,
  type ToolConnectionRecord,
} from "./repository";
import { appliedTools, toClient } from "./service";
import type { ToolConnection } from "./schema";

/**
 * Discovery and apply — the two halves of "the offered toolset changes only
 * on operator command" (user decision, 2026-08-28).
 *
 * Discovery asks the remote server what it offers and stores the ANSWER,
 * diffed against the applied snapshot. It never edits what the model sees:
 * a server that renamed a tool mid-conversation would break the prompt's
 * prefix cache and, on a strict provider, 400 the whole request.
 *
 * Apply writes the snapshot from the discovery the operator reviewed —
 * deliberately not from a fresh fetch, so what is applied is what was on
 * screen when the button was pressed.
 */

const FEATURE = FEATURES["tool-connections"];

/** The outcome of one discovery run, as returned to the dashboard. */
export interface DiscoveryReport {
  connectionId: string;
  ok: boolean;
  /** Why discovery failed, or null. */
  error: string | null;
  /** The connection as it now reads (including the stored discovery). */
  connection: ToolConnection;
  /** What the discovery saw against what is applied; null when it failed. */
  diff: ToolsetDiff | null;
}

async function reload(db: StoreDb, id: string): Promise<ToolConnectionRecord> {
  const record = await getToolConnectionById(db, id);
  if (!record) throw ApiError.notFound("Unknown tool connection");
  return record;
}

/**
 * Ask a connection's server what it offers, store the answer, and report the
 * drift. A failure is an outcome, not an exception: the operator asked a
 * question and "the server did not answer, here is what it said" IS the
 * answer — so the report comes back with `ok: false` while the trace settles
 * as failed and the reason is persisted on the row for the dashboard.
 */
export async function discoverToolConnection(
  id: string,
  trigger: TraceTrigger,
  db: StoreDb = getStoreDb(),
): Promise<DiscoveryReport> {
  return withTrace(
    { feature: FEATURE.id, action: "discover", trigger, inputSummary: `connection ${id}` },
    async (trace) => {
      const record = await reload(db, id);
      trace.relate(FEATURE.relatedIdsKey, [id]);
      await trace.event({
        type: "input",
        message: `discover tools of "${record.name}"`,
        data: { endpointUrl: record.endpointUrl, transport: record.transport },
      });
      if (record.transport !== "http") {
        throw ApiError.badRequest("Only http connections can be discovered in this version");
      }

      let discovered;
      try {
        discovered = await listRemoteTools(record);
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        await recordDiscovery(db, id, { at: record.lastDiscoveredAt ? new Date(record.lastDiscoveredAt) : null, error });
        await trace.event({
          type: "external_call",
          level: "error",
          message: "discovery failed — the applied toolset is untouched",
          data: { error },
        });
        await trace.fail(err, { outputSummary: "discovery failed" });
        publishEvent(FEATURE.realtimeTopic!);
        return {
          connectionId: id,
          ok: false,
          error,
          connection: toClient(await reload(db, id)),
          diff: null,
        };
      }

      await recordDiscovery(db, id, { at: new Date(), error: null, tools: discovered });
      const diff = diffToolsets(appliedTools(record), discovered);
      await trace.event({
        type: "external_call",
        message: `server offers ${discovered.length} tools — ${describeDiff(diff)}`,
        data: { diff, tools: discovered },
      });
      await trace.event({
        type: "step",
        message: hasDrift(diff)
          ? "stored for review — the model is still offered the applied snapshot"
          : "no drift — the applied snapshot already matches",
      });
      await trace.succeed({ outputSummary: describeDiff(diff) });
      publishEvent(FEATURE.realtimeTopic!);
      return {
        connectionId: id,
        ok: true,
        error: null,
        connection: toClient(await reload(db, id)),
        diff,
      };
    },
  );
}

/**
 * Make the reviewed discovery the offered toolset. This is the ONLY write
 * that changes what the model can call, which is why it takes no arguments
 * beyond the connection: there is nothing to choose, only to confirm.
 */
export async function applyToolConnection(
  id: string,
  trigger: TraceTrigger,
  db: StoreDb = getStoreDb(),
): Promise<ToolConnection> {
  return withTrace(
    { feature: FEATURE.id, action: "apply", trigger, inputSummary: `connection ${id}` },
    async (trace) => {
      const record = await reload(db, id);
      trace.relate(FEATURE.relatedIdsKey, [id]);
      const discovered = record.discoveredTools;
      if (!discovered) {
        throw ApiError.badRequest("Discover this connection's tools before applying them");
      }
      const diff = diffToolsets(appliedTools(record), discovered);
      await trace.event({
        type: "input",
        message: `apply ${discovered.length} tools to "${record.name}" — ${describeDiff(diff)}`,
        data: { diff },
      });
      await replaceSnapshot(db, id, discovered);
      await trace.event({
        type: "db",
        message: "snapshot applied — the model is offered this set from the next turn",
      });
      await trace.succeed({ outputSummary: describeDiff(diff) });
      publishEvent(FEATURE.realtimeTopic!);
      return toClient(await reload(db, id));
    },
  );
}

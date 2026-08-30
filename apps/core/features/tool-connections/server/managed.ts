import "server-only";

import { randomUUID } from "node:crypto";

import type { SourceId } from "@assistant-hub/contracts";

import { FEATURES } from "@/lib/features";
import type { TraceTrigger } from "@/lib/trace";
import { INTERNAL_TOKEN_HEADER } from "@assistant-hub/service";
import { publishEvent } from "@/server/realtime/hub";
import { getEnv } from "@/server/env";
import { getTransport } from "@/server/transports/service";
import { directorySourceLabel } from "@/server/source/directory";
import { getStoreDb, type StoreDb } from "@/server/store/db";
import { withTrace } from "@/server/trace";
import type { TraceRecorder } from "@/server/trace/recorder";
import { listRemoteTools } from "@/server/mcp/http-client";
import { describeDiff, diffToolsets } from "./diff";
import {
  getToolConnectionBySlug,
  insertToolConnection,
  recordDiscovery,
  replaceSnapshot,
  updateToolConnection,
  type ToolConnectionRecord,
} from "./repository";
import { appliedTools } from "./service";

/**
 * The transport apps' own MCP servers, as tool connections (PLAN.md: each
 * transport "hosts an MCP server" for its platform's outbound actions, which
 * the core registers as a managed connection).
 *
 * Only sources served by a separate app are reconciled. The web chat left
 * this list with the dissolve (Phase 6): its delivery tools are in-process
 * registry tools now, and its old managed row is deleted by store migration
 * 0006.
 *
 * They are reconciled from configuration rather than typed in by an operator:
 * their endpoint is the app's own URL, their scope is the app itself, and
 * **their snapshot follows the code**. That is the one place the
 * discover-then-apply rule does not apply, and deliberately so: the rule
 * exists to keep a third party from changing what the model is offered
 * mid-conversation, while these tools ship with the release and change when it
 * is deployed. Asking an operator to press Apply after every upgrade would
 * mean an assistant that silently lost the ability to react.
 *
 * The operator still owns the parts that are judgment: enabling, and which
 * assistants may call them. Identity and endpoint are refused as edits.
 */

const FEATURE = FEATURES["tool-connections"];

/** The sources whose MCP server lives in a separate transport app. */
const TRANSPORT_SOURCE_IDS: readonly SourceId[] = ["tg"];

/** What a source app's connection looks like when configuration is complete. */
interface ManagedDesired {
  source: SourceId;
  slug: string;
  name: string;
  endpointUrl: string;
  authHeaders: Record<string, string>;
}

/**
 * The desired connection for one source, or null when it has not registered
 * (or announces no MCP server). Resolved from the transport's registration
 * row since Phase 7 — the endpoint is `baseUrl + mcpPath` as announced.
 */
export async function desiredManagedConnection(
  source: SourceId,
): Promise<ManagedDesired | null> {
  const token = getEnv().INTERNAL_API_TOKEN;
  if (!token) return null;
  const row = await getTransport(source).catch(() => null);
  if (!row || !row.baseUrl || !row.mcpPath) return null;
  return {
    source,
    slug: source,
    name: `${directorySourceLabel(source)} tools`,
    endpointUrl: `${row.baseUrl.replace(/[/]$/, "")}${row.mcpPath}`,
    authHeaders: { [INTERNAL_TOKEN_HEADER]: token },
  };
}

/** One source's row brought in line with configuration; null if not deployed. */
async function reconcileOne(
  db: StoreDb,
  source: SourceId,
  trace: Pick<TraceRecorder, "event">,
): Promise<ToolConnectionRecord | null> {
  const desired = await desiredManagedConnection(source);
  const existing = await getToolConnectionBySlug(db, source);

  if (!desired) {
    // The app is not deployed here. The row stays (its scope and assistant
    // selection are the operator's), but nothing may be offered from an
    // endpoint that no longer exists.
    if (existing?.enabled) {
      await updateToolConnection(db, existing.id, { enabled: false });
      await trace.event({
        type: "step",
        level: "warn",
        message: `${source} is not configured in this deployment — its tools are disabled`,
      });
    }
    return null;
  }

  if (!existing) {
    const created = await insertToolConnection(db, randomUUID(), {
      slug: desired.slug,
      name: desired.name,
      transport: "http",
      endpointUrl: desired.endpointUrl,
      authHeaders: desired.authHeaders,
      enabled: true,
      appScope: desired.source,
      allAssistants: true,
      managed: true,
    });
    await trace.event({ type: "db", message: `registered ${source}'s own MCP server` });
    return created;
  }

  const changed =
    existing.endpointUrl !== desired.endpointUrl ||
    existing.name !== desired.name ||
    existing.appScope !== desired.source ||
    !existing.managed ||
    JSON.stringify(existing.authHeaders) !== JSON.stringify(desired.authHeaders);
  if (!changed) return existing;

  const updated = await updateToolConnection(db, existing.id, {
    name: desired.name,
    endpointUrl: desired.endpointUrl,
    authHeaders: desired.authHeaders,
    appScope: desired.source,
    managed: true,
  });
  await trace.event({ type: "db", message: `${source}'s connection re-pointed to configuration` });
  return updated;
}

/**
 * Bring every source app's connection in line with configuration and take its
 * current toolset — one trace for the whole pass, so a boot that could not
 * reach an app says which one and why instead of failing silently.
 *
 * A source that cannot be reached keeps its last snapshot: the tools it
 * offered a minute ago are the ones this release ships, and dropping them
 * because the app is still starting would make the first turns after a
 * restart quietly less capable.
 */
export async function reconcileManagedConnections(
  trigger: TraceTrigger = { kind: "system" },
  db: StoreDb = getStoreDb(),
): Promise<void> {
  return withTrace(
    { feature: FEATURE.id, action: "reconcile-managed", trigger, inputSummary: "source apps" },
    async (trace) => {
      const summary: string[] = [];
      for (const source of TRANSPORT_SOURCE_IDS) {
        const record = await reconcileOne(db, source, trace);
        if (!record) {
          summary.push(`${source}: not deployed`);
          continue;
        }
        try {
          const discovered = await listRemoteTools(record);
          const diff = diffToolsets(appliedTools(record), discovered);
          await recordDiscovery(db, record.id, {
            at: new Date(),
            error: null,
            tools: discovered,
          });
          await replaceSnapshot(db, record.id, discovered);
          await trace.event({
            type: "external_call",
            message: `${source} offers ${discovered.length} tools — ${describeDiff(diff)}`,
            data: { tools: discovered.map((tool) => tool.name) },
          });
          summary.push(`${source}: ${discovered.length} tools`);
        } catch (err) {
          const error = err instanceof Error ? err.message : String(err);
          await recordDiscovery(db, record.id, {
            at: record.lastDiscoveredAt ? new Date(record.lastDiscoveredAt) : null,
            error,
          });
          await trace.event({
            type: "external_call",
            level: "warn",
            message: `${source} did not answer — keeping the ${record.tools.length} tools it last offered`,
            data: { error },
          });
          summary.push(`${source}: unreachable`);
        }
      }
      await trace.succeed({ outputSummary: summary.join("; ") });
      publishEvent(FEATURE.realtimeTopic!);
    },
  );
}

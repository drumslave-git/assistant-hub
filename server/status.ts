import "server-only";

import { sql } from "drizzle-orm";

import { getDb, type DrizzleDb } from "@/db/drizzle";
import {
  getDownloadStorageHealth,
  type DownloadStorageHealth,
} from "@/features/browser-agent/server/download";
import { getSettingsRecord } from "@/features/settings/server/repository";
import { listModels } from "@/server/llm/client";
import { getTraceStorageHealth, type TraceStorageHealth } from "@/server/trace/store";

/**
 * System status for the dashboard overview. Every field is a *real probe* —
 * an actual `SELECT 1`, an actual `/v1/models` call — never a "is the env var
 * set" guess. Config lives in the DB, so status is derived by exercising it.
 *
 * Probes are best-effort and never throw: each failure is captured as a detail
 * string so the overview renders honest state instead of erroring.
 */

/** Short timeout so the overview stays responsive even against a dead endpoint. */
const LLM_PROBE_TIMEOUT_MS = 5_000;

export interface DbStatus {
  connected: boolean;
  detail: string;
}

export interface LlmStatus {
  state: "unconfigured" | "connected" | "error";
  detail: string;
  modelCount?: number;
}

export interface ModelStatus {
  selected: boolean;
  detail: string;
}

export interface SystemStatus {
  db: DbStatus;
  llm: LlmStatus;
  model: ModelStatus;
  /** Trace/debug log write path — a real append probe, not a config guess. */
  traces: TraceStorageHealth;
  /** Browser-agent download write path — a real create/unlink probe, same reasoning. */
  downloads: DownloadStorageHealth;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export interface ConfigReadiness {
  configured: boolean;
  detail: string;
}

/**
 * Cheap, DB-only configuration readiness for the persistent shell (no live LLM
 * probe — that would run on every page). "Configured" means an endpoint and a
 * model are saved; the Overview page does the live reachability check.
 */
export async function getConfigReadiness(db: DrizzleDb = getDb()): Promise<ConfigReadiness> {
  try {
    const settings = await getSettingsRecord(db);
    const configured = Boolean(settings?.llmBaseUrl && settings?.model);
    return {
      configured,
      detail: configured
        ? "LLM endpoint and model set — see Overview for live status."
        : "Connect an LLM endpoint and choose a model.",
    };
  } catch {
    return { configured: false, detail: "Database unavailable." };
  }
}

/**
 * Probe the database, the LLM endpoint, the model selection, and both filesystem
 * write paths (trace logs and browser-agent downloads).
 */
export async function getSystemStatus(db: DrizzleDb = getDb()): Promise<SystemStatus> {
  // Both write paths are independent of the DB — probe them first so a DB outage
  // cannot hide a dying volume (each is surfaced on its own), and concurrently
  // since neither touches the other's directory.
  const [traces, downloads] = await Promise.all([
    getTraceStorageHealth(),
    getDownloadStorageHealth(),
  ]);

  // 1. Database — a real query. If it fails, nothing downstream can be checked.
  try {
    await db.execute(sql`SELECT 1`);
  } catch (err) {
    const detail = errorMessage(err);
    return {
      db: { connected: false, detail },
      llm: { state: "unconfigured", detail: "Requires a database connection" },
      model: { selected: false, detail: "Requires a database connection" },
      traces,
      downloads,
    };
  }

  // 2. LLM endpoint — probe only what is actually configured in the DB.
  const settings = await getSettingsRecord(db);
  const baseUrl = settings?.llmBaseUrl ?? null;

  let llm: LlmStatus;
  if (!baseUrl) {
    llm = { state: "unconfigured", detail: "No endpoint set — configure it in Settings" };
  } else {
    try {
      const models = await listModels(
        { baseUrl, apiKey: settings?.llmApiKey ?? null },
        LLM_PROBE_TIMEOUT_MS,
      );
      llm = { state: "connected", detail: baseUrl, modelCount: models.length };
    } catch (err) {
      llm = { state: "error", detail: errorMessage(err) };
    }
  }

  // 3. Model selection.
  const model: ModelStatus = settings?.model
    ? { selected: true, detail: settings.model }
    : { selected: false, detail: "No model selected" };

  return { db: { connected: true, detail: "Connected" }, llm, model, traces, downloads };
}

export interface HealthReport {
  /** True when the app can serve requests — i.e. its bootstrap dependency (DB) works. */
  ready: boolean;
  database: { ok: boolean; detail: string };
  /** DB-stored config presence (cheap). Not a readiness gate — the LLM being down
   *  must not make the dashboard "unhealthy". Live LLM reachability is on Overview. */
  configuration: ConfigReadiness;
  /**
   * Trace write-path health (real append probe + standing flush failures).
   * Informational, NEVER a readiness gate: while the volume is unwritable the
   * only copy of the unflushed traces is this process's RAM — failing the
   * healthcheck would make the orchestrator restart-loop the container and
   * destroy exactly the data the operator still has a chance to save.
   */
  traceStorage: TraceStorageHealth;
  /**
   * Download write-path health (real create/unlink probe). Informational and never a
   * readiness gate, for a different reason than traces: the app serves fine without
   * it — only the browser agent's downloads fail, loudly, on the run that attempted
   * one. Reported here so an unwritable mount is visible to an orchestrator's probe
   * output without affecting whether the container is considered healthy.
   */
  downloadStorage: DownloadStorageHealth;
}

/**
 * Readiness for the `/api/health` endpoint. Gated on a real database probe
 * (`SELECT 1`) — the one bootstrap dependency — not env presence. Deliberately
 * omits the live LLM probe so healthchecks stay fast and don't flap on an
 * external endpoint blip.
 */
export async function getHealth(db: DrizzleDb = getDb()): Promise<HealthReport> {
  let database: HealthReport["database"];
  try {
    await db.execute(sql`SELECT 1`);
    database = { ok: true, detail: "Connected" };
  } catch (err) {
    database = { ok: false, detail: errorMessage(err) };
  }

  const configuration: ConfigReadiness = database.ok
    ? await getConfigReadiness(db)
    : { configured: false, detail: "Requires a database connection." };

  const [traceStorage, downloadStorage] = await Promise.all([
    getTraceStorageHealth(),
    getDownloadStorageHealth(),
  ]);

  return {
    ready: database.ok,
    database,
    configuration,
    traceStorage,
    downloadStorage,
  };
}

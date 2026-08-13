import "server-only";

import { sql } from "drizzle-orm";

import { getDb, type DrizzleDb } from "@/db/drizzle";
import {
  getDownloadStorageHealth,
  type DownloadStorageHealth,
} from "@/features/browser-agent/server/download";
import { getBackendById } from "@/features/backends/server/repository";
import { getSettingsRecord } from "@/features/settings/server/repository";
import {
  getAudioRuntime,
  getBrowserLlmRuntime,
  getEmbeddingRuntime,
  getImageRuntime,
  getSpeechRuntime,
  getVisionRuntime,
} from "@/features/settings/server/service";
import { listModels } from "@/server/llm/client";
import { probeTranscription } from "@/server/llm/transcription";
import { tinySilenceWav } from "@/server/media/audio";
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

/**
 * Live status of one optional endpoint (embeddings, images, speech,
 * transcription, vision, browser agent).
 *
 * - `ok` / `error`: a dedicated endpoint that was actually probed.
 * - `off`: the capability genuinely does not run — a configuration choice, not
 *   a fault, so it renders neutral.
 * - `inherited`: no dedicated model, so the role runs on the **chat** model
 *   ("main by default"). Also neutral — nothing was probed beyond what the LLM
 *   card already probes — but the capability is *on*, and calling that "off"
 *   would be a lie about a working feature.
 */
export interface EndpointStatus {
  id: "embeddings" | "images" | "speech" | "audio" | "vision" | "browser";
  label: string;
  state: "off" | "inherited" | "ok" | "error";
  detail: string;
}

/** What an unprobed role reports: why, and whether the capability still runs. */
interface UnprobedStatus {
  state: "off" | "inherited";
  detail: string;
}

export interface SystemStatus {
  db: DbStatus;
  llm: LlmStatus;
  model: ModelStatus;
  /** Every optional endpoint, each behind a real probe (see {@link EndpointStatus}). */
  endpoints: EndpointStatus[];
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
    const configured = Boolean(settings?.chatBackendId && settings?.model);
    return {
      configured,
      detail: configured
        ? "Chat backend and model set — see Overview for live status."
        : "Pick a chat backend and model in Settings.",
    };
  } catch {
    return { configured: false, detail: "Database unavailable." };
  }
}

/**
 * Probe one model-serving optional endpoint (embeddings, images, speech): list
 * its models — bounded by the shared probe timeout so a dead host cannot stall
 * the page — and verify the configured model is actually served. An endpoint
 * that lists nothing cannot disprove the model, so it reports reachable rather
 * than guessing.
 */
async function probeModelEndpoint(
  id: EndpointStatus["id"],
  label: string,
  unprobed: UnprobedStatus,
  runtime: { baseUrl: string; apiKey?: string | null; model: string } | null,
): Promise<EndpointStatus> {
  if (!runtime) return { id, label, ...unprobed };
  try {
    const models = await listModels(runtime, LLM_PROBE_TIMEOUT_MS);
    if (models.length > 0 && !models.includes(runtime.model)) {
      return {
        id,
        label,
        state: "error",
        detail: `"${runtime.model}" is not served by ${runtime.baseUrl}`,
      };
    }
    return { id, label, state: "ok", detail: `${runtime.model} @ ${runtime.baseUrl}` };
  } catch (err) {
    return { id, label, state: "error", detail: errorMessage(err) };
  }
}

/** Bound on the transcription probe — its own default deadline is page-hostile. */
const TRANSCRIPTION_PROBE_TIMEOUT_MS = 6_000;

/**
 * Probe the transcription endpoint by actually transcribing a fraction of a
 * second of silence — whisper-class servers often expose no model listing, so a
 * real call is the only honest check (same reasoning as the Settings probe).
 */
async function probeTranscriptionEndpoint(
  db: DrizzleDb,
  chatFallback: UnprobedStatus,
): Promise<EndpointStatus> {
  const id = "audio" as const;
  const label = "Audio (STT)";
  const runtime = await getAudioRuntime(db).catch(() => null);
  if (!runtime) return { id, label, ...chatFallback };
  try {
    await Promise.race([
      probeTranscription(runtime, tinySilenceWav()),
      new Promise<never>((_, reject) =>
        setTimeout(
          () =>
            reject(
              new Error(
                `No answer from ${runtime.baseUrl} within ${TRANSCRIPTION_PROBE_TIMEOUT_MS / 1000}s`,
              ),
            ),
          TRANSCRIPTION_PROBE_TIMEOUT_MS,
        ),
      ),
    ]);
    return { id, label, state: "ok", detail: `${runtime.model} @ ${runtime.baseUrl}` };
  } catch (err) {
    return { id, label, state: "error", detail: errorMessage(err) };
  }
}

/** Every optional endpoint's live status, probed concurrently. */
async function probeOptionalEndpoints(db: DrizzleDb): Promise<EndpointStatus[]> {
  // The chat-fallback roles (vision, browser agent, voice transcription) are
  // probed only when the operator gave them a model or backend of their own —
  // otherwise they resolve to exactly the chat connection the LLM card already
  // probes, and a second identical probe would just double the noise.
  const record = await getSettingsRecord(db).catch(() => null);
  const visionOverridden = Boolean(record?.visionBackendId || record?.visionModel);
  const browserOverridden = Boolean(record?.browserBackendId || record?.browserModel);
  const chatModelSet = Boolean(record?.chatBackendId && record?.model);

  /**
   * What a role with no dedicated model reports. Running on the chat model is
   * the feature working as configured, so it is `inherited`, not `off` — but
   * the modality is the operator's to get right, since a chat model that does
   * not accept the input fails only when the feature is actually used. With no
   * chat model there is nothing to fall back to, and the role really is off.
   */
  const fallback = (modality: string, whenOff: string): UnprobedStatus =>
    chatModelSet
      ? { state: "inherited", detail: `Runs on the chat model, which must accept ${modality}` }
      : { state: "off", detail: whenOff };

  return Promise.all([
    getEmbeddingRuntime(db)
      .catch(() => null)
      .then((runtime) =>
        probeModelEndpoint("embeddings", "Embeddings", {
          state: "off",
          detail: "No embedding model — semantic recall off",
        }, runtime),
      ),
    getImageRuntime(db)
      .catch(() => null)
      .then((runtime) =>
        probeModelEndpoint("images", "Images", {
          state: "off",
          detail: "No image model — image generation off",
        }, runtime),
      ),
    getSpeechRuntime(db)
      .catch(() => null)
      .then((runtime) =>
        probeModelEndpoint("speech", "Speech", {
          state: "off",
          detail: "No speech model — voice replies text-only",
        }, runtime),
      ),
    probeTranscriptionEndpoint(
      db,
      fallback("audio", "No STT model and no chat model — voice cannot be transcribed"),
    ),
    (visionOverridden ? getVisionRuntime(db).catch(() => null) : Promise.resolve(null)).then(
      (runtime) =>
        probeModelEndpoint(
          "vision",
          "Vision",
          visionOverridden
            ? { state: "off", detail: "Not fully configured" }
            : fallback("images", "No vision model and no chat model — media cannot be described"),
          runtime,
        ),
    ),
    (browserOverridden ? getBrowserLlmRuntime(db).catch(() => null) : Promise.resolve(null)).then(
      (runtime) =>
        probeModelEndpoint(
          "browser",
          "Browser agent",
          browserOverridden
            ? { state: "off", detail: "Not fully configured" }
            : fallback("tool calls", "No browser model and no chat model — browsing is off"),
          runtime,
        ),
    ),
  ]);
}

/**
 * Probe the database, the LLM endpoint, the model selection, every optional
 * endpoint, and both filesystem write paths (trace logs and browser-agent
 * downloads).
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
      endpoints: [],
      traces,
      downloads,
    };
  }

  // 2. LLM endpoint — probe only what is actually configured in the DB. The
  // optional endpoints are probed concurrently with it; each is bounded, so the
  // page waits for the slowest single probe, not their sum.
  const settings = await getSettingsRecord(db);
  const chatBackend = settings?.chatBackendId
    ? await getBackendById(db, settings.chatBackendId)
    : null;

  const probeLlm = async (): Promise<LlmStatus> => {
    if (!chatBackend) {
      return { state: "unconfigured", detail: "No chat backend set — configure it in Settings" };
    }
    try {
      const models = await listModels(
        { baseUrl: chatBackend.baseUrl, apiKey: chatBackend.apiKey, backend: chatBackend.type },
        LLM_PROBE_TIMEOUT_MS,
      );
      return { state: "connected", detail: chatBackend.baseUrl, modelCount: models.length };
    } catch (err) {
      return { state: "error", detail: errorMessage(err) };
    }
  };
  const [llm, endpoints] = await Promise.all([probeLlm(), probeOptionalEndpoints(db)]);

  // 3. Model selection.
  const model: ModelStatus = settings?.model
    ? { selected: true, detail: settings.model }
    : { selected: false, detail: "No model selected" };

  return { db: { connected: true, detail: "Connected" }, llm, model, endpoints, traces, downloads };
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

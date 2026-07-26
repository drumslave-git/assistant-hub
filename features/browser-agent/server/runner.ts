import "server-only";

import type { DrizzleDb } from "@/db/drizzle";
import { getDb } from "@/db/drizzle";
import { recordAssistantMessage } from "@/features/history/server/service";
import { getActivePersonalityPrompt } from "@/features/personalities/server/service";
import {
  getBrowserDownloadMaxMb,
  getBotPolicy,
  getLlmRuntime,
} from "@/features/settings/server/service";
import { getGroupLanguage } from "@/features/known-groups/server/service";
import { getUserLanguage } from "@/features/known-users/server/service";
import { FEATURES } from "@/lib/features";
import { resolveRequiredLanguage } from "@/lib/language";
import { isGroupChatId } from "@/lib/telegram";
import { sanitizeMessagesForTrace } from "@/server/llm/client";
import { withAdvisoryLock } from "@/server/jobs/lock";
import { publishEvent } from "@/server/realtime/hub";
import { sendChatDocument, sendChatMessage } from "@/server/telegram/bot-manager";
import { startTrace } from "@/server/trace";

import type { BrowserAgentRun, BrowserDownloadRecord } from "../types";
import { runBrowserAgent } from "./agent";
import { formatDownloadLine, formatRunReport } from "../format";
import { getDownloadStorageHealth } from "./download";
import { clearLiveState, setLiveAction, setLiveProgress } from "./live-state";
import {
  appendBrowserRunStep,
  claimBrowserAgentRun,
  failStaleRunningRuns,
  insertBrowserRunScreenshot,
  listQueuedBrowserAgentRuns,
  setBrowserAgentRunTrace,
  settleBrowserAgentRun,
} from "./repository";
import { BrowserAgentSession } from "./session";
import { setRunEnqueuedListener } from "./signal";
import type { AgentToolContext, CollectedFile } from "./tools";

/**
 * The browser-agent runner: an in-process queue pump, the same operating model as
 * the scheduled-tasks poller (recorded background-job decision). A single run
 * executes at a time; the queue is the `browser_agent_runs` table. Enqueuers
 * signal via `signal.ts`, and a crash-safety sweep at boot fails any run left
 * `running` by a previous process.
 *
 * Delivery mirrors the MVP: each downloaded file is posted to the chat the moment
 * it lands (silently — an intermediate progress message), and the agent's final
 * report is delivered at the end and mirrored into history. A dashboard-started
 * run (no `chatId`) delivers nothing — the report is only stored on the run row.
 */

const FEATURE = FEATURES["browser-agent"];
const JOB_NAME = "browser-agent";

let started = false;
let pumping = false;
let active = false;

/** Deliver text to the run's chat, split into Telegram-sized messages. */
async function deliverText(
  run: BrowserAgentRun,
  text: string,
  opts: { silent?: boolean } = {},
): Promise<number | null> {
  if (!run.chatId || !text.trim()) return null;
  // sendChatMessage handles the length via the caller; keep it whole here — the
  // report is already concise, and a run recap rarely exceeds one message.
  const { messageId } = await sendChatMessage(run.chatId, text, {
    threadId: run.threadId,
    ...(opts.silent ? { silent: true } : {}),
  });
  return messageId;
}

/** Post one finished download to the chat as it lands (silent progress message). */
async function deliverDownload(
  run: BrowserAgentRun,
  record: BrowserDownloadRecord,
  file: CollectedFile | null,
): Promise<void> {
  if (!run.chatId) return;
  try {
    if (file) {
      await sendChatDocument(
        run.chatId,
        { buffer: file.buffer, filename: file.filename },
        { threadId: run.threadId, caption: formatDownloadLine(record) },
      );
    } else {
      await sendChatMessage(run.chatId, formatDownloadLine(record), {
        threadId: run.threadId,
        silent: true,
      });
    }
  } catch (err) {
    console.error(
      `browser-agent: failed to deliver a download for run ${run.id}:`,
      err instanceof Error ? err.message : String(err),
    );
  }
}

/** Execute one claimed run to completion. Never throws — always settles the run. */
async function runOne(run: BrowserAgentRun, db: DrizzleDb): Promise<void> {
  active = true;
  publishEvent(FEATURE.realtimeTopic);

  const trace = await startTrace({
    feature: FEATURE.id,
    action: "run",
    trigger: {
      kind: run.chatId ? "telegram" : "dashboard",
      actor: run.chatId ?? "dashboard",
      correlationId: run.id,
    },
    inputSummary: run.goal,
  });
  await setBrowserAgentRunTrace(db, run.id, trace.id).catch(() => undefined);

  const session = new BrowserAgentSession();
  const downloads: BrowserDownloadRecord[] = [];
  let screenshotSeq = 0;

  try {
    const runtime = await getLlmRuntime();
    if (!runtime) {
      await trace.skip("LLM not configured");
      await settleBrowserAgentRun(db, run.id, {
        status: "failed",
        error: "No LLM is configured.",
        downloads: [],
      });
      return;
    }

    const [downloadMaxMb, personalityPrompt, storedLanguage] = await Promise.all([
      getBrowserDownloadMaxMb(),
      getActivePersonalityPrompt().catch(() => null),
      run.chatId
        ? (isGroupChatId(run.chatId) ? getGroupLanguage(run.chatId) : getUserLanguage(run.chatId)).catch(
            () => null,
          )
        : Promise.resolve(null),
    ]);
    // Persona is not composed into the agent prompt (the agent reports facts, it
    // does not converse in character), but the chat's language still applies.
    void personalityPrompt;

    const toolContext: AgentToolContext = {
      session,
      isOwner: run.isOwner,
      downloadMaxMb,
      downloads,
      onAction: (action, url) => {
        // Reflect the in-flight action immediately for the live "current action"
        // indicator; the completed-step record (with outcome) follows in onStep.
        setLiveAction(run.id, url ? `${action} — ${url}` : action);
      },
      onStep: async (step) => {
        setLiveAction(run.id, null);
        await appendBrowserRunStep(db, run.id, {
          tool: step.tool,
          action: step.action,
          url: step.url,
          ok: step.ok,
          summary: step.summary,
          at: new Date().toISOString(),
        }).catch(() => undefined);
        await trace.event({
          type: "external_call",
          level: step.ok ? "info" : "warn",
          message: `browser: ${step.action}`,
          data: { tool: step.tool, url: step.url, ok: step.ok, summary: step.summary },
        });
        // A completed step is a discrete, low-frequency event — refresh the list
        // (step count) and any open detail. Live progress within a download is not
        // published here; the detail view polls for that.
        publishEvent(FEATURE.realtimeTopic);
      },
      onProgress: (line) => setLiveProgress(run.id, line),
      onScreenshot: async ({ buffer, url, title }) => {
        const seq = screenshotSeq++;
        await insertBrowserRunScreenshot(db, { runId: run.id, seq, url, title, data: buffer }).catch(
          () => undefined,
        );
        return seq;
      },
      onDownload: async (record, file) => {
        await trace.event({
          type: "db",
          message: "download",
          data: { filename: record.filename, sizeBytes: record.sizeBytes, sourceUrl: record.sourceUrl },
        });
        await deliverDownload(run, record, file);
        publishEvent(FEATURE.realtimeTopic);
      },
    };

    const result = await runBrowserAgent({
      goal: run.goal,
      conn: { baseUrl: runtime.baseUrl, apiKey: runtime.apiKey },
      model: runtime.model,
      toolContext,
      requiredLanguage: resolveRequiredLanguage(storedLanguage) ?? null,
      onRequest: async (requestBody) => {
        await trace.event({
          type: "llm_request",
          message: "browser agent request",
          // Redact any inline image bytes (none in the seed today, but the
          // convention must hold if the seed ever carries a screenshot).
          data: redactRequestImages(requestBody),
        });
      },
      onRound: async (round, report) => {
        await trace.event({
          type: "llm_response",
          message: report.isFinal ? "report round" : "tool round",
          data: round.raw,
          usage: {
            model: runtime.model,
            promptTokens: round.usage?.promptTokens,
            completionTokens: round.usage?.completionTokens,
            totalTokens: round.usage?.totalTokens,
            latencyMs: round.latencyMs,
            callKind: report.isFinal ? "browser-agent-report" : "browser-agent-turn",
          },
        });
      },
    });

    const report = result.report || "I browsed but couldn't find anything useful.";

    // Deliver the final report and mirror it into history (best-effort).
    if (run.chatId) {
      const recap = formatRunReport(report, downloads);
      const messageId = await deliverText(run, recap).catch((err) => {
        console.error(
          `browser-agent: failed to deliver the report for run ${run.id}:`,
          err instanceof Error ? err.message : String(err),
        );
        return null;
      });
      if (messageId != null) {
        await recordAssistantMessage({
          chatId: run.chatId,
          telegramMessageId: messageId,
          content: recap,
        }).catch(() => undefined);
        await trace.event({
          type: "output",
          level: "success",
          message: "send report",
          data: { content: recap, messageId },
        });
      }
    }

    await settleBrowserAgentRun(db, run.id, {
      status: "done",
      report,
      downloads,
    });
    await trace.succeed({
      outputSummary: report.slice(0, 200),
      relatedIds: { [FEATURE.relatedIdsKey!]: [run.id] },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await settleBrowserAgentRun(db, run.id, {
      status: "failed",
      error: message,
      downloads,
    }).catch(() => undefined);
    // Tell the chat the run failed, so a user is never left waiting on a promise.
    if (run.chatId) {
      await deliverText(run, "I hit a problem while browsing and had to stop.").catch(() => undefined);
    }
    await trace.fail(err);
  } finally {
    clearLiveState(run.id);
    await session.close();
    active = false;
    publishEvent(FEATURE.realtimeTopic);
  }
}

/** Redact inline image `data:` URLs in a chat-completion request body for traces. */
function redactRequestImages(body: unknown): unknown {
  const request = body as { messages?: unknown } | null;
  if (!request || !Array.isArray(request.messages)) return body;
  return {
    ...request,
    messages: sanitizeMessagesForTrace(request.messages as never),
  };
}

/**
 * Drain the queue: one run at a time, paused during maintenance. Guarded so
 * overlapping triggers (a poll + an enqueue signal) don't double-drain. The
 * advisory lock additionally guards cross-process overlap during a redeploy.
 */
async function pump(db: DrizzleDb): Promise<void> {
  if (!started || pumping || active) return;
  pumping = true;
  try {
    for (;;) {
      if (!started) break;
      const policy = await getBotPolicy().catch(() => null);
      if (policy?.maintenanceModeEnabled) break;

      const queued = await listQueuedBrowserAgentRuns(db).catch(() => []);
      if (queued.length === 0) break;

      const outcome = await withAdvisoryLock(
        JOB_NAME,
        async () => {
          // Re-claim under the lock: the row must still be queued (another process
          // in a redeploy overlap may have taken it).
          const claimed = await claimBrowserAgentRun(db, queued[0].id);
          if (!claimed) return false;
          publishEvent(FEATURE.realtimeTopic);
          await runOne(claimed, db);
          return true;
        },
        db,
      );
      // Lock held elsewhere, or the row was already taken — stop this drain; the
      // holder will finish the queue (or the next signal re-triggers us).
      if (!outcome.ran || outcome.result === false) break;
    }
  } finally {
    pumping = false;
  }
}

/** Start the runner (boot): sweep stale runs, then drain any backlog. Idempotent. */
export function startBrowserAgentRunner(db: DrizzleDb = getDb()): void {
  if (started) return;
  started = true;
  setRunEnqueuedListener(() => void pump(db));
  void (async () => {
    // Probe the download write path at boot so an unwritable mount screams in the
    // server log immediately — not on the first user who asks for a file. The
    // dashboard reads the same health (Overview card, /api/health, this page's
    // notice); this is only the log line. Never gates the runner: a run that needs
    // no download still works, and one that does reports its own failure.
    const storage = await getDownloadStorageHealth().catch(() => null);
    if (storage && !storage.ok) {
      console.error(
        `Browser-agent downloads directory is NOT writable (${storage.detail}). Downloads will fail until this is fixed; for a Docker bind mount, fix the host directory's ownership.`,
      );
    }
    await failStaleRunningRuns(db).catch(() => undefined);
    void pump(db);
  })();
}

/** Stop the runner (shutdown). A run in flight finishes; no new runs are claimed. */
export function stopBrowserAgentRunner(): void {
  started = false;
  setRunEnqueuedListener(null);
}

/** Whether a run is currently executing (for the dashboard status card). */
export function isBrowserAgentRunning(): boolean {
  return active;
}

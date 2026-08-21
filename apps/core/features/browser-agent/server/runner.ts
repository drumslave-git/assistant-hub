import "server-only";

import { rm } from "node:fs/promises";

import type { DrizzleDb } from "@/db/drizzle";
import { getDb } from "@/db/drizzle";
import { markMessageDeleted, recordAssistantMessage } from "@/features/history/server/service";
import { getActivePersonalityPrompt } from "@/features/personalities/server/service";
import {
  getBrowserDownloadLimitBytes,
  getBotPolicy,
  getBrowserLlmRuntime,
} from "@/features/settings/server/service";
import { getGroupLanguage } from "@/features/known-groups/server/service";
import { getUserLanguage } from "@/features/known-users/server/service";
import { FEATURES } from "@/lib/features";
import { resolveRequiredLanguage } from "@/lib/language";
import { isGroupChatId, TELEGRAM_MAX_UPLOAD_MB } from "@/lib/telegram";
import { chatCompletion, type LlmConnection } from "@/server/llm/client";
import { withAdvisoryLock } from "@/server/jobs/lock";
import { publishEvent } from "@/server/realtime/hub";
import { deleteChatMessage, sendChatFile, sendChatMessage } from "@/server/telegram/bot-manager";
import { startTrace, type TraceRecorder } from "@/server/trace";

import type { BrowserAgentRun, BrowserDownloadRecord } from "../types";
import { takeRunAck } from "./ack";
import { runBrowserAgent } from "./agent";
import {
  buildRunOutcomeMessages,
  parseRunOutcomeVerdict,
  type RunOutcomeVerdict,
} from "./outcome";
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
import type { AgentToolContext, CollectedFile, DownloadOutcome } from "./tools";

/**
 * The browser-agent runner: an in-process queue pump, the same operating model as
 * the tasks poller (recorded background-job decision). A single run
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

/** Telegram caps a media caption at 1024 characters. */
const TELEGRAM_CAPTION_MAX = 1024;

/** One attachable file held until the end of the run, delivered with the report. */
interface StagedFile {
  record: BrowserDownloadRecord;
  file: CollectedFile;
}

/**
 * Send one staged file to the chat, as playable media where the container
 * allows. On success the record is marked delivered and the server copy removed
 * — the chat is now the file's home. Resolves the delivered message id, or null
 * when the send failed (the file then stays in the downloads folder and the
 * recap points there).
 */
async function sendStagedFile(
  run: BrowserAgentRun,
  staged: StagedFile,
  caption: string,
): Promise<number | null> {
  if (!run.chatId) return null;
  try {
    const { messageId } = await sendChatFile(
      run.chatId,
      { buffer: staged.file.buffer, filename: staged.file.filename, mime: staged.file.mime },
      { threadId: run.threadId, caption },
    );
    staged.record.deliveredToChat = true;
    // A failed unlink leaves a stray file, not a wrong answer — the chat still
    // has it, so the record stays truthful and only the disk hygiene is off.
    await rm(staged.file.filePath, { force: true }).catch((err: unknown) => {
      console.error(
        `browser-agent: delivered "${staged.file.filename}" but could not remove the server copy:`,
        err instanceof Error ? err.message : String(err),
      );
    });
    return messageId;
  } catch (err) {
    console.error(
      `browser-agent: failed to deliver "${staged.file.filename}" for run ${run.id}:`,
      err instanceof Error ? err.message : String(err),
    );
    return null;
  }
}

/**
 * Deliver the end of a run as ONE message wherever possible: a single staged
 * file rides with the report as its caption; with several files (or a report
 * over the caption cap) each file goes out under its own line and the report
 * follows. The recap only lists files that did NOT reach the chat — a delivered
 * attachment speaks for itself. Resolves what was sent as the report-bearing
 * message (for history + trace), or null when nothing could be delivered.
 */
async function deliverRunOutcome(
  run: BrowserAgentRun,
  report: string,
  staged: StagedFile[],
  downloads: BrowserDownloadRecord[],
): Promise<{ content: string; messageId: number; hasMedia: boolean } | null> {
  if (!run.chatId) return null;
  if (staged.length === 1) {
    const others = downloads.filter((d) => d !== staged[0].record && !d.deliveredToChat);
    const caption = formatRunReport(report, others);
    if (caption.length <= TELEGRAM_CAPTION_MAX) {
      const messageId = await sendStagedFile(run, staged[0], caption);
      if (messageId != null) return { content: caption, messageId, hasMedia: true };
      // Fall through: the file could not be sent, so it is undelivered and the
      // text recap below names it in the downloads folder.
    } else {
      await sendStagedFile(
        run,
        staged[0],
        formatDownloadLine({ ...staged[0].record, deliveredToChat: true }),
      );
    }
  } else {
    for (const one of staged) {
      await sendStagedFile(run, one, formatDownloadLine({ ...one.record, deliveredToChat: true }));
    }
  }
  const recap = formatRunReport(report, downloads.filter((d) => !d.deliveredToChat));
  // A report that only announces an undeliverable file is sent without a ping
  // (user decision, 2026-08-01) — there is nothing for the user to act on.
  const silent = downloads.some((d) => d.discarded);
  const messageId = await deliverText(run, recap, { silent }).catch((err) => {
    console.error(
      `browser-agent: failed to deliver the report for run ${run.id}:`,
      err instanceof Error ? err.message : String(err),
    );
    return null;
  });
  return messageId != null ? { content: recap, messageId, hasMedia: false } : null;
}

/**
 * Remove the chat's "on it" acknowledgement now that the run has spoken for
 * itself (the ack was sent silent and exists only to bridge the wait). Marks the
 * run settled in the ack store either way, so an acknowledgement that arrives
 * *after* the run finished is deleted at registration instead of surviving
 * forever. Best-effort — a message Telegram refuses to delete (older than 48h)
 * just stays.
 */
async function removeRunAck(runId: string): Promise<void> {
  const ack = takeRunAck(runId);
  if (!ack) return;
  for (const messageId of ack.messageIds) {
    try {
      await deleteChatMessage(ack.chatId, messageId);
      // Mirror follows the chat: the row is soft-deleted only once Telegram
      // actually dropped the message.
      await markMessageDeleted(ack.chatId, messageId);
    } catch (err) {
      console.error(
        `browser-agent: could not remove the acknowledgement message ${messageId} for run ${runId}:`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }
}

/** Cap on the outcome verdict answer — a tiny JSON object, not an essay. */
const OUTCOME_CHECK_MAX_TOKENS = 500;

/**
 * Ask the classifier whether the report states the goal failed, recording the
 * exchange on the run trace. Never throws: a provider failure here abstains and
 * the run settles `done` — the check reclassifies failures, it must not create
 * a new way for successful runs to break.
 */
async function judgeRunOutcome(
  conn: LlmConnection,
  model: string,
  goal: string,
  report: string,
  trace: TraceRecorder,
): Promise<RunOutcomeVerdict> {
  const messages = buildRunOutcomeMessages({ goal, report });
  try {
    const result = await chatCompletion(conn, {
      model,
      messages,
      reasoning: "off",
      maxTokens: OUTCOME_CHECK_MAX_TOKENS,
      trace: { recorder: trace, callKind: "run-outcome-check", label: "run outcome check" },
    });
    return parseRunOutcomeVerdict(result.content, { report });
  } catch (err) {
    await trace.event({
      type: "error",
      level: "warn",
      message: "run outcome check failed — run settles as done",
      data: { error: err instanceof Error ? err.message : String(err) },
    });
    return {
      goalFailed: false,
      outcome: null,
      quote: null,
      reason: "outcome check call failed",
    };
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
  /** Attachable files held for the end-of-run combined message (file + report). */
  const staged: StagedFile[] = [];
  let screenshotSeq = 0;

  try {
    const runtime = await getBrowserLlmRuntime();
    if (!runtime) {
      await trace.skip("LLM not configured");
      await settleBrowserAgentRun(db, run.id, {
        status: "failed",
        error: "No LLM is configured.",
        downloads: [],
      });
      return;
    }

    const [downloadLimitBytes, personalityPrompt, storedLanguage] = await Promise.all([
      getBrowserDownloadLimitBytes(),
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
      // A rule lends the owner's rights only for the links that triggered it;
      // an owner-started (or dashboard) run downloads without a URL fence.
      allowedDownloadUrls: run.restricted ? run.sourceUrls : null,
      // Telegram's own upload ceiling — not a tunable (user decision, 2026-08-01).
      downloadMaxMb: TELEGRAM_MAX_UPLOAD_MB,
      downloadLimitBytes,
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
        let outcome: DownloadOutcome = "kept";
        if (run.chatId && file) {
          // Held for the end of the run: the file goes out together with the
          // report as one combined message instead of two.
          staged.push({ record, file });
          outcome = "staged";
        } else if (run.chatId && run.restricted) {
          // Attach or fail (user decision, 2026-08-01): a restricted run's
          // audience cannot reach the server's disk, so a file the chat cannot
          // take is deleted by the dispatcher, not archived. No announcement —
          // the final report carries the failure.
          outcome = "discarded";
        } else if (run.chatId) {
          // Owner's run, too large to attach — announce it by name as it lands
          // (silent); the recap points at the downloads folder.
          await sendChatMessage(run.chatId, formatDownloadLine(record), {
            threadId: run.threadId,
            silent: true,
          }).catch((err: unknown) => {
            console.error(
              `browser-agent: failed to announce a download for run ${run.id}:`,
              err instanceof Error ? err.message : String(err),
            );
          });
        }
        await trace.event({
          type: "db",
          message: "download",
          data: {
            filename: record.filename,
            sizeBytes: record.sizeBytes,
            sourceUrl: record.sourceUrl,
            staged: outcome === "staged",
            discarded: outcome === "discarded",
          },
        });
        publishEvent(FEATURE.realtimeTopic);
        return outcome;
      },
    };

    const conn: LlmConnection = {
      baseUrl: runtime.baseUrl,
      apiKey: runtime.apiKey,
      backend: runtime.backend,
    };
    const result = await runBrowserAgent({
      goal: run.goal,
      sourceUrls: run.sourceUrls,
      conn,
      model: runtime.model,
      toolContext,
      requiredLanguage: resolveRequiredLanguage(storedLanguage) ?? null,
      trace: {
        recorder: trace,
        callKind: "browser-agent-report",
        toolTurnCallKind: "browser-agent-turn",
        label: "browser agent",
      },
    });

    const report = result.report || "I browsed but couldn't find anything useful.";

    // Outcome verdict — the report's own language decides done vs failed. The
    // agent is instructed to end an unachievable goal with an honest failure
    // report, and settling that as `done` is how failed runs sat green on the
    // dashboard. The model judges the language; code records the enum and
    // verifies the citation (see `outcome.ts`). Fails open: an unreadable or
    // unbacked verdict settles `done`, exactly as before the check existed.
    const verdict = await judgeRunOutcome(conn, runtime.model, run.goal, report, trace);

    // Deliver the outcome — file(s) + report, combined where possible — and
    // mirror the report-bearing message into history (best-effort). A failed
    // goal delivers the same way: the report IS the honest failure message.
    if (run.chatId) {
      const delivered = await deliverRunOutcome(run, report, staged, downloads);
      if (delivered != null) {
        await recordAssistantMessage({
          chatId: run.chatId,
          telegramMessageId: delivered.messageId,
          content: delivered.content,
          hasMedia: delivered.hasMedia,
        }).catch(() => undefined);
        await trace.event({
          type: "output",
          level: "success",
          message: delivered.hasMedia ? "send report with file" : "send report",
          data: { content: delivered.content, messageId: delivered.messageId },
        });
      }
      // The run has spoken for itself — the silent "on it" ack can go.
      await removeRunAck(run.id);
    }

    if (verdict.goalFailed) {
      await settleBrowserAgentRun(db, run.id, {
        status: "failed",
        report,
        error: `The agent reported the goal failed: "${verdict.quote}"`,
        downloads,
      });
      // Failed, not succeeded: a run that did not achieve its goal must be
      // findable on the Debug page — a green trace over a failure report is
      // exactly how these sat unnoticed.
      await trace.fail(new Error(`goal not achieved — ${verdict.reason}`), {
        relatedIds: { [FEATURE.relatedIdsKey!]: [run.id] },
      });
      return;
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
    // A file the run did download must still reach the chat, failure or not —
    // delivered before the settle so the persisted records say what happened.
    if (run.chatId) {
      for (const one of staged) {
        await sendStagedFile(run, one, formatDownloadLine({ ...one.record, deliveredToChat: true }));
      }
    }
    await settleBrowserAgentRun(db, run.id, {
      status: "failed",
      error: message,
      downloads,
    }).catch(() => undefined);
    // Tell the chat the run failed, so a user is never left waiting on a promise.
    if (run.chatId) {
      await deliverText(run, "I hit a problem while browsing and had to stop.").catch(() => undefined);
      await removeRunAck(run.id);
    }
    await trace.fail(err);
  } finally {
    clearLiveState(run.id);
    await session.close();
    active = false;
    publishEvent(FEATURE.realtimeTopic);
  }
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

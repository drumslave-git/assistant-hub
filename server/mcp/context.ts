import "server-only";

import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Per-turn context for MCP tool handlers. Tools are registered once on the shared
 * in-process server at startup, but their execution is scoped to a single chat
 * turn. Rather than force the model to pass (and be trusted with) a chat id, the
 * runtime binds the current chat here and tool handlers read it — so a tool can
 * only ever touch the current conversation's data.
 */
export interface McpToolContext {
  /** The current chat's id (Telegram chat/group id as a string). */
  chatId: string;
  /** The sender's numeric Telegram user id, when known (absent for tests). */
  userId?: string | null;
  /**
   * The turn's trace correlation (`<chatId>:<messageId>` for a reply turn, the
   * task id for a fire), stamped on every tool call's own trace so a whole
   * turn — reply trace plus each `mcp-tools-*` trace it caused — reads as one
   * process under the Debug correlation filter.
   */
  correlationId?: string;
  /**
   * The identity whose **permissions** this turn's tool calls carry, when it is
   * not the sender's. Set when a standing chat rule drove the turn: a rule is
   * its author's standing order, so an action the rule calls for runs with the
   * author's rights rather than those of whoever happened to send the message
   * that triggered it (user decision, 2026-07-29 — "rule creator beats message
   * source"). Absent → the sender's own rights, the ordinary case.
   *
   * Permissions **only**. Provenance — who wrote a memory, who created a task,
   * who authored an entry — always stays {@link userId}: elevating the sender's
   * identity would file another person's data under the owner.
   */
  authorityUserId?: string | null;
  /**
   * The http(s) URLs of the triggering message, extracted in code. Hard data the
   * model must not be trusted to re-type: `browse_web` carries them onto the run
   * verbatim, where they anchor the agent's prompt and bound a restricted run's
   * downloads. Absent when the turn has no message text (e.g. a task fire).
   */
  messageUrls?: string[];
  /** The forum-topic thread the turn is in, when any (so a task delivers there). */
  threadId?: number | null;
  /**
   * Sink for binary artifacts a tool produced (currently: generated images, as
   * base64), collected here and delivered to the chat by the pipeline *after* the
   * reply — deliberately out-of-band rather than through the tool's result.
   *
   * A tool result travels two places that bytes must not go: into the model's
   * context (a megabyte of base64 is not something to reason over — the model gets
   * only the text acknowledgement) and into trace storage verbatim
   * (`tool-trace.ts` records `structuredContent` as-is). Routing artifacts around
   * both keeps the recorded structured content complete *and* small, with no
   * redaction step to forget.
   *
   * Absent when the bound turn has no way to deliver an image (e.g. a scheduled
   * task fire, which is text-only). A tool that produces images must treat that as
   * "cannot send images here" and say so, rather than generating bytes into a void.
   */
  collectImage?: (base64: string) => void;
  /**
   * Notifies the turn that `browse_web` enqueued a background browsing run.
   * The reply pipeline uses it to treat this turn's reply as a transient
   * acknowledgement: delivered silently, and deleted once the run posts its own
   * report (user decision, 2026-08-01). Absent when the turn has no reply to
   * treat that way (e.g. a task fire).
   */
  onBrowserRunEnqueued?: (runId: string) => void;
  /**
   * Outbound delivery for a **task-driven turn** — the turns where the model's
   * own text is never sent and a delivery tool is the only way anything reaches
   * the chat (user decision, 2026-08-13: the model decides what a task sends,
   * not a hardcoded delivery). Its absence is what makes those tools refuse in
   * an ordinary reply turn, whose reply already delivers itself.
   *
   * How the message lands is the **binding's** decision, not the model's, which
   * is why this takes only the text. A turn opened by a `message` task replies
   * to the message that triggered it; a timed fire has no such message and sends
   * standalone. The model never picks a target, so it can never aim one wrong.
   *
   * Resolves the delivered Telegram message id.
   */
  deliver?: (text: string) => Promise<{ messageId: number }>;
  /**
   * Which delivery tool this turn offers, so the tool that is *not* offered can
   * still refuse coherently if a stale registry hands it to the model anyway.
   * `reply` — a `message`-triggered turn, answering the message that opened it.
   * `send` — a timed fire, speaking into the chat unprompted.
   */
  deliveryKind?: "reply" | "send";
}

const STORE_KEY = Symbol.for("llm-tg-bot.mcp.tool-context");

/**
 * The one storage for this process, pinned to `globalThis` like every other
 * cross-bundle singleton here (`server/mcp/runtime.ts`,
 * `server/telegram/bot-manager.ts`).
 *
 * A module-level `AsyncLocalStorage` is one storage *per module instance*, and
 * Next evaluates the same server file in more than one bundle: instrumentation
 * (where the Telegram poller and the task scheduler run) and the app/Route
 * Handler bundle (where the dashboard runs), plus a fresh copy on every dev hot
 * reload. The MCP registry is deliberately a global singleton that outlives all
 * of that, so its tool handlers keep reading whichever copy's storage existed
 * when it was built — while a turn driven from another bundle binds a different
 * one. The turn's chat is then simply not there, and every context-reading tool
 * fails with "no chat is bound" no matter how correctly the pipeline bound it
 * (traces `62e74a24…` `set_message_reaction` and `dd9a9130…` `tasks_create`,
 * 2026-08-14, where the bot told the chat the action was impossible).
 *
 * One storage per process, keyed by a name rather than by module identity,
 * removes the failure mode instead of leaving it to load order.
 */
function storage(): AsyncLocalStorage<McpToolContext> {
  const g = globalThis as typeof globalThis & {
    [STORE_KEY]?: AsyncLocalStorage<McpToolContext>;
  };
  if (!g[STORE_KEY]) g[STORE_KEY] = new AsyncLocalStorage<McpToolContext>();
  return g[STORE_KEY];
}

/** Run `fn` with the given tool context bound for any tool calls it triggers. */
export function runWithToolContext<T>(context: McpToolContext, fn: () => Promise<T>): Promise<T> {
  return storage().run(context, fn);
}

/**
 * The active tool context. Throws when called outside {@link runWithToolContext}
 * — a programming error (a tool ran without the runtime binding a turn).
 */
export function getToolContext(): McpToolContext {
  const context = storage().getStore();
  if (!context) {
    throw new Error("MCP tool called outside a tool context — no chat is bound");
  }
  return context;
}

/**
 * The active tool context, or null when none is bound. For cross-cutting infra
 * (e.g. tool-call trace recording) that runs around every call and should degrade
 * gracefully rather than throw when a call happens outside a turn (e.g. in tests).
 */
export function tryGetToolContext(): McpToolContext | null {
  return storage().getStore() ?? null;
}

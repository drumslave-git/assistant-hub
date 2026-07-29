import "server-only";

import { randomUUID } from "node:crypto";

import { getDb, type DrizzleDb } from "@/db/drizzle";
import { getSettingsRecord } from "@/features/settings/server/repository";
import { ApiError } from "@/lib/api-error";
import { FEATURES } from "@/lib/features";
import { isGroupChatId } from "@/lib/telegram";
import type { TraceTrigger } from "@/lib/trace";
import { publishEvent } from "@/server/realtime/hub";
import { withTrace } from "@/server/trace";

import { alwaysRules, replyRules } from "../format";
import {
  countRulesInScope,
  deleteRule,
  getRuleById,
  getRuleByText,
  insertRule,
  isDuplicateText,
  listAllRules,
  listRulesForChat,
  updateRule,
  type ChatRuleRecord,
} from "./repository";
import {
  MAX_RULES_PER_SCOPE,
  type ChatRule,
  type CreateChatRule,
  type RuleTrigger,
  type UpdateChatRule,
} from "./schema";

/**
 * Chat-rules domain service — the boundary Route Handlers, Server Components,
 * the reply pipeline, and the MCP toolkit call. Owns validation (the per-scope
 * cap, duplicate text), the chat-side permission gate, and trace recording for
 * every mutation. Reads are cheap and untraced.
 *
 * Two ways in, deliberately different:
 *  - the dashboard is operator-only and may author any scope, including the
 *    global one;
 *  - a chat may author only its own rules, gated on who is asking (the
 *    specialists precedent, user decision 2026-07-29): self-serve in a private
 *    chat, owner-only in a group. A denial is *returned*, never thrown, so the
 *    model relays the refusal instead of the turn failing.
 */

const FEATURE = FEATURES["chat-rules"];

/** A stored record is already client-safe. */
function toClient(record: ChatRuleRecord): ChatRule {
  return record;
}

/** The scope label used in trace summaries and refusals. */
function scopeLabel(chatId: string | null): string {
  return chatId === null ? "global" : `chat ${chatId}`;
}

/* --------------------------------- reads ---------------------------------- */

/** Every rule in every scope, oldest first (the dashboard view). */
export async function getChatRulesView(db: DrizzleDb = getDb()): Promise<ChatRule[]> {
  return (await listAllRules(db)).map(toClient);
}

/** Every rule governing one chat — its own plus the global ones. */
export async function getRulesForChat(
  chatId: string,
  db: DrizzleDb = getDb(),
): Promise<ChatRule[]> {
  return (await listRulesForChat(db, chatId)).map(toClient);
}

/**
 * Server-only: the enabled rules composed into a chat's reply prompt, and the
 * subset that may open a turn nobody addressed. Read once per incoming message
 * by the Telegram runtime.
 */
export async function getActiveRulesForChat(
  chatId: string,
  db: DrizzleDb = getDb(),
): Promise<{ reply: ChatRule[]; always: ChatRule[] }> {
  const rules = await getRulesForChat(chatId, db);
  return { reply: replyRules(rules), always: alwaysRules(rules) };
}

/* ------------------------------ dashboard CRUD ----------------------------- */

/** Guard the per-scope cap and duplicate text; throws {@link ApiError}. */
async function assertWritable(
  db: DrizzleDb,
  chatId: string | null,
  text: string,
  exceptId?: string,
): Promise<void> {
  if (!exceptId && (await countRulesInScope(db, chatId)) >= MAX_RULES_PER_SCOPE) {
    throw ApiError.conflict(
      `At most ${MAX_RULES_PER_SCOPE} rules are allowed for ${scopeLabel(chatId)}`,
    );
  }
  if (await isDuplicateText(db, chatId, text, exceptId)) {
    throw ApiError.conflict("That rule already exists here");
  }
}

/** Create a rule, recorded as a trace. Used by the dashboard and the chat path. */
export async function createChatRule(
  input: CreateChatRule & { createdByUserId?: string | null; source?: "chat" | "dashboard" },
  trigger: TraceTrigger,
  db: DrizzleDb = getDb(),
): Promise<ChatRule> {
  return withTrace(
    {
      feature: FEATURE.id,
      action: "create",
      trigger,
      inputSummary: `${scopeLabel(input.chatId)}: ${input.text}`,
    },
    async (trace) => {
      await trace.event({ type: "input", message: "create rule", data: { ...input } });
      await assertWritable(db, input.chatId, input.text);
      const record = await insertRule(db, randomUUID(), {
        chatId: input.chatId,
        text: input.text,
        trigger: input.trigger,
        enabled: input.enabled,
        createdByUserId: input.createdByUserId ?? null,
        source: input.source ?? "dashboard",
      });
      await trace.event({ type: "db", message: "rule created" });
      await trace.succeed({
        outputSummary: record.text,
        relatedIds: { [FEATURE.relatedIdsKey]: [record.id] },
      });
      publishEvent(FEATURE.realtimeTopic);
      return toClient(record);
    },
  );
}

/** Apply a validated update to a rule, recorded as a trace. */
export async function editChatRule(
  id: string,
  input: UpdateChatRule,
  trigger: TraceTrigger,
  db: DrizzleDb = getDb(),
): Promise<ChatRule> {
  return withTrace(
    { feature: FEATURE.id, action: "update", trigger, inputSummary: `rule ${id}` },
    async (trace) => {
      await trace.event({ type: "input", message: "update rule", data: { id, ...input } });
      const existing = await getRuleById(db, id);
      if (!existing) throw ApiError.notFound("Unknown rule");
      if (input.text !== undefined) {
        await assertWritable(db, existing.chatId, input.text, id);
      }
      const record = await updateRule(db, id, input);
      if (!record) throw ApiError.notFound("Unknown rule");
      await trace.event({ type: "db", message: "rule updated" });
      await trace.succeed({
        outputSummary: record.text,
        relatedIds: { [FEATURE.relatedIdsKey]: [record.id] },
      });
      publishEvent(FEATURE.realtimeTopic);
      return toClient(record);
    },
  );
}

/** Delete a rule, recorded as a trace. */
export async function removeChatRule(
  id: string,
  trigger: TraceTrigger,
  db: DrizzleDb = getDb(),
): Promise<void> {
  return withTrace(
    { feature: FEATURE.id, action: "delete", trigger, inputSummary: `rule ${id}` },
    async (trace) => {
      const deleted = await deleteRule(db, id);
      if (!deleted) throw ApiError.notFound("Unknown rule");
      await trace.event({ type: "db", message: "rule deleted" });
      await trace.succeed({
        outputSummary: `deleted ${id}`,
        relatedIds: { [FEATURE.relatedIdsKey]: [id] },
      });
      publishEvent(FEATURE.realtimeTopic);
    },
  );
}

/* ------------------------------- chat-side CRUD ---------------------------- */

/** Outcome of a chat-side write, for the tool to relay. */
export type RuleWriteResult =
  | { status: "created"; rule: ChatRule }
  /**
   * The rule was already there, unchanged — a *success* from the chat's point of
   * view, not the conflict the dashboard gets. Creating from chat is therefore
   * idempotent: "make sure this rule is in force" rather than "insert a row".
   *
   * This exists because the alternative cost a real failure (trace `f33e1ede…`,
   * 2026-07-29). Asked a third time to set the same rule, the model reasoned that
   * calling the tool again "might result in duplicate rules", chose to just
   * confirm in prose, and stored nothing. A tool that punishes a repeat teaches
   * exactly that hesitation, so a repeat now succeeds and says so.
   */
  | { status: "exists"; rule: ChatRule }
  | { status: "updated"; rule: ChatRule }
  | { status: "deleted"; id: string }
  | { status: "denied"; reason: string }
  | { status: "not_found" };

/**
 * May this user manage this chat's rules from inside the chat? Mirrors the
 * specialist switch gate exactly (user decision, 2026-07-29): in a private chat
 * the user manages their own chat's rules; in a group only the configured owner
 * may. Resolves a refusal reason, or null when allowed.
 */
async function denyReason(
  db: DrizzleDb,
  chatId: string,
  userId: string | null,
): Promise<string | null> {
  if (isGroupChatId(chatId)) {
    const ownerUserId = (await getSettingsRecord(db))?.ownerUserId ?? null;
    if (!ownerUserId || !userId || userId !== ownerUserId) {
      return "Only the bot owner can change this group's rules.";
    }
    return null;
  }
  // A private chat's id equals the user id; anything else is not "their own DM".
  if (!userId || userId !== chatId) {
    return "You can only change the rules of your own chat.";
  }
  return null;
}

/**
 * Resolve a rule a chat turn wants to modify. A rule of another chat is
 * invisible (`not_found`, never "forbidden" — the chat has no business learning
 * it exists), and a global rule is visible but read-only from chat.
 */
function resolveTarget(
  record: ChatRuleRecord | null,
  chatId: string,
): { ok: true; record: ChatRuleRecord } | { ok: false; result: RuleWriteResult } {
  if (!record || (record.chatId !== null && record.chatId !== chatId)) {
    return { ok: false, result: { status: "not_found" } };
  }
  if (record.chatId === null) {
    return {
      ok: false,
      result: {
        status: "denied",
        reason:
          "That rule applies to every chat and can only be changed by the operator in the dashboard.",
      },
    };
  }
  return { ok: true, record };
}

/** Create a rule for the current chat from a chat turn, gated and traced. */
export async function createRuleFromChat(
  input: { chatId: string; userId: string | null; text: string; trigger: RuleTrigger },
  traceTrigger: TraceTrigger,
  db: DrizzleDb = getDb(),
): Promise<RuleWriteResult> {
  const denied = await denyReason(db, input.chatId, input.userId);
  if (denied) return { status: "denied", reason: denied };
  // Normalized here rather than trusted from the caller: the duplicate check
  // compares stored text, so untrimmed input from a tool would slip past it and
  // store the "same" rule twice — the exact outcome the idempotence exists to
  // prevent. The API path is trimmed by zod; this covers every path.
  const text = input.text.trim();
  // Idempotent from chat (see `RuleWriteResult.exists`): the same rule again is
  // the state the caller asked for, so report it as reached rather than refused.
  const existing = await getRuleByText(db, input.chatId, text);
  if (existing) return { status: "exists", rule: toClient(existing) };
  const rule = await createChatRule(
    {
      chatId: input.chatId,
      text,
      trigger: input.trigger,
      enabled: true,
      createdByUserId: input.userId,
      source: "chat",
    },
    traceTrigger,
    db,
  );
  return { status: "created", rule };
}

/** Update one of the current chat's rules from a chat turn, gated and traced. */
export async function updateRuleFromChat(
  input: {
    chatId: string;
    userId: string | null;
    id: string;
    patch: UpdateChatRule;
  },
  traceTrigger: TraceTrigger,
  db: DrizzleDb = getDb(),
): Promise<RuleWriteResult> {
  const denied = await denyReason(db, input.chatId, input.userId);
  if (denied) return { status: "denied", reason: denied };
  const target = resolveTarget(await getRuleById(db, input.id), input.chatId);
  if (!target.ok) return target.result;
  const rule = await editChatRule(input.id, input.patch, traceTrigger, db);
  return { status: "updated", rule };
}

/** Delete one of the current chat's rules from a chat turn, gated and traced. */
export async function deleteRuleFromChat(
  input: { chatId: string; userId: string | null; id: string },
  traceTrigger: TraceTrigger,
  db: DrizzleDb = getDb(),
): Promise<RuleWriteResult> {
  const denied = await denyReason(db, input.chatId, input.userId);
  if (denied) return { status: "denied", reason: denied };
  const target = resolveTarget(await getRuleById(db, input.id), input.chatId);
  if (!target.ok) return target.result;
  await removeChatRule(input.id, traceTrigger, db);
  return { status: "deleted", id: input.id };
}

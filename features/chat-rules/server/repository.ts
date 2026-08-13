import "server-only";

import { and, asc, eq, isNull, or, sql } from "drizzle-orm";

import type { DrizzleDb } from "@/db/drizzle";
import { chatRules, type ChatRuleRow } from "@/db/schema";

import type { RuleSource, RuleTrigger } from "./schema";

/**
 * Typed persistence for standing chat rules. Pure data access: no policy, no
 * validation, no trace recording (the service owns those). Every function takes
 * a {@link DrizzleDb} so the same code runs against the pool or a test instance.
 */

/** A rule as stored. */
export interface ChatRuleRecord {
  id: string;
  /** Null for a global rule. */
  chatId: string | null;
  text: string;
  trigger: RuleTrigger;
  enabled: boolean;
  /** Senders the rule is limited to; empty means everyone in the chat. */
  targetUserIds: string[];
  createdByUserId: string | null;
  source: RuleSource;
  createdAt: string;
  updatedAt: string;
}

/** Columns a create may set. */
export interface ChatRuleValues {
  chatId: string | null;
  text: string;
  trigger: RuleTrigger;
  enabled: boolean;
  targetUserIds: string[];
  createdByUserId: string | null;
  source: RuleSource;
}

function mapRow(row: ChatRuleRow): ChatRuleRecord {
  return {
    id: row.id,
    chatId: row.chatId,
    text: row.text,
    trigger: row.trigger as RuleTrigger,
    enabled: row.enabled,
    targetUserIds: row.targetUserIds,
    createdByUserId: row.createdByUserId,
    source: row.source as RuleSource,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** Oldest first — the order the rules were agreed in is the order they read in. */
const byAge = [asc(chatRules.createdAt)];

/** Every rule in every scope (the dashboard's full view). */
export async function listAllRules(db: DrizzleDb): Promise<ChatRuleRecord[]> {
  const rows = await db.query.chatRules.findMany({ orderBy: byAge });
  return rows.map(mapRow);
}

/**
 * The rules that govern one chat: its own, plus every global rule. Used by the
 * reply pipeline and by the chat-side tools, so both see the same set.
 */
export async function listRulesForChat(
  db: DrizzleDb,
  chatId: string,
): Promise<ChatRuleRecord[]> {
  const rows = await db.query.chatRules.findMany({
    where: or(eq(chatRules.chatId, chatId), isNull(chatRules.chatId)),
    orderBy: byAge,
  });
  return rows.map(mapRow);
}

/** The rules of exactly one scope — one chat's own, or the global set. */
export async function listRulesInScope(
  db: DrizzleDb,
  chatId: string | null,
): Promise<ChatRuleRecord[]> {
  const rows = await db.query.chatRules.findMany({
    where: chatId === null ? isNull(chatRules.chatId) : eq(chatRules.chatId, chatId),
    orderBy: byAge,
  });
  return rows.map(mapRow);
}

/** One rule by id, or null. */
export async function getRuleById(db: DrizzleDb, id: string): Promise<ChatRuleRecord | null> {
  const row = await db.query.chatRules.findFirst({ where: eq(chatRules.id, id) });
  return row ? mapRow(row) : null;
}

/** Number of rules in one scope (for the per-scope cap). */
export async function countRulesInScope(
  db: DrizzleDb,
  chatId: string | null,
): Promise<number> {
  const rows = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(chatRules)
    .where(chatId === null ? isNull(chatRules.chatId) : eq(chatRules.chatId, chatId));
  return rows[0]?.n ?? 0;
}

/**
 * Whether the same rule text already exists in a scope (case-insensitive),
 * optionally excluding one id. Duplicate rules are not an error the DB can
 * express — the same instruction twice is just noise in every prompt.
 */
export async function isDuplicateText(
  db: DrizzleDb,
  chatId: string | null,
  text: string,
  exceptId?: string,
): Promise<boolean> {
  const scope = chatId === null ? isNull(chatRules.chatId) : eq(chatRules.chatId, chatId);
  const parts = [scope, sql`lower(${chatRules.text}) = lower(${text})`];
  if (exceptId) parts.push(sql`${chatRules.id} <> ${exceptId}`);
  const rows = await db
    .select({ id: chatRules.id })
    .from(chatRules)
    .where(and(...parts))
    .limit(1);
  return rows.length > 0;
}

/**
 * The rule with this exact text in a scope (case-insensitive), or null. Lets the
 * chat path answer "that rule is already in force" with the rule itself instead
 * of a bare conflict.
 */
export async function getRuleByText(
  db: DrizzleDb,
  chatId: string | null,
  text: string,
): Promise<ChatRuleRecord | null> {
  const scope = chatId === null ? isNull(chatRules.chatId) : eq(chatRules.chatId, chatId);
  const rows = await db
    .select()
    .from(chatRules)
    .where(and(scope, sql`lower(${chatRules.text}) = lower(${text})`))
    .limit(1);
  return rows[0] ? mapRow(rows[0]) : null;
}

/** Insert a rule with an app-generated id. Returns the stored record. */
export async function insertRule(
  db: DrizzleDb,
  id: string,
  values: ChatRuleValues,
): Promise<ChatRuleRecord> {
  const now = new Date();
  const [row] = await db
    .insert(chatRules)
    .values({ id, ...values, createdAt: now, updatedAt: now })
    .returning();
  return mapRow(row);
}

/** Apply a patch to one rule. Returns the updated record, or null if unknown. */
export async function updateRule(
  db: DrizzleDb,
  id: string,
  patch: Partial<Pick<ChatRuleValues, "text" | "trigger" | "enabled" | "targetUserIds">>,
): Promise<ChatRuleRecord | null> {
  const [row] = await db
    .update(chatRules)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(chatRules.id, id))
    .returning();
  return row ? mapRow(row) : null;
}

/** Delete one rule. Returns true if a row was removed. */
export async function deleteRule(db: DrizzleDb, id: string): Promise<boolean> {
  const rows = await db.delete(chatRules).where(eq(chatRules.id, id)).returning({
    id: chatRules.id,
  });
  return rows.length > 0;
}

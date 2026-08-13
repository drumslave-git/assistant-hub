import { z } from "zod";

import { isGroupChatId } from "@/lib/telegram";

/**
 * Chat-rules validation contract — the single source of truth for the shape of a
 * standing rule. Shared by the service, Route Handlers, the MCP toolkit, and the
 * dashboard. Pure (no `server-only`) so tests build inputs against the same
 * schema the handlers parse.
 */

/** Per-scope cap: one chat's own rules, and the global set, each bounded. */
export const MAX_RULES_PER_SCOPE = 32;
/** A rule is an instruction, not a document — the model has to hold all of them. */
export const MAX_RULE_TEXT_LEN = 1_000;
/**
 * How many people one rule may single out. A rule naming more of a group than
 * this is a rule for the group, and the picker it is chosen from is a roster.
 */
export const MAX_RULE_TARGETS = 16;

/**
 * `on-reply` — applies to turns the bot already answers (every private message,
 * an addressed group message). `always` — may additionally act on a group
 * message that never addressed the bot, at the cost of one classification call
 * per unaddressed message in chats that have one (user decision, 2026-07-29).
 */
export const RULE_TRIGGERS = ["on-reply", "always"] as const;
export type RuleTrigger = (typeof RULE_TRIGGERS)[number];

/** Where a rule was authored, kept as provenance. */
export const RULE_SOURCES = ["chat", "dashboard"] as const;
export type RuleSource = (typeof RULE_SOURCES)[number];

const ruleText = z
  .string()
  .trim()
  .min(1, "Rule text is required")
  .max(MAX_RULE_TEXT_LEN, `A rule must be at most ${MAX_RULE_TEXT_LEN} characters`);
const trigger = z.enum(RULE_TRIGGERS);
/** Null means the global scope (applies in every chat). */
const chatId = z.string().trim().min(1).nullable();
/**
 * Whose messages a rule applies to: empty for everyone in the chat. Normalized
 * here (trimmed, de-duplicated, order of appearance kept) so every path stores
 * the same list for the same intent and two equal target sets compare equal.
 */
const targetUserIds = z
  .array(z.string().trim().min(1))
  .max(MAX_RULE_TARGETS, `A rule can name at most ${MAX_RULE_TARGETS} people`)
  .transform((ids) => [...new Set(ids)]);

/** Only a group rule may name senders — see {@link TARGETS_SCOPE_MESSAGE}. */
export const TARGETS_SCOPE_MESSAGE =
  "Only a rule scoped to a group chat can be limited to specific people";

/**
 * Reject targets on a scope that has nobody to choose between: the global set
 * (its chats share no roster) and a DM (one person is already the whole chat).
 */
function checkTargetScope(
  value: { chatId: string | null; targetUserIds: string[] },
  ctx: z.RefinementCtx,
): void {
  if (value.targetUserIds.length === 0) return;
  if (value.chatId !== null && isGroupChatId(value.chatId)) return;
  ctx.addIssue({ code: "custom", path: ["targetUserIds"], message: TARGETS_SCOPE_MESSAGE });
}

/** A rule as returned to clients (nothing secret involved). */
export const chatRuleSchema = z.object({
  id: z.string(),
  chatId: z.string().nullable(),
  text: z.string(),
  trigger,
  enabled: z.boolean(),
  /** Empty means every sender in the chat. */
  targetUserIds: z.array(z.string()),
  createdByUserId: z.string().nullable(),
  source: z.enum(RULE_SOURCES),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export type ChatRule = z.infer<typeof chatRuleSchema>;

/** Create input. `chatId: null` is the global scope (dashboard only). */
export const createChatRuleSchema = z
  .object({
    chatId: chatId.optional().default(null),
    text: ruleText,
    trigger: trigger.optional().default("on-reply"),
    enabled: z.boolean().optional().default(true),
    targetUserIds: targetUserIds.default([]),
  })
  .superRefine(checkTargetScope);

export type CreateChatRule = z.infer<typeof createChatRuleSchema>;

/**
 * Update input: any subset of the editable fields; at least one required. The
 * scope is not editable — moving a rule between chats is a delete plus a create,
 * so a rule's chat can never change under the people who agreed to it. Who it
 * applies to *is* editable: adding or dropping a person is an ordinary amendment
 * within the same chat, and the scope check runs against the stored chat in the
 * service (the patch alone does not know it).
 */
export const updateChatRuleSchema = z
  .object({ text: ruleText, trigger, enabled: z.boolean(), targetUserIds })
  .partial()
  .refine((v) => Object.keys(v).length > 0, {
    message: "Provide at least one field to update",
  });

export type UpdateChatRule = z.infer<typeof updateChatRuleSchema>;

/** Dashboard list filter: one chat's rules, the global set, or everything. */
export const listChatRulesQuerySchema = z.object({
  chatId: z.string().optional(),
});

export type ListChatRulesQuery = z.infer<typeof listChatRulesQuerySchema>;

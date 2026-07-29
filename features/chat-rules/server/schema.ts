import { z } from "zod";

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

/** A rule as returned to clients (nothing secret involved). */
export const chatRuleSchema = z.object({
  id: z.string(),
  chatId: z.string().nullable(),
  text: z.string(),
  trigger,
  enabled: z.boolean(),
  createdByUserId: z.string().nullable(),
  source: z.enum(RULE_SOURCES),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export type ChatRule = z.infer<typeof chatRuleSchema>;

/** Create input. `chatId: null` is the global scope (dashboard only). */
export const createChatRuleSchema = z.object({
  chatId: chatId.optional().default(null),
  text: ruleText,
  trigger: trigger.optional().default("on-reply"),
  enabled: z.boolean().optional().default(true),
});

export type CreateChatRule = z.infer<typeof createChatRuleSchema>;

/**
 * Update input: any subset of the editable fields; at least one required. The
 * scope is not editable — moving a rule between chats is a delete plus a create,
 * so a rule's chat can never change under the people who agreed to it.
 */
export const updateChatRuleSchema = z
  .object({ text: ruleText, trigger, enabled: z.boolean() })
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

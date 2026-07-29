import "server-only";

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { ApiError } from "@/lib/api-error";
import type { TraceTrigger } from "@/lib/trace";
import { getToolContext } from "@/server/mcp/context";

import { triggerLabel } from "../format";
import {
  MAX_RULE_TEXT_LEN,
  RULE_TRIGGERS,
  type ChatRule,
  type RuleTrigger,
} from "./schema";
import {
  createRuleFromChat,
  deleteRuleFromChat,
  getRulesForChat,
  updateRuleFromChat,
  type RuleWriteResult,
} from "./service";

/**
 * The chat-rules toolkit, exposed as MCP tools: how the people in a chat give
 * the bot a standing rule ("from now on, whenever X, do Y") and manage the rules
 * they already gave it, in their own words, without the dashboard.
 *
 * The chat is bound per turn via the tool context, so a rule can only ever be
 * written for the current conversation. Who may write is enforced **inside** the
 * service (no lexical pre-filter): self-serve in a private chat, owner-only in a
 * group; a denied caller gets a refusal the model relays. Global rules are
 * visible here and editable only in the dashboard.
 */

export const RULES_LIST_TOOL = "rules_list";
export const RULES_CREATE_TOOL = "rules_create";
export const RULES_UPDATE_TOOL = "rules_update";
export const RULES_DELETE_TOOL = "rules_delete";

export const CHAT_RULES_TOOL_NAMES = [
  RULES_LIST_TOOL,
  RULES_CREATE_TOOL,
  RULES_UPDATE_TOOL,
  RULES_DELETE_TOOL,
];

/**
 * What `rules_create` has to teach a small model, kept as a constant so the
 * live tool-selection test can pin it. Four jobs:
 *
 * 1. Recognize the many ways a standing instruction is phrased — few users say
 *    "rule".
 * 2. Separate it from the two neighbouring tools it is otherwise confused with:
 *    a fact about a person is memory; something that happens at a *time* is a
 *    scheduled task.
 * 3. Pick the trigger mode from whether the rule must fire on messages nobody
 *    sent to the bot.
 * 4. Remove the two beliefs that talked a model out of calling it at all (trace
 *    `f33e1ede…`, 2026-07-29): that its own earlier "got it, I'll do that" in
 *    the transcript meant the rule was already stored, and that calling again
 *    would create duplicates. Its reasoning states both, in those words, having
 *    correctly worked out that it *should* call the tool. So the description now
 *    says a repeat is safe, that a repeated instruction is a signal the person
 *    does not believe you, and that the only way to know what is stored is
 *    `rules_list` — never your own past message.
 */
export const RULES_CREATE_DESCRIPTION =
  "Save a standing rule for THIS chat — an instruction about how you must behave here from now on, " +
  "which you then follow in every future message without being reminded. Use it whenever someone " +
  "sets one, however they phrase it: \"new rule: …\", \"from now on …\", \"always …\", \"never … " +
  "again\", \"whenever someone sends X, do Y\", \"stop doing X\", \"remember to always …\". Write " +
  "the rule as a complete, self-contained instruction to yourself, spelling out the trigger and the " +
  "action in full — it is read later without this conversation, so it must make sense alone. This " +
  "is NOT for facts about people (that is the memory tool) and NOT for anything that should happen " +
  "at a particular time or on a schedule (that is the scheduled-task tool). Set trigger to " +
  "\"always\" when the rule must act on messages that were not sent to you — anything of the form " +
  "\"any time someone posts/sends X, do Y\"; use \"on-reply\" when the rule only shapes how you " +
  "answer when someone does talk to you. " +
  "ALWAYS call this tool when a rule is set, even if the conversation already contains you saying " +
  "you would follow it: a message of yours agreeing to a rule is NOT the rule being saved, and a " +
  "rule that was never stored through this tool does not exist no matter how many times you " +
  "promised it. Someone repeating the same instruction is telling you they do not believe it took " +
  "effect — call the tool, do not reassure them again. Calling it twice is safe and costs nothing: " +
  "a rule that is already there is left exactly as it is and the result says so, so never skip the " +
  "call to avoid duplicating a rule. If you want to know what is actually stored, call rules_list — " +
  "that result is the only evidence; your own earlier messages are not. " +
  "Tell the person what rule you saved once it is stored.";

function textResult(text: string, structured?: Record<string, unknown>) {
  return { content: [{ type: "text" as const, text }], structuredContent: structured };
}

function errorResult(text: string) {
  return { content: [{ type: "text" as const, text }], isError: true as const };
}

/** Map an ApiError (cap, duplicate, unknown id) to a tool error the model relays. */
function toToolError(err: unknown): ReturnType<typeof errorResult> | null {
  if (err instanceof ApiError) return errorResult(err.message);
  return null;
}

/** The trigger for a rule mutation traced from a chat turn. */
function toolTrigger(chatId: string, userId?: string | null): TraceTrigger {
  return { kind: "telegram", actor: userId ?? chatId, correlationId: chatId };
}

/** Structured view of a rule returned alongside the text result. */
function ruleView(rule: ChatRule) {
  return {
    id: rule.id,
    text: rule.text,
    trigger: rule.trigger,
    enabled: rule.enabled,
    scope: rule.chatId === null ? "global" : "this_chat",
    created_at: rule.createdAt,
  };
}

/** One rule as a compact line the model can read back to the chat. */
function ruleLine(rule: ChatRule): string {
  const flags = [triggerLabel(rule.trigger)];
  if (!rule.enabled) flags.push("disabled");
  if (rule.chatId === null) flags.push("every chat");
  return `${rule.id} [${flags.join(", ")}]: ${rule.text}`;
}

/** Relay a chat-side write outcome, or null when it succeeded. */
function relayFailure(result: RuleWriteResult): ReturnType<typeof errorResult> | null {
  if (result.status === "denied") return errorResult(result.reason);
  if (result.status === "not_found") {
    return errorResult(
      "No rule with that id exists in this chat. List the rules first and use an exact id.",
    );
  }
  return null;
}

/** Register the chat-rules MCP tools on the shared server. */
export function registerChatRulesMcpTools(server: McpServer): void {
  server.registerTool(
    RULES_LIST_TOOL,
    {
      title: "List chat rules",
      description:
        "List the standing rules currently in force in THIS chat, with their ids — the ones set " +
        "here, plus any the operator set for every chat. Use it when someone asks what rules you " +
        "have, what you were told to do, or before changing or removing a rule (you need its id). " +
        "Rules marked as applying to every chat cannot be changed from here.",
      inputSchema: {},
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () => {
      const ctx = getToolContext();
      const rules = await getRulesForChat(ctx.chatId);
      const text = rules.length === 0 ? "(no rules are set for this chat)" : rules.map(ruleLine).join("\n");
      return textResult(text, { ok: true, count: rules.length, rules: rules.map(ruleView) });
    },
  );

  server.registerTool(
    RULES_CREATE_TOOL,
    {
      title: "Create chat rule",
      description: RULES_CREATE_DESCRIPTION,
      inputSchema: {
        text: z
          .string()
          .min(1)
          .max(MAX_RULE_TEXT_LEN)
          .describe(
            "The rule as a complete instruction to yourself, naming both what triggers it and what " +
              "you must do — understandable on its own, without this conversation",
          ),
        trigger: z
          .enum(RULE_TRIGGERS)
          .default("on-reply")
          .describe(
            "\"always\" when the rule must act on messages nobody addressed to you; \"on-reply\" " +
              "when it only shapes your answers to people talking to you",
          ),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ text, trigger }) => {
      const ctx = getToolContext();
      try {
        const result = await createRuleFromChat(
          {
            chatId: ctx.chatId,
            userId: ctx.userId ?? null,
            text: text.trim(),
            trigger: trigger as RuleTrigger,
          },
          toolTrigger(ctx.chatId, ctx.userId),
        );
        const failure = relayFailure(result);
        if (failure) return failure;
        // A repeat is a success, not a conflict — the asked-for state is in force.
        if (result.status === "exists") {
          return textResult(
            `That rule is already in force for this chat (${triggerLabel(result.rule.trigger)}), ` +
              `unchanged: ${result.rule.text}`,
            { ok: true, rule: ruleView(result.rule), already_present: true },
          );
        }
        if (result.status !== "created") return errorResult("The rule could not be saved.");
        return textResult(
          `Rule saved for this chat (${triggerLabel(result.rule.trigger)}): ${result.rule.text}`,
          { ok: true, rule: ruleView(result.rule) },
        );
      } catch (err) {
        const mapped = toToolError(err);
        if (mapped) return mapped;
        throw err;
      }
    },
  );

  server.registerTool(
    RULES_UPDATE_TOOL,
    {
      title: "Update chat rule",
      description:
        "Change one of THIS chat's existing rules by its id — reword it, change when it fires, or " +
        "switch it off without deleting it (set enabled to false to pause a rule, true to bring it " +
        "back). Use it when someone amends a rule they already set rather than adding a new one. " +
        "List the rules first to get the id; only the fields you pass are changed.",
      inputSchema: {
        id: z.string().min(1).describe("Rule id to change"),
        text: z
          .string()
          .max(MAX_RULE_TEXT_LEN)
          .default("")
          .describe("New rule text, complete and self-contained (leave empty to keep it)"),
        trigger: z
          .enum(["on-reply", "always", ""])
          .default("")
          .describe("New trigger mode (optional)"),
        enabled: z
          .boolean()
          .nullable()
          .default(null)
          .describe("false to pause the rule, true to reactivate it (optional)"),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ id, text, trigger, enabled }) => {
      const ctx = getToolContext();
      const patch = {
        ...(text.trim() ? { text: text.trim() } : {}),
        ...(trigger ? { trigger: trigger as RuleTrigger } : {}),
        ...(enabled === null ? {} : { enabled }),
      };
      if (Object.keys(patch).length === 0) {
        return errorResult(
          "Nothing to change — pass the new text, a new trigger mode, or enabled true/false.",
        );
      }
      try {
        const result = await updateRuleFromChat(
          { chatId: ctx.chatId, userId: ctx.userId ?? null, id, patch },
          toolTrigger(ctx.chatId, ctx.userId),
        );
        const failure = relayFailure(result);
        if (failure) return failure;
        if (result.status !== "updated") return errorResult("The rule could not be changed.");
        const state = result.rule.enabled ? "active" : "paused";
        return textResult(
          `Rule updated (${triggerLabel(result.rule.trigger)}, ${state}): ${result.rule.text}`,
          { ok: true, rule: ruleView(result.rule) },
        );
      } catch (err) {
        const mapped = toToolError(err);
        if (mapped) return mapped;
        throw err;
      }
    },
  );

  server.registerTool(
    RULES_DELETE_TOOL,
    {
      title: "Delete chat rule",
      description:
        "Remove one of THIS chat's rules for good by its id — use it when someone cancels a rule " +
        "(\"forget that rule\", \"stop doing that\", \"drop the rule about X\"). To pause a rule " +
        "instead of losing it, update it with enabled false. List the rules first to get the id.",
      inputSchema: { id: z.string().min(1).describe("Rule id to delete") },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ id }) => {
      const ctx = getToolContext();
      try {
        const result = await deleteRuleFromChat(
          { chatId: ctx.chatId, userId: ctx.userId ?? null, id },
          toolTrigger(ctx.chatId, ctx.userId),
        );
        const failure = relayFailure(result);
        if (failure) return failure;
        return textResult(`Rule ${id} deleted — it no longer applies here.`, { ok: true, id });
      } catch (err) {
        const mapped = toToolError(err);
        if (mapped) return mapped;
        throw err;
      }
    },
  );
}

import "server-only";

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { ApiError } from "@/lib/api-error";
import type { TraceTrigger } from "@/lib/trace";
import { getToolContext } from "@/server/mcp/context";

import {
  MAX_COLLECTION_LEN,
  MAX_QUERY_RESULTS,
  type Specialist,
  type SpecialistEntry,
} from "./schema";
import {
  deleteEntry,
  getActiveSpecialist,
  getSpecialistsView,
  queryEntriesForChat,
  saveEntry,
  switchSpecialistFromChat,
  updateEntry,
} from "./service";

/**
 * The shared specialist toolkit, exposed as MCP tools. One generic data toolkit
 * over the unified entry store — no per-specialist tables or code (the skills
 * model: instructions over shared tools; user decision, 2026-07-27). The chat is
 * bound per turn via the tool context; which specialist's data a tool touches —
 * and whether reads are chat-siloed or shared across chats — comes from the
 * chat's active specialist and its data-scope flag, resolved in the service.
 *
 * Always registered (the registry convention): with no specialist active in the
 * current chat, the data tools return a clear "no specialist is active in this
 * chat" result instead of guessing. Switching is self-serve in a private chat
 * and owner-only in groups, enforced **inside** the switch tool (no lexical
 * pre-filter) — a denied caller gets a refusal the model relays.
 */

export const SPECIALIST_SAVE_TOOL = "specialist_save_entry";
export const SPECIALIST_QUERY_TOOL = "specialist_query_entries";
export const SPECIALIST_UPDATE_TOOL = "specialist_update_entry";
export const SPECIALIST_DELETE_TOOL = "specialist_delete_entry";
export const SPECIALIST_SWITCH_TOOL = "specialist_switch";
export const SPECIALIST_LIST_TOOL = "specialist_list";

export const SPECIALISTS_TOOL_NAMES = [
  SPECIALIST_SAVE_TOOL,
  SPECIALIST_QUERY_TOOL,
  SPECIALIST_UPDATE_TOOL,
  SPECIALIST_DELETE_TOOL,
  SPECIALIST_SWITCH_TOOL,
  SPECIALIST_LIST_TOOL,
];

function textResult(text: string, structured?: Record<string, unknown>) {
  return { content: [{ type: "text" as const, text }], structuredContent: structured };
}

function errorResult(text: string) {
  return { content: [{ type: "text" as const, text }], isError: true as const };
}

/** Map an ApiError (validation/not-found/cap) to a tool error the model can relay. */
function toToolError(err: unknown): ReturnType<typeof errorResult> | null {
  if (err instanceof ApiError) return errorResult(err.message);
  return null;
}

/** The trigger for a specialist mutation traced from a chat turn. */
function toolTrigger(chatId: string, userId?: string | null): TraceTrigger {
  return { kind: "telegram", actor: userId ?? chatId, correlationId: chatId };
}

/** The no-active-specialist result every data tool returns when unscoped. */
function noActiveSpecialist() {
  return textResult(
    "No specialist is active in this chat. Data can be stored or read only while a specialist is active.",
    { ok: false, reason: "no_active_specialist" },
  );
}

/** Structured view of an entry returned alongside the text result. */
function entryView(entry: SpecialistEntry) {
  return {
    id: entry.id,
    collection: entry.collection,
    payload: entry.payload,
    chat_id: entry.chatId,
    author_user_id: entry.authorUserId,
    created_at: entry.createdAt,
    updated_at: entry.updatedAt,
  };
}

/** One entry as a compact text line the model can read back. */
function entryLine(entry: SpecialistEntry): string {
  return `${entry.id} [${entry.collection}] ${entry.createdAt}: ${JSON.stringify(entry.payload)}`;
}

/** Resolve the current chat's active specialist, or null. */
async function activeSpecialist(): Promise<{ specialist: Specialist | null; chatId: string; userId: string | null }> {
  const ctx = getToolContext();
  const specialist = await getActiveSpecialist(ctx.chatId);
  return { specialist, chatId: ctx.chatId, userId: ctx.userId ?? null };
}

/** Register the specialist toolkit MCP tools on the shared server. */
export function registerSpecialistsMcpTools(server: McpServer): void {
  server.registerTool(
    SPECIALIST_SAVE_TOOL,
    {
      title: "Save specialist entry",
      description:
        "Store one data entry for THIS chat's active specialist role — a journal note, a list " +
        "item, a plan, or any other record the active role's instructions call for. Pick a short " +
        "lowercase 'collection' label that groups similar entries (for example journal, " +
        "groceries, plans) and reuse the same label for the same kind of data. 'payload' is a " +
        "JSON object whose fields you choose; keep them consistent within a collection. Fails " +
        "with a clear message when no specialist is active in this chat.",
      inputSchema: {
        collection: z
          .string()
          .min(1)
          .max(MAX_COLLECTION_LEN)
          .describe("Short grouping label for this kind of entry (reuse existing labels)"),
        payload: z
          .record(z.string(), z.unknown())
          .describe("The entry body as a JSON object; you choose the fields"),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ collection, payload }) => {
      const { specialist, chatId, userId } = await activeSpecialist();
      if (!specialist) return noActiveSpecialist();
      try {
        const entry = await saveEntry(
          {
            specialist,
            chatId,
            authorUserId: userId,
            collection: collection.trim().toLowerCase(),
            payload,
          },
          toolTrigger(chatId, userId),
        );
        return textResult(`Saved entry ${entry.id} in "${entry.collection}".`, {
          ok: true,
          entry: entryView(entry),
        });
      } catch (err) {
        const mapped = toToolError(err);
        if (mapped) return mapped;
        throw err;
      }
    },
  );

  server.registerTool(
    SPECIALIST_QUERY_TOOL,
    {
      title: "Query specialist entries",
      description:
        "Read the stored data entries of THIS chat's active specialist role — use it before " +
        "answering any question about what was previously saved (journal history, current list " +
        "items, plans and their progress). Optionally narrow by 'collection' label and/or a " +
        "'contains' text filter matched against the entry content. Returns newest entries first " +
        `(at most ${MAX_QUERY_RESULTS}) with their ids and full payloads, plus the collection ` +
        "labels that exist. Fails with a clear message when no specialist is active in this chat.",
      inputSchema: {
        collection: z.string().default("").describe("Only entries with this collection label (optional)"),
        contains: z.string().default("").describe("Only entries whose content contains this text (optional)"),
        limit: z
          .number()
          .int()
          .min(1)
          .max(MAX_QUERY_RESULTS)
          .default(MAX_QUERY_RESULTS)
          .describe("Maximum entries to return"),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ collection, contains, limit }) => {
      const { specialist, chatId } = await activeSpecialist();
      if (!specialist) return noActiveSpecialist();
      const { entries, collections } = await queryEntriesForChat({
        specialist,
        chatId,
        collection: collection.trim() ? collection.trim().toLowerCase() : undefined,
        contains: contains.trim() ? contains.trim() : undefined,
        limit,
      });
      const text =
        entries.length === 0
          ? `(no matching entries)${collections.length > 0 ? ` Existing collections: ${collections.join(", ")}` : ""}`
          : entries.map(entryLine).join("\n");
      return textResult(text, {
        ok: true,
        count: entries.length,
        collections,
        entries: entries.map(entryView),
      });
    },
  );

  server.registerTool(
    SPECIALIST_UPDATE_TOOL,
    {
      title: "Update specialist entry",
      description:
        "Replace the payload of one stored entry of THIS chat's active specialist role by its " +
        "id — for marking progress, correcting a record, or changing a quantity. The new " +
        "'payload' object replaces the old one entirely, so include every field that should " +
        "remain. Read the entries first to get the id and current payload. Fails with a clear " +
        "message when no specialist is active in this chat.",
      inputSchema: {
        id: z.string().min(1).describe("Entry id to update"),
        payload: z
          .record(z.string(), z.unknown())
          .describe("The full replacement payload as a JSON object"),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ id, payload }) => {
      const { specialist, chatId, userId } = await activeSpecialist();
      if (!specialist) return noActiveSpecialist();
      try {
        const entry = await updateEntry(
          { specialist, chatId, id, payload },
          toolTrigger(chatId, userId),
        );
        return textResult(`Updated entry ${entry.id}.`, { ok: true, entry: entryView(entry) });
      } catch (err) {
        const mapped = toToolError(err);
        if (mapped) return mapped;
        throw err;
      }
    },
  );

  server.registerTool(
    SPECIALIST_DELETE_TOOL,
    {
      title: "Delete specialist entry",
      description:
        "Delete one stored entry of THIS chat's active specialist role by its id — for items " +
        "that are done, bought, or no longer needed. Read the entries first to get the id. " +
        "Fails with a clear message when no specialist is active in this chat.",
      inputSchema: { id: z.string().min(1).describe("Entry id to delete") },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ id }) => {
      const { specialist, chatId, userId } = await activeSpecialist();
      if (!specialist) return noActiveSpecialist();
      try {
        await deleteEntry({ specialist, chatId, id }, toolTrigger(chatId, userId));
        return textResult(`Deleted entry ${id}.`, { ok: true, id });
      } catch (err) {
        const mapped = toToolError(err);
        if (mapped) return mapped;
        throw err;
      }
    },
  );

  server.registerTool(
    SPECIALIST_LIST_TOOL,
    {
      title: "List specialists",
      description:
        "List the available specialist roles the bot can take on in a chat — their names, what " +
        "each is for, and which one (if any) is currently active in THIS chat. Use it when " +
        "someone asks what specialists/roles/modes exist or which one is active.",
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
      const [view, active] = await Promise.all([
        getSpecialistsView(),
        getActiveSpecialist(ctx.chatId),
      ]);
      const lines = view.specialists.map((s) => {
        const marker = active?.id === s.id ? " (active in this chat)" : "";
        return `${s.name}${marker}: ${s.description || "(no description)"}`;
      });
      const text =
        lines.length === 0 ? "(no specialists are defined)" : lines.join("\n");
      return textResult(text, {
        ok: true,
        active: active ? { id: active.id, name: active.name } : null,
        specialists: view.specialists.map((s) => ({
          id: s.id,
          name: s.name,
          description: s.description,
        })),
      });
    },
  );

  server.registerTool(
    SPECIALIST_SWITCH_TOOL,
    {
      title: "Switch specialist",
      description:
        "Activate a specialist role for THIS chat by its name, or deactivate the current one " +
        "(pass an empty name) — use when someone asks to enable, switch to, or turn off a " +
        "specialist/role/mode. In a private chat the user controls their own chat's specialist; " +
        "in a group only the bot owner may switch, and anyone else is refused — relay the " +
        "refusal politely.",
      inputSchema: {
        name: z
          .string()
          .default("")
          .describe("Specialist name to activate; empty to deactivate the current one"),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ name }) => {
      const ctx = getToolContext();
      const result = await switchSpecialistFromChat(
        {
          chatId: ctx.chatId,
          userId: ctx.userId ?? null,
          specialistName: name.trim() ? name.trim() : null,
        },
        toolTrigger(ctx.chatId, ctx.userId),
      );
      switch (result.status) {
        case "switched":
          return textResult(
            `Specialist "${result.specialist.name}" is now active in this chat.`,
            { ok: true, active: { id: result.specialist.id, name: result.specialist.name } },
          );
        case "cleared":
          return textResult("Specialist deactivated — this chat is back to the default behavior.", {
            ok: true,
            active: null,
          });
        case "not_found":
          return errorResult(
            `No specialist named "${result.name}" exists. Check the available specialists and use an exact name.`,
          );
        case "denied":
          return errorResult(result.reason);
      }
    },
  );
}

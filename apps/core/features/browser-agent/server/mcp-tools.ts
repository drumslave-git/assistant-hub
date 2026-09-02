import "server-only";

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { scopedRef } from "@assistant-hub-swarm/contracts";

import { isGroupChat } from "@/features/known-groups/server/repository";
import { getToolContext } from "@/server/mcp/context";

import { enqueueBrowserRun } from "./service";
import { emitRunEnqueued } from "./signal";

/**
 * The browser agent exposed as a single MCP tool. `browse_web` enqueues a
 * background run: a sub-agent LLM drives a full browser (search, navigate, click,
 * type, scroll, read, screenshot, download) to accomplish the goal, then reports
 * back to this chat. The chat model calls this and moves on — it does not drive the
 * browser itself (recorded decision: background run, not inline).
 *
 * This is the bot's ONLY web-facing tool (user decision, 2026-07-26): the earlier
 * `search_web` (Tavily snippets) and `read_web_page` (one-shot page read) tools are
 * gone, because a real browser does both better and two weaker alternatives only
 * split the model's choice. Searching now happens inside a run, on live search
 * engines, with the Tavily API kept as the last-resort fallback there.
 *
 * The generic browser tools the run uses are NOT MCP tools and are never offered
 * here; only this dispatch tool is. Anyone may start a run; the download tool
 * inside the run is gated to owner-started runs (resolved at enqueue time).
 */

export const BROWSE_WEB_TOOL = "browse_web";

export const BROWSER_AGENT_TOOL_NAMES = [BROWSE_WEB_TOOL];

const BROWSE_WEB_DESCRIPTION =
  "Start a background web agent that opens a REAL browser and does everything on the web for you: " +
  "SEARCH the web, open and read any page, follow links, click, fill forms, read a page's LIVE " +
  "rendered values, AND download files (documents, images, videos, archives) to send to the user. " +
  "This is the ONLY way you can reach the internet. " +
  "You CAN get a file for the user through this tool — when a user gives you a link and asks you " +
  "to download / save / grab / fetch it (or the video/image/file on it), call this tool: never " +
  "reply that you are 'just a language model' or 'cannot download files' — that refusal is wrong. " +
  "MUST call when the user: (a) asks you to look something up or check what is online; (b) shares " +
  "a URL, or asks about a page whose URL is in the conversation — read it instead of answering " +
  "from memory; (c) asks to download or save a file, video, image, or document; (d) names a site " +
  "or service to get data FROM ('on <site>', 'check <site>'); (e) wants a LIVE or CURRENT value — " +
  "weather, a price, a rate, live stats or counts, availability, today's news — your own " +
  "knowledge is stale; (f) needs any multi-step interaction on the web. " +
  "Do NOT call for casual chat, an opinion, or a stable fact you already know well and the user " +
  "did not ask you to verify (a definition, a historical date, arithmetic). " +
  "Write the goal as a clear, self-contained instruction and INCLUDE ALL links, site names, and " +
  "search terms the user gave, links copied character-for-character — the agent starts from " +
  "nothing but this text. Pass on what was actually asked and add NO easier alternative: never " +
  "'or describe it' / 'or explain how to get it' — the agent takes any alternative as permission " +
  "to stop early, so a request for a file comes back as a paragraph about the file. A download " +
  "goal must say plainly that the file is to be downloaded, and whether audio or video. " +
  "The agent reports back to this chat itself when done (this may take a while), so just tell " +
  "the user you're on it; do not invent results.";

/** Register the browser-agent MCP tool on the shared server. */
export function registerBrowserAgentMcpTools(server: McpServer): void {
  server.registerTool(
    BROWSE_WEB_TOOL,
    {
      title: "Browse the web",
      description: BROWSE_WEB_DESCRIPTION,
      inputSchema: {
        goal: z
          .string()
          .min(4)
          .max(4000)
          .describe(
            "A clear, self-contained description of what to find or do on the web. Include ALL links the user gave. Keep the user's request intact — never add a weaker alternative such as 'or tell me about it', which lets the agent stop before doing the work.",
          ),
      },
      outputSchema: {
        ok: z.boolean(),
        runId: z.string().optional(),
      },
      annotations: {
        readOnlyHint: false,
        // Queues background work that will post to the chat; nothing destructive.
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ goal }) => {
      const ctx = getToolContext();
      // Owner status gates the download tool for the whole run; resolve it now.
      // It is resolved from the turn's *authority* — the sender normally, but
      // the author of the standing chat rule when a rule drove this turn, so an
      // owner's "download any media link posted here" rule works for everyone's
      // links. Provenance below stays the real sender either way. Both flags
      // come from the bound context (the source's `sender.isOwner` stamp and
      // the matched task's stamps) — no owner-id comparison here.
      const senderIsOwner = ctx.senderIsOwner === true;
      const isOwner = senderIsOwner || ctx.authorityIsOwner === true;
      // A rule drove this turn: `authorityIsOwner` is set only when a standing
      // rule matched and its author had rights to lend (never on a direct
      // request, even the owner's own — the matcher is skipped there).
      const ruleDriven = ctx.authorityIsOwner === true;
      // Restricted = downloads are fenced to the message's own links and must
      // attach to the chat or be discarded (user decisions, 2026-08-01): every
      // rule-driven run in a group — the owner's own message included, since a
      // group's audience cannot reach the server's disk — and any run whose
      // rights were lent to a non-owner. The owner's direct requests and their
      // own DM rules stay unrestricted.
      const restricted =
        isOwner &&
        ruleDriven &&
        (!senderIsOwner || (await isGroupChat(undefined, ctx.source, ctx.chatId)));

      const run = await enqueueBrowserRun({
        goal,
        chatRef: scopedRef(ctx.source, "chat", ctx.chatId),
        threadId: ctx.threadId ?? null,
        createdByUserRef: ctx.userId ? scopedRef(ctx.source, "user", ctx.userId) : null,
        isOwner,
        restricted,
        sourceUrls: ctx.messageUrls ?? [],
      });
      // The turn's reply is now only an acknowledgement of this run — the
      // pipeline sends it silent and removes it once the run reports.
      ctx.onBrowserRunEnqueued?.(run.id);
      emitRunEnqueued();

      return {
        content: [
          {
            type: "text" as const,
            text:
              `Browsing run started in the background. Tell the user you're on it and will ` +
              `report back here with what you find. Do not make up results — the run posts them itself.`,
          },
        ],
        structuredContent: { ok: true, runId: run.id },
      };
    },
  );
}

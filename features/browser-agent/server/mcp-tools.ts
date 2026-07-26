import "server-only";

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { getBotPolicy } from "@/features/settings/server/service";
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
  "SEARCH the web, open and read any page, follow links, click, fill forms, read content behind a " +
  "click, read a page's LIVE rendered values, AND download files (documents, images, videos, archives) " +
  "to send to the user. This is the ONLY way you can reach the internet — you have no other way to " +
  "search, open a link, or fetch a file. " +
  "You CAN get a file for the user through this tool — so when a user gives you a link and asks you " +
  "to download / save / grab / get / fetch it (or the video/image/file on it), DO NOT reply that you " +
  "are 'just a language model' or 'cannot download files': call this tool instead. That refusal is " +
  "wrong — this is exactly the tool for it. " +
  "MUST call when: (a) the user asks you to look something up, search for something, or check what is " +
  "online right now; (b) the user shares a URL, or asks about the content of a page whose URL is in " +
  "the conversation — go read that page instead of answering from memory; (c) the user asks to " +
  "download or save a file, video, image, or document; (d) the user names a specific site, service, or " +
  "page to get data FROM (e.g. 'on <site>', 'check <site>', 'from <site>') — go read it there; (e) the " +
  "user wants a LIVE or CURRENT value — the weather, a price, a rate, live stats, a player/viewer/user " +
  "count, a chart or dashboard, availability, today's news — because those change constantly and your " +
  "own knowledge is stale; (f) the task needs any multi-step interaction on the web. " +
  "In all of those, go get the real value from the real page instead of answering from memory. " +
  "The agent works step by step and reports back to this chat when it is done (this may take a while). " +
  "Do NOT call for casual chat, an opinion, or a stable fact you already know well and the user did " +
  "not ask you to verify (a definition, a historical date, arithmetic) — that is not a web task. " +
  "Write the goal as a clear, self-contained instruction, and INCLUDE ALL links, site names, and " +
  "search terms the user gave — the agent starts from nothing but this text. " +
  "The agent replies to the chat itself, so just tell the user you're on it; do not invent results.";

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
            "A clear, self-contained description of what to find or do on the web. Include ALL links the user gave.",
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
      const policy = await getBotPolicy().catch(() => null);
      const isOwner = Boolean(policy?.ownerUserId && ctx.userId === policy.ownerUserId);

      const run = await enqueueBrowserRun({
        goal,
        chatId: ctx.chatId,
        threadId: ctx.threadId ?? null,
        createdByUserId: ctx.userId ?? null,
        isOwner,
      });
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

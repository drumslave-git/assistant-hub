import "server-only";

import {
  BROWSER_AGENT_TOOL_NAMES,
  registerBrowserAgentMcpTools,
} from "@/features/browser-agent/server/mcp-tools";
import {
  HISTORY_TOOL_NAMES,
  registerHistoryMcpTools,
} from "@/features/history/server/mcp-tools";
import {
  IMAGE_GEN_TOOL_NAMES,
  registerImageGenMcpTools,
} from "@/features/image-gen/server/mcp-tools";
import {
  KNOWN_USERS_TOOL_NAMES,
  registerKnownUsersMcpTools,
} from "@/features/known-users/server/mcp-tools";
import {
  MEMORY_TOOL_NAMES,
  registerMemoryMcpTools,
} from "@/features/memory/server/mcp-tools";
import {
  registerScheduledTasksMcpTools,
  SCHEDULED_TASKS_TOOL_NAMES,
} from "@/features/scheduled-tasks/server/mcp-tools";
import { BotMcpRegistry } from "./registry";

/**
 * Process-wide MCP registry. Tools are registered once and the in-process
 * client/server pair connects once; both the reply runtime (per turn) and the
 * Tools dashboard read the same registry. Kept on a `globalThis` singleton — like
 * the bot manager — so it survives module re-evaluation across Next bundles and
 * dev hot-reload, and the MCP server is never connected twice.
 *
 * New tool-owning features add their registrar here.
 */

interface RegistryStore {
  registry: BotMcpRegistry | null;
  loading: Promise<BotMcpRegistry> | null;
}

const STORE_KEY = Symbol.for("llm-tg-bot.mcp.registry");

function store(): RegistryStore {
  const g = globalThis as typeof globalThis & { [STORE_KEY]?: RegistryStore };
  if (!g[STORE_KEY]) g[STORE_KEY] = { registry: null, loading: null };
  return g[STORE_KEY];
}

/** Build the registry, register every feature's tools, and connect. */
async function build(): Promise<BotMcpRegistry> {
  const registry = new BotMcpRegistry();
  registry.registerTools("history", registerHistoryMcpTools, HISTORY_TOOL_NAMES);
  registry.registerTools("known-users", registerKnownUsersMcpTools, KNOWN_USERS_TOOL_NAMES);
  registry.registerTools(
    "scheduled-tasks",
    registerScheduledTasksMcpTools,
    SCHEDULED_TASKS_TOOL_NAMES,
  );
  registry.registerTools("memory", registerMemoryMcpTools, MEMORY_TOOL_NAMES);
  registry.registerTools("image-gen", registerImageGenMcpTools, IMAGE_GEN_TOOL_NAMES);
  registry.registerTools(
    "browser-agent",
    registerBrowserAgentMcpTools,
    BROWSER_AGENT_TOOL_NAMES,
  );
  await registry.finishRegistration();
  return registry;
}

/**
 * The shared MCP registry, loaded and connected. Idempotent and safe to call
 * concurrently — the first call builds it, the rest await the same promise.
 */
export async function loadMcpRegistry(): Promise<BotMcpRegistry> {
  const s = store();
  if (s.registry) return s.registry;
  if (!s.loading) {
    s.loading = build().then((registry) => {
      s.registry = registry;
      return registry;
    });
  }
  return s.loading;
}
